import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  mergeSettings,
  installIdeHooks,
  installOpenCodePlugin,
  claudeCodeIntegration,
  cursorIntegration,
  openCodeIntegration,
} from '../src/core/ide-hooks.js';
import { PLUGIN_MARKER } from '../src/opencode/specgraph-drift.plugin.js';

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

describe('cursor integration', () => {
  it('writes hooks.json — Cursor never reads .cursor/settings.json', () => {
    installIdeHooks(tmpDir, cursorIntegration);
    expect(fs.existsSync(path.join(tmpDir, '.cursor/hooks.json'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, '.cursor/settings.json'))).toBe(false);
  });

  it('uses Cursor native schema: version 1 and camelCase events', () => {
    installIdeHooks(tmpDir, cursorIntegration);
    const s = readSettings('.cursor/hooks.json') as any;
    expect(s.version).toBe(1);
    expect(Object.keys(s.hooks).sort()).toEqual(['postToolUse', 'sessionStart', 'stop']);
  });

  it('carries no Claude Code schema artefacts', () => {
    installIdeHooks(tmpDir, cursorIntegration);
    const raw = fs.readFileSync(path.join(tmpDir, '.cursor/hooks.json'), 'utf-8');
    expect(raw).not.toContain('PreToolUse');
    expect(raw).not.toContain('"async"');
    // Native entries hold the command directly, not a nested hooks array.
    const s = JSON.parse(raw) as any;
    expect(s.hooks.stop[0].hooks).toBeUndefined();
    expect(typeof s.hooks.stop[0].command).toBe('string');
  });

  it('asks check for the cursor output dialect, since stop has no block field', () => {
    installIdeHooks(tmpDir, cursorIntegration);
    const s = readSettings('.cursor/hooks.json') as any;
    expect(s.hooks.stop[0].command).toContain('--format cursor');
  });

  it('regenerates rules on session start and after edits', () => {
    installIdeHooks(tmpDir, cursorIntegration);
    const s = readSettings('.cursor/hooks.json') as any;
    expect(s.hooks.sessionStart[0].command).toContain('specgraph rules');
    expect(s.hooks.postToolUse[0].command).toContain('specgraph rules');
    expect(s.hooks.postToolUse[0].matcher).toBe('Write');
  });

  it('is idempotent — running twice does not duplicate hooks', () => {
    installIdeHooks(tmpDir, cursorIntegration);
    installIdeHooks(tmpDir, cursorIntegration);
    const s = readSettings('.cursor/hooks.json') as any;
    expect(s.hooks.sessionStart).toHaveLength(1);
    expect(s.hooks.postToolUse).toHaveLength(1);
    expect(s.hooks.stop).toHaveLength(1);
  });

  it('does not install a preToolUse context hook, which Cursor would discard', () => {
    installIdeHooks(tmpDir, cursorIntegration);
    const s = readSettings('.cursor/hooks.json') as any;
    expect(s.hooks.preToolUse).toBeUndefined();
  });
});

describe('OpenCode integration', () => {
  it('writes opencode.json with experimental shell hooks', () => {
    installIdeHooks(tmpDir, openCodeIntegration);
    const s = readSettings('opencode.json') as any;
    expect(s.experimental.hook.file_edited[0].command).toEqual(['specgraph', 'analyze']);
    expect(s.experimental.hook.session_completed[0].command).toEqual(['specgraph', 'check']);
  });

  it('does not use --hook-output on session_completed — config hooks ignore stdout JSON', () => {
    installIdeHooks(tmpDir, openCodeIntegration);
    const raw = fs.readFileSync(path.join(tmpDir, 'opencode.json'), 'utf-8');
    expect(raw).not.toContain('--hook-output');
  });

  it('installs the drift plugin template', () => {
    installOpenCodePlugin(tmpDir);
    const pluginPath = path.join(tmpDir, '.opencode/plugin/specgraph-drift.ts');
    expect(fs.existsSync(pluginPath)).toBe(true);
    expect(fs.readFileSync(pluginPath, 'utf-8')).toContain(PLUGIN_MARKER);
    expect(fs.readFileSync(pluginPath, 'utf-8')).toContain('session.idle');
  });

  it('is idempotent — running twice does not duplicate hooks', () => {
    installIdeHooks(tmpDir, openCodeIntegration);
    installIdeHooks(tmpDir, openCodeIntegration);
    const s = readSettings('opencode.json') as any;
    expect(s.experimental.hook.file_edited).toHaveLength(1);
    expect(s.experimental.hook.session_completed).toHaveLength(1);
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
