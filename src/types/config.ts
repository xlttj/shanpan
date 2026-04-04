export interface AnalyzeConfig {
  /** Directories (relative to project root) to scan for source files */
  include: string[];
  /** Directory names to skip while walking */
  exclude: string[];
  /** Languages to parse, e.g. ['typescript', 'php'] */
  languages: string[];
}

export interface SpecGraphConfig {
  specsDir: string;
  analyze: AnalyzeConfig;
}

export const DEFAULT_CONFIG: SpecGraphConfig = {
  specsDir: 'specs',
  analyze: {
    include: ['src'],
    exclude: ['node_modules', 'dist', '.git', 'vendor', 'build', 'coverage'],
    languages: ['typescript'],
  },
};
