import fs from 'node:fs';
import path from 'node:path';

export interface AnalyzeState {
  /** relPath → mtime in ms since epoch */
  fileMtimes: Record<string, number>;
}

const STATE_FILE = 'analyze-state.json';

export function loadAnalyzeState(projectDir: string): AnalyzeState {
  const p = path.join(projectDir, '.shanpan', STATE_FILE);
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8')) as AnalyzeState;
  } catch {
    return { fileMtimes: {} };
  }
}

export function saveAnalyzeState(projectDir: string, state: AnalyzeState): void {
  const p = path.join(projectDir, '.shanpan', STATE_FILE);
  fs.writeFileSync(p, JSON.stringify(state), 'utf-8');
}
