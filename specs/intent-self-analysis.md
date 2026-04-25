---
title: specgraph analyses itself
type: intent
status: active
created: '2026-04-05'
---
# specgraph analyses itself

specgraph uses its own tooling to describe its own modules. The spec files in `specs/`
are authored with `specgraph create` and `specgraph update`, and the IMPLEMENTS edges
in the graph are created by running `specgraph analyze --include src` against specgraph's
own TypeScript source.

This serves as the primary end-to-end integration test: if the graph can correctly link
its own spec files to its own code symbols, the tool is working as intended.

The expected state after running `specgraph index && specgraph analyze --include src`:
- 16 Spec nodes with path-based IDs (e.g. `core/spec-parser`, `cli/cli-commands`)
- 2 BusinessRule nodes (BusinessRule stubs come from `defines_rules` in the two rule specs)
- 20+ CodeSymbol nodes linked via IMPLEMENTS edges
- 0 drift warnings (all declared symbols exist in the extracted set)
