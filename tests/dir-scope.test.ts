import { describe, it, expect } from 'vitest';
import { ancestorDirs, dirDepth, normalizeSubjectPath } from '../src/core/dir-scope.js';

describe('ancestorDirs', () => {
  it('lists every ancestor directory, most specific first', () => {
    expect(ancestorDirs('apps/bmf/src/Consumers/Foo.php')).toEqual([
      'apps/bmf/src/Consumers',
      'apps/bmf/src',
      'apps/bmf',
      'apps',
    ]);
  });

  it('handles a top-level file', () => {
    expect(ancestorDirs('README.md')).toEqual([]);
  });

  it('handles a file one level deep', () => {
    expect(ancestorDirs('src/index.ts')).toEqual(['src']);
  });

  it('normalizes a leading slash to repo-relative', () => {
    expect(ancestorDirs('/foo/bar/baz.php')).toEqual(['foo/bar', 'foo']);
  });

  it('does not treat a sibling with a shared prefix as an ancestor', () => {
    // The whole point of segment-boundary matching: a file under foo/barbaz
    // must not resolve foo/bar as an ancestor.
    expect(ancestorDirs('foo/barbaz/x.php')).toEqual(['foo/barbaz', 'foo']);
    expect(ancestorDirs('foo/barbaz/x.php')).not.toContain('foo/bar');
  });
});

describe('dirDepth', () => {
  it('counts segments', () => {
    expect(dirDepth('apps/bmf/src')).toBe(3);
    expect(dirDepth('apps')).toBe(1);
    expect(dirDepth('/apps/bmf/')).toBe(2);
  });
});

describe('normalizeSubjectPath', () => {
  it('strips leading and trailing slashes', () => {
    expect(normalizeSubjectPath('/foo/bar/')).toBe('foo/bar');
    expect(normalizeSubjectPath('foo/bar')).toBe('foo/bar');
  });
});
