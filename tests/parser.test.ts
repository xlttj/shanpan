import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseSpecFile, findSpecFiles, parseAllSpecs } from '../src/core/parser.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'specgraph-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeSpec(name: string, content: string): string {
  const filePath = path.join(tmpDir, name);
  fs.writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

describe('parseSpecFile', () => {
  it('parses valid spec frontmatter', () => {
    const filePath = writeSpec('spec-001.md', `---
title: "Test Spec"
type: software_requirement
status: draft
priority: high
author: axel
created: 2026-03-21
---

# Test Spec

Some description.
`);

    const result = parseSpecFile(filePath);

    expect(result.frontmatter.title).toBe('Test Spec');
    expect(result.frontmatter.type).toBe('software_requirement');
    expect(result.frontmatter.status).toBe('draft');
    expect(result.frontmatter.priority).toBe('high');
    expect(result.content).toContain('# Test Spec');
  });

  it('computes the path-based id when specsDir is provided', () => {
    const filePath = writeSpec('spec-001.md', `---
title: "Test Spec"
type: software_requirement
status: draft
---
`);
    const result = parseSpecFile(filePath, tmpDir);
    expect(result.id).toBe('spec-001');
  });

  it('throws on missing title', () => {
    const filePath = writeSpec('bad.md', `---
type: software_requirement
status: draft
---
`);
    expect(() => parseSpecFile(filePath)).toThrow("Missing required field 'title'");
  });

  it('parses optional arrays', () => {
    const filePath = writeSpec('spec-002.md', `---
title: "With Relations"
type: software_requirement
status: approved
defines_rules:
  - "BR-001"
implements:
  - symbol: "src/foo.ts::bar"
    type: function
---
`);
    const result = parseSpecFile(filePath);
    expect(result.frontmatter.defines_rules).toEqual(['BR-001']);
    expect(result.frontmatter.implements).toEqual([{ symbol: 'src/foo.ts::bar', type: 'function' }]);
  });
});

describe('findSpecFiles', () => {
  it('returns empty array for non-existent directory', () => {
    expect(findSpecFiles('/does/not/exist')).toEqual([]);
  });

  it('finds .md files recursively', () => {
    writeSpec('spec-001.md', `---\ntitle: "A"\ntype: t\nstatus: draft\n---\n`);
    writeSpec('spec-002.md', `---\ntitle: "B"\ntype: t\nstatus: draft\n---\n`);
    const files = findSpecFiles(tmpDir);
    expect(files).toHaveLength(2);
  });

  it('ignores non-md files', () => {
    writeSpec('notes.txt', 'just text');
    writeSpec('spec-001.md', `---\ntitle: "A"\ntype: t\nstatus: draft\n---\n`);
    const files = findSpecFiles(tmpDir);
    expect(files).toHaveLength(1);
  });
});

describe('parseAllSpecs', () => {
  it('collects parse errors without throwing', () => {
    writeSpec('good.md', `---\ntitle: "Good"\ntype: t\nstatus: draft\n---\n`);
    writeSpec('bad.md', `---\ntype: t\nstatus: draft\n---\n`);

    const { specs, errors } = parseAllSpecs(tmpDir);
    expect(specs).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("Missing required field 'title'");
  });

  it('warns on unknown frontmatter fields', () => {
    writeSpec('unknown-fields.md', `---
title: "Test"
type: software_requirement
status: draft
rules:
  - must not do X
widgets: 42
---
`);
    const { specs, warnings } = parseAllSpecs(tmpDir);
    expect(specs).toHaveLength(1);
    expect(warnings).toHaveLength(2);
    expect(warnings.some((w) => w.includes("'rules'"))).toBe(true);
    expect(warnings.some((w) => w.includes("'widgets'"))).toBe(true);
  });

  it('emits no warnings for valid frontmatter fields', () => {
    writeSpec('valid.md', `---
title: "Test"
type: business_rule
status: active
created: '2026-01-01'
implements:
  - symbol: src/foo.ts::bar
    type: method
refs:
  - https://example.com
---
`);
    const { warnings } = parseAllSpecs(tmpDir);
    expect(warnings).toHaveLength(0);
  });

  it('onWarning callback fires for unknown fields in parseSpecFile', () => {
    const filePath = writeSpec('spec.md', `---
title: "Test"
type: software_requirement
status: draft
rules:
  - must not do X
---
`);
    const collected: string[] = [];
    parseSpecFile(filePath, undefined, (msg) => collected.push(msg));
    expect(collected).toHaveLength(1);
    expect(collected[0]).toContain("'rules'");
  });
});
