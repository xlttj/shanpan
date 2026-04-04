import chalk from 'chalk';
import path from 'node:path';
import { openDatabase, closeDatabase, dbExists } from '../../core/db.js';
import { parseAllSpecs } from '../../core/parser.js';
import { validateSpecs } from '../../core/validator.js';
import { indexSpecs } from '../../core/indexer.js';

export async function runIndex(options: { specsDir?: string }): Promise<void> {
  const projectDir = process.cwd();

  if (!dbExists(projectDir)) {
    console.error(chalk.red('No SpecGraph database found. Run `specgraph init` first.'));
    process.exit(1);
  }

  const specsDir = path.resolve(projectDir, options.specsDir ?? 'specs');
  console.log(chalk.cyan(`Indexing specs from ${path.relative(projectDir, specsDir)}/…`));

  const { specs, errors: parseErrors } = parseAllSpecs(specsDir);

  if (parseErrors.length > 0) {
    console.error(chalk.red('\nParse errors:'));
    for (const err of parseErrors) {
      console.error(chalk.red(`  ✗ ${err}`));
    }
  }

  if (specs.length === 0) {
    console.log(chalk.yellow('No spec files found.'));
    return;
  }

  console.log(chalk.gray(`Found ${specs.length} spec file(s)`));

  const { errors: validationErrors, warnings } = validateSpecs(specs);

  if (warnings.length > 0) {
    console.warn(chalk.yellow('\nWarnings:'));
    for (const warn of warnings) {
      console.warn(chalk.yellow(`  ⚠ ${warn}`));
    }
  }

  if (validationErrors.length > 0) {
    console.error(chalk.red('\nValidation errors:'));
    for (const err of validationErrors) {
      console.error(chalk.red(`  ✗ ${err}`));
    }
    process.exit(1);
  }

  const { db, conn } = await openDatabase(projectDir);

  try {
    const stats = await indexSpecs(conn, specs);

    console.log('');
    console.log(chalk.green('✓ Index complete'));
    console.log('');
    console.log(chalk.bold('Indexed:'));
    console.log(`  ${chalk.cyan('Specs')}           ${stats.specs}`);
    if (stats.rules > 0) console.log(`  ${chalk.cyan('Business Rules')} ${stats.rules}`);
    if (stats.symbols > 0) console.log(`  ${chalk.cyan('Code Symbols')}  ${stats.symbols}`);
    console.log('');
    const totalEdges = stats.dependsOn + stats.derivesFrom + stats.defines + stats.implements;
    if (totalEdges > 0) {
      console.log(chalk.bold('Edges:'));
      if (stats.dependsOn > 0) console.log(`  ${chalk.cyan('DEPENDS_ON')}     ${stats.dependsOn}`);
      if (stats.derivesFrom > 0) console.log(`  ${chalk.cyan('DERIVES_FROM')}   ${stats.derivesFrom}`);
      if (stats.defines > 0) console.log(`  ${chalk.cyan('DEFINES')}        ${stats.defines}`);
      if (stats.implements > 0) console.log(`  ${chalk.cyan('IMPLEMENTS')}     ${stats.implements}`);
    }
  } finally {
    await closeDatabase(db, conn);
  }
}
