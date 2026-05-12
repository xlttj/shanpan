# specgraph

SpecGraph stores software specifications as a knowledge graph and exposes them to AI agents via the Model Context Protocol. Specs are Markdown files with structured YAML frontmatter that link to code symbols; the graph tracks which functions, classes, and files implement which requirements, and surfaces drift when code changes break those links.

## Requirements

Node.js 20 or later.

## Install

```bash
npm install -g specgraph
```

## Project setup

```bash
specgraph init           # create .specgraph/, write .specgraphrc.json, install agent skills and hooks
specgraph index          # parse spec Markdown files into the graph
specgraph analyze        # scan source code and link symbols to specs (incremental)
specgraph analyze --full # force a complete rebuild, ignoring cached state
```

`specgraph init` detects which AI coding tool the project uses and installs agent skills and hooks automatically. Supported tools: **Claude Code**, **Cursor**, **OpenCode**. Skills are written to the tool's client directory (e.g. `.claude/skills/`); hooks wire `specgraph analyze` and `specgraph check` into the agent's file-edit and session-end events.

Configuration is stored in `.specgraphrc.json` at the project root. If the file already exists when `init` runs it is left untouched.

## MCP configuration

Add the following to your MCP client's server configuration. `--project-dir` must be the absolute path to the project root that contains `.specgraph/`.

```json
{
  "mcpServers": {
    "specgraph": {
      "command": "specgraph",
      "args": ["mcp", "--project-dir", "/absolute/path/to/your/project"]
    }
  }
}
```

## Available MCP tools

**Specs and rules**
`list_specs` `get_spec` `list_rules` `get_specs_by_ref` `get_drift_report` `get_unspecced_symbols` `create_spec` `update_spec` `reindex`

**Symbol lookup**
`search_symbols` `get_specs_for_symbol` `get_specs_for_symbol_with_context` `get_symbols_for_spec`

`get_specs_for_symbol_with_context` returns specs grouped by scope: the symbol itself, its containing class hierarchy, its file, and specs linked to 1-hop call-graph neighbours (callers and callees). Prefer it over `get_specs_for_symbol`.

**Call graph**
`get_callers` `get_callees` `get_callers_transitive` `get_impact`

| Tool | Direction | Depth | Use for |
|------|-----------|-------|---------|
| `get_callers` | incoming | 1 hop | who directly calls this symbol |
| `get_callees` | outgoing | 1 hop | what this symbol directly calls |
| `get_callers_transitive` | incoming | BFS up to 10 | all entry points that lead to this symbol |
| `get_impact` | outgoing | BFS up to 10 | blast radius — all code affected by changing this symbol |

**Escape hatch**
`query_graph` — execute any read-only Cypher query directly against the graph.
