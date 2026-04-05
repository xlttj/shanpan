---
id: SPEC-006
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

`createSpec` writes a new `.md` file with YAML frontmatter (id, title, type, status,
created, optional implements/depends_on/derives_from). Throws if the file already exists
or if `type` is not one of the allowed values. The filename is derived from the ID
(lowercased), e.g. `RULE-007.md` → `rule-007.md`.

`updateSpec` finds an existing spec by scanning `specsDir` for a matching `id` field
(filename is not assumed), then applies in-place mutations: add/remove symbol links in
`implements`, change `status`. The markdown body is preserved exactly. Uses gray-matter
to parse and re-serialize so YAML structure is maintained.

Both functions are called from `src/cli/commands/create.ts`, `src/cli/commands/update.ts`,
and `src/cli/commands/mcp.ts` to avoid duplicated file-writing logic.
