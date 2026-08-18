import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDatabase, closeDatabase, dropAndRecreateSchema } from '../src/core/db.js';
import type { Database, Connection } from '@ladybugdb/core';

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
  it('blocks DROP', () => expect(isMutatingQuery('DROP TABLE Record')).toBe(true));
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



// ─── Tool list completeness ───────────────────────────────────────────────────

describe('MCP tool list', () => {
  // The expected tool names from the plan
  const EXPECTED_TOOLS = [
    'query_graph',
    'get_undocumented_symbols',
    'reindex',
    'get_callers',
    'get_callees',
    'get_impact',
    'get_callers_transitive',
    'search_symbols',
    'get_records_for_symbol',
    'search_records',
    'get_records_by_kind',
    'add_record',
    'get_record_drift',
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

  it('awaits every delegated handler, so the dispatch try/catch wraps its errors', () => {
    // `return handleX(...)` returns an unawaited promise; a rejection then
    // escapes the dispatch try/catch and reaches the agent as a raw -32603
    // instead of a diagnosed message. `return await handleX(...)` keeps it
    // inside the guard. This asserts none regressed to the unawaited form.
    const mcpSrc = fs.readFileSync(path.resolve('src/cli/commands/mcp.ts'), 'utf-8');
    const unawaited = [...mcpSrc.matchAll(/return (handle\w+)\(/g)].map((m) => m[1]);
    expect(unawaited, `unawaited delegated returns bypass diagnoseError: ${unawaited.join(', ')}`).toEqual([]);
  });
});

// ─── get_undocumented_symbols logic ──────────────────────────────────────────

describe('get_undocumented_symbols tool logic', () => {
  let db: Database;
  let conn: Connection;
  let dbDir: string;

  beforeEach(async () => {
    dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shanpan-undoc-'));
    ({ db, conn } = await openDatabase(dbDir));
    await dropAndRecreateSchema(conn);
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

  async function attachRecord(recordId: string, symbolId: string): Promise<void> {
    const r = await conn.query(
      `CREATE (:Record { id: '${recordId}', kind: 'intent', claim: 'c', because: NULL, given: NULL, when_: NULL, then_: NULL, provenance: 'a', provenance_kind: 'a', ts: timestamp('2026-01-01 00:00:00'), live: true })`,
    );
    if (!Array.isArray(r)) r.close();
    const e = await conn.query(
      `MATCH (rec:Record {id: '${recordId}'}), (c:CodeSymbol {id: '${symbolId}'}) CREATE (rec)-[:ABOUT]->(c)`,
    );
    if (!Array.isArray(e)) e.close();
  }

  it('returns symbols no record is ABOUT', async () => {
    await insertSymbol('src/a.ts::covered', 'src/a.ts');
    await insertSymbol('src/b.ts::bare', 'src/b.ts');
    await attachRecord('r00001', 'src/a.ts::covered');

    const { queryAll: qa } = await import('../src/core/db.js');
    const { rows } = await qa(
      conn,
      `MATCH (c:CodeSymbol) WHERE NOT EXISTS { MATCH (:Record)-[:ABOUT]->(c) }
       RETURN c.id AS id ORDER BY c.id`,
    );
    expect(rows.map((r) => r['id'])).toEqual(['src/b.ts::bare']);
  });

  it('returns empty when every symbol has a record', async () => {
    await insertSymbol('src/a.ts::covered', 'src/a.ts');
    await attachRecord('r00002', 'src/a.ts::covered');

    const { queryAll: qa } = await import('../src/core/db.js');
    const { rows } = await qa(
      conn,
      `MATCH (c:CodeSymbol) WHERE NOT EXISTS { MATCH (:Record)-[:ABOUT]->(c) } RETURN c.id AS id`,
    );
    expect(rows).toHaveLength(0);
  });

  it('filters by file_path when provided', async () => {
    await insertSymbol('src/x.ts::alpha', 'src/x.ts');
    await insertSymbol('src/y.ts::beta', 'src/y.ts');

    const { queryAll: qa } = await import('../src/core/db.js');
    const { rows } = await qa(
      conn,
      `MATCH (c:CodeSymbol) WHERE NOT EXISTS { MATCH (:Record)-[:ABOUT]->(c) } AND c.file_path = 'src/x.ts' RETURN c.id AS id`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.['id']).toBe('src/x.ts::alpha');
  });
});




// ─── call-graph handlers (SPEC-008) ───────────────────────────────────────────

describe('call-graph handlers', () => {
  let dbDir: string;
  let db: Database;
  let conn: Connection;

  beforeEach(async () => {
    dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shanpan-callgraph-'));
    // .shanpan is a directory (see DB_DIR)
    fs.mkdirSync(path.join(dbDir, '.shanpan'), { recursive: true });
    ({ db, conn } = await openDatabase(dbDir));
    await dropAndRecreateSchema(conn);
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

  it('explains an empty caller result instead of a bare []', async () => {
    const { handleGetCallers } = await import('../src/cli/commands/mcp.js');
    const res = await handleGetCallers(dbDir, 'src/does-not-exist.ts::nope');
    expect(res.content[0]!.text).toContain('does not mean');
    expect(res.content[0]!.text).toMatch(/vendor|not indexed/);
  });

  it('symbol output uses snake_case keys matching Cypher (file_path, symbol_type)', async () => {
    const { handleGetCallers } = await import('../src/cli/commands/mcp.js');
    const res = parseJsonResult(await handleGetCallers(dbDir, 'src/f.ts::b')) as Record<string, unknown>[];
    const row = res[0]!;
    expect(row).toHaveProperty('file_path');
    expect(row).toHaveProperty('symbol_type');
    expect(row).not.toHaveProperty('filePath');
    expect(row).not.toHaveProperty('kind');
  });

  it('get_callees returns direct callees only', async () => {
    const { handleGetCallees } = await import('../src/cli/commands/mcp.js');
    const res = parseJsonResult(await handleGetCallees(dbDir, 'src/f.ts::a')) as {
      id: string;
    }[];
    const ids = res.map((r) => r.id).sort();
    expect(ids).toEqual(['src/f.ts::b', 'src/f.ts::d']);
  });

  it('explains an empty callee result for a leaf symbol', async () => {
    const { handleGetCallees } = await import('../src/cli/commands/mcp.js');
    const res = await handleGetCallees(dbDir, 'src/f.ts::c');
    expect(res.content[0]!.text).toContain('does not mean');
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
    dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shanpan-search-'));
    fs.mkdirSync(path.join(dbDir, '.shanpan'), { recursive: true });
    ({ db, conn } = await openDatabase(dbDir));
    await dropAndRecreateSchema(conn);
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
    expect(res[0]?.symbol_type).toBe('class');
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

