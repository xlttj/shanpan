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
  - symbol: src/analyzer/languages/index.ts::getParserForExtension
    type: function
  - symbol: src/analyzer/languages/index.ts::getExtensionsForLanguages
    type: function
---
# Language Parsers

Tree-sitter based code symbol extractors for TypeScript and PHP.

Both parsers implement the `LanguageParser` interface: they accept a relative file path
and source string, parse with tree-sitter, and return an array of `CodeSymbol` objects.

`TypeScriptParser` handles `.ts`, `.tsx`, `.mts`, `.cts`. It extracts classes, interfaces,
functions, type aliases, enums, and methods (as `ClassName.methodName` FQNs). Export
wrappers are transparently unwrapped.

`PhpParser` handles `.php`. It extracts classes, interfaces, traits, enums, top-level
functions, and methods. PHP namespaces are not yet resolved (full FQNs planned for a
future iteration).

The language registry (`getParserForExtension`, `getExtensionsForLanguages`) maps file
extensions to parser instances via a singleton list.
