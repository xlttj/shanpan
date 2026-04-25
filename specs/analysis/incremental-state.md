---
title: Incremental Analyze State
type: software_requirement
status: active
created: '2026-04-25'
implements:
  - symbol: src/core/analyze-state.ts::loadAnalyzeState
    type: function
  - symbol: src/core/analyze-state.ts::saveAnalyzeState
    type: function
---
# Incremental Analyze State

Persists per-file modification times so that `specgraph analyze` can skip unchanged
files on subsequent runs.

State is stored in `.specgraph/analyze-state.json` as a flat object mapping each
relative file path to its last-seen mtime in milliseconds:

```json
{ "fileMtimes": { "src/Foo.php": 1714050000000, "src/Bar.php": 1714051000000 } }
```

`loadAnalyzeState` reads the file and returns the parsed state, or an empty
`{ fileMtimes: {} }` if the file does not exist or cannot be parsed.

`saveAnalyzeState` writes the updated state atomically after a successful analyze run.
The file is only written when the mode is `full` or `incremental`; a `skip` run (no
changes detected) leaves the state file untouched.

The CLI layer (`runOneAnalyze`) compares current mtimes against the saved state to
partition files into three sets — changed, deleted, unchanged — before opening the
database. When all files are unchanged the DB is never opened, keeping no-change runs
under 250 ms. The `--full` flag bypasses the state file and forces a complete rebuild.
