import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import type { Connection } from '@ladybugdb/core';
import type { ShanpanConfig } from '../types/config.js';
import type { CodeSymbol, CallRef, InheritanceEdge } from '../types/code.js';
import { walkFiles } from './walker.js';
import { getParserForExtension, getExtensionsForLanguages } from './languages/index.js';
import { queryAll } from '../core/db.js';
import type { ParseTask, ParseResult } from './parse-worker.js';

export interface AnalysisStats {
  filesScanned: number;
  symbolsFound: number;
  callEdgesCreated: number;
  containsEdgesCreated: number;
  fileNodesCreated: number;
  parseErrors: number;
}

const BATCH_SIZE = 200;

function esc(value: string | null | undefined): string {
  if (value == null) return 'NULL';
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function fileKind(ext: string): 'source' | 'config' | 'other' {
  if (
    ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.php', '.py', '.rb', '.go', '.java', '.cs', '.cpp', '.c', '.rs'].includes(ext)
  )
    return 'source';
  if (['.json', '.yaml', '.yml', '.toml', '.xml', '.env', '.ini', '.cfg', '.conf'].includes(ext))
    return 'config';
  return 'other';
}

/** Merge inheritance edges into a `child name → parent names` map. */
function buildInheritanceMap(edges: Iterable<InheritanceEdge>): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const e of edges) {
    const cur = map.get(e.child) ?? [];
    cur.push(...e.parents);
    map.set(e.child, cur);
  }
  return map;
}

/**
 * Find `Ancestor.method` by walking the class hierarchy strictly above
 * `className` (its extends/traits, transitively) — never `className` itself.
 * This is how `parent::method()` resolves, and the ancestor step of a normal
 * `$this->method()`.
 */
function resolveInAncestors(
  className: string,
  method: string,
  byFqn: Map<string, CodeSymbol>,
  inheritanceMap: Map<string, string[]>,
): CodeSymbol | null {
  const seen = new Set<string>([className]);
  const queue = [...(inheritanceMap.get(className) ?? [])];
  while (queue.length > 0) {
    const ancestor = queue.shift() as string;
    if (seen.has(ancestor)) continue;
    seen.add(ancestor);
    const hit = byFqn.get(`${ancestor}.${method}`);
    if (hit) return hit;
    for (const p of inheritanceMap.get(ancestor) ?? []) if (!seen.has(p)) queue.push(p);
  }
  return null;
}

/** Class fqn from a symbol id `filePath::Class.method` → `Class` (null if none). */
function classOfSymbolId(id: string): string | null {
  const sep = id.indexOf('::');
  const fqn = sep !== -1 ? id.slice(sep + 2) : id;
  const dot = fqn.lastIndexOf('.');
  return dot !== -1 ? fqn.slice(0, dot) : null;
}

/**
 * Resolve a call target to a symbol. Order matters:
 *   1. exact fqn — a same-class or already-typed call;
 *   2. walk the caller class's ancestors (extends + traits) for `Ancestor.method`
 *      — this is how `$this->clear()` finds `ImageMemoryCache.clear`, and it is
 *      precise, unlike the name-suffix guess;
 *   3. name-suffix, last resort, kept so languages without inheritance data
 *      (TypeScript, Python for now) still resolve `this.inherited()`.
 */
function resolveCallTarget(
  targetName: string,
  byFqn: Map<string, CodeSymbol>,
  allSymbols: CodeSymbol[],
  inheritanceMap: Map<string, string[]>,
): CodeSymbol | null {
  const exact = byFqn.get(targetName);
  if (exact) return exact;

  const dot = targetName.lastIndexOf('.');
  if (dot !== -1) {
    const ancestor = resolveInAncestors(targetName.slice(0, dot), targetName.slice(dot + 1), byFqn, inheritanceMap);
    if (ancestor) return ancestor;
  }

  const suffix = `.${targetName}`;
  return allSymbols.find((s) => s.fqn.endsWith(suffix)) ?? null;
}

/** First symbol seen per fqn, matching the old find-first resolution order. */
function indexByFqn(symbols: CodeSymbol[]): Map<string, CodeSymbol> {
  const byFqn = new Map<string, CodeSymbol>();
  for (const s of symbols) if (!byFqn.has(s.fqn)) byFqn.set(s.fqn, s);
  return byFqn;
}

async function runQuery(conn: Connection, cypher: string): Promise<void> {
  const result = await conn.query(cypher);
  if (result && !Array.isArray(result)) result.close();
}

async function batchQuery(
  conn: Connection,
  items: string[],
  buildQuery: (list: string) => string,
): Promise<void> {
  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const batch = items.slice(i, i + BATCH_SIZE);
    if (batch.length === 0) continue;
    await runQuery(conn, buildQuery(batch.join(', ')));
  }
}

function fileRow(id: string, ext: string): string {
  return `{id: ${esc(id)}, path: ${esc(id)}, ext: ${esc(ext)}, kind: ${esc(fileKind(ext))}}`;
}

function symbolRow(sym: CodeSymbol): string {
  return `{id: ${esc(sym.id)}, fqn: ${esc(sym.fqn)}, symbol_type: ${esc(sym.kind)}, file_path: ${esc(sym.filePath)}, line_start: ${sym.lineStart}, line_end: ${sym.lineEnd}, language: ${esc(sym.language)}}`;
}

async function insertFiles(
  conn: Connection,
  files: Map<string, string>,
  onProgress?: (n: number, total: number) => void,
  offset = 0,
  total = 0,
): Promise<number> {
  const rows = [...files.entries()].map(([id, ext]) => fileRow(id, ext));
  let inserted = 0;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    await runQuery(
      conn,
      `UNWIND [${batch.join(', ')}] AS row CREATE (:File {id: row.id, path: row.path, ext: row.ext, kind: row.kind})`,
    );
    inserted += batch.length;
    onProgress?.(offset + inserted, total);
  }
  return inserted;
}

/**
 * Collapse symbols sharing an id (same file::fqn) to one, keeping the last.
 * The CodeSymbol id is a primary key, so a duplicate aborts the whole insert —
 * and duplicates are normal in real code: @overload stubs in Python, function
 * overload signatures and declaration merging in TypeScript, conditional
 * redefinitions under `if TYPE_CHECKING`. Keeping the last favours the actual
 * implementation, which follows its stubs.
 */
function dedupeById(symbols: CodeSymbol[]): CodeSymbol[] {
  const byId = new Map<string, CodeSymbol>();
  for (const s of symbols) byId.set(s.id, s);
  return [...byId.values()];
}

async function insertSymbols(
  conn: Connection,
  symbols: CodeSymbol[],
  onProgress?: (n: number, total: number) => void,
  offset = 0,
  total = 0,
): Promise<void> {
  const rows = symbols.map(symbolRow);
  let inserted = 0;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    await runQuery(
      conn,
      `UNWIND [${batch.join(', ')}] AS row CREATE (:CodeSymbol {id: row.id, fqn: row.fqn, symbol_type: row.symbol_type, file_path: row.file_path, line_start: row.line_start, line_end: row.line_end, language: row.language})`,
    );
    inserted += batch.length;
    onProgress?.(offset + inserted, total);
  }
}

function buildContainsPairs(
  symbols: CodeSymbol[],
): { fileToSymbol: [string, string][]; symbolToSymbol: [string, string][] } {
  const fileToSymbol: [string, string][] = [];
  const symbolToSymbol: [string, string][] = [];

  const byFile = new Map<string, CodeSymbol[]>();
  for (const sym of symbols) {
    const list = byFile.get(sym.filePath) ?? [];
    list.push(sym);
    byFile.set(sym.filePath, list);
  }

  for (const fileSymbols of byFile.values()) {
    const fqnMap = new Map(fileSymbols.map((s) => [s.fqn, s]));
    for (const sym of fileSymbols) {
      const dotIdx = sym.fqn.lastIndexOf('.');
      if (dotIdx !== -1) {
        const parentFqn = sym.fqn.slice(0, dotIdx);
        const parent = fqnMap.get(parentFqn);
        if (parent) {
          symbolToSymbol.push([parent.id, sym.id]);
          continue;
        }
      }
      fileToSymbol.push([sym.filePath, sym.id]);
    }
  }

  return { fileToSymbol, symbolToSymbol };
}

async function insertContainsEdges(
  conn: Connection,
  pairs: { fileToSymbol: [string, string][]; symbolToSymbol: [string, string][] },
): Promise<number> {
  const f2s = pairs.fileToSymbol.map(([f, s]) => `[${esc(f)}, ${esc(s)}]`);
  const s2s = pairs.symbolToSymbol.map(([p, c]) => `[${esc(p)}, ${esc(c)}]`);

  await batchQuery(
    conn,
    f2s,
    (list) =>
      `UNWIND [${list}] AS e MATCH (f:File {id: e[1]}), (c:CodeSymbol {id: e[2]}) CREATE (f)-[:CONTAINS]->(c)`,
  );
  await batchQuery(
    conn,
    s2s,
    (list) =>
      `UNWIND [${list}] AS e MATCH (p:CodeSymbol {id: e[1]}), (c:CodeSymbol {id: e[2]}) CREATE (p)-[:CONTAINS]->(c)`,
  );

  return pairs.fileToSymbol.length + pairs.symbolToSymbol.length;
}

async function insertCallsEdges(
  conn: Connection,
  callRefs: CallRef[],
  allSymbols: CodeSymbol[],
  inheritanceMap: Map<string, string[]>,
): Promise<number> {
  const byFqn = indexByFqn(allSymbols);
  const resolved: [string, string, string][] = [];
  for (const ref of callRefs) {
    let target: CodeSymbol | null;
    if (ref.targetName.startsWith('parent::')) {
      // parent::method() resolves strictly in the caller class's ancestors,
      // never its own class — even when this class overrides the method.
      const callerClass = classOfSymbolId(ref.callerSymbolId);
      target = callerClass
        ? resolveInAncestors(callerClass, ref.targetName.slice('parent::'.length), byFqn, inheritanceMap)
        : null;
    } else {
      target = resolveCallTarget(ref.targetName, byFqn, allSymbols, inheritanceMap);
    }
    if (target) resolved.push([ref.callerSymbolId, target.id, ref.kind]);
  }

  const rows = resolved.map(([caller, target, kind]) => `[${esc(caller)}, ${esc(target)}, ${esc(kind)}]`);
  await batchQuery(
    conn,
    rows,
    (list) =>
      `UNWIND [${list}] AS e MATCH (caller:CodeSymbol {id: e[1]}), (target:CodeSymbol {id: e[2]}) CREATE (caller)-[:CALLS {call_kind: e[3]}]->(target)`,
  );

  return resolved.length;
}

/**
 * Create EXTENDS edges from each child class symbol to its parent class/trait
 * symbol. A parent that has no symbol in the graph (e.g. a vendor base class)
 * is skipped — the inheritance *map* still carries the name for resolution, but
 * an edge needs both endpoints.
 */
async function insertExtendsEdges(
  conn: Connection,
  inheritance: InheritanceEdge[],
  allSymbols: CodeSymbol[],
): Promise<number> {
  const byFqn = indexByFqn(allSymbols);
  const pairs: [string, string][] = [];
  for (const e of inheritance) {
    const childId = `${e.filePath}::${e.child}`;
    for (const parent of e.parents) {
      const parentSym = byFqn.get(parent);
      if (parentSym) pairs.push([childId, parentSym.id]);
    }
  }
  const rows = pairs.map(([c, p]) => `[${esc(c)}, ${esc(p)}]`);
  await batchQuery(
    conn,
    rows,
    (list) =>
      `UNWIND [${list}] AS e MATCH (c:CodeSymbol {id: e[1]}), (p:CodeSymbol {id: e[2]}) CREATE (c)-[:EXTENDS]->(p)`,
  );
  return pairs.length;
}

const WORKER_COUNT = Math.max(1, Math.min(os.cpus().length, 8));

type ParseBatch = { allSymbols: CodeSymbol[]; allCallRefs: CallRef[]; allInheritance: InheritanceEdge[]; parseErrors: number; scannedFiles: Map<string, string> };

function parseSerial(
  files: { absPath: string; relPath: string; ext: string }[],
  onProgress?: (n: number, total: number) => void,
): ParseBatch {
  const allSymbols: CodeSymbol[] = [];
  const allCallRefs: CallRef[] = [];
  const allInheritance: InheritanceEdge[] = [];
  const scannedFiles = new Map<string, string>();
  let parseErrors = 0;
  for (let i = 0; i < files.length; i++) {
    const { absPath, relPath, ext } = files[i];
    const parser = getParserForExtension(ext);
    if (!parser) { onProgress?.(i + 1, files.length); continue; }
    scannedFiles.set(relPath, ext);
    try {
      const source = fs.readFileSync(absPath, 'utf-8');
      const symbols = parser.extractSymbols(relPath, source);
      allSymbols.push(...symbols);
      if (parser.extractCallRefs) allCallRefs.push(...parser.extractCallRefs(relPath, source, symbols));
      if (parser.extractInheritance) allInheritance.push(...parser.extractInheritance(relPath, source));
    } catch {
      parseErrors++;
    }
    onProgress?.(i + 1, files.length);
  }
  return { allSymbols, allCallRefs, allInheritance, parseErrors, scannedFiles };
}

// Resolve the worker script path. Returns null if not available (e.g. unbuilt dev tree).
function resolveWorkerScript(): string | null {
  if (process.env['SHANPAN_WORKERS'] === '0') return null;
  try {
    const thisFile = fileURLToPath(import.meta.url);
    // dist/cli/index.js → dist/analyzer/parse-worker.js
    const distAnalyzer = path.resolve(path.dirname(thisFile), '..', 'analyzer', 'parse-worker.js');
    if (fs.existsSync(distAnalyzer)) return distAnalyzer;
    // Same directory (when indexer is also in dist/analyzer/)
    const sameDir = path.resolve(path.dirname(thisFile), 'parse-worker.js');
    if (fs.existsSync(sameDir)) return sameDir;
  } catch {
    // ignore
  }
  return null;
}

async function parseWithWorkers(
  files: { absPath: string; relPath: string; ext: string }[],
  onProgress?: (n: number, total: number) => void,
): Promise<ParseBatch> {
  if (files.length === 0) return { allSymbols: [], allCallRefs: [], allInheritance: [], parseErrors: 0, scannedFiles: new Map() };

  const workerScript = resolveWorkerScript();
  if (!workerScript) return parseSerial(files, onProgress);

  const allSymbols: CodeSymbol[] = [];
  const allCallRefs: CallRef[] = [];
  const allInheritance: InheritanceEdge[] = [];
  const scannedFiles = new Map<string, string>();
  let parseErrors = 0;
  let completed = 0;

  const workerUrl = new URL(`file://${workerScript}`);
  const numWorkers = Math.min(WORKER_COUNT, files.length);

  return new Promise((resolve, reject) => {
    const workers: Worker[] = [];
    const queue = [...files];
    let pending = 0;

    const dispatch = (worker: Worker) => {
      const task = queue.shift();
      if (!task) return;
      pending++;
      worker.postMessage({ relPath: task.relPath, absPath: task.absPath, ext: task.ext } satisfies ParseTask);
    };

    const onMessage = (worker: Worker) => (result: ParseResult) => {
      pending--;
      completed++;
      scannedFiles.set(result.relPath, path.extname(result.relPath).toLowerCase());
      if (result.error) {
        parseErrors++;
      } else {
        allSymbols.push(...result.symbols);
        allCallRefs.push(...result.callRefs);
        allInheritance.push(...result.inheritance);
      }
      onProgress?.(completed, files.length);
      if (queue.length > 0) {
        dispatch(worker);
      } else if (pending === 0) {
        for (const w of workers) void w.terminate();
        resolve({ allSymbols, allCallRefs, allInheritance, parseErrors, scannedFiles });
      }
    };

    for (let i = 0; i < numWorkers; i++) {
      try {
        const worker = new Worker(workerUrl);
        worker.on('message', onMessage(worker));
        worker.on('error', (err) => {
          for (const w of workers) void w.terminate();
          reject(err);
        });
        workers.push(worker);
        dispatch(worker);
      } catch {
        break;
      }
    }

    if (workers.length === 0) {
      resolve(parseSerial(files, onProgress));
    }
  });
}

/** Full rebuild — re-scans all files and rewrites the entire code graph. */
export async function analyzeAndIndex(
  conn: Connection,
  projectDir: string,
  config: ShanpanConfig,
  onProgress?: (phase: 'scan' | 'index', n: number, total: number) => void,
): Promise<AnalysisStats> {
  const stats: AnalysisStats = {
    filesScanned: 0,
    symbolsFound: 0,
    callEdgesCreated: 0,
    containsEdgesCreated: 0,
    fileNodesCreated: 0,
    parseErrors: 0,
  };

  const extensions = getExtensionsForLanguages(config.analyze.languages);
  if (extensions.length === 0) return stats;

  const includeDirs = config.analyze.include.map((d) => path.resolve(projectDir, d));
  const files = walkFiles(includeDirs, extensions, config.analyze.exclude);
  const totalFiles = files.length;

  // Phase 1 — parse (parallel workers when available)
  const fileTasks = files.flatMap((filePath) => {
    const ext = path.extname(filePath).toLowerCase();
    if (!getParserForExtension(ext)) return [];
    return [{ absPath: filePath, relPath: path.relative(projectDir, filePath), ext }];
  });
  stats.filesScanned = files.length;

  const {
    allSymbols,
    allCallRefs,
    allInheritance,
    parseErrors: workerParseErrors,
    scannedFiles,
  } = await parseWithWorkers(fileTasks, onProgress ? (n, t) => onProgress('scan', n, t) : undefined);
  const symbols = dedupeById(allSymbols);
  stats.symbolsFound = symbols.length;
  stats.parseErrors = workerParseErrors;

  // Phase 2 — clear and write
  await runQuery(conn, 'MATCH (c:CodeSymbol) DETACH DELETE c');
  await runQuery(conn, 'MATCH (f:File) DETACH DELETE f');

  const totalNodes = scannedFiles.size + symbols.length;

  stats.fileNodesCreated = await insertFiles(conn, scannedFiles, onProgress ? (n, t) => onProgress('index', n, t) : undefined, 0, totalNodes);
  await insertSymbols(conn, symbols, onProgress ? (n, t) => onProgress('index', n, t) : undefined, scannedFiles.size, totalNodes);

  const containsPairs = buildContainsPairs(symbols);
  stats.containsEdgesCreated = await insertContainsEdges(conn, containsPairs);

  await insertExtendsEdges(conn, allInheritance, symbols);
  const inheritanceMap = buildInheritanceMap(allInheritance);
  stats.callEdgesCreated = await insertCallsEdges(conn, allCallRefs, symbols, inheritanceMap);

  return stats;
}

/** Incremental rebuild — only re-processes files whose mtime changed. */
export async function analyzeAndIndexIncremental(
  conn: Connection,
  projectDir: string,
  config: ShanpanConfig,
  changedPaths: Set<string>,
  deletedPaths: Set<string>,
  onProgress?: (phase: 'scan' | 'index', n: number, total: number) => void,
): Promise<AnalysisStats> {
  const stats: AnalysisStats = {
    filesScanned: 0,
    symbolsFound: 0,
    callEdgesCreated: 0,
    containsEdgesCreated: 0,
    fileNodesCreated: 0,
    parseErrors: 0,
  };

  const toDelete = new Set([...changedPaths, ...deletedPaths]);
  for (const relPath of toDelete) {
    await runQuery(conn, `MATCH (c:CodeSymbol {file_path: ${esc(relPath)}}) DETACH DELETE c`);
    await runQuery(conn, `MATCH (f:File {id: ${esc(relPath)}}) DETACH DELETE f`);
  }

  // Parse only changed files (parallel workers when available)
  const fileTasks = [...changedPaths].flatMap((relPath) => {
    const ext = path.extname(relPath).toLowerCase();
    if (!getParserForExtension(ext)) return [];
    return [{ absPath: path.resolve(projectDir, relPath), relPath, ext }];
  });
  stats.filesScanned = changedPaths.size;

  const {
    allSymbols: newSymbols,
    allCallRefs: newCallRefs,
    allInheritance: newInheritance,
    parseErrors: workerParseErrors,
    scannedFiles: newFiles,
  } = await parseWithWorkers(fileTasks, onProgress ? (n, t) => onProgress('scan', n, t) : undefined);
  const symbols = dedupeById(newSymbols);
  stats.symbolsFound = symbols.length;
  stats.parseErrors = workerParseErrors;

  const totalNodes = newFiles.size + symbols.length;
  if (totalNodes > 0) {
    stats.fileNodesCreated = await insertFiles(conn, newFiles, onProgress ? (n, t) => onProgress('index', n, t) : undefined, 0, totalNodes);
    await insertSymbols(conn, symbols, onProgress ? (n, t) => onProgress('index', n, t) : undefined, newFiles.size, totalNodes);

    const containsPairs = buildContainsPairs(symbols);
    stats.containsEdgesCreated = await insertContainsEdges(conn, containsPairs);

    // Query existing symbols for cross-file CALLS resolution
    const { rows } = await queryAll(
      conn,
      'MATCH (c:CodeSymbol) RETURN c.id AS id, c.fqn AS fqn, c.file_path AS filePath, c.symbol_type AS kind, c.line_start AS lineStart, c.line_end AS lineEnd, c.language AS language',
    );
    const existingSymbols: CodeSymbol[] = rows.map((r) => ({
      id: String(r['id']),
      fqn: String(r['fqn']),
      filePath: String(r['filePath']),
      kind: String(r['kind']) as CodeSymbol['kind'],
      lineStart: Number(r['lineStart']),
      lineEnd: Number(r['lineEnd']),
      language: String(r['language']),
    }));
    const allCurrentSymbols = [...existingSymbols, ...symbols];

    // Inheritance for the changed files' classes; unchanged files' EXTENDS were
    // left in the graph. Rebuild the full map from both so $this->method()
    // resolves through parents defined in files this run did not touch.
    await insertExtendsEdges(conn, newInheritance, allCurrentSymbols);
    const { rows: extRows } = await queryAll(
      conn,
      'MATCH (c:CodeSymbol)-[:EXTENDS]->(p:CodeSymbol) RETURN c.fqn AS child, p.fqn AS parent',
    );
    const inheritanceMap = buildInheritanceMap([
      ...extRows.map((r) => ({ child: String(r['child']), parents: [String(r['parent'])], filePath: '' })),
      ...newInheritance,
    ]);

    stats.callEdgesCreated = await insertCallsEdges(conn, newCallRefs, allCurrentSymbols, inheritanceMap);
  }

  return stats;
}
