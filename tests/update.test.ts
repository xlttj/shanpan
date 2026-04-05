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

function seed(id = 'SPEC-001', extraOpts: object = {}) {
  return createSpec({ id, title: 'Test Spec', type: 'intent', specsDir: tmpDir, ...extraOpts });
}

describe('updateSpec', () => {
  it('updates status without touching the markdown body', () => {
    const { filePath } = seed();
    const bodyBefore = parseSpecFile(filePath).content;

    updateSpec({ id: 'SPEC-001', specsDir: tmpDir, status: 'active' });

    const parsed = parseSpecFile(filePath);
    expect(parsed.frontmatter.status).toBe('active');
    expect(parsed.content).toBe(bodyBefore);
  });

  it('adds a symbol to an empty implements list', () => {
    seed();
    updateSpec({
      id: 'SPEC-001',
      specsDir: tmpDir,
      addSymbols: [{ symbol: 'src/foo.ts::Foo', type: 'class' }],
    });
    const parsed = parseSpecFile(path.join(tmpDir, 'spec-001.md'));
    expect(parsed.frontmatter.implements).toHaveLength(1);
    expect(parsed.frontmatter.implements?.[0]?.symbol).toBe('src/foo.ts::Foo');
    expect(parsed.frontmatter.implements?.[0]?.type).toBe('class');
  });

  it('appends to an existing implements list', () => {
    seed('SPEC-002', { symbols: ['src/a.ts::A'] });
    updateSpec({
      id: 'SPEC-002',
      specsDir: tmpDir,
      addSymbols: [{ symbol: 'src/b.ts::B', type: 'function' }],
    });
    const parsed = parseSpecFile(path.join(tmpDir, 'spec-002.md'));
    expect(parsed.frontmatter.implements).toHaveLength(2);
  });

  it('does not duplicate a symbol already in implements', () => {
    seed('SPEC-003', { symbols: ['src/a.ts::A'] });
    updateSpec({
      id: 'SPEC-003',
      specsDir: tmpDir,
      addSymbols: [{ symbol: 'src/a.ts::A', type: 'class' }],
    });
    const parsed = parseSpecFile(path.join(tmpDir, 'spec-003.md'));
    expect(parsed.frontmatter.implements).toHaveLength(1);
  });

  it('removes a symbol from implements', () => {
    seed('SPEC-004', { symbols: ['src/a.ts::A', 'src/b.ts::B'] });
    updateSpec({ id: 'SPEC-004', specsDir: tmpDir, removeSymbols: ['src/a.ts::A'] });
    const parsed = parseSpecFile(path.join(tmpDir, 'spec-004.md'));
    expect(parsed.frontmatter.implements).toHaveLength(1);
    expect(parsed.frontmatter.implements?.[0]?.symbol).toBe('src/b.ts::B');
  });

  it('removing the last symbol clears the implements field', () => {
    seed('SPEC-005', { symbols: ['src/a.ts::A'] });
    updateSpec({ id: 'SPEC-005', specsDir: tmpDir, removeSymbols: ['src/a.ts::A'] });
    const parsed = parseSpecFile(path.join(tmpDir, 'spec-005.md'));
    expect(parsed.frontmatter.implements).toBeUndefined();
  });

  it('removing a non-existent symbol is a no-op', () => {
    seed('SPEC-006', { symbols: ['src/a.ts::A'] });
    expect(() =>
      updateSpec({ id: 'SPEC-006', specsDir: tmpDir, removeSymbols: ['src/x.ts::X'] }),
    ).not.toThrow();
    const parsed = parseSpecFile(path.join(tmpDir, 'spec-006.md'));
    expect(parsed.frontmatter.implements).toHaveLength(1);
  });

  it('preserves the markdown body verbatim', () => {
    seed();
    const rawBefore = fs.readFileSync(path.join(tmpDir, 'spec-001.md'), 'utf-8');
    const bodyBefore = rawBefore.split('---').slice(2).join('---');

    updateSpec({
      id: 'SPEC-001',
      specsDir: tmpDir,
      addSymbols: [{ symbol: 'src/foo.ts::Foo', type: 'class' }],
      status: 'active',
    });

    const rawAfter = fs.readFileSync(path.join(tmpDir, 'spec-001.md'), 'utf-8');
    const bodyAfter = rawAfter.split('---').slice(2).join('---');
    expect(bodyAfter).toBe(bodyBefore);
  });

  it('throws if spec ID is not found', () => {
    expect(() =>
      updateSpec({ id: 'SPEC-NONEXISTENT', specsDir: tmpDir, status: 'active' }),
    ).toThrow('not found');
  });

  it('finds spec by ID regardless of filename convention', () => {
    // Simulate the existing SPEC-001-project-bootstrap.md naming pattern
    const longName = path.join(tmpDir, 'SPEC-007-long-name.md');
    fs.writeFileSync(
      longName,
      '---\nid: SPEC-007\ntitle: Long name\ntype: intent\nstatus: draft\ncreated: 2026-01-01\n---\n# Long name\n\n',
    );
    updateSpec({ id: 'SPEC-007', specsDir: tmpDir, status: 'active' });
    const parsed = parseSpecFile(longName);
    expect(parsed.frontmatter.status).toBe('active');
  });
});
