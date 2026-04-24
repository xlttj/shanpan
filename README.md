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
specgraph init      # create .specgraph/ in your project root
specgraph index     # parse spec Markdown files into the graph
specgraph analyze   # scan source code and link symbols to specs
```

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

`list_specs` `get_spec` `list_rules` `get_symbols_for_spec` `get_specs_for_symbol` `get_specs_for_symbol_with_context` `get_drift_report` `get_unspecced_symbols` `search_symbols` `get_callers` `get_callees` `get_impact` `create_spec` `update_spec` `reindex` `query_graph`
