import fs from 'node:fs';
import path from 'node:path';
import type { Connection } from '@ladybugdb/core';
import type { SpecGraphConfig } from '../types/config.js';
import type { CodeSymbol } from '../types/code.js';
import type { ParsedSpec } from '../types/spec.js';
import { walkFiles } from './walker.js';
import { getParserForExtension, getExtensionsForLanguages } from './languages/index.js';
import { resolveImplementations, findUnresolvedImplementations } from './resolver.js';

export interface AnalysisStats {
  filesScanned: number;
  symbolsFound: number;
  implementationsLinked: number;
  parseErrors: number;
  unresolvedSymbols: number;
  driftWarnings: string[];
}

function esc(value: string | null | undefined): string {
  if (value == null) return 'NULL';
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

async function upsertCodeSymbol(conn: Connection, symbol: CodeSymbol): Promise<void> {
  // Use MERGE-like pattern: delete existing then create
  await conn.query(
    `MATCH (c:CodeSymbol {id: ${esc(symbol.id)}}) DELETE c`,
  );
  const result = await conn.query(`CREATE (:CodeSymbol {
    id: ${esc(symbol.id)},
    fqn: ${esc(symbol.fqn)},
    symbol_type: ${esc(symbol.kind)},
    file_path: ${esc(symbol.filePath)},
    line_start: ${symbol.lineStart},
    line_end: ${symbol.lineEnd},
    language: ${esc(symbol.language)}
  })`);
  if (result && !Array.isArray(result)) result.close();
}

async function linkImplementation(
  conn: Connection,
  symbolId: string,
  specId: string,
  confidence: number,
): Promise<void> {
  const result = await conn.query(
    `MATCH (c:CodeSymbol {id: ${esc(symbolId)}}), (s:Spec {id: ${esc(specId)}})
     CREATE (c)-[:IMPLEMENTS {confidence: ${confidence}}]->(s)`,
  );
  if (result && !Array.isArray(result)) result.close();
}

export async function analyzeAndIndex(
  conn: Connection,
  projectDir: string,
  specs: ParsedSpec[],
  config: SpecGraphConfig,
): Promise<AnalysisStats> {
  const stats: AnalysisStats = {
    filesScanned: 0,
    symbolsFound: 0,
    implementationsLinked: 0,
    parseErrors: 0,
    unresolvedSymbols: 0,
    driftWarnings: [],
  };

  const extensions = getExtensionsForLanguages(config.analyze.languages);
  if (extensions.length === 0) {
    return stats;
  }

  const includeDirs = config.analyze.include.map((d) => path.resolve(projectDir, d));
  const files = walkFiles(includeDirs, extensions, config.analyze.exclude);

  const allSymbols: CodeSymbol[] = [];

  for (const filePath of files) {
    stats.filesScanned++;
    const ext = path.extname(filePath).toLowerCase();
    const parser = getParserForExtension(ext);
    if (!parser) continue;

    try {
      const source = fs.readFileSync(filePath, 'utf-8');
      const relPath = path.relative(projectDir, filePath);
      const symbols = parser.extractSymbols(relPath, source);
      allSymbols.push(...symbols);
      stats.symbolsFound += symbols.length;
    } catch {
      stats.parseErrors++;
    }
  }

  // Upsert all discovered CodeSymbol nodes
  for (const symbol of allSymbols) {
    await upsertCodeSymbol(conn, symbol);
  }

  // Resolve and create IMPLEMENTS edges
  const links = resolveImplementations(allSymbols, specs);
  for (const link of links) {
    await linkImplementation(conn, link.symbolId, link.specId, link.confidence);
    stats.implementationsLinked++;
  }

  // Detect drift: spec implements entries with no matching symbol
  const unresolved = findUnresolvedImplementations(allSymbols, specs);
  stats.unresolvedSymbols = unresolved.length;
  stats.driftWarnings = unresolved.map(
    (u) => `${u.specId}: ${u.symbolId} not found`,
  );

  return stats;
}
