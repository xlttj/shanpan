import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createSpec, ALLOWED_SPEC_TYPES } from '../src/core/spec-writer.js';
import { parseSpecFile } from '../src/core/parser.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'specgraph-create-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('createSpec', () => {
  it('creates a .md file at the correct path', () => {
    const { filePath } = createSpec({
      id: 'SPEC-001',
      title: 'Test Spec',
      type: 'intent',
      specsDir: tmpDir,
    });
    expect(fs.existsSync(filePath)).toBe(true);
    expect(filePath).toBe(path.join(tmpDir, 'spec-001.md'));
  });

  it('derives the filename from the ID (lowercase)', () => {
    createSpec({ id: 'RULE-007', title: 'A rule', type: 'business_rule', specsDir: tmpDir });
    expect(fs.existsSync(path.join(tmpDir, 'rule-007.md'))).toBe(true);
  });

  it('produces a file that round-trips through parseSpecFile', () => {
    const { filePath } = createSpec({
      id: 'SPEC-002',
      title: 'Round-trip test',
      type: 'software_requirement',
      specsDir: tmpDir,
    });
    const parsed = parseSpecFile(filePath);
    expect(parsed.frontmatter.id).toBe('SPEC-002');
    expect(parsed.frontmatter.title).toBe('Round-trip test');
    expect(parsed.frontmatter.type).toBe('software_requirement');
    expect(parsed.frontmatter.status).toBe('draft');
  });

  it('sets today\'s date in the created field', () => {
    const { filePath } = createSpec({
      id: 'SPEC-003',
      title: 'Date test',
      type: 'intent',
      specsDir: tmpDir,
    });
    const parsed = parseSpecFile(filePath);
    const today = new Date().toISOString().slice(0, 10);
    expect(String(parsed.frontmatter.created)).toBe(today);
  });

  it('throws if the file already exists', () => {
    const opts = { id: 'SPEC-004', title: 'Dup', type: 'intent', specsDir: tmpDir };
    createSpec(opts);
    expect(() => createSpec(opts)).toThrow('already exists');
  });

  it('throws on an invalid spec type', () => {
    expect(() =>
      createSpec({ id: 'SPEC-005', title: 'Bad type', type: 'unknown_type', specsDir: tmpDir }),
    ).toThrow('Invalid spec type');
  });

  it('accepts all allowed types without throwing', () => {
    for (const type of ALLOWED_SPEC_TYPES) {
      const id = `TEST-${type.toUpperCase().replace(/_/g, '-')}`;
      expect(() => createSpec({ id, title: type, type, specsDir: tmpDir })).not.toThrow();
    }
  });

  it('populates implements when symbols are provided', () => {
    const { filePath } = createSpec({
      id: 'SPEC-006',
      title: 'With symbols',
      type: 'business_rule',
      symbols: ['src/foo.ts::Foo', 'src/bar.ts::Bar.doWork'],
      specsDir: tmpDir,
    });
    const parsed = parseSpecFile(filePath);
    expect(parsed.frontmatter.implements).toHaveLength(2);
    expect(parsed.frontmatter.implements?.[0]?.symbol).toBe('src/foo.ts::Foo');
    expect(parsed.frontmatter.implements?.[1]?.symbol).toBe('src/bar.ts::Bar.doWork');
  });

  it('omits implements when no symbols are provided', () => {
    const { filePath } = createSpec({
      id: 'SPEC-007',
      title: 'No symbols',
      type: 'intent',
      specsDir: tmpDir,
    });
    const parsed = parseSpecFile(filePath);
    expect(parsed.frontmatter.implements).toBeUndefined();
  });

  it('populates depends_on when dependsOn is provided', () => {
    const { filePath } = createSpec({
      id: 'SPEC-008',
      title: 'Deps',
      type: 'intent',
      dependsOn: ['SPEC-001'],
      specsDir: tmpDir,
    });
    const parsed = parseSpecFile(filePath);
    expect(parsed.frontmatter.depends_on).toEqual(['SPEC-001']);
  });

  it('creates the specsDir if it does not exist', () => {
    const nestedDir = path.join(tmpDir, 'deep', 'specs');
    createSpec({ id: 'SPEC-009', title: 'Nested', type: 'intent', specsDir: nestedDir });
    expect(fs.existsSync(path.join(nestedDir, 'spec-009.md'))).toBe(true);
  });
});
