import chalk from 'chalk';
import fs from 'node:fs';
import path from 'node:path';
import { openDatabase, closeDatabase, dbExists, queryAll, ensureSchema } from '../../core/db.js';
import { loadConfig, saveConfig } from '../../core/config.js';
import { analyzeAndIndex, analyzeAndIndexIncremental } from '../../analyzer/indexer.js';
import { walkFiles } from '../../analyzer/walker.js';
import { getExtensionsForLanguages } from '../../analyzer/languages/index.js';
import { loadAnalyzeState, saveAnalyzeState } from '../../core/analyze-state.js';
import { currentBuildId, writeAnalyzerBuild } from '../../core/build-info.js';
import { watchAndReindex } from '../../core/watcher.js';
import { readRecords } from '../../core/records.js';
import { indexRecords } from '../../core/record-indexer.js';
import type { ShanpanConfig } from '../../types/config.js';

/** True when the graph holds no code symbols, whatever the state cache claims. */
async function isGraphEmpty(conn: Parameters<typeof queryAll>[0]): Promise<boolean> {
  try {
    const { rows } = await queryAll(conn, 'MATCH (c:CodeSymbol) RETURN count(c) AS cnt');
    return Number(rows[0]?.['cnt'] ?? 0) === 0;
  } catch {
    return false;
  }
}

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
  console.log(`  ${chalk.cyan('Symbols found')}     ${stats.symbolsFound}`);
  console.log(`  ${chalk.cyan('Files indexed')}     ${stats.fileNodesCreated}`);
  console.log(`  ${chalk.cyan('Call edges')}        ${stats.callEdgesCreated}`);
  if (stats.parseErrors > 0) {
    console.log(chalk.yellow(`  Parse errors: ${stats.parseErrors}`));
  }
}

async function runOneAnalyze(
  projectDir: string,
  config: ShanpanConfig,
  verbose: boolean,
  full: boolean,
): Promise<{ filesScanned: number }> {
  if (verbose) {
    console.log(chalk.cyan('Analyzing source code…'));
    console.log(chalk.gray(`  Directories: ${config.analyze.include.join(', ')}`));
    console.log(chalk.gray(`  Languages:   ${config.analyze.languages.join(', ')}`));
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
    // Bring an older graph up to the current schema before writing — analyze
    // may create tables (e.g. EXTENDS) that a pre-upgrade database lacks.
    await ensureSchema(conn);

    const onProgress = makeProgressCallback(verbose);

    // The state cache lives beside the database but outlives it — deleting
    // graph.db alone leaves a cache claiming every file is already indexed,
    // which would silently under-index. An empty graph forces a full rebuild
    // regardless of what the cache says.
    const graphIsEmpty = !full && Object.keys(prevMtimes).length > 0 && (await isGraphEmpty(conn));
    if (graphIsEmpty && verbose) {
      console.log(chalk.gray('  Graph is empty but a state cache exists — forcing full rebuild.'));
    }

    if (full || graphIsEmpty || Object.keys(prevMtimes).length === 0) {
      // No prior state, empty graph, or forced full rebuild
      mode = 'full';
      stats = await analyzeAndIndex(conn, projectDir, config, onProgress);
    } else if (changedPaths.size === 0 && deletedPaths.size === 0) {
      mode = 'skip';
      stats = {
        filesScanned: 0, symbolsFound: 0, callEdgesCreated: 0,
        containsEdgesCreated: 0, fileNodesCreated: 0, parseErrors: 0,
      };
    } else {
      mode = 'incremental';
      if (verbose) {
        console.log(chalk.gray(`  Mode: incremental (${changedPaths.size} changed, ${deletedPaths.size} deleted)`));
      }
      stats = await analyzeAndIndexIncremental(
        conn, projectDir, config, changedPaths, deletedPaths, onProgress,
      );
    }

    if (verbose && process.stdout.isTTY && mode !== 'skip') process.stdout.write('\n');
    printResults(stats, verbose, mode);

    // Rebuild records in the same pass — always, even on a symbol 'skip'. The
    // knowledge file changes independently of source (an agent adds a record
    // without touching code), so gating this on symbol changes would leave a
    // new record unindexed and its subject reported as drift. Rebuilding ~tens
    // of records is cheap; the expensive symbol analysis stays gated by skip.
    const { records, errors } = readRecords(projectDir);
    if (records.length > 0 && errors.length === 0) {
      const cleared = await conn.query('MATCH (r:Record) DETACH DELETE r');
      if (!Array.isArray(cleared)) cleared.close();
      const recStats = await indexRecords(conn, records, projectDir);
      if (verbose) {
        console.log(
          chalk.cyan('  Records') + `           ${recStats.live} live` +
            (recStats.unresolved.length > 0
              ? chalk.yellow(` · ${recStats.unresolved.length} unresolved subject(s)`)
              : ''),
        );
      }
    } else if (records.length > 0 && errors.length > 0 && verbose) {
      console.log(chalk.yellow(`  Records skipped — ${errors.length} invalid line(s); run 'shanpan records check'.`));
    }
  } finally {
    await closeDatabase(db, conn);
  }

  // Persist updated mtimes after a successful run
  if (mode !== 'skip') {
    saveAnalyzeState(projectDir, { fileMtimes: currentMtimes });
  }
  // Stamp which binary built this graph, so an MCP server can detect that it is
  // running older code than the one that last analyzed.
  writeAnalyzerBuild(projectDir, currentBuildId());

  return { filesScanned: stats.filesScanned };
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
    console.error(chalk.red('No Shanpan database found. Run `shanpan init` first.'));
    process.exit(1);
  }

  const config = loadConfig(projectDir);

  const hasOverrides =
    (options.include && options.include.length > 0) ||
    (options.exclude && options.exclude.length > 0) ||
    (options.languages && options.languages.length > 0);

  if (options.include && options.include.length > 0) config.analyze.include = options.include;
  if (options.exclude && options.exclude.length > 0) config.analyze.exclude = options.exclude;
  if (options.languages && options.languages.length > 0) config.analyze.languages = options.languages;

  if (hasOverrides) saveConfig(projectDir, config);

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
