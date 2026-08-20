# shanpan

Shanpan parses your codebase into a knowledge graph — files, classes, methods, and the calls between them — and welds committable knowledge records (traps, invariants, decisions and their reasons) onto that graph, anchored anywhere from a single method to a whole directory. It serves both to AI coding agents over the Model Context Protocol: the relevant records are injected when an agent edits code, and drift is flagged when the code a record describes moves or disappears. Knowledge is stored as newline-delimited JSON committed alongside your code. Parsed languages: TypeScript, Python, PHP, SQL.

## Requirements

Node.js 20 or later. `npm install` compiles native tree-sitter grammars, so a C/C++ toolchain must be available.

## Install

Not yet published to npm — install from source:

```bash
git clone https://github.com/xlttj/shanpan.git
cd shanpan
npm install    # install dependencies and build (the prepare script runs the build)
npm link       # put the `shanpan` command on your PATH
```

`npm install` builds automatically via the `prepare` script. After editing the source, rebuild with `npm run build` (or `npm run dev` to rebuild on change). Run the tests with `npm test`.

## Project setup

Run these in the project you want shanpan to analyze:

```bash
shanpan init            # create .shanpan/, write .shanpanrc.json, install agent skills and hooks
shanpan analyze         # scan source into the code graph and re-index knowledge records (incremental)
shanpan analyze --full  # force a complete rebuild, ignoring cached state
shanpan records index   # rebuild only the graph's Record nodes from .shanpan/knowledge.ndjson
```

`shanpan init` detects which AI coding tool the project uses and installs agent skills and hooks automatically. Supported tools: **Claude Code**, **Cursor**, **OpenCode**. Skills are written to the tool's client directory (e.g. `.claude/skills/`); hooks wire `shanpan analyze` and `shanpan check` into the agent's file-edit and session-end events.

Configuration is stored in `.shanpanrc.json` at the project root and is meant to be committed, so a teammate's clone analyzes the same paths and languages instead of silently falling back to the defaults. If the file already exists when `init` runs it is left untouched. By default only TypeScript is parsed; widen it via `analyze.languages`, e.g. `{ "analyze": { "languages": ["typescript", "python", "php", "sql"] } }`.

`knowledge.notify` controls when an agent is asked to tell you about a record it just wrote. The default, `inferred`, covers records whose provenance is `a` or `i` — the ones that cite nothing anyone can open, so you are the only person who can say whether they are true. Set it to `all` to hear about every record, or `never` to switch it off. Checking a claim while the code is still in your head costs a sentence; the same correction weeks later costs re-reading the code first.

Commit `.shanpanrc.json`. It is the file that declares a repository uses shanpan — the graph and the generated skills are all ignored — and committing it means a teammate's fresh clone analyzes the same languages and paths instead of silently falling back to the defaults.

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
| `get_supertypes` | inheritance | transitive | the classes/interfaces a symbol extends or implements |

**Diagnostics**
`get_server_info` — report the running server build vs. the build that last analyzed the graph, whether they match, and node counts. Call it when a feature seems missing or results look stale: a long-lived MCP server can serve pre-update code until it is restarted.

**Escape hatch**
`query_graph` — execute any read-only Cypher query directly against the graph.
