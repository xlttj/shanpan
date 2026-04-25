---
title: IDE Agent Hook Installation
type: software_requirement
status: active
created: '2026-04-25'
implements:
  - symbol: src/core/ide-hooks.ts::installIdeHooks
    type: function
  - symbol: src/core/ide-hooks.ts::mergeSettings
    type: function
  - symbol: src/core/ide-hooks.ts::IDE_INTEGRATIONS
    type: variable
  - symbol: src/cli/commands/init.ts::runInit
    type: function
  - symbol: src/cli/commands/check.ts::runCheck
    type: function
---
# IDE Agent Hook Installation

During `specgraph init`, the CLI prompts the user to select their AI coding tool and
writes agent hooks to the appropriate IDE settings file. Hooks automate graph sync
and drift detection during AI sessions without requiring manual intervention.

`IDE_INTEGRATIONS` is the registry of supported IDEs. Each entry implements `IdeIntegration`
with an `id`, `label`, `settingsPath` (relative to project root), and `buildHooksConfig()`
returning the hooks object to merge.

`mergeSettings` reads the target settings file (or starts from `{}`), deep-merges the new
hooks configuration preserving any existing entries, and writes the result back as formatted
JSON. Array-valued hook lists are concatenated rather than replaced.

`installIdeHooks` resolves the settings file path from `ide.settingsPath` and delegates to
`mergeSettings`.

`runInit` prompts the user via a simple `readline` menu showing detected IDEs, defaults to
Claude Code when stdin is not a TTY, then calls `installIdeHooks` for each selected IDE.
The hooks installed are:

- **PostToolUse** (matcher `Write|Edit|MultiEdit`, `async: true`): runs `specgraph analyze`
  in the background after any file write. The graph is updated silently; the agent queries
  fresh results via MCP tools on the next call.
- **Stop**: runs `specgraph check --hook-output`. If drift is found, outputs
  `{"decision":"block","reason":"..."}` to stdout, preventing the session from ending and
  showing the reason to the model. If clean, outputs `{}` and the session ends normally.

`runCheck` gains a `--hook-output` flag that suppresses human-readable output and instead
writes hook-compatible JSON (as above) to stdout. Exit code is always 0 in this mode so
Claude Code parses the JSON rather than treating it as a hook failure.

## Supported IDEs

- **Claude Code**: `.claude/settings.json` (format confirmed)
- **Cursor**: `.cursor/settings.json` (format assumed equivalent; stubbed for correction)

The `IdeIntegration` interface allows adding further IDEs without changing the installation
logic in `runInit`.
