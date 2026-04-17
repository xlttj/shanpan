import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { watchAndReindex } from '../src/core/watcher.js';
import { DEFAULT_CONFIG } from '../src/types/config.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'specgraph-watcher-'));
  // Create the directories the watcher expects
  fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'specs'), { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('watchAndReindex', () => {
  it('calls onFlush after debounce window when a file changes', async () => {
    let flushCount = 0;
    let lastPaths: string[] = [];
    const config = {
      ...DEFAULT_CONFIG,
      analyze: { ...DEFAULT_CONFIG.analyze, include: ['src'] },
    };

    const stop = watchAndReindex(tmpDir, config, {
      log: () => {}, // silence output in tests
      onFlush: async (paths) => {
        flushCount++;
        lastPaths = paths;
        return { filesScanned: paths.length, driftCount: 0 };
      },
    });

    try {
      // Trigger a write; watcher has a 2-second debounce
      fs.writeFileSync(path.join(tmpDir, 'src', 'foo.ts'), 'export const x = 1;\n');

      // Wait slightly longer than the debounce window
      await new Promise((r) => setTimeout(r, 2500));

      expect(flushCount).toBe(1);
      expect(lastPaths.length).toBeGreaterThan(0);
      expect(lastPaths.some((p) => p.endsWith('foo.ts'))).toBe(true);
    } finally {
      await stop();
    }
  }, 10_000);

  it('ignores files under .specgraph to prevent feedback loops', async () => {
    fs.mkdirSync(path.join(tmpDir, '.specgraph'), { recursive: true });
    let flushCount = 0;
    const config = {
      ...DEFAULT_CONFIG,
      analyze: { ...DEFAULT_CONFIG.analyze, include: ['.'] },
    };

    const stop = watchAndReindex(tmpDir, config, {
      log: () => {},
      onFlush: async () => {
        flushCount++;
        return { filesScanned: 0, driftCount: 0 };
      },
    });

    try {
      // Writing inside .specgraph must not trigger a flush
      fs.writeFileSync(path.join(tmpDir, '.specgraph', 'graph.db'), 'binary junk');
      await new Promise((r) => setTimeout(r, 2500));
      expect(flushCount).toBe(0);
    } finally {
      await stop();
    }
  }, 10_000);
});
