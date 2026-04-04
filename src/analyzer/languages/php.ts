import { createRequire } from 'module';
import type Parser from 'tree-sitter';
import type { CodeSymbol, SymbolKind } from '../../types/code.js';
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
}
