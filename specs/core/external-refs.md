---
title: External References (refs)
type: software_requirement
status: draft
created: '2026-04-25'
---
# External References (refs)

Specs may carry a `refs` list of external URLs that provide context for agents working on the spec — e.g. upstream RFCs, API documentation, design documents hosted outside the repo.

## Schema

```yaml
refs:
  - https://example.com/rfc-1234
  - https://docs.example.com/api/v2
```

Each entry must be a full URL beginning with `http://` or `https://`. Relative paths and `file://` URIs are rejected at write time.

## Graph representation

Each unique URL is stored as a `Ref` node (`id = url`). A `REFERENCES` edge connects the `Spec` to each of its `Ref` nodes. Ref nodes are deduplicated: if two specs reference the same URL, a single `Ref` node is shared between them.

## Tooling

- **CLI create**: `--ref <url>...`
- **CLI update**: `--add-ref <url>...` / `--remove-ref <url>...`
- **MCP create_spec**: `refs` array field
- **MCP update_spec**: `addRefs` / `removeRefs` array fields
- **MCP get_specs_by_ref**: returns all specs that reference a given URL
