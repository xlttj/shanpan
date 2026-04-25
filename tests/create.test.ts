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
      title: 'Test Spec',
      type: 'intent',
      specsDir: tmpDir,
    });
    expect(fs.existsSync(filePath)).toBe(true);
    expect(filePath).toBe(path.join(tmpDir, 'test-spec.md'));
  });

  it('derives the filename from the title slug', () => {
    createSpec({ title: 'A Rule', type: 'business_rule', specsDir: tmpDir });
    expect(fs.existsSync(path.join(tmpDir, 'a-rule.md'))).toBe(true);
  });

  it('produces a file that round-trips through parseSpecFile', () => {
    const { filePath } = createSpec({
      title: 'Round-trip test',
      type: 'software_requirement',
      specsDir: tmpDir,
    });
    const parsed = parseSpecFile(filePath);
    expect(parsed.frontmatter.title).toBe('Round-trip test');
    expect(parsed.frontmatter.type).toBe('software_requirement');
    expect(parsed.frontmatter.status).toBe('draft');
  });

  it('sets today\'s date in the created field', () => {
    const { filePath } = createSpec({
      title: 'Date test',
      type: 'intent',
      specsDir: tmpDir,
    });
    const parsed = parseSpecFile(filePath);
    const today = new Date().toISOString().slice(0, 10);
    expect(String(parsed.frontmatter.created)).toBe(today);
  });

  it('throws if the file already exists', () => {
    const opts = { title: 'Dup', type: 'intent', specsDir: tmpDir };
    createSpec(opts);
    expect(() => createSpec(opts)).toThrow('already exists');
  });

  it('throws on an invalid spec type', () => {
    expect(() =>
      createSpec({ title: 'Bad type', type: 'unknown_type', specsDir: tmpDir }),
    ).toThrow('Invalid spec type');
  });

  it('accepts all allowed types without throwing', () => {
    for (const type of ALLOWED_SPEC_TYPES) {
      expect(() => createSpec({ title: type, type, specsDir: tmpDir })).not.toThrow();
    }
  });

  it('populates implements when symbols are provided', () => {
    const { filePath } = createSpec({
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
      title: 'No symbols',
      type: 'intent',
      specsDir: tmpDir,
    });
    const parsed = parseSpecFile(filePath);
    expect(parsed.frontmatter.implements).toBeUndefined();
  });

  it('creates the specsDir if it does not exist', () => {
    const nestedDir = path.join(tmpDir, 'deep', 'specs');
    createSpec({ title: 'Nested', type: 'intent', specsDir: nestedDir });
    expect(fs.existsSync(path.join(nestedDir, 'nested.md'))).toBe(true);
  });

  it('places the file in a subdirectory when dir is provided', () => {
    const { filePath } = createSpec({ title: 'Sub spec', type: 'intent', specsDir: tmpDir, dir: 'core' });
    expect(filePath).toBe(path.join(tmpDir, 'core', 'sub-spec.md'));
    expect(fs.existsSync(filePath)).toBe(true);
  });
});
