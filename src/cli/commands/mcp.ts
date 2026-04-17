import fs from 'node:fs';
import path from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { openDatabase, closeDatabase, dbExists, queryAll } from '../../core/db.js';
import { loadConfig } from '../../core/config.js';
import { parseSpecFile, findSpecFiles, parseAllSpecs } from '../../core/parser.js';
import { createSpec, updateSpec, ALLOWED_SPEC_TYPES } from '../../core/spec-writer.js';
import { indexSpecs } from '../../core/indexer.js';
import { suggestRenames } from '../../analyzer/resolver.js';
import type { UnresolvedImplementation } from '../../analyzer/resolver.js';

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

function escId(id: string): string {
  return id.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
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
      'MATCH (c:CodeSymbol) RETURN c.id AS id, c.fqn AS fqn, c.file_path AS filePath, c.symbol_type AS kind';
    if (kind && (CODE_SYMBOL_KINDS as readonly string[]).includes(kind)) {
      cypher = `MATCH (c:CodeSymbol { symbol_type: '${escId(kind)}' }) RETURN c.id AS id, c.fqn AS fqn, c.file_path AS filePath, c.symbol_type AS kind`;
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

export async function runMcp(): Promise<void> {
  const projectDir = process.cwd();

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
        description: 'Get full content (frontmatter + body) of a spec by ID',
        inputSchema: {
          type: 'object',
          properties: { id: { type: 'string', description: 'Spec ID, e.g. SPEC-001' } },
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
          properties: { id: { type: 'string', description: 'Spec ID' } },
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
            id: { type: 'string', description: 'Spec ID, e.g. RULE-001' },
            title: { type: 'string', description: 'Human-readable title' },
            type: {
              type: 'string',
              enum: [...ALLOWED_SPEC_TYPES],
              description: 'Spec type',
            },
            symbols: {
              type: 'array',
              items: { type: 'string' },
              description: 'Symbol IDs to link via implements',
            },
            dependsOn: {
              type: 'array',
              items: { type: 'string' },
              description: 'Spec IDs this spec depends on',
            },
            derivesFrom: {
              type: 'array',
              items: { type: 'string' },
              description: 'Spec IDs this spec derives from',
            },
          },
          required: ['id', 'title', 'type'],
        },
      },
      {
        name: 'update_spec',
        description: 'Add/remove symbol links or change the status of an existing spec',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Spec ID to update' },
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
      const files = findSpecFiles(specsDir);
      for (const filePath of files) {
        try {
          const parsed = parseSpecFile(filePath);
          if (parsed.frontmatter.id === id) {
            return jsonResult({
              frontmatter: parsed.frontmatter,
              content: parsed.content,
              filePath: path.relative(projectDir, parsed.filePath),
            });
          }
        } catch {
          // skip malformed files
        }
      }
      return textResult(`Spec "${id}" not found.`);
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
      const esc = id.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
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
      const esc = symbolId.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
      const { db, conn } = await openDatabase(projectDir, true);
      try {
        const { rows } = await queryAll(
          conn,
          `MATCH (c:CodeSymbol {id: '${esc}'})-[:IMPLEMENTS]->(s:Spec)
           RETURN s.id AS id, s.title AS title, s.type AS type, s.status AS status`,
        );
        return jsonResult(rows);
      } finally {
        await closeDatabase(db, conn);
      }
    }

    if (name === 'get_drift_report') {
      // Drift = spec implements entries whose symbol ID is not in the CodeSymbol table
      const { db, conn } = await openDatabase(projectDir, true);
      try {
        // Get all known symbols (id + fqn + file_path) for drift detection and suggestions
        const { rows: symbolRows } = await queryAll(
          conn,
          'MATCH (c:CodeSymbol) RETURN c.id AS id, c.fqn AS fqn, c.file_path AS filePath',
        );
        const knownIds = new Set(symbolRows.map((r) => String(r['id'])));

        // Build CodeSymbol-compatible objects for suggestRenames
        const allSymbols = symbolRows.map((r) => ({
          id: String(r['id']),
          fqn: String(r['fqn']),
          filePath: String(r['filePath']),
          kind: 'function' as const,
          lineStart: 0,
          lineEnd: 0,
          language: '',
        }));

        // Parse all specs and find unresolved implements
        const config = loadConfig(projectDir);
        const specsDir = path.resolve(projectDir, config.specsDir);
        const files = findSpecFiles(specsDir);
        const drift: UnresolvedImplementation[] = [];
        for (const filePath of files) {
          try {
            const parsed = parseSpecFile(filePath);
            for (const impl of parsed.frontmatter.implements ?? []) {
              if (!knownIds.has(impl.symbol)) {
                drift.push({ specId: parsed.frontmatter.id, symbolId: impl.symbol });
              }
            }
          } catch {
            // skip
          }
        }

        // Enrich with rename suggestions
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
          id: String(a['id'] ?? ''),
          title: String(a['title'] ?? ''),
          type: String(a['type'] ?? ''),
          symbols: Array.isArray(a['symbols']) ? (a['symbols'] as string[]) : undefined,
          dependsOn: Array.isArray(a['dependsOn']) ? (a['dependsOn'] as string[]) : undefined,
          derivesFrom: Array.isArray(a['derivesFrom'])
            ? (a['derivesFrom'] as string[])
            : undefined,
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
          status: a['status'] !== undefined ? String(a['status']) : undefined,
        });
        return textResult(`Updated ${path.relative(projectDir, filePath)}`);
      } catch (err) {
        return textResult(`Error: ${(err as Error).message}`);
      }
    }

    if (name === 'get_unspecced_symbols') {
      const filePath = a['file_path'] !== undefined ? String(a['file_path']) : undefined;
      const { db, conn } = await openDatabase(projectDir, true);
      try {
        let cypher =
          'MATCH (c:CodeSymbol) WHERE NOT EXISTS { MATCH (c)-[:IMPLEMENTS]->() }';
        if (filePath !== undefined) {
          const safe = filePath.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
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
      const { db, conn } = await openDatabase(projectDir);
      try {
        const stats = await indexSpecs(conn, specs);
        const lines = [
          `✓ Reindexed: ${stats.specs} specs, ${stats.symbols} symbols, ${stats.implements} IMPLEMENTS edges`,
        ];
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

    if (name === 'search_symbols') {
      const limit = typeof a['limit'] === 'number' ? (a['limit'] as number) : 20;
      const kind = typeof a['kind'] === 'string' ? (a['kind'] as string) : undefined;
      return handleSearchSymbols(projectDir, String(a['query'] ?? ''), limit, kind);
    }

    return textResult(`Unknown tool: ${name}`);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
