import fs from 'node:fs';
import path from 'node:path';
import chalk from 'chalk';
import type { SpecGraphConfig } from '../types/config.js';
import { DB_DIR } from './db.js';

const DEBOUNCE_MS = 2000;

function timestamp(): string {
  const d = new Date();
  return `${d.getHours().toString().padStart(2, '0')}:${d
    .getMinutes()
    .toString()
    .padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}`;
}

function shouldIgnore(relPath: string, excludes: string[]): boolean {
  if (relPath.startsWith(DB_DIR + path.sep) || relPath === DB_DIR) return true;
  if (relPath.startsWith('.git' + path.sep)) return true;
  const parts = relPath.split(path.sep);
  for (const excluded of excludes) {
    if (parts.includes(excluded)) return true;
  }
  return false;
}

export interface WatchOptions {
  onFlush: (changedPaths: string[]) => Promise<{ filesScanned: number; driftCount: number }>;
  log?: (line: string) => void;
}

/**
 * Watches `config.analyze.include` directories and the specs directory,
 * debounces events, and calls `onFlush` with the accumulated paths.
 * Returns a stop function to tear down watchers and resolve cleanly.
 */
export function watchAndReindex(
  projectDir: string,
  config: SpecGraphConfig,
  options: WatchOptions,
): () => Promise<void> {
  // Resolve symlinks so that watch-root paths match what FSEvents reports on macOS
  // (e.g. /tmp is a symlink to /private/tmp; without this the relative-path
  // computation in the event callback silently produces garbage).
  try { projectDir = fs.realpathSync(projectDir); } catch { /* keep original */ }

  const log = options.log ?? ((line) => console.log(line));
  const watchRoots = new Set<string>();
  for (const dir of config.analyze.include) {
    const abs = path.resolve(projectDir, dir);
    if (abs === projectDir) {
      // Watching the project root directly would also watch .specgraph/, .git/,
      // etc. On macOS, fs.watch may report only the basename (not the full
      // relative path) for nested events, making path-based filtering unreliable.
      // Instead, enumerate non-ignored immediate subdirectories and watch those.
      try {
        for (const entry of fs.readdirSync(projectDir, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          if (shouldIgnore(entry.name, config.analyze.exclude)) continue;
          watchRoots.add(path.join(projectDir, entry.name));
        }
      } catch { /* skip if enumeration fails */ }
    } else {
      watchRoots.add(abs);
    }
  }
  watchRoots.add(path.resolve(projectDir, config.specsDir));

  const watchers: fs.FSWatcher[] = [];
  let pendingPaths = new Set<string>();
  let timer: NodeJS.Timeout | null = null;
  let flushing = false;
  let stopped = false;

  const scheduleFlush = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void flush();
    }, DEBOUNCE_MS);
  };

  const flush = async () => {
    if (stopped) return;
    if (flushing) {
      if (pendingPaths.size > 0) scheduleFlush();
      return;
    }
    const paths = Array.from(pendingPaths);
    pendingPaths = new Set();
    if (paths.length === 0) return;
    flushing = true;
    try {
      const { filesScanned, driftCount } = await options.onFlush(paths);
      log(
        chalk.gray(
          `[${timestamp()}] reindexed ${filesScanned} file${
            filesScanned === 1 ? '' : 's'
          } · ${driftCount} drift warning${driftCount === 1 ? '' : 's'}`,
        ),
      );
    } catch (err) {
      log(chalk.red(`[${timestamp()}] reindex failed: ${(err as Error).message}`));
    } finally {
      flushing = false;
      if (pendingPaths.size > 0) scheduleFlush();
    }
  };

  const onEvent = (root: string, filename: string | null) => {
    if (stopped) return;
    if (!filename) return; // indeterminate event; can't tell if it's from .specgraph
    const rel = path.relative(projectDir, path.join(root, filename));
    if (shouldIgnore(rel, config.analyze.exclude)) return;
    pendingPaths.add(rel);
    scheduleFlush();
  };

  for (const root of watchRoots) {
    if (!fs.existsSync(root)) continue;
    try {
      const watcher = fs.watch(root, { recursive: true }, (_event, filename) =>
        onEvent(root, filename),
      );
      watcher.on('error', (err) => log(chalk.yellow(`watcher error: ${err.message}`)));
      watchers.push(watcher);
    } catch (err) {
      log(chalk.yellow(`failed to watch ${root}: ${(err as Error).message}`));
    }
  }

  log(
    chalk.cyan(
      `watching ${watchRoots.size} director${
        watchRoots.size === 1 ? 'y' : 'ies'
      } (debounce ${DEBOUNCE_MS}ms) — press Ctrl-C to stop`,
    ),
  );

  return async () => {
    stopped = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    for (const w of watchers) w.close();
    watchers.length = 0;
  };
}
