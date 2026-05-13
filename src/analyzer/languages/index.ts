import type { LanguageParser } from './parser.js';
import { TypeScriptParser } from './typescript.js';
import { PhpParser } from './php.js';
import { SqlParser } from './sql.js';

export type { LanguageParser };
export { TypeScriptParser, PhpParser, SqlParser };

let _parsers: LanguageParser[] | null = null;

function getParsers(): LanguageParser[] {
  if (_parsers === null) {
    _parsers = [new TypeScriptParser(), new PhpParser(), new SqlParser()];
  }
  return _parsers;
}

export function getParserForExtension(ext: string): LanguageParser | undefined {
  return getParsers().find((p) => p.extensions.includes(ext));
}

export function getExtensionsForLanguages(languages: string[]): string[] {
  return getParsers()
    .filter((p) => languages.includes(p.name))
    .flatMap((p) => p.extensions);
}
