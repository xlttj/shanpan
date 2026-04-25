import fs from 'node:fs';
import path from 'node:path';

const MARKER_START = '# specgraph post-commit hook';
const MARKER_END = '# end specgraph post-commit hook';
const HOOK_BLOCK = `\n${MARKER_START}\nspecgraph analyze --include src || true\n${MARKER_END}\n`;

export function installPostCommitHook(projectDir: string): 'created' | 'exists' | 'appended' {
  const hooksDir = path.join(projectDir, '.git', 'hooks');
  if (!fs.existsSync(hooksDir)) {
    throw new Error(`Not a git repository: no .git/hooks directory found in ${projectDir}`);
  }

  const hookPath = path.join(hooksDir, 'post-commit');

  if (!fs.existsSync(hookPath)) {
    fs.writeFileSync(hookPath, `#!/bin/sh${HOOK_BLOCK}`, { mode: 0o755 });
    return 'created';
  }

  const existing = fs.readFileSync(hookPath, 'utf-8');
  if (existing.includes(MARKER_START)) {
    return 'exists';
  }

  fs.writeFileSync(hookPath, existing + HOOK_BLOCK);
  return 'appended';
}

export function uninstallPostCommitHook(projectDir: string): 'removed' | 'absent' | 'not_found' {
  const hookPath = path.join(projectDir, '.git', 'hooks', 'post-commit');

  if (!fs.existsSync(hookPath)) {
    return 'not_found';
  }

  const content = fs.readFileSync(hookPath, 'utf-8');
  if (!content.includes(MARKER_START)) {
    return 'absent';
  }

  const startIdx = content.indexOf('\n' + MARKER_START);
  const endIdx = content.indexOf(MARKER_END);
  if (startIdx === -1 || endIdx === -1) {
    return 'absent';
  }

  const cleaned = content.slice(0, startIdx) + content.slice(endIdx + MARKER_END.length);
  fs.writeFileSync(hookPath, cleaned.trimEnd() + '\n');
  return 'removed';
}
