---
id: SPEC-005
title: MCP Server
type: software_requirement
status: active
created: '2026-04-05'
implements:
  - symbol: src/cli/commands/mcp.ts::runMcp
    type: function
---
# MCP Server

Exposes the specgraph knowledge graph to AI agents via the Model Context Protocol (stdio).

`runMcp` starts a `@modelcontextprotocol/sdk` stdio server with the following tools:

**Read tools**: `list_specs`, `get_spec`, `list_rules`, `get_symbols_for_spec`,
`get_specs_for_symbol`, `get_drift_report`, `query_graph`.

**Write tools**: `create_spec`, `update_spec`.

`query_graph` rejects mutating Cypher keywords (CREATE, MERGE, SET, DELETE, REMOVE, DROP,
ALTER, CALL) to prevent accidental graph mutation. All other tools that need the DB open it
in read-only mode except for the write tools which delegate to `spec-writer.ts`.

The server uses `@modelcontextprotocol/sdk@1.0.4` pinned to avoid pulling in Express/Hono/
OAuth machinery that a stdio-only server does not need.
