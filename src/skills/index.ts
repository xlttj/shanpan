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

4. **Fetch a specific spec**: call \`get_spec\` with the spec ID (e.g. \`SPEC-002\`) to read the full requirement text.

## Choosing the right tool

| Situation | Tool |
|-----------|------|
| You have a symbol path | \`get_specs_for_symbol_with_context\` |
| You have a keyword | \`search_symbols\` → \`get_specs_for_symbol_with_context\` |
| You want to browse | \`list_specs\` |
| You need full spec text | \`get_spec\` |

## Notes

- Prefer \`get_specs_for_symbol_with_context\` over \`get_specs_for_symbol\` — it includes call-graph neighbours and gives richer context.
- A symbol with no linked specs is not necessarily unspecced — use \`get_unspecced_symbols\` to see what genuinely lacks coverage.
`,
};

const createSpec: SkillDefinition = {
  name: 'create-spec',
  content: `---
name: create-spec
description: Create a new spec file with correct frontmatter and link it to code symbols. Use when a feature or rule needs to be formally specified before or after implementation.
---

# Create Spec

Create a new spec file with correct frontmatter using the \`create_spec\` MCP tool.

## Spec types

| type | Use for |
|------|---------|
| \`intent\` | High-level goals and product decisions |
| \`business_rule\` | Domain constraints that must always hold |
| \`software_requirement\` | Concrete implementation requirements |
| \`project_spec\` | Project-wide setup and architectural decisions |

## Steps

1. **Choose an ID**: use the format \`SPEC-NNN\` for software requirements, \`RULE-NNN\` for business rules, \`INTENT-NNN\` for intents. Call \`list_specs\` first to find the next available number.

2. **Call \`create_spec\`** with the required fields:
   \`\`\`
   create_spec({
     id: "SPEC-042",
     title: "Human-readable title",
     type: "software_requirement",
     description: "One paragraph explaining what this spec governs."
   })
   \`\`\`

3. **Link symbols if known**: if the spec covers existing code, pass \`symbols\` as an array of \`filePath::fqn\` IDs. Otherwise link them later with \`update_spec\` after running \`reindex\`.

4. **Call \`reindex\`** after creating the spec so the graph is up to date.

## Notes

- New specs are created with \`status: draft\`. Change to \`active\` with \`update_spec\` when approved.
- The file is written to the configured specs directory (default: \`specs/\`).
- Write spec body text to describe what the code must do and why — not how it does it.
`,
};

const checkDrift: SkillDefinition = {
  name: 'check-drift',
  content: `---
name: check-drift
description: Detect and fix spec drift — symbols that were renamed or deleted after being linked to specs. Run after refactoring or before committing.
---

# Check Drift

Detect and fix broken links between specs and code symbols.

## When to use

- After renaming or deleting functions, classes, or methods
- Before committing a refactor
- When the CI pre-commit hook reports drift errors

## Steps

1. **Get the drift report**: call \`get_drift_report\`. It returns a list of broken \`implements\` links — symbol IDs that no longer exist in the graph.

2. **For each broken link**, choose an action:
   - **Symbol was renamed**: call \`update_spec\` with \`removeSymbols: [oldId]\` and \`addSymbols: [{ symbol: newId, type: "..." }]\`.
   - **Symbol was deleted and the spec is obsolete**: call \`update_spec\` with \`removeSymbols: [oldId]\` and set \`status\` to \`deprecated\`.
   - **Symbol was deleted but the requirement still applies**: remove the old link and add the new symbol that now fulfils the requirement.

3. **Re-run \`reindex\`** after making changes, then call \`get_drift_report\` again to confirm no remaining issues.

## Notes

- Run \`specgraph analyze\` (CLI) or call \`reindex\` (MCP) after source changes so the graph reflects current symbols before checking drift.
- The pre-commit hook (\`specgraph check --staged\`) runs a lighter staged-only version of this check automatically on commit.
`,
};

const analyzeAndLink: SkillDefinition = {
  name: 'analyze-and-link',
  content: `---
name: analyze-and-link
description: After adding or modifying source code, reindex the graph and link new symbols to their governing specs. Use after implementing a feature.
---

# Analyze and Link

After adding or modifying source code, update the graph and link new symbols to specs.

## Steps

1. **Reindex**: call \`reindex\` via MCP (or run \`specgraph analyze\` in the terminal). This scans source files and updates the symbol graph.

2. **Find unlinked symbols**: call \`get_unspecced_symbols\` to see symbols that have no spec coverage. Focus on the files you just changed.

3. **Link symbols to specs**: for each new symbol that implements a requirement, call \`update_spec\`:
   \`\`\`
   update_spec({
     id: "SPEC-042",
     addSymbols: [{ symbol: "src/core/parser.ts::parseSpecFile", type: "function" }]
   })
   \`\`\`

4. **Verify**: call \`get_specs_for_symbol_with_context\` on a newly linked symbol to confirm the link appears in the graph.

## Symbol ID format

Symbol IDs follow \`filePath::fullyQualifiedName\`:

- Function: \`src/core/parser.ts::parseSpecFile\`
- Method: \`src/core/parser.ts::SpecParser.parse\`
- Class: \`src/core/parser.ts::SpecParser\`

Use \`search_symbols\` to find exact IDs when unsure.

## Notes

- Link at the most specific level that makes sense: prefer method-level links over class-level when only one method implements a requirement.
- If no existing spec covers the new code, use the \`create-spec\` skill first.
`,
};

export const SKILLS: SkillDefinition[] = [specLookup, createSpec, checkDrift, analyzeAndLink];
