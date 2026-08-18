import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { detectSkew, writeAnalyzerBuild, readAnalyzerBuild } from '../src/core/build-info.js';

describe('detectSkew', () => {
  it('reports unknown (null) when the graph has no build marker', () => {
    expect(detectSkew('100', null).inSync).toBeNull();
    expect(detectSkew('100', null).advice).toBeNull();
  });

  it('is in sync when server and graph builds match', () => {
    const s = detectSkew('12345', '12345');
    expect(s.inSync).toBe(true);
    expect(s.advice).toBeNull();
  });

  it('tells the user to restart when the graph is newer than the server', () => {
    const s = detectSkew('100', '200');
    expect(s.inSync).toBe(false);
    expect(s.advice).toMatch(/restart/i);
  });

  it('tells the user to re-analyze when the server is newer than the graph', () => {
    const s = detectSkew('300', '200');
    expect(s.inSync).toBe(false);
    expect(s.advice).toMatch(/analyze --full/);
  });
});

describe('analyzer build marker', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shanpan-build-'));
    fs.mkdirSync(path.join(dir, '.shanpan'), { recursive: true });
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('round-trips the build id through the marker file', () => {
    expect(readAnalyzerBuild(dir)).toBeNull();
    writeAnalyzerBuild(dir, 'abc123');
    expect(readAnalyzerBuild(dir)).toBe('abc123');
  });
});
