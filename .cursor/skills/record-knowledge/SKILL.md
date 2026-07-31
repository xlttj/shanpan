---
name: record-knowledge
description: Write a knowledge record when you learn something durable — a trap, an invariant, a decision and its reason, or an approach that was tried and abandoned. Use after coding, after debugging, and when the user states a rule or preference in chat.
---

# Record Knowledge

Append a record whenever something durable is learned. Use the "add_record" MCP
tool, then call "reindex" so it becomes queryable.

## The wire schema

Records are stored as one JSON object per line with two-character keys. You do
not normally write the file directly, but you must be able to read it:

| key | meaning |
|---|---|
| id | stable short id, assigned for you |
| kn | kind |
| sb | subject — symbol IDs or file paths this is about |
| cl | claim |
| bc | because — why the claim holds |
| pv | provenance |
| ts | UTC timestamp, YYYYMMDDHHIISS |
| ss | supersedes — id of the record this replaces |
| gv / wn / tn | given / when / then, behavior only |

## Choosing the kind

This is mechanical, not a judgement call:

- Writing a given/when/then scenario? It is **behavior**. "wn" and "tn" are
  required, "gv" is optional.
- Stating something that must always hold? **constraint**.
- A non-obvious trap that will bite the next person? **gotcha**.
- A choice made between alternatives? **decision** — and "bc" is mandatory,
  because a decision without its reason is worthless.
- Something tried and abandoned? **rejected** — also needs "bc".
- Why a module exists at all? **intent**.
- Two sources disagree and you cannot resolve it? **conflict**. Do not pick a
  winner; record the disagreement and let a human settle it.

## Provenance discipline

Set "pv" honestly. This is the single most important field, because everything
downstream trusts it:

- "u" when the user stated it in conversation.
- "a" when you observed it while working — a test failed, a build broke.
- "i" when you inferred it and have no hard source.
- "g:<sha>", "t:<path>", "n:<path>:<line>", "d:<path>" when it traces to a
  commit, test, code comment, or document.

**Never invent a reason.** If you do not know why a decision was made, omit
"bc" or record the claim with provenance "i". A plausible-sounding fabricated
rationale is worse than a gap, because it reads as authoritative and the next
agent will build on it.

**Never derive a decision or rejected record from code alone.** Code shows what
is, never why. Those two kinds need a commit message, a document, or the user.

## Corrections: supersede, never edit

Records are immutable. To correct one, write a new record with "supersedes" set
to the old id. The old record stays on disk as the reasoning trail; only the new
one is live.

This is not a stylistic preference — the knowledge file is merged with git's
union strategy, which is safe only because records never change in place.

## Writing good behavior records

"wn" is a single triggering event. "tn" is the expected outcome. Common failures:

- **Condition leaking into "tn"** — if "tn" contains "if", "when", "unless",
  "provided", "assuming", or "as long as", the condition belongs in "gv" and you
  probably need two records rather than one.
- **State in "wn"** — "wn" is an event, not a situation. "the cache is empty" is
  a precondition; it belongs in "gv".
- **Two events in "wn"** — split into two records.

## Capturing knowledge from chat

When the user states a rule, a preference, or a reason during conversation —
"we never do X because Y", "always use Z here" — that is a record with
provenance "u". These are the highest-value records in the system and they are
lost the moment the session ends unless you write them down. Do it at the time,
not at the end.

## After coding

Before you finish a task, ask:

1. Did I hit a trap someone else will hit? → **gotcha**
2. Did I choose between alternatives? → **decision** with the reason
3. Did I try something that did not work? → **rejected** with the reason
4. Did the user state a rule? → any kind, provenance "u"
5. Did a record I read turn out to be wrong? → supersede it

**This is not optional for decision-heavy work.** New modules, IDE integrations,
refactors between approaches, and anything you would explain in a commit body
need a record while the reason is still in context. Code and comments show
what is; they do not carry why. If you shipped a decision and did not record
it, do so before ending the session.

Record subjects must be real symbol IDs or file paths. A subject that resolves
to nothing shows up as drift — check the ID with "search_symbols" if unsure.

<!-- specgraph-managed-skill -->
