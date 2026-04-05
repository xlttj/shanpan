---
id: SPEC-007
title: CLI Commands
type: software_requirement
status: active
created: '2026-04-05'
implements:
  - symbol: src/cli/commands/init.ts::runInit
    type: function
  - symbol: src/cli/commands/index-specs.ts::runIndex
    type: function
  - symbol: src/cli/commands/analyze.ts::runAnalyze
    type: function
  - symbol: src/cli/commands/create.ts::runCreate
    type: function
  - symbol: src/cli/commands/update.ts::runUpdate
    type: function
  - symbol: src/cli/commands/check.ts::runCheck
    type: function
  - symbol: src/cli/commands/status.ts::runStatus
    type: function
  - symbol: src/cli/commands/query.ts::runQuery
    type: function
---
# CLI Commands

The `specgraph` CLI provides the following commands, each implemented as a standalone
`run*` function that is registered in `src/cli/index.ts` via Commander.js:

- `init` — creates `.specgraph/` with an empty graph DB and writes `config.json`
- `index` — parses all spec files and rebuilds the Spec/BusinessRule/edge graph
- `analyze` — walks source directories, extracts symbols, creates IMPLEMENTS edges
- `create` — authors a new spec markdown file with validated frontmatter
- `update` — adds/removes symbol links or changes status of an existing spec
- `check --staged` — pre-commit hook: reads `git diff --cached`, finds specs affected
  by deleted/renamed files, exits 1 to block the commit if violations found
- `status` — shows node and edge counts from the DB
- `query <cypher>` — executes a raw Cypher query and formats results as a table
