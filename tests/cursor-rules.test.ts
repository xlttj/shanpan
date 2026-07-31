import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  ruleFileName,
  renderRule,
  writeRules,
  RULES_DIR,
  RULE_MARKER,
  type FileRecords,
} from '../src/core/cursor-rules.js';
import type { ContextRecord } from '../src/core/record-format.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'specgraph-rules-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function rec(id: string, kind: string, over: Partial<ContextRecord> = {}): ContextRecord {
  return {
    id,
    kind,
    claim: over.claim ?? `claim ${id}`,
    because: over.because ?? null,
    provenance: over.provenance ?? 'a',
  };
}

function rulesPath(name: string): string {
  return path.join(tmpDir, RULES_DIR, name);
}

describe('ruleFileName', () => {
  it('derives a flat filename from a nested source path', () => {
    expect(ruleFileName('src/core/watcher.ts')).toBe('specgraph-src-core-watcher-ts.mdc');
  });

  it('gives different files different names', () => {
    expect(ruleFileName('src/a.ts')).not.toBe(ruleFileName('src/b.ts'));
  });

  it('leaves no leading or trailing separator for dotfiles', () => {
    expect(ruleFileName('.specgraphrc.json')).toBe('specgraph-specgraphrc-json.mdc');
  });
});

describe('renderRule', () => {
  it('scopes the rule to the file with globs and alwaysApply false', () => {
    const body = renderRule('src/core/watcher.ts', [rec('aa', 'gotcha')]);
    expect(body).toContain('globs: src/core/watcher.ts');
    expect(body).toContain('alwaysApply: false');
  });

  it('opens with frontmatter so Cursor parses it as a rule', () => {
    expect(renderRule('src/a.ts', [rec('aa', 'gotcha')]).startsWith('---\n')).toBe(true);
  });

  it('carries the ownership marker so pruning can recognise it', () => {
    expect(renderRule('src/a.ts', [rec('aa', 'gotcha')])).toContain(RULE_MARKER);
  });

  it('includes every record rather than capping at the hook limit', () => {
    const many = Array.from({ length: 20 }, (_, i) => rec(String(i).padStart(2, '0'), 'gotcha'));
    const body = renderRule('src/a.ts', many);
    expect(body).not.toContain('not shown');
    for (const r of many) expect(body).toContain(r.id);
  });

  it('renders the reason when a record has one', () => {
    const body = renderRule('src/a.ts', [
      rec('aa', 'decision', { claim: 'use X', because: 'Y is slower' }),
    ]);
    expect(body).toContain('[decision] use X — Y is slower  (aa, a)');
  });
});

describe('writeRules', () => {
  const groups: FileRecords[] = [
    { file: 'src/a.ts', records: [rec('aa', 'gotcha')] },
    { file: 'src/b.ts', records: [rec('bb', 'constraint')] },
  ];

  it('writes one rule file per subject file', () => {
    const { written } = writeRules(tmpDir, groups);
    expect(written).toHaveLength(2);
    expect(fs.existsSync(rulesPath('specgraph-src-a-ts.mdc'))).toBe(true);
    expect(fs.existsSync(rulesPath('specgraph-src-b-ts.mdc'))).toBe(true);
  });

  it('is idempotent — a second run leaves the same set of files', () => {
    writeRules(tmpDir, groups);
    const first = fs.readdirSync(path.join(tmpDir, RULES_DIR)).sort();
    const { pruned } = writeRules(tmpDir, groups);
    expect(pruned).toEqual([]);
    expect(fs.readdirSync(path.join(tmpDir, RULES_DIR)).sort()).toEqual(first);
  });

  it('prunes a rule whose file no longer has records', () => {
    writeRules(tmpDir, groups);
    const { pruned } = writeRules(tmpDir, [groups[0]!]);
    expect(pruned).toEqual(['specgraph-src-b-ts.mdc']);
    expect(fs.existsSync(rulesPath('specgraph-src-b-ts.mdc'))).toBe(false);
    expect(fs.existsSync(rulesPath('specgraph-src-a-ts.mdc'))).toBe(true);
  });

  it('never deletes a hand-written rule that lacks the marker', () => {
    const handWritten = rulesPath('my-own-rule.mdc');
    fs.mkdirSync(path.dirname(handWritten), { recursive: true });
    fs.writeFileSync(handWritten, '---\nalwaysApply: true\n---\n\nmine\n');

    writeRules(tmpDir, groups);
    writeRules(tmpDir, []);

    expect(fs.existsSync(handWritten)).toBe(true);
    expect(fs.readFileSync(handWritten, 'utf-8')).toContain('mine');
  });

  it('prunes every generated rule when no records remain', () => {
    writeRules(tmpDir, groups);
    const { written, pruned } = writeRules(tmpDir, []);
    expect(written).toEqual([]);
    expect(pruned.sort()).toEqual(['specgraph-src-a-ts.mdc', 'specgraph-src-b-ts.mdc']);
  });
});
