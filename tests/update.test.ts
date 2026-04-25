import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createSpec, updateSpec } from '../src/core/spec-writer.js';
import { parseSpecFile } from '../src/core/parser.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'specgraph-update-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function seed(title = 'test-spec', extraOpts: object = {}) {
  return createSpec({ title, type: 'intent', specsDir: tmpDir, ...extraOpts });
}

describe('updateSpec', () => {
  it('updates status without touching the markdown body', () => {
    const { filePath } = seed();
    const bodyBefore = parseSpecFile(filePath).content;

    updateSpec({ id: 'test-spec', specsDir: tmpDir, status: 'active' });

    const parsed = parseSpecFile(filePath);
    expect(parsed.frontmatter.status).toBe('active');
    expect(parsed.content).toBe(bodyBefore);
  });

  it('adds a symbol to an empty implements list', () => {
    seed();
    updateSpec({
      id: 'test-spec',
      specsDir: tmpDir,
      addSymbols: [{ symbol: 'src/foo.ts::Foo', type: 'class' }],
    });
    const parsed = parseSpecFile(path.join(tmpDir, 'test-spec.md'));
    expect(parsed.frontmatter.implements).toHaveLength(1);
    expect(parsed.frontmatter.implements?.[0]?.symbol).toBe('src/foo.ts::Foo');
    expect(parsed.frontmatter.implements?.[0]?.type).toBe('class');
  });

  it('appends to an existing implements list', () => {
    seed('spec-two', { symbols: ['src/a.ts::A'] });
    updateSpec({
      id: 'spec-two',
      specsDir: tmpDir,
      addSymbols: [{ symbol: 'src/b.ts::B', type: 'function' }],
    });
    const parsed = parseSpecFile(path.join(tmpDir, 'spec-two.md'));
    expect(parsed.frontmatter.implements).toHaveLength(2);
  });

  it('does not duplicate a symbol already in implements', () => {
    seed('spec-three', { symbols: ['src/a.ts::A'] });
    updateSpec({
      id: 'spec-three',
      specsDir: tmpDir,
      addSymbols: [{ symbol: 'src/a.ts::A', type: 'class' }],
    });
    const parsed = parseSpecFile(path.join(tmpDir, 'spec-three.md'));
    expect(parsed.frontmatter.implements).toHaveLength(1);
  });

  it('removes a symbol from implements', () => {
    seed('spec-four', { symbols: ['src/a.ts::A', 'src/b.ts::B'] });
    updateSpec({ id: 'spec-four', specsDir: tmpDir, removeSymbols: ['src/a.ts::A'] });
    const parsed = parseSpecFile(path.join(tmpDir, 'spec-four.md'));
    expect(parsed.frontmatter.implements).toHaveLength(1);
    expect(parsed.frontmatter.implements?.[0]?.symbol).toBe('src/b.ts::B');
  });

  it('removing the last symbol clears the implements field', () => {
    seed('spec-five', { symbols: ['src/a.ts::A'] });
    updateSpec({ id: 'spec-five', specsDir: tmpDir, removeSymbols: ['src/a.ts::A'] });
    const parsed = parseSpecFile(path.join(tmpDir, 'spec-five.md'));
    expect(parsed.frontmatter.implements).toBeUndefined();
  });

  it('removing a non-existent symbol is a no-op', () => {
    seed('spec-six', { symbols: ['src/a.ts::A'] });
    expect(() =>
      updateSpec({ id: 'spec-six', specsDir: tmpDir, removeSymbols: ['src/x.ts::X'] }),
    ).not.toThrow();
    const parsed = parseSpecFile(path.join(tmpDir, 'spec-six.md'));
    expect(parsed.frontmatter.implements).toHaveLength(1);
  });

  it('preserves the markdown body verbatim', () => {
    seed();
    const rawBefore = fs.readFileSync(path.join(tmpDir, 'test-spec.md'), 'utf-8');
    const bodyBefore = rawBefore.split('---').slice(2).join('---');

    updateSpec({
      id: 'test-spec',
      specsDir: tmpDir,
      addSymbols: [{ symbol: 'src/foo.ts::Foo', type: 'class' }],
      status: 'active',
    });

    const rawAfter = fs.readFileSync(path.join(tmpDir, 'test-spec.md'), 'utf-8');
    const bodyAfter = rawAfter.split('---').slice(2).join('---');
    expect(bodyAfter).toBe(bodyBefore);
  });

  it('throws if spec path key is not found', () => {
    expect(() =>
      updateSpec({ id: 'nonexistent-spec', specsDir: tmpDir, status: 'active' }),
    ).toThrow('not found');
  });

  it('adds a URL to refs', () => {
    seed('ref-add');
    updateSpec({ id: 'ref-add', specsDir: tmpDir, addRefs: ['https://example.com/rfc1'] });
    const parsed = parseSpecFile(path.join(tmpDir, 'ref-add.md'));
    expect(parsed.frontmatter.refs).toEqual(['https://example.com/rfc1']);
  });

  it('appends to an existing refs list without duplicates', () => {
    seed('ref-dedup', { refs: ['https://example.com/a'] });
    updateSpec({
      id: 'ref-dedup',
      specsDir: tmpDir,
      addRefs: ['https://example.com/a', 'https://example.com/b'],
    });
    const parsed = parseSpecFile(path.join(tmpDir, 'ref-dedup.md'));
    expect(parsed.frontmatter.refs).toEqual(['https://example.com/a', 'https://example.com/b']);
  });

  it('removes a URL from refs', () => {
    seed('ref-remove', { refs: ['https://example.com/a', 'https://example.com/b'] });
    updateSpec({ id: 'ref-remove', specsDir: tmpDir, removeRefs: ['https://example.com/a'] });
    const parsed = parseSpecFile(path.join(tmpDir, 'ref-remove.md'));
    expect(parsed.frontmatter.refs).toEqual(['https://example.com/b']);
  });

  it('removing the last ref clears the refs field', () => {
    seed('ref-clear', { refs: ['https://example.com/a'] });
    updateSpec({ id: 'ref-clear', specsDir: tmpDir, removeRefs: ['https://example.com/a'] });
    const parsed = parseSpecFile(path.join(tmpDir, 'ref-clear.md'));
    expect(parsed.frontmatter.refs).toBeUndefined();
  });

  it('throws when addRefs contains a non-http URL', () => {
    seed('ref-invalid');
    expect(() =>
      updateSpec({ id: 'ref-invalid', specsDir: tmpDir, addRefs: ['file:///etc/passwd'] }),
    ).toThrow('Invalid ref');
  });

  it('resolves spec in a subdirectory by path key', () => {
    fs.mkdirSync(path.join(tmpDir, 'core'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'core', 'my-spec.md'),
      '---\ntitle: My Spec\ntype: intent\nstatus: draft\ncreated: 2026-01-01\n---\n# My Spec\n\n',
    );
    updateSpec({ id: 'core/my-spec', specsDir: tmpDir, status: 'active' });
    const parsed = parseSpecFile(path.join(tmpDir, 'core', 'my-spec.md'));
    expect(parsed.frontmatter.status).toBe('active');
  });
});
