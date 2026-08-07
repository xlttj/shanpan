import chalk from 'chalk';
import { openDatabase, closeDatabase, queryAll, dbExists } from '../../core/db.js';

function formatTable(columns: string[], rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return chalk.gray('(no results)');

  const colWidths = columns.map((col) => {
    const dataMax = rows.reduce((max, row) => {
      const val = String(row[col] ?? '');
      return Math.max(max, val.length);
    }, 0);
    return Math.max(col.length, dataMax);
  });

  const separator = colWidths.map((w) => '─'.repeat(w + 2)).join('┼');
  const header = columns.map((col, i) => ` ${chalk.bold(col.padEnd(colWidths[i]!))} `).join('│');
  const divider = `├${separator}┤`;
  const topBorder = `┌${colWidths.map((w) => '─'.repeat(w + 2)).join('┬')}┐`;
  const bottomBorder = `└${colWidths.map((w) => '─'.repeat(w + 2)).join('┴')}┘`;
  const headerRow = `│${header}│`;

  const dataRows = rows.map((row) => {
    const cells = columns.map((col, i) => {
      const val = String(row[col] ?? '');
      return ` ${val.padEnd(colWidths[i]!)} `;
    });
    return `│${cells.join('│')}│`;
  });

  return [topBorder, headerRow, divider, ...dataRows, bottomBorder].join('\n');
}

export async function runQuery(cypher: string): Promise<void> {
  const projectDir = process.cwd();

  if (!dbExists(projectDir)) {
    console.error(chalk.red('No Shanpan database found. Run `shanpan init` first.'));
    process.exit(1);
  }

  const { db, conn } = await openDatabase(projectDir, true);

  try {
    const { columns, rows } = await queryAll(conn, cypher);
    console.log(formatTable(columns, rows));
    console.log('');
    console.log(chalk.gray(`${rows.length} row(s)`));
  } catch (err) {
    console.error(chalk.red(`Query error: ${(err as Error).message}`));
    process.exit(1);
  } finally {
    await closeDatabase(db, conn);
  }
}
