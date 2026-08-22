/**
 * Holding the knowledge log on a git ref of its own.
 *
 * Everything that shells out to git lives here and nowhere else, so the rest
 * of the code keeps talking to two functions in records.ts and never learns
 * where the bytes come from.
 *
 * Three rules shape this module:
 *
 *   - **The ref is the truth; the file in .shanpan is cache.** The cache exists
 *     so validation errors can name a line a human can open, and so grep and an
 *     editor keep working on a plaintext format.
 *   - **Refresh merges, never overwrites.** A record appended just before an
 *     aborted commit is still in the cache, and the next refresh carries it
 *     forward instead of dropping it.
 *   - **Nothing is ever checked out.** Reads go through `git show`, writes
 *     through hash-object/mktree/commit-tree/update-ref. No worktree is
 *     touched, which is the entire point: recording knowledge must not dirty
 *     the tree someone is working in.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DB_DIR } from './db.js';

/**
 * Name the blob carries inside the ref's tree. Spelled out rather than
 * imported from records.ts, which imports this module — the cycle would be
 * legal but fragile, and one shared literal is not worth it. It must stay in
 * step with KNOWLEDGE_FILE so `git show <ref>:<name>` keeps resolving.
 */
export const REF_BLOB_NAME = 'knowledge.ndjson';

/** Where the cache records which ref revision it has already merged. */
export const STAMP_FILE = 'knowledge-ref.json';

export interface RefStamp {
  ref: string;
  sha: string;
}

/**
 * Run git, returning stdout — or null when git fails for any reason. Callers
 * treat null as "this is not available", never as an error to throw: a project
 * that is not a git repository must keep working on the plain file.
 */
function git(projectDir: string, args: string[], input?: string): string | null {
  try {
    return execFileSync('git', args, {
      cwd: projectDir,
      encoding: 'utf-8',
      input,
      maxBuffer: 256 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    return null;
  }
}

export function isGitRepo(projectDir: string): boolean {
  return git(projectDir, ['rev-parse', '--git-dir']) !== null;
}

/**
 * Current revision of the ref, or null when it does not exist yet. This is the
 * cache key — one sub-millisecond call decides whether a refresh is needed.
 */
export function refSha(projectDir: string, ref: string): string | null {
  const out = git(projectDir, ['rev-parse', '--verify', '--quiet', ref]);
  const sha = out?.trim();
  return sha && sha.length > 0 ? sha : null;
}

/** Contents of the knowledge blob on the ref, or null when the ref is absent. */
export function readRefText(projectDir: string, ref: string): string | null {
  if (refSha(projectDir, ref) === null) return null;
  return git(projectDir, ['show', `${ref}:${REF_BLOB_NAME}`]) ?? '';
}

/**
 * An identity for the knowledge commits. The repository's own is used when it
 * has one, because who recorded a piece of knowledge is worth keeping; the
 * fallback only exists so a repository without a configured user still works.
 */
function commitEnv(projectDir: string): NodeJS.ProcessEnv {
  const name = git(projectDir, ['config', 'user.name'])?.trim();
  const email = git(projectDir, ['config', 'user.email'])?.trim();
  if (name && email) return process.env;
  return {
    ...process.env,
    GIT_AUTHOR_NAME: name || 'shanpan',
    GIT_AUTHOR_EMAIL: email || 'shanpan@localhost',
    GIT_COMMITTER_NAME: name || 'shanpan',
    GIT_COMMITTER_EMAIL: email || 'shanpan@localhost',
  };
}

/**
 * Write `text` to the ref as a single-file tree, without touching the worktree.
 * Returns the new revision, or null if any step failed — a failed commit is
 * survivable, because the record is already in the cache and the next refresh
 * carries it forward.
 */
export function commitToRef(
  projectDir: string,
  ref: string,
  text: string,
  message: string,
  extraParents: string[] = [],
): string | null {
  const blob = git(projectDir, ['hash-object', '-w', '--stdin'], text)?.trim();
  if (!blob) return null;

  const tree = git(projectDir, ['mktree'], `100644 blob ${blob}\t${REF_BLOB_NAME}\n`)?.trim();
  if (!tree) return null;

  const parent = refSha(projectDir, ref);
  // A second parent is what makes the push a fast-forward after a fetch: the
  // remote tip becomes an ancestor, so the remote accepts the result instead of
  // rejecting two histories that merely happen to share content.
  const parents = [...(parent ? [parent] : []), ...extraParents.filter((p) => p !== parent)];
  const args = ['commit-tree', tree, ...parents.flatMap((p) => ['-p', p]), '-m', message];
  let commit: string | undefined;
  try {
    commit = execFileSync('git', args, {
      cwd: projectDir,
      encoding: 'utf-8',
      env: commitEnv(projectDir),
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return null;
  }
  if (!commit) return null;

  // Compare-and-swap against the revision we built on, so a concurrent writer
  // is refused rather than silently overwritten.
  const update = git(projectDir, ['update-ref', ref, commit, ...(parent ? [parent] : [''])]);
  return update === null ? null : commit;
}

// ─── moving the ref between machines ─────────────────────────────────────────

/**
 * Environment for the two operations that talk to a remote.
 *
 * Git opens `/dev/tty` directly for credential prompts, so redirecting stdio
 * does not stop it asking — a sync running from `post-merge` or a session-start
 * hook would sit there forever, invisibly, waiting for a password nobody is
 * being shown. Prompts are therefore allowed only when a human is actually
 * watching this run.
 *
 * Credential *helpers* keep working either way: the keychain, libsecret and
 * ssh-agent all answer without a terminal. Only the raw prompt is suppressed,
 * which turns an indefinite hang into an error message naming the cause.
 */
function networkEnv(): NodeJS.ProcessEnv {
  if (process.stdout.isTTY) return process.env;
  const ssh = process.env['GIT_SSH_COMMAND'] ?? 'ssh';
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    // BatchMode leaves agent and keyfile auth untouched; it only stops ssh
    // asking for a passphrase it has no way to display here.
    GIT_SSH_COMMAND: `${ssh} -o BatchMode=yes`,
  };
}

export interface Fetched {
  sha: string;
  text: string;
}

/**
 * Fetch the ref from a remote without moving any local ref — the result lands
 * in FETCH_HEAD, so nothing local is overwritten before the merge decides what
 * to keep. Returns null when the remote has no such ref yet, which is the
 * ordinary state of the first machine to push.
 */
export function fetchRef(projectDir: string, remote: string, ref: string): Fetched | null {
  try {
    execFileSync('git', ['fetch', '--quiet', remote, ref], {
      cwd: projectDir,
      encoding: 'utf-8',
      env: networkEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    return null;
  }
  const sha = git(projectDir, ['rev-parse', '--verify', '--quiet', 'FETCH_HEAD'])?.trim();
  if (!sha) return null;
  return { sha, text: git(projectDir, ['show', `FETCH_HEAD:${REF_BLOB_NAME}`]) ?? '' };
}

export interface PushResult {
  ok: boolean;
  /**
   * True only for the losing-a-race kind of failure, where the remote moved
   * and fetching again would help. Anything else — no permission, no network,
   * an unknown remote — is not worth retrying, and reporting it as contention
   * would name a cause we did not observe.
   */
  retryable: boolean;
  message: string;
}

const REJECTED = /\[rejected\]|non-fast-forward|fetch first|stale info/i;

/** Push the ref, reporting whether a retry could plausibly succeed. */
export function pushRef(projectDir: string, remote: string, ref: string): PushResult {
  try {
    execFileSync('git', ['push', '--quiet', remote, `${ref}:${ref}`], {
      cwd: projectDir,
      encoding: 'utf-8',
      env: networkEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { ok: true, retryable: false, message: '' };
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    const message = (e.stderr ?? e.message ?? 'push failed').trim();
    return { ok: false, retryable: REJECTED.test(message), message };
  }
}

/** True when `maybeAncestor` is already contained in `tip`'s history. */
export function isAncestor(projectDir: string, maybeAncestor: string, tip: string | null): boolean {
  if (tip === null) return false;
  return git(projectDir, ['merge-base', '--is-ancestor', maybeAncestor, tip]) !== null;
}

// ─── merging two logs ────────────────────────────────────────────────────────

export interface MergeResult {
  text: string;
  /** Ids present in both sides with different content — a genuine collision. */
  conflicts: string[];
}

/** The id on one NDJSON line, or null when the line is blank or unparsable. */
function lineId(line: string): string | null {
  const raw = line.trim();
  if (raw.length === 0) return null;
  try {
    const parsed = JSON.parse(raw) as { id?: unknown };
    return typeof parsed.id === 'string' ? parsed.id : null;
  } catch {
    return null;
  }
}

/**
 * Union two knowledge logs by record id, keeping `base` byte for byte and
 * appending only the lines `extra` adds.
 *
 * Merging at the line level rather than by re-serialising records means the
 * blob committed to the ref stays stable: a refresh that changes nothing
 * produces the same bytes, so it produces no commit. Records are immutable and
 * append-only, which is what makes a union the whole of the merge — there is
 * no in-place edit to reconcile.
 *
 * An id on both sides with different content is a real collision (ids are five
 * random bytes, so this is vanishingly rare). It is reported rather than
 * resolved: picking a winner would silently destroy one of two records, and
 * nobody can say which one mattered.
 */
export function mergeNdjson(base: string, extra: string): MergeResult {
  const known = new Map<string, string>();
  const out: string[] = [];

  for (const line of base.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    out.push(trimmed);
    const id = lineId(trimmed);
    if (id !== null && !known.has(id)) known.set(id, trimmed);
  }

  const conflicts: string[] = [];
  for (const line of extra.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const id = lineId(trimmed);
    if (id === null) {
      out.push(trimmed); // unparsable: keep it so `records check` can report it
      continue;
    }
    const existing = known.get(id);
    if (existing === undefined) {
      known.set(id, trimmed);
      out.push(trimmed);
    } else if (existing !== trimmed && !conflicts.includes(id)) {
      conflicts.push(id);
    }
  }

  return { text: out.length > 0 ? out.join('\n') + '\n' : '', conflicts };
}

// ─── cache stamp ─────────────────────────────────────────────────────────────

export function stampPath(projectDir: string): string {
  return path.join(projectDir, DB_DIR, STAMP_FILE);
}

export function readStamp(projectDir: string): RefStamp | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(stampPath(projectDir), 'utf-8')) as Partial<RefStamp>;
    if (typeof parsed.ref === 'string' && typeof parsed.sha === 'string') {
      return { ref: parsed.ref, sha: parsed.sha };
    }
  } catch {
    /* absent or unreadable — treat as never refreshed */
  }
  return null;
}

export function writeStamp(projectDir: string, stamp: RefStamp): void {
  const file = stampPath(projectDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(stamp, null, 2) + '\n', 'utf-8');
}

// ─── setup ───────────────────────────────────────────────────────────────────

export type EnsureRefStatus = 'not-configured' | 'not-a-repo' | 'present' | 'created' | 'failed';

/**
 * Create the ref if it is configured and missing, seeding it from whatever the
 * working tree already holds. Idempotent, and reports what it did rather than
 * printing — both `init` and `upgrade` call it and each phrases its own output.
 */
export function ensureRef(
  projectDir: string,
  ref: string | null,
  seedText: string,
): EnsureRefStatus {
  if (ref === null) return 'not-configured';
  if (!isGitRepo(projectDir)) return 'not-a-repo';
  if (refSha(projectDir, ref) !== null) return 'present';

  const sha = commitToRef(projectDir, ref, seedText, 'knowledge: seed ref from working tree');
  if (sha === null) return 'failed';
  writeStamp(projectDir, { ref, sha });
  return 'created';
}

/** True when the cache has not yet merged the ref's current revision. */
export function needsRefresh(projectDir: string, ref: string, sha: string | null): boolean {
  if (sha === null) return false; // no ref yet: nothing to merge in
  const stamp = readStamp(projectDir);
  return stamp === null || stamp.ref !== ref || stamp.sha !== sha;
}
