import chalk from 'chalk';
import { openDatabase, closeDatabase, dbExists } from '../../core/db.js';
import { fetchRecordsByFile, writeRules, RULES_DIR } from '../../core/cursor-rules.js';

export async function runRules(): Promise<void> {
  const projectDir = process.cwd();

  if (!dbExists(projectDir)) {
    console.error(chalk.red('No Shanpan database found. Run `shanpan init` first.'));
    process.exitCode = 1;
    return;
  }

  const { db, conn } = await openDatabase(projectDir, true);
  let groups;
  try {
    groups = await fetchRecordsByFile(conn);
  } finally {
    await closeDatabase(db, conn);
  }

  const { written, pruned } = writeRules(projectDir, groups);

  const recordCount = groups.reduce((n, g) => n + g.records.length, 0);
  console.log(
    chalk.green(`✓ Wrote ${written.length} rule file(s) to ${RULES_DIR}/`) +
      chalk.gray(` (${recordCount} record(s))`),
  );
  if (pruned.length > 0) {
    console.log(chalk.gray(`  Pruned ${pruned.length} stale rule file(s)`));
  }
}
