import type { CodeSymbol, SymbolKind, CallRef } from '../../types/code.js';
import type { LanguageParser } from './parser.js';

const TS_KEYWORDS = new Set([
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default',
  'delete', 'do', 'else', 'export', 'extends', 'finally', 'for', 'function',
  'if', 'import', 'in', 'instanceof', 'let', 'new', 'return', 'super', 'switch',
  'this', 'throw', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield',
  'enum', 'implements', 'interface', 'package', 'private', 'protected', 'public',
  'static', 'abstract', 'as', 'async', 'await', 'declare', 'from', 'module',
  'namespace', 'of', 'override', 'readonly', 'type',
]);

const TS_MODIFIERS_RE =
  /^(?:(?:public|private|protected|static|async|abstract|override|readonly)\s+)*/;

interface Scope {
  sym: CodeSymbol;
  closeDepth: number;
  isClassLike: boolean;
}

interface Pending {
  name: string;
  kind: SymbolKind;
  lineStart: number;
  isClassLike: boolean;
}

function countChar(s: string, ch: string): number {
  let n = 0;
  for (const c of s) if (c === ch) n++;
  return n;
}

function findEnclosing(symbols: CodeSymbol[], line: number): CodeSymbol | null {
  let best: CodeSymbol | null = null;
  let bestRange = Infinity;
  for (const sym of symbols) {
    if (sym.lineStart <= line && line <= sym.lineEnd) {
      const range = sym.lineEnd - sym.lineStart;
      if (range < bestRange) {
        bestRange = range;
        best = sym;
      }
    }
  }
  return best;
}

export class TypeScriptParser implements LanguageParser {
  readonly name = 'typescript';
  readonly extensions = ['.ts', '.tsx', '.mts', '.cts'];

  extractSymbols(filePath: string, source: string): CodeSymbol[] {
    const lines = source.split('\n');
    const results: CodeSymbol[] = [];
    const scopeStack: Scope[] = [];
    let depth = 0;
    let pending: Pending | null = null;

    const getParentFqn = (): string | null => {
      for (let i = scopeStack.length - 1; i >= 0; i--) {
        if (scopeStack[i].isClassLike) return scopeStack[i].sym.fqn;
      }
      return null;
    };

    const classBodyDepth = (): number | null => {
      for (let i = scopeStack.length - 1; i >= 0; i--) {
        if (scopeStack[i].isClassLike) return scopeStack[i].closeDepth + 1;
      }
      return null;
    };

    const makeSym = (name: string, kind: SymbolKind, lineNum: number): CodeSymbol => {
      const parentFqn = getParentFqn();
      const fqn = parentFqn ? `${parentFqn}.${name}` : name;
      return {
        id: `${filePath}::${fqn}`,
        fqn,
        kind,
        filePath,
        lineStart: lineNum,
        lineEnd: lineNum,
        language: 'typescript',
      };
    };

    const pushDecl = (
      name: string,
      kind: SymbolKind,
      isClassLike: boolean,
      lineNum: number,
      opens: number,
      closes: number,
    ): void => {
      const sym = makeSym(name, kind, lineNum);
      results.push(sym);
      if (opens > closes) {
        scopeStack.push({ sym, closeDepth: depth, isClassLike });
      }
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;
      const trimmed = line.trimStart();

      const opens = countChar(line, '{');
      const closes = countChar(line, '}');

      // Activate a pending declaration when its opening brace appears
      if (pending !== null && opens > 0) {
        const sym = makeSym(pending.name, pending.kind, pending.lineStart);
        results.push(sym);
        if (opens > closes) {
          scopeStack.push({ sym, closeDepth: depth, isClassLike: pending.isClassLike });
        }
        pending = null;
      }

      const cbd = classBodyDepth();
      const isTopLevel = depth === 0;
      const inClassBody = cbd !== null && depth === cbd;

      if (isTopLevel) {
        const cm = trimmed.match(
          /^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][A-Za-z0-9_$]*)/,
        );
        if (cm) {
          if (opens > 0) pushDecl(cm[1], 'class', true, lineNum, opens, closes);
          else pending = { name: cm[1], kind: 'class', lineStart: lineNum, isClassLike: true };
        } else {
          const im = trimmed.match(/^(?:export\s+)?interface\s+([A-Za-z_$][A-Za-z0-9_$]*)/);
          if (im) {
            if (opens > 0) pushDecl(im[1], 'interface', true, lineNum, opens, closes);
            else pending = { name: im[1], kind: 'interface', lineStart: lineNum, isClassLike: true };
          } else {
            const fm = trimmed.match(
              /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)/,
            );
            if (fm) {
              if (opens > 0) pushDecl(fm[1], 'function', false, lineNum, opens, closes);
              else pending = { name: fm[1], kind: 'function', lineStart: lineNum, isClassLike: false };
            } else {
              const tm = trimmed.match(
                /^(?:export\s+)?type\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*[=<]/,
              );
              if (tm) {
                pushDecl(tm[1], 'type', false, lineNum, opens, closes);
              } else {
                const em = trimmed.match(
                  /^(?:export\s+)?(?:const\s+)?enum\s+([A-Za-z_$][A-Za-z0-9_$]*)/,
                );
                if (em) {
                  if (opens > 0) pushDecl(em[1], 'enum', false, lineNum, opens, closes);
                  else pending = { name: em[1], kind: 'enum', lineStart: lineNum, isClassLike: false };
                }
              }
            }
          }
        }
      } else if (inClassBody) {
        const stripped = trimmed.replace(TS_MODIFIERS_RE, '');
        const mm = stripped.match(/^([a-zA-Z_$][a-zA-Z0-9_$]*)\s*[(<]/);
        if (mm && !TS_KEYWORDS.has(mm[1])) {
          if (opens > closes) {
            pushDecl(mm[1], 'method', false, lineNum, opens, closes);
          } else {
            // Single-line body or no body (interface member / abstract method)
            pushDecl(mm[1], 'method', false, lineNum, opens, closes);
          }
        }
      }

      depth += opens - closes;

      while (scopeStack.length > 0 && depth <= scopeStack[scopeStack.length - 1].closeDepth) {
        const scope = scopeStack.pop()!;
        scope.sym.lineEnd = lineNum;
      }
    }

    return results;
  }

  extractCallRefs(filePath: string, source: string, symbols: CodeSymbol[]): CallRef[] {
    const lines = source.split('\n');
    const results: CallRef[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;

      // new ClassName(  — simple identifier only
      const newRe = /\bnew\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*[(<]/g;
      let m: RegExpExecArray | null;
      while ((m = newRe.exec(line)) !== null) {
        const enclosing = findEnclosing(symbols, lineNum);
        if (enclosing) {
          results.push({
            callerSymbolId: enclosing.id,
            targetName: m[1],
            kind: 'instantiation',
            line: lineNum,
          });
        }
      }

      // Identifier.method(  — skip this. and super.
      const callRe = /\b([A-Za-z_$][A-Za-z0-9_$]*)\.([A-Za-z0-9_$]+)\s*\(/g;
      while ((m = callRe.exec(line)) !== null) {
        const obj = m[1];
        if (obj === 'this' || obj === 'super') continue;
        const enclosing = findEnclosing(symbols, lineNum);
        if (enclosing) {
          results.push({
            callerSymbolId: enclosing.id,
            targetName: `${obj}.${m[2]}`,
            kind: 'static_call',
            line: lineNum,
          });
        }
      }
    }

    return results;
  }
}
