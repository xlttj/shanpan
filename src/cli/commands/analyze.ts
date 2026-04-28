import chalk from 'chalk';
import fs from 'node:fs';
import path from 'node:path';
import { openDatabase, closeDatabase, dbExists } from '../../core/db.js';
import { loadConfig, saveConfig } from '../../core/config.js';
import { parseAllSpecs } from '../../core/parser.js';
import { analyzeAndIndex, analyzeAndIndexIncremental } from '../../analyzer/indexer.js';
import { walkFiles } from '../../analyzer/walker.js';
import { getExtensionsForLanguages } from '../../analyzer/languages/index.js';
import { loadAnalyzeState, saveAnalyzeState } from '../../core/analyze-state.js';
import { watchAndReindex } from '../../core/watcher.js';
import type { SpecGraphConfig } from '../../types/config.js';

function makeProgressCallback(verbose: boolean) {
  if (!verbose || !process.stdout.isTTY) return undefined;
  let lastPhase = '';
  return (phase: 'scan' | 'index', n: number, total: number) => {
    const label = phase === 'scan' ? 'Scanning' : 'Indexing';
    if (phase !== lastPhase) {
      if (lastPhase) process.stdout.write('\n');
      lastPhase = phase;
    }
    process.stdout.write(`\r  ${label}... (${n}/${total})`);
  };
}

function printResults(
  stats: Awaited<ReturnType<typeof analyzeAndIndex>>,
  verbose: boolean,
  mode: 'full' | 'incremental' | 'skip',
) {
  if (!verbose) return;
  console.log('');
  if (mode === 'skip') {
    console.log(chalk.green('✓ No changes detected'));
    return;
  }
  const label = mode === 'incremental' ? '✓ Incremental analysis complete' : '✓ Analysis complete';
  console.log(chalk.green(label));
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
          suggestion.reason === 'different_file_same_fqn' ? 'file moved, same name' : 'same file, same class';
        console.log(chalk.gray(`     → Did you rename to ${suggestion.suggestedSymbolId}? (${label})`));
        console.log(chalk.gray(`       Fix: specgraph update --id ${specId} \\`));
        console.log(chalk.gray(`                 --remove-symbol ${symbolId} \\`));
        console.log(chalk.gray(`                 --add-symbol ${suggestion.suggestedSymbolId}`));
      }
    }
  }
}

async function runOneAnalyze(
  projectDir: string,
  config: SpecGraphConfig,
  verbose: boolean,
  full: boolean,
): Promise<{ filesScanned: number; driftCount: number }> {
  const specsDir = path.resolve(projectDir, config.specsDir);
  const { specs, warnings } = parseAllSpecs(specsDir);

  if (verbose) {
    console.log(chalk.cyan('Analyzing source code…'));
    console.log(chalk.gray(`  Directories: ${config.analyze.include.join(', ')}`));
    console.log(chalk.gray(`  Languages:   ${config.analyze.languages.join(', ')}`));
    for (const w of warnings) {
      console.warn(chalk.yellow(`  ⚠ ${w}`));
    }
  }

  // Compute changed/deleted files unless forced full rebuild
  const state = full ? { fileMtimes: {} } : loadAnalyzeState(projectDir);
  const extensions = getExtensionsForLanguages(config.analyze.languages);
  const includeDirs = config.analyze.include.map((d) => path.resolve(projectDir, d));
  const currentFiles = walkFiles(includeDirs, extensions, config.analyze.exclude);

  const currentMtimes: Record<string, number> = {};
  for (const absPath of currentFiles) {
    const relPath = path.relative(projectDir, absPath);
    try {
      currentMtimes[relPath] = fs.statSync(absPath).mtimeMs;
    } catch {
      // file disappeared between walk and stat — skip
    }
  }

  const prevMtimes = state.fileMtimes;
  const changedPaths = new Set<string>();
  const deletedPaths = new Set<string>();

  for (const [relPath, mtime] of Object.entries(currentMtimes)) {
    if (prevMtimes[relPath] === undefined || prevMtimes[relPath] !== mtime) {
      changedPaths.add(relPath);
    }
  }
  for (const relPath of Object.keys(prevMtimes)) {
    if (currentMtimes[relPath] === undefined) {
      deletedPaths.add(relPath);
    }
  }

  const { db, conn } = await openDatabase(projectDir);
  let mode: 'full' | 'incremental' | 'skip' = 'full';
  let stats: Awaited<ReturnType<typeof analyzeAndIndex>>;

  try {
    const onProgress = makeProgressCallback(verbose);

    if (full || Object.keys(prevMtimes).length === 0) {
      // No prior state or forced full rebuild
      mode = 'full';
      stats = await analyzeAndIndex(conn, projectDir, specs, config, onProgress);
    } else if (changedPaths.size === 0 && deletedPaths.size === 0) {
      mode = 'skip';
      stats = {
        filesScanned: 0, symbolsFound: 0, implementationsLinked: 0,
        callEdgesCreated: 0, containsEdgesCreated: 0, fileNodesCreated: 0,
        parseErrors: 0, unresolvedSymbols: 0, driftWarnings: [], renameSuggestions: [],
      };
    } else {
      mode = 'incremental';
      if (verbose) {
        console.log(chalk.gray(`  Mode: incremental (${changedPaths.size} changed, ${deletedPaths.size} deleted)`));
      }
      stats = await analyzeAndIndexIncremental(
        conn, projectDir, specs, config, changedPaths, deletedPaths, onProgress,
      );
    }

    if (verbose && process.stdout.isTTY && mode !== 'skip') process.stdout.write('\n');
    printResults(stats, verbose, mode);
  } finally {
    await closeDatabase(db, conn);
  }

  // Persist updated mtimes after a successful run
  if (mode !== 'skip') {
    saveAnalyzeState(projectDir, { fileMtimes: currentMtimes });
  }

  return { filesScanned: stats.filesScanned, driftCount: stats.driftWarnings.length };
}

export async function runAnalyze(options: {
  include?: string[];
  exclude?: string[];
  languages?: string[];
  watch?: boolean;
  full?: boolean;
}): Promise<void> {
  const projectDir = process.cwd();

  if (!dbExists(projectDir)) {
    console.error(chalk.red('No SpecGraph database found. Run `specgraph init` first.'));
    process.exit(1);
  }

  const config = loadConfig(projectDir);

  if (options.include && options.include.length > 0) config.analyze.include = options.include;
  if (options.exclude && options.exclude.length > 0) config.analyze.exclude = options.exclude;
  if (options.languages && options.languages.length > 0) config.analyze.languages = options.languages;

  saveConfig(projectDir, config);

  await runOneAnalyze(projectDir, config, true, !!options.full);

  if (!options.watch) return;

  console.log('');
  const stop = await watchAndReindex(projectDir, config, {
    onFlush: async () => runOneAnalyze(projectDir, config, false, false),
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
