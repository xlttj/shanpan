/**
 * Directory-anchored records. A record whose subject is a directory applies to
 * that directory and everything beneath it, transitively — a module-wide rule
 * covers the whole module subtree. Matching is on path-segment boundaries, not
 * raw string prefix, so `foo/bar` never matches `foo/barbaz`.
 */

/** Strip a leading slash so an absolute-looking subject is treated repo-relative. */
export function normalizeSubjectPath(p: string): string {
  return p.replace(/^\/+/, '').replace(/\/+$/, '');
}

/**
 * The ancestor directories of a repo-relative file path, most specific first.
 * `apps/bmf/src/Consumers/Foo.php` →
 *   ['apps/bmf/src/Consumers', 'apps/bmf/src', 'apps/bmf', 'apps']
 *
 * These are the directories whose anchored records apply to that file.
 */
export function ancestorDirs(relPath: string): string[] {
  const clean = normalizeSubjectPath(relPath);
  if (!clean) return [];
  const parts = clean.split('/');
  const out: string[] = [];
  // Drop the last segment (the file itself), then each shallower prefix.
  for (let i = parts.length - 1; i >= 1; i--) {
    out.push(parts.slice(0, i).join('/'));
  }
  return out;
}

/** Depth of a directory path in segments — deeper is more specific. */
export function dirDepth(dir: string): number {
  const clean = normalizeSubjectPath(dir);
  return clean ? clean.split('/').length : 0;
}
