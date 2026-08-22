export interface AnalyzeConfig {
  /** Directories (relative to project root) to scan for source files */
  include: string[];
  /** Directory names to skip while walking */
  exclude: string[];
  /** Languages to parse, e.g. ['typescript', 'php'] */
  languages: string[];
}

/**
 * When to put a freshly written record in front of the developer.
 *
 * "inferred" is the default because review is cheapest at write time — the
 * developer still has the context in their head, so a wrong claim costs a
 * sentence to correct rather than a re-read of the code. Notifying on every
 * record instead trains people to stop reading the notifications, which leaves
 * the appearance of review without the substance.
 */
export const NOTIFY_MODES = ['all', 'inferred', 'never'] as const;
export type NotifyMode = (typeof NOTIFY_MODES)[number];

/**
 * Whether appending a record also commits the log to its ref. Only meaningful
 * when `ref` is set; the commit is local, so "auto" costs nothing but a few
 * milliseconds and keeps the ref current.
 */
export const COMMIT_MODES = ['auto', 'never'] as const;
export type CommitMode = (typeof COMMIT_MODES)[number];

/**
 * Whether `shanpan sync` fetches before merging and pushes after committing.
 *
 * Deliberately not session-start/session-end: the moment is already decided by
 * whichever hook calls sync, so a setting naming a moment would describe the
 * hook's job and the two could contradict each other. The config answers
 * *whether*, the hook answers *when*.
 *
 * There is no fetch-on-every-read mode either. Reads happen on nearly every
 * MCP call, and a network round trip on each would make the graph feel broken
 * the first time someone works on a train.
 */
export const SYNC_MODES = ['auto', 'never'] as const;
export type SyncMode = (typeof SYNC_MODES)[number];

export interface KnowledgeConfig {
  /**
   * Git ref holding the knowledge log, e.g. "refs/shanpan/knowledge". When
   * null the log lives in the working tree as before.
   *
   * A ref rather than a branch on purpose: refs outside refs/heads are shared
   * across linked worktrees and cannot be checked out, so several worktrees of
   * one repository see one knowledge state and none of them can block another
   * by checking it out.
   */
  ref: string | null;
  commit: CommitMode;
  /** Remote the ref is synced with. */
  remote: string;
  pull: SyncMode;
  push: SyncMode;
  notify: NotifyMode;
}

export interface ShanpanConfig {
  analyze: AnalyzeConfig;
  knowledge: KnowledgeConfig;
}

export const DEFAULT_CONFIG: ShanpanConfig = {
  analyze: {
    include: ['src'],
    exclude: ['node_modules', 'dist', '.git', 'vendor', 'build', 'coverage'],
    languages: ['typescript'],
  },
  knowledge: {
    ref: null,
    commit: 'auto',
    remote: 'origin',
    pull: 'auto',
    push: 'auto',
    notify: 'inferred',
  },
};
