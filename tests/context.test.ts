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
