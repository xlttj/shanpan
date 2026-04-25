---
title: Call-graph queries via MCP
type: software_requirement
status: active
created: '2026-04-17'
implements:
  - symbol: src/cli/commands/mcp.ts::handleGetCallers
    type: function
  - symbol: src/cli/commands/mcp.ts::handleGetCallees
    type: function
  - symbol: src/cli/commands/mcp.ts::handleGetImpact
    type: function
---
# Call-graph queries via MCP

Exposes the CALLS edge graph built by the code analyzer as three dedicated MCP tools,
so AI agents can answer "who calls this?" and "what breaks if I change this?" without
writing raw Cypher queries.

## Background

The analyzer already records every `static_call` and `instantiation` reference
as a `(CodeSymbol)-[:CALLS {kind, line}]->(CodeSymbol)` edge in LadybugDB.
These tools expose that data without requiring agents to write hand-crafted Cypher.

## Tools

### `get_callers`

Returns the set of code symbols that directly call a given symbol (1-hop
incoming CALLS edges).

**Input**
```json
{ "symbolId": "src/core/db.ts::openDatabase" }
```

**Output** — array of objects, empty array if none:
```json
[
  { "id": "src/cli/commands/analyze.ts::runAnalyze",
    "fqn": "runAnalyze",
    "filePath": "src/cli/commands/analyze.ts",
    "kind": "function" }
]
```

An unknown `symbolId` returns `[]`, not an error.

### `get_callees`

Returns the set of code symbols that a given symbol directly calls (1-hop
outgoing CALLS edges). Same input/output shape as `get_callers`, reversed
direction.

### `get_impact`

Returns all symbols reachable from a given symbol by following outgoing CALLS
edges transitively (blast-radius analysis). Uses BFS so each symbol appears
at most once, at the shallowest depth reached.

**Input**
```json
{ "symbolId": "src/core/db.ts::openDatabase", "maxDepth": 3 }
```
`maxDepth` defaults to 3, hard cap at 10.

**Output** — array with `depth` and `path` added:
```json
[
  { "id": "src/cli/commands/analyze.ts::runAnalyze",
    "fqn": "runAnalyze",
    "filePath": "src/cli/commands/analyze.ts",
    "kind": "function",
    "depth": 1,
    "path": ["src/core/db.ts::openDatabase",
              "src/cli/commands/analyze.ts::runAnalyze"] }
]
```

The seed symbol itself is excluded from the result. A visited set prevents
infinite loops on cyclic call graphs.

## Implementation notes

Each tool handler is extracted into a named top-level function
(`handleGetCallers`, `handleGetCallees`, `handleGetImpact`) rather than written
as an inline `if`-branch inside `runMcp`. This makes the symbol IDs stable and
addressable by the spec.

The BFS in `handleGetImpact` must guard against cycles and respect `maxDepth`.
Opening the database in read-only mode is sufficient for all three tools
(`openDatabase(projectDir, true)`).

## Acceptance criteria

- All three tools registered in `ListToolsRequestSchema` and handled in
  `CallToolRequestSchema`.
- `get_callers` and `get_callees` covered by at least 2 tests each (result
  found, unknown symbol → empty array).
- `get_impact` covered by at least 3 tests (1-hop, multi-hop, cycle safety).
- Tool names listed in `EXPECTED_TOOLS` in `tests/mcp.test.ts`.
