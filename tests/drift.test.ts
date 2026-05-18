import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { driftKey, loadDriftCache, saveDriftCache } from '../src/core/drift.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'specgraph-drift-'));
  fs.mkdirSync(path.join(tmpDir, '.specgraph'), { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('driftKey', () => {
  it('produces a stable string per (specId, symbolId) pair', () => {
    const a = driftKey({ specId: 'orders/x', symbolId: 'src/a.ts::A' });
    const b = driftKey({ specId: 'orders/x', symbolId: 'src/a.ts::A' });
    expect(a).toBe(b);
  });

  it('distinguishes different specs with same symbol', () => {
    const a = driftKey({ specId: 'orders/x', symbolId: 's' });
    const b = driftKey({ specId: 'orders/y', symbolId: 's' });
    expect(a).not.toBe(b);
  });
});

describe('drift cache (loop prevention)', () => {
  it('returns an empty set when no cache file exists', () => {
    expect(loadDriftCache(tmpDir).size).toBe(0);
  });

  it('round-trips a list of drift entries', () => {
    saveDriftCache(tmpDir, [
      { specId: 'a', symbolId: 'x' },
      { specId: 'b', symbolId: 'y' },
    ]);
    const reloaded = loadDriftCache(tmpDir);
    expect(reloaded.has(driftKey({ specId: 'a', symbolId: 'x' }))).toBe(true);
    expect(reloaded.has(driftKey({ specId: 'b', symbolId: 'y' }))).toBe(true);
    expect(reloaded.size).toBe(2);
  });

  it('overwrites the cache on each save (no accumulation)', () => {
    saveDriftCache(tmpDir, [{ specId: 'a', symbolId: 'x' }]);
    saveDriftCache(tmpDir, [{ specId: 'b', symbolId: 'y' }]);
    const reloaded = loadDriftCache(tmpDir);
    expect(reloaded.size).toBe(1);
    expect(reloaded.has(driftKey({ specId: 'b', symbolId: 'y' }))).toBe(true);
  });

  it('treats a malformed cache file as empty', () => {
    fs.writeFileSync(path.join(tmpDir, '.specgraph', 'last-drift-report.json'), 'not json');
    expect(loadDriftCache(tmpDir).size).toBe(0);
  });

  it('saving an empty list clears the cache', () => {
    saveDriftCache(tmpDir, [{ specId: 'a', symbolId: 'x' }]);
    saveDriftCache(tmpDir, []);
    expect(loadDriftCache(tmpDir).size).toBe(0);
  });

  it('a persistent drift set produces no new entries on the second call', () => {
    const drift = [
      { specId: 'a', symbolId: 'x' },
      { specId: 'b', symbolId: 'y' },
    ];
    // First call: nothing cached, everything is new.
    const cached1 = loadDriftCache(tmpDir);
    const new1 = drift.filter((d) => !cached1.has(driftKey(d)));
    expect(new1).toHaveLength(2);
    saveDriftCache(tmpDir, drift);

    // Second call: same drift, nothing new — this is what breaks the loop.
    const cached2 = loadDriftCache(tmpDir);
    const new2 = drift.filter((d) => !cached2.has(driftKey(d)));
    expect(new2).toHaveLength(0);
  });
});
