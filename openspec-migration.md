# OpenSpec → SpecGraph Migration Guide

Migrating a modulith PHP repo from OpenSpec (per-change `proposal.md`, `design.md`,
`tasks.md`, `specs.md` files) into specgraph's closed, independent spec files.

---

## Spec format reference

Every specgraph file is a Markdown file with YAML frontmatter. The fields that matter
for migration:

```yaml
---
title: Short human-readable title
type: intent | business_rule | software_requirement | project_spec
status: draft | active | deprecated
created: 'YYYY-MM-DD'
implements:
  - symbol: src/Module/ClassName.php::methodName
    type: function | class | method | constant
refs:
  - https://...          # link back to the original OpenSpec change dir or ticket
acceptance_criteria:     # structured Gherkin — lives in frontmatter, NOT in the body
  - given: "a logged-in customer with an active subscription"
    when: "they request a plan downgrade"
    then: "the downgrade is scheduled for the next billing cycle"
---
# Title

One-paragraph description of the requirement or rule.

## Rules        (optional — for business_rule type)
- Must not allow …
- Always validates …
```

Key points:
- `acceptance_criteria` is a **frontmatter array** of `{given, when, then}` objects —
  this is where all Gherkin scenario content goes, not in the body.
- Concatenate multiple `Given / And` steps into a single `given` string.
  Do the same for `When / And` → `when` and `Then / And` → `then`.
- `Scenario Outline` with `Examples` tables: create one `acceptance_criteria` entry
  per example row (use concrete values, not placeholders).
- The body (`# Title` + paragraphs) holds prose description only.

---

## OpenSpec file roles

| OpenSpec file  | What to look for |
|----------------|-----------------|
| `proposal.md`  | Intent, motivation, high-level goals → `intent` or `project_spec` |
| `design.md`    | Technical decisions, constraints, architecture notes → `software_requirement` or `business_rule` |
| `specs.md`     | Gherkin scenarios, acceptance criteria, validation rules → `software_requirement` or `business_rule` |
| `tasks.md`     | Implementation tasks — use only to identify which PHP files/classes are involved, then discard |

One OpenSpec "change" directory often produces **multiple** specgraph files:
one intent-level spec + one or more rule/requirement specs.

---

## Prerequisites — run once

```bash
specgraph analyze --full   # populate code symbol graph from PHP source
specgraph index            # index any existing specgraph specs
```

The agent needs a live symbol graph so `search_symbols` returns real results.

---

## Phase 1 — Survey (one session, no spec files created)

> **Agent prompt:**
>
> Find every OpenSpec change directory:
> ```bash
> find . -type f \( -name "proposal.md" -o -name "specs.md" -o -name "design.md" \) \
>   | sed 's|/[^/]*$||' | sort -u
> ```
>
> For each directory, read `proposal.md`, `design.md`, and `specs.md` (skip `tasks.md` for
> now — you will use it later only to find class names).
>
> Produce a single file `openspec-migration-tasks.md` with one checkbox per specgraph spec
> you plan to create. Use this row format:
>
> ```
> - [ ] **<short title>** | source: `<change-dir>/<file>#<section>` | type: `<type>` | dir: `<module>` | gherkin: yes/no | symbols: unknown
> ```
>
> Rules for type assignment:
> - `intent` — the "why", product goals, motivation paragraphs from `proposal.md`
> - `business_rule` — invariants, validation rules, "must / must not / always / never" statements
> - `software_requirement` — concrete feature behaviour, API contracts, Gherkin scenarios
> - `project_spec` — cross-cutting architecture or setup decisions
>
> One OpenSpec change → typically 1 intent spec + 1–3 requirement/rule specs.
> Do **not** create any spec files yet. Only write `openspec-migration-tasks.md`.
> End with a total count so nothing is skipped.

**Review the task file yourself** before proceeding: merge duplicates, correct types,
adjust module dirs to match your PHP namespace structure.

---

## Phase 2 — Migration (run in batches of 10–15 items)

Hand the agent a slice of unchecked rows from `openspec-migration-tasks.md`.

> **Agent prompt:**
>
> Work through the unchecked items below **one at a time**. For each:
>
> **Step 1 — Find implementing symbols**
> Read `tasks.md` in the source change directory for class/method names.
> Then search the symbol graph:
> ```
> MCP search_symbols "<ClassName>"
> MCP search_symbols "<methodName>"
> ```
> Cross-check with git history on the relevant files:
> ```bash
> git log --oneline -10 -- src/Module/ClassName.php
> ```
> Note the symbol IDs (format: `src/Module/File.php::ClassName::methodName`).
>
> **Step 2 — Create the spec file**
> ```bash
> specgraph create --title "<title>" --type <type> --dir <module> \
>   --symbol <id1> --symbol <id2>
> ```
>
> **Step 3 — Edit the generated file**
> Open the `.md` file that was just created. Fill in:
>
> - **Body**: one paragraph describing the requirement in plain language.
>
> - **`acceptance_criteria`** in the frontmatter (if the source has Gherkin):
>   Convert each `Scenario:` block to one `{given, when, then}` entry.
>   Merge multi-step `Given/And` into a single `given` string, same for `when` and `then`.
>   For `Scenario Outline`: one entry per example row with concrete values.
>
> - **`refs`** in the frontmatter: add the relative path to the source change directory
>   only if it has a canonical URL (e.g. a Jira/GitHub link found in `proposal.md`).
>   Do not invent URLs.
>
> - **`## Rules` section** in the body (for `business_rule` type only):
>   List each invariant as a bullet.
>
> **Step 4 — Update the task file**
> Mark the row done: `- [x]` and fill in the found symbol IDs in the `symbols:` field.
>
> If after two MCP searches you cannot identify an implementing symbol, leave `implements:`
> empty and add `<!-- TODO: find symbol -->` as the first line of the body. Do not guess.
>
> After every 10 specs run:
> ```bash
> specgraph index
> ```

---

## Phase 3 — Verification (one session)

> **Agent prompt:**
>
> ```bash
> specgraph index
> specgraph analyze
> ```
>
> Then:
>
> 1. Call MCP `get_drift_report`. For each warning, check whether the symbol was renamed
>    since the change was merged. If so:
>    ```bash
>    specgraph update --id <spec-path-key> \
>      --remove-symbol <old-id> --add-symbol <new-id>
>    ```
>
> 2. Call MCP `get_unspecced_symbols` filtered to PHP files. For each symbol that appears
>    in an OpenSpec change directory (check via `git log -- <file>`), either:
>    - Link it to an existing spec: `specgraph update --id <spec> --add-symbol <id>`
>    - Or add it to `specs/backlog.md` with a one-line note.
>
> 3. Search for remaining unchecked items:
>    ```bash
>    grep '^\- \[ \]' openspec-migration-tasks.md
>    ```
>    Report any found without acting on them.
>
> 4. Search for unresolved TODOs:
>    ```bash
>    grep -rl 'TODO: find symbol' specs/
>    ```
>    Report the list.

---

## CLAUDE.md additions (copy into your project's CLAUDE.md)

```markdown
## OpenSpec migration conventions
- One OpenSpec "change" directory → 1 intent spec + 1–3 requirement/rule specs
- Gherkin goes into acceptance_criteria frontmatter as {given, when, then} objects — never in the body
- Merge multi-step Given/And into one given string; same for When/And and Then/And
- Scenario Outline + Examples → one acceptance_criteria entry per concrete example row
- tasks.md is used only to find class/method names — do not create specs from it
- Route paths like POST /orders → search_symbols for the controller method
- Module dir for --dir should match the PHP namespace segment (e.g. Orders, Billing)
- business_rule type for anything phrased as a constraint: "must", "cannot", "only when"
- Leave implements empty (with TODO comment) rather than guessing a symbol
```

---

## Gherkin conversion example

**OpenSpec `specs.md`:**
```gherkin
Scenario: Downgrade scheduled at end of billing cycle
  Given a customer with an active Professional subscription
  And the customer is not in a trial period
  When the customer requests a downgrade to Basic
  And confirms the change
  Then the downgrade is scheduled for the next billing cycle start date
  And a confirmation email is sent to the customer
```

**Resulting frontmatter:**
```yaml
acceptance_criteria:
  - given: "a customer with an active Professional subscription and not in a trial period"
    when: "the customer requests a downgrade to Basic and confirms the change"
    then: "the downgrade is scheduled for the next billing cycle start date and a confirmation email is sent"
```
