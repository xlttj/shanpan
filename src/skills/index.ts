export interface SkillDefinition {
  name: string;
  content: string;
}

// NOTE: skill text lives in template literals. Never put a backtick inside
// these strings — tsup strips the backslash from an escaped backtick, leaving
// a bare one that breaks the compiled output at runtime. Use double quotes for
// inline code instead.

const knowledgeLookup: SkillDefinition = {
  name: 'knowledge-lookup',
  content: `---
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

The PreToolUse hook injects the same knowledge automatically when you edit a
file, so you often get it without asking. Use the tools when you need more than
the hook shows, or before you have picked a file.

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
`,
};

const recordKnowledge: SkillDefinition = {
  name: 'record-knowledge',
  content: `---
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

Record subjects must be real symbol IDs or file paths. A subject that resolves
to nothing shows up as drift — check the ID with "search_symbols" if unsure.
`,
};

const checkKnowledge: SkillDefinition = {
  name: 'check-knowledge',
  content: `---
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
`,
};

export const SKILLS: SkillDefinition[] = [knowledgeLookup, recordKnowledge, checkKnowledge];
