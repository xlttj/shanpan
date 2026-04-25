---
title: Code Analyzer
type: software_requirement
status: active
created: '2026-04-05'
implements:
  - symbol: src/analyzer/indexer.ts::analyzeAndIndex
    type: function
  - symbol: src/analyzer/indexer.ts::analyzeAndIndexIncremental
    type: function
  - symbol: src/analyzer/walker.ts::walkFiles
    type: function
  - symbol: src/analyzer/resolver.ts::resolveImplementations
    type: function
  - symbol: src/analyzer/resolver.ts::findUnresolvedImplementations
    type: function
---
# Code Analyzer

Walks source directories, parses files, and writes CodeSymbol nodes, File nodes,
CONTAINS edges, and IMPLEMENTS edges into the graph.

`walkFiles` recursively traverses a list of root directories, filtering by file extension
and skipping excluded directory names. Returns absolute file paths.

`resolveImplementations` matches extracted CodeSymbol IDs against the `implements` entries
declared in spec frontmatter. Only symbols that exist in the extracted set produce links.

`findUnresolvedImplementations` returns the complement: spec `implements` entries whose
symbol ID was not found in the extracted set. These are drift warnings.

`analyzeAndIndex` orchestrates the full pipeline: walk → parse → write. Parsing runs in
parallel across a worker-thread pool (up to 8 workers, `SPECGRAPH_WORKERS=0` disables).
DB writes use UNWIND batches of 200 rows instead of per-item queries. The full rebuild
clears all CodeSymbol and File nodes before reinserting. Spec `implements` entries with
`type: file` create File→Spec IMPLEMENTS edges; missing files are recorded as drift.

`analyzeAndIndexIncremental` handles the common case where only a subset of files changed.
It receives the sets of changed and deleted relative paths (determined by mtime comparison
in the CLI layer), deletes only those files' nodes, re-parses changed files, reinserts
their nodes and edges, and re-resolves IMPLEMENTS and drift against the full current DB
symbol set. Cross-file CALLS edges are resolved by querying existing symbols from the DB
after inserting the new ones.
