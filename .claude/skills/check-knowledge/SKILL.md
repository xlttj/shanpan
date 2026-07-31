---
name: check-knowledge
description: Check whether knowledge records still match the code. Use after renaming, moving, or deleting code, and before finishing a session.
---

# Check Knowledge

## Two kinds of drift

**Hard drift** is detected automatically: a record subject no longer resolves to
any symbol or file. Call "get_record_drift" or run "specgraph check".

**Soft drift** cannot be detected mechanically: the symbol still exists but the
claim about it is no longer true. Only you or the user can spot this. It happens
whenever behaviour changes without the symbol being renamed.

## Fixing hard drift

For each unresolved subject, decide which happened:

- **The code moved or was renamed** → supersede the record with a corrected
  subject. Use "search_symbols" to find the new ID.
- **The code was deleted and the knowledge no longer applies** → supersede it
  with a record that says so, or leave it if it is simply obsolete.

Do not fix drift by editing the record in place. Records are immutable.

## The Stop hook

The Stop hook reports drift **once per drift state**. If you see a drift
warning, investigate it once and act. If the same warning does not reappear on
your next turn, it has already been reported — do not re-run the same checks
looking for it. Repeatedly re-investigating a warning that is not reappearing is
how a session gets stuck in a loop.

The hook also blocks when the knowledge file fails validation. Run
"specgraph records check" to see the offending lines; the graph is not being
updated from a file that does not parse.

## Before finishing a session

1. Run "get_record_drift" and resolve anything new.
2. Ask whether any record you read this session is now false — that is soft
   drift, and it is invisible to the tool.
3. Ask whether anything learned this session is unrecorded. See the
   "record-knowledge" skill.

<!-- specgraph-managed-skill -->
