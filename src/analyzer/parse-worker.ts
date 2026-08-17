import { workerData, parentPort } from 'node:worker_threads';
import { TypeScriptParser } from './languages/typescript.js';
import { PhpParser } from './languages/php.js';
import { SqlParser } from './languages/sql.js';
import { PythonParser } from './languages/python.js';
import type { LanguageParser } from './languages/parser.js';
import type { CodeSymbol, CallRef } from '../types/code.js';

export interface ParseTask {
  relPath: string;
  absPath: string;
  ext: string;
}

export interface ParseResult {
  relPath: string;
  symbols: CodeSymbol[];
  callRefs: CallRef[];
  error?: string;
}

// One parser instance per worker — re-used across all files assigned to this worker.
const parsers: LanguageParser[] = [new TypeScriptParser(), new PhpParser(), new SqlParser(), new PythonParser()];

function getParser(ext: string): LanguageParser | undefined {
  return parsers.find((p) => p.extensions.includes(ext));
}

import fs from 'node:fs';

parentPort!.on('message', (task: ParseTask) => {
  const parser = getParser(task.ext);
  if (!parser) {
    parentPort!.postMessage({ relPath: task.relPath, symbols: [], callRefs: [] } satisfies ParseResult);
    return;
  }

  try {
    const source = fs.readFileSync(task.absPath, 'utf-8');
    const symbols = parser.extractSymbols(task.relPath, source);
    const callRefs = parser.extractCallRefs ? parser.extractCallRefs(task.relPath, source, symbols) : [];
    parentPort!.postMessage({ relPath: task.relPath, symbols, callRefs } satisfies ParseResult);
  } catch (err) {
    parentPort!.postMessage({
      relPath: task.relPath,
      symbols: [],
      callRefs: [],
      error: (err as Error).message,
    } satisfies ParseResult);
  }
});

// Signal readiness (unused by current pool impl, but useful for testing)
void workerData;
