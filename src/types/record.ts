/**
 * Knowledge records — the agent-native replacement for markdown specs.
 *
 * Wire format is NDJSON: one record per line, short keys to keep the
 * per-record cost low when records are injected into an agent's context.
 * Records are immutable; corrections are new records carrying `ss`
 * (supersedes). That immutability is what makes `merge=union` safe.
 */

/** Record kinds. Mechanical to choose — no judgement call required. */
export const RECORD_KINDS = [
  'behavior',   // given/when/then contract
  'constraint', // invariant that must hold
  'decision',   // chose X over Y, because Z
  'rejected',   // tried X, abandoned because Y
  'gotcha',     // non-obvious trap
  'intent',     // why this exists at all
  'conflict',   // sources disagree — needs human adjudication
] as const;

export type RecordKind = (typeof RECORD_KINDS)[number];

/**
 * A single knowledge record as stored on disk.
 *
 * Key abbreviations (the skill must carry this table verbatim, otherwise
 * agents guess):
 *   id → id          kn → kind        sb → subject     cl → claim
 *   bc → because     pv → provenance  ts → timestamp   ss → supersedes
 *   gv → given       wn → when        tn → then
 */
export interface KnowledgeRecord {
  /** Stable short id, unique within the knowledge base. */
  id: string;
  /** Record kind. */
  kn: RecordKind;
  /** Subjects: CodeSymbol ids or bare file paths this record is about. */
  sb?: string[];
  /** The claim itself. For `behavior`, this is the scenario name. */
  cl: string;
  /** Why the claim holds. Absent is legal; fabricated is not. */
  bc?: string;
  /** Provenance token — see PROVENANCE_PREFIXES. */
  pv: string;
  /** UTC timestamp, YYYYMMDDHHIISS. */
  ts: string;
  /** Id of the record this one replaces. */
  ss?: string;
  /** behavior only: precondition. */
  gv?: string;
  /** behavior only: the single triggering event. */
  wn?: string;
  /** behavior only: the expected outcome. */
  tn?: string;
}

/**
 * Provenance tokens. A bare letter needs no pointer; a prefixed form
 * carries the source location after the colon.
 *
 *   u              stated by the user
 *   a              observed by an agent while working
 *   i              inferred by a model, no hard source — treat as weakest
 *   g:<sha>        git commit
 *   t:<path>       test file
 *   n:<path>:<ln>  code comment
 *   d:<path>       doc / ADR / migrated spec
 */
export const PROVENANCE_PREFIXES = ['g', 't', 'n', 'd'] as const;
export const PROVENANCE_BARE = ['u', 'a', 'i'] as const;

export interface RecordValidationError {
  line: number;
  id: string | null;
  message: string;
}
