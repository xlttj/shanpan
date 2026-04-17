import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  installPostCommitHook,
  uninstallPostCommitHook,
} from '../src/cli/commands/hook.js';

const MARKER = '# specgraph post-commit hook';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'specgraph-hook-'));
  fs.mkdirSync(path.join(tmpDir, '.git', 'hooks'), { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function readHook(): string {
  return fs.readFileSync(path.join(tmpDir, '.git', 'hooks', 'post-commit'), 'utf-8');
}

describe('installPostCommitHook', () => {
  it('creates a new post-commit hook when none exists', () => {
    const result = installPostCommitHook(tmpDir);
    expect(result).toBe('created');
    const content = readHook();
    expect(content).toContain(MARKER);
    expect(content).toContain('specgraph analyze');
  });

  it('is idempotent: calling twice does not duplicate the block', () => {
    installPostCommitHook(tmpDir);
    const result2 = installPostCommitHook(tmpDir);
    expect(result2).toBe('exists');
    const content = readHook();
    const markerCount = content.split(MARKER).length - 1;
    expect(markerCount).toBe(1);
  });

  it('appends to an existing hook without destroying prior content', () => {
    const preExisting = '#!/bin/sh\necho "pre-existing hook"\n';
    fs.writeFileSync(path.join(tmpDir, '.git', 'hooks', 'post-commit'), preExisting);
    const result = installPostCommitHook(tmpDir);
    expect(result).toBe('appended');
    const content = readHook();
    expect(content).toContain('pre-existing hook');
    expect(content).toContain(MARKER);
  });

  it('throws when not inside a git repo', () => {
    const noGit = fs.mkdtempSync(path.join(os.tmpdir(), 'no-git-'));
    try {
      expect(() => installPostCommitHook(noGit)).toThrow(/Not a git repository/);
    } finally {
      fs.rmSync(noGit, { recursive: true, force: true });
    }
  });
});

describe('uninstallPostCommitHook', () => {
  it('removes only the specgraph block, leaves other content intact', () => {
    const preExisting = '#!/bin/sh\necho "pre-existing hook"\n';
    fs.writeFileSync(path.join(tmpDir, '.git', 'hooks', 'post-commit'), preExisting);
    installPostCommitHook(tmpDir);
    const removed = uninstallPostCommitHook(tmpDir);
    expect(removed).toBe('removed');
    const content = readHook();
    expect(content).toContain('pre-existing hook');
    expect(content).not.toContain(MARKER);
    expect(content).not.toContain('specgraph analyze');
  });

  it('returns absent when hook exists without specgraph block', () => {
    fs.writeFileSync(path.join(tmpDir, '.git', 'hooks', 'post-commit'), '#!/bin/sh\necho hi\n');
    const result = uninstallPostCommitHook(tmpDir);
    expect(result).toBe('absent');
  });

  it('returns not_found when no hook file exists', () => {
    const result = uninstallPostCommitHook(tmpDir);
    expect(result).toBe('not_found');
  });

  it('round-trip: install then uninstall returns hook to pristine state', () => {
    const pristine = '#!/bin/sh\necho "original"\n';
    fs.writeFileSync(path.join(tmpDir, '.git', 'hooks', 'post-commit'), pristine);
    installPostCommitHook(tmpDir);
    uninstallPostCommitHook(tmpDir);
    const content = readHook();
    expect(content.trim()).toBe(pristine.trim());
  });
});
