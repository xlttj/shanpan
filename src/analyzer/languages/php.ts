import type { CodeSymbol, SymbolKind, CallRef } from '../../types/code.js';
import type { LanguageParser } from './parser.js';

const PHP_MODIFIERS_RE =
  /^(?:(?:public|private|protected|static|abstract|final)\s+)*/;

const SKIP_PHP_SCOPES = new Set(['self', 'parent', 'static']);

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

export class PhpParser implements LanguageParser {
  readonly name = 'php';
  readonly extensions = ['.php'];

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
        language: 'php',
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
        const cm = trimmed.match(/^(?:abstract\s+)?class\s+([A-Za-z_][A-Za-z0-9_]*)/);
        if (cm) {
          if (opens > 0) pushDecl(cm[1], 'class', true, lineNum, opens, closes);
          else pending = { name: cm[1], kind: 'class', lineStart: lineNum, isClassLike: true };
        } else {
          const im = trimmed.match(/^interface\s+([A-Za-z_][A-Za-z0-9_]*)/);
          if (im) {
            if (opens > 0) pushDecl(im[1], 'interface', true, lineNum, opens, closes);
            else pending = { name: im[1], kind: 'interface', lineStart: lineNum, isClassLike: true };
          } else {
            const trm = trimmed.match(/^trait\s+([A-Za-z_][A-Za-z0-9_]*)/);
            if (trm) {
              if (opens > 0) pushDecl(trm[1], 'class', true, lineNum, opens, closes);
              else pending = { name: trm[1], kind: 'class', lineStart: lineNum, isClassLike: true };
            } else {
              const em = trimmed.match(/^enum\s+([A-Za-z_][A-Za-z0-9_]*)/);
              if (em) {
                if (opens > 0) pushDecl(em[1], 'enum', false, lineNum, opens, closes);
                else pending = { name: em[1], kind: 'enum', lineStart: lineNum, isClassLike: false };
              } else {
                const fm = trimmed.match(/^function\s+([a-zA-Z_][a-zA-Z0-9_]*)/);
                if (fm) {
                  if (opens > 0) pushDecl(fm[1], 'function', false, lineNum, opens, closes);
                  else pending = { name: fm[1], kind: 'function', lineStart: lineNum, isClassLike: false };
                }
              }
            }
          }
        }
      } else if (inClassBody) {
        // Methods: optional access modifiers + function keyword
        const stripped = trimmed.replace(PHP_MODIFIERS_RE, '');
        const mm = stripped.match(/^function\s+([a-zA-Z_][a-zA-Z0-9_]*)/);
        if (mm) {
          if (opens > 0) pushDecl(mm[1], 'method', false, lineNum, opens, closes);
          else pending = { name: mm[1], kind: 'method', lineStart: lineNum, isClassLike: false };
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

      // new ClassName() or new \Qualified\ClassName()
      const newRe =
        /\bnew\s+((?:\\?[A-Za-z_][A-Za-z0-9_]*)(?:\\[A-Za-z_][A-Za-z0-9_]*)*)\s*[(<]/g;
      let m: RegExpExecArray | null;
      while ((m = newRe.exec(line)) !== null) {
        const parts = m[1].split('\\').filter(Boolean);
        const className = parts[parts.length - 1];
        if (!className) continue;
        const enclosing = findEnclosing(symbols, lineNum);
        if (enclosing) {
          results.push({
            callerSymbolId: enclosing.id,
            targetName: className,
            kind: 'instantiation',
            line: lineNum,
          });
        }
      }

      // ClassName::method() — skip self/parent/static
      const staticRe = /\b([A-Za-z_][A-Za-z0-9_]*)::([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/g;
      while ((m = staticRe.exec(line)) !== null) {
        if (SKIP_PHP_SCOPES.has(m[1])) continue;
        const enclosing = findEnclosing(symbols, lineNum);
        if (enclosing) {
          results.push({
            callerSymbolId: enclosing.id,
            targetName: `${m[1]}.${m[2]}`,
            kind: 'static_call',
            line: lineNum,
          });
        }
      }
    }

    return results;
  }
}
