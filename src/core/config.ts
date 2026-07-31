import fs from 'node:fs';
import path from 'node:path';
import { type SpecGraphConfig, DEFAULT_CONFIG } from '../types/config.js';
import { DB_DIR } from './db.js';

export const RC_FILE = '.specgraphrc.json';
const LEGACY_CONFIG_FILE = 'config.json';

function parseConfig(raw: string): SpecGraphConfig {
  const parsed = JSON.parse(raw) as Partial<SpecGraphConfig>;
  return {
    analyze: {
      include: parsed.analyze?.include ?? DEFAULT_CONFIG.analyze.include,
      exclude: parsed.analyze?.exclude ?? DEFAULT_CONFIG.analyze.exclude,
      languages: parsed.analyze?.languages ?? DEFAULT_CONFIG.analyze.languages,
    },
  };
}

export function loadConfig(projectDir: string): SpecGraphConfig {
  const rcPath = path.join(projectDir, RC_FILE);
  if (fs.existsSync(rcPath)) {
    try { return parseConfig(fs.readFileSync(rcPath, 'utf-8')); } catch { /* fall through */ }
  }
  // Backward-compatibility: read from legacy .specgraph/config.json
  const legacyPath = path.join(projectDir, DB_DIR, LEGACY_CONFIG_FILE);
  if (fs.existsSync(legacyPath)) {
    try { return parseConfig(fs.readFileSync(legacyPath, 'utf-8')); } catch { /* fall through */ }
  }
  return structuredClone(DEFAULT_CONFIG);
}

export function saveConfig(projectDir: string, config: SpecGraphConfig): void {
  fs.writeFileSync(path.join(projectDir, RC_FILE), JSON.stringify(config, null, 2), 'utf-8');
}
