import type { CodeSymbol } from '../../types/code.js';

export interface LanguageParser {
  readonly name: string;
  readonly extensions: string[];
  extractSymbols(filePath: string, source: string): CodeSymbol[];
}
