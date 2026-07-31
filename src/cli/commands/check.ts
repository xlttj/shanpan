import chalk from 'chalk';
import { execFileSync } from 'node:child_process';
import { openDatabase, closeDatabase, dbExists, queryAll, escId } from '../../core/db.js';
import {
  computeRecordDrift,
  driftKey,
  loadDriftCache,
  saveDriftCache,
} from '../../core/record-drift.js';

interface StagedChanges {
  removed: string[]; // deleted or renamed — subjects definitively broken
  modified: string[]; // content changed — subject exists, behaviour may differ
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

export type HookFormat = 'claude' | 'cursor';

/**
 * Claude Code blocks a Stop with decision/reason. Cursor's native `stop` hook
 * has no block field at all — the only way to feed text back to the model is
 * followup_message, which it auto-submits as the next user message.
 */
export function blockResponse(format: HookFormat, reason: string): string {
  if (format === 'cursor') return JSON.stringify({ followup_message: reason });
  return JSON.stringify({ decision: 'block', reason });
}

async function runHookOutputCheck(projectDir: string, format: HookFormat): Promise<void> {
  if (!dbExists(projectDir)) {
    process.stdout.write('{}');
    return;
  }

  const { db, conn } = await openDatabase(projectDir, true);
  let report;
  try {
    report = await computeRecordDrift(conn, projectDir);
  } finally {
    await closeDatabase(db, conn);
  }

  // Only block on drift that is new since the last hook invocation. Without
  // this, persistent drift re-fires the block on every Stop event and traps
  // the agent in a loop, re-investigating drift it has already been told about
  // and cannot fix without explicit user intent.
  const previouslyReported = loadDriftCache(projectDir);
  const newDrift = report.unresolved.filter((d) => !previouslyReported.has(driftKey(d)));
  saveDriftCache(projectDir, report.unresolved);

  if (newDrift.length === 0 && report.invalidRecords.length === 0) {
    process.stdout.write('{}');
    return;
  }

  const parts: string[] = [];

  if (report.invalidRecords.length > 0) {
    parts.push(
      `${report.invalidRecords.length} knowledge record(s) fail validation. ` +
        'Run `specgraph records check` to see them — the graph is not being updated from them.',
    );
  }

  if (newDrift.length > 0) {
    const preview = newDrift
      .slice(0, 3)
      .map((d) => `  - ${d.recordId} → ${d.subject}`)
      .join('\n');
    const more = newDrift.length > 3 ? `\n  …and ${newDrift.length - 3} more` : '';
    const plural = newDrift.length === 1 ? '' : 's';
    parts.push(
      `Record drift: ${newDrift.length} subject${plural} no longer resolve${newDrift.length === 1 ? 's' : ''} to any symbol or file:\n${preview}${more}\n` +
        'Inspect with the MCP `get_record_drift` tool. Either the code moved — then supersede the ' +
        'record with a corrected subject — or the knowledge is obsolete. ' +
        'This warning is shown once per drift state; do not retry the same checks if it does not reappear.',
    );
  }

  process.stdout.write(blockResponse(format, parts.join('\n\n')));
}

export async function runCheck(options: {
  staged: boolean;
  hookOutput?: boolean;
  format?: HookFormat;
}): Promise<void> {
  const projectDir = process.cwd();

  if (options.hookOutput) {
    await runHookOutputCheck(projectDir, options.format ?? 'claude');
    return;
  }

  if (!dbExists(projectDir)) {
    console.log(chalk.gray('No SpecGraph database found — skipping knowledge integrity check.'));
    return;
  }

  if (!options.staged) {
    const { db, conn } = await openDatabase(projectDir, true);
    try {
      const report = await computeRecordDrift(conn, projectDir);
      if (report.invalidRecords.length > 0) {
        console.error(chalk.red(`✗ ${report.invalidRecords.length} invalid record(s):`));
        for (const e of report.invalidRecords) {
          console.error(chalk.red(`  line ${e.line}${e.id ? ` (${e.id})` : ''}: ${e.message}`));
        }
      }
      if (report.unresolved.length === 0) {
        console.log(chalk.green('✓ Every record subject resolves'));
      } else {
        console.log(chalk.yellow(`⚠ ${report.unresolved.length} unresolved subject(s):`));
        for (const d of report.unresolved) {
          console.log(chalk.yellow(`  ${d.recordId} → ${d.subject}`));
          console.log(chalk.gray(`     ${d.claim}`));
        }
      }
      if (report.invalidRecords.length > 0) process.exitCode = 1;
    } finally {
      await closeDatabase(db, conn);
    }
    return;
  }

  const { removed, modified } = getStagedChanges();
  if (removed.length === 0 && modified.length === 0) {
    return;
  }

  const { db, conn } = await openDatabase(projectDir, true);
  let hasViolations = false;

  try {
    // Hard block: files deleted or renamed — record subjects are now broken.
    if (removed.length > 0) {
      const { rows } = await queryAll(
        conn,
        `MATCH (r:Record)-[:ABOUT]->(t)
         WHERE r.live AND (t.file_path IN [${escList(removed)}] OR t.id IN [${escList(removed)}])
         RETURN DISTINCT r.id AS recordId, r.claim AS claim, t.id AS subject`,
      );

      if (rows.length > 0) {
        hasViolations = true;
        console.error(chalk.red('✗ Pre-commit: knowledge integrity violation'));
        console.error('');
        console.error(chalk.red('  These records describe code in files being deleted or renamed:'));
        console.error('');
        for (const row of rows) {
          console.error(chalk.red(`  ${String(row['recordId'])} → ${String(row['subject'])}`));
          console.error(chalk.gray(`     ${String(row['claim'])}`));
        }
        console.error('');
        console.error(
          chalk.gray('  Supersede each record with a corrected subject, or drop it if the knowledge no longer applies.'),
        );
      }
    }

    // Soft warn: files modified — the subject still exists but the claim may
    // no longer hold. Only an agent or a human can judge that.
    if (modified.length > 0) {
      const { rows } = await queryAll(
        conn,
        `MATCH (r:Record)-[:ABOUT]->(t)
         WHERE r.live AND (t.file_path IN [${escList(modified)}] OR t.id IN [${escList(modified)}])
         RETURN DISTINCT r.id AS recordId, r.claim AS claim, t.id AS subject`,
      );

      if (rows.length > 0) {
        console.error(chalk.yellow('⚠ Review suggested — these records describe modified code:'));
        console.error('');
        for (const row of rows) {
          console.error(chalk.yellow(`  ${String(row['recordId'])} → ${String(row['subject'])}`));
          console.error(chalk.gray(`     ${String(row['claim'])}`));
        }
        console.error('');
        console.error(chalk.gray('  If a claim no longer holds, supersede it rather than editing in place.'));
      }
    }
  } finally {
    await closeDatabase(db, conn);
  }

  if (hasViolations) {
    process.exit(1);
  }
}
