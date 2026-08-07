import fs from 'node:fs';
import path from 'node:path';
import chalk from 'chalk';
import parcelWatcher from '@parcel/watcher';
import type { ShanpanConfig } from '../types/config.js';
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
  onFlush: (changedPaths: string[]) => Promise<{ filesScanned: number }>;
  log?: (line: string) => void;
}

/**
 * Watches `config.analyze.include` directories and the specs directory,
 * debounces events, and calls `onFlush` with the accumulated paths.
 * Returns a stop function to tear down watchers and resolve cleanly.
 */
export async function watchAndReindex(
  projectDir: string,
  config: ShanpanConfig,
  options: WatchOptions,
): Promise<() => Promise<void>> {
  try { projectDir = fs.realpathSync(projectDir); } catch { /* keep original */ }

  const log = options.log ?? ((line) => console.log(line));

  const watchRoots = new Set<string>();
  for (const dir of config.analyze.include) {
    const abs = path.resolve(projectDir, dir);
    if (abs === projectDir) {
      // Watching the project root directly risks receiving FSEvents coalesced
      // events at the root level on macOS, bypassing path-based ignore checks.
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


  // Absolute-path ignore list: passed to each subscription for defence-in-depth
  // against nested excluded directories (e.g. src/node_modules).
  const ignoreList: string[] = [
    path.join(projectDir, DB_DIR),
    path.join(projectDir, '.git'),
    ...config.analyze.exclude.map((d) => path.join(projectDir, d)),
  ];

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
      const { filesScanned } = await options.onFlush(paths);
      log(
        chalk.gray(
          `[${timestamp()}] reindexed ${filesScanned} file${filesScanned === 1 ? '' : 's'}`,
        ),
      );
    } catch (err) {
      log(chalk.red(`[${timestamp()}] reindex failed: ${(err as Error).message}`));
    } finally {
      flushing = false;
      if (pendingPaths.size > 0) scheduleFlush();
    }
  };

  const subscriptions: Awaited<ReturnType<typeof parcelWatcher.subscribe>>[] = [];

  for (const root of watchRoots) {
    if (!fs.existsSync(root)) continue;
    try {
      // FSEventStreamSetExclusionPaths on macOS misbehaves when exclusion paths
      // lie outside the watch root — only pass entries that are inside this root.
      const rootPrefix = root + path.sep;
      const relevantIgnores = ignoreList.filter(
        (p) => p === root || p.startsWith(rootPrefix),
      );
      const sub = await parcelWatcher.subscribe(
        root,
        (err, events) => {
          if (stopped) return;
          if (err) {
            log(chalk.yellow(`watcher error: ${err.message}`));
            return;
          }
          let added = 0;
          for (const event of events) {
            // @parcel/watcher on macOS delivers a spurious CREATE event for the
            // watch-root directory itself when the stream starts (FSEvents
            // initialization artifact from recently-created dirs). Only process
            // events for items strictly inside the root.
            if (!event.path.startsWith(root + path.sep)) continue;
            const rel = path.relative(projectDir, event.path);
            if (shouldIgnore(rel, config.analyze.exclude)) continue;
            pendingPaths.add(rel);
            added++;
          }
          if (added > 0) scheduleFlush();
        },
        { ignore: relevantIgnores },
      );
      subscriptions.push(sub);
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
    await Promise.all(subscriptions.map((s) => s.unsubscribe()));
    subscriptions.length = 0;
  };
}
