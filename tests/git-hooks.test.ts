import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import {
  renderHookFile,
  installGitHooks,
  GIT_HOOKS,
  HOOK_BEGIN,
  HOOK_END,
} from '../src/core/git-hooks.js';

// ─── renderHookFile (pure merge logic) ───────────────────────────────────────

describe('renderHookFile', () => {
  it('creates a fresh hook with a shebang and the managed block', () => {
    const out = renderHookFile(null, 'echo hi');
    expect(out.startsWith('#!/bin/sh\n')).toBe(true);
    expect(out).toContain(HOOK_BEGIN);
    expect(out).toContain('echo hi');
    expect(out).toContain(HOOK_END);
  });

  it('treats an empty existing file as fresh', () => {
    expect(renderHookFile('   \n', 'echo hi').startsWith('#!/bin/sh')).toBe(true);
  });

  it('replaces an earlier managed block in place (idempotent update)', () => {
    const first = renderHookFile(null, 'echo v1');
    const second = renderHookFile(first, 'echo v2');
    expect(second).toContain('echo v2');
    expect(second).not.toContain('echo v1');
    // Exactly one managed block, not two stacked.
    expect(second.split(HOOK_BEGIN)).toHaveLength(2);
  });

  it('appends to a user hook without a managed block, never clobbering it', () => {
    const userHook = '#!/bin/sh\nnpm run lint\n';
    const out = renderHookFile(userHook, 'shanpan analyze');
    expect(out).toContain('npm run lint'); // user content survives
    expect(out).toContain('shanpan analyze');
    expect(out.indexOf('npm run lint')).toBeLessThan(out.indexOf(HOOK_BEGIN));
  });

  it('running twice over a user hook does not duplicate our block', () => {
    const userHook = '#!/bin/sh\nnpm test\n';
    const once = renderHookFile(userHook, 'shanpan check --staged');
    const twice = renderHookFile(once, 'shanpan check --staged');
    expect(twice.split(HOOK_BEGIN)).toHaveLength(2);
    expect(twice).toContain('npm test');
  });
});

// ─── installGitHooks (against a real git repo) ───────────────────────────────

describe('installGitHooks', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shanpan-githooks-'));
    execFileSync('git', ['init', '-q'], { cwd: tmpDir });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes all managed hooks and marks them executable', () => {
    const written = installGitHooks(tmpDir);
    expect(written).toEqual(Object.keys(GIT_HOOKS));
    for (const name of written!) {
      const p = path.join(tmpDir, '.git', 'hooks', name);
      expect(fs.existsSync(p)).toBe(true);
      // owner-executable bit set
      expect(fs.statSync(p).mode & 0o100).toBeTruthy();
    }
  });

  it('post-checkout only rebuilds on a branch checkout, not a file checkout', () => {
    installGitHooks(tmpDir);
    const body = fs.readFileSync(path.join(tmpDir, '.git', 'hooks', 'post-checkout'), 'utf-8');
    expect(body).toContain('[ "$3" = "1" ] || exit 0');
  });

  it('pre-commit does not swallow the check exit code, so a violation blocks', () => {
    installGitHooks(tmpDir);
    const body = fs.readFileSync(path.join(tmpDir, '.git', 'hooks', 'pre-commit'), 'utf-8');
    expect(body).toContain('shanpan check --staged');
    expect(body).not.toContain('check --staged >/dev/null');
    expect(body).not.toMatch(/check --staged.*\|\| true/);
  });

  it('is idempotent across re-runs', () => {
    installGitHooks(tmpDir);
    installGitHooks(tmpDir);
    const body = fs.readFileSync(path.join(tmpDir, '.git', 'hooks', 'post-merge'), 'utf-8');
    expect(body.split(HOOK_BEGIN)).toHaveLength(2);
  });

  it('returns null outside a git repository', () => {
    const nonRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'shanpan-nonrepo-'));
    try {
      expect(installGitHooks(nonRepo)).toBeNull();
    } finally {
      fs.rmSync(nonRepo, { recursive: true, force: true });
    }
  });
});
