import fs from 'node:fs';
import path from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { openDatabase, closeDatabase, dbExists, queryAll, escId } from '../../core/db.js';
import { loadConfig } from '../../core/config.js';
import { parseSpecFile, findSpecFiles, parseAllSpecs } from '../../core/parser.js';
import { createSpec, updateSpec, ALLOWED_SPEC_TYPES } from '../../core/spec-writer.js';
import { indexSpecs } from '../../core/indexer.js';
import { suggestRenames } from '../../analyzer/resolver.js';
import { computeDrift } from '../../core/drift.js';
import {
  readRecords,
  appendRecords,
  liveIds,
  nextId,
  formatTs,
  validateRecord,
} from '../../core/records.js';
import { indexRecords } from '../../core/record-indexer.js';
import { RECORD_KINDS, type KnowledgeRecord, type RecordKind } from '../../types/record.js';

const MUTATING_KEYWORDS = /^\s*(CREATE|MERGE|SET|DELETE|REMOVE|DROP|ALTER|CALL)\b/i;

function isMutatingQuery(cypher: string): boolean {
  return MUTATING_KEYWORDS.test(cypher);
}

function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function jsonResult(data: unknown) {
  return textResult(JSON.stringify(data, null, 2));
}

const CODE_SYMBOL_KINDS = [
  'class',
  'function',
  'method',
  'interface',
  'type',
  'enum',
  'constant',
] as const;

export async function handleGetCallers(
  projectDir: string,
  symbolId: string,
): Promise<{ content: { type: 'text'; text: string }[] }> {
  const { db, conn } = await openDatabase(projectDir, true);
  try {
    const { rows } = await queryAll(
      conn,
      `MATCH (c:CodeSymbol)-[:CALLS]->(:CodeSymbol {id: '${escId(symbolId)}'})
       RETURN DISTINCT c.id AS id, c.fqn AS fqn,
                       c.file_path AS filePath, c.symbol_type AS kind`,
    );
    rows.sort((a, b) => String(a['id']).localeCompare(String(b['id'])));
    return jsonResult(rows);
  } finally {
    await closeDatabase(db, conn);
  }
}

export async function handleGetCallees(
  projectDir: string,
  symbolId: string,
): Promise<{ content: { type: 'text'; text: string }[] }> {
  const { db, conn } = await openDatabase(projectDir, true);
  try {
    const { rows } = await queryAll(
      conn,
      `MATCH (:CodeSymbol {id: '${escId(symbolId)}'})-[:CALLS]->(c:CodeSymbol)
       RETURN DISTINCT c.id AS id, c.fqn AS fqn,
                       c.file_path AS filePath, c.symbol_type AS kind`,
    );
    rows.sort((a, b) => String(a['id']).localeCompare(String(b['id'])));
    return jsonResult(rows);
  } finally {
    await closeDatabase(db, conn);
  }
}

export async function handleGetImpact(
  projectDir: string,
  symbolId: string,
  maxDepthRequested = 3,
): Promise<{ content: { type: 'text'; text: string }[] }> {
  const maxDepth = Math.max(1, Math.min(10, Math.floor(maxDepthRequested)));
  const { db, conn } = await openDatabase(projectDir, true);
  try {
    const visited = new Map<
      string,
      { id: string; fqn: string; filePath: string; kind: string; depth: number; path: string[] }
    >();
    let frontier: { id: string; path: string[] }[] = [{ id: symbolId, path: [symbolId] }];
    for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
      const nextFrontier: { id: string; path: string[] }[] = [];
      for (const curr of frontier) {
        const { rows } = await queryAll(
          conn,
          `MATCH (:CodeSymbol {id: '${escId(curr.id)}'})-[:CALLS]->(c:CodeSymbol)
           RETURN DISTINCT c.id AS id, c.fqn AS fqn,
                           c.file_path AS filePath, c.symbol_type AS kind`,
        );
        for (const row of rows) {
          const id = String(row['id']);
          if (id === symbolId || visited.has(id)) continue;
          const newPath = [...curr.path, id];
          visited.set(id, {
            id,
            fqn: String(row['fqn']),
            filePath: String(row['filePath']),
            kind: String(row['kind']),
            depth,
            path: newPath,
          });
          nextFrontier.push({ id, path: newPath });
        }
      }
      frontier = nextFrontier;
    }
    const result = Array.from(visited.values()).sort(
      (a, b) => a.depth - b.depth || a.id.localeCompare(b.id),
    );
    return jsonResult(result);
  } finally {
    await closeDatabase(db, conn);
  }
}

export async function handleGetCallersTransitive(
  projectDir: string,
  symbolId: string,
  maxDepthRequested = 3,
): Promise<{ content: { type: 'text'; text: string }[] }> {
  const maxDepth = Math.max(1, Math.min(10, Math.floor(maxDepthRequested)));
  const { db, conn } = await openDatabase(projectDir, true);
  try {
    const visited = new Map<
      string,
      { id: string; fqn: string; filePath: string; kind: string; depth: number; path: string[] }
    >();
    let frontier: { id: string; path: string[] }[] = [{ id: symbolId, path: [symbolId] }];
    for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
      const nextFrontier: { id: string; path: string[] }[] = [];
      for (const curr of frontier) {
        const { rows } = await queryAll(
          conn,
          `MATCH (c:CodeSymbol)-[:CALLS]->(:CodeSymbol {id: '${escId(curr.id)}'})
           RETURN DISTINCT c.id AS id, c.fqn AS fqn,
                           c.file_path AS filePath, c.symbol_type AS kind`,
        );
        for (const row of rows) {
          const id = String(row['id']);
          if (id === symbolId || visited.has(id)) continue;
          const newPath = [...curr.path, id];
          visited.set(id, {
            id,
            fqn: String(row['fqn']),
            filePath: String(row['filePath']),
            kind: String(row['kind']),
            depth,
            path: newPath,
          });
          nextFrontier.push({ id, path: newPath });
        }
      }
      frontier = nextFrontier;
    }
    const result = Array.from(visited.values()).sort(
      (a, b) => a.depth - b.depth || a.id.localeCompare(b.id),
    );
    return jsonResult(result);
  } finally {
    await closeDatabase(db, conn);
  }
}

interface SymbolSearchResult {
  id: string;
  fqn: string;
  filePath: string;
  kind: string;
  score: number;
}

function splitIdentifierWords(fqn: string): string[] {
  // Split on dots, then each segment on camelCase boundaries and underscores.
  const words: string[] = [];
  for (const segment of fqn.split('.')) {
    if (!segment) continue;
    const parts = segment.split(/_+/).flatMap((s) => s.split(/(?=[A-Z])/));
    for (const p of parts) if (p) words.push(p);
  }
  return words;
}

export async function handleSearchSymbols(
  projectDir: string,
  query: string,
  limitRequested = 20,
  kind?: string,
): Promise<{ content: { type: 'text'; text: string }[] }> {
  if (!query || query.length === 0) return jsonResult([]);
  const limit = Math.max(1, Math.min(100, Math.floor(limitRequested)));

  const { db, conn } = await openDatabase(projectDir, true);
  try {
    // Fetch the candidate set once, filter + score in TS — avoids assumptions
    // about LIKE/CONTAINS support and keeps the scoring logic obvious.
    let cypher =
      'MATCH (c:CodeSymbol) RETURN c.id AS id, c.fqn AS fqn, c.file_path AS filePath, c.symbol_type AS kind LIMIT 10000';
    if (kind && (CODE_SYMBOL_KINDS as readonly string[]).includes(kind)) {
      cypher = `MATCH (c:CodeSymbol { symbol_type: '${escId(kind)}' }) RETURN c.id AS id, c.fqn AS fqn, c.file_path AS filePath, c.symbol_type AS kind LIMIT 10000`;
    }
    const { rows } = await queryAll(conn, cypher);

    const lowerQuery = query.toLowerCase();
    const scored = new Map<string, SymbolSearchResult>();
    for (const row of rows) {
      const id = String(row['id']);
      const fqn = String(row['fqn']);
      const filePath = String(row['filePath']);
      const rowKind = String(row['kind']);
      let score = 0;
      if (fqn === query) {
        score = 100;
      } else if (fqn.toLowerCase().includes(lowerQuery)) {
        score = 50;
      } else {
        const words = splitIdentifierWords(fqn);
        if (words.some((w) => w.toLowerCase().startsWith(lowerQuery))) {
          score = 25;
        }
      }
      if (score > 0) {
        const prev = scored.get(id);
        if (!prev || prev.score < score) {
          scored.set(id, { id, fqn, filePath, kind: rowKind, score });
        }
      }
    }

    const result = Array.from(scored.values())
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
      .slice(0, limit);
    return jsonResult(result);
  } finally {
    await closeDatabase(db, conn);
  }
}

const RECORD_RETURN =
  `r.id AS id, r.kind AS kind, r.claim AS claim, r.because AS because,
   r.given AS given, r.when_ AS whenClause, r.then_ AS thenClause,
   r.provenance AS provenance, r.ts AS ts`;

/**
 * Records attached to a symbol, to its containing file, and — when the symbol
 * is a method — to its parent class. Mirrors what the PreToolUse hook injects,
 * so an agent can ask for the same knowledge mid-task.
 */
export async function handleGetRecordsForSymbol(
  projectDir: string,
  symbolId: string,
  includeSuperseded = false,
): Promise<{ content: { type: 'text'; text: string }[] }> {
  const { db, conn } = await openDatabase(projectDir, true);
  try {
    const sep = symbolId.indexOf('::');
    const filePath = sep === -1 ? symbolId : symbolId.slice(0, sep);
    const liveFilter = includeSuperseded ? '' : 'AND r.live ';

    const targets = new Set<string>([symbolId, filePath]);
    // A method inherits knowledge recorded against its class.
    if (sep !== -1) {
      let fqn = symbolId.slice(sep + 2);
      while (fqn.includes('.')) {
        fqn = fqn.slice(0, fqn.lastIndexOf('.'));
        targets.add(`${filePath}::${fqn}`);
      }
    }

    const byId = new Map<string, Record<string, unknown>>();
    for (const target of targets) {
      const { rows } = await queryAll(
        conn,
        `MATCH (r:Record)-[:ABOUT]->(t) WHERE t.id = '${escId(target)}' ${liveFilter}
         RETURN DISTINCT ${RECORD_RETURN}, t.id AS subject`,
      );
      for (const row of rows) byId.set(String(row['id']), row);
    }
    return jsonResult([...byId.values()]);
  } finally {
    await closeDatabase(db, conn);
  }
}

/** Substring search over claim and because. Filtered in TS to avoid dialect assumptions. */
export async function handleSearchRecords(
  projectDir: string,
  query: string,
  limitRequested = 20,
  kind?: string,
): Promise<{ content: { type: 'text'; text: string }[] }> {
  if (!query) return jsonResult([]);
  const limit = Math.max(1, Math.min(100, Math.floor(limitRequested)));
  const { db, conn } = await openDatabase(projectDir, true);
  try {
    const kindFilter =
      kind && (RECORD_KINDS as readonly string[]).includes(kind)
        ? `AND r.kind = '${escId(kind)}' `
        : '';
    const { rows } = await queryAll(
      conn,
      `MATCH (r:Record) WHERE r.live ${kindFilter}RETURN ${RECORD_RETURN} LIMIT 10000`,
    );
    const needle = query.toLowerCase();
    const hits = rows.filter((row) => {
      const hay = `${String(row['claim'] ?? '')} ${String(row['because'] ?? '')}`.toLowerCase();
      return hay.includes(needle);
    });
    return jsonResult(hits.slice(0, limit));
  } finally {
    await closeDatabase(db, conn);
  }
}

/** All live records of one kind — 'rejected' and 'gotcha' are the high-value reads. */
export async function handleGetRecordsByKind(
  projectDir: string,
  kind: string,
): Promise<{ content: { type: 'text'; text: string }[] }> {
  if (!(RECORD_KINDS as readonly string[]).includes(kind)) {
    return textResult(`Unknown kind '${kind}'. Expected one of: ${RECORD_KINDS.join(', ')}`);
  }
  const { db, conn } = await openDatabase(projectDir, true);
  try {
    const { rows } = await queryAll(
      conn,
      `MATCH (r:Record) WHERE r.live AND r.kind = '${escId(kind)}'
       RETURN ${RECORD_RETURN} ORDER BY r.ts DESC`,
    );
    return jsonResult(rows);
  } finally {
    await closeDatabase(db, conn);
  }
}

/**
 * Subjects that resolve to no node — the record-level equivalent of spec drift.
 * Recomputed from disk rather than the graph, so it stays correct even when
 * the graph is stale.
 */
export async function handleGetRecordDrift(
  projectDir: string,
): Promise<{ content: { type: 'text'; text: string }[] }> {
  const { records, errors } = readRecords(projectDir);
  const { db, conn } = await openDatabase(projectDir, true);
  try {
    const { rows: symbolRows } = await queryAll(conn, 'MATCH (c:CodeSymbol) RETURN c.id AS id');
    const known = new Set(symbolRows.map((r) => String(r['id'])));
    const { rows: fileRows } = await queryAll(conn, 'MATCH (f:File) RETURN f.id AS id');
    for (const r of fileRows) known.add(String(r['id']));

    const live = liveIds(records);
    const unresolved: { recordId: string; subject: string; claim: string }[] = [];
    for (const rec of records) {
      if (!live.has(rec.id)) continue;
      for (const subject of rec.sb ?? []) {
        if (!known.has(subject)) {
          unresolved.push({ recordId: rec.id, subject, claim: rec.cl });
        }
      }
    }
    return jsonResult({ unresolved, invalidRecords: errors });
  } finally {
    await closeDatabase(db, conn);
  }
}

export interface AddRecordArgs {
  kind: string;
  claim: string;
  because?: string;
  subjects?: string[];
  provenance?: string;
  given?: string;
  when?: string;
  then?: string;
  supersedes?: string;
}

/**
 * Append one record. Validates before touching disk so a malformed write
 * cannot corrupt the knowledge file mid-session.
 */
export async function handleAddRecord(
  projectDir: string,
  args: AddRecordArgs,
): Promise<{ content: { type: 'text'; text: string }[] }> {
  const { records, errors } = readRecords(projectDir);
  if (errors.length > 0) {
    return textResult(
      `Refusing to append — the knowledge file has ${errors.length} invalid record(s). ` +
        `Run 'specgraph records check' to see them.`,
    );
  }
  if (!(RECORD_KINDS as readonly string[]).includes(args.kind)) {
    return textResult(`Unknown kind '${args.kind}'. Expected one of: ${RECORD_KINDS.join(', ')}`);
  }

  const taken = new Set(records.map((r) => r.id));
  const rec: KnowledgeRecord = {
    id: nextId(taken),
    kn: args.kind as RecordKind,
    cl: args.claim,
    pv: args.provenance ?? 'a',
    ts: formatTs(new Date()),
  };
  if (args.subjects && args.subjects.length > 0) rec.sb = args.subjects;
  if (args.because) rec.bc = args.because;
  if (args.given) rec.gv = args.given;
  if (args.when) rec.wn = args.when;
  if (args.then) rec.tn = args.then;
  if (args.supersedes) rec.ss = args.supersedes;

  const problems = validateRecord(rec, 0);
  if (problems.length > 0) {
    return textResult(`Record is not valid:\n${problems.map((p) => `  - ${p.message}`).join('\n')}`);
  }
  if (args.supersedes && !taken.has(args.supersedes)) {
    return textResult(`Cannot supersede '${args.supersedes}' — no such record.`);
  }

  appendRecords(projectDir, [rec]);
  return textResult(`Created record ${rec.id} (${rec.kn}). Call reindex to make it queryable.`);
}

export async function handleGetSpecsForSymbolWithContext(
  projectDir: string,
  symbolId: string,
): Promise<{ content: { type: 'text'; text: string }[] }> {
  const { db, conn } = await openDatabase(projectDir, true);
  try {
    const sep = symbolId.indexOf('::');
    const filePath = sep === -1 ? symbolId : symbolId.slice(0, sep);
    const fqn = sep === -1 ? null : symbolId.slice(sep + 2);

    // Build the FQN ancestor chain: e.g. "UserService.signIn" → ["UserService.signIn", "UserService"]
    const fqnLevels: string[] = [];
    if (fqn) {
      let current = fqn;
      while (current) {
        fqnLevels.push(current);
        const dot = current.lastIndexOf('.');
        if (dot === -1) break;
        current = current.slice(0, dot);
      }
    }

    const result: { scope: string; symbolId: string; specs: unknown[] }[] = [];

    // Query each FQN level (symbol → parent class → … )
    for (let i = 0; i < fqnLevels.length; i++) {
      const id = `${filePath}::${fqnLevels[i]}`;
      const { rows } = await queryAll(
        conn,
        `MATCH (c:CodeSymbol {id: '${escId(id)}'})-[:IMPLEMENTS]->(s:Spec)
         RETURN s.id AS id, s.title AS title, s.type AS type, s.status AS status`,
      );
      if (rows.length > 0) {
        const scope = i === 0 ? 'symbol' : i === fqnLevels.length - 1 ? 'class' : 'parent';
        result.push({ scope, symbolId: id, specs: rows });
      }
    }

    // Query File node specs
    const { rows: fileRows } = await queryAll(
      conn,
      `MATCH (f:File {id: '${escId(filePath)}'})-[:IMPLEMENTS]->(s:Spec)
       RETURN s.id AS id, s.title AS title, s.type AS type, s.status AS status`,
    );
    if (fileRows.length > 0) {
      result.push({ scope: 'file', symbolId: filePath, specs: fileRows });
    }

    // Specs linked to 1-hop callers (symbols that call this one)
    const { rows: callerSpecRows } = await queryAll(
      conn,
      `MATCH (caller:CodeSymbol)-[:CALLS]->(:CodeSymbol {id: '${escId(symbolId)}'})
       MATCH (caller)-[:IMPLEMENTS]->(s:Spec)
       RETURN s.id AS id, s.title AS title, s.type AS type, s.status AS status,
              caller.id AS viaSymbolId`,
    );
    if (callerSpecRows.length > 0) {
      result.push({ scope: 'callers', symbolId, specs: callerSpecRows });
    }

    // Specs linked to 1-hop callees (symbols this one calls)
    const { rows: calleeSpecRows } = await queryAll(
      conn,
      `MATCH (:CodeSymbol {id: '${escId(symbolId)}'})-[:CALLS]->(callee:CodeSymbol)
       MATCH (callee)-[:IMPLEMENTS]->(s:Spec)
       RETURN s.id AS id, s.title AS title, s.type AS type, s.status AS status,
              callee.id AS viaSymbolId`,
    );
    if (calleeSpecRows.length > 0) {
      result.push({ scope: 'callees', symbolId, specs: calleeSpecRows });
    }

    return jsonResult(result);
  } finally {
    await closeDatabase(db, conn);
  }
}

export async function runMcp(options: { projectDir?: string } = {}): Promise<void> {
  const projectDir = options.projectDir ? path.resolve(options.projectDir) : process.cwd();

  const server = new Server(
    { name: 'specgraph', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'list_specs',
        description: 'List all specs with id, title, type, and status',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'get_spec',
        description: 'Get full content (frontmatter + body) of a spec by path key',
        inputSchema: {
          type: 'object',
          properties: { id: { type: 'string', description: 'Spec path key, e.g. core/spec-parser' } },
          required: ['id'],
        },
      },
      {
        name: 'list_rules',
        description: 'List all BusinessRule nodes',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'get_symbols_for_spec',
        description: 'Get code symbols linked to a spec via IMPLEMENTS',
        inputSchema: {
          type: 'object',
          properties: { id: { type: 'string', description: 'Spec path key, e.g. core/spec-parser' } },
          required: ['id'],
        },
      },
      {
        name: 'get_specs_for_symbol',
        description: 'Get specs that cover a given code symbol ID',
        inputSchema: {
          type: 'object',
          properties: {
            symbolId: {
              type: 'string',
              description: 'Symbol ID, e.g. "src/foo.ts::MyClass"',
            },
          },
          required: ['symbolId'],
        },
      },
      {
        name: 'get_drift_report',
        description:
          'List spec implements entries whose symbol was not found during last analyze run',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'query_graph',
        description: 'Execute a read-only Cypher query against the graph',
        inputSchema: {
          type: 'object',
          properties: { cypher: { type: 'string', description: 'Cypher query (read-only)' } },
          required: ['cypher'],
        },
      },
      {
        name: 'create_spec',
        description: 'Create a new spec markdown file',
        inputSchema: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Human-readable title' },
            type: {
              type: 'string',
              enum: [...ALLOWED_SPEC_TYPES],
              description: 'Spec type',
            },
            dir: {
              type: 'string',
              description: 'Subdirectory under specsDir, e.g. core, cli, mcp',
            },
            symbols: {
              type: 'array',
              items: { type: 'string' },
              description: 'Symbol IDs to link via implements',
            },
            refs: {
              type: 'array',
              items: { type: 'string' },
              description: 'External URLs (http/https) to attach as context references',
            },
          },
          required: ['title', 'type'],
        },
      },
      {
        name: 'update_spec',
        description: 'Add/remove symbol links or change the status of an existing spec',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Spec path key to update, e.g. core/spec-parser' },
            addSymbols: {
              type: 'array',
              items: { type: 'string' },
              description: 'Symbol IDs to add to implements',
            },
            removeSymbols: {
              type: 'array',
              items: { type: 'string' },
              description: 'Symbol IDs to remove from implements',
            },
            addRefs: {
              type: 'array',
              items: { type: 'string' },
              description: 'URLs to add to refs',
            },
            removeRefs: {
              type: 'array',
              items: { type: 'string' },
              description: 'URLs to remove from refs',
            },
            status: { type: 'string', description: 'New status value' },
          },
          required: ['id'],
        },
      },
      {
        name: 'get_unspecced_symbols',
        description:
          'List CodeSymbol nodes that have no IMPLEMENTS edge — symbols not yet covered by any spec. Optionally filter by file path.',
        inputSchema: {
          type: 'object',
          properties: {
            file_path: {
              type: 'string',
              description:
                'Optional — filter to symbols in a specific file (relative path from project root)',
            },
          },
          required: [],
        },
      },
      {
        name: 'reindex',
        description:
          'Re-parse all spec files and rebuild the graph database. Use after creating or updating spec files within an MCP session.',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'get_callers',
        description:
          'List code symbols that directly call the given symbol (1-hop incoming CALLS edges).',
        inputSchema: {
          type: 'object',
          properties: {
            symbolId: { type: 'string', description: 'Symbol ID, e.g. "src/foo.ts::bar"' },
          },
          required: ['symbolId'],
        },
      },
      {
        name: 'get_callees',
        description:
          'List code symbols that the given symbol directly calls (1-hop outgoing CALLS edges).',
        inputSchema: {
          type: 'object',
          properties: {
            symbolId: { type: 'string', description: 'Symbol ID' },
          },
          required: ['symbolId'],
        },
      },
      {
        name: 'get_impact',
        description:
          'Blast radius: symbols transitively reachable via outgoing CALLS, up to maxDepth (default 3, max 10).',
        inputSchema: {
          type: 'object',
          properties: {
            symbolId: { type: 'string', description: 'Symbol ID to start from' },
            maxDepth: {
              type: 'number',
              description: 'Maximum BFS depth (default 3, capped at 10)',
            },
          },
          required: ['symbolId'],
        },
      },
      {
        name: 'get_callers_transitive',
        description:
          'Entry points: all symbols that transitively lead to the given symbol being called (reverse BFS via incoming CALLS edges), up to maxDepth (default 3, max 10). Each result includes depth and the call path from that entry point to the target. Use to understand who triggers this code and trace execution origins.',
        inputSchema: {
          type: 'object',
          properties: {
            symbolId: { type: 'string', description: 'Symbol ID to trace callers of' },
            maxDepth: {
              type: 'number',
              description: 'Maximum BFS depth (default 3, capped at 10)',
            },
          },
          required: ['symbolId'],
        },
      },
      {
        name: 'search_symbols',
        description:
          'Find code symbols by partial name. Matches in three passes: exact FQN (score 100), case-insensitive substring (50), camelCase/snake_case word-prefix (25).',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Partial name or identifier to search for' },
            limit: {
              type: 'number',
              description: 'Maximum results to return (default 20, capped at 100)',
            },
            kind: {
              type: 'string',
              enum: [...CODE_SYMBOL_KINDS],
              description: 'Optional symbol kind filter',
            },
          },
          required: ['query'],
        },
      },
      {
        name: 'get_specs_by_ref',
        description: 'List specs that reference a given external URL via their refs field',
        inputSchema: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'Exact URL to look up' },
          },
          required: ['url'],
        },
      },
      {
        name: 'get_unlinked_specs',
        description:
          'List specs that have no implements entries — specs not yet linked to any code symbol.',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'get_multi_spec_symbols',
        description:
          'List code symbols that are linked to more than one spec via IMPLEMENTS. Useful for spotting overlapping specs or intentional shared implementations.',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'get_records_for_symbol',
        description:
          'Knowledge records attached to a symbol, its containing file, and (for a method) its parent class. This is the same knowledge the PreToolUse hook injects. Kinds: gotcha and constraint are traps and invariants; rejected says what was already tried and abandoned; decision carries reasoning you should not re-litigate.',
        inputSchema: {
          type: 'object',
          properties: {
            symbolId: {
              type: 'string',
              description: 'Symbol ID (e.g. "src/core/drift.ts::computeDrift") or bare file path',
            },
            includeSuperseded: {
              type: 'boolean',
              description: 'Include records that have been replaced (default false)',
            },
          },
          required: ['symbolId'],
        },
      },
      {
        name: 'search_records',
        description: 'Substring search over record claims and reasons.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Text to look for' },
            kind: { type: 'string', enum: [...RECORD_KINDS], description: 'Optional kind filter' },
            limit: { type: 'number', description: 'Max results (default 20, capped at 100)' },
          },
          required: ['query'],
        },
      },
      {
        name: 'get_records_by_kind',
        description:
          "All live records of one kind, newest first. Use 'rejected' before proposing an approach and 'gotcha' before touching unfamiliar code.",
        inputSchema: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: [...RECORD_KINDS], description: 'Record kind' },
          },
          required: ['kind'],
        },
      },
      {
        name: 'add_record',
        description:
          'Append a knowledge record. Use when you learn something durable: a trap, an invariant, a decision and its reason, or an approach that was tried and abandoned. Set provenance to u when the user stated it, a when you observed it while working, i when you inferred it without a hard source. given/when/then are only valid on kind behavior, where when and then are required.',
        inputSchema: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: [...RECORD_KINDS], description: 'Record kind' },
            claim: { type: 'string', description: 'The claim; for behavior, the scenario name' },
            because: { type: 'string', description: 'Why the claim holds — omit rather than invent' },
            subjects: {
              type: 'array',
              items: { type: 'string' },
              description: 'Symbol IDs or file paths this record is about',
            },
            provenance: {
              type: 'string',
              description: 'u | a | i | g:<sha> | t:<path> | n:<path>:<line> | d:<path>',
            },
            given: { type: 'string', description: 'behavior only: precondition' },
            when: { type: 'string', description: 'behavior only: single triggering event' },
            then: { type: 'string', description: 'behavior only: expected outcome' },
            supersedes: { type: 'string', description: 'Record id this one replaces' },
          },
          required: ['kind', 'claim'],
        },
      },
      {
        name: 'get_record_drift',
        description:
          'Record subjects that no longer resolve to any symbol or file, plus any records that fail validation.',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'get_specs_for_symbol_with_context',
        description:
          'Get specs for a symbol AND its containing class/file hierarchy AND its 1-hop call-graph neighbours. Returns results grouped by scope (symbol, parent, class, file, callers, callees), with empty scopes omitted. Callers/callees entries include a viaSymbolId field showing which neighbour linked the spec.',
        inputSchema: {
          type: 'object',
          properties: {
            symbolId: {
              type: 'string',
              description: 'Symbol ID (e.g. "src/auth/session.ts::UserService.signIn") or bare file path (e.g. "composer.json")',
            },
          },
          required: ['symbolId'],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const a = (args ?? {}) as Record<string, unknown>;

    if (!dbExists(projectDir) && name !== 'create_spec' && name !== 'update_spec') {
      return textResult('No SpecGraph database found. Run `specgraph init` first.');
    }

    if (name === 'list_specs') {
      const { db, conn } = await openDatabase(projectDir, true);
      try {
        const { rows } = await queryAll(
          conn,
          'MATCH (s:Spec) RETURN s.id AS id, s.title AS title, s.type AS type, s.status AS status ORDER BY s.id',
        );
        return jsonResult(rows);
      } finally {
        await closeDatabase(db, conn);
      }
    }

    if (name === 'get_spec') {
      const id = String(a['id'] ?? '');
      const config = loadConfig(projectDir);
      const specsDir = path.resolve(projectDir, config.specsDir);
      const filePath = path.join(specsDir, id.endsWith('.md') ? id : id + '.md');
      try {
        const parsed = parseSpecFile(filePath, specsDir);
        return jsonResult({
          frontmatter: parsed.frontmatter,
          content: parsed.content,
          filePath: path.relative(projectDir, parsed.filePath),
        });
      } catch {
        return textResult(`Spec "${id}" not found.`);
      }
    }

    if (name === 'list_rules') {
      const { db, conn } = await openDatabase(projectDir, true);
      try {
        const { rows } = await queryAll(
          conn,
          'MATCH (r:BusinessRule) RETURN r.id AS id, r.title AS title, r.status AS status ORDER BY r.id',
        );
        return jsonResult(rows);
      } finally {
        await closeDatabase(db, conn);
      }
    }

    if (name === 'get_symbols_for_spec') {
      const id = String(a['id'] ?? '');
      const esc = escId(id);
      const { db, conn } = await openDatabase(projectDir, true);
      try {
        const { rows } = await queryAll(
          conn,
          `MATCH (c:CodeSymbol)-[:IMPLEMENTS]->(s:Spec {id: '${esc}'})
           RETURN c.id AS id, c.fqn AS fqn, c.symbol_type AS kind,
                  c.file_path AS filePath, c.line_start AS lineStart`,
        );
        return jsonResult(rows);
      } finally {
        await closeDatabase(db, conn);
      }
    }

    if (name === 'get_specs_for_symbol') {
      const symbolId = String(a['symbolId'] ?? '');
      const esc = escId(symbolId);
      const { db, conn } = await openDatabase(projectDir, true);
      try {
        const { rows: symRows } = await queryAll(
          conn,
          `MATCH (c:CodeSymbol {id: '${esc}'})-[:IMPLEMENTS]->(s:Spec)
           RETURN s.id AS id, s.title AS title, s.type AS type, s.status AS status`,
        );
        const { rows: fileRows } = await queryAll(
          conn,
          `MATCH (f:File {id: '${esc}'})-[:IMPLEMENTS]->(s:Spec)
           RETURN s.id AS id, s.title AS title, s.type AS type, s.status AS status`,
        );
        return jsonResult([...symRows, ...fileRows]);
      } finally {
        await closeDatabase(db, conn);
      }
    }

    if (name === 'get_drift_report') {
      const { db, conn } = await openDatabase(projectDir, true);
      try {
        const drift = await computeDrift(conn, projectDir);

        // Rename suggestions only make sense for CodeSymbol drift, not file drift.
        const { rows: symbolRows } = await queryAll(
          conn,
          'MATCH (c:CodeSymbol) RETURN c.id AS id, c.fqn AS fqn, c.file_path AS filePath',
        );
        const allSymbols = symbolRows.map((r) => ({
          id: String(r['id']),
          fqn: String(r['fqn']),
          filePath: String(r['filePath']),
          kind: 'function' as const,
          lineStart: 0,
          lineEnd: 0,
          language: '',
        }));

        const suggestions = suggestRenames(drift, allSymbols);
        const suggestionMap = new Map(
          suggestions.map((s) => [`${s.specId}::${s.oldSymbolId}`, s]),
        );
        const enriched = drift.map((d) => ({
          ...d,
          suggestion: suggestionMap.get(`${d.specId}::${d.symbolId}`) ?? null,
        }));

        return jsonResult(enriched);
      } finally {
        await closeDatabase(db, conn);
      }
    }

    if (name === 'query_graph') {
      const cypher = String(a['cypher'] ?? '');
      if (isMutatingQuery(cypher)) {
        return textResult(
          'Mutating queries are not allowed via query_graph. Use dedicated write tools.',
        );
      }
      const { db, conn } = await openDatabase(projectDir, true);
      try {
        const { columns, rows } = await queryAll(conn, cypher);
        return jsonResult({ columns, rows });
      } finally {
        await closeDatabase(db, conn);
      }
    }

    if (name === 'create_spec') {
      const config = loadConfig(projectDir);
      const specsDir = path.resolve(projectDir, config.specsDir);
      try {
        const { filePath } = createSpec({
          title: String(a['title'] ?? ''),
          type: String(a['type'] ?? ''),
          dir: typeof a['dir'] === 'string' ? a['dir'] : undefined,
          symbols: Array.isArray(a['symbols']) ? (a['symbols'] as string[]) : undefined,
          refs: Array.isArray(a['refs']) ? (a['refs'] as string[]) : undefined,
          specsDir,
        });
        return textResult(`Created ${path.relative(projectDir, filePath)}`);
      } catch (err) {
        return textResult(`Error: ${(err as Error).message}`);
      }
    }

    if (name === 'update_spec') {
      const config = loadConfig(projectDir);
      const specsDir = path.resolve(projectDir, config.specsDir);
      const addSymbolIds = Array.isArray(a['addSymbols']) ? (a['addSymbols'] as string[]) : [];
      const addSymbols = addSymbolIds.map((s) => ({ symbol: s, type: 'unknown' }));
      try {
        const { filePath } = updateSpec({
          id: String(a['id'] ?? ''),
          specsDir,
          addSymbols: addSymbols.length > 0 ? addSymbols : undefined,
          removeSymbols: Array.isArray(a['removeSymbols'])
            ? (a['removeSymbols'] as string[])
            : undefined,
          addRefs: Array.isArray(a['addRefs']) ? (a['addRefs'] as string[]) : undefined,
          removeRefs: Array.isArray(a['removeRefs']) ? (a['removeRefs'] as string[]) : undefined,
          status: a['status'] !== undefined ? String(a['status']) : undefined,
        });
        return textResult(`Updated ${path.relative(projectDir, filePath)}`);
      } catch (err) {
        return textResult(`Error: ${(err as Error).message}`);
      }
    }

    if (name === 'get_unlinked_specs') {
      const { db, conn } = await openDatabase(projectDir, true);
      try {
        const { rows } = await queryAll(
          conn,
          `MATCH (s:Spec) WHERE NOT EXISTS { MATCH ()-[:IMPLEMENTS]->(s) }
           RETURN s.id AS id, s.title AS title, s.type AS type, s.status AS status
           ORDER BY s.id`,
        );
        return jsonResult(rows);
      } finally {
        await closeDatabase(db, conn);
      }
    }

    if (name === 'get_multi_spec_symbols') {
      const { db, conn } = await openDatabase(projectDir, true);
      try {
        const { rows } = await queryAll(
          conn,
          `MATCH (c:CodeSymbol)-[:IMPLEMENTS]->(s:Spec)
           WITH c, collect({id: s.id, title: s.title, type: s.type}) AS specs
           WHERE size(specs) > 1
           RETURN c.id AS symbolId, c.fqn AS fqn, c.file_path AS filePath, specs
           ORDER BY c.id`,
        );
        return jsonResult(rows);
      } finally {
        await closeDatabase(db, conn);
      }
    }

    if (name === 'get_unspecced_symbols') {
      const filePath = a['file_path'] !== undefined ? String(a['file_path']) : undefined;
      const { db, conn } = await openDatabase(projectDir, true);
      try {
        let cypher =
          'MATCH (c:CodeSymbol) WHERE NOT EXISTS { MATCH (c)-[:IMPLEMENTS]->() }';
        if (filePath !== undefined) {
          const safe = escId(filePath);
          cypher += ` AND c.file_path = '${safe}'`;
        }
        cypher +=
          ' RETURN c.id AS id, c.fqn AS fqn, c.symbol_type AS kind, c.file_path AS file_path ORDER BY c.file_path, c.fqn';
        const { rows } = await queryAll(conn, cypher);
        return jsonResult(rows);
      } finally {
        await closeDatabase(db, conn);
      }
    }

    if (name === 'reindex') {
      const config = loadConfig(projectDir);
      const specsDir = path.resolve(projectDir, config.specsDir);
      const { specs, errors } = parseAllSpecs(specsDir);
      const { records, errors: recordErrors } = readRecords(projectDir);
      const { db, conn } = await openDatabase(projectDir);
      try {
        const stats = await indexSpecs(conn, specs);
        const lines = [
          `✓ Reindexed: ${stats.specs} specs, ${stats.symbols} symbols, ${stats.refs} refs, ${stats.implements} IMPLEMENTS edges, ${stats.references} REFERENCES edges`,
        ];
        // indexSpecs recreates the schema, so records must be rebuilt with it.
        if (recordErrors.length > 0) {
          lines.push(
            `Skipped records — ${recordErrors.length} invalid line(s); run 'specgraph records check'.`,
          );
        } else {
          const rec = await indexRecords(conn, records);
          lines.push(
            `✓ Records: ${rec.records} indexed, ${rec.live} live, ${rec.about} subject link(s)`,
          );
          if (rec.unresolved.length > 0) {
            lines.push(`⚠ ${rec.unresolved.length} unresolved subject(s) — run analyze, or the symbol moved.`);
          }
        }
        if (errors.length > 0) lines.push(`Warnings: ${errors.join('; ')}`);
        return textResult(lines.join('\n'));
      } finally {
        await closeDatabase(db, conn);
      }
    }

    if (name === 'get_callers') {
      return handleGetCallers(projectDir, String(a['symbolId'] ?? ''));
    }

    if (name === 'get_callees') {
      return handleGetCallees(projectDir, String(a['symbolId'] ?? ''));
    }

    if (name === 'get_impact') {
      const maxDepth = typeof a['maxDepth'] === 'number' ? (a['maxDepth'] as number) : 3;
      return handleGetImpact(projectDir, String(a['symbolId'] ?? ''), maxDepth);
    }

    if (name === 'get_callers_transitive') {
      const maxDepth = typeof a['maxDepth'] === 'number' ? (a['maxDepth'] as number) : 3;
      return handleGetCallersTransitive(projectDir, String(a['symbolId'] ?? ''), maxDepth);
    }

    if (name === 'search_symbols') {
      const limit = typeof a['limit'] === 'number' ? (a['limit'] as number) : 20;
      const kind = typeof a['kind'] === 'string' ? (a['kind'] as string) : undefined;
      return handleSearchSymbols(projectDir, String(a['query'] ?? ''), limit, kind);
    }

    if (name === 'get_specs_by_ref') {
      const url = String(a['url'] ?? '');
      const { db, conn } = await openDatabase(projectDir, true);
      try {
        const { rows } = await queryAll(
          conn,
          `MATCH (s:Spec)-[:REFERENCES]->(r:Ref {id: '${escId(url)}'})
           RETURN s.id AS id, s.title AS title, s.type AS type, s.status AS status ORDER BY s.id`,
        );
        return jsonResult(rows);
      } finally {
        await closeDatabase(db, conn);
      }
    }

    if (name === 'get_specs_for_symbol_with_context') {
      return handleGetSpecsForSymbolWithContext(projectDir, String(a['symbolId'] ?? ''));
    }

    if (name === 'get_records_for_symbol') {
      return handleGetRecordsForSymbol(
        projectDir,
        String(a['symbolId'] ?? ''),
        a['includeSuperseded'] === true,
      );
    }

    if (name === 'search_records') {
      const limit = typeof a['limit'] === 'number' ? (a['limit'] as number) : 20;
      const kind = typeof a['kind'] === 'string' ? (a['kind'] as string) : undefined;
      return handleSearchRecords(projectDir, String(a['query'] ?? ''), limit, kind);
    }

    if (name === 'get_records_by_kind') {
      return handleGetRecordsByKind(projectDir, String(a['kind'] ?? ''));
    }

    if (name === 'get_record_drift') {
      return handleGetRecordDrift(projectDir);
    }

    if (name === 'add_record') {
      return handleAddRecord(projectDir, {
        kind: String(a['kind'] ?? ''),
        claim: String(a['claim'] ?? ''),
        because: typeof a['because'] === 'string' ? a['because'] : undefined,
        subjects: Array.isArray(a['subjects']) ? (a['subjects'] as string[]) : undefined,
        provenance: typeof a['provenance'] === 'string' ? a['provenance'] : undefined,
        given: typeof a['given'] === 'string' ? a['given'] : undefined,
        when: typeof a['when'] === 'string' ? a['when'] : undefined,
        then: typeof a['then'] === 'string' ? a['then'] : undefined,
        supersedes: typeof a['supersedes'] === 'string' ? a['supersedes'] : undefined,
      });
    }

    return textResult(`Unknown tool: ${name}`);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // server.connect() resolves immediately after registering stdin listeners.
  // Block here until the client closes the pipe, so the process.exit(0) in
  // the CLI entry point doesn't terminate us before the first handshake.
  await new Promise<void>((resolve) => {
    process.stdin.once('close', resolve);
    if (process.stdin.destroyed || process.stdin.readableEnded) resolve();
  });
}
