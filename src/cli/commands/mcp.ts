import fs from 'node:fs';
import path from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { openDatabase, closeDatabase, dbExists, queryAll, escId, ensureSchema, migrateLegacyLayout } from '../../core/db.js';
import type { Connection } from '@ladybugdb/core';
import { computeRecordDrift } from '../../core/record-drift.js';
import {
  readRecords,
  appendRecords,
  nextId,
  formatTs,
  validateRecord,
  missingProvenanceRefs,
} from '../../core/records.js';
import { indexRecords } from '../../core/record-indexer.js';
import { ancestorDirs } from '../../core/dir-scope.js';
import { KIND_PRIORITY } from '../../core/record-format.js';
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

/** Turn a low-level DB error into an agent-actionable recovery message. */
export function diagnoseError(err: unknown): { content: { type: 'text'; text: string }[] } {
  const msg = err instanceof Error ? err.message : String(err);
  // An unknown *property* is a query typo, not a stale graph — do not tell the
  // agent to rebuild. The most common trap: MCP tools return camelCase
  // (filePath), but Cypher properties are snake_case (file_path).
  if (/cannot find property|property .*(does not exist|not found)/i.test(msg)) {
    return textResult(
      `shanpan: that property does not exist on the node (${msg}). This is a query ` +
        'error, not a stale graph. Cypher uses snake_case even though the MCP tools ' +
        'return camelCase. CodeSymbol properties: id, fqn, symbol_type, file_path, ' +
        'line_start, line_end, language. Record properties: id, kind, claim, because, ' +
        'provenance, ts, given, when_, then_, ref, live.',
    );
  }
  if (/binder|does not exist|no such|catalog|table/i.test(msg)) {
    return textResult(
      'shanpan: the graph database looks out of date — it likely predates a schema change ' +
        `(${msg}). Rebuild it with 'shanpan analyze --full' then 'shanpan records index' ` +
        '(or call the reindex tool), which recreates the graph against the current schema.',
    );
  }
  return textResult(`shanpan error: ${msg}`);
}

/** True when knowledge.ndjson holds records the graph does not have indexed. */
async function graphMissingRecords(projectDir: string, conn: Connection): Promise<number | null> {
  const { rows } = await queryAll(conn, 'MATCH (r:Record) RETURN count(r) AS n');
  if (Number(rows[0]?.['n'] ?? 0) > 0) return null;
  const { records } = readRecords(projectDir);
  return records.length > 0 ? records.length : null;
}

/**
 * A record read returned nothing. Distinguish "genuinely no records" from
 * "records exist on disk but the graph has none" — the latter is stale data
 * masquerading as absence, which an agent would otherwise trust.
 */
async function emptyRecordResult(
  projectDir: string,
  conn: Connection,
): Promise<{ content: { type: 'text'; text: string }[] }> {
  const onDisk = await graphMissingRecords(projectDir, conn);
  if (onDisk !== null) {
    return textResult(
      `shanpan: knowledge.ndjson holds ${onDisk} record(s) but none are indexed in the graph. ` +
        "Run 'shanpan records index' (or call the reindex tool) to make them queryable. " +
        'This is stale data, not an empty knowledge base.',
    );
  }
  return jsonResult([]);
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
   r.ref AS ref, r.provenance AS provenance, r.ts AS ts`;

/**
 * Records attached to a symbol, to its containing file, and — when the symbol
 * is a method — to its parent class. A bare file path returns every live
 * record on any symbol in that file (same grouping as shanpan rules).
 * Mirrors what the PreToolUse hook injects, so an agent can ask for the same
 * knowledge mid-task.
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

    // Bare file path: records often name a symbol, not the File node — pull
    // everything in the file the same way fetchRecordsByFile does for rules.
    if (sep === -1) {
      const { rows } = await queryAll(
        conn,
        `MATCH (r:Record)-[:ABOUT]->(c:CodeSymbol)
         WHERE c.file_path = '${escId(filePath)}' ${liveFilter}
         RETURN DISTINCT ${RECORD_RETURN}, c.id AS subject`,
      );
      for (const row of rows) byId.set(String(row['id']), row);
    }

    // Directory-anchored records covering the file's module subtree. Without
    // this, an OpenCode agent (which has no pre-edit injection and relies on
    // this tool) would never see module-wide rules.
    const dirs = ancestorDirs(filePath);
    if (dirs.length > 0) {
      const list = dirs.map((d) => `'${escId(d)}'`).join(', ');
      const { rows } = await queryAll(
        conn,
        `MATCH (r:Record)-[:ABOUT]->(d:File)
         WHERE d.kind = 'dir' AND d.id IN [${list}] ${liveFilter}
         RETURN DISTINCT ${RECORD_RETURN}, d.id AS subject`,
      );
      for (const row of rows) byId.set(String(row['id']), row);
    }

    // Lead with traps and invariants: gotcha/constraint before decision, the
    // same priority the PreToolUse hook injects with. Without this the payload
    // came back in resolution order and buried the load-bearing records.
    const out = [...byId.values()].sort(
      (a, b) =>
        (KIND_PRIORITY[String(a['kind'])] ?? 99) - (KIND_PRIORITY[String(b['kind'])] ?? 99) ||
        String(a['id']).localeCompare(String(b['id'])),
    );
    return out.length === 0 ? await emptyRecordResult(projectDir, conn) : jsonResult(out);
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
    const out = hits.slice(0, limit);
    return out.length === 0 ? await emptyRecordResult(projectDir, conn) : jsonResult(out);
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
    return rows.length === 0 ? await emptyRecordResult(projectDir, conn) : jsonResult(rows);
  } finally {
    await closeDatabase(db, conn);
  }
}

/** Live source records pointing at a given document — the reverse of a source pointer. */
export async function handleGetRecordsByRef(
  projectDir: string,
  ref: string,
): Promise<{ content: { type: 'text'; text: string }[] }> {
  if (!ref) return jsonResult([]);
  const { db, conn } = await openDatabase(projectDir, true);
  try {
    const { rows } = await queryAll(
      conn,
      `MATCH (r:Record) WHERE r.live AND r.ref = '${escId(ref)}'
       RETURN ${RECORD_RETURN} ORDER BY r.ts DESC`,
    );
    return rows.length === 0 ? await emptyRecordResult(projectDir, conn) : jsonResult(rows);
  } finally {
    await closeDatabase(db, conn);
  }
}

/**
 * Subjects that resolve to no CodeSymbol and no File.
 * Recomputed from disk rather than the graph, so it stays correct even when
 * the graph is stale.
 */
export async function handleGetRecordDrift(
  projectDir: string,
): Promise<{ content: { type: 'text'; text: string }[] }> {
  const { db, conn } = await openDatabase(projectDir, true);
  try {
    const report = await computeRecordDrift(conn, projectDir);
    const onDisk = await graphMissingRecords(projectDir, conn);
    // Surface the stale-graph state here too — this is the diagnostic tool an
    // agent reaches for, and a "clean" drift report against an empty graph is a
    // silent lie.
    const graphStale =
      onDisk !== null
        ? `knowledge.ndjson has ${onDisk} record(s) but the graph has none indexed — run 'shanpan records index'.`
        : null;
    return jsonResult({ ...report, graphStale });
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
  ref?: string;
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
        `Run 'shanpan records check' to see them.`,
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
  if (args.ref) rec.rf = args.ref;
  if (args.supersedes) rec.ss = args.supersedes;

  const problems = validateRecord(rec, 0);
  if (problems.length > 0) {
    return textResult(`Record is not valid:\n${problems.map((p) => `  - ${p.message}`).join('\n')}`);
  }
  if (args.supersedes && !taken.has(args.supersedes)) {
    return textResult(`Cannot supersede '${args.supersedes}' — no such record.`);
  }
  const missing = missingProvenanceRefs(rec, projectDir);
  if (missing.length > 0) {
    return textResult(
      `Provenance cites a file that does not exist: ${missing.join(', ')}. ` +
        "A d:/t:/n: pointer must name a real file you read; if the claim is your own inference, use provenance 'i'.",
    );
  }

  appendRecords(projectDir, [rec]);
  return textResult(`Created record ${rec.id} (${rec.kn}). Call reindex to make it queryable.`);
}

export async function runMcp(options: { projectDir?: string } = {}): Promise<void> {
  const projectDir = options.projectDir ? path.resolve(options.projectDir) : process.cwd();
  // A repo bootstrapped under the old name must not read as empty here.
  migrateLegacyLayout(projectDir);

  const server = new Server(
    { name: 'shanpan', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
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
        name: 'get_undocumented_symbols',
        description:
          'List CodeSymbol nodes that no knowledge record is ABOUT — code nothing has been recorded against. Optionally filter by file path.',
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
          'Re-read knowledge.ndjson and rebuild Record nodes. Call after add_record so the new record becomes queryable.',
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
          'Append a knowledge record. Use when you learn something durable: a trap, an invariant, a decision and its reason, or an approach that was tried and abandoned. Set provenance to u when the user stated it, a when you observed it while working, i when you inferred it without a hard source. given/when/then are only valid on kind behavior, where when and then are required. For kind source, claim is the topic and ref (required) is the document to consult; add subjects to surface it when related code is edited.',
        inputSchema: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: [...RECORD_KINDS], description: 'Record kind' },
            claim: { type: 'string', description: 'The claim; for behavior the scenario name; for source the topic' },
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
            ref: { type: 'string', description: 'source only, required: the document — a URL or repo-relative path' },
            supersedes: { type: 'string', description: 'Record id this one replaces' },
          },
          required: ['kind', 'claim'],
        },
      },
      {
        name: 'get_records_by_ref',
        description:
          'Find source records that point at a given document (URL or repo-relative path). The inverse of reading a source pointer — answers "which topics cite this document?".',
        inputSchema: {
          type: 'object',
          properties: {
            ref: { type: 'string', description: 'Exact document URL or path to look up' },
          },
          required: ['ref'],
        },
      },
      {
        name: 'get_record_drift',
        description:
          'Record subjects that no longer resolve to any symbol or file, plus any records that fail validation.',
        inputSchema: { type: 'object', properties: {} },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
   try {
    const { name, arguments: args } = request.params;
    const a = (args ?? {}) as Record<string, unknown>;

    if (!dbExists(projectDir) && name !== 'add_record') {
      return textResult('No Shanpan database found. Run `shanpan init` first.');
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





    if (name === 'get_undocumented_symbols') {
      const filePath = a['file_path'] !== undefined ? String(a['file_path']) : undefined;
      const { db, conn } = await openDatabase(projectDir, true);
      try {
        let cypher =
          'MATCH (c:CodeSymbol) WHERE NOT EXISTS { MATCH (:Record)-[:ABOUT]->(c) }';
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
      const { records, errors } = readRecords(projectDir);
      if (errors.length > 0) {
        return textResult(
          `Refusing to index — ${errors.length} invalid record(s). Run 'shanpan records check'.`,
        );
      }
      const { db, conn } = await openDatabase(projectDir);
      try {
        const cleared = await conn.query('MATCH (r:Record) DETACH DELETE r');
        if (!Array.isArray(cleared)) cleared.close();
        const stats = await indexRecords(conn, records, projectDir);
        const lines = [
          `✓ Indexed ${stats.records} record(s): ${stats.live} live, ${stats.about} subject link(s), ${stats.supersedes} supersede edge(s)`,
        ];
        if (stats.unresolved.length > 0) {
          lines.push(`⚠ ${stats.unresolved.length} unresolved subject(s) — run 'shanpan analyze', or the symbol moved.`);
        }
        return textResult(lines.join('\n'));
      } finally {
        await closeDatabase(db, conn);
      }
    }


    if (name === 'get_callers') {
      return await handleGetCallers(projectDir, String(a['symbolId'] ?? ''));
    }

    if (name === 'get_callees') {
      return await handleGetCallees(projectDir, String(a['symbolId'] ?? ''));
    }

    if (name === 'get_impact') {
      const maxDepth = typeof a['maxDepth'] === 'number' ? (a['maxDepth'] as number) : 3;
      return await handleGetImpact(projectDir, String(a['symbolId'] ?? ''), maxDepth);
    }

    if (name === 'get_callers_transitive') {
      const maxDepth = typeof a['maxDepth'] === 'number' ? (a['maxDepth'] as number) : 3;
      return await handleGetCallersTransitive(projectDir, String(a['symbolId'] ?? ''), maxDepth);
    }

    if (name === 'search_symbols') {
      const limit = typeof a['limit'] === 'number' ? (a['limit'] as number) : 20;
      const kind = typeof a['kind'] === 'string' ? (a['kind'] as string) : undefined;
      return await handleSearchSymbols(projectDir, String(a['query'] ?? ''), limit, kind);
    }



    if (name === 'get_records_for_symbol') {
      return await handleGetRecordsForSymbol(
        projectDir,
        String(a['symbolId'] ?? ''),
        a['includeSuperseded'] === true,
      );
    }

    if (name === 'search_records') {
      const limit = typeof a['limit'] === 'number' ? (a['limit'] as number) : 20;
      const kind = typeof a['kind'] === 'string' ? (a['kind'] as string) : undefined;
      return await handleSearchRecords(projectDir, String(a['query'] ?? ''), limit, kind);
    }

    if (name === 'get_records_by_kind') {
      return await handleGetRecordsByKind(projectDir, String(a['kind'] ?? ''));
    }

    if (name === 'get_records_by_ref') {
      return await handleGetRecordsByRef(projectDir, String(a['ref'] ?? ''));
    }

    if (name === 'get_record_drift') {
      return await handleGetRecordDrift(projectDir);
    }

    if (name === 'add_record') {
      return await handleAddRecord(projectDir, {
        kind: String(a['kind'] ?? ''),
        claim: String(a['claim'] ?? ''),
        because: typeof a['because'] === 'string' ? a['because'] : undefined,
        subjects: Array.isArray(a['subjects']) ? (a['subjects'] as string[]) : undefined,
        provenance: typeof a['provenance'] === 'string' ? a['provenance'] : undefined,
        given: typeof a['given'] === 'string' ? a['given'] : undefined,
        when: typeof a['when'] === 'string' ? a['when'] : undefined,
        then: typeof a['then'] === 'string' ? a['then'] : undefined,
        ref: typeof a['ref'] === 'string' ? a['ref'] : undefined,
        supersedes: typeof a['supersedes'] === 'string' ? a['supersedes'] : undefined,
      });
    }

    return textResult(`Unknown tool: ${name}`);
   } catch (err) {
     // Never let a raw binder/connection error reach the agent as -32603 with
     // no recovery path — translate it into an actionable message.
     return diagnoseError(err);
   }
  });

  // Migrate an existing database to the current schema before serving. Handlers
  // open read-only, so without this a database that predates a schema change
  // would fail every query on a missing column with no chance to self-heal.
  if (dbExists(projectDir)) {
    try {
      const { db, conn } = await openDatabase(projectDir);
      try {
        await ensureSchema(conn);
      } finally {
        await closeDatabase(db, conn);
      }
    } catch {
      // Best-effort — if migration fails, per-call diagnoseError still guides.
    }
  }

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
