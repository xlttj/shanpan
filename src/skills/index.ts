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
   with the symbol ID — a file path, then "::", then the fully-qualified name
   (e.g. "src/core/drift.ts::computeDrift") — or a bare file path. It walks
   method to class to file, so knowledge recorded against a class reaches you
   when you edit one of its methods.
2. **Check what was rejected**: call "get_records_by_kind" with kind "rejected"
   before proposing any approach that feels novel. If your idea is already
   there, say so and pick something else rather than repeating it.
3. **Search by topic** when you do not have a symbol yet: "search_records" does
   substring matching over claims and reasons.

How knowledge reaches you depends on the IDE:

- **Claude Code**: the PreToolUse hook runs "shanpan context" and injects
  records for the file being edited. You often get them without calling MCP.
- **Cursor**: there is no pre-edit injection. "shanpan rules" writes
  ".cursor/rules/*.mdc" files scoped by globs; Cursor auto-attaches a rule when
  a matching file is in context. Hooks regenerate rules on sessionStart and
  after Write. **Call "get_records_for_symbol" yourself before editing** when
  the file is not yet in context or you need more than the attached rule shows.
- **OpenCode**: no pre-edit injection and no rules generator. Knowledge is
  MCP-only — always call "get_records_for_symbol" before editing. The
  shanpan-drift plugin on session.idle surfaces record drift via
  check --format opencode; config shell hooks only run analyze and a plain
  check for logging.

Use the MCP tools whenever the automatic path might have missed something.

## Reading a record

Kinds, in the order they should change your behaviour:

| kind | what it tells you |
|---|---|
| gotcha | a non-obvious trap — read before touching unfamiliar code |
| constraint | an invariant that must keep holding |
| rejected | already tried, abandoned; do not re-propose |
| decision | a settled choice and its reason; do not re-litigate |
| source | a document to consult on a topic — go read it, do not treat it as a rule |
| behavior | a given/when/then contract |
| intent | why the thing exists at all |
| conflict | sources disagree; needs a human to adjudicate |

When you see a **source** record, it points at authoritative material (a URL or
a local file) for a topic. Read the referenced document before working on that
topic — it holds detail the record deliberately does not duplicate.

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

Record what you learned. See the "knowledge-record" skill.
`,
};

const knowledgeRecord: SkillDefinition = {
  name: 'knowledge-record',
  content: `---
name: knowledge-record
description: Write a knowledge record when you learn something durable — a trap, an invariant, a decision and its reason, or an approach that was tried and abandoned. Use after coding, after debugging, and when the user states a rule or preference in chat.
---

# Knowledge Record

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
| rf | ref — the document to consult, source only |

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
- Pointing at a document that covers a topic? **source** — see below.
- Two sources disagree and you cannot resolve it? **conflict**. Do not pick a
  winner; record the disagreement and let a human settle it.

## Source pointers — "for topic X, consult document Y"

When you learn in a session that a topic is documented somewhere — a wiki page,
an RFC, a local design doc — record it as a **source** so the next session finds
it. You know all of this from the conversation, so capture it at the time.

- **cl** = the topic (and what you will find there).
- **rf** = the document: a URL, or a repo-relative path. Required. One source
  per record — two documents are two records.
- **sb** (optional but powerful) = the code the topic relates to. With it, the
  pointer rides the same injection as code records: editing that code surfaces
  "consult Y". Without it, the pointer is pure domain knowledge, found by search.
- **pv** = usually "u" (the user told you) or "d:<path>" (you read it).

Example: "on VAT rounding across the EU, consult docs/tax/vat.md, relates to
src/tax/Vat.ts" →
add_record kind=source claim="VAT rounding across the EU" ref="docs/tax/vat.md"
subject="src/tax/Vat.ts" provenance=u

A source pointer can rot — the document moves or dies. Same discipline as any
record: when you find it moved, supersede it with the new location. shanpan
never checks URLs and only softly flags a missing local file, so this is on you.

## Provenance discipline

Set "pv" honestly. This is the single most important field, because everything
downstream trusts it:

- "u" when the user stated it in conversation.
- "a" when you observed it while working — a test failed, a build broke.
- "i" when you inferred it and have no hard source.
- "g:<sha>", "t:<path>", "n:<path>:<line>", "d:<path>" when it traces to a
  commit, test, code comment, or document.

**A d:/t:/n: pointer must name a file you actually opened.** shanpan rejects
the record at write time if the path is not on disk — a fabricated or mistyped
source cannot be saved. If you are reasoning from a document you did not read,
you have no source: use provenance "i", not a path you are guessing at.

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

## Anchoring: symbol, file, or directory

A subject can be a symbol ("src/cart.ts::Cart.total"), a file ("app/handlers.py"),
or a **directory** ("src/billing"). A directory anchor applies to that directory
and everything beneath it, recursively — so editing any file in the subtree
surfaces the record.

**Choose the most specific anchor that is still true.** A trap in one function
anchors at the symbol. A rule for one file anchors at the file. Anchor at a
directory only for a rule that genuinely spans the whole module — "every
consumer in this directory must be idempotent", not "this one class does X".

But "true" is not enough — the subject must be what the claim is **about**:

- **Anchor to what the claim is about, not what it sits near.** The subject is
  the code the claim constrains or describes — the place where, mid-edit, you
  would want this warning to fire. A gotcha about running the test suite is not
  "about" the package manifests (package.json, pyproject.toml, composer.json)
  that happen to define the projects; anchored there it never surfaces when
  someone actually runs tests. If editing the subject would not be the moment
  this record should appear, it is the wrong subject.
- **Repeated siblings are a parent in disguise.** If you are listing three
  package manifests (one per app) because the claim holds for all of them, the
  claim belongs to their shared module or root — anchor once, higher, not once
  per leaf.
- **Workflow knowledge rarely maps to a file's contents.** How to run tests,
  build, or toggle tooling is about a task, not a file. Anchor it at the
  directory whose work it governs (the test-tooling directory, say) — not a
  scatter of config leaves, and not the whole repo. If no directory fits, keep
  the subject to that work area and let "search_records" find it; that beats
  over-pinning it to an incidental file you happened to have open.
- **Anchor to the enforcer, not only the obeyer.** A rule about how something
  must behave belongs on the code that enforces it — the listener, the guard,
  the middleware — not only on the classes expected to comply. The agent who
  breaks the rule is editing the enforcer, so that is where the record must fire.

Two cautions:
- **Do not anchor above the module.** A subject like "apps" or "src" injects for
  every edit in a huge tree — noise that trains agents to ignore records. Anchor
  at the bounded-context / module root, not the repo root.
- **A directory anchor has weaker drift protection.** The directory keeps
  existing even when its meaningful contents move, so a module rule rots more
  quietly than a symbol-anchored one. Revisit module anchors deliberately.
`,
};

const knowledgeCheck: SkillDefinition = {
  name: 'knowledge-check',
  content: `---
name: knowledge-check
description: Check whether knowledge records still match the code. Use after renaming, moving, or deleting code, and before finishing a session.
---

# Knowledge Check

## Two kinds of drift

**Hard drift** is detected automatically: a record subject no longer resolves to
any symbol or file. Call "get_record_drift" or run "shanpan check".

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
"shanpan records check" to see the offending lines; the graph is not being
updated from a file that does not parse.

## Before finishing a session

1. Run "get_record_drift" and resolve anything new.
2. Ask whether any record you read this session is now false — that is soft
   drift, and it is invisible to the tool.
3. Ask whether anything learned this session is unrecorded. See the
   "knowledge-record" skill.
`,
};

const knowledgeBootstrap: SkillDefinition = {
  name: 'knowledge-bootstrap',
  content: `---
name: knowledge-bootstrap
description: Seed an existing project's knowledge base for the first time. Use once, when shanpan has just been added to a codebase that has history but no records yet.
---

# Knowledge Bootstrap

A codebase carries knowledge in places a scanner cannot guess: decisions in a
wiki, caveats in a CONTRIBUTING file, rationale in commit threads, conventions
only the team knows. Your job is to find where knowledge actually lives in THIS
project and drive the tools accordingly — not to trust defaults.

The "shanpan bootstrap" command is a deterministic scanner. It reliably reads
three mechanical sources — marker comments, git reverts, and structured decision
docs — but it only looks where you point it. You supply the judgment about where
that is and what is worth keeping.

## Do not assume — ask

Before running anything, ask the user:

1. **Where are decisions and design documents kept?** ADRs, an "architecture/"
   folder, a docs site, a wiki, long-lived issues? Do not assume "docs/adr".
2. **Are there sources outside the repo?** Notion, Confluence, Linear, a design
   doc drive. You may be able to reach these through connected tools even though
   the CLI cannot.
3. **Does the team use its own comment tags?** Beyond HACK/FIXME/XXX, some use
   KLUDGE, REVIEW, DEBT, or a "@"-prefixed convention.

If the user does not know or defers, survey the repo yourself (list top-level
dirs, look for docs/, adr/, architecture/, *.md at root) and propose what you
found before writing anything.

## The process

1. **Run "shanpan analyze" first.** Marker gotchas attach to files and symbols
   need to exist for later record subjects to resolve.

2. **Dry-run before writing.** Always start with:
   shanpan bootstrap --dry-run --doc <where-decisions-live> --marker <custom-tag>
   Point --doc at whatever the user told you (a file or a directory, repeatable).
   Add --marker for each project-specific tag. Pass --no-adr if the auto-detected
   ADR directories are wrong for this project.

3. **Review the candidate counts and cull.** A project with 400 FIXMEs does not
   have 400 pieces of knowledge — it has a backlog. If the marker count is huge,
   the markers are noise, not caveats: narrow the marker set, or skip markers and
   record only the genuinely load-bearing ones by hand. A thin, trusted base
   beats a large, noisy one.

4. **Commit the run** by dropping --dry-run once the counts look right.

5. **Read prose docs yourself.** The scanner only understands structured ADRs
   (an H1 title and a "## Decision" section). A prose design doc, a README
   rationale, a wiki page — read it and record what it decided with "add_record",
   provenance "d:<path>" (or "u" if it came from the user, not a file). Do not
   point --doc at unstructured prose and expect a good claim.

6. **Pull from sources only you can reach.** If the team keeps decisions in a
   connected tool (Notion, Confluence, Linear), read the relevant pages and
   record the decisions and rejected approaches you find. Provenance is a matter
   of judgment here: use "d:" with a URL-ish pointer, or "u" if the user
   confirmed it in conversation.

7. **Verify.** Run "shanpan records index" then "shanpan check". "check"
   fails (exit 1) on any record whose provenance cites a file that is not on
   disk — the fabrication net. Resolve those, and any unresolved subjects
   (usually a symbol id that needs "search_symbols" to fix), before you finish.

## Provenance stays honest

The scanner sets provenance for you: n:file:line for markers, g:sha for reverts,
d:path for docs. When YOU add records from judgment, set it just as honestly —
"d:" for something you read, "u:" for something the user stated, and "i:" only
when you inferred it with no source. Never invent a reason to fill a gap. See the
knowledge-record skill for the discipline.

This is where bootstrapping goes wrong at scale: reading a design.md and
recording claims about code you never opened, with the design doc typed in as
proof. Do not. A d:/t:/n: provenance must name a file you actually read, and
shanpan rejects the record if that path is not on disk — so a fabricated
source fails the write, and "check" fails the ones written straight to the file.
If a design doc describes code you have not verified exists, either record it as
a "source" ("consult this doc about X") or set provenance "i". Do not launder a
guess into a citation.

Two more mistakes are easy to make in bulk: setting "t:" (a test file) on a
document that is not a test — a migrated spec or ADR is "d:", not "t:" — and
guessing a rationale the source does not state. Both compound across a big
bootstrap. Slow down on provenance.

## Anchor module rules at the module, not a stand-in file

Much bootstrapped knowledge is module-wide ("this whole module does X"). Do
not pin such a rule to one representative class — anchor it at the module
directory (e.g. "src/billing/handlers"), which applies to the whole subtree and
surfaces for every file in it. Anchor at a concrete symbol or file when the rule
is that local, and never above the module root. See the knowledge-record skill's
anchoring section.

## This runs once

Bootstrap seeds a base. It is not how the knowledge base stays current — that is
the per-task loop in knowledge-lookup and knowledge-record. Bootstrap is
deliberately partial; say so to the user when you finish, and point them at the
ongoing loop.
`,
};

export const SKILLS: SkillDefinition[] = [
  knowledgeLookup,
  knowledgeRecord,
  knowledgeCheck,
  knowledgeBootstrap,
];
