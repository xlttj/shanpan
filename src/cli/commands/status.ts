import chalk from 'chalk';
import { openDatabase, closeDatabase, dbExists } from '../../core/db.js';
import { getGraphStats } from '../../core/stats.js';

export async function runStatus(): Promise<void> {
  const projectDir = process.cwd();

  if (!dbExists(projectDir)) {
    console.error(chalk.red('No SpecGraph database found. Run `specgraph init` first.'));
    process.exit(1);
  }

  const { db, conn } = await openDatabase(projectDir, true);

  try {
    const stats = await getGraphStats(conn);
    const totalEdges = Object.values(stats.edges).reduce((a, b) => a + b, 0);

    console.log(chalk.bold('SpecGraph Status'));
    console.log(chalk.gray('─'.repeat(40)));
    console.log('');
    console.log(chalk.bold('Nodes'));
    console.log(`  ${chalk.cyan('Code Symbols')}  ${chalk.white(stats.symbols)}`);
    console.log(`  ${chalk.cyan('Files')}         ${chalk.white(stats.files)}`);
    console.log(
      `  ${chalk.cyan('Records')}       ${chalk.white(stats.records)}` +
        chalk.gray(` (${stats.liveRecords} live)`),
    );
    console.log('');
    console.log(chalk.bold('Edges'));
    for (const [type, count] of Object.entries(stats.edges)) {
      if (count > 0) {
        console.log(`  ${chalk.cyan(type.padEnd(14))} ${chalk.white(count)}`);
      }
    }
    if (totalEdges === 0) {
      console.log(chalk.gray('  (no edges yet)'));
    }
    console.log('');
    console.log(
      chalk.gray(
        `Total: ${stats.symbols + stats.files + stats.records} nodes, ${totalEdges} edges`,
      ),
    );
  } finally {
    await closeDatabase(db, conn);
  }
}
