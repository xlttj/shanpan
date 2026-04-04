import { createRequire } from 'module';
import type Parser from 'tree-sitter';
import type { CodeSymbol, SymbolKind } from '../../types/code.js';
import type { LanguageParser } from './parser.js';

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const TreeSitter = require('tree-sitter') as typeof Parser;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const TSLanguage = require('tree-sitter-typescript') as {
  typescript: Parser.Language;
  tsx: Parser.Language;
};

const TS_DECLARATION_TYPES: Record<string, SymbolKind> = {
  class_declaration: 'class',
  abstract_class_declaration: 'class',
  function_declaration: 'function',
  interface_declaration: 'interface',
  type_alias_declaration: 'type',
  enum_declaration: 'enum',
};

const METHOD_TYPES = new Set(['method_definition', 'method_signature']);

function getNameNode(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
  return (
    node.childForFieldName('name') ??
    node.children.find(
      (c) => c.type === 'type_identifier' || c.type === 'identifier' || c.type === 'property_identifier',
    ) ??
    null
  );
}

function walkNode(
  node: Parser.SyntaxNode,
  filePath: string,
  language: string,
  parentFqn: string | null,
  results: CodeSymbol[],
): void {
  const kind = TS_DECLARATION_TYPES[node.type];

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
        language,
      });
      // Walk into class/interface body for methods
      if (kind === 'class' || kind === 'interface') {
        const body =
          node.childForFieldName('body') ??
          node.children.find((c) => c.type === 'class_body' || c.type === 'interface_body');
        if (body) {
          for (const child of body.children) {
            walkNode(child, filePath, language, fqn, results);
          }
        }
      }
    }
    return;
  }

  if (METHOD_TYPES.has(node.type)) {
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
        language,
      });
    }
    return;
  }

  // Unwrap export statements
  if (node.type === 'export_statement') {
    for (const child of node.children) {
      walkNode(child, filePath, language, parentFqn, results);
    }
    return;
  }

  // Recurse into top-level containers
  if (node.type === 'program' || node.type === 'statement_block') {
    for (const child of node.children) {
      walkNode(child, filePath, language, parentFqn, results);
    }
  }
}

export class TypeScriptParser implements LanguageParser {
  readonly name = 'typescript';
  readonly extensions = ['.ts', '.tsx', '.mts', '.cts'];

  private readonly _parser: Parser;

  constructor() {
    this._parser = new TreeSitter();
    this._parser.setLanguage(TSLanguage.typescript);
  }

  extractSymbols(filePath: string, source: string): CodeSymbol[] {
    const ext = filePath.split('.').pop() ?? '';
    const lang = ext === 'tsx' || ext === 'jsx' ? TSLanguage.tsx : TSLanguage.typescript;
    this._parser.setLanguage(lang);

    const tree = this._parser.parse(source);
    const results: CodeSymbol[] = [];
    walkNode(tree.rootNode, filePath, 'typescript', null, results);
    return results;
  }
}
