import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { mergeSettings, installIdeHooks, claudeCodeIntegration } from '../src/core/ide-hooks.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'specgraph-hooks-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function readSettings(rel: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(tmpDir, rel), 'utf-8'));
}

describe('installIdeHooks', () => {
  it('writes the specgraph hooks into a fresh settings file', () => {
    installIdeHooks(tmpDir, claudeCodeIntegration);
    const s = readSettings('.claude/settings.json') as any;
    const cmds = s.hooks.PreToolUse.flatMap((e: any) => e.hooks.map((h: any) => h.command));
    expect(cmds).toContain('specgraph context');
  });

  it('is idempotent — running twice does not duplicate hooks', () => {
    installIdeHooks(tmpDir, claudeCodeIntegration);
    installIdeHooks(tmpDir, claudeCodeIntegration);
    const s = readSettings('.claude/settings.json') as any;
    expect(s.hooks.PreToolUse).toHaveLength(1);
    expect(s.hooks.PostToolUse).toHaveLength(1);
    expect(s.hooks.Stop).toHaveLength(1);
  });

  it('self-heals a settings file that already accumulated duplicates', () => {
    // Simulate the pre-fix state: the same hook entry stacked twice.
    const entry = {
      matcher: 'Write|Edit|MultiEdit',
      hooks: [{ type: 'command', command: 'specgraph context' }],
    };
    const filePath = path.join(tmpDir, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({ hooks: { PreToolUse: [entry, entry] } }));

    installIdeHooks(tmpDir, claudeCodeIntegration);

    expect(readSettings('.claude/settings.json').hooks as any).toMatchObject({
      PreToolUse: expect.any(Array),
    });
    expect((readSettings('.claude/settings.json') as any).hooks.PreToolUse).toHaveLength(1);
  });
});

describe('mergeSettings', () => {
  it('preserves a user hook that differs from the specgraph one', () => {
    const filePath = path.join(tmpDir, 'settings.json');
    const userEntry = {
      matcher: 'Write',
      hooks: [{ type: 'command', command: 'my-own-linter' }],
    };
    fs.writeFileSync(filePath, JSON.stringify({ hooks: { PreToolUse: [userEntry] } }));

    mergeSettings(filePath, {
      hooks: {
        PreToolUse: [
          { matcher: 'Write|Edit|MultiEdit', hooks: [{ type: 'command', command: 'specgraph context' }] },
        ],
      },
    });

    const merged = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    const cmds = merged.hooks.PreToolUse.flatMap((e: any) => e.hooks.map((h: any) => h.command));
    expect(cmds).toContain('my-own-linter');
    expect(cmds).toContain('specgraph context');
    expect(merged.hooks.PreToolUse).toHaveLength(2);
  });

  it('keeps unrelated top-level settings untouched', () => {
    const filePath = path.join(tmpDir, 'settings.json');
    fs.writeFileSync(filePath, JSON.stringify({ model: 'opus', hooks: {} }));
    mergeSettings(filePath, { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'x' }] }] } });
    const merged = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    expect(merged.model).toBe('opus');
  });

  it('starts fresh when the existing file is malformed JSON', () => {
    const filePath = path.join(tmpDir, 'settings.json');
    fs.writeFileSync(filePath, '{ not json');
    mergeSettings(filePath, { hooks: { Stop: [] } });
    expect(() => JSON.parse(fs.readFileSync(filePath, 'utf-8'))).not.toThrow();
  });
});
