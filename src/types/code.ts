export type SymbolKind =
  | 'class'
  | 'function'
  | 'method'
  | 'interface'
  | 'type'
  | 'enum'
  | 'constant';

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
