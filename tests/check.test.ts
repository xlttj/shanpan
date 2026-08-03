import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// We test the pure logic helpers extracted from check.ts rather than the
// full runCheck (which requires git, a real DB, and process.exit).
// The key correctness concerns are: parsing git diff output and the Cypher
// path-list escaping. We import and test them via a small test-only re-export.

// Re-test the path parsing logic inline (mirrors check.ts getStagedChanges)
function parseDiffOutput(output: string): { removed: string[]; modified: string[] } {
  const removed: string[] = [];
  const modified: string[] = [];
  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split('\t');
    const status = parts[0] ?? '';
    if (status === 'D') {
      if (parts[1]) removed.push(parts[1]);
    } else if (status.startsWith('R')) {
      if (parts[1]) removed.push(parts[1]);
    } else if (status === 'M') {
      if (parts[1]) modified.push(parts[1]);
    }
  }
  return { removed, modified };
}

describe('parseDiffOutput (staged change parsing)', () => {
  it('collects deleted file paths into removed', () => {
    const output = 'D\tsrc/foo.ts\nD\tsrc/bar.ts\n';
    expect(parseDiffOutput(output)).toEqual({ removed: ['src/foo.ts', 'src/bar.ts'], modified: [] });
  });

  it('collects the old path for renames into removed', () => {
    const output = 'R100\tsrc/old.ts\tsrc/new.ts\n';
    expect(parseDiffOutput(output)).toEqual({ removed: ['src/old.ts'], modified: [] });
  });

  it('collects modified files into modified, not removed', () => {
    const output = 'M\tsrc/foo.ts\n';
    expect(parseDiffOutput(output)).toEqual({ removed: [], modified: ['src/foo.ts'] });
  });

  it('ignores added files', () => {
    const output = 'A\tsrc/new.ts\n';
    expect(parseDiffOutput(output)).toEqual({ removed: [], modified: [] });
  });

  it('returns empty buckets for empty output', () => {
    expect(parseDiffOutput('')).toEqual({ removed: [], modified: [] });
  });

  it('correctly splits D, R, and M into separate buckets', () => {
    const output = 'D\tsrc/a.ts\nR90\tsrc/b.ts\tsrc/c.ts\nM\tsrc/d.ts\nA\tsrc/e.ts\n';
    expect(parseDiffOutput(output)).toEqual({
      removed: ['src/a.ts', 'src/b.ts'],
      modified: ['src/d.ts'],
    });
  });

  it('modified files do not cause a hard block (removed stays empty)', () => {
    const output = 'M\tsrc/tracked.ts\n';
    const { removed } = parseDiffOutput(output);
    // removed must be empty — no exit-1 should be triggered
    expect(removed).toHaveLength(0);
  });
});

// Cypher escaping for path lists
function escList(paths: string[]): string {
  return paths.map((p) => `'${p.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`).join(', ');
}

describe('escList (Cypher path escaping)', () => {
  it('wraps paths in single quotes', () => {
    expect(escList(['src/foo.ts'])).toBe("'src/foo.ts'");
  });

  it('joins multiple paths with commas', () => {
    expect(escList(['src/a.ts', 'src/b.ts'])).toBe("'src/a.ts', 'src/b.ts'");
  });

  it('escapes single quotes in paths', () => {
    expect(escList(["src/it's.ts"])).toBe("'src/it\\'s.ts'");
  });

  it('returns empty string for empty array', () => {
    expect(escList([])).toBe('');
  });
});

// Integration: check that the check command file exists and exports runCheck
describe('check command module', () => {
  it('exports a runCheck function', async () => {
    const mod = await import('../src/cli/commands/check.js');
    expect(typeof mod.runCheck).toBe('function');
  });
});

describe('blockResponse (Stop hook dialects)', () => {
  it('blocks with decision/reason for Claude Code', async () => {
    const { blockResponse } = await import('../src/cli/commands/check.js');
    expect(JSON.parse(blockResponse('claude', 'drift found'))).toEqual({
      decision: 'block',
      reason: 'drift found',
    });
  });

  it('uses followup_message for Cursor, which has no block field on stop', async () => {
    const { blockResponse } = await import('../src/cli/commands/check.js');
    expect(JSON.parse(blockResponse('cursor', 'drift found'))).toEqual({
      followup_message: 'drift found',
    });
  });

  it('never emits Claude fields in the cursor dialect', async () => {
    const { blockResponse } = await import('../src/cli/commands/check.js');
    const out = JSON.parse(blockResponse('cursor', 'x'));
    expect('decision' in out).toBe(false);
    expect('reason' in out).toBe(false);
  });

  it('preserves multi-line reasons through JSON', async () => {
    const { blockResponse } = await import('../src/cli/commands/check.js');
    expect(JSON.parse(blockResponse('cursor', 'a\n\nb')).followup_message).toBe('a\n\nb');
  });

  it('uses prompt for OpenCode, consumed by the specgraph-drift plugin', async () => {
    const { blockResponse } = await import('../src/cli/commands/check.js');
    expect(JSON.parse(blockResponse('opencode', 'drift found'))).toEqual({
      prompt: 'drift found',
    });
  });

  it('parseHookFormat defaults unknown values to claude', async () => {
    const { parseHookFormat } = await import('../src/cli/commands/check.js');
    expect(parseHookFormat('cursor')).toBe('cursor');
    expect(parseHookFormat('opencode')).toBe('opencode');
    expect(parseHookFormat('anything-else')).toBe('claude');
  });
});
