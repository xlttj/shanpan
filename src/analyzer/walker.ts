import fs from 'node:fs';
import path from 'node:path';

/**
 * Recursively walk `dirs`, collecting files whose extension is in `extensions`.
 * Subdirectories whose basename appears in `excludeDirs` are skipped.
 */
export function walkFiles(
  dirs: string[],
  extensions: string[],
  excludeDirs: string[] = ['node_modules', 'dist', '.git', 'vendor', 'build', 'coverage'],
): string[] {
  const extSet = new Set(extensions.map((e) => e.toLowerCase()));
  const excludeSet = new Set(excludeDirs);
  const results: string[] = [];

  function walk(dir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!excludeSet.has(entry.name)) {
          walk(fullPath);
        }
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (extSet.has(ext)) {
          results.push(fullPath);
        }
      }
    }
  }

  for (const dir of dirs) {
    if (fs.existsSync(dir)) {
      walk(dir);
    }
  }

  return results;
}
