import chalk from 'chalk';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadConfig } from '../../core/config.js';
import { openDatabase, closeDatabase, dbExists } from '../../core/db.js';
import { walkFiles } from '../../analyzer/walker.js';
import { getExtensionsForLanguages } from '../../analyzer/languages/index.js';
import { indexRecords } from '../../core/record-indexer.js';
import {
  readRecords,
  appendRecords,
  nextId,
  formatTs,
} from '../../core/records.js';
import type { KnowledgeRecord } from '../../types/record.js';
import {
  scanMarkers,
  parseReverts,
  buildGitLogArgs,
  scanAdr,
  dedupKey,
  ADR_DIRS,
} from '../../core/bootstrap.js';

const DEFAULT_COMMIT_LIMIT = 2000;

function gitLog(projectDir: string, limit: number): string | null {
  try {
    return execFileSync('git', buildGitLogArgs(limit), {
      cwd: projectDir,
      encoding: 'utf-8',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return null; // not a git repo, or git unavailable
  }
}

function findAdrFiles(projectDir: string): string[] {
  const found: string[] = [];
  for (const dir of ADR_DIRS) {
    const abs = path.join(projectDir, dir);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isFile() && e.name.toLowerCase().endsWith('.md') && e.name.toLowerCase() !== 'readme.md') {
        found.push(path.join(dir, e.name));
      }
    }
  }
  return found.sort();
}

export interface BootstrapOptions {
  dryRun?: boolean;
  commitLimit?: number;
}

export async function runBootstrap(options: BootstrapOptions = {}): Promise<void> {
  const projectDir = process.cwd();
  const config = loadConfig(projectDir);
  const commitLimit = options.commitLimit ?? DEFAULT_COMMIT_LIMIT;

  // Dedup against what already exists plus what we add within this run, so
  // bootstrap is idempotent: running it twice adds nothing the second time.
  const { records: existing } = readRecords(projectDir);
  const seen = new Set<string>();
  for (const r of existing) seen.add(dedupKey(r.kn, r.cl));
  const taken = new Set(existing.map((r) => r.id));

  const nextRecords: KnowledgeRecord[] = [];
  const now = formatTs(new Date());
  const counts = { gotcha: 0, rejected: 0, decision: 0, skipped: 0 };

  const add = (rec: Omit<KnowledgeRecord, 'id' | 'ts'>): void => {
    const key = dedupKey(rec.kn, rec.cl);
    if (seen.has(key)) {
      counts.skipped++;
      return;
    }
    seen.add(key);
    const id = nextId(taken);
    taken.add(id);
    nextRecords.push({ ...rec, id, ts: now });
    if (rec.kn === 'gotcha') counts.gotcha++;
    else if (rec.kn === 'rejected') counts.rejected++;
    else if (rec.kn === 'decision') counts.decision++;
  };

  // ── marker comments → gotcha ────────────────────────────────────────────────
  const extensions = getExtensionsForLanguages(config.analyze.languages);
  const includeDirs = config.analyze.include.map((d) => path.resolve(projectDir, d));
  const files = walkFiles(includeDirs, extensions, config.analyze.exclude);
  for (const absPath of files) {
    let source: string;
    try {
      source = fs.readFileSync(absPath, 'utf-8');
    } catch {
      continue;
    }
    const relPath = path.relative(projectDir, absPath);
    for (const m of scanMarkers(relPath, source)) {
      add({
        kn: 'gotcha',
        cl: m.claim,
        sb: [m.file],
        pv: `n:${m.file}:${m.line}`,
      });
    }
  }

  // ── git reverts → rejected ──────────────────────────────────────────────────
  const log = gitLog(projectDir, commitLimit);
  const gitAvailable = log !== null;
  if (log) {
    for (const rev of parseReverts(log)) {
      add({
        kn: 'rejected',
        cl: rev.claim,
        bc: `reverted in ${rev.sha}`,
        pv: `g:${rev.sha}`,
      });
    }
  }

  // ── ADR docs → decision ─────────────────────────────────────────────────────
  const adrFiles = findAdrFiles(projectDir);
  for (const rel of adrFiles) {
    let source: string;
    try {
      source = fs.readFileSync(path.join(projectDir, rel), 'utf-8');
    } catch {
      continue;
    }
    const adr = scanAdr(source);
    if (!adr) continue;
    add({
      kn: 'decision',
      cl: adr.claim,
      ...(adr.because ? { bc: adr.because } : {}),
      sb: [rel],
      pv: `d:${rel}`,
    });
  }

  // ── report ──────────────────────────────────────────────────────────────────
  const total = counts.gotcha + counts.rejected + counts.decision;

  console.log(chalk.bold('specgraph bootstrap'));
  console.log(chalk.gray('─'.repeat(40)));
  console.log(`  ${chalk.cyan('gotcha')}   (marker comments)  ${counts.gotcha}`);
  console.log(`  ${chalk.cyan('rejected')} (git reverts)      ${counts.rejected}`);
  console.log(`  ${chalk.cyan('decision')} (ADR docs)         ${counts.decision}`);
  if (counts.skipped > 0) {
    console.log(chalk.gray(`  ${counts.skipped} already present, skipped`));
  }
  if (!gitAvailable) {
    console.log(chalk.yellow('  ⚠ git log unavailable — no reverts scanned'));
  }

  if (options.dryRun) {
    console.log('');
    console.log(chalk.gray(`Dry run — ${total} record(s) would be added. Nothing written.`));
    printGap();
    return;
  }

  if (total === 0) {
    console.log('');
    console.log(chalk.gray('Nothing new to add.'));
    printGap();
    return;
  }

  appendRecords(projectDir, nextRecords);
  console.log('');
  console.log(chalk.green(`✓ Added ${total} record(s) to .specgraph/knowledge.ndjson`));

  if (dbExists(projectDir)) {
    const { db, conn } = await openDatabase(projectDir);
    try {
      const cleared = await conn.query('MATCH (r:Record) DETACH DELETE r');
      if (!Array.isArray(cleared)) cleared.close();
      const { records } = readRecords(projectDir);
      const stats = await indexRecords(conn, records, projectDir);
      console.log(chalk.green(`✓ Indexed: ${stats.live} live record(s), ${stats.about} subject link(s)`));
      if (stats.unresolved.length > 0) {
        console.log(chalk.yellow(`  ⚠ ${stats.unresolved.length} unresolved subject(s) — run 'specgraph analyze' first.`));
      }
    } finally {
      await closeDatabase(db, conn);
    }
  } else {
    console.log(chalk.gray("  Run 'specgraph analyze' then 'specgraph records index' to make them queryable."));
  }

  printGap();
}

/**
 * Bootstrap is deliberately partial. Saying so out loud keeps a thin, trusted
 * base from being mistaken for full coverage — silent gaps read as "done".
 */
function printGap(): void {
  console.log('');
  console.log(chalk.gray('Not extracted — these need an agent or a human, not a scanner:'));
  console.log(chalk.gray('  · the reasoning behind decisions that live only in code'));
  console.log(chalk.gray('  · behaviour contracts (write these from tests as you touch them)'));
  console.log(chalk.gray('  · anything the team knows but never wrote down'));
  console.log(chalk.gray('The base fills in as agents work — see the record-knowledge skill.'));
}
