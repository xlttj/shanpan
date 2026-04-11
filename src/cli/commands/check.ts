import chalk from 'chalk';
import { execFileSync } from 'node:child_process';
import { openDatabase, closeDatabase, dbExists, queryAll } from '../../core/db.js';

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
  return paths.map((p) => `'${p.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`).join(', ');
}

export async function runCheck(options: { staged: boolean }): Promise<void> {
  const projectDir = process.cwd();

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
    // Hard block: files deleted or renamed — symbol IDs in specs are now broken
    if (removed.length > 0) {
      const { rows } = await queryAll(
        conn,
        `MATCH (c:CodeSymbol)-[:IMPLEMENTS]->(s:Spec)
         WHERE c.file_path IN [${escList(removed)}]
         RETURN c.id AS symbolId, s.id AS specId`,
      );

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

    // Soft warn: files modified — symbol may still exist, but behaviour may have changed
    if (modified.length > 0) {
      const { rows } = await queryAll(
        conn,
        `MATCH (c:CodeSymbol)-[:IMPLEMENTS]->(s:Spec)
         WHERE c.file_path IN [${escList(modified)}]
         RETURN c.id AS symbolId, s.id AS specId`,
      );

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
