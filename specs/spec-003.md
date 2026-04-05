---
id: SPEC-003
title: Code Analyzer
type: software_requirement
status: active
created: '2026-04-05'
implements:
  - symbol: src/analyzer/indexer.ts::analyzeAndIndex
    type: function
  - symbol: src/analyzer/walker.ts::walkFiles
    type: function
  - symbol: src/analyzer/resolver.ts::resolveImplementations
    type: function
  - symbol: src/analyzer/resolver.ts::findUnresolvedImplementations
    type: function
---
# Code Analyzer

Walks source directories, parses files with tree-sitter, and writes CodeSymbol nodes
and IMPLEMENTS edges into the graph.

`walkFiles` recursively traverses a list of root directories, filtering by file extension
and skipping excluded directory names. Returns absolute file paths.

`resolveImplementations` matches extracted CodeSymbol IDs against the `implements` entries
declared in spec frontmatter. Only symbols that exist in the extracted set produce links.

`findUnresolvedImplementations` returns the complement: spec `implements` entries whose
symbol ID was not found in the extracted set. These are drift warnings.

`analyzeAndIndex` orchestrates the full pipeline: walk → parse per language → upsert
CodeSymbol nodes → resolve implementations → create IMPLEMENTS edges → collect drift warnings.
