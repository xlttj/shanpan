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

export interface KnowledgeConfig {
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
    notify: 'inferred',
  },
};
