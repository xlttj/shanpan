---
name: knowledge-lookup
description: Read what is already known about code before changing it — traps, invariants, past decisions, and approaches already tried and abandoned. Use before writing or modifying any code.
---

# Knowledge Lookup

Knowledge about this codebase lives in records, not in prose documents. Each
record is one claim about one thing, with a reason and a source. Read the
relevant ones before you touch code.

## Why this matters more than it looks

The most expensive thing lost between sessions is not what the code does — that
is in the code. It is **what was already tried and abandoned, and why**. Without
reading records you will re-propose approaches that were rejected for reasons
nobody wrote in the diff.

## Before the first edit

1. **Look up the symbol you are about to change**: call "get_records_for_symbol"
   with the symbol ID ("filePath::fqn", e.g. "src/core/drift.ts::computeDrift")
   or a bare file path. It walks method to class to file, so knowledge recorded
   against a class reaches you when you edit one of its methods.
2. **Check what was rejected**: call "get_records_by_kind" with kind "rejected"
   before proposing any approach that feels novel. If your idea is already
   there, say so and pick something else rather than repeating it.
3. **Search by topic** when you do not have a symbol yet: "search_records" does
   substring matching over claims and reasons.

How knowledge reaches you depends on the IDE:

- **Claude Code**: the PreToolUse hook runs "specgraph context" and injects
  records for the file being edited. You often get them without calling MCP.
- **Cursor**: there is no pre-edit injection. "specgraph rules" writes
  ".cursor/rules/*.mdc" files scoped by globs; Cursor auto-attaches a rule when
  a matching file is in context. Hooks regenerate rules on sessionStart and
  after Write. **Call "get_records_for_symbol" yourself before editing** when
  the file is not yet in context or you need more than the attached rule shows.

Use the MCP tools whenever the automatic path might have missed something.

## Reading a record

Kinds, in the order they should change your behaviour:

| kind | what it tells you |
|---|---|
| gotcha | a non-obvious trap — read before touching unfamiliar code |
| constraint | an invariant that must keep holding |
| rejected | already tried, abandoned; do not re-propose |
| decision | a settled choice and its reason; do not re-litigate |
| behavior | a given/when/then contract |
| intent | why the thing exists at all |
| conflict | sources disagree; needs a human to adjudicate |

Provenance tells you how much weight to give a claim:

- "u" — the user stated it. Strongest.
- "g:<sha>", "t:<path>", "n:<path>:<line>", "d:<path>" — traceable to a commit,
  a test, a code comment, a document. Verify against that source if it matters.
- "a" — an agent observed it while working.
- "i" — inferred by a model with no hard source. **Weakest. Treat as a lead, not
  a fact.** If it matters to your change, verify it and record what you find.

## During the work

If a record contradicts what you are about to do, stop and surface the conflict
before proceeding. Do not silently work around a constraint — either the record
is stale, which is worth recording, or your change is wrong.

## After the work

Record what you learned. See the "record-knowledge" skill.

<!-- specgraph-managed-skill -->
