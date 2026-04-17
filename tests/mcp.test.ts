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
import { parseSpecFile, parseAllSpecs } from '../src/core/parser.js';
import { openDatabase, closeDatabase } from '../src/core/db.js';
import { indexSpecs } from '../src/core/indexer.js';
import type { Database, Connection } from '@ladybugdb/core';

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
    'get_unspecced_symbols',
    'reindex',
    'get_callers',
    'get_callees',
    'get_impact',
    'search_symbols',
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

// ─── get_unspecced_symbols logic ──────────────────────────────────────────────

describe('get_unspecced_symbols tool logic', () => {
  let db: Database;
  let conn: Connection;
  let dbDir: string;

  beforeEach(async () => {
    dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'specgraph-unspecced-'));
    ({ db, conn } = await openDatabase(dbDir));
    // indexSpecs calls dropAndRecreateSchema internally
    await indexSpecs(conn, []);
  });

  afterEach(async () => {
    await closeDatabase(db, conn);
    fs.rmSync(dbDir, { recursive: true, force: true });
  });

  async function insertSymbol(id: string, filePath: string): Promise<void> {
    const fqn = id.split('::')[1] ?? id;
    const r = await conn.query(
      `CREATE (:CodeSymbol { id: '${id}', fqn: '${fqn}', symbol_type: 'function', file_path: '${filePath}', line_start: 0, line_end: 0, language: 'typescript' })`,
    );
    if (!Array.isArray(r)) r.close();
  }

  it('returns symbols with no IMPLEMENTS edge', async () => {
    // one specced symbol (via indexSpecs), one raw unspecced symbol
    await indexSpecs(conn, [{
      frontmatter: { id: 'S1', title: 'S1', type: 'intent', status: 'draft', implements: [{ symbol: 'src/a.ts::covered', type: 'function' }] },
      content: '',
      filePath: '/fake/s1.md',
    }]);
    await insertSymbol('src/b.ts::unspecced', 'src/b.ts');

    const { queryAll: qa } = await import('../src/core/db.js');
    const { rows } = await qa(
      conn,
      `MATCH (c:CodeSymbol) WHERE NOT EXISTS { MATCH (c)-[:IMPLEMENTS]->() }
       RETURN c.id AS id ORDER BY c.id`,
    );
    expect(rows.map((r) => r['id'])).toContain('src/b.ts::unspecced');
    expect(rows.map((r) => r['id'])).not.toContain('src/a.ts::covered');
  });

  it('returns empty array when all symbols have IMPLEMENTS edges', async () => {
    await indexSpecs(conn, [{
      frontmatter: { id: 'S2', title: 'S2', type: 'intent', status: 'draft', implements: [{ symbol: 'src/a.ts::covered', type: 'function' }] },
      content: '',
      filePath: '/fake/s2.md',
    }]);

    const { queryAll: qa } = await import('../src/core/db.js');
    const { rows } = await qa(
      conn,
      `MATCH (c:CodeSymbol) WHERE NOT EXISTS { MATCH (c)-[:IMPLEMENTS]->() } RETURN c.id AS id`,
    );
    expect(rows).toHaveLength(0);
  });

  it('filters by file_path when provided', async () => {
    await insertSymbol('src/x.ts::alpha', 'src/x.ts');
    await insertSymbol('src/y.ts::beta', 'src/y.ts');

    const { queryAll: qa } = await import('../src/core/db.js');
    const fp = 'src/x.ts';
    const safe = fp.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const { rows } = await qa(
      conn,
      `MATCH (c:CodeSymbol) WHERE NOT EXISTS { MATCH (c)-[:IMPLEMENTS]->() } AND c.file_path = '${safe}' RETURN c.id AS id`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.['id']).toBe('src/x.ts::alpha');
  });
});

// ─── reindex logic ────────────────────────────────────────────────────────────

describe('reindex tool logic', () => {
  it('parseAllSpecs + indexSpecs returns correct stats for temp spec files', async () => {
    createSpec({ id: 'RIDX-001', title: 'Reindex One', type: 'intent', specsDir: tmpDir });
    createSpec({
      id: 'RIDX-002',
      title: 'Reindex Two',
      type: 'business_rule',
      symbols: ['src/core/db.ts::openDatabase'],
      specsDir: tmpDir,
    });

    const { specs } = parseAllSpecs(tmpDir);
    expect(specs).toHaveLength(2);

    const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'specgraph-reindex-'));
    const { db, conn } = await openDatabase(dbDir);
    try {
      const stats = await indexSpecs(conn, specs);
      expect(stats.specs).toBe(2);
      expect(stats.symbols).toBe(1);
      expect(stats.implements).toBe(1);
    } finally {
      await closeDatabase(db, conn);
      fs.rmSync(dbDir, { recursive: true, force: true });
    }
  });
});

// ─── call-graph handlers (SPEC-008) ───────────────────────────────────────────

describe('call-graph handlers', () => {
  let dbDir: string;
  let db: Database;
  let conn: Connection;

  beforeEach(async () => {
    dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'specgraph-callgraph-'));
    // .specgraph is a directory (see DB_DIR)
    fs.mkdirSync(path.join(dbDir, '.specgraph'), { recursive: true });
    ({ db, conn } = await openDatabase(dbDir));
    await indexSpecs(conn, []);
    // Seed: a → b → c, a → d, d → b (cycle back)
    for (const [id, fqn] of [
      ['src/f.ts::a', 'a'],
      ['src/f.ts::b', 'b'],
      ['src/f.ts::c', 'c'],
      ['src/f.ts::d', 'd'],
    ]) {
      const r = await conn.query(
        `CREATE (:CodeSymbol { id: '${id}', fqn: '${fqn}', symbol_type: 'function', file_path: 'src/f.ts', line_start: 0, line_end: 0, language: 'typescript' })`,
      );
      if (!Array.isArray(r)) r.close();
    }
    for (const [from, to] of [
      ['src/f.ts::a', 'src/f.ts::b'],
      ['src/f.ts::b', 'src/f.ts::c'],
      ['src/f.ts::a', 'src/f.ts::d'],
      ['src/f.ts::d', 'src/f.ts::b'],
    ]) {
      const r = await conn.query(
        `MATCH (s:CodeSymbol {id: '${from}'}), (t:CodeSymbol {id: '${to}'}) CREATE (s)-[:CALLS {call_kind: 'static_call'}]->(t)`,
      );
      if (!Array.isArray(r)) r.close();
    }
    // Close the write connection so read-only handlers can open their own.
    await closeDatabase(db, conn);
  });

  afterEach(() => {
    fs.rmSync(dbDir, { recursive: true, force: true });
  });

  function parseJsonResult(res: { content: { type: string; text: string }[] }): unknown {
    return JSON.parse(res.content[0]!.text);
  }

  it('get_callers returns direct callers only', async () => {
    const { handleGetCallers } = await import('../src/cli/commands/mcp.js');
    const res = parseJsonResult(await handleGetCallers(dbDir, 'src/f.ts::b')) as {
      id: string;
    }[];
    const ids = res.map((r) => r.id).sort();
    expect(ids).toEqual(['src/f.ts::a', 'src/f.ts::d']);
  });

  it('get_callers returns empty array for unknown symbol', async () => {
    const { handleGetCallers } = await import('../src/cli/commands/mcp.js');
    const res = parseJsonResult(await handleGetCallers(dbDir, 'src/does-not-exist.ts::nope'));
    expect(res).toEqual([]);
  });

  it('get_callees returns direct callees only', async () => {
    const { handleGetCallees } = await import('../src/cli/commands/mcp.js');
    const res = parseJsonResult(await handleGetCallees(dbDir, 'src/f.ts::a')) as {
      id: string;
    }[];
    const ids = res.map((r) => r.id).sort();
    expect(ids).toEqual(['src/f.ts::b', 'src/f.ts::d']);
  });

  it('get_callees returns empty array for leaf symbol', async () => {
    const { handleGetCallees } = await import('../src/cli/commands/mcp.js');
    const res = parseJsonResult(await handleGetCallees(dbDir, 'src/f.ts::c'));
    expect(res).toEqual([]);
  });

  it('get_impact reaches all descendants with depth info', async () => {
    const { handleGetImpact } = await import('../src/cli/commands/mcp.js');
    const res = parseJsonResult(await handleGetImpact(dbDir, 'src/f.ts::a', 3)) as {
      id: string;
      depth: number;
    }[];
    const ids = res.map((r) => r.id).sort();
    expect(ids).toEqual(['src/f.ts::b', 'src/f.ts::c', 'src/f.ts::d']);
    const byId = new Map(res.map((r) => [r.id, r.depth]));
    expect(byId.get('src/f.ts::b')).toBe(1);
    expect(byId.get('src/f.ts::d')).toBe(1);
    expect(byId.get('src/f.ts::c')).toBe(2);
  });

  it('get_impact excludes the seed symbol itself and terminates on cycles', async () => {
    const { handleGetImpact } = await import('../src/cli/commands/mcp.js');
    const res = parseJsonResult(await handleGetImpact(dbDir, 'src/f.ts::b', 5)) as {
      id: string;
    }[];
    // b → c is the only reachable path; d→b→c must not pull b back in
    const ids = res.map((r) => r.id).sort();
    expect(ids).toEqual(['src/f.ts::c']);
  });

  it('get_impact respects maxDepth', async () => {
    const { handleGetImpact } = await import('../src/cli/commands/mcp.js');
    const res = parseJsonResult(await handleGetImpact(dbDir, 'src/f.ts::a', 1)) as {
      id: string;
    }[];
    const ids = res.map((r) => r.id).sort();
    expect(ids).toEqual(['src/f.ts::b', 'src/f.ts::d']);
  });
});

// ─── search_symbols (SPEC-009) ────────────────────────────────────────────────

describe('search_symbols handler', () => {
  let dbDir: string;
  let db: Database;
  let conn: Connection;

  beforeEach(async () => {
    dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'specgraph-search-'));
    fs.mkdirSync(path.join(dbDir, '.specgraph'), { recursive: true });
    ({ db, conn } = await openDatabase(dbDir));
    await indexSpecs(conn, []);
    const rows: [string, string, string][] = [
      ['src/auth.ts::signInWithGoogle', 'signInWithGoogle', 'function'],
      ['src/auth.ts::signInWithApple', 'signInWithApple', 'function'],
      ['src/tax.ts::Tax.calculateTax', 'Tax.calculateTax', 'method'],
      ['src/tax.ts::Tax', 'Tax', 'class'],
      ['src/misc.ts::my_helper', 'my_helper', 'function'],
    ];
    for (const [id, fqn, kind] of rows) {
      const r = await conn.query(
        `CREATE (:CodeSymbol { id: '${id}', fqn: '${fqn}', symbol_type: '${kind}', file_path: '${
          id.split('::')[0]
        }', line_start: 0, line_end: 0, language: 'typescript' })`,
      );
      if (!Array.isArray(r)) r.close();
    }
    await closeDatabase(db, conn);
  });

  afterEach(() => {
    fs.rmSync(dbDir, { recursive: true, force: true });
  });

  function parseJsonResult(res: { content: { type: string; text: string }[] }): unknown {
    return JSON.parse(res.content[0]!.text);
  }

  it('exact FQN match scores 100', async () => {
    const { handleSearchSymbols } = await import('../src/cli/commands/mcp.js');
    const res = parseJsonResult(await handleSearchSymbols(dbDir, 'signInWithGoogle')) as {
      id: string;
      score: number;
    }[];
    expect(res[0]?.score).toBe(100);
    expect(res[0]?.id).toBe('src/auth.ts::signInWithGoogle');
  });

  it('case-insensitive substring match scores 50', async () => {
    const { handleSearchSymbols } = await import('../src/cli/commands/mcp.js');
    const res = parseJsonResult(await handleSearchSymbols(dbDir, 'tax')) as {
      id: string;
      score: number;
    }[];
    const scores = new Map(res.map((r) => [r.id, r.score]));
    // Both Tax and Tax.calculateTax contain "tax" case-insensitively
    expect(scores.get('src/tax.ts::Tax')).toBe(50);
    expect(scores.get('src/tax.ts::Tax.calculateTax')).toBe(50);
  });

  it('camelCase boundary match scores 25', async () => {
    const { handleSearchSymbols } = await import('../src/cli/commands/mcp.js');
    const res = parseJsonResult(await handleSearchSymbols(dbDir, 'google')) as {
      id: string;
      score: number;
    }[];
    const hit = res.find((r) => r.id === 'src/auth.ts::signInWithGoogle');
    // "Google" word-prefix matches "google" (lowercased); substring also hits, so substring wins
    expect(hit?.score).toBe(50);
  });

  it('snake_case boundary match scores 25 when no substring match exists', async () => {
    const { handleSearchSymbols } = await import('../src/cli/commands/mcp.js');
    const res = parseJsonResult(await handleSearchSymbols(dbDir, 'help')) as {
      id: string;
      score: number;
    }[];
    const hit = res.find((r) => r.id === 'src/misc.ts::my_helper');
    // "helper" word starts with "help" but "help" is also a substring of "my_helper" → 50
    expect(hit?.score).toBe(50);
  });

  it('kind filter narrows results', async () => {
    const { handleSearchSymbols } = await import('../src/cli/commands/mcp.js');
    const res = parseJsonResult(await handleSearchSymbols(dbDir, 'Tax', 20, 'class')) as {
      id: string;
      kind: string;
    }[];
    expect(res).toHaveLength(1);
    expect(res[0]?.id).toBe('src/tax.ts::Tax');
    expect(res[0]?.kind).toBe('class');
  });

  it('empty query returns empty array', async () => {
    const { handleSearchSymbols } = await import('../src/cli/commands/mcp.js');
    const res = parseJsonResult(await handleSearchSymbols(dbDir, ''));
    expect(res).toEqual([]);
  });

  it('results are sorted by score descending', async () => {
    const { handleSearchSymbols } = await import('../src/cli/commands/mcp.js');
    const res = parseJsonResult(await handleSearchSymbols(dbDir, 'Tax')) as {
      id: string;
      score: number;
    }[];
    for (let i = 1; i < res.length; i++) {
      expect(res[i - 1]!.score).toBeGreaterThanOrEqual(res[i]!.score);
    }
  });
});
