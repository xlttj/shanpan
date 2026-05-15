export interface SkillDefinition {
  name: string;
  content: string;
}

const specLookup: SkillDefinition = {
  name: 'spec-lookup',
  content: `---
name: spec-lookup
description: Find specs and business rules that govern a symbol, file, or topic before implementing. Use this before writing code to understand what requirements apply.
---

# Spec Lookup

Before implementing a feature or modifying code, identify the specs that govern the affected area.

## When to use

- Before writing or modifying code in a function, class, or file
- When asked to implement a feature — find existing intent and business rule specs first
- When a symbol name or file path is known and you want to know what it must satisfy

## Steps

1. **Find specs for a known symbol**: call \`get_specs_for_symbol_with_context\` with the symbol's fully-qualified ID (\`filePath::fqn\`, e.g. \`src/core/parser.ts::parseSpecFile\`). This returns specs for the symbol, its class hierarchy, its file, and its 1-hop call-graph neighbours — all in one call.

2. **Search by topic when no symbol is known**: call \`search_symbols\` with a keyword, then call \`get_specs_for_symbol_with_context\` on each result.

3. **Browse all specs**: call \`list_specs\` (optionally filter by \`type\` or \`status\`) to see what exists before designing something new.

4. **Fetch a specific spec**: call \`get_spec\` with the spec ID (e.g. \`core/order-validation\`) to read the full requirement text including \`acceptance_criteria\`.

## Choosing the right tool

| Situation | Tool |
|-----------|------|
| You have a symbol path | \`get_specs_for_symbol_with_context\` |
| You have a keyword | \`search_symbols\` → \`get_specs_for_symbol_with_context\` |
| You want to browse | \`list_specs\` |
| You need full spec text + criteria | \`get_spec\` |
| Who directly calls this symbol? | \`get_callers\` |
| What does this symbol directly call? | \`get_callees\` |
| What entry points transitively reach this symbol? | \`get_callers_transitive\` |
| What code is affected if I change this symbol? | \`get_impact\` |

## Call-graph tools

CALLS edges exist only for languages with static analysis support (TypeScript, PHP).
SQL symbols have no CALLS edges — \`get_callers\`, \`get_callees\`, \`get_callers_transitive\`,
and \`get_impact\` will return empty results for \`.sql\` symbols. Use \`get_specs_for_symbol_with_context\`
to find specs linked directly to a SQL table, view, procedure, or trigger.

\`get_callers\` and \`get_callees\` return 1-hop neighbours. Use them to understand the
immediate call context before writing or modifying code.

\`get_callers_transitive\` walks incoming CALLS edges up to maxDepth hops (default 3).
Use it to find all entry points — controllers, CLI handlers, event listeners — that
eventually invoke the target. Each result includes \`depth\` and \`path\` so you can
see the full call chain from entry point to target.

\`get_impact\` walks outgoing CALLS edges transitively. Use it before refactoring to
see what code would be affected by a change.

\`get_specs_for_symbol_with_context\` also returns specs from 1-hop call-graph
neighbours (scopes \`callers\` and \`callees\`). Each entry in those scopes includes a
\`viaSymbolId\` field showing which neighbouring symbol linked the spec. This means
you often get enough context in a single call without needing to chain tools.

## Notes

- Prefer \`get_specs_for_symbol_with_context\` over \`get_specs_for_symbol\` — it includes
  hierarchy (symbol → class → file) AND call-graph neighbours in one call.
- A symbol with no linked specs is not necessarily unspecced — use \`get_unspecced_symbols\`
  to see what genuinely lacks coverage.
- Always read \`acceptance_criteria\` in the spec before writing code — these are the
  conditions your implementation must satisfy.
`,
};

const createSpec: SkillDefinition = {
  name: 'create-spec',
  content: `---
name: create-spec
description: Create a new spec file with correct frontmatter and link it to code symbols. Use when a feature or rule needs to be formally specified before or after implementation.
---

# Create Spec

Create a new spec file using the \`create_spec\` MCP tool, then edit the file to add
structured acceptance criteria.

## What a spec is — and is not

A spec describes **behaviour**: why the system should do something, and how it must
respond under defined conditions. It is the contract a future change must not break.

A spec is **not** a description of the code that currently exists. Do not enumerate
columns, parameter lists, type signatures, class hierarchies, or join graphs that
already live in the source. That information is owned by the code; duplicating it
in a spec creates silent drift the moment the code changes.

Rule of thumb: if removing this paragraph would lose **a behavioural commitment**
(an invariant, a rejection rule, an outcome under specific input), keep it. If
removing it only loses **a description of what was built**, delete it — the code is
the source of truth for that.

## Spec types

| type | Use for |
|------|---------|
| \`intent\` | High-level goals and product decisions ("why we build this") |
| \`business_rule\` | Domain constraints that must always hold ("must / must not / always") |
| \`software_requirement\` | Concrete behaviour with acceptance criteria |
| \`project_spec\` | Cross-cutting architecture or setup decisions |

## Steps

1. **Call \`create_spec\`** with title, type, and optional dir:
   \`\`\`
   create_spec({
     title: "Order Downgrade Scheduling",
     type: "software_requirement",
     dir: "orders"
   })
   \`\`\`
   The spec ID is derived from the path: \`orders/order-downgrade-scheduling\`.
   The file is created with \`status: draft\`.

2. **Add acceptance criteria** — open the generated \`.md\` file and add
   \`acceptance_criteria\` to the YAML frontmatter. Each entry is a \`{given, when, then}\`
   object. Merge multi-step Given/And into one string; same for When and Then:
   \`\`\`yaml
   acceptance_criteria:
     - given: "a customer with an active Professional subscription not in a trial"
       when: "they request a downgrade to Basic and confirm"
       then: "the downgrade is scheduled for the next billing cycle and a confirmation email is sent"
   \`\`\`
   Write the body as a short prose description of what the code must do and why.

3. **Link symbols if known**: pass \`symbols\` to \`create_spec\`, or add them later:
   \`\`\`
   update_spec({ id: "orders/order-downgrade-scheduling", addSymbols: ["src/Orders/DowngradeService.php::schedule"] })
   \`\`\`

4. **Call \`reindex\`** so the graph reflects the new spec.

## One spec, one primary symbol

A \`software_requirement\` spec describes the behaviour of **one** thing — usually one
class, one function, or one SQL object. The \`implements:\` list may contain multiple
symbols, but they must form a single cohesive unit (a class plus the helper it owns,
a SQL view plus the trigger that maintains it).

When the body needs to describe how data flows from a SQL table *through* a PHP
processor *into* an external system, that is at least two specs — one per consumer,
each linked to its own symbols. The SQL table's spec stops at "what the table
guarantees about its rows"; how something downstream uses it belongs in that
consumer's spec.

## Splitting heuristics

- The prose describes behaviour of symbols in different files / languages / layers → split
- One \`acceptance_criteria\` entry that could independently fail → candidate for its own spec
- More than 5 \`acceptance_criteria\` entries → stop and actively check for mixed concerns before adding more
- "Must not" / "Must always" / "SHALL NOT" phrasing → \`business_rule\`, not \`software_requirement\`
- Two behaviours owned by different teams → two specs
- If you need "and also" to describe it → split it
- UI behaviour (navigation, forms, display rules) and domain/application behaviour → always separate specs
- One spec per architectural layer: domain aggregate logic, application command handling, and UI are always different specs
- One feature typically yields: 1 \`intent\` + 1–3 \`business_rule\` + 1–3 \`software_requirement\`
- Every feature needs an \`intent\` spec; if none exists yet, create it first

## Anti-patterns — do not include

- **Column / field / parameter tables** that mirror the schema or signature. The code
  already declares these; the spec's job is to say *which of them carry behavioural
  obligations* (e.g. "must not be null", "must equal the upstream value"), not to
  list them.
- **"Here is what was built"** prose written after implementation. Rewrite it as
  *"here is what the system must do"* — present tense, observable outcomes. If you
  cannot phrase it that way, it does not belong in the spec.
- **Implementation choices** that could be swapped without changing observable
  behaviour (which library, which SQL dialect feature, which class is injected).
  These belong in code comments or an ADR.
- **Historical change logs** in the spec body. Use \`refs:\` for ticket links; the
  story of how the spec evolved lives in git history, not in the spec.

## Symbol linking rules

- Link to the class or method that **does** the work — the one that holds logic and makes decisions
- Do NOT link to data carriers: Command, DTO, ValueObject, Event classes carry data but implement nothing
- When in doubt: if the class has no methods beyond a constructor and getters, it is a data carrier — skip it

**SQL symbols** use kinds \`table\`, \`view\`, \`procedure\`, \`trigger\` — link them directly:
\`\`\`yaml
implements:
  - symbol: db/schema/orders.sql::orders
    type: table
  - symbol: db/procs/billing.sql::confirm_order
    type: procedure
\`\`\`
The symbol ID is always \`filePath::objectName\` (schema prefix stripped, no quoting).

**SQL files with no CREATE statements** (cleanup scripts, migration runners, schema
teardown files) produce no extractable symbols. Link the file itself using \`type: file\`:
\`\`\`yaml
implements:
  - symbol: db/pipeline/01-cleanup.sql
    type: file
\`\`\`
The symbol value is the relative file path with no \`::\` suffix.
Do NOT use \`type: table\`, \`type: unknown\`, or any other kind here — only \`type: file\`
causes the system to resolve the link against the filesystem rather than the symbol
index. Any other type will produce a drift warning on every \`analyze\` run.

## Notes

- Spec ID = relative file path without \`.md\` (e.g. \`orders/order-downgrade-scheduling\`)
- \`status: draft\` means planned but not yet implemented — change to \`active\` when done
- Write present tense ("the system rejects…"), not past tense ("the system was changed to reject…")
- A spec the code can satisfy in more than one way is a *good* spec; a spec that
  describes one specific implementation is documentation, not a contract
`,
};

const planFeature: SkillDefinition = {
  name: 'plan-feature',
  content: `---
name: plan-feature
description: Decompose a new feature into intent, business rule, and software requirement specs before writing any code. Run this at the start of every feature task.
---

# Plan Feature

The goal is to gather exactly enough information to write **precise, unambiguous specs**.
Precise means: every \`acceptance_criteria\` entry is independently testable, every
\`business_rule\` has no undefined edge cases, and every \`software_requirement\` names
a concrete actor, trigger, and observable outcome.

## When to use

- At the very start of a feature task, before touching any code
- When handed a prompt, JIRA issue, user story, or design note to implement

## How to interview

**Do not use a fixed question list.** Instead:

1. Read the input (prompt / ticket / design doc) carefully.
2. Draft the spec tree you *would* write right now based only on what is given.
3. Identify every field you cannot fill in precisely:
   - A \`given\` that is vague ("a valid user") — what makes a user valid here?
   - A \`then\` that is unmeasurable ("it works correctly") — what exactly is observed?
   - A \`business_rule\` constraint implied but not stated — what are the limits?
   - An actor or trigger that is ambiguous — who initiates this, under what condition?
   - An error case mentioned but not described — what happens, what does the user see?
   - A scope boundary that is unclear — does X fall inside or outside this change?
4. Ask **only** about those gaps, one question at a time. Do not ask about things
   already answered in the input, even implicitly.
5. After each answer, re-evaluate: can you now write that field precisely?
   If yes, move to the next gap. If a new gap surfaced, ask about that.
6. Stop asking when every field in your draft spec tree can be written without
   placeholders, qualifiers like "as needed", or assumed behaviour.

## Precision checklist — gaps that block spec writing

Use this to identify what to ask about, not as a question script:

- [ ] Who or what initiates the behaviour? (actor / trigger)
- [ ] What is the exact precondition? (not just role, but state)
- [ ] What is the observable outcome? (what changes, what is returned, what is shown)
- [ ] What are the rejection / error cases and their outcomes?
- [ ] Are there quantities, thresholds, or time constraints?
- [ ] What must never happen, regardless of implementation? (invariants)
- [ ] What is explicitly excluded from this change?
- [ ] Which module or service owns this? (needed to find symbols later)

## Decomposition

From the completed picture, build a spec tree:

\`\`\`
intent                       <- the "why" (one per feature, always required)
  |-- business_rule          <- each hard invariant ("must / must not / always / never / SHALL NOT")
  |-- business_rule          <- each rejection / idempotency rule with defined outcome
  |-- software_requirement   <- domain / aggregate behaviour (one per logical concern)
  |-- software_requirement   <- application layer behaviour (commands, handlers)
  +-- software_requirement   <- UI behaviour (forms, navigation, search) -- always separate from domain
\`\`\`

One spec per architectural layer. Never put domain aggregate logic and UI behaviour in the same spec.

Create each spec using \`create_spec\`, all with \`status: draft\`.

- \`intent\`: body = motivation and user benefit; no \`acceptance_criteria\`; add "## Out of scope" section
- \`business_rule\`: rules go in the **markdown body** under a \`## Rules\` heading as a bullet list —
  there is no \`rules:\` frontmatter field; the only valid frontmatter fields are
  \`title\`, \`type\`, \`status\`, \`created\`, \`implements\`, \`acceptance_criteria\`, \`refs\`, \`defines_rules\`
- \`software_requirement\`: add \`acceptance_criteria\` to the frontmatter:

\`\`\`yaml
acceptance_criteria:
  - given: "specific, concrete precondition"
    when: "exact action or event"
    then: "observable, testable outcome"
\`\`\`

Merge multi-step Given/And into one \`given\` string. Same for When and Then.
For Scenario Outline / examples: one entry per concrete input row.

## Confirming the plan

After creating all specs, show the user:
\`\`\`
query_graph("MATCH (s:Spec {status: 'draft'}) RETURN s.id, s.title, s.type ORDER BY s.type, s.id")
\`\`\`
Ask: "Does this cover all cases, or are there gaps?" Do not start implementation until confirmed.

## Notes

- A small feature with one scenario and no hard constraints needs only one
  \`software_requirement\` — do not over-split
- If the input already answers everything precisely, skip straight to spec creation
- Never fill a gap with an assumption — ask
`,
};

const trackProgress: SkillDefinition = {
  name: 'track-progress',
  content: `---
name: track-progress
description: Check what specs remain unimplemented and mark specs active as you complete them. Use throughout a feature implementation to stay oriented.
---

# Track Progress

The spec graph is the task list. \`status: draft\` = not yet implemented.
\`status: active\` = implemented and linked to code.

## Checking what remains

Run at any point to see open work for the current feature:

\`\`\`
query_graph("MATCH (s:Spec {status: 'draft'}) RETURN s.id, s.title, s.type ORDER BY s.type, s.id")
\`\`\`

For a broader picture including broken links:

\`\`\`
get_drift_report()
\`\`\`

Drift = spec has an \`implements\` link but the symbol no longer exists.
These are higher priority than unlinked drafts.

## Marking a spec implemented

After writing and verifying the code that satisfies a spec:

1. Find the implementing symbol ID (format: \`src/Module/File.php::ClassName::method\`).
   Use \`search_symbols\` if unsure.

2. Link it and mark active in one sequence:
   \`\`\`
   update_spec({ id: "orders/order-downgrade-scheduling", addSymbols: ["src/Orders/DowngradeService.php::schedule"] })
   update_spec({ id: "orders/order-downgrade-scheduling", status: "active" })
   \`\`\`

3. Call \`reindex\` after every 3–5 specs so the graph stays current.

## Definition of done for a feature

A feature implementation is complete when **all three** conditions hold:

1. \`query_graph("MATCH (s:Spec {status: 'draft'}) ..."\` returns no rows for the specs
   created during planning
2. \`get_drift_report()\` returns no new drift entries
3. Every \`software_requirement\` spec has at least one entry in \`implements\`
   (verify with \`get_spec\` on each)

Do not close a task or end a session until these conditions are confirmed.

## Handling blocked specs

If a spec cannot be implemented in this session (dependency, missing info):
- Do not mark it \`active\`
- Add a one-line note to the spec body starting with \`> Blocked:\` explaining why
- Report the blocked spec IDs to the user before stopping

## Notes

- \`business_rule\` specs often have no direct \`implements\` link — they are enforced
  across multiple symbols. Mark them \`active\` when all their \`acceptance_criteria\`
  are covered by tests or by linked \`software_requirement\` specs.
- Never mark a spec \`active\` speculatively — only after the code exists and is linked.
`,
};

export const SKILLS: SkillDefinition[] = [specLookup, createSpec, planFeature, trackProgress];
