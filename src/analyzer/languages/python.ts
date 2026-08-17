import { createRequire } from 'module';
import type Parser from 'tree-sitter';
import type { CodeSymbol, SymbolKind, CallRef } from '../../types/code.js';
import type { LanguageParser } from './parser.js';

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const TreeSitter = require('tree-sitter') as typeof Parser;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const PyLanguage = require('tree-sitter-python') as Parser.Language;

/** SCREAMING_SNAKE_CASE — the Python convention for a module- or class-level constant. */
function isConstantName(name: string): boolean {
  return /^[A-Z_][A-Z0-9_]*$/.test(name) && /[A-Z]/.test(name);
}

function makeSymbol(
  kind: SymbolKind,
  fqn: string,
  filePath: string,
  node: Parser.SyntaxNode,
): CodeSymbol {
  return {
    id: `${filePath}::${fqn}`,
    fqn,
    kind,
    filePath,
    lineStart: node.startPosition.row + 1,
    lineEnd: node.endPosition.row + 1,
    language: 'python',
  };
}

function walkNode(
  node: Parser.SyntaxNode,
  filePath: string,
  parentFqn: string | null,
  results: CodeSymbol[],
): void {
  switch (node.type) {
    case 'module':
      for (const child of node.namedChildren) walkNode(child, filePath, parentFqn, results);
      return;

    // A decorator (@property, @staticmethod, @dataclass, …) wraps the real
    // definition; unwrap and process the class/function underneath.
    case 'decorated_definition': {
      const def = node.childForFieldName('definition');
      if (def) walkNode(def, filePath, parentFqn, results);
      return;
    }

    case 'class_definition': {
      const nameNode = node.childForFieldName('name');
      if (!nameNode) return;
      const fqn = parentFqn ? `${parentFqn}.${nameNode.text}` : nameNode.text;
      results.push(makeSymbol('class', fqn, filePath, node));
      // Descend into the class body for methods, nested classes, class constants.
      const body = node.childForFieldName('body');
      if (body) {
        for (const child of body.namedChildren) walkNode(child, filePath, fqn, results);
      }
      return;
    }

    case 'function_definition': {
      const nameNode = node.childForFieldName('name');
      if (!nameNode) return;
      const fqn = parentFqn ? `${parentFqn}.${nameNode.text}` : nameNode.text;
      // Inside a class it is a method; at module level it is a function. We do
      // not descend into function bodies — locals and nested defs are noise.
      results.push(makeSymbol(parentFqn ? 'method' : 'function', fqn, filePath, node));
      return;
    }

    // Module- or class-level assignment to a SCREAMING_SNAKE_CASE name → constant.
    case 'expression_statement': {
      const assign = node.namedChildren.find((c) => c.type === 'assignment');
      const left = assign?.childForFieldName('left');
      if (left && left.type === 'identifier' && isConstantName(left.text)) {
        const fqn = parentFqn ? `${parentFqn}.${left.text}` : left.text;
        results.push(makeSymbol('constant', fqn, filePath, node));
      }
      return;
    }
  }
}

function findEnclosingSymbol(symbols: CodeSymbol[], line: number): CodeSymbol | null {
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

function collectCallRefs(
  node: Parser.SyntaxNode,
  symbols: CodeSymbol[],
  results: CallRef[],
): void {
  if (node.type === 'call') {
    const fn = node.childForFieldName('function');
    const line = node.startPosition.row + 1;
    const enclosing = findEnclosingSymbol(symbols, line);
    if (enclosing && fn) {
      if (fn.type === 'identifier') {
        // Foo(...) — Python has no `new`, so a capitalised name is by convention
        // a class instantiation; a lower-case name is a plain function call.
        const name = fn.text;
        const kind = /^[A-Z]/.test(name) ? 'instantiation' : 'static_call';
        results.push({ callerSymbolId: enclosing.id, targetName: name, kind, line });
      } else if (fn.type === 'attribute') {
        const objNode = fn.childForFieldName('object');
        const attrNode = fn.childForFieldName('attribute');
        if (objNode?.type === 'identifier' && attrNode?.type === 'identifier') {
          if (objNode.text === 'self' || objNode.text === 'cls') {
            // self.method() / cls.method() → resolve as EnclosingClass.method.
            const dotIdx = enclosing.fqn.lastIndexOf('.');
            if (dotIdx !== -1) {
              const className = enclosing.fqn.slice(0, dotIdx);
              results.push({
                callerSymbolId: enclosing.id,
                targetName: `${className}.${attrNode.text}`,
                kind: 'static_call',
                line,
              });
            }
          } else {
            // obj.method() — used as-is; resolves only if obj is a known symbol.
            results.push({
              callerSymbolId: enclosing.id,
              targetName: `${objNode.text}.${attrNode.text}`,
              kind: 'static_call',
              line,
            });
          }
        }
        // Chained calls (a.b.c()) carry no type info and are skipped.
      }
    }
  }

  for (const child of node.namedChildren) {
    collectCallRefs(child, symbols, results);
  }
}

export class PythonParser implements LanguageParser {
  readonly name = 'python';
  readonly extensions = ['.py'];

  private readonly _parser: Parser;

  constructor() {
    this._parser = new TreeSitter();
    this._parser.setLanguage(PyLanguage);
  }

  extractSymbols(filePath: string, source: string): CodeSymbol[] {
    const tree = this._parser.parse(source);
    const results: CodeSymbol[] = [];
    walkNode(tree.rootNode, filePath, null, results);
    return results;
  }

  extractCallRefs(filePath: string, source: string, symbols: CodeSymbol[]): CallRef[] {
    const tree = this._parser.parse(source);
    const results: CallRef[] = [];
    collectCallRefs(tree.rootNode, symbols, results);
    return results;
  }
}
