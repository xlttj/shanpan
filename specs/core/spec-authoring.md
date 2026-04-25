---
title: Spec Authoring
type: software_requirement
status: active
created: '2026-04-05'
implements:
  - symbol: src/core/spec-writer.ts::createSpec
    type: function
  - symbol: src/core/spec-writer.ts::updateSpec
    type: function
---
# Spec Authoring

Provides the shared logic for creating and updating spec markdown files, used by both
the CLI commands and the MCP server.

`createSpec` writes a new `.md` file with YAML frontmatter (title, type, status, created,
optional implements, optional acceptance_criteria). Throws if the file already exists or
if `type` is not one of the allowed values. The filename is derived from the title slug
(e.g. `"Auth Login"` → `auth-login.md`). An optional `dir` parameter places the file in
a subdirectory under specsDir.

`updateSpec` resolves the spec file path directly from a path key (e.g. `core/spec-parser`
→ `specsDir/core/spec-parser.md`), then applies in-place mutations: add/remove symbol
links in `implements`, change `status`. The markdown body is preserved exactly. Uses
gray-matter to parse and re-serialize so YAML structure is maintained.

Both functions are called from `src/cli/commands/create.ts`, `src/cli/commands/update.ts`,
and `src/cli/commands/mcp.ts` to avoid duplicated file-writing logic.
