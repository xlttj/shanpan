import fs from 'node:fs';
import path from 'node:path';
import type { Connection } from '@ladybugdb/core';
import type { SpecGraphConfig } from '../types/config.js';
import type { CodeSymbol, CallRef } from '../types/code.js';
import type { ParsedSpec } from '../types/spec.js';
import { walkFiles } from './walker.js';
import { getParserForExtension, getExtensionsForLanguages } from './languages/index.js';
import { resolveImplementations, findUnresolvedImplementations, suggestRenames } from './resolver.js';
import type { RenameSuggestion } from './resolver.js';

export interface AnalysisStats {
  filesScanned: number;
  symbolsFound: number;
  implementationsLinked: number;
  callEdgesCreated: number;
  parseErrors: number;
  unresolvedSymbols: number;
  driftWarnings: string[];
  renameSuggestions: RenameSuggestion[];
}

function esc(value: string | null | undefined): string {
  if (value == null) return 'NULL';
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

async function upsertCodeSymbol(conn: Connection, symbol: CodeSymbol): Promise<void> {
  // Use MERGE-like pattern: delete existing then create
  await conn.query(
    `MATCH (c:CodeSymbol {id: ${esc(symbol.id)}}) DETACH DELETE c`,
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

/**
 * Resolve a targetName (e.g. "SomeClass" or "SomeClass.method") against the
 * full set of extracted symbols. Tries exact FQN match first, then suffix match
 * for namespaced PHP classes (e.g. "Product" matches "App.Models.Product").
 */
function resolveCallTarget(targetName: string, symbols: CodeSymbol[]): CodeSymbol | null {
  // Exact match
  const exact = symbols.find((s) => s.fqn === targetName);
  if (exact) return exact;
  // Suffix match — handles namespace-qualified FQNs
  const suffix = `.${targetName}`;
  return symbols.find((s) => s.fqn.endsWith(suffix)) ?? null;
}

async function linkCall(
  conn: Connection,
  callerSymbolId: string,
  targetSymbolId: string,
  callKind: string,
): Promise<void> {
  const result = await conn.query(
    `MATCH (caller:CodeSymbol {id: ${esc(callerSymbolId)}}), (target:CodeSymbol {id: ${esc(targetSymbolId)}})
     CREATE (caller)-[:CALLS {call_kind: ${esc(callKind)}}]->(target)`,
  );
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
    callEdgesCreated: 0,
    parseErrors: 0,
    unresolvedSymbols: 0,
    driftWarnings: [],
    renameSuggestions: [],
  };

  const extensions = getExtensionsForLanguages(config.analyze.languages);
  if (extensions.length === 0) {
    return stats;
  }

  const includeDirs = config.analyze.include.map((d) => path.resolve(projectDir, d));
  const files = walkFiles(includeDirs, extensions, config.analyze.exclude);

  const allSymbols: CodeSymbol[] = [];
  const allCallRefs: CallRef[] = [];

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

      if (parser.extractCallRefs) {
        const callRefs = parser.extractCallRefs(relPath, source, symbols);
        allCallRefs.push(...callRefs);
      }
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

  // Resolve call refs and create CALLS edges
  for (const ref of allCallRefs) {
    const target = resolveCallTarget(ref.targetName, allSymbols);
    if (target) {
      await linkCall(conn, ref.callerSymbolId, target.id, ref.kind);
      stats.callEdgesCreated++;
    }
  }

  // Detect drift: spec implements entries with no matching symbol
  const unresolved = findUnresolvedImplementations(allSymbols, specs);
  stats.unresolvedSymbols = unresolved.length;
  stats.driftWarnings = unresolved.map(
    (u) => `${u.specId}: ${u.symbolId} not found`,
  );
  stats.renameSuggestions = suggestRenames(unresolved, allSymbols);

  return stats;
}
