/**
 * Deterministic extraction of knowledge from an existing codebase.
 *
 * specgraph has no model at runtime, so bootstrap only extracts what can be
 * read mechanically and traced to a concrete source. It never infers *why* a
 * decision was made from code alone — that is the one thing no amount of
 * scanning can recover, and a fabricated rationale is worse than a gap.
 *
 * Three honest sources:
 *   - marker comments  → gotcha   (provenance n:<file>:<line>)
 *   - git reverts      → rejected (provenance g:<sha>)
 *   - ADR / decision docs → decision (provenance d:<path>)
 */

/** Longest claim we keep — a runaway comment should not become a wall of text. */
export const MAX_CLAIM = 280;

export interface MarkerCandidate {
  file: string;
  line: number;
  marker: string;
  claim: string;
}

// Markers that signal a trap or a caveat worth carrying forward. TODO is
// excluded on purpose: it is future work, not knowledge about the code. NOTE is
// excluded because it is too often used for benign asides to be high-signal.
const MARKERS = ['HACK', 'FIXME', 'XXX', 'WORKAROUND', 'GOTCHA', 'WARNING', 'CAREFUL', 'DANGER'];

const MARKER_RE = new RegExp(
  // comment opener, then the marker as the first token, then the text
  String.raw`(?:\/\/+|#+|\/\*+|\*+)\s*(` + MARKERS.join('|') + String.raw`)\b[:\-\s]+(.+?)\s*(?:\*\/\s*)?$`,
  'i',
);

function clip(text: string): string {
  const t = text.trim();
  return t.length > MAX_CLAIM ? t.slice(0, MAX_CLAIM - 1).trimEnd() + '…' : t;
}

/**
 * Scan one source file for marker comments. Matches a marker only when it is
 * the first token of a comment, which keeps precision high — prose that merely
 * mentions "a hack" does not match.
 */
export function scanMarkers(relPath: string, source: string): MarkerCandidate[] {
  const out: MarkerCandidate[] = [];
  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = MARKER_RE.exec(lines[i] ?? '');
    if (!m) continue;
    const claim = clip(m[2] ?? '');
    if (claim.length === 0) continue; // a bare "// HACK" carries no knowledge
    out.push({ file: relPath, line: i + 1, marker: (m[1] ?? '').toUpperCase(), claim });
  }
  return out;
}

export interface RevertCandidate {
  sha: string;
  claim: string;
}

/**
 * Parse `git log` output for reverts. Expects records separated by \x1e and
 * fields (hash, subject, body) by \x1f — see buildGitLogArgs.
 *
 * A revert is the one place where an abandoned approach is recorded
 * mechanically: the code is gone, but the history remembers it was tried.
 */
export function parseReverts(gitLog: string): RevertCandidate[] {
  const out: RevertCandidate[] = [];
  for (const rawRecord of gitLog.split('\x1e')) {
    const record = rawRecord.replace(/^\n+/, '');
    if (!record.trim()) continue;
    const [hash = '', subject = ''] = record.split('\x1f');
    const m = /^Revert\s+"(.+)"$/.exec(subject.trim());
    if (!m) continue;
    const sha = hash.trim().slice(0, 9);
    if (!sha) continue;
    out.push({ sha, claim: clip(m[1] ?? '') });
  }
  return out;
}

export function buildGitLogArgs(limit: number): string[] {
  // %H hash, %s subject, %b body — separated so parseReverts can split cleanly.
  return ['log', '--no-merges', `-n${limit}`, '--format=%H%x1f%s%x1f%b%x1e'];
}

export interface DocCandidate {
  file: string;
  claim: string;
  because: string | null;
}

/** Directories conventionally holding architecture decision records. */
export const ADR_DIRS = [
  'docs/adr',
  'docs/adrs',
  'docs/decisions',
  'docs/architecture/decisions',
  'doc/adr',
  'adr',
];

/**
 * Extract a decision from an ADR-style document: the H1 title as the claim, and
 * the paragraph under a "## Decision" heading as the reason when present.
 * Returns null when there is no usable title.
 */
export function scanAdr(source: string): { claim: string; because: string | null } | null {
  const titleMatch = /^#\s+(.+)$/m.exec(source);
  if (!titleMatch) return null;
  // Strip common ADR numbering prefixes: "ADR-12:", "0012.", "12 - ".
  const title = (titleMatch[1] ?? '')
    .replace(/^(?:ADR[-\s]?\d+|0*\d+)[.:)\-\s]+/i, '')
    .trim();
  if (!title) return null;

  let because: string | null = null;
  const decisionMatch = /^##+\s*Decision\s*$/im.exec(source);
  if (decisionMatch) {
    const after = source.slice(decisionMatch.index + decisionMatch[0].length);
    // First non-empty paragraph up to the next heading or blank-line break.
    const para = after.replace(/^\s+/, '').split(/\n\s*\n|\n#{1,6}\s/)[0] ?? '';
    const collapsed = para.replace(/\s+/g, ' ').trim();
    if (collapsed) because = clip(collapsed);
  }

  return { claim: clip(title), because };
}

/** Normalised key for dedup: same kind + same claim text should not be added twice. */
export function dedupKey(kind: string, claim: string): string {
  return `${kind}\x00${claim.toLowerCase().replace(/\s+/g, ' ').trim()}`;
}
