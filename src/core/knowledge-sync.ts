/**
 * Moving the knowledge log between machines.
 *
 * Sync is one operation, not three: fetch, fold both sides together, commit,
 * push. Splitting it into separate pull and push commands would invite the
 * half-state where a machine has pushed what it had but never took what
 * others wrote.
 *
 * The configuration decides *whether* each half happens, never *when* — the
 * moment is chosen by whichever hook calls this. That is why the modes are
 * plain auto/never rather than session-start/session-end: a setting that named
 * a moment would be describing the hook's job, and the two could disagree.
 */

import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.js';
import { knowledgePath, parseRecords } from './records.js';
import {
  isGitRepo,
  refSha,
  readRefText,
  commitToRef,
  fetchRef,
  pushRef,
  isAncestor,
  mergeNdjson,
  writeStamp,
} from './knowledge-ref.js';

/** Bounded because each attempt costs a network round trip. */
const MAX_ATTEMPTS = 3;

export type SyncStatus =
  | 'ok'
  | 'not-configured'
  | 'not-a-repo'
  /** The remote kept moving under us — retrying later is the answer. */
  | 'push-rejected'
  /** The push could not happen at all: no permission, no network, no remote. */
  | 'push-failed';

export interface SyncResult {
  status: SyncStatus;
  ref: string | null;
  /** Records the remote had that this machine did not. */
  gained: number;
  /** Records this machine contributed that the ref did not hold. */
  contributed: number;
  pushed: boolean;
  /** Ids carrying different content on the two sides — reported, never resolved. */
  conflicts: string[];
  attempts: number;
  /** git's own words, when the push failed for a reason retrying will not fix. */
  error: string;
}

function idsOf(text: string): Set<string> {
  return new Set(parseRecords(text).records.map((r) => r.id));
}

function countNew(before: Set<string>, after: Set<string>): number {
  let n = 0;
  for (const id of after) if (!before.has(id)) n++;
  return n;
}

/**
 * Fold the remote, the local ref and the local cache into one log, commit it,
 * and push. Safe to call at any time and from any hook: with nothing to do it
 * writes no commit, so a quiet repository stays quiet.
 */
export function syncKnowledge(projectDir: string): SyncResult {
  const { ref, remote, pull, push } = loadConfig(projectDir).knowledge;
  const base: SyncResult = {
    status: 'ok', ref, gained: 0, contributed: 0, pushed: false, conflicts: [], attempts: 0, error: '',
  };

  if (ref === null) return { ...base, status: 'not-configured' };
  if (!isGitRepo(projectDir)) return { ...base, status: 'not-a-repo' };

  const file = knowledgePath(projectDir);
  let result = base;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const refText = readRefText(projectDir, ref) ?? '';
    const cacheText = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : '';

    // What this machine knows: the ref it holds, plus anything the cache has
    // that never reached it (a record written just before a failed commit).
    const local = mergeNdjson(refText, cacheText);
    const fetched = pull === 'auto' ? fetchRef(projectDir, remote, ref) : null;

    // Remote first, so its bytes stay put and only genuinely local lines are
    // appended — a machine with nothing new then produces no commit at all.
    const merged = fetched ? mergeNdjson(fetched.text, local.text) : local;
    const conflicts = [...new Set([...local.conflicts, ...merged.conflicts])];

    const localIds = idsOf(local.text);
    const mergedIds = idsOf(merged.text);
    result = {
      status: 'ok',
      ref,
      gained: countNew(localIds, mergedIds),
      contributed: fetched ? countNew(idsOf(fetched.text), localIds) : localIds.size,
      pushed: false,
      conflicts,
      attempts: attempt,
      error: '',
    };

    // A commit is needed when the content moved, or when the remote's history
    // is not yet in ours — the latter is what a push needs to fast-forward.
    const contentChanged = merged.text !== refText;
    const behindRemote =
      fetched !== null && !isAncestor(projectDir, fetched.sha, refSha(projectDir, ref));

    if (contentChanged || behindRemote) {
      const sha = commitToRef(
        projectDir,
        ref,
        merged.text,
        `knowledge: sync${fetched ? ` with ${remote}` : ''}`,
        fetched ? [fetched.sha] : [],
      );
      if (sha === null) return result; // another writer moved the ref; caller can retry
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, merged.text, 'utf-8');
      writeStamp(projectDir, { ref, sha });
    }

    if (push !== 'auto') return result;
    const pushed = pushRef(projectDir, remote, ref);
    if (pushed.ok) return { ...result, pushed: true };
    // Only a lost race is worth another pass — fetching again on the next one
    // makes it converge. Anything else will fail identically three times over,
    // so report what git actually said instead of guessing at contention.
    if (!pushed.retryable) {
      return { ...result, status: 'push-failed', error: pushed.message };
    }
  }

  return { ...result, status: 'push-rejected' };
}
