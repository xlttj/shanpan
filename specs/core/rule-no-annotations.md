---
title: No annotations in source code
type: business_rule
status: active
created: '2026-04-05'
---
# No annotations in source code

Source code files MUST NOT contain any specgraph-specific annotations, comments, or
decorators that reference spec IDs, rule IDs, or graph metadata.

The connection between code and specs is declared exclusively in the spec files via the
`implements` frontmatter array. Code has no knowledge of the spec system.

This rule enables specgraph to be applied to legacy codebases without modifying a single
source file, and ensures that spec coverage can be added, changed, or removed without
touching the code under observation.

Any tooling that requires code annotations to function is incompatible with this rule.
