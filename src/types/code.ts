export type SymbolKind =
  | 'class'
  | 'function'
  | 'method'
  | 'interface'
  | 'type'
  | 'enum'
  | 'constant'
  | 'table'
  | 'view'
  | 'procedure'
  | 'trigger';

export interface CodeSymbol {
  /** Unique ID: "<relativeFilePath>::<fqn>" */
  id: string;
  /** Fully qualified name, e.g. "MyClass" or "MyClass.myMethod" */
  fqn: string;
  kind: SymbolKind;
  /** Relative path from project root */
  filePath: string;
  lineStart: number;
  lineEnd: number;
  language: string;
}

export interface ExtractionResult {
  filePath: string;
  symbols: CodeSymbol[];
  error?: string;
}

/**
 * A class and the classes/traits it inherits method implementations from
 * (extends + used traits), by simple name. Used to resolve `$this->method()`
 * to the ancestor that actually defines the method.
 */
export interface InheritanceEdge {
  /** Simple name of the child class. */
  child: string;
  /** Simple names of parent classes and used traits. */
  parents: string[];
  /** File the child class lives in, for building the child's symbol id. */
  filePath: string;
}

export type CallKind = 'static_call' | 'instantiation';

export interface CallRef {
  /** ID of the symbol that contains this call (already resolved) */
  callerSymbolId: string;
  /**
   * Unresolved target name. For static calls: "ClassName.methodName".
   * For instantiation: "ClassName".
   */
  targetName: string;
  kind: CallKind;
  /** 1-based line number of the call expression */
  line: number;
}
