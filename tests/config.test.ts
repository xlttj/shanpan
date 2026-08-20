import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadConfig, saveConfig, RC_FILE } from '../src/core/config.js';
import { DEFAULT_CONFIG } from '../src/types/config.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shanpan-config-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeRc(value: unknown): void {
  fs.writeFileSync(path.join(tmpDir, RC_FILE), JSON.stringify(value), 'utf-8');
}

describe('loadConfig — knowledge block', () => {
  it('defaults to notifying on inferred records when there is no config at all', () => {
    expect(loadConfig(tmpDir).knowledge.notify).toBe('inferred');
  });

  // The block is new, so every config file written before it exists lacks it.
  // Those projects must keep working, not fall into an undefined mode.
  it('fills in the default for a config that predates the knowledge block', () => {
    writeRc({ analyze: { include: ['app'], exclude: [], languages: ['php'] } });
    const config = loadConfig(tmpDir);
    expect(config.knowledge.notify).toBe('inferred');
    expect(config.analyze.include).toEqual(['app']);
  });

  it('reads an explicit mode', () => {
    writeRc({ knowledge: { notify: 'never' } });
    expect(loadConfig(tmpDir).knowledge.notify).toBe('never');
  });

  // A typo, or a mode from a newer shanpan, must not put this build into a
  // state it has no behaviour for.
  it('falls back to the default for an unknown mode', () => {
    writeRc({ knowledge: { notify: 'sometimes' } });
    expect(loadConfig(tmpDir).knowledge.notify).toBe('inferred');
  });

  it('round-trips through saveConfig', () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.knowledge.notify = 'all';
    saveConfig(tmpDir, config);
    expect(loadConfig(tmpDir).knowledge.notify).toBe('all');
  });
});
