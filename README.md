# shanpan

Shanpan stores software specifications as a knowledge graph and exposes them to AI agents via the Model Context Protocol. Specs are Markdown files with structured YAML frontmatter that link to code symbols; the graph tracks which functions, classes, and files implement which requirements, and surfaces drift when code changes break those links.

## Requirements

Node.js 20 or later.

## Install

```bash
npm install -g shanpan
```

## Project setup

```bash
shanpan init           # create .shanpan/, write .shanpanrc.json, install agent skills and hooks
shanpan index          # parse spec Markdown files into the graph
shanpan analyze        # scan source code and link symbols to specs (incremental)
shanpan analyze --full # force a complete rebuild, ignoring cached state
```

`shanpan init` detects which AI coding tool the project uses and installs agent skills and hooks automatically. Supported tools: **Claude Code**, **Cursor**, **OpenCode**. Skills are written to the tool's client directory (e.g. `.claude/skills/`); hooks wire `shanpan analyze` and `shanpan check` into the agent's file-edit and session-end events.

Configuration is stored in `.shanpanrc.json` at the project root. If the file already exists when `init` runs it is left untouched.

## MCP configuration

Add the following to your MCP client's server configuration. `--project-dir` must be the absolute path to the project root that contains `.shanpan/`.

```json
{
  "mcpServers": {
    "shanpan": {
      "command": "shanpan",
      "args": ["mcp", "--project-dir", "/absolute/path/to/your/project"]
    }
  }
}
```

## Available MCP tools

<!-- Keep this list in sync with the server's ListTools output. tests/readme.test.ts
     fails if it drifts from src/cli/commands/mcp.ts. -->

**Knowledge records**
`get_records_for_symbol` `get_records_by_kind` `get_records_by_ref` `search_records` `add_record` `get_record_drift` `reindex`

`get_records_for_symbol` walks method → class → file, returning every record that applies to a symbol and its containing scopes — the same knowledge the PreToolUse hook injects. `get_records_by_kind` is best for reading `rejected` before proposing an approach and `gotcha` before touching unfamiliar code. `get_records_by_ref` finds `source` records that point at a given document. `add_record` appends knowledge (call `reindex` after to make it queryable).

**Symbol lookup**
`search_symbols` `get_undocumented_symbols`

`get_undocumented_symbols` lists code symbols that no record is about — the gaps in coverage.

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
