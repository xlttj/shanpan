import chalk from 'chalk';
import path from 'node:path';
import { openDatabase, closeDatabase, dbExists } from '../../core/db.js';
import { loadConfig, saveConfig } from '../../core/config.js';
import { parseAllSpecs } from '../../core/parser.js';
import { analyzeAndIndex } from '../../analyzer/indexer.js';

export async function runAnalyze(options: {
  include?: string[];
  exclude?: string[];
  languages?: string[];
}): Promise<void> {
  const projectDir = process.cwd();

  if (!dbExists(projectDir)) {
    console.error(chalk.red('No SpecGraph database found. Run `specgraph init` first.'));
    process.exit(1);
  }

  const config = loadConfig(projectDir);

  // Apply CLI overrides
  if (options.include && options.include.length > 0) {
    config.analyze.include = options.include;
  }
  if (options.exclude && options.exclude.length > 0) {
    config.analyze.exclude = options.exclude;
  }
  if (options.languages && options.languages.length > 0) {
    config.analyze.languages = options.languages;
  }

  // Persist any overrides back to config
  saveConfig(projectDir, config);

  const specsDir = path.resolve(projectDir, config.specsDir);
  const { specs } = parseAllSpecs(specsDir);

  console.log(chalk.cyan('Analyzing source code…'));
  console.log(chalk.gray(`  Directories: ${config.analyze.include.join(', ')}`));
  console.log(chalk.gray(`  Languages:   ${config.analyze.languages.join(', ')}`));

  const { db, conn } = await openDatabase(projectDir);

  try {
    const stats = await analyzeAndIndex(conn, projectDir, specs, config);

    console.log('');
    console.log(chalk.green('✓ Analysis complete'));
    console.log('');
    console.log(chalk.bold('Results:'));
    console.log(`  ${chalk.cyan('Files scanned')}         ${stats.filesScanned}`);
    console.log(`  ${chalk.cyan('Symbols found')}         ${stats.symbolsFound}`);
    console.log(`  ${chalk.cyan('Implementations linked')} ${stats.implementationsLinked}`);
    console.log(`  ${chalk.cyan('Call edges created')}    ${stats.callEdgesCreated}`);
    if (stats.parseErrors > 0) {
      console.log(chalk.yellow(`  Parse errors: ${stats.parseErrors}`));
    }
    if (stats.driftWarnings.length > 0) {
      console.log('');
      console.log(chalk.yellow('Drift warnings (symbol declared in spec but not found in code):'));
      for (const w of stats.driftWarnings) {
        console.log(chalk.yellow(`  ⚠ ${w}`));
      }
    }
  } finally {
    await closeDatabase(db, conn);
  }
}
