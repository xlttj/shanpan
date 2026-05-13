---
title: Language Parsers
type: software_requirement
status: active
created: '2026-04-05'
implements:
  - symbol: src/analyzer/languages/typescript.ts::TypeScriptParser
    type: class
  - symbol: src/analyzer/languages/php.ts::PhpParser
    type: class
  - symbol: src/analyzer/languages/sql.ts::SqlParser
    type: class
  - symbol: src/analyzer/languages/index.ts::getParserForExtension
    type: function
  - symbol: src/analyzer/languages/index.ts::getExtensionsForLanguages
    type: function
---
# Language Parsers

Code symbol extractors for TypeScript, PHP, and SQL.

All parsers implement the `LanguageParser` interface: they accept a relative file path
and source string and return an array of `CodeSymbol` objects. Call-graph extraction
(`extractCallRefs`) is optional and only implemented where static analysis is meaningful.

`TypeScriptParser` handles `.ts`, `.tsx`, `.mts`, `.cts`. It uses tree-sitter to extract
classes, interfaces, functions, type aliases, enums, and methods (as `ClassName.methodName`
FQNs). Export wrappers are transparently unwrapped. Implements `extractCallRefs`.

`PhpParser` handles `.php`. It uses tree-sitter to extract classes, interfaces, traits,
enums, top-level functions, and methods. PHP namespaces are not yet resolved (full FQNs
planned for a future iteration). Implements `extractCallRefs`.

`SqlParser` handles `.sql`. It uses regex-based line scanning to extract DDL declarations:
`CREATE TABLE` → `table`, `CREATE VIEW` → `view`, `CREATE FUNCTION` → `function`,
`CREATE PROCEDURE` → `procedure`, `CREATE TRIGGER` → `trigger`. Schema prefixes and
identifier quoting (backtick, double-quote, bracket) are stripped to produce bare object
names as FQNs. `extractCallRefs` is intentionally not implemented — SQL has no static
call-graph equivalent; the parser exists purely for spec linkage.

The language registry (`getParserForExtension`, `getExtensionsForLanguages`) maps file
extensions to parser instances via a singleton list.
