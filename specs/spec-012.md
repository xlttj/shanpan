---
id: SPEC-012
title: Agent Skill Installation
type: software_requirement
status: active
created: '2026-04-25'
implements:
  - symbol: src/skills/index.ts::SKILLS
    type: variable
  - symbol: src/cli/commands/init.ts::writeSkills
    type: function
  - symbol: src/cli/commands/init.ts::runInit
    type: function
---
# Agent Skill Installation

During `specgraph init`, the CLI writes SKILL.md files to the project's AI client skill
directories so that LLMs working in the project receive structured guidance on how to use
specgraph correctly.

`SKILLS` is the canonical list of skill definitions: embedded TypeScript string constants
that each contain a valid SKILL.md file (YAML frontmatter + Markdown body) conforming to
the Agent Skills open standard (agentskills.io).

`writeSkills` iterates over `SKILLS` and writes each one to `<clientDir>/skills/<name>/SKILL.md`.
It always writes to `.claude/skills/` (creating it if absent) and additionally writes to
`.cursor/skills/` if a `.cursor/` directory already exists in the project root. Each skill
occupies its own subdirectory named after the skill's `name` frontmatter field.

`runInit` calls `writeSkills` after the graph database and config are created, and logs
the directories written so the user can confirm placement.

## Skills installed

- **spec-lookup** — find specs that govern a symbol or topic before implementing
- **create-spec** — create a new spec with correct frontmatter and link it to symbols
- **check-drift** — detect and fix broken symbol links after refactoring
- **analyze-and-link** — reindex the graph and link new symbols to specs after coding
