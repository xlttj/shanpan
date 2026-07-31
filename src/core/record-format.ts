export interface ContextRecord {
  id: string;
  kind: string;
  claim: string;
  because: string | null;
  provenance: string;
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
  behavior: 4,
  intent: 5,
  conflict: 6,
};

/** Cap injected records so a well-documented file cannot flood the context. */
export const MAX_INJECTED = 12;

/** Traps and invariants first, background last; ties broken by id for stability. */
export function sortRecords(records: ContextRecord[]): ContextRecord[] {
  return [...records].sort(
    (a, b) =>
      (KIND_PRIORITY[a.kind] ?? 99) - (KIND_PRIORITY[b.kind] ?? 99) ||
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
    return `  • [${r.kind}] ${r.claim}${why}  (${r.id}, ${r.provenance})`;
  });
  if (records.length > shown.length) {
    const rest = records.length - shown.length;
    lines.push(`  … ${rest} more record(s) not shown — query them if relevant.`);
  }
  return lines;
}
