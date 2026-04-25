import chalk from 'chalk';
import { execFileSync } from 'node:child_process';
import { openDatabase, closeDatabase, dbExists, queryAll, escId } from '../../core/db.js';
import { loadConfig } from '../../core/config.js';
import { findSpecFiles, parseSpecFile } from '../../core/parser.js';
import path from 'node:path';

interface StagedChanges {
  removed: string[]; // deleted or renamed — symbol IDs definitively broken
  modified: string[]; // content changed — symbol may still exist, behaviour may differ
}

function getStagedChanges(): StagedChanges {
  let output: string;
  try {
    output = execFileSync(
      'git',
      ['diff', '--cached', '--name-status', '--diff-filter=DRM'],
      { encoding: 'utf-8' },
    );
  } catch {
    // Not a git repo or git not available
    return { removed: [], modified: [] };
  }

  const removed: string[] = [];
  const modified: string[] = [];

  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split('\t');
    const status = parts[0] ?? '';
    if (status === 'D') {
      // Deleted: D\t<path>
      if (parts[1]) removed.push(parts[1]);
    } else if (status.startsWith('R')) {
      // Renamed: R<score>\t<old>\t<new> — the old path is what matters
      if (parts[1]) removed.push(parts[1]);
    } else if (status === 'M') {
      // Modified: M\t<path>
      if (parts[1]) modified.push(parts[1]);
    }
  }

  return { removed, modified };
}

function escList(paths: string[]): string {
  return paths.map((p) => `'${escId(p)}'`).join(', ');
}

async function runHookOutputCheck(projectDir: string): Promise<void> {
  if (!dbExists(projectDir)) {
    process.stdout.write('{}');
    return;
  }

  const { db, conn } = await openDatabase(projectDir, true);
  let brokenCount = 0;
  try {
    const { rows } = await queryAll(
      conn,
      'MATCH (c:CodeSymbol) RETURN c.id AS id',
    );
    const knownIds = new Set(rows.map((r) => String(r['id'])));

    const config = loadConfig(projectDir);
    const specsDir = path.resolve(projectDir, config.specsDir);
    for (const filePath of findSpecFiles(specsDir)) {
      try {
        const parsed = parseSpecFile(filePath);
        for (const impl of parsed.frontmatter.implements ?? []) {
          if (!knownIds.has(impl.symbol)) brokenCount++;
        }
      } catch {
        // skip malformed
      }
    }
  } finally {
    await closeDatabase(db, conn);
  }

  if (brokenCount > 0) {
    process.stdout.write(
      JSON.stringify({
        decision: 'block',
        reason: `Spec drift: ${brokenCount} broken link${brokenCount === 1 ? '' : 's'} detected. Run \`specgraph check\` or use the MCP \`get_drift_report\` tool.`,
      }),
    );
  } else {
    process.stdout.write('{}');
  }
}

export async function runCheck(options: { staged: boolean; hookOutput?: boolean }): Promise<void> {
  const projectDir = process.cwd();

  if (options.hookOutput) {
    await runHookOutputCheck(projectDir);
    return;
  }

  if (!dbExists(projectDir)) {
    console.log(chalk.gray('No SpecGraph database found — skipping spec integrity check.'));
    return;
  }

  if (!options.staged) {
    console.log(chalk.gray('Usage: specgraph check --staged'));
    console.log(chalk.gray('Run as a pre-commit hook to detect spec drift.'));
    return;
  }

  const { removed, modified } = getStagedChanges();
  if (removed.length === 0 && modified.length === 0) {
    return;
  }

  const { db, conn } = await openDatabase(projectDir, true);
  let hasViolations = false;

  try {
    // Hard block: files deleted or renamed — spec references are now broken.
    // Check both CodeSymbol nodes (by file_path) and File nodes (by id).
    if (removed.length > 0) {
      const { rows: symRows } = await queryAll(
        conn,
        `MATCH (c:CodeSymbol)-[:IMPLEMENTS]->(s:Spec)
         WHERE c.file_path IN [${escList(removed)}]
         RETURN c.id AS symbolId, s.id AS specId`,
      );
      const { rows: fileRows } = await queryAll(
        conn,
        `MATCH (f:File)-[:IMPLEMENTS]->(s:Spec)
         WHERE f.id IN [${escList(removed)}]
         RETURN f.id AS symbolId, s.id AS specId`,
      );
      const rows = [...symRows, ...fileRows];

      if (rows.length > 0) {
        hasViolations = true;
        console.error(chalk.red('✗ Pre-commit: spec integrity violation'));
        console.error('');
        console.error(chalk.red('  The following specs reference symbols in files being deleted or renamed:'));
        console.error('');
        for (const row of rows) {
          console.error(chalk.red(`  ${String(row['specId'])} references ${String(row['symbolId'])}`));
        }
        console.error('');
        console.error(chalk.gray('  Update the spec(s) to reflect the rename, or run `specgraph analyze` after.'));
      }
    }

    // Soft warn: files modified.
    // For CodeSymbols: the symbol may still exist but behaviour may have changed.
    // For File nodes: any change is semantically significant — content must be
    // re-verified against the spec.
    if (modified.length > 0) {
      const { rows: symRows } = await queryAll(
        conn,
        `MATCH (c:CodeSymbol)-[:IMPLEMENTS]->(s:Spec)
         WHERE c.file_path IN [${escList(modified)}]
         RETURN c.id AS symbolId, s.id AS specId`,
      );
      const { rows: fileRows } = await queryAll(
        conn,
        `MATCH (f:File)-[:IMPLEMENTS]->(s:Spec)
         WHERE f.id IN [${escList(modified)}]
         RETURN f.id AS symbolId, s.id AS specId`,
      );
      const rows = [...symRows, ...fileRows];

      if (rows.length > 0) {
        console.error(chalk.yellow('⚠ Spec review suggested: the following specs reference symbols in modified files:'));
        console.error('');
        for (const row of rows) {
          console.error(chalk.yellow(`  ${String(row['specId'])} → ${String(row['symbolId'])} (file modified)`));
        }
        console.error('');
        console.error(chalk.gray('  Update spec text if behaviour changed, then run `specgraph analyze`.'));
      }
    }
  } finally {
    await closeDatabase(db, conn);
  }

  if (hasViolations) {
    process.exit(1);
  }
}
