import { createRequire } from 'module';
import type Parser from 'tree-sitter';
import type { CodeSymbol, SymbolKind, CallRef, InheritanceEdge } from '../../types/code.js';
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
    node.type === 'compound_statement' ||
    node.type === 'namespace_definition'
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

const stripDollar = (s: string): string => (s.startsWith('$') ? s.slice(1) : s);

/**
 * Simple class name from a type declaration, or null when it carries no single
 * resolvable class. Strips a nullable "?" and namespace segments ("\App\Foo" →
 * "Foo"); unions and intersections ("Foo|Bar") are ambiguous, so they yield
 * null rather than a guess.
 */
function simpleTypeName(typeNode: Parser.SyntaxNode | null): string | null {
  if (!typeNode) return null;
  const text = typeNode.text.trim();
  if (text.includes('|') || text.includes('&')) return null;
  const bare = text.replace(/^\?/, '').split('\\').filter(Boolean).pop() ?? '';
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(bare) ? bare : null;
}

/**
 * Map of `class name → (property name → declared class type)` for one file,
 * covering typed property declarations and constructor-promoted parameters —
 * the two ways a Symfony/PHP class names the type of an injected dependency.
 * With it, a call on `$this->prop` resolves to `Type.method` instead of being
 * dropped for want of type inference. Kept file-local, which is enough: a call
 * and the property it reads live in the same class in the same file.
 */
function buildPropertyTypes(root: Parser.SyntaxNode): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>();

  const collectProps = (classNode: Parser.SyntaxNode, props: Map<string, string>): void => {
    const visit = (node: Parser.SyntaxNode): void => {
      if (node.type === 'property_declaration') {
        const typeName = simpleTypeName(node.childForFieldName('type'));
        if (typeName) {
          for (const el of node.namedChildren) {
            if (el.type === 'property_element') {
              const nm = el.childForFieldName('name')?.text;
              if (nm) props.set(stripDollar(nm), typeName);
            }
          }
        }
        return;
      }
      if (node.type === 'property_promotion_parameter') {
        const nm = node.childForFieldName('name')?.text;
        const typeName = simpleTypeName(node.childForFieldName('type'));
        if (nm && typeName) props.set(stripDollar(nm), typeName);
        return;
      }
      // Do not descend into a nested class/trait — keep props scoped to this one.
      if (node !== classNode && (node.type === 'class_declaration' || node.type === 'trait_declaration')) {
        return;
      }
      for (const c of node.namedChildren) visit(c);
    };
    visit(classNode);
  };

  const walk = (node: Parser.SyntaxNode): void => {
    if (node.type === 'class_declaration' || node.type === 'trait_declaration') {
      const nameNode = getNameNode(node);
      if (nameNode) {
        const props = out.get(nameNode.text) ?? new Map<string, string>();
        collectProps(node, props);
        out.set(nameNode.text, props);
      }
    }
    for (const c of node.namedChildren) walk(c);
  };
  walk(root);
  return out;
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
  propTypes: Map<string, Map<string, string>>,
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
    const objectNode = node.childForFieldName('object');
    const nameNode = node.childForFieldName('name');
    if (objectNode && nameNode) {
      const line = node.startPosition.row + 1;
      const enclosing = findEnclosingSymbol(symbols, line);
      const dotIdx = enclosing ? enclosing.fqn.lastIndexOf('.') : -1;
      const className = enclosing && dotIdx !== -1 ? enclosing.fqn.slice(0, dotIdx) : null;
      if (enclosing && className) {
        if (objectNode.text === '$this') {
          // $this->method() — same class.
          results.push({
            callerSymbolId: enclosing.id,
            targetName: `${className}.${nameNode.text}`,
            kind: 'static_call',
            line,
          });
        } else if (
          objectNode.type === 'member_access_expression' &&
          objectNode.childForFieldName('object')?.text === '$this'
        ) {
          // $this->prop->method() — resolve prop's declared type to Type.method.
          const propName = objectNode.childForFieldName('name')?.text;
          const propType = propName ? propTypes.get(className)?.get(propName) : undefined;
          if (propType) {
            results.push({
              callerSymbolId: enclosing.id,
              targetName: `${propType}.${nameNode.text}`,
              kind: 'static_call',
              line,
            });
          }
        }
      }
    }
  }

  for (const child of node.namedChildren) {
    collectCallRefs(child, symbols, results, propTypes);
  }
}

/**
 * Extends/uses relationships per class, by simple name. Method resolution needs
 * the classes and traits that carry method *bodies* (extends + `use` traits);
 * `implements` is omitted because an interface supplies no implementation.
 */
function collectInheritance(root: Parser.SyntaxNode, filePath: string): InheritanceEdge[] {
  const edges: InheritanceEdge[] = [];

  const parentsOf = (classNode: Parser.SyntaxNode): string[] => {
    const parents: string[] = [];
    for (const child of classNode.namedChildren) {
      // `extends Base` — a base_clause holds one or more class names.
      if (child.type === 'base_clause') {
        for (const n of child.namedChildren) {
          const name = extractClassName(n);
          if (name) parents.push(name);
        }
      }
      // `use SomeTrait, Other;` inside the class body brings in trait methods.
      if (child.type === 'declaration_list') {
        for (const member of child.namedChildren) {
          if (member.type === 'use_declaration') {
            for (const n of member.namedChildren) {
              const name = extractClassName(n);
              if (name) parents.push(name);
            }
          }
        }
      }
    }
    return parents;
  };

  const walk = (node: Parser.SyntaxNode): void => {
    if (node.type === 'class_declaration' || node.type === 'trait_declaration') {
      const nameNode = getNameNode(node);
      if (nameNode) {
        const parents = parentsOf(node);
        if (parents.length > 0) edges.push({ child: nameNode.text, parents, filePath });
      }
    }
    for (const c of node.namedChildren) walk(c);
  };
  walk(root);
  return edges;
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
    const propTypes = buildPropertyTypes(tree.rootNode);
    collectCallRefs(tree.rootNode, symbols, results, propTypes);
    return results;
  }

  extractInheritance(filePath: string, source: string): InheritanceEdge[] {
    const tree = this._parser.parse(source);
    return collectInheritance(tree.rootNode, filePath);
  }
}
