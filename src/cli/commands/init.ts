import chalk from 'chalk';
import fs from 'node:fs';
import path from 'node:path';
import { openDatabase, closeDatabase, ensureSchema, getDbPath, DB_DIR } from '../../core/db.js';

export async function runInit(options: { specsDir?: string }): Promise<void> {
  const projectDir = process.cwd();
  const dbPath = getDbPath(projectDir);

  if (fs.existsSync(dbPath)) {
    console.log(chalk.yellow(`Graph database already exists at ${DB_DIR}/`));
    console.log(chalk.gray('Run `specgraph status` to inspect the current state.'));
    return;
  }

  const specsDir = path.resolve(projectDir, options.specsDir ?? 'specs');
  if (!fs.existsSync(specsDir)) {
    fs.mkdirSync(specsDir, { recursive: true });
    console.log(chalk.gray(`Created specs directory: ${path.relative(projectDir, specsDir)}/`));
  }

  console.log(chalk.cyan('Initializing SpecGraph…'));

  const { db, conn } = await openDatabase(projectDir);
  await ensureSchema(conn);
  await closeDatabase(db, conn);

  console.log(chalk.green(`✓ Created ${DB_DIR}/ with empty graph database`));
  console.log(chalk.green(`✓ Specs directory ready at ${path.relative(projectDir, specsDir)}/`));
  console.log('');
  console.log(chalk.gray('Next steps:'));
  console.log(chalk.gray('  1. Add spec files (*.md) to the specs/ directory'));
  console.log(chalk.gray('  2. Run `specgraph index` to build the graph'));
  console.log(chalk.gray('  3. Run `specgraph status` to inspect the graph'));
}
