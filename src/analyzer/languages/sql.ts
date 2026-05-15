import type { CodeSymbol, SymbolKind } from '../../types/code.js';
import type { LanguageParser } from './parser.js';

interface SqlPattern {
  kind: SymbolKind;
  re: RegExp;
}

// Matches the full name expression after the DDL keyword (may include schema prefix).
// Identifier chars include word chars plus quoting chars; schema separator is a dot.
const NAME_EXPR = /(?:[\w`"[\]]+\.)*[\w`"[\]]+/;
const n = NAME_EXPR.source;

const SQL_PATTERNS: SqlPattern[] = [
  {
    kind: 'table',
    re: new RegExp(String.raw`\bCREATE\s+(?:TEMPORARY\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(${n})`, 'i'),
  },
  {
    kind: 'view',
    re: new RegExp(String.raw`\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:ALGORITHM\s*=\s*\w+\s+)?(?:DEFINER\s*=\s*\S+\s+)?(?:SQL\s+SECURITY\s+\w+\s+)?(?:MATERIALIZED\s+)?VIEW\s+(${n})`, 'i'),
  },
  {
    kind: 'function',
    re: new RegExp(String.raw`\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:DEFINER\s*=\s*\S+\s+)?FUNCTION\s+(${n})`, 'i'),
  },
  {
    kind: 'procedure',
    re: new RegExp(String.raw`\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:DEFINER\s*=\s*\S+\s+)?PROCEDURE\s+(${n})`, 'i'),
  },
  {
    kind: 'trigger',
    re: new RegExp(String.raw`\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:DEFINER\s*=\s*\S+\s+)?TRIGGER\s+(${n})`, 'i'),
  },
];

/** Strip schema prefix and quoting chars, return the bare object name. */
function extractObjectName(raw: string): string | null {
  const parts = raw.split('.');
  const last = parts[parts.length - 1].replace(/^[`"[\]]|[`"[\]]$/g, '').trim();
  return last || null;
}

export class SqlParser implements LanguageParser {
  readonly name = 'sql';
  readonly extensions = ['.sql'];

  extractSymbols(filePath: string, source: string): CodeSymbol[] {
    const lines = source.split('\n');
    const totalLines = lines.length;

    const hits: Array<{ kind: SymbolKind; fqn: string; lineStart: number }> = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Skip single-line comments
      if (/^\s*--/.test(line)) continue;

      for (const { kind, re } of SQL_PATTERNS) {
        const m = re.exec(line);
        if (m?.[1]) {
          const name = extractObjectName(m[1]);
          if (name) {
            hits.push({ kind, fqn: name, lineStart: i + 1 });
            break;
          }
        }
      }
    }

    return hits.map((hit, idx) => {
      const nextStart = idx + 1 < hits.length ? hits[idx + 1].lineStart - 1 : totalLines;
      return {
        id: `${filePath}::${hit.fqn}`,
        fqn: hit.fqn,
        kind: hit.kind,
        filePath,
        lineStart: hit.lineStart,
        lineEnd: Math.max(hit.lineStart, nextStart),
        language: 'sql',
      };
    });
  }
}
