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

1. **Find specs for a known symbol**: call \`get_specs_for_symbol_with_context\` with the symbol's fully-qualified ID (\`filePath::fqn\`, e.g. \`src/core/parser.ts::parseSpecFile\`). This returns direct spec links and call-graph neighbours.

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

## Notes

- Prefer \`get_specs_for_symbol_with_context\` over \`get_specs_for_symbol\` — it includes call-graph neighbours and gives richer context.
- A symbol with no linked specs is not necessarily unspecced — use \`get_unspecced_symbols\` to see what genuinely lacks coverage.
- Always read \`acceptance_criteria\` in the spec before writing code — these are the conditions your implementation must satisfy.
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

## Splitting heuristics

- One \`acceptance_criteria\` entry that could independently fail → candidate for its own spec
- "Must not" / "Must always" phrasing → \`business_rule\`, not \`software_requirement\`
- Two behaviours owned by different teams → two specs
- If you need "and also" to describe it → split it
- One feature typically yields: 1 \`intent\` + 1–3 \`business_rule\` + 1–3 \`software_requirement\`

## Notes

- Spec ID = relative file path without \`.md\` (e.g. \`orders/order-downgrade-scheduling\`)
- \`status: draft\` means planned but not yet implemented — change to \`active\` when done
- Do not add implementation details to the body; describe observable behaviour only
`,
};

const planFeature: SkillDefinition = {
  name: 'plan-feature',
  content: `---
name: plan-feature
description: Decompose a new feature into intent, business rule, and software requirement specs before writing any code. Run this at the start of every feature task.
---

# Plan Feature

Interview the user to understand a feature fully, then create all specs as \`draft\`
before any implementation starts. The spec files become the task list.

## When to use

- At the very start of a feature task, before touching any code
- When asked to plan or design a feature
- Before an OpenSpec migration batch

## Interview steps

Ask these questions **one at a time**. Wait for the answer before asking the next.

1. **Goal**: What is the user-facing outcome this feature delivers? Who benefits and how?
2. **Constraints**: What must always be true, regardless of how it is implemented?
   (Probe: edge cases, forbidden states, invariants, "what can never happen?")
3. **Behaviour**: Walk me through the main scenario step by step — what triggers it,
   what happens, what does the user or system observe at the end?
4. **Error cases**: What happens when something goes wrong? Are there rejection or
   rollback behaviours?
5. **Scope boundary**: What is explicitly out of scope for this change?

## Decomposition

From the answers, build a spec tree — do not flatten everything into one spec:

\`\`\`
intent              ← the "why" (one per feature)
  ├── business_rule ← each hard constraint from question 2
  ├── business_rule ← each error/rejection rule from question 4
  └── software_requirement ← main happy-path behaviour (question 3)
  └── software_requirement ← each significant error behaviour (question 4)
\`\`\`

Create each spec using \`create_spec\`, all with \`status: draft\`:
- \`intent\` specs: body = goal and motivation; no acceptance_criteria needed
- \`business_rule\` specs: body = the rule stated plainly; list edge cases as bullets
- \`software_requirement\` specs: add \`acceptance_criteria\` entries (one per scenario)

## Acceptance criteria format

\`\`\`yaml
acceptance_criteria:
  - given: "precondition describing the starting state"
    when: "the action or event that occurs"
    then: "the observable outcome that must result"
\`\`\`

Merge multi-step Given/And into one \`given\` string. Same for When and Then.

## Confirming the plan

After creating all specs, call:
\`\`\`
query_graph("MATCH (s:Spec {status: 'draft'}) RETURN s.id, s.title, s.type ORDER BY s.type, s.id")
\`\`\`
Show the result to the user and ask: "Does this cover everything, or are there missing cases?"
Adjust specs before writing any code.

## Notes

- Do not start implementation until the user confirms the spec tree
- If the feature is small (one acceptance criterion, no hard constraints), one
  \`software_requirement\` spec is sufficient — do not over-split
- Out-of-scope items do not need specs; note them in the intent body under "## Out of scope"
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
