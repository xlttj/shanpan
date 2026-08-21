import fs from 'node:fs';
import path from 'node:path';
import {
  type ShanpanConfig,
  type NotifyMode,
  type CommitMode,
  DEFAULT_CONFIG,
  NOTIFY_MODES,
  COMMIT_MODES,
} from '../types/config.js';
import { DB_DIR } from './db.js';

export const RC_FILE = '.shanpanrc.json';
const LEGACY_CONFIG_FILE = 'config.json';

/**
 * Fall back to the default when a value is not one this build understands —
 * a typo or a key from a newer version must not put the tool in an
 * undefined state.
 */
function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

function parseConfig(raw: string): ShanpanConfig {
  const parsed = JSON.parse(raw) as Partial<ShanpanConfig>;
  return {
    analyze: {
      include: parsed.analyze?.include ?? DEFAULT_CONFIG.analyze.include,
      exclude: parsed.analyze?.exclude ?? DEFAULT_CONFIG.analyze.exclude,
      languages: parsed.analyze?.languages ?? DEFAULT_CONFIG.analyze.languages,
    },
    knowledge: {
      // A non-empty string or nothing — an empty ref name would send every git
      // call somewhere undefined, so it reads as "not configured".
      ref:
        typeof parsed.knowledge?.ref === 'string' && parsed.knowledge.ref.trim().length > 0
          ? parsed.knowledge.ref.trim()
          : DEFAULT_CONFIG.knowledge.ref,
      commit: oneOf<CommitMode>(
        parsed.knowledge?.commit,
        COMMIT_MODES,
        DEFAULT_CONFIG.knowledge.commit,
      ),
      notify: oneOf<NotifyMode>(
        parsed.knowledge?.notify,
        NOTIFY_MODES,
        DEFAULT_CONFIG.knowledge.notify,
      ),
    },
  };
}

export function loadConfig(projectDir: string): ShanpanConfig {
  const rcPath = path.join(projectDir, RC_FILE);
  if (fs.existsSync(rcPath)) {
    try { return parseConfig(fs.readFileSync(rcPath, 'utf-8')); } catch { /* fall through */ }
  }
  // Backward-compatibility: read from legacy .shanpan/config.json
  const legacyPath = path.join(projectDir, DB_DIR, LEGACY_CONFIG_FILE);
  if (fs.existsSync(legacyPath)) {
    try { return parseConfig(fs.readFileSync(legacyPath, 'utf-8')); } catch { /* fall through */ }
  }
  return structuredClone(DEFAULT_CONFIG);
}

export function saveConfig(projectDir: string, config: ShanpanConfig): void {
  fs.writeFileSync(path.join(projectDir, RC_FILE), JSON.stringify(config, null, 2), 'utf-8');
}
