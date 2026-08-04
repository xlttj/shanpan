export interface ContextRecord {
  id: string;
  kind: string;
  claim: string;
  because: string | null;
  provenance: string;
  /** source only: the document to consult. Null for every other kind. */
  ref?: string | null;
  /**
   * How specifically this record is anchored to the edited file — lower is more
   * specific. A symbol/file anchor is 0; a directory anchor is 100 minus its
   * depth, so a deep module dir outranks a shallow one and every directory
   * anchor sorts below the file's own records. Set when a record reaches a file
   * through a directory ancestor; undefined (→ 0) otherwise.
   */
  scope?: number;
  /** The directory this record is anchored at, when it reached the file via one. */
  anchorDir?: string | null;
}

/**
 * Order records so the ones that change what an agent is about to do come
 * first: traps and invariants, then things already tried, then background.
 */
const KIND_PRIORITY: Record<string, number> = {
  gotcha: 0,
  constraint: 1,
  rejected: 2,
  decision: 3,
  source: 4,
  behavior: 5,
  intent: 6,
  conflict: 7,
};

/** Cap injected records so a well-documented file cannot flood the context. */
export const MAX_INJECTED = 12;

/**
 * Traps and invariants first; within a kind, the more specific anchor wins so a
 * broad module rule never buries the file-specific one; id breaks final ties.
 */
export function sortRecords(records: ContextRecord[]): ContextRecord[] {
  return [...records].sort(
    (a, b) =>
      (KIND_PRIORITY[a.kind] ?? 99) - (KIND_PRIORITY[b.kind] ?? 99) ||
      (a.scope ?? 0) - (b.scope ?? 0) ||
      a.id.localeCompare(b.id),
  );
}

/**
 * Render one line per record. The hook path caps the count because it pays the
 * cost on every edit; a generated rule file passes Infinity, since it is only
 * attached when the file it describes is already in context.
 */
export function formatRecords(records: ContextRecord[], limit = MAX_INJECTED): string[] {
  const shown = records.slice(0, limit);
  const lines = shown.map((r) => {
    const why = r.because ? ` — ${r.because}` : '';
    // Mark a module-wide record so the agent knows it applies to the directory,
    // not just this file — and can judge its breadth accordingly.
    const scopeTag = r.anchorDir ? ` [module: ${r.anchorDir}]` : '';
    // A source record's whole point is the pointer, so lead with it: the agent
    // should go read the document, not treat the topic as a claim to obey.
    if (r.kind === 'source' && r.ref) {
      return `  • [source] ${r.claim} → consult ${r.ref}${why}${scopeTag}  (${r.id}, ${r.provenance})`;
    }
    return `  • [${r.kind}] ${r.claim}${why}${scopeTag}  (${r.id}, ${r.provenance})`;
  });
  if (records.length > shown.length) {
    const rest = records.length - shown.length;
    lines.push(`  … ${rest} more record(s) not shown — query them if relevant.`);
  }
  return lines;
}
