---
title: The database is a derived index
type: business_rule
status: active
created: '2026-04-05'
implements:
  - symbol: src/core/db.ts::openDatabase
    type: function
  - symbol: src/core/db.ts::ensureSchema
    type: function
  - symbol: src/core/indexer.ts::indexSpecs
    type: function
---
# The database is a derived index

The LadybugDB graph stored in `.specgraph/` MUST be treated as a derived, reproducible
artifact — not as a source of truth.

The sources of truth are:
1. The spec markdown files in `specsDir/`
2. The source code files in the project

Running `specgraph index` followed by `specgraph analyze` MUST produce an identical graph
regardless of the prior DB state. The `indexSpecs` function enforces this by performing a
full schema drop-and-recreate on every run.

Consequences:
- The `.specgraph/` directory SHOULD be listed in `.gitignore`
- CI pipelines SHOULD rebuild the graph from scratch rather than caching it
- No graph data should ever be hand-edited directly in the DB
