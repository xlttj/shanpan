import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { walkFiles } from '../src/analyzer/walker.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shanpan-walker-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function mkfile(rel: string, content = ''): string {
  const full = path.join(tmpDir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
}

describe('walkFiles', () => {
  it('returns empty array when directory does not exist', () => {
    const result = walkFiles([path.join(tmpDir, 'nonexistent')], ['.ts']);
    expect(result).toEqual([]);
  });

  it('finds files with matching extensions', () => {
    mkfile('a.ts');
    mkfile('b.tsx');
    mkfile('c.js');
    mkfile('d.ts');

    const result = walkFiles([tmpDir], ['.ts', '.tsx']);
    expect(result).toHaveLength(3);
    expect(result.some((f) => f.endsWith('a.ts'))).toBe(true);
    expect(result.some((f) => f.endsWith('b.tsx'))).toBe(true);
    expect(result.some((f) => f.endsWith('d.ts'))).toBe(true);
  });

  it('recurses into subdirectories', () => {
    mkfile('src/foo/a.ts');
    mkfile('src/bar/b.ts');
    mkfile('src/index.ts');

    const result = walkFiles([tmpDir], ['.ts']);
    expect(result).toHaveLength(3);
  });

  it('skips excluded directories', () => {
    mkfile('src/a.ts');
    mkfile('node_modules/lib/b.ts');
    mkfile('dist/c.ts');

    const result = walkFiles([tmpDir], ['.ts'], ['node_modules', 'dist']);
    expect(result).toHaveLength(1);
    expect(result[0]).toContain('src');
  });

  it('accepts multiple root directories', () => {
    const dir1 = path.join(tmpDir, 'src');
    const dir2 = path.join(tmpDir, 'lib');
    fs.mkdirSync(dir1);
    fs.mkdirSync(dir2);
    fs.writeFileSync(path.join(dir1, 'a.ts'), '');
    fs.writeFileSync(path.join(dir2, 'b.ts'), '');

    const result = walkFiles([dir1, dir2], ['.ts']);
    expect(result).toHaveLength(2);
  });

  it('returns empty array when no extensions match', () => {
    mkfile('a.ts');
    mkfile('b.php');

    const result = walkFiles([tmpDir], ['.java']);
    expect(result).toEqual([]);
  });
});
