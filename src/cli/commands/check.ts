import chalk from 'chalk';
import { execFileSync } from 'node:child_process';
import { openDatabase, closeDatabase, dbExists, queryAll } from '../../core/db.js';

interface StagedChange {
  oldPath: string;
}

function getStagedRemovedPaths(): string[] {
  let output: string;
  try {
    output = execFileSync(
      'git',
      ['diff', '--cached', '--name-status', '--diff-filter=DR'],
      { encoding: 'utf-8' },
    );
  } catch {
    // Not a git repo or git not available
    return [];
  }

  const paths: string[] = [];
  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split('\t');
    const status = parts[0] ?? '';
    if (status === 'D') {
      // Deleted: D\t<path>
      if (parts[1]) paths.push(parts[1]);
    } else if (status.startsWith('R')) {
      // Renamed: R<score>\t<old>\t<new> — the old path is what matters
      if (parts[1]) paths.push(parts[1]);
    }
  }
  return paths;
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

  const affectedPaths = getStagedRemovedPaths();
  if (affectedPaths.length === 0) {
    return;
  }

  const { db, conn } = await openDatabase(projectDir, true);
  let hasViolations = false;

  try {
    const { rows } = await queryAll(
      conn,
      `MATCH (c:CodeSymbol)-[:IMPLEMENTS]->(s:Spec)
       WHERE c.file_path IN [${escList(affectedPaths)}]
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
  } finally {
    await closeDatabase(db, conn);
  }

  if (hasViolations) {
    process.exit(1);
  }
}
