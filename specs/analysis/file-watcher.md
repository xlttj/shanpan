---
title: Incremental re-analysis via file watching
type: software_requirement
status: active
created: '2026-04-17'
implements:
  - symbol: src/core/watcher.ts::watchAndReindex
    type: function
  - symbol: src/cli/commands/analyze.ts::runAnalyze
    type: function
---
# Incremental re-analysis via file watching

Removes the need to run `specgraph analyze` manually after every code change by
providing a long-running `--watch` mode that re-indexes on save.

## Watch mode

`specgraph analyze --watch` runs a long-lived process that:

1. Performs an initial one-shot `analyze` on startup.
2. Registers file-system watchers on every directory listed in
   `config.analyze.include` and on `config.specsDir`.
3. Debounces incoming events with a **2-second quiet window**: accumulates
   changed paths and flushes them all in a single re-analyze once no new
   events arrive for 2 seconds.
4. On each flush, runs the full analyze pipeline (same code path as the
   one-shot command — no separate incremental logic).
5. Excludes `config.analyze.exclude` directories and the `.specgraph/`
   database directory from the watch to prevent feedback loops.
6. Prints a status line after each flush:
   ```
   [14:32:07] reindexed 4 files · 0 drift warnings
   ```
7. Exits cleanly on SIGINT (`Ctrl-C`): closes the DB connection, then exits 0.
8. If a flush throws an error, logs the error to stderr and resumes watching
   (does not exit).

### Platform notes

`node:fs.watch` with `{ recursive: true }` works natively on macOS and
Windows. On Linux, native recursive watching may not be available; the
implementation falls back to registering individual watchers on each
subdirectory discovered via the same `walkFiles` traversal used by the
analyzer.

The core watch logic lives in `src/core/watcher.ts::watchAndReindex`, called
by `runAnalyze` when the `watch` option is true.

## Acceptance criteria

- `specgraph analyze --help` documents the `--watch` flag.
- Integration test: write a source file during a watch session and assert that
  `reindexed` appears in stdout within 3 seconds.
