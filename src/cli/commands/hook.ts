import fs from 'node:fs';
import path from 'node:path';
import chalk from 'chalk';

const MARKER = '# specgraph post-commit hook — do not remove this line';
const HOOK_BLOCK = `${MARKER}\n(specgraph analyze > /dev/null 2>&1 &)\n`;

function hookPath(projectDir: string): string {
  return path.join(projectDir, '.git', 'hooks', 'post-commit');
}

function hooksDir(projectDir: string): string {
  return path.join(projectDir, '.git', 'hooks');
}

export function installPostCommitHook(projectDir: string): 'created' | 'appended' | 'exists' {
  if (!fs.existsSync(path.join(projectDir, '.git'))) {
    throw new Error('Not a git repository — run this inside a project with `.git/`.');
  }
  fs.mkdirSync(hooksDir(projectDir), { recursive: true });
  const file = hookPath(projectDir);
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, `#!/bin/sh\n${HOOK_BLOCK}`, { mode: 0o755 });
    return 'created';
  }
  const existing = fs.readFileSync(file, 'utf-8');
  if (existing.includes(MARKER)) return 'exists';
  const needsNewline = existing.length > 0 && !existing.endsWith('\n');
  fs.writeFileSync(file, existing + (needsNewline ? '\n' : '') + HOOK_BLOCK);
  fs.chmodSync(file, 0o755);
  return 'appended';
}

export function uninstallPostCommitHook(projectDir: string): 'removed' | 'absent' | 'not_found' {
  const file = hookPath(projectDir);
  if (!fs.existsSync(file)) return 'not_found';
  const existing = fs.readFileSync(file, 'utf-8');
  if (!existing.includes(MARKER)) return 'absent';
  const lines = existing.split('\n');
  const markerIdx = lines.findIndex((l) => l.includes(MARKER));
  // Remove marker + the two following lines of our block: the command and a trailing blank.
  // Our block is exactly "MARKER\n(specgraph analyze …)\n" — two non-empty lines.
  const beforeBlock = lines.slice(0, markerIdx);
  const afterBlock = lines.slice(markerIdx + 2);
  const rebuilt = [...beforeBlock, ...afterBlock].join('\n').replace(/\n{3,}/g, '\n\n');
  fs.writeFileSync(file, rebuilt);
  return 'removed';
}

export function runInstallHooks(): void {
  const result = installPostCommitHook(process.cwd());
  if (result === 'created') {
    console.log(chalk.green('✓ Created .git/hooks/post-commit with specgraph hook'));
  } else if (result === 'appended') {
    console.log(chalk.green('✓ Appended specgraph block to existing .git/hooks/post-commit'));
  } else {
    console.log(chalk.gray('Hook already installed — no changes'));
  }
}

export function runUninstallHooks(): void {
  const result = uninstallPostCommitHook(process.cwd());
  if (result === 'removed') {
    console.log(chalk.green('✓ Removed specgraph block from .git/hooks/post-commit'));
  } else if (result === 'absent') {
    console.log(chalk.gray('Post-commit hook exists but contains no specgraph block — no changes'));
  } else {
    console.log(chalk.gray('No post-commit hook found'));
  }
}
