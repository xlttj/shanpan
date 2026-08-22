import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import {
  mergeNdjson,
  commitToRef,
  readRefText,
  refSha,
  ensureRef,
  readStamp,
  writeStamp,
  needsRefresh,
} from '../src/core/knowledge-ref.js';
import { readRecords, appendRecords, knowledgePath, serializeRecord } from '../src/core/records.js';
import type { KnowledgeRecord } from '../src/types/record.js';

const REF = 'refs/shanpan/knowledge';

let projectDir: string;

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: projectDir, encoding: 'utf-8' });
}

function rec(over: Partial<KnowledgeRecord> = {}): KnowledgeRecord {
  return {
    id: 'aaaaaaaaaa',
    kn: 'gotcha',
    cl: 'a claim',
    pv: 'u',
    ts: '20260101120000',
    ...over,
  };
}

/** Write the config so readRecords/appendRecords pick the ref up. */
function configureRef(ref: string | null): void {
  fs.writeFileSync(
    path.join(projectDir, '.shanpanrc.json'),
    JSON.stringify({ knowledge: { ref, commit: 'auto' } }),
    'utf-8',
  );
}

beforeEach(() => {
  projectDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shanpan-ref-')));
  fs.mkdirSync(path.join(projectDir, '.shanpan'), { recursive: true });
  git('init', '-q');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.com');
  git('commit', '-q', '--allow-empty', '-m', 'init');
});

afterEach(() => {
  fs.rmSync(projectDir, { recursive: true, force: true });
});

// ─── mergeNdjson ─────────────────────────────────────────────────────────────

describe('mergeNdjson', () => {
  it('keeps the base byte for byte and appends what the other side adds', () => {
    const a = '{"id":"a"}\n{"id":"b"}\n';
    const b = '{"id":"b"}\n{"id":"c"}\n';
    const { text, conflicts } = mergeNdjson(a, b);
    expect(text).toBe('{"id":"a"}\n{"id":"b"}\n{"id":"c"}\n');
    expect(conflicts).toEqual([]);
  });

  // Stability matters: a refresh that changes nothing must produce the same
  // bytes, or every read would commit a new revision of an unchanged log.
  it('is a no-op when the other side adds nothing', () => {
    const a = '{"id":"a"}\n{"id":"b"}\n';
    expect(mergeNdjson(a, a).text).toBe(a);
  });

  it('reports an id carrying different content on the two sides', () => {
    const { text, conflicts } = mergeNdjson('{"id":"a","cl":"one"}\n', '{"id":"a","cl":"two"}\n');
    expect(conflicts).toEqual(['a']);
    // Neither is dropped in favour of the other — the caller has to be told.
    expect(text).toBe('{"id":"a","cl":"one"}\n');
  });

  it('keeps an unparsable line so validation can report it', () => {
    const { text } = mergeNdjson('', 'not json\n');
    expect(text).toContain('not json');
  });

  it('ignores blank lines on both sides', () => {
    expect(mergeNdjson('\n\n{"id":"a"}\n\n', '\n').text).toBe('{"id":"a"}\n');
  });

  it('returns empty text for two empty logs', () => {
    expect(mergeNdjson('', '').text).toBe('');
  });
});

// ─── the ref itself ──────────────────────────────────────────────────────────

describe('commitToRef / readRefText', () => {
  it('round-trips content through a ref', () => {
    const sha = commitToRef(projectDir, REF, 'hello\n', 'test');
    expect(sha).not.toBeNull();
    expect(readRefText(projectDir, REF)).toBe('hello\n');
  });

  it('leaves the working tree untouched', () => {
    commitToRef(projectDir, REF, 'hello\n', 'test');
    expect(git('status', '--porcelain').trim()).toBe('');
  });

  // The ref must not be a branch: a branch can only be checked out in one
  // worktree, and refs outside refs/heads are invisible to `git branch`.
  it('does not show up as a branch', () => {
    commitToRef(projectDir, REF, 'hello\n', 'test');
    expect(git('branch', '--list').includes('knowledge')).toBe(false);
  });

  it('chains commits so the log keeps its history', () => {
    const first = commitToRef(projectDir, REF, 'one\n', 'first');
    commitToRef(projectDir, REF, 'two\n', 'second');
    const parents = git('rev-list', REF).trim().split('\n');
    expect(parents).toContain(first);
    expect(readRefText(projectDir, REF)).toBe('two\n');
  });

  it('returns null outside a git repository', () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'shanpan-plain-'));
    try {
      expect(commitToRef(plain, REF, 'x\n', 'test')).toBeNull();
      expect(refSha(plain, REF)).toBeNull();
    } finally {
      fs.rmSync(plain, { recursive: true, force: true });
    }
  });
});

describe('ensureRef', () => {
  it('creates the ref, seeded from the working tree', () => {
    fs.writeFileSync(knowledgePath(projectDir), '{"id":"a"}\n', 'utf-8');
    expect(ensureRef(projectDir, REF, '{"id":"a"}\n')).toBe('created');
    expect(readRefText(projectDir, REF)).toBe('{"id":"a"}\n');
    expect(readStamp(projectDir)?.sha).toBe(refSha(projectDir, REF));
  });

  it('is idempotent', () => {
    ensureRef(projectDir, REF, '');
    expect(ensureRef(projectDir, REF, '')).toBe('present');
  });

  it('reports when there is no ref configured or no repository', () => {
    expect(ensureRef(projectDir, null, '')).toBe('not-configured');
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'shanpan-plain-'));
    try {
      expect(ensureRef(plain, REF, '')).toBe('not-a-repo');
    } finally {
      fs.rmSync(plain, { recursive: true, force: true });
    }
  });
});

describe('needsRefresh', () => {
  it('is false when there is no ref yet — nothing to merge in', () => {
    expect(needsRefresh(projectDir, REF, null)).toBe(false);
  });

  it('is true when the stamp names a different revision or a different ref', () => {
    writeStamp(projectDir, { ref: REF, sha: 'old' });
    expect(needsRefresh(projectDir, REF, 'new')).toBe(true);
    expect(needsRefresh(projectDir, 'refs/other', 'old')).toBe(true);
    expect(needsRefresh(projectDir, REF, 'old')).toBe(false);
  });
});

// ─── readRecords / appendRecords against a ref ───────────────────────────────

describe('records with knowledge.ref set', () => {
  it('commits an appended record to the ref without dirtying the tree', () => {
    configureRef(REF);
    appendRecords(projectDir, [rec({ id: 'r1' })]);

    expect(readRefText(projectDir, REF)).toContain('"id":"r1"');
    // -uno: the claim is that committing to the ref changes nothing git is
    // tracking. The fixture has no .gitignore, so its own .shanpan/ and config
    // would otherwise count as untracked noise and hide the real assertion.
    expect(git('status', '--porcelain', '-uno').trim()).toBe('');
    expect(readRecords(projectDir).records.map((r) => r.id)).toEqual(['r1']);
  });

  it('pulls in a record that reached the ref from elsewhere', () => {
    configureRef(REF);
    appendRecords(projectDir, [rec({ id: 'r1' })]);

    // Someone else's record arrives on the ref, bypassing this cache entirely.
    const outside = readRefText(projectDir, REF)! + serializeRecord(rec({ id: 'r2' })) + '\n';
    commitToRef(projectDir, REF, outside, 'from elsewhere');

    expect(readRecords(projectDir).records.map((r) => r.id).sort()).toEqual(['r1', 'r2']);
  });

  // The invariant that makes an aborted commit cost nothing.
  it('refreshes by merging, so a record written before a failed commit survives', () => {
    configureRef(REF);
    appendRecords(projectDir, [rec({ id: 'r1' })]);

    // Simulate the crash window: the line is in the cache, never committed.
    fs.appendFileSync(knowledgePath(projectDir), serializeRecord(rec({ id: 'local' })) + '\n');

    // Meanwhile the ref moves on, which forces a refresh on the next read.
    commitToRef(projectDir, REF, readRefText(projectDir, REF)! + serializeRecord(rec({ id: 'r2' })) + '\n', 'other');

    const ids = readRecords(projectDir).records.map((r) => r.id).sort();
    expect(ids).toEqual(['local', 'r1', 'r2']);
  });

  it('carries the uncommitted record to the ref on the next append', () => {
    configureRef(REF);
    appendRecords(projectDir, [rec({ id: 'r1' })]);
    fs.appendFileSync(knowledgePath(projectDir), serializeRecord(rec({ id: 'local' })) + '\n');

    appendRecords(projectDir, [rec({ id: 'r3' })]);

    const onRef = readRefText(projectDir, REF)!;
    expect(onRef).toContain('"id":"local"');
    expect(onRef).toContain('"id":"r3"');
  });

  it('surfaces a genuine id collision as a validation error rather than picking a winner', () => {
    configureRef(REF);
    appendRecords(projectDir, [rec({ id: 'dup', cl: 'local version' })]);
    // Same id, different content, arriving on the ref.
    commitToRef(projectDir, REF, serializeRecord(rec({ id: 'dup', cl: 'ref version' })) + '\n', 'collide');

    const { errors } = readRecords(projectDir);
    expect(errors.some((e) => e.id === 'dup')).toBe(true);
  });

  it('behaves exactly as before when no ref is configured', () => {
    configureRef(null);
    appendRecords(projectDir, [rec({ id: 'r1' })]);

    expect(refSha(projectDir, REF)).toBeNull();
    expect(readRecords(projectDir).records.map((r) => r.id)).toEqual(['r1']);
    // The file is still the source of truth, and no stamp is written.
    expect(fs.existsSync(knowledgePath(projectDir))).toBe(true);
    expect(readStamp(projectDir)).toBeNull();
  });
});

// ─── sync between two clones ─────────────────────────────────────────────────
// Exercised against a local bare remote: no network, deterministic, and it
// covers exactly the paths that matter — fetch, merge, the merge-commit parent
// that makes a push fast-forward, and the retry after a rejection.

describe('syncKnowledge', () => {
  let bare: string;
  let alice: string;
  let bob: string;

  function run(dir: string, ...args: string[]): string {
    return execFileSync('git', args, { cwd: dir, encoding: 'utf-8' });
  }

  function clone(name: string): string {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `shanpan-${name}-`)));
    execFileSync('git', ['clone', '-q', bare, dir], { encoding: 'utf-8' });
    run(dir, 'config', 'user.name', name);
    run(dir, 'config', 'user.email', `${name}@example.com`);
    fs.mkdirSync(path.join(dir, '.shanpan'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.shanpanrc.json'),
      JSON.stringify({ knowledge: { ref: REF, commit: 'auto', pull: 'auto', push: 'auto' } }),
      'utf-8',
    );
    return dir;
  }

  beforeEach(() => {
    bare = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shanpan-bare-')));
    execFileSync('git', ['init', '-q', '--bare', bare], { encoding: 'utf-8' });
    // Point the bare repo's HEAD at the branch the seed pushes, or every clone
    // warns about a dangling HEAD and buries the real test output.
    execFileSync('git', ['--git-dir', bare, 'symbolic-ref', 'HEAD', 'refs/heads/main'], {
      encoding: 'utf-8',
    });

    const seed = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shanpan-seed-')));
    execFileSync('git', ['init', '-q', seed], { encoding: 'utf-8' });
    run(seed, 'config', 'user.name', 'Seed');
    run(seed, 'config', 'user.email', 'seed@example.com');
    run(seed, 'commit', '-q', '--allow-empty', '-m', 'init');
    run(seed, 'branch', '-M', 'main');
    run(seed, 'remote', 'add', 'origin', bare);
    run(seed, 'push', '-q', 'origin', 'main');
    fs.rmSync(seed, { recursive: true, force: true });

    alice = clone('alice');
    bob = clone('bob');
  });

  afterEach(() => {
    for (const d of [bare, alice, bob]) fs.rmSync(d, { recursive: true, force: true });
  });

  it('pushes what one machine wrote and hands it to the next', async () => {
    const { syncKnowledge } = await import('../src/core/knowledge-sync.js');

    appendRecords(alice, [rec({ id: 'fromalice' })]);
    const pushed = syncKnowledge(alice);
    expect(pushed.status).toBe('ok');
    expect(pushed.pushed).toBe(true);

    const got = syncKnowledge(bob);
    expect(got.gained).toBe(1);
    expect(readRecords(bob).records.map((r) => r.id)).toEqual(['fromalice']);
  });

  // The case the merge-commit parent exists for: both sides commit before
  // either pushes, so the second push is only a fast-forward if the fetched
  // tip became an ancestor.
  it('converges when both machines wrote before either synced', async () => {
    const { syncKnowledge } = await import('../src/core/knowledge-sync.js');

    appendRecords(alice, [rec({ id: 'fromalice' })]);
    appendRecords(bob, [rec({ id: 'frombob' })]);

    expect(syncKnowledge(alice).pushed).toBe(true);
    const second = syncKnowledge(bob);
    expect(second.status).toBe('ok');
    expect(second.pushed).toBe(true);

    // Bob holds both; Alice picks up Bob's on her next sync.
    expect(readRecords(bob).records.map((r) => r.id).sort()).toEqual(['fromalice', 'frombob']);
    syncKnowledge(alice);
    expect(readRecords(alice).records.map((r) => r.id).sort()).toEqual(['fromalice', 'frombob']);
  });

  it('writes no commit and reports nothing gained when everything is already shared', async () => {
    const { syncKnowledge } = await import('../src/core/knowledge-sync.js');

    appendRecords(alice, [rec({ id: 'shared' })]);
    syncKnowledge(alice);
    const before = refSha(alice, REF);

    const again = syncKnowledge(alice);
    expect(again.gained).toBe(0);
    expect(refSha(alice, REF)).toBe(before); // a quiet repository stays quiet
  });

  it('never touches either working tree', async () => {
    const { syncKnowledge } = await import('../src/core/knowledge-sync.js');
    appendRecords(alice, [rec({ id: 'fromalice' })]);
    syncKnowledge(alice);
    syncKnowledge(bob);
    expect(run(alice, 'status', '--porcelain', '-uno').trim()).toBe('');
    expect(run(bob, 'status', '--porcelain', '-uno').trim()).toBe('');
  });

  // A push that cannot happen at all must not be reported as contention: "no
  // permission" and "lost a race" send people to fix entirely different things.
  it('stops at once and quotes git when the push is not retryable', async () => {
    const { syncKnowledge } = await import('../src/core/knowledge-sync.js');
    run(alice, 'remote', 'set-url', 'origin', path.join(alice, 'does-not-exist.git'));
    appendRecords(alice, [rec({ id: 'stranded' })]);

    const result = syncKnowledge(alice);
    expect(result.status).toBe('push-failed');
    expect(result.attempts).toBe(1); // not three
    expect(result.error.length).toBeGreaterThan(0);
    // The record is safe locally even though it reached nobody.
    expect(readRecords(alice).records.map((r) => r.id)).toEqual(['stranded']);
  });

  it('does nothing without a ref configured', async () => {
    const { syncKnowledge } = await import('../src/core/knowledge-sync.js');
    fs.writeFileSync(path.join(alice, '.shanpanrc.json'), JSON.stringify({}), 'utf-8');
    expect(syncKnowledge(alice).status).toBe('not-configured');
  });

  it('commits locally but does not push when push is off', async () => {
    const { syncKnowledge } = await import('../src/core/knowledge-sync.js');
    fs.writeFileSync(
      path.join(alice, '.shanpanrc.json'),
      JSON.stringify({ knowledge: { ref: REF, commit: 'auto', pull: 'auto', push: 'never' } }),
      'utf-8',
    );
    appendRecords(alice, [rec({ id: 'private' })]);
    const result = syncKnowledge(alice);
    expect(result.pushed).toBe(false);
    expect(refSha(alice, REF)).not.toBeNull();
    expect(syncKnowledge(bob).gained).toBe(0);
  });
});

// ─── the unfetched clone ─────────────────────────────────────────────────────
// The state an agent sandbox lands in: config committed, ref never fetched.
// Absence here must never be reported as "nothing is known".

describe('refDeclaredButAbsent', () => {
  it('names the ref when it is configured but missing', async () => {
    const { refDeclaredButAbsent } = await import('../src/cli/commands/mcp.js');
    configureRef(REF);
    expect(refDeclaredButAbsent(projectDir)).toBe(REF);
  });

  it('stays silent once the ref is there', async () => {
    const { refDeclaredButAbsent } = await import('../src/cli/commands/mcp.js');
    configureRef(REF);
    ensureRef(projectDir, REF, '');
    expect(refDeclaredButAbsent(projectDir)).toBeNull();
  });

  it('stays silent when no ref is configured at all', async () => {
    const { refDeclaredButAbsent } = await import('../src/cli/commands/mcp.js');
    configureRef(null);
    expect(refDeclaredButAbsent(projectDir)).toBeNull();
  });
});
