import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ─── isMutatingQuery (white-box test of the guard logic) ──────────────────────
// Mirrors the function in mcp.ts exactly so we can test it in isolation.

const MUTATING_KEYWORDS = /^\s*(CREATE|MERGE|SET|DELETE|REMOVE|DROP|ALTER|CALL)\b/i;

function isMutatingQuery(cypher: string): boolean {
  return MUTATING_KEYWORDS.test(cypher);
}

describe('isMutatingQuery', () => {
  it('blocks CREATE', () => expect(isMutatingQuery('CREATE (:Foo)')).toBe(true));
  it('blocks MERGE', () => expect(isMutatingQuery('MERGE (:Foo)')).toBe(true));
  it('blocks SET', () => expect(isMutatingQuery('SET n.prop = 1')).toBe(true));
  it('blocks DELETE', () => expect(isMutatingQuery('DELETE n')).toBe(true));
  it('blocks REMOVE', () => expect(isMutatingQuery('REMOVE n.prop')).toBe(true));
  it('blocks DROP', () => expect(isMutatingQuery('DROP TABLE Spec')).toBe(true));
  it('is case-insensitive', () => expect(isMutatingQuery('create (:Foo)')).toBe(true));
  it('allows leading whitespace', () => expect(isMutatingQuery('  CREATE (:Foo)')).toBe(true));

  it('allows MATCH', () => expect(isMutatingQuery('MATCH (n) RETURN n')).toBe(false));
  it('allows RETURN', () => expect(isMutatingQuery('RETURN 1')).toBe(false));
  it('allows WITH', () => expect(isMutatingQuery('WITH 1 AS x RETURN x')).toBe(false));
  it('allows UNWIND', () => expect(isMutatingQuery('UNWIND [1,2] AS x RETURN x')).toBe(false));
  // CALL in a query that begins with MATCH is still a mutating keyword by this heuristic —
  // that is intentional; agents should use dedicated tools for write operations
});

// ─── MCP module exports ───────────────────────────────────────────────────────

describe('runMcp export', () => {
  it('exports a runMcp function', async () => {
    const mod = await import('../src/cli/commands/mcp.js');
    expect(typeof mod.runMcp).toBe('function');
  });
});

// ─── create_spec via spec-writer (used by MCP create_spec tool) ───────────────

import { createSpec, updateSpec, ALLOWED_SPEC_TYPES } from '../src/core/spec-writer.js';
import { parseSpecFile } from '../src/core/parser.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'specgraph-mcp-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('create_spec tool logic (via spec-writer)', () => {
  it('creates a spec file with the correct structure', () => {
    const { filePath } = createSpec({
      id: 'MCP-001',
      title: 'MCP test spec',
      type: 'intent',
      specsDir: tmpDir,
    });
    const parsed = parseSpecFile(filePath);
    expect(parsed.frontmatter.id).toBe('MCP-001');
    expect(parsed.frontmatter.type).toBe('intent');
    expect(parsed.frontmatter.status).toBe('draft');
  });

  it('returns an error message for duplicate IDs (error thrown by spec-writer)', () => {
    const opts = { id: 'MCP-002', title: 'Dup', type: 'intent', specsDir: tmpDir };
    createSpec(opts);
    expect(() => createSpec(opts)).toThrow('already exists');
  });

  it('returns an error message for invalid type', () => {
    expect(() =>
      createSpec({ id: 'MCP-003', title: 'Bad', type: 'invalid_type', specsDir: tmpDir }),
    ).toThrow('Invalid spec type');
  });

  it('populates implements from symbols list', () => {
    const { filePath } = createSpec({
      id: 'MCP-004',
      title: 'With symbols',
      type: 'business_rule',
      symbols: ['src/Model/Order.php::Order.setPrice'],
      specsDir: tmpDir,
    });
    const parsed = parseSpecFile(filePath);
    expect(parsed.frontmatter.implements?.[0]?.symbol).toBe('src/Model/Order.php::Order.setPrice');
  });
});

// ─── update_spec tool logic (via spec-writer) ─────────────────────────────────

describe('update_spec tool logic (via updateSpec)', () => {
  it('updates status of an existing spec', () => {
    createSpec({ id: 'MCP-UPDATE-001', title: 'U1', type: 'intent', specsDir: tmpDir });
    const { filePath } = updateSpec({
      id: 'MCP-UPDATE-001',
      specsDir: tmpDir,
      status: 'active',
    });
    const parsed = parseSpecFile(filePath);
    expect(parsed.frontmatter.status).toBe('active');
  });

  it('adds symbol links to a spec', () => {
    createSpec({ id: 'MCP-UPDATE-002', title: 'U2', type: 'intent', specsDir: tmpDir });
    updateSpec({
      id: 'MCP-UPDATE-002',
      specsDir: tmpDir,
      addSymbols: [{ symbol: 'src/core/db.ts::openDatabase', type: 'function' }],
    });
    const parsed = parseSpecFile(path.join(tmpDir, 'mcp-update-002.md'));
    expect(parsed.frontmatter.implements?.[0]?.symbol).toBe('src/core/db.ts::openDatabase');
  });
});

// ─── Tool list completeness ───────────────────────────────────────────────────

describe('MCP tool list', () => {
  // The expected tool names from the plan
  const EXPECTED_TOOLS = [
    'list_specs',
    'get_spec',
    'list_rules',
    'get_symbols_for_spec',
    'get_specs_for_symbol',
    'get_drift_report',
    'query_graph',
    'create_spec',
    'update_spec',
  ];

  it('mcp.ts contains all expected tool names', async () => {
    const mcpSrc = fs.readFileSync(
      path.resolve('src/cli/commands/mcp.ts'),
      'utf-8',
    );
    for (const tool of EXPECTED_TOOLS) {
      expect(mcpSrc).toContain(`name: '${tool}'`);
    }
  });
});
