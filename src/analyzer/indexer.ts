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
  containsEdgesCreated: number;
  fileNodesCreated: number;
  parseErrors: number;
  unresolvedSymbols: number;
  driftWarnings: string[];
  renameSuggestions: RenameSuggestion[];
}

function esc(value: string | null | undefined): string {
  if (value == null) return 'NULL';
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function fileKind(ext: string): 'source' | 'config' | 'other' {
  if (['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.php', '.py', '.rb', '.go', '.java', '.cs', '.cpp', '.c', '.rs'].includes(ext))
    return 'source';
  if (['.json', '.yaml', '.yml', '.toml', '.xml', '.env', '.ini', '.cfg', '.conf'].includes(ext))
    return 'config';
  return 'other';
}

async function upsertFile(conn: Connection, id: string, ext: string): Promise<void> {
  await conn.query(`MATCH (f:File {id: ${esc(id)}}) DETACH DELETE f`);
  const result = await conn.query(`CREATE (:File {
    id: ${esc(id)},
    path: ${esc(id)},
    ext: ${esc(ext)},
    kind: ${esc(fileKind(ext))}
  })`);
  if (result && !Array.isArray(result)) result.close();
}

async function upsertCodeSymbol(conn: Connection, symbol: CodeSymbol): Promise<void> {
  await conn.query(`MATCH (c:CodeSymbol {id: ${esc(symbol.id)}}) DETACH DELETE c`);
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

async function linkContainsFileToSymbol(conn: Connection, fileId: string, symbolId: string): Promise<void> {
  const result = await conn.query(
    `MATCH (f:File {id: ${esc(fileId)}}), (c:CodeSymbol {id: ${esc(symbolId)}})
     CREATE (f)-[:CONTAINS]->(c)`,
  );
  if (result && !Array.isArray(result)) result.close();
}

async function linkContainsSymbolToSymbol(conn: Connection, parentId: string, childId: string): Promise<void> {
  const result = await conn.query(
    `MATCH (p:CodeSymbol {id: ${esc(parentId)}}), (c:CodeSymbol {id: ${esc(childId)}})
     CREATE (p)-[:CONTAINS]->(c)`,
  );
  if (result && !Array.isArray(result)) result.close();
}

/**
 * Resolve a targetName (e.g. "SomeClass" or "SomeClass.method") against the
 * full set of extracted symbols. Tries exact FQN match first, then suffix match
 * for namespaced PHP classes (e.g. "Product" matches "App.Models.Product").
 */
function resolveCallTarget(targetName: string, symbols: CodeSymbol[]): CodeSymbol | null {
  const exact = symbols.find((s) => s.fqn === targetName);
  if (exact) return exact;
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

async function linkFileImplementation(
  conn: Connection,
  fileId: string,
  specId: string,
): Promise<void> {
  const result = await conn.query(
    `MATCH (f:File {id: ${esc(fileId)}}), (s:Spec {id: ${esc(specId)}})
     CREATE (f)-[:IMPLEMENTS {confidence: 1.0}]->(s)`,
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
    containsEdgesCreated: 0,
    fileNodesCreated: 0,
    parseErrors: 0,
    unresolvedSymbols: 0,
    driftWarnings: [],
    renameSuggestions: [],
  };

  // Separate file-type implements from code-symbol implements so the resolver
  // never sees file paths (which would incorrectly appear as unresolved drift).
  const fileImplsBySpecId = new Map<string, string[]>();
  for (const spec of specs) {
    for (const impl of spec.frontmatter.implements ?? []) {
      if (impl.type === 'file') {
        const list = fileImplsBySpecId.get(spec.frontmatter.id) ?? [];
        list.push(impl.symbol);
        fileImplsBySpecId.set(spec.frontmatter.id, list);
      }
    }
  }
  // Specs visible to the code resolver have file-type entries stripped.
  const specsForResolver: ParsedSpec[] = specs.map((spec) => ({
    ...spec,
    frontmatter: {
      ...spec.frontmatter,
      implements: (spec.frontmatter.implements ?? []).filter((i) => i.type !== 'file'),
    },
  }));

  const extensions = getExtensionsForLanguages(config.analyze.languages);
  if (extensions.length === 0) {
    return stats;
  }

  const includeDirs = config.analyze.include.map((d) => path.resolve(projectDir, d));
  const files = walkFiles(includeDirs, extensions, config.analyze.exclude);

  const allSymbols: CodeSymbol[] = [];
  const allCallRefs: CallRef[] = [];
  // Track which files were scanned (relPath → ext)
  const scannedFiles = new Map<string, string>();

  for (const filePath of files) {
    stats.filesScanned++;
    const ext = path.extname(filePath).toLowerCase();
    const parser = getParserForExtension(ext);
    if (!parser) continue;

    const relPath = path.relative(projectDir, filePath);
    scannedFiles.set(relPath, ext);

    try {
      const source = fs.readFileSync(filePath, 'utf-8');
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

  // Upsert File nodes for every scanned source file.
  for (const [relPath, ext] of scannedFiles) {
    await upsertFile(conn, relPath, ext);
    stats.fileNodesCreated++;
  }

  // Upsert all discovered CodeSymbol nodes.
  for (const symbol of allSymbols) {
    await upsertCodeSymbol(conn, symbol);
  }

  // Build CONTAINS edges.
  // Group symbols by file so we can resolve parent FQNs within the same file.
  const symbolsByFile = new Map<string, CodeSymbol[]>();
  for (const sym of allSymbols) {
    const list = symbolsByFile.get(sym.filePath) ?? [];
    list.push(sym);
    symbolsByFile.set(sym.filePath, list);
  }
  for (const [filePath, fileSymbols] of symbolsByFile) {
    // Build a lookup: fqn → symbol (within this file)
    const fqnMap = new Map(fileSymbols.map((s) => [s.fqn, s]));
    for (const sym of fileSymbols) {
      const dotIdx = sym.fqn.lastIndexOf('.');
      if (dotIdx !== -1) {
        const parentFqn = sym.fqn.slice(0, dotIdx);
        const parent = fqnMap.get(parentFqn);
        if (parent) {
          await linkContainsSymbolToSymbol(conn, parent.id, sym.id);
          stats.containsEdgesCreated++;
          continue;
        }
      }
      // No parent symbol found — link directly from the File node.
      await linkContainsFileToSymbol(conn, filePath, sym.id);
      stats.containsEdgesCreated++;
    }
  }

  // Resolve and create CodeSymbol IMPLEMENTS edges (file-type entries already stripped).
  const links = resolveImplementations(allSymbols, specsForResolver);
  for (const link of links) {
    await linkImplementation(conn, link.symbolId, link.specId, link.confidence);
    stats.implementationsLinked++;
  }

  // Resolve call refs and create CALLS edges.
  for (const ref of allCallRefs) {
    const target = resolveCallTarget(ref.targetName, allSymbols);
    if (target) {
      await linkCall(conn, ref.callerSymbolId, target.id, ref.kind);
      stats.callEdgesCreated++;
    }
  }

  // Handle file-type implements: create File nodes + IMPLEMENTS edges, detect drift.
  for (const [specId, filePaths] of fileImplsBySpecId) {
    for (const fileId of filePaths) {
      const absPath = path.resolve(projectDir, fileId);
      if (!fs.existsSync(absPath)) {
        // File not on disk → drift
        stats.driftWarnings.push(`${specId}: ${fileId} not found`);
        stats.unresolvedSymbols++;
        continue;
      }
      const ext = path.extname(fileId).toLowerCase();
      // Upsert File node if not already created by the source-file pass.
      if (!scannedFiles.has(fileId)) {
        await upsertFile(conn, fileId, ext);
        stats.fileNodesCreated++;
      }
      await linkFileImplementation(conn, fileId, specId);
      stats.implementationsLinked++;
    }
  }

  // Detect drift for code-symbol implements entries.
  const unresolved = findUnresolvedImplementations(allSymbols, specsForResolver);
  stats.unresolvedSymbols += unresolved.length;
  stats.driftWarnings.push(
    ...unresolved.map((u) => `${u.specId}: ${u.symbolId} not found`),
  );
  stats.renameSuggestions = suggestRenames(unresolved, allSymbols);

  return stats;
}
