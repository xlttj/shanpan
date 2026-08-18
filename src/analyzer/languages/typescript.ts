import { createRequire } from 'module';
import type Parser from 'tree-sitter';
import type { CodeSymbol, SymbolKind, CallRef, InheritanceEdge } from '../../types/code.js';
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

  // const/let declarations → constant symbols
  if (node.type === 'lexical_declaration' || node.type === 'variable_declaration') {
    for (const child of node.children) {
      if (child.type === 'variable_declarator') {
        const nameNode = child.childForFieldName('name');
        if (nameNode && nameNode.type === 'identifier') {
          const name = nameNode.text;
          const fqn = parentFqn ? `${parentFqn}.${name}` : name;
          results.push({
            id: `${filePath}::${fqn}`,
            fqn,
            kind: 'constant',
            filePath,
            lineStart: node.startPosition.row + 1,
            lineEnd: node.endPosition.row + 1,
            language,
          });
        }
      }
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

/** Simple class/interface name from a type node, or null when not a single named type. */
function simpleTypeName(node: Parser.SyntaxNode | null): string | null {
  if (!node) return null;
  switch (node.type) {
    case 'type_identifier':
    case 'identifier':
      return node.text;
    case 'generic_type':
      return simpleTypeName(node.childForFieldName('name') ?? node.namedChildren[0] ?? null);
    case 'nested_type_identifier': {
      const parts = node.namedChildren.filter((c) => c.type === 'type_identifier' || c.type === 'identifier');
      return parts.length ? parts[parts.length - 1]!.text : null;
    }
    default:
      return null; // predefined_type, union_type, intersection_type, … — not resolvable
  }
}

/** The declared type name inside a `: Type` annotation. */
function typeFromAnnotation(annotation: Parser.SyntaxNode | null): string | null {
  if (!annotation) return null;
  return simpleTypeName(annotation.namedChildren[0] ?? null);
}

/**
 * Map of `class name → (property name → declared class type)` for one file,
 * covering constructor parameter properties (`constructor(private foo: Foo)`)
 * and typed field declarations (`private foo: Foo`). Lets a call on `this.prop`
 * resolve to `Type.method` instead of being dropped.
 */
function buildPropertyTypes(root: Parser.SyntaxNode): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>();

  const collect = (classNode: Parser.SyntaxNode, props: Map<string, string>): void => {
    const body = classNode.childForFieldName('body');
    if (!body) return;
    for (const member of body.namedChildren) {
      // Typed field: `foo: Foo`
      if (member.type === 'public_field_definition') {
        const name = member.childForFieldName('name')?.text;
        const type = typeFromAnnotation(member.childForFieldName('type'));
        if (name && type) props.set(name, type);
      }
      // Constructor parameter properties: `constructor(private foo: Foo)`
      if (member.type === 'method_definition' && member.childForFieldName('name')?.text === 'constructor') {
        const params = member.childForFieldName('parameters');
        for (const p of params?.namedChildren ?? []) {
          if (p.type !== 'required_parameter' && p.type !== 'optional_parameter') continue;
          // A parameter is a property only with an accessibility/readonly modifier.
          const isProp = p.namedChildren.some(
            (c) => c.type === 'accessibility_modifier' || c.type === 'override_modifier',
          );
          if (!isProp) continue;
          const name = p.childForFieldName('pattern')?.text;
          const type = typeFromAnnotation(p.childForFieldName('type'));
          if (name && type) props.set(name, type);
        }
      }
    }
  };

  const walk = (node: Parser.SyntaxNode): void => {
    if (node.type === 'class_declaration' || node.type === 'class') {
      const nameNode = getNameNode(node);
      if (nameNode) {
        const props = out.get(nameNode.text) ?? new Map<string, string>();
        collect(node, props);
        out.set(nameNode.text, props);
      }
    }
    for (const c of node.namedChildren) walk(c);
  };
  walk(root);
  return out;
}

/** Extends + implements per class, by simple name, for inheritance resolution. */
function collectInheritance(root: Parser.SyntaxNode, filePath: string): InheritanceEdge[] {
  const edges: InheritanceEdge[] = [];
  const walk = (node: Parser.SyntaxNode): void => {
    if (node.type === 'class_declaration' || node.type === 'class') {
      const nameNode = getNameNode(node);
      const heritage = node.namedChildren.find((c) => c.type === 'class_heritage');
      if (nameNode && heritage) {
        const parents: string[] = [];
        for (const clause of heritage.namedChildren) {
          if (clause.type === 'extends_clause' || clause.type === 'implements_clause') {
            for (const t of clause.namedChildren) {
              const name = simpleTypeName(t);
              if (name) parents.push(name);
            }
          }
        }
        if (parents.length > 0) edges.push({ child: nameNode.text, parents, filePath });
      }
    }
    for (const c of node.namedChildren) walk(c);
  };
  walk(root);
  return edges;
}

function collectCallRefs(
  node: Parser.SyntaxNode,
  symbols: CodeSymbol[],
  results: CallRef[],
  propTypes: Map<string, Map<string, string>>,
): void {
  if (node.type === 'new_expression') {
    const ctorNode = node.childForFieldName('constructor');
    // Only handle simple identifier — not `new this.Foo()` etc.
    if (ctorNode?.type === 'identifier') {
      const line = node.startPosition.row + 1;
      const enclosing = findEnclosingSymbol(symbols, line);
      if (enclosing) {
        results.push({
          callerSymbolId: enclosing.id,
          targetName: ctorNode.text,
          kind: 'instantiation',
          line,
        });
      }
    }
  } else if (node.type === 'call_expression') {
    const funcNode = node.childForFieldName('function');
    if (funcNode?.type === 'member_expression') {
      const objNode = funcNode.childForFieldName('object');
      const propNode = funcNode.childForFieldName('property');
      if (objNode && propNode) {
        const line = node.startPosition.row + 1;
        const enclosing = findEnclosingSymbol(symbols, line);
        if (enclosing) {
          const dotIdx = enclosing.fqn.lastIndexOf('.');
          const className = dotIdx !== -1 ? enclosing.fqn.slice(0, dotIdx) : null;
          if (objNode.type === 'identifier') {
            // SomeClass.method() or variable.method() — use as-is
            results.push({
              callerSymbolId: enclosing.id,
              targetName: `${objNode.text}.${propNode.text}`,
              kind: 'static_call',
              line,
            });
          } else if (objNode.type === 'this' && className) {
            // this.method() — resolve as EnclosingClass.method (the indexer walks
            // ancestors for inherited methods).
            results.push({ callerSymbolId: enclosing.id, targetName: `${className}.${propNode.text}`, kind: 'static_call', line });
          } else if (objNode.type === 'super') {
            // super.method() — resolve strictly in the ancestors.
            results.push({ callerSymbolId: enclosing.id, targetName: `parent::${propNode.text}`, kind: 'static_call', line });
          } else if (
            objNode.type === 'member_expression' &&
            objNode.childForFieldName('object')?.type === 'this' &&
            className
          ) {
            // this.prop.method() — resolve prop's declared type to Type.method.
            const propName = objNode.childForFieldName('property')?.text;
            const propType = propName ? propTypes.get(className)?.get(propName) : undefined;
            if (propType) {
              results.push({ callerSymbolId: enclosing.id, targetName: `${propType}.${propNode.text}`, kind: 'static_call', line });
            }
          }
        }
      }
    }
  }

  for (const child of node.namedChildren) {
    collectCallRefs(child, symbols, results, propTypes);
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

  extractCallRefs(filePath: string, source: string, symbols: CodeSymbol[]): CallRef[] {
    const ext = filePath.split('.').pop() ?? '';
    const lang = ext === 'tsx' || ext === 'jsx' ? TSLanguage.tsx : TSLanguage.typescript;
    this._parser.setLanguage(lang);

    const tree = this._parser.parse(source);
    const results: CallRef[] = [];
    const propTypes = buildPropertyTypes(tree.rootNode);
    collectCallRefs(tree.rootNode, symbols, results, propTypes);
    return results;
  }

  extractInheritance(filePath: string, source: string): InheritanceEdge[] {
    const ext = filePath.split('.').pop() ?? '';
    const lang = ext === 'tsx' || ext === 'jsx' ? TSLanguage.tsx : TSLanguage.typescript;
    this._parser.setLanguage(lang);
    const tree = this._parser.parse(source);
    return collectInheritance(tree.rootNode, filePath);
  }
}
