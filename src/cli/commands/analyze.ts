import chalk from 'chalk';
import path from 'node:path';
import { openDatabase, closeDatabase, dbExists } from '../../core/db.js';
import { loadConfig, saveConfig } from '../../core/config.js';
import { parseAllSpecs } from '../../core/parser.js';
import { analyzeAndIndex } from '../../analyzer/indexer.js';
import { watchAndReindex } from '../../core/watcher.js';
import type { SpecGraphConfig } from '../../types/config.js';

async function runOneAnalyze(
  projectDir: string,
  config: SpecGraphConfig,
  verbose: boolean,
): Promise<{ filesScanned: number; driftCount: number }> {
  const specsDir = path.resolve(projectDir, config.specsDir);
  const { specs } = parseAllSpecs(specsDir);

  if (verbose) {
    console.log(chalk.cyan('Analyzing source code…'));
    console.log(chalk.gray(`  Directories: ${config.analyze.include.join(', ')}`));
    console.log(chalk.gray(`  Languages:   ${config.analyze.languages.join(', ')}`));
  }

  const { db, conn } = await openDatabase(projectDir);
  try {
    const stats = await analyzeAndIndex(conn, projectDir, specs, config);

    if (verbose) {
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
        const suggestionMap = new Map(
          stats.renameSuggestions.map((s) => [`${s.specId}::${s.oldSymbolId}`, s]),
        );
        console.log('');
        console.log(chalk.yellow('Drift warnings (symbol declared in spec but not found in code):'));
        for (const w of stats.driftWarnings) {
          const colonIdx = w.indexOf(':');
          const specId = w.slice(0, colonIdx);
          const symbolId = w.slice(colonIdx + 2, w.lastIndexOf(' not found'));
          console.log(chalk.yellow(`  ⚠ ${w}`));
          const suggestion = suggestionMap.get(`${specId}::${symbolId}`);
          if (suggestion) {
            const label =
              suggestion.reason === 'different_file_same_fqn'
                ? 'file moved, same name'
                : 'same file, same class';
            console.log(
              chalk.gray(`     → Did you rename to ${suggestion.suggestedSymbolId}? (${label})`),
            );
            console.log(chalk.gray(`       Fix: specgraph update --id ${specId} \\`));
            console.log(chalk.gray(`                 --remove-symbol ${symbolId} \\`));
            console.log(chalk.gray(`                 --add-symbol ${suggestion.suggestedSymbolId}`));
          }
        }
      }
    }

    return { filesScanned: stats.filesScanned, driftCount: stats.driftWarnings.length };
  } finally {
    await closeDatabase(db, conn);
  }
}

export async function runAnalyze(options: {
  include?: string[];
  exclude?: string[];
  languages?: string[];
  watch?: boolean;
}): Promise<void> {
  const projectDir = process.cwd();

  if (!dbExists(projectDir)) {
    console.error(chalk.red('No SpecGraph database found. Run `specgraph init` first.'));
    process.exit(1);
  }

  const config = loadConfig(projectDir);

  if (options.include && options.include.length > 0) {
    config.analyze.include = options.include;
  }
  if (options.exclude && options.exclude.length > 0) {
    config.analyze.exclude = options.exclude;
  }
  if (options.languages && options.languages.length > 0) {
    config.analyze.languages = options.languages;
  }

  saveConfig(projectDir, config);

  await runOneAnalyze(projectDir, config, true);

  if (!options.watch) return;

  console.log('');
  const stop = await watchAndReindex(projectDir, config, {
    onFlush: async () => runOneAnalyze(projectDir, config, false),
  });

  await new Promise<void>((resolve) => {
    const shutdown = () => {
      console.log('');
      console.log(chalk.gray('stopping watcher…'));
      void stop().then(resolve);
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  });
}
