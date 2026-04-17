---
id: SPEC-009
title: Symbol search via MCP
type: software_requirement
status: draft
created: '2026-04-17'
depends_on:
  - SPEC-005
implements:
  - symbol: src/cli/commands/mcp.ts::handleSearchSymbols
    type: function
---
# Symbol search via MCP

Adds a `search_symbols` MCP tool that lets agents find code symbols by partial
name or concept — without knowing the exact `file::FQN` symbol ID that all
other tools require.

## Background

Every other MCP tool that accepts a `symbolId` parameter requires the caller to
know the precise fully-qualified ID (e.g. `src/core/db.ts::openDatabase`).
When an AI agent starts exploring an unfamiliar codebase it often knows only a
concept name ("signIn", "Tax", "calculateTotal") and must guess or scan files
to discover the full ID. This tool closes that gap.

## Tool: `search_symbols`

**Input schema**
```json
{
  "query": "signIn",
  "limit": 20,
  "kind": "function"
}
```

- `query` — required, non-empty string. Searched against the symbol's FQN.
- `limit` — optional, default 20, maximum 100.
- `kind` — optional filter; one of `class`, `function`, `method`, `interface`,
  `type`, `enum`, `constant`. When omitted, all kinds are returned.

An empty `query` returns `[]` immediately without touching the database.

**Output** — array ordered by `score` descending:
```json
[
  { "id": "src/auth/session.ts::signInWithGoogle",
    "fqn": "signInWithGoogle",
    "filePath": "src/auth/session.ts",
    "kind": "function",
    "score": 25 }
]
```

## Matching strategy

Three passes are evaluated in order. Results from all passes are merged,
deduplicated by `id`, and sorted by the highest score seen for that symbol.

| Pass | Condition | Score |
|------|-----------|-------|
| 1 | FQN exactly equals `query` (case-sensitive) | 100 |
| 2 | FQN contains `query` as a substring (case-insensitive) | 50 |
| 3 | CamelCase / snake_case boundary match (see below) | 25 |

**CamelCase boundary match (Pass 3):** Split the FQN on capital letters, `_`,
and `.` to produce a list of words. The symbol matches if `query` (lowercased)
is a prefix of any resulting word. For example, `"sign"` matches
`signInWithGoogle` because splitting on capitals yields `["sign","In","With",
"Google"]` and `"sign"` is a prefix of `"sign"`.

`%` and `_` in the user query are escaped before being used in Cypher CONTAINS
comparisons to prevent unintended wildcard behaviour.

## Implementation notes

`handleSearchSymbols` is extracted as a named top-level function (same pattern
as SPEC-008) and registered alongside the other tools in `runMcp`. The three
passes can be implemented as three separate Cypher queries followed by a merge
in TypeScript; avoid constructing a single enormous Cypher UNION for readability.

## Acceptance criteria

- Tool registered in `ListToolsRequestSchema` and handled in
  `CallToolRequestSchema`.
- Tests covering: exact match (score 100), substring match (score 50), camelCase
  boundary match (score 25), `kind` filter narrows results, empty `query`
  returns `[]`, query with `%` in it does not crash.
- Tool name listed in `EXPECTED_TOOLS` in `tests/mcp.test.ts`.
