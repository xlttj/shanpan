---
id: INTENT-001
title: specgraph analyses itself
type: intent
status: active
created: '2026-04-05'
depends_on:
  - SPEC-002
  - SPEC-003
  - SPEC-006
  - SPEC-007
---
# specgraph analyses itself

specgraph uses its own tooling to describe its own modules. The spec files in `specs/`
are authored with `specgraph create` and `specgraph update`, and the IMPLEMENTS edges
in the graph are created by running `specgraph analyze --include src` against specgraph's
own TypeScript source.

This serves as the primary end-to-end integration test: if the graph can correctly link
its own spec files to its own code symbols, the tool is working as intended.

The expected state after running `specgraph index && specgraph analyze --include src`:
- 14+ Spec nodes (SPEC-001 through SPEC-011, RULE-001, RULE-002, INTENT-001)
- 2 BusinessRule nodes (from RULE-001 and RULE-002 being indexed as Spec nodes with
  type business_rule — BusinessRule stubs come from `defines_rules`, not from type)
- 20+ CodeSymbol nodes linked to SPEC-002 through SPEC-011 and RULE-002
- 0 drift warnings (all declared symbols exist in the extracted set)
