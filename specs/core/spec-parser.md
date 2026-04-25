---
title: Spec Parser & Indexer
type: software_requirement
status: active
created: '2026-04-05'
implements:
  - symbol: src/core/parser.ts::parseSpecFile
    type: function
  - symbol: src/core/parser.ts::parseAllSpecs
    type: function
  - symbol: src/core/parser.ts::findSpecFiles
    type: function
  - symbol: src/core/indexer.ts::indexSpecs
    type: function
  - symbol: src/core/indexer.ts::getGraphStats
    type: function
---
# Spec Parser & Indexer

Parses YAML-frontmatter markdown spec files and indexes them into the LadybugDB graph.

`parseSpecFile` reads a single `.md` file, extracts the YAML frontmatter via gray-matter,
validates required fields (`title`, `type`, `status`), and returns a `ParsedSpec`. The
`id` field on `ParsedSpec` is computed at parse time as the relative file path without
the `.md` extension (e.g. `core/spec-parser`).

`parseAllSpecs` walks a directory recursively, calls `parseSpecFile` on each `.md` file,
and collects results and errors without throwing.

`indexSpecs` performs a full drop-and-recreate of the schema, then inserts all Spec nodes,
BusinessRule stubs (from `defines_rules`), CodeSymbol stubs (from `implements`), and the
typed edges (DEFINES, IMPLEMENTS).
