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

    return textResult(`Unknown tool: ${name}`);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
