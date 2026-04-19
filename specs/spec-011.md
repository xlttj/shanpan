---
id: SPEC-011
title: File nodes, containment hierarchy, and context-aware spec lookup
type: software_requirement
status: active
created: '2026-04-19'
depends_on:
  - SPEC-003
  - SPEC-005
  - SPEC-008
implements:
  - symbol: src/analyzer/indexer.ts::analyzeAndIndex
    type: function
  - symbol: src/cli/commands/mcp.ts::handleGetSpecsForSymbolWithContext
    type: function
  - symbol: src/cli/commands/check.ts::runCheck
    type: function
---
# File nodes, containment hierarchy, and context-aware spec lookup

Promotes files to first-class graph citizens and encodes the code-symbol
containment hierarchy as explicit CONTAINS edges, so that a spec query on a
method can automatically surface specs at the class and file level too.

## Background

The graph currently treats all code symbols as flat peers. A method and its
containing class have no structural edge between them. Files are not nodes at
all — only a string property on each `CodeSymbol`. This means:

- `get_specs_for_symbol` returns only specs that directly implement a given
  method, missing class- or file-level specs that also govern its behaviour.
- Config files (`composer.json`, `package.json`, `.env`, images, PDFs…) cannot
  be specced because there are no symbols inside them.
- `specgraph check --staged` is blind to specs on files that have no parseable
  symbols.

## File nodes

A `File` node is created for every source file processed during `analyze` and
for every file path that appears in a spec `implements` entry with `type: file`.

The node schema:
- `id` — relative file path (e.g. `composer.json`, `src/auth/session.ts`)
- `path` — same as id
- `ext` — file extension including the dot (`.ts`, `.json`, `""`)
- `kind` — `source` | `config` | `other`

Files without a language parser (JSON, YAML, images, Markdown, PDFs…) are
specced at file level only — no sub-nodes. Semantic verification of file
content (e.g. "does composer.json satisfy 'Use Symfony 8'?") is delegated to
the agent that reads the file; the graph's role is routing.

### Spec frontmatter for file-level specs

```yaml
implements:
  - symbol: composer.json
    type: file
```

Drift for file-level specs: file **deleted**, **renamed**, or **changed** — all
three surface in `specgraph check --staged`. Deleted/renamed is a hard block
(spec now points at nothing); changed is a soft warn (content may no longer
satisfy the spec).

## CONTAINS edges

`(File)-[:CONTAINS]->(CodeSymbol)` — every top-level symbol in a source file.

`(CodeSymbol)-[:CONTAINS]->(CodeSymbol)` — every method/nested symbol inside a
class or interface, derived from the dot-notation FQN already produced by the
parser (e.g. `UserService.signIn` is contained by `UserService`).

## MCP tool: `get_specs_for_symbol_with_context`

Returns specs for a symbol **and** its containing hierarchy, grouped by scope.

**Input**
```json
{ "symbolId": "src/auth/session.ts::UserService.signIn" }
```

**Output** — array ordered from most-specific to least-specific scope, with
empty scopes omitted:
```json
[
  { "scope": "symbol", "symbolId": "src/auth/session.ts::UserService.signIn", "specs": [...] },
  { "scope": "parent", "symbolId": "src/auth/session.ts::UserService",        "specs": [...] },
  { "scope": "file",   "symbolId": "src/auth/session.ts",                     "specs": [...] }
]
```

For a bare file path (no `::`) the result contains only the `file` scope.

## Acceptance criteria

- `File` nodes appear in the graph after `specgraph analyze`.
- Every top-level CodeSymbol has a `File-[:CONTAINS]->CodeSymbol` edge.
- Every method has a `CodeSymbol-[:CONTAINS]->CodeSymbol` edge from its class.
- A spec with `type: file` in its `implements` array links a `File` node via
  IMPLEMENTS after analyze.
- `specgraph check --staged` reports modified files that have file-level specs.
- `get_specs_for_symbol_with_context` returns specs at each populated scope level.
- Tests cover: CONTAINS edges built, file-level drift, context tool output.
