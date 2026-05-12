import { createRequire } from 'module';
import type Parser from 'tree-sitter';
import type { CodeSymbol, SymbolKind, CallRef } from '../../types/code.js';
import type { LanguageParser } from './parser.js';

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const TreeSitter = require('tree-sitter') as typeof Parser;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const PHPLanguage = require('tree-sitter-php') as {
  php: Parser.Language;
  php_only: Parser.Language;
};

const PHP_DECL_TYPES: Record<string, SymbolKind> = {
  class_declaration: 'class',
  interface_declaration: 'interface',
  trait_declaration: 'class',
  enum_declaration: 'enum',
  function_definition: 'function',
};

const PHP_METHOD_TYPES = new Set(['method_declaration']);

function getNameNode(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
  return (
    node.childForFieldName('name') ??
    node.children.find((c) => c.type === 'name') ??
    null
  );
}

function walkNode(
  node: Parser.SyntaxNode,
  filePath: string,
  parentFqn: string | null,
  results: CodeSymbol[],
): void {
  const kind = PHP_DECL_TYPES[node.type];

  if (kind !== undefined) {
    const nameNode = getNameNode(node);
    if (nameNode) {
      const name = nameNode.text;
      const fqn = parentFqn ? `${parentFqn}.${name}` : name;
      results.push({
        id: `${filePath}::${fqn}`,
        fqn,
        kind,
        filePath,
        lineStart: node.startPosition.row + 1,
        lineEnd: node.endPosition.row + 1,
        language: 'php',
      });
      if (kind === 'class' || kind === 'interface') {
        for (const child of node.children) {
          walkNode(child, filePath, fqn, results);
        }
      }
    }
    return;
  }

  if (PHP_METHOD_TYPES.has(node.type)) {
    const nameNode = getNameNode(node);
    if (nameNode && parentFqn) {
      const fqn = `${parentFqn}.${nameNode.text}`;
      results.push({
        id: `${filePath}::${fqn}`,
        fqn,
        kind: 'method',
        filePath,
        lineStart: node.startPosition.row + 1,
        lineEnd: node.endPosition.row + 1,
        language: 'php',
      });
    }
    return;
  }

  // Recurse into containers
  if (
    node.type === 'program' ||
    node.type === 'declaration_list' ||
    node.type === 'compound_statement'
  ) {
    for (const child of node.children) {
      walkNode(child, filePath, parentFqn, results);
    }
  }
}

/** Extract the simple class name from a name or qualified_name node */
function extractClassName(node: Parser.SyntaxNode): string | null {
  if (node.type === 'name') return node.text;
  if (node.type === 'qualified_name') {
    const names = node.namedChildren.filter((c) => c.type === 'name');
    return names[names.length - 1]?.text ?? null;
  }
  return null;
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
  if (node.type === 'scoped_call_expression') {
    const scopeNode = node.childForFieldName('scope');
    const nameNode = node.childForFieldName('name');
    // Skip self::, parent::, static:: — can't resolve without type context
    if (scopeNode && nameNode && scopeNode.type !== 'relative_scope') {
      const className = extractClassName(scopeNode);
      if (className) {
        const line = node.startPosition.row + 1;
        const enclosing = findEnclosingSymbol(symbols, line);
        if (enclosing) {
          results.push({
            callerSymbolId: enclosing.id,
            targetName: `${className}.${nameNode.text}`,
            kind: 'static_call',
            line,
          });
        }
      }
    }
  } else if (node.type === 'object_creation_expression') {
    const classChild = node.namedChildren[0];
    if (classChild) {
      const className = extractClassName(classChild);
      if (className) {
        const line = node.startPosition.row + 1;
        const enclosing = findEnclosingSymbol(symbols, line);
        if (enclosing) {
          results.push({
            callerSymbolId: enclosing.id,
            targetName: className,
            kind: 'instantiation',
            line,
          });
        }
      }
    }
  } else if (node.type === 'member_call_expression') {
    // $this->method() — resolve target as EnclosingClass.method
    // Chained calls ($this->prop->method()) are not resolved: no type inference.
    const objectNode = node.childForFieldName('object');
    const nameNode = node.childForFieldName('name');
    if (objectNode && nameNode && objectNode.text === '$this') {
      const line = node.startPosition.row + 1;
      const enclosing = findEnclosingSymbol(symbols, line);
      if (enclosing) {
        const dotIdx = enclosing.fqn.lastIndexOf('.');
        if (dotIdx !== -1) {
          const className = enclosing.fqn.slice(0, dotIdx);
          results.push({
            callerSymbolId: enclosing.id,
            targetName: `${className}.${nameNode.text}`,
            kind: 'static_call',
            line,
          });
        }
      }
    }
  }

  for (const child of node.namedChildren) {
    collectCallRefs(child, symbols, results);
  }
}

export class PhpParser implements LanguageParser {
  readonly name = 'php';
  readonly extensions = ['.php'];

  private readonly _parser: Parser;

  constructor() {
    this._parser = new TreeSitter();
    this._parser.setLanguage(PHPLanguage.php);
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
