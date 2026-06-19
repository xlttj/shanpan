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

## Coding workflow

Follow this loop for every coding task. Do not skip steps.

### Before the first edit

1. **If the IDE injected a "[specgraph]" message** listing specs for the file you are
   about to edit — read it now. That is the spec context for this edit, pre-loaded by
   the PreToolUse hook. Call \`get_spec\` on any listed spec to read the full criteria.
2. **If no "[specgraph]" message appeared** (hook not configured, file not yet indexed,
   or no specs exist for this file): call \`get_specs_for_symbol_with_context\` for the
   symbol(s) you are about to touch, or \`search_symbols\` if the symbol path is unknown.
3. Read the \`acceptance_criteria\` and \`## Rules\` sections of any returned specs.
4. If no specs exist for the affected symbols, note that and continue — absence of
   specs is not permission to ignore the area. Use \`get_unspecced_symbols\` to confirm
   the symbol is genuinely unspecced rather than linked under a different ID.
5. If a spec's acceptance criteria would be *violated* by what you are about to
   implement, **stop and surface the conflict to the user** before writing any code.
   Do not silently implement something that contradicts a spec — the spec is the
   contract. Ask: "This would break criterion X in spec Y. Should we update the spec,
   change the approach, or accept the deviation?"

### During implementation

5. If you discover during coding that a spec is *incomplete* — it does not cover a
   case you are implementing — note it. Do not expand the spec silently; flag it to
   the user: "The spec doesn't cover this edge case. Should I add a criterion, or is
   this behaviour intentionally unspecced?"

### After coding

6. Once the implementation is done, compare what you built against the acceptance
   criteria and rules you read in step 2. Ask yourself:
   - Did any criterion change in meaning (even if the symbol still exists)?
   - Did you make a decision during implementation that the spec's \`## Decisions\`
     section should record?
   - Did you discover something about the domain that is not captured anywhere?
7. If yes to any of the above: update the spec **in the same session** before
   closing the task. Use \`update_spec\` for symbol links; edit the file directly
   for body content (criteria, decisions, context).
8. Run \`reindex\` after any spec edit.

### Capturing chat insights

New requirements, constraints, and decisions often emerge during the conversation
between user and agent — not from code, but from clarifying questions and answers.
These are spec material. At the end of a coding session:

- Scan the conversation for statements like "actually it should always…",
  "we decided not to…", "this only applies when…", or "the reason for this is…"
- If any of these are behavioural commitments not yet in a spec, offer to create or
  update the relevant spec. Do not assume the user will remember to do it later.
  Concrete prompt: "During this session we established that [X]. Should I add this
  to spec [Y] under \`## Decisions\` / as a new criterion / as a business rule?"

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

| type | Use for | Has \`acceptance_criteria\`? |
|------|---------|---------------------------|
| \`intent\` | High-level goals and product decisions ("why we build this") | No |
| \`business_rule\` | Domain constraints that hold **at all times** — no trigger needed ("must / must not / always / SHALL NOT") | No — rules go in markdown body under \`## Rules\` |
| \`software_requirement\` | Observable behaviour triggered by a specific event | Yes |
| \`project_spec\` | Cross-cutting architecture or setup decisions | No |

**Type decision rule**: If you find yourself writing \`given/when/then\` criteria — the type is
\`software_requirement\`. A \`business_rule\` never has \`acceptance_criteria\`; its constraints
hold at all times without a trigger to fire them. If the rule only applies *when something
happens*, it is a \`software_requirement\` criterion, not a \`business_rule\`.

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

2. **Add content to the spec body**:
   - For \`software_requirement\`: add \`acceptance_criteria\` to the YAML frontmatter.
     Each entry is a single \`{given, when, then}\` triple. See *Writing acceptance
     criteria precisely* below for the rules on what goes in each field.
   - For \`business_rule\`: add a \`## Rules\` heading to the markdown body and list
     each rule as a bullet. Do **not** add \`acceptance_criteria\` to frontmatter —
     business rules have no trigger; they hold unconditionally.
   - For \`intent\`: write motivation and user benefit in the markdown body; no
     \`acceptance_criteria\` or \`## Rules\` needed.
   - **Always write a meaningful body**, regardless of type. See *Spec body structure*
     below for what to include.

3. **Link symbols if known**: pass \`symbols\` to \`create_spec\`, or add them later:
   \`\`\`
   update_spec({ id: "orders/order-downgrade-scheduling", addSymbols: ["src/Orders/DowngradeService.php::schedule"] })
   \`\`\`

4. **Call \`reindex\`** so the graph reflects the new spec.

## Spec body structure

The frontmatter captures *what* the system must do. The body captures *why* —
the domain reasoning, decisions, and context that explain those commitments. A
spec body without rationale is a contract without reasoning: implementers can
satisfy the letter while violating the intent.

**Do not repeat the frontmatter in the body.** The body is not a prose restatement
of \`acceptance_criteria\` or \`## Rules\`. It adds what the structured fields cannot.

### software_requirement body

\`\`\`markdown
## Context

[1–3 sentences: the domain situation or user need that makes this behaviour
necessary. Why does this requirement exist? What breaks if it is absent?]

## Decisions

- **[Decision title]**: [Why this approach was chosen over the alternatives.
  Relevant constraint, tradeoff, or domain fact that motivated the choice.]
- ...

## Out of scope

- [Explicit exclusion — behaviour that is intentionally NOT covered and why]
\`\`\`

Rules for \`## Context\`: one paragraph, no implementation details, no column lists.
It answers: *"What domain problem does this requirement solve?"*

Rules for \`## Decisions\`: only include decisions that shaped the acceptance criteria
directly — e.g. why the lookup uses 5 keys instead of 3, why NULL is treated as
an error rather than a default, why priority ordering matters. Omit implementation
choices (which class, which library, which SQL feature).

Rules for \`## Out of scope\`: list behaviour that a reader might reasonably expect
to be here but is not. Explicitly naming exclusions prevents scope creep.

### business_rule body

\`\`\`markdown
## Rules

- [Rule as an invariant — "must", "must not", "never", "always", "SHALL NOT"]

## Rationale

[Why this rule exists: regulatory requirement, domain invariant, contractual
obligation, safety constraint, product decision. One sentence per rule if they
have different reasons; one paragraph if they share a common motivation.]

## Out of scope

- [Situations the rule intentionally does not govern]
\`\`\`

Each rule bullet is a single unconditional statement. If you feel the need to add
a qualification after the bullet, that qualification is either a separate rule or
a \`software_requirement\` criterion — not a bullet modifier.

The \`## Rationale\` is mandatory for \`business_rule\`. A rule without rationale
cannot be challenged, revised, or retired correctly. "Why does this constraint
exist?" must have an answer in the spec.

### intent body

\`\`\`markdown
[Opening paragraph: the user need or system problem being addressed. Written from
the user's perspective, not the system's.]

## User benefit

[Observable improvement for the user when this intent is fulfilled — not features,
but outcomes. What can the user do or avoid that they could not before?]

## Decisions

- **[Scope or product decision]**: [Rationale — why this decision, not the alternative]

## Out of scope

- [Explicit product exclusion — adjacent problems intentionally deferred or delegated]
\`\`\`

### project_spec body

\`\`\`markdown
## Overview

[What this cross-cutting concern governs and why it requires a dedicated spec
rather than being captured in individual \`software_requirement\` specs.]

## Decisions

- **[Architectural or process decision]**: [Rationale]

## Out of scope

- [Systems or concerns explicitly not governed here]
\`\`\`

## Writing acceptance criteria precisely

The format is intentionally three single strings — no nested AND/OR fields — because
it forces clarity about what is a precondition, what is a trigger, and what is an
outcome. Most translation mistakes come from blurring these three.

### What each field is

- **\`given\`** — the complete precondition: actor state, system state, and any data
  that must be true *before* the trigger fires. All "AND" preconditions stack into
  this one string as prose.
- **\`when\`** — the single triggering event or action. One verb, one initiator
  (a user action, a scheduled job, an incoming message, a CLI invocation).
- **\`then\`** — the observable, *unconditional* outcome the system produces. What
  changes, what is returned, what is shown, what is recorded. Never conditional.

### Three anti-patterns

**1. Conditional \`then\` (precondition leaking out of \`given\`)**

Bad: \`then: "the order is rejected if inventory is empty"\`
Fix — move the condition up:
\`\`\`yaml
given: "a customer placing an order for an item with zero inventory"
when:  "the order is submitted"
then:  "the order is rejected with an out-of-stock error"
\`\`\`
Signal words: if you write *if*, *when*, *unless*, *provided*, *assuming*, or *as long as*
inside \`then\`, a precondition has leaked out of \`given\`. Move the clause to \`given\` and
restate \`then\` as an unconditional outcome.

**2. State in \`when\` (precondition leaking out of \`given\`)**

Bad: \`when: "the user is logged in and has admin rights"\`
"Is logged in" is a state, not an event. Move to \`given\`; put the trigger in \`when\`.

**3. Two events in one \`when\`**

Bad: \`when: "the user clicks Submit and the server validates the input"\`
Server validation is the system's response, which belongs in \`then\`. \`when\` is
exactly one initiating action.

### Handling AND / OR from the source

- **AND preconditions** → merge into \`given\` as prose: *"a customer with an active
  subscription **and** a verified email"*.
- **AND outcomes** → merge into \`then\` as prose.
- **OR preconditions, same outcome** → two criteria with identical \`then\` and
  different \`given\`.
- **OR producing different outcomes** → always two separate criteria.

### Source-agnostic translation pattern

Input may be a chat, a ticket, an existing spec file, an email thread, a test name,
or behaviour inferred from code. The translation is always the same: **find the
trigger; everything before it is \`given\`; everything after it is \`then\`.**

- **Gherkin-style chains (WHEN X AND Y AND Z THEN W)** — only one of the X/Y/Z is
  the real trigger (usually a user action or external event). The rest are
  preconditions; push them into \`given\`.
- **Ticket-style bullet lists** — read the bullets, identify the user/system action
  in the list, put it in \`when\`, the surrounding context in \`given\`, the expected
  result in \`then\`.
- **Chat / conversation** — listen for *"when X happens, Y should…"* and *"but if Z,
  then W"* branches. Each branch is a separate criterion.
- **Existing code** — the entry point (HTTP handler, message handler, scheduled
  job, CLI command) is the trigger. Inputs to it are \`given\`; side effects and
  return values are \`then\`. Skip implementation steps in between.

### Worked example

A complete spec with well-shaped acceptance criteria **and** a meaningful body:

*Frontmatter:*
\`\`\`yaml
title: Order Downgrade Scheduling
type: software_requirement
status: draft
implements:
  - symbol: src/Orders/DowngradeService.php::DowngradeService.schedule
    type: method
acceptance_criteria:
  - given: "a customer with an active Professional subscription not in a trial"
    when:  "they request a downgrade to Basic"
    then:  "the downgrade is scheduled for the next billing cycle and a confirmation email is sent"
  - given: "a customer already scheduled for a downgrade"
    when:  "they request a second downgrade"
    then:  "the request is rejected with 'downgrade already pending'"
\`\`\`

*Body:*
\`\`\`markdown
## Context

Customers on Professional may downgrade to Basic, but immediate downgrades would
cause partial-period refund complexity. Scheduling at billing-cycle boundary
simplifies billing and prevents revenue leakage from same-day churn patterns.

## Decisions

- **Scheduled, not immediate**: downgrade takes effect at the next billing cycle
  boundary rather than instantly, so no proration logic is required.
- **One pending downgrade at a time**: a second request is rejected rather than
  replacing the first, because replacing silently would allow a customer to change
  their mind without customer support involvement, bypassing retention flow.

## Out of scope

- Cancellation of a pending downgrade (handled in order-downgrade-cancellation spec)
- Upgrade from Basic back to Professional after a downgrade is scheduled
\`\`\`

The \`given\` carries every precondition; the \`when\` is one user-initiated action;
the \`then\` lists every observable outcome with no \`if\`/\`when\` qualifiers.
The body explains WHY these criteria are shaped this way — information the
structured fields cannot express.

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

**Co-located symbols that serve different consumers** require special attention. If
two symbols live in the same file but are consumed by different parts of the system,
always ask: *what does each consumer see that the other doesn't?* That difference is
a behavioral commitment and belongs as an acceptance criterion. A spec that links
both symbols without stating the distinction implies they are equivalent — which
creates false confidence and misses real regression risk.

## Reading existing code and documentation

When the source material is existing code, docs, or legacy spec files rather than a
fresh requirement, do a **two-pass survey before writing anything**.

**Pass 1 — inventory**: Read ALL source material. For each behavioral statement you
find, note it and tag it provisionally:
- *why this exists / user benefit* → likely \`intent\`
- *must always / must never / invariant* → likely \`business_rule\`
- *observable output of a specific symbol* → likely \`software_requirement\`
- *how the system is organised / execution order / lifecycle contract* → likely \`project_spec\`

**Pass 2 — classify and assign**: Group the tagged statements by spec type and by
symbol. Statements about different symbols at different architectural layers become
different specs. Only then start writing.

**When source material contradicts itself or contradicts the code**: do not resolve
the conflict silently. Note both versions, then surface it explicitly:
- If the code and a spec disagree, the code reflects current reality — but the spec
  is now stale and must be updated or retired, not silently ignored.
- If two documents disagree, flag which is newer or more authoritative and ask.
Resolving contradictions unilaterally produces specs that look confident but embed
an undisclosed assumption. The user needs to know.

**Source material triage** — what does and does not belong in a spec:

| Source material | Belongs in spec? |
|----------------|-----------------|
| WHY this was built, user benefit | Yes — \`intent\` body |
| Hard invariant ("must never", "SHALL NOT") | Yes — \`business_rule\` |
| Observable output under specific input | Yes — \`acceptance_criteria\` |
| Pipeline / execution order contract | Yes — \`project_spec\` |
| Task list / implementation checklist | No — commit message or ADR |
| Column list / parameter enumeration | No — unless each entry carries a distinct behavioral obligation |
| Design decisions, alternatives considered | No — ADR or design doc |
| "No behavioral change" / migration notes | No — commit message |

If you find material that spans multiple rows in the "Yes" section and different
symbols or layers, you have more than one spec to write. Create them all before
calling \`reindex\`.

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
- Use \`search_symbols\` to look up the exact symbol ID before writing it — a wrong ID
  produces a drift warning on every \`analyze\` run

**TypeScript / PHP symbols** — the symbol ID is always \`filePath::fqn\`. Methods use dot
notation: \`ClassName.methodName\`. The \`type\` field is informational metadata for humans
and graph queries; it does not affect how the link is resolved (only \`type: file\` has
routing significance):
\`\`\`yaml
implements:
  - symbol: src/Orders/DowngradeService.php::DowngradeService
    type: class
  - symbol: src/Orders/DowngradeService.php::DowngradeService.schedule
    type: method
  - symbol: src/utils/pricing.ts::calculateDiscount
    type: function
  - symbol: src/contracts/OrderRepository.ts::OrderRepository
    type: interface
\`\`\`
Valid \`type\` values for TypeScript: \`class\`, \`interface\`, \`function\`, \`method\`, \`type\`,
\`enum\`. For PHP: \`class\`, \`interface\`, \`trait\`, \`enum\`, \`function\`, \`method\`.

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
- When extracting specs from existing code, legacy spec files, or design documents
  (spec archaeology): treat the existing material as evidence, run the same
  two-pass survey described in the \`create-spec\` skill, then proceed as normal

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
After creation, open the file and write a full body — see *Spec body structure*
in the \`create-spec\` skill for the per-type template.

| type | Frontmatter fields | Required body sections |
|------|--------------------|------------------------|
| \`intent\` | \`title\`, \`type\`, \`status\` | Opening paragraph, \`## User benefit\`, \`## Decisions\`, \`## Out of scope\` |
| \`business_rule\` | \`title\`, \`type\`, \`status\`, optionally \`implements\` | \`## Rules\`, \`## Rationale\`, \`## Out of scope\` |
| \`software_requirement\` | \`title\`, \`type\`, \`status\`, \`implements\`, \`acceptance_criteria\` | \`## Context\`, \`## Decisions\`, \`## Out of scope\` |
| \`project_spec\` | \`title\`, \`type\`, \`status\` | \`## Overview\`, \`## Decisions\`, \`## Out of scope\` |

\`acceptance_criteria\` frontmatter format:
\`\`\`yaml
acceptance_criteria:
  - given: "specific, concrete precondition"
    when: "exact action or event"
    then: "observable, testable outcome"
\`\`\`

Merge multi-step Given/And into one \`given\` string. Same for When and Then.
For Scenario Outline / examples: one entry per concrete input row.

## Notes

- A small feature with one scenario and no hard constraints needs only one
  \`software_requirement\` — do not over-split
- If the input already answers everything precisely, skip straight to spec creation
- Never fill a gap with an assumption — ask
`,
};

const checkDrift: SkillDefinition = {
  name: 'check-drift',
  content: `---
name: check-drift
description: Check whether code and specs are aligned. Use after any code change that renames, moves, or deletes a specced symbol, or when reviewing whether a spec is linked to its implementation.
---

# Check Drift

Drift means a spec declares an \`implements\` symbol that no longer exists in the
codebase — the spec and the code have diverged. Surfacing drift is specgraph's core
job. Resolving it (update the spec, revert the code, or retire the spec) is the
user's decision.

## Two kinds of drift

**Hard drift** — the symbol the spec links to no longer exists. Detected automatically
by \`get_drift_report\`. The Stop hook reports new instances at the end of each turn.

**Soft drift** — the symbol still exists, but its behaviour no longer matches the spec.
Not detected automatically. You must recognise it:
- You implemented something that satisfies the code but violates an acceptance criterion
- You changed the semantics of a symbol (return value, error handling, precondition)
  without touching the spec
- A decision was made during the session that contradicts what \`## Decisions\` says
- User confirmed during chat that a rule or criterion is wrong or outdated

Soft drift is silent — no hook fires, no drift report shows it. **You** are the detector.
When you notice it, do not continue without flagging it to the user and offering to
update the spec.

## Run the drift report

\`\`\`
get_drift_report()
\`\`\`

The report lists every spec that declares a symbol not found in the last \`analyze\`
run. For each entry, surface it to the user with the spec ID and the missing symbol —
do not silently fix it or choose a replacement unilaterally.

If a drift entry contains \`no '::' separator — did you mean type: file?\` the spec has
a malformed \`implements\` entry (bare file path written as a symbol).

## Link a spec to its implementation

When a spec has no \`implements\` link, or a symbol was renamed and the link is stale:

1. Find the current symbol ID:
   \`\`\`
   search_symbols({ query: SymbolName })
   \`\`\`

2. Add the link:
   \`\`\`
   update_spec({ id: orders/order-downgrade-scheduling, addSymbols: [src/Orders/DowngradeService.php::DowngradeService.schedule] })
   \`\`\`

3. Remove a stale link if the symbol was renamed:
   \`\`\`
   update_spec({ id: ..., removeSymbols: [old/path.php::OldName] })
   \`\`\`

4. Run \`reindex\` after edits so the graph reflects the current state.

## Status field

\`status: draft\` — behavioral commitment defined; not yet linked to an implementation.
\`status: active\` — linked to code via at least one valid \`implements\` entry.

Status is metadata about linkage completeness, not a task completion flag. Whether
to link remaining drafts is a product decision, not a specgraph concern.

## When to run

- After renaming, moving, or deleting any symbol that may be referenced by a spec
- When \`specgraph analyze\` reports drift warnings in its output
- When onboarding to a codebase to understand which specs are linked vs unlinked
- After a batch of spec creation to verify all \`implements\` entries resolved
- **At the end of any coding session** — see below

## End-of-session spec review

At the end of a session where code was written or modified, actively review whether
specs need updating. Do not wait for the user to ask. Go through this checklist:

**Hard drift** (run automatically):
\`\`\`
get_drift_report()
\`\`\`
If any broken links exist, surface them to the user.

**Soft drift** (manual — you must check this yourself):
- Read back the specs for every symbol you modified this session
  (\`get_specs_for_symbol_with_context\`)
- Compare: does what you implemented match the \`acceptance_criteria\`?
- If a criterion no longer describes actual behaviour: flag it and offer to update

**Chat insights** (scan the conversation):
Look for statements made during the session that represent new behavioural commitments:
- "Actually, it should always…" → candidate for a new rule or criterion
- "We decided not to…" → candidate for \`## Out of scope\` or a business rule
- "The reason for this is…" → candidate for \`## Rationale\` or \`## Context\`
- "This only applies when…" → candidate for a new \`given\` or a \`business_rule\`
- "We changed our mind about…" → an existing criterion or decision may be stale

For each candidate: offer to update the relevant spec. Concrete prompt:
"During this session we established that [X]. Should I add this to
[spec ID] under [## Decisions / ## Rationale / as a new criterion]?"

Never silently discard an insight because it feels minor. The user decides
what is worth capturing; your job is to surface it.

## Stop-hook drift warnings

If you receive a hook message of the form *"Spec drift: N new broken link(s) detected"*,
the IDE Stop hook is reporting drift that is **new since its last check**. Each broken
link is announced exactly once per state change. After investigating:

- If the warning concerns a spec **unrelated to your current task**, acknowledge it to
  the user once and move on — do not re-run \`get_drift_report\` on later turns hoping
  the warning will reappear. It will not, by design.
- If the warning concerns code **you just changed**, run \`get_drift_report\` to see the
  full broken (specId, symbolId) pair, then update the spec via \`update_spec\` or retire
  it.
- The hook's silence on later turns means *"no new drift since last check"*, not
  *"everything is fine"* — use \`get_drift_report\` for an authoritative current view.
`,
};

export const SKILLS: SkillDefinition[] = [specLookup, createSpec, planFeature, checkDrift];
