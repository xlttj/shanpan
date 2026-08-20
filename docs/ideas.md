# Product notes — open ideas

Working notes, not commitments. Each entry keeps the objection as well as the
idea, because the objections are the part that gets lost.

## The principle everything keeps colliding with

A wrong record costs more than a missing one. Missing, the agent works as it
does today. Wrong, the agent believes it and **stops looking**. So a feature
that produces knowledge at 70% accuracy is not "pretty good" — it makes the
whole store untrustworthy, and the store's only value is that it can be
trusted.

Corollary discovered mid-discussion: the fabrication gate checks that a
provenance pointer *resolves*, not that the claim *matches* the pointer.
Anything that auto-generates claims with a real SHA attached would pass the
gate while defeating its purpose.

`src/core/bootstrap.ts:4` already states this rule for the bootstrap path.

---

## 1. History mining — mine questions, not conclusions

**Origin:** looking for the feature that separates shanpan from structure-only
code-graph products (GitNexus, Graphify, code-review-graph — category
impression, not a verified feature comparison).

**Thesis:** structure (what calls what) is derivable — compiler, LSP, and an
agent with ripgrep all reconstruct most of it. It is a depreciating asset.
Intent and history are not derivable from the current tree at all.

**First form (rejected):** mine git history for reverts and churn, emit
`rejected`/`gotcha` records automatically.

**Why rejected:** commit messages rarely carry *why*. They carry nothing
("fix errors") or the *what* ("refactored class names"). Reverts are rare in
teams that fix forward. An auto-written rationale would be a guess wearing a
citation.

**What survives — the split:**

- *Measurements* are correct by construction and say nothing about why:
  co-change coupling ("these two files changed together in 47 of 52 commits"),
  churn ("this body was rewritten 9× by 5 authors in 12 months"), silent
  reverts (code heavily reworked within days of being written — no `Revert`
  keyword, same fingerprint).
- *Interpretations* need prose that does not exist. Dropped.

**Reframe:** mining is a **targeting system for scarce human attention**, not
an author. It finds the spot worth asking about; the human answers in twenty
seconds because they are already in that code. That record is true — a human
wrote it, provenance `u`.

**Where it docks:** not on `bootstrap` (which writes claims), but as the
missing **ranking function for `get_undocumented_symbols`**, which today
returns a flat, unusable list of thousands. Same question, finally
prioritised. `printGap()` says "anything the team knows but never wrote down"
in prose; the ranker turns that into a worklist.

**Hard rule:** the ranker writes nothing into the record store. Enforced by
architecture, not by discipline.

**Falsifiable test before building anything else:** run the measurement half
read-only on a real repo, output the top 20 spots with numeric justification
only. A knowledgeable human marks each "there is a story here" / "banal".
**Below 50%, drop the idea** — including the targeting reframe.

**Side finding:** the revert path uses the reverted commit's subject as the
claim (`src/cli/commands/bootstrap.ts:97`). `Revert "fix errors"` yields a
record whose claim is `fix errors` — not false, but worthless, and it occupies
a slot as if something were known. Low-information subjects should be filtered
out. Small, concrete, independent of the rest.

---

## 2. Local GUI over the NDJSON (HTTP server + UI)

**Why it may be the strongest idea on this list:** it introduces the missing
third actor. Today the agent writes and the agent reads; the human sees the
result at best as a diff in a PR. Every question above ("who says this is
true?") dies for lack of a human surface. Only someone who knows the code can
answer it.

**Review without a Draft status** — no schema change needed:

- A record is valid on arrival, provenance `a` (agent).
- Review does not admit it into existence; it **vouches** for it — the human
  supersedes it with a version carrying `u`.
- A wrong record is superseded by its correction, not deleted.

"Reviewed" is therefore provenance, not lifecycle. The `a` / `u` distinction
already encodes *who says so*; the GUI is the first thing that makes it
visible and actionable.

*Open question to check in the code:* does the supersede chain cleanly express
"this was simply wrong" as distinct from "this is different now"? Review needs
both.

**Two traps:**

1. *Two writers on one file.* Agent and GUI both append to
   `knowledge.ndjson`. Append-only plus `merge=union` makes this far safer
   than a real database — but the GUI must not present a frozen snapshot while
   the agent appends, or the human judges a state that no longer exists.
2. *A second long-lived process on the Kuzu DB.* Exactly the failure class
   that produced the MCP process skew (`get_server_info` exists because of
   it). An HTTP server holding the DB open while the edit hook runs
   `shanpan analyze` is the same bug in new clothes. Instinct: **the GUI reads
   NDJSON as truth** (always fresh, no lock) and touches the graph only
   briefly and read-only, for drift and anchors.

**What a GUI can do that terminal and agent cannot** — all four need an eye or
a judgement:

1. Survey many records at once (table by kind, anchor, age, provenance).
2. Judge with context side by side — record left, anchored code right. This is
   *the* review act, and it is not possible in a terminal.
3. Bulk operations — after a large refactor 40 records drift; in the CLI that
   is 40 invocations, in a UI one multi-select.
4. See the shape of the whole — coverage per directory, age distribution.
   This is what turns a log file into a visible asset (also the strongest
   adoption argument: a lead will never run `search_records`).

**Explicitly out of scope: the node-graph hairball.** Every product in this
category builds the force-directed picture because it screenshots well. At
4000 nodes it is a screensaver. If shanpan gets a UI it is a **review tool,
not a visualisation** — that discipline is itself the differentiator.

**Smallest version worth building:** two queues, nothing else.

- *Drift queue* — records whose code moved: re-anchor, correct, discard.
- *Review queue* — records with provenance `a` that no human has vouched for,
  with the code beside them.

Search, filters and statistics are trim to add later.

**The fork that decides the design:** is the user the developer in their own
repo, or a lead looking at the team's knowledge? Recommendation: **start with
the developer** — they are the only one who can answer the truth question. The
team view follows from that; the reverse does not.

---

## 3. Separate git ref for `knowledge.ndjson`

See the discussion that produced these notes. Summary of the position reached:

**Wins, in order of weight:**

1. *No working-tree pollution.* Today an agent recording a gotcha mid-feature
   leaves an unstaged change the developer never asked for — it lands in
   unrelated commits and unrelated PRs. Plausibly a real adoption blocker.
2. *One global knowledge state instead of per-branch fragments.* On a
   long-lived feature branch you currently see only the records merged into
   that branch — colleagues' knowledge from last week is invisible. For a
   knowledge base, global-and-current beats branch-local-and-stale.
3. *Knowledge survives an abandoned branch.* What was learned on a branch that
   never merged is currently lost with it.
4. *Semantic merge instead of textual union.* Reconciling two refs can dedupe
   by record `id` rather than relying on `merge=union` line behaviour — a
   genuine improvement over today.

**The cost, and why it is smaller than it first appears:** the obvious
objection is that knowledge and code stop moving atomically. But the log is
already cumulative and multi-temporal — records are immutable and superseded,
never edited in place, so the file at any commit already describes code from
several eras. Append-only is precisely the structure that tolerates a separate
timeline.

**The real cost:** PRs are currently the *only* place a human sees a claim an
agent made about their code. A separate ref removes that surface — right
after we concluded that review is the missing piece.

**Therefore this idea is coupled to a review surface:** the separate ref is
defensible *if* something replaces the gate it removes. That was originally
idea 2 (the GUI) — idea 4 (write-time notification) turns out to be the
cheaper and earlier answer. Without either, the ref removes the only existing
gate and puts nothing in its place.

### Custom ref vs. orphan branch — settled by measurement

Some developers keep several worktrees on one repo, so the question was
whether a custom ref survives that. Measured, not remembered:

| Test | Result |
|---|---|
| `refs/shanpan/knowledge` visible in a second worktree | yes, identical SHA |
| written from the second worktree → seen in the main one | yes, immediately |
| `refs/worktree/private` visible in the second worktree | **no** |
| same branch checked out in two worktrees | `fatal: 'feature' is already used by worktree at …` |

Refs live in the shared `--git-common-dir`. Only `HEAD`, `refs/bisect/*`,
`refs/worktree/*` and `refs/rewritten/*` are per-worktree — row three confirms
that exception mechanism exists and that our ref does not fall under it.

So: **one knowledge state across all worktrees of a repo.** Correct — a
developer with three worktrees is one person with one memory, not three.

Row four decides the design question. A branch can be checked out in only one
worktree; the moment someone checks out a knowledge *branch* it is blocked
everywhere else. A ref that is never checked out cannot hit this. **Custom
ref, not orphan branch.**

**What stays per-worktree:** `.shanpan/` lives in the working directory, so
each worktree has its own Kuzu DB — which is right, the code differs per
worktree. But a materialised `knowledge.ndjson` beside it would be a separate,
possibly stale copy per worktree. Hence the rule:

> **The ref is the truth, the local file is cache.** Cache key is
> `git rev-parse refs/shanpan/knowledge` — a sub-millisecond call, so
> invalidation is trivial and staleness is structurally impossible.

### Storage backend — the change is smaller than the idea sounds

If the ref is the truth, how does `shanpan analyze` still read the file?
Counted in the code rather than assumed:

- **10 read sites**, every one through `readRecords(projectDir)` — including
  `analyze.ts:154`, `record-drift.ts:62`, three in the MCP server, two in
  `bootstrap`.
- **3 write sites**, every one through `appendRecords(projectDir, recs)`.
- **Exactly one file touches the filesystem**: `records.ts:243-259`.

Nobody opens `knowledge.ndjson` directly. The storage backend is therefore
swappable behind **two functions**, and `analyze` needs to know nothing.
`parseRecords(text)` is already separate and pure, so the "where do the bytes
come from" / "what do they mean" split is drawn as well.

**Two possible answers:**

- **A — materialise, but as cache.** The file stays at
  `.shanpan/knowledge.ndjson`, untracked, refreshed from the ref when its SHA
  changes. `readRecords` stays literally unchanged; the whole change is a
  refresh step in front of it.
- **B — never materialise.** `readRecords` becomes
  `git show <ref>:knowledge.ndjson` → `parseRecords`. One function body.

**Take A, and the deciding reason is error messages.** `validateRecord`
reports errors *with a line number*, and `shanpan records validate` prints
them — "line 47: malformed JSON". If the content exists only inside a git
object, line 47 of *what*? The developer has nothing to open. A materialised
file keeps that message actionable, and keeps `grep` and an editor working —
for a plaintext format that is part of the promise, not a side effect.

B additionally costs a subprocess per read, and the MCP server reads on nearly
every tool call. And without git there would be no knowledge at all, which
breaks non-repo usage and the tests.

**The hazard to secure first:** the write path becomes two-stage — append to
the cache, then commit to the ref. A crash in between leaves a record in the
file but not in the ref, and the next refresh would **silently drop it**.

> **The refresh must be a merge, never an overwrite.** Not `git show > file`,
> but union by record `id`.

That is the same semantic merge already required for concurrent pushes; it
just has to be used in the refresh path too, not only on push. Then an aborted
commit is harmless — the record is still there and reaches the ref next time.
`appendRecords` already writes whole lines so concurrent appends cannot
interleave (`records.ts:251`); that property carries over unchanged.

**Unaffected:** `missingProvenanceRefs` checks the *cited* files in the
working tree, not the ndjson itself. The fabrication gate keeps working as is.

**Migration:** today `.shanpan/knowledge.ndjson` is tracked and carries
`merge=union` on the code branch. It would become ignored — remove from the
index, seed the ref from its existing history, extend `.gitignore`, and keep
the old mode working for projects that do not want the move. Same care as the
`.specgraph` → `.shanpan` rename.

**Remaining mechanics:** read without checkout via `git show <ref>:<path>`;
write without checkout via `hash-object` / `commit-tree` / `update-ref`, so
nothing ever touches a worktree. Concurrent pushes need a fetch-merge-retry
loop, resolved semantically by record `id`. Shallow CI clones and fresh clones
do not get the ref by default — needs an explicit fetch in `init` / `analyze`.
That last one is where this will hurt in practice; think it through first.

---

## 4. Write-time notification, and behaviour as configuration

**The notification beats an objection raised against idea 3.** Auto-push
without review multiplies unvetted claims by the size of the team. Having the
agent surface a record to the developer right after writing it closes exactly
that gap — at the cheapest possible point.

**Review is cheapest at write time.** The developer still has the context in
their head; a wrong record costs twenty seconds to correct. The same record
three weeks later in a UI costs re-reading the code first. So this is not a
weaker substitute for the GUI, it is a **different station in a record's
life**: the notification catches what is born wrong, the GUI catches what
slipped through or drifted later.

Consequence for sequencing: notification plus configuration are small, and
together they could make the separate ref defensible **before** the GUI
exists.

**The one danger: notification fatigue.** If every record produces a line,
nobody reads them after a week — and then there is the *appearance* of review
without review, which is worse than none, because the records get trusted.

**So notify selectively.** The dividing line is the same one as in idea 1,
measurement versus interpretation: records whose claim the agent **observed**
(a test failure, an error message, a line it just read — with a resolving
pointer) pass silently. Records it **inferred** (`decision`, `rejected`,
anything with bare `a` and no pointer) get shown.

### Configuration — three axes, not one switch

```jsonc
{
  "knowledge": {
    "ref": "refs/shanpan/knowledge",
    "commit": "auto",          // auto | never
    "push":   "session-end",   // auto | session-end | never
    "pull":   "session-start", // session-start | on-read | never
    "notify": "inferred"       // all | inferred | never
  }
}
```

Proposed defaults are the values above:

- **commit: auto** — local and free, no reason not to. This is the axis that
  keeps the working tree clean.
- **push: session-end** — bundles the noise onto a natural checkpoint. Fits
  mechanically too: a session-end hook already exists, carrying
  `shanpan check`.
- **pull: session-start** — one network round trip per session instead of one
  per read.
- **notify: inferred** — see above.

### Prerequisite both ideas hid: the config must be tracked

Surfaced while asking how a fresh clone learns that a knowledge ref exists.
The answer was going to be "the config declares it" — except
`.shanpanrc.json` was ignored in this repo, on the reasoning that `init`
writes it byte-identical to `DEFAULT_CONFIG`, so there was nothing to track.

That reasoning holds only while the file carries no decisions. It stops
holding the moment it carries project policy — which ref, and the
commit/push/pull/notify axes above. Settings that are meant to be shared
cannot live in a file nobody shares; the ref approach would fragment at
exactly the point where it is supposed to create common ground.

The stronger reason came from the other direction: **it is the one file that
says a repository uses shanpan at all.** The graph is derived, the skills are
generated, the rc was ignored — and under the ref model the record file leaves
the worktree too. A freshly cloned project would be indistinguishable from one
that never adopted shanpan. Something has to declare it.

Now un-ignored and committed, with the README saying so. Note this rule was
local to this repository — nothing in `src/` writes `.gitignore` entries, so
user projects were never affected.

**Related, for the migration:** the same `.gitignore` currently re-includes
`knowledge.ndjson` with the comment *"the knowledge records are the source of
truth and must be committed."* Under the ref model that sentence inverts.
Migrating is therefore not just a `git rm --cached` — two rules that today
stand with good reasons have to be reversed, and the reasons in the comments
have to travel with them, or the next reader finds the opposite of what holds.
