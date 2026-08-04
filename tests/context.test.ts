import { describe, it, expect } from 'vitest';

// Test the output format contract, not the DB integration.
// The command is thin: parse stdin JSON → extract paths → query DB → emit hookSpecificOutput.
// We test the JSON contract and edge-case handling via the module's helper logic.

function allowResponse() {
  return {
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' },
  };
}

function buildOutput(additionalContext: string) {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      additionalContext,
      permissionDecision: 'allow',
    },
  };
}

describe('context hook output contract', () => {
  it('allow response has the required PreToolUse shape', () => {
    const out = allowResponse();
    expect(out.hookSpecificOutput.hookEventName).toBe('PreToolUse');
    expect(out.hookSpecificOutput.permissionDecision).toBe('allow');
    expect('additionalContext' in out.hookSpecificOutput).toBe(false);
  });

  it('context response carries additionalContext and allows the tool', () => {
    const out = buildOutput('spec info here');
    expect(out.hookSpecificOutput.permissionDecision).toBe('allow');
    expect(out.hookSpecificOutput.additionalContext).toBe('spec info here');
  });

  it('JSON.stringify round-trips without mangling', () => {
    const out = buildOutput('line1\nline2');
    const parsed = JSON.parse(JSON.stringify(out));
    expect(parsed.hookSpecificOutput.additionalContext).toBe('line1\nline2');
  });
});

describe('record injection', () => {
  function r(id: string, kind: string, over: Partial<{ claim: string; because: string | null; provenance: string; ref: string | null }> = {}) {
    return {
      id,
      kind,
      claim: over.claim ?? `claim ${id}`,
      because: over.because === undefined ? null : over.because,
      provenance: over.provenance ?? 'a',
      ref: over.ref === undefined ? null : over.ref,
    };
  }

  it('puts traps and invariants before background, source after decision', async () => {
    const { sortRecords } = await import('../src/cli/commands/context.js');
    const sorted = sortRecords([
      r('aa', 'intent'), r('bb', 'decision'), r('cc', 'gotcha'),
      r('dd', 'constraint'), r('ee', 'rejected'), r('ff', 'source'),
    ]);
    expect(sorted.map((x) => x.kind)).toEqual([
      'gotcha', 'constraint', 'rejected', 'decision', 'source', 'intent',
    ]);
  });

  it('breaks ties by id so output is stable across runs', async () => {
    const { sortRecords } = await import('../src/cli/commands/context.js');
    const sorted = sortRecords([r('zz', 'gotcha'), r('aa', 'gotcha'), r('mm', 'gotcha')]);
    expect(sorted.map((x) => x.id)).toEqual(['aa', 'mm', 'zz']);
  });

  it('ranks a file-specific record above a module-wide one of the same kind', async () => {
    const { sortRecords } = await import('../src/cli/commands/context.js');
    const fileRec = { ...r('aa', 'constraint'), scope: 0 };
    const dirRec = { ...r('bb', 'constraint'), scope: 97, anchorDir: 'apps/bmf/src' };
    const sorted = sortRecords([dirRec, fileRec]);
    expect(sorted.map((x) => x.id)).toEqual(['aa', 'bb']);
  });

  it('renders a module-anchored record with its directory tag', async () => {
    const { formatRecords } = await import('../src/cli/commands/context.js');
    const lines = formatRecords([
      { ...r('ab12cd', 'constraint', { claim: 'idempotent consumers' }), anchorDir: 'apps/bmf/src' },
    ]);
    expect(lines[0]).toBe('  • [constraint] idempotent consumers [module: apps/bmf/src]  (ab12cd, a)');
  });

  it('sorts unknown kinds last rather than dropping them', async () => {
    const { sortRecords } = await import('../src/cli/commands/context.js');
    const sorted = sortRecords([r('aa', 'future_kind'), r('bb', 'intent')]);
    expect(sorted.map((x) => x.kind)).toEqual(['intent', 'future_kind']);
  });

  it('renders claim, reason, id and provenance on one line each', async () => {
    const { formatRecords } = await import('../src/cli/commands/context.js');
    const lines = formatRecords([r('ab12cd', 'gotcha', { claim: 'do not X', because: 'it breaks Y', provenance: 'g:abc123' })]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe('  • [gotcha] do not X — it breaks Y  (ab12cd, g:abc123)');
  });

  it('renders a source record as a pointer to the document', async () => {
    const { formatRecords } = await import('../src/cli/commands/context.js');
    const lines = formatRecords([r('ab12cd', 'source', { claim: 'VAT rounding', ref: 'docs/tax/vat.md', provenance: 'u' })]);
    expect(lines[0]).toBe('  • [source] VAT rounding → consult docs/tax/vat.md  (ab12cd, u)');
  });

  it('omits the reason clause when a record has no because', async () => {
    const { formatRecords } = await import('../src/cli/commands/context.js');
    const lines = formatRecords([r('ab12cd', 'constraint', { claim: 'always UTC' })]);
    expect(lines[0]).toBe('  • [constraint] always UTC  (ab12cd, a)');
  });

  it('caps injected records and says how many were withheld', async () => {
    const { formatRecords, MAX_INJECTED } = await import('../src/cli/commands/context.js');
    const many = Array.from({ length: MAX_INJECTED + 5 }, (_, i) =>
      r(String(i).padStart(2, '0'), 'gotcha'),
    );
    const lines = formatRecords(many);
    expect(lines).toHaveLength(MAX_INJECTED + 1);
    expect(lines[lines.length - 1]).toContain('5 more record(s) not shown');
  });

  it('adds no overflow line when exactly at the cap', async () => {
    const { formatRecords, MAX_INJECTED } = await import('../src/cli/commands/context.js');
    const exact = Array.from({ length: MAX_INJECTED }, (_, i) =>
      r(String(i).padStart(2, '0'), 'gotcha'),
    );
    expect(formatRecords(exact)).toHaveLength(MAX_INJECTED);
  });
});

describe('file path extraction logic', () => {
  function extractFilePaths(toolInput: { file_path?: string; edits?: Array<{ file_path?: string }> }): string[] {
    const paths: string[] = [];
    if (toolInput.file_path) paths.push(toolInput.file_path);
    for (const edit of toolInput.edits ?? []) {
      if (edit.file_path) paths.push(edit.file_path);
    }
    return [...new Set(paths)];
  }

  it('extracts file_path from Write/Edit input', () => {
    expect(extractFilePaths({ file_path: '/a/b.ts' })).toEqual(['/a/b.ts']);
  });

  it('extracts all unique paths from MultiEdit input', () => {
    const paths = extractFilePaths({
      edits: [{ file_path: '/a.ts' }, { file_path: '/b.ts' }, { file_path: '/a.ts' }],
    });
    expect(paths).toEqual(['/a.ts', '/b.ts']);
  });

  it('returns empty array when no file paths present', () => {
    expect(extractFilePaths({})).toEqual([]);
  });
});
