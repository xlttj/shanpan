import type { CodeSymbol, CallRef } from '../../types/code.js';

export interface LanguageParser {
  readonly name: string;
  readonly extensions: string[];
  extractSymbols(filePath: string, source: string): CodeSymbol[];
  /**
   * Extract call references from the file. The already-extracted symbols are
   * provided so implementations can determine which symbol encloses each call
   * by line-range containment rather than re-walking the tree.
   */
  extractCallRefs?(filePath: string, source: string, symbols: CodeSymbol[]): CallRef[];
}
