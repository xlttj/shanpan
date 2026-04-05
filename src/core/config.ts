import fs from 'node:fs';
import path from 'node:path';
import { type SpecGraphConfig, DEFAULT_CONFIG } from '../types/config.js';
import { DB_DIR } from './db.js';

const CONFIG_FILE = 'config.json';

export function loadConfig(projectDir: string): SpecGraphConfig {
  const configPath = path.join(projectDir, DB_DIR, CONFIG_FILE);
  if (!fs.existsSync(configPath)) {
    return structuredClone(DEFAULT_CONFIG);
  }
  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<SpecGraphConfig>;
    return {
      specsDir: parsed.specsDir ?? DEFAULT_CONFIG.specsDir,
      analyze: {
        include: parsed.analyze?.include ?? DEFAULT_CONFIG.analyze.include,
        exclude: parsed.analyze?.exclude ?? DEFAULT_CONFIG.analyze.exclude,
        languages: parsed.analyze?.languages ?? DEFAULT_CONFIG.analyze.languages,
      },
    };
  } catch {
    return structuredClone(DEFAULT_CONFIG);
  }
}

export function saveConfig(projectDir: string, config: SpecGraphConfig): void {
  const dirPath = path.join(projectDir, DB_DIR);
  fs.mkdirSync(dirPath, { recursive: true }); // ensure dir exists even before DB init
  const configPath = path.join(dirPath, CONFIG_FILE);
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
}
