import type { CodeSymbol, CallRef, InheritanceEdge } from '../../types/code.js';

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
  /**
   * Extract class inheritance (extends + used traits) so the indexer can
   * resolve a `$this->method()` call to the ancestor that defines the method.
   */
  extractInheritance?(filePath: string, source: string): InheritanceEdge[];
}
