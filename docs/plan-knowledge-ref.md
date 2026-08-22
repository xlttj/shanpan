# Plan — knowledge records on a separate git ref

Implementation plan for idea 3 (and the part of idea 4 it depends on) in
`ideas.md`. Written before any of it is built, so the reasoning is reviewable
while it is still cheap to change.

## Goal

Move the knowledge log out of the working tree and onto a git ref of its own,
so that:

- recording knowledge never dirties the tree a developer is working in;
- every worktree and every branch sees one knowledge state instead of the
  fragment that happens to be merged into the branch they are on;
- knowledge learned on a branch that is never merged is not lost with it.

## Non-goals

- Not a CI gate. Shanpan is not run as a gate in CI and this plan does not
  make it one.
- Not a change to the record format, the supersede model, or the fabrication
  gate. Those stay exactly as they are.
- Not a graph change. The graph is still derived and disposable.

## Preconditions — both already met

1. **The config is tracked.** `.shanpanrc.json` was ignored; it now ships with
   the repository, which is what lets a fresh clone know a ref is expected at
   all. (Commit `251fcbd`.)
2. **Ids are wide enough to merge safely.** Ids were three bytes checked only
   against the local view, so parallel appends could collide and cost a
   record; they are now five bytes, and a byte-identical repeat is no longer
   an error. (Commit `58b2a3f`.) This is what removes the need for a
   merge-repair strategy: the conflict case is now both rare and loud.

## Invariants

These hold at every step. If a slice cannot keep them, the slice is wrong.

1. **The ref is the truth; any file on disk is cache.** Cache key is
   `git rev-parse <ref>`.
2. **Refresh merges, never overwrites.** Union by record `id`. Never
   `git show > file`. A crash between "append to cache" and "commit to ref"
   must cost nothing.
3. **Nothing ever checks out the ref.** Read with `git show <ref>:<path>`,
   write with `hash-object` / `commit-tree` / `update-ref`. No second
   worktree, no stash, no detached HEAD.
4. **Absence is never silent.** A missing or unfetched ref must never look
   like "this project has no knowledge". Same rule that produced
   `get_server_info` and `emptyRecordResult`.
5. **The old mode keeps working.** A project without a `knowledge.ref` in its
   config behaves exactly as today.

## Why this slicing

The ref removes the only place a human currently sees a claim an agent made
about their code: the pull request. Building it first would ship the
regression before the mitigation. So the notification comes first — it stands
on its own, and it is what makes the ref defensible.

Slice 2 is deliberately local-only. That is already the entire
worktree-pollution win, it is fully reversible, and it needs no coordination
with anyone else. Only slice 3 makes knowledge move between machines.

---

## Slice 1 — config schema and write-time notification

**Independent of the ref. Ships value on its own.**

### 1.1 Config schema

`src/types/config.ts`, `src/core/config.ts` (`parseConfig` — extend the same
`?? DEFAULT_CONFIG` pattern already used for the `analyze` keys).

```jsonc
{
  "knowledge": {
    "notify": "inferred"        // all | inferred | never
  }
}
```

**Shipped with `notify` only, deliberately.** The plan originally declared all
five keys here — `ref`, `commit`, `push`, `pull` as well — so that later stages
would only add behaviour. That is the wrong trade: a key that parses and
validates but does nothing is a lie to whoever sets it. Someone writing
`"push": "auto"` would reasonably expect their records to be pushed. Each
remaining key lands in the stage that gives it an effect.

An unknown value falls back to the default rather than leaving the tool in a
state it has no behaviour for, and a config written before the block existed
keeps working.

### 1.2 Classifying a record as observed or inferred

Mechanical, from the field that already exists — no new state, no heuristic:

| `pv` | class | notify under `inferred` |
|---|---|---|
| `n:` `t:` `d:` `g:` | observed — cites something that resolves | no |
| `u` | the human said it | no |
| `a`, `i` | the agent asserted it with nothing to point at | **yes** |

### 1.3 Surfacing it

`handleAddRecord` in `src/cli/commands/mcp.ts` returns the record it wrote;
extend that response so an inferred record is explicitly marked as needing the
developer's eyes. The `knowledge-record` skill (`src/skills/index.ts`) gets the
matching instruction: surface an inferred record to the developer in the same
turn, quoting the claim, and correct it immediately if they say it is wrong.

**Stated limitation:** shanpan cannot force an agent to speak. It can classify
and it can instruct; whether the sentence reaches the human depends on the
agent honouring the skill. This is a real gap and it is the strongest argument
for the review UI later — the UI is the backstop for everything the
notification misses. Write this down rather than pretending the notification
is a gate.

### 1.4 Tests

- classification table above, one case per provenance form
- config round-trip, including a config with no `knowledge` block at all
- `add_record` marks an inferred record and does not mark an observed one

---

## Slice 2 — the ref as local storage

**No network. Fully reversible. Built.**

Two things worth recording from building it:

**The read cost was measured, not assumed** — the risk list below asks for
exactly that. With 500 records: **2.53 ms/read without a ref, 6.18 ms with**.
The difference is almost entirely spawning `git rev-parse` for the cache key.
Acceptable in absolute terms, so no cache-the-cache-key layer was added: that
would trade a real correctness property for a few milliseconds nobody notices.

**The clean working tree does not arrive yet.** The cache file is still tracked
at this point, so an append still shows up in `git status` — the ignore flip is
slice 3's job. Slice 2 buys the correctness (one knowledge state, merge-safe,
nothing checked out); the headline benefit comes one slice later.

### 2.1 New module `src/core/knowledge-ref.ts`

Everything that shells out to git lives here and nowhere else.

- `refExists(projectDir, ref)`
- `readRefBlob(projectDir, ref)` → `git show <ref>:knowledge.ndjson`, null if absent
- `commitToRef(projectDir, ref, content, message)` → `hash-object` → `mktree`
  → `commit-tree` (parent = current ref tip if any) → `update-ref`
- `refSha(projectDir, ref)` → `git rev-parse`, the cache key
- `mergeById(a, b)` → union of two record lists, later `ts` losing to nothing;
  identical ids with identical content collapse, conflicting ids are reported
  rather than resolved

### 2.2 The two-function swap

`readRecords` and `appendRecords` in `src/core/records.ts` are the whole I/O
surface — 10 read sites and 3 write sites go through them, and nothing else
touches the file. Neither signature changes.

- `readRecords`: if `knowledge.ref` is set and the cache's stamped SHA differs
  from `refSha`, refresh first — **merge** the ref's content into the cache,
  then parse the cache as today. Line numbers in validation errors keep
  pointing at a real file a human can open, which is why the cache exists at
  all.
- `appendRecords`: append to the cache as today (whole lines, unchanged), then
  commit the cache content to the ref when `commit: auto`. If the commit
  fails, the record is still in the cache and reaches the ref on the next
  write — because refresh merges rather than overwrites.

### 2.3 Repair path — `upgrade`, not `init`

`init.ts:106` returns immediately when the graph already exists, and that is
correct: `init` is for a project that has none. The idempotent "bring an
existing project up to date" command already exists — `shanpan upgrade`, which
today rewrites skills, git hooks and IDE settings. The ref check belongs there:
create the ref if the config declares one and it is missing, seed it from the
tracked file, report what it did.

For a fresh clone `init` still runs fully (the graph is ignored, so it is
absent) and does the same thing on the way through.

### 2.4 What must follow the ref

- `src/cli/commands/rules.ts` generates `.cursor/rules/shanpan-*.mdc` from the
  records — a derived artifact that has to regenerate when the ref moves.
- The graph is rebuilt by `analyze` / `reindex` as today. A ref change is a new
  reason for the records to differ, so the refresh has to happen before the
  record-indexing pass in `analyze.ts:154`, not after.

### 2.5 Tests

- ref round-trip: commit, read back, no worktree change (`git status` clean)
- refresh merges rather than overwrites: cache holds a record the ref does not,
  refresh keeps it
- crash simulation: append to cache, skip the commit, next append recovers both
- a project with `ref: null` behaves byte-identically to today

---

## Slice 3 — push, pull, migration

**The first slice that is hard to undo. Built, except the migration.**

Three things the build changed or discovered:

**The sync modes are auto/never, not session-start/session-end.** The moment is
already decided by whichever hook calls sync, so a setting naming a moment
would be describing the hook's job — and the two could then contradict each
other. The config answers *whether*, the hook answers *when*. `pull: on-read`
was dropped outright: reads happen on nearly every MCP call, and a network
round trip on each would make the graph feel broken on a train.

**Push needs a merge commit, not just matching content.** Two machines that
each commit before either pushes produce histories that share every record and
no ancestor, and the second push is rejected forever. Committing the merged log
with the fetched tip as a second parent makes the remote's tip an ancestor, so
the push fast-forwards. Without that the retry loop would spin until it gave up.

**Pushing a custom ref to GitHub works** — confirmed against the real remote
over SSH, so the transport this whole slice rests on is sound. It could not be
shown from the build environment, whose proxy refuses anything outside
`refs/heads` with HTTP 403 (a tag is refused too, a branch is not — a namespace
policy of that proxy, not of GitHub).

**The migration is documented, not performed here.** Untracking the knowledge
file from inside that environment would leave every record on a ref that cannot
leave the container. So the ignore flip stays a written procedure, and the
order in it is what matters: seed the ref, sync it to the remote, verify it
arrived, and only then `git rm --cached`.

One credential detail the first real run surfaced: git opens `/dev/tty`
directly to ask for a password, so a sync from a hook would hang invisibly
rather than fail. Prompts are now allowed only when a human is watching, and
the resulting error names the cause — an https remote on an SSH-authenticated
machine, or a key that is not in the agent.

### 3.1 Push and pull

- `push: session-end` hangs on the session-end hook that already carries
  `shanpan check`.
- `pull: session-start` — one fetch per session rather than one per read.
- Concurrent pushes will hit non-fast-forward. Resolution is mechanical:
  fetch, `mergeById`, commit, retry, bounded. There is no semantic conflict to
  resolve because records are immutable and ids are now wide.

### 3.2 Absence must be loud

`emptyRecordResult` / `graphMissingRecords` in `src/cli/commands/mcp.ts`
already separate "genuinely no records" from "records on disk, graph empty".
The ref adds a third state to the same function: **config declares a ref, the
ref is not present locally.** That is an unfetched clone — an agent sandbox,
most likely, where nobody ran `init` — and it must say so instead of returning
an empty list.

This is the whole answer to the sandbox question. No new mechanism, one more
case in a function that exists for exactly this purpose.

### 3.3 Migration

Two `.gitignore` rules that stand today with good reasons have to be reversed,
and the reasons in the comments must travel with them or the next reader finds
the opposite of what holds:

- `!.shanpan/knowledge.ndjson` (*"the knowledge records are the source of truth
  and must be committed"*) → the file becomes cache and is ignored.
- `knowledge.archive.ndjson` is **dead code** — `ARCHIVE_FILE` and
  `archivePath` are declared in `records.ts` and read or written nowhere.
  Delete them rather than migrating a ghost.

Sequence: seed the ref from the tracked file's history, `git rm --cached`,
flip the ignore rules, keep reading the tracked file as a fallback for one
release so a half-migrated clone still works.

### 3.4 Tests

- two clones, parallel appends, both records survive the merge
- non-fast-forward push retries and converges
- unfetched clone produces the third empty-state message, not an empty list
- a repository mid-migration (tracked file present *and* ref present) resolves
  to the union, not to one silently winning

---

## Risks

1. **The notification is not a gate.** It depends on the agent following the
   skill. Slice 1 reduces the exposure that slice 3 creates; it does not
   remove it.
2. **A long-lived MCP server plus a pull.** The skew problem
   (`get_server_info`) exists because a long-lived process served stale code.
   A pull is a new way for the world to change under a running server. The SHA
   check on read is the intended defence — verify it by measurement, not by
   reading the code, since that is exactly the mistake made last time.
3. **Fresh clones.** Answered by `init` / `upgrade` plus the loud third empty
   state, but it stays the place where this will feel rough in practice.
4. **Shelling out to git on every read.** `git rev-parse` is sub-millisecond
   and only the SHA check runs per read, but the MCP server reads often enough
   that this deserves a measurement before slice 2 is called done.

## Order of work

1. Slice 1, complete, shipped, used for a while before slice 2 begins — the
   point of the ordering is lost if they land together.
2. Slice 2 behind `knowledge.ref`, opt-in, dogfooded on this repository first.
3. Slice 3 only once slice 2 has run locally long enough to trust.
