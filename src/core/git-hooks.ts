import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * Git hooks that keep the graph honest without the user remembering to run
 * anything. A branch checkout swaps the tree out from under the graph, so the
 * next drift check reports the old tree's symbols as missing — exactly the
 * false positive that trips up a Stop hook. Rebuilding on checkout/merge fixes
 * that; a pre-commit gate blocks a commit that breaks a record's subject.
 *
 * These live in .git/hooks, which is per-clone and never committed, so they are
 * installed by `shanpan init` rather than shipped in the repo.
 */

// A marked block, so re-running init updates our section in place and a user's
// own hook body is never touched.
export const HOOK_BEGIN = '# >>> shanpan managed >>>';
export const HOOK_END = '# <<< shanpan managed <<<';

/** Hook name → the shell body of our managed block (without the markers). */
export const GIT_HOOKS: Record<string, string> = {
  // $3 == 1 marks a branch checkout; 0 is a file checkout, which must not rebuild.
  'post-checkout': [
    '[ "$3" = "1" ] || exit 0',
    'command -v shanpan >/dev/null 2>&1 || exit 0',
    'root=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0',
    'cd "$root" || exit 0',
    '[ -f .shanpan/graph.db ] || exit 0',
    'shanpan analyze >/dev/null 2>&1 || true',
  ].join('\n'),

  'post-merge': [
    'command -v shanpan >/dev/null 2>&1 || exit 0',
    'root=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0',
    'cd "$root" || exit 0',
    '[ -f .shanpan/graph.db ] || exit 0',
    'shanpan analyze >/dev/null 2>&1 || true',
  ].join('\n'),

  // The one hook that is allowed to fail the git operation: a hard integrity
  // violation (record points at code being deleted/renamed) should block.
  'pre-commit': [
    'command -v shanpan >/dev/null 2>&1 || exit 0',
    'root=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0',
    'cd "$root" || exit 0',
    '[ -f .shanpan/graph.db ] || exit 0',
    'shanpan check --staged',
  ].join('\n'),
};

/**
 * Merge our block into an existing hook file's contents (or create fresh).
 * Pure so the block logic is testable without a real git repo.
 */
export function renderHookFile(existing: string | null, body: string): string {
  const block = `${HOOK_BEGIN}\n${body}\n${HOOK_END}`;

  if (existing === null || existing.trim() === '') {
    return `#!/bin/sh\n${block}\n`;
  }

  // Replace an earlier managed block in place — keeps re-runs idempotent.
  const begin = existing.indexOf(HOOK_BEGIN);
  const end = existing.indexOf(HOOK_END);
  if (begin !== -1 && end !== -1 && end > begin) {
    const before = existing.slice(0, begin);
    const after = existing.slice(end + HOOK_END.length);
    return `${before}${block}${after}`;
  }

  // A user's own hook with no managed block — append ours, never clobber.
  const sep = existing.endsWith('\n') ? '\n' : '\n\n';
  return `${existing}${sep}${block}\n`;
}

/** Resolve the hooks directory, honouring worktrees and custom core.hooksPath. */
function resolveHooksDir(projectDir: string): string | null {
  try {
    const out = execFileSync('git', ['rev-parse', '--git-path', 'hooks'], {
      cwd: projectDir,
      encoding: 'utf-8',
    }).trim();
    return path.isAbsolute(out) ? out : path.join(projectDir, out);
  } catch {
    const fallback = path.join(projectDir, '.git', 'hooks');
    return fs.existsSync(path.dirname(fallback)) ? fallback : null;
  }
}

/**
 * Install (or update) the shanpan git hooks. Returns the hook names written,
 * or null when the directory is not a git repository.
 */
export function installGitHooks(projectDir: string): string[] | null {
  const hooksDir = resolveHooksDir(projectDir);
  if (hooksDir === null) return null;
  fs.mkdirSync(hooksDir, { recursive: true });

  const written: string[] = [];
  for (const [name, body] of Object.entries(GIT_HOOKS)) {
    const filePath = path.join(hooksDir, name);
    const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : null;
    fs.writeFileSync(filePath, renderHookFile(existing, body), 'utf-8');
    try {
      fs.chmodSync(filePath, 0o755);
    } catch {
      // Some filesystems reject chmod; the hook still works where mode is honoured.
    }
    written.push(name);
  }
  return written;
}
