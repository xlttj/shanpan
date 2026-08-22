# Manual test checklist — knowledge on a git ref

Everything on this list is here for one reason: it could not be verified in the
environment the feature was built in. The automated suite covers the logic
(fetch, merge, the merge-commit parent, retry, the non-retryable failure) against
a local bare repository. What is left needs a real remote, real worktrees, and a
real editor session.

**The blocker to settle first is step 2.** The build environment's proxy refuses
to push anything outside `refs/heads` (HTTP 403). If that also happens on your
machine, the whole approach needs a different transport, and **step 7 must not
be attempted** — untracking the knowledge file while the ref cannot leave your
laptop would strand every record on one machine.

Steps 1–6 are safe and reversible. Step 7 is the one that changes how the
repository stores knowledge; step 8 undoes it.

---

## 0. Preparation

```bash
git fetch origin
git switch knowledge-ref
npm install && npm run build && npm test        # expect 402 passing
```

Back the log up before touching anything. It is the one artefact here that
cannot be rebuilt:

```bash
cp .shanpan/knowledge.ndjson ~/shanpan-knowledge-backup.ndjson
wc -l ~/shanpan-knowledge-backup.ndjson         # note the number
```

The config on this branch already sets `knowledge.ref`. `remote`, `pull` and
`push` are absent, so their defaults apply: `origin`, `auto`, `auto`.

---

## 1. The ref exists locally, and is not a branch

```bash
shanpan upgrade
```

- [ ] prints `✓ Created knowledge ref refs/shanpan/knowledge` (or `already present`)
- [ ] `git for-each-ref refs/shanpan` lists it
- [ ] `git branch --list` does **not** list it — this is the property that makes
      it worktree-safe
- [ ] `git show refs/shanpan/knowledge:knowledge.ndjson | wc -l` matches your backup
- [ ] `git status --porcelain -uno` is empty — creating the ref touched nothing tracked

---

## 2. Push to the real remote ⚠️ the decisive step

```bash
shanpan sync
git ls-remote origin 'refs/shanpan/*'
```

- [ ] sync prints `✓ pushed`
- [ ] `ls-remote` shows `refs/shanpan/knowledge`

**If it fails**, sync now quotes git verbatim instead of guessing. Read what it
says:

- `403` / `denied` / `permission` → the host or a proxy is refusing custom refs.
  This is the blocker. Stop here and skip to step 8; do not attempt step 7.
- `does not appear to be a git repository` → wrong `knowledge.remote`.
- anything about `non-fast-forward` → someone else pushed; run `shanpan sync`
  again, it is built to converge.

---

## 3. A second clone receives the knowledge

```bash
git clone <repo-url> /tmp/shanpan-b
cd /tmp/shanpan-b
git switch knowledge-ref
npm install && npm run build
node dist/cli/index.js sync
```

- [ ] reports `N record(s) received`
- [ ] `git show refs/shanpan/knowledge:knowledge.ndjson | wc -l` matches step 1

### Convergence — both sides write before either syncs

This is the case the merge-commit parent exists for. Do it in this order, and
do **not** sync in between.

In clone B:

```bash
printf '%s\n' '{"id":"bb11bb11bb","kn":"gotcha","cl":"probe from clone B","pv":"u","ts":"20260822120000"}' \
  >> .shanpan/knowledge.ndjson
```

In your main clone:

```bash
printf '%s\n' '{"id":"aa11aa11aa","kn":"gotcha","cl":"probe from clone A","pv":"u","ts":"20260822120100"}' \
  >> .shanpan/knowledge.ndjson
shanpan sync          # pushes first
```

Back in clone B:

```bash
node dist/cli/index.js sync    # must not be rejected forever
node dist/cli/index.js sync    # idempotent: "Already up to date."
```

- [ ] B's sync succeeds and reports `1 record(s) received, pushed`
- [ ] B's log holds **both** probes
- [ ] main clone: `shanpan sync` then shows both as well
- [ ] a second `shanpan sync` with nothing to do prints `Already up to date.`
      and leaves `git rev-parse refs/shanpan/knowledge` unchanged

Remove the probes afterwards (they are test data, not knowledge):

```bash
grep -v '"id":"aa11aa11aa"\|"id":"bb11bb11bb"' .shanpan/knowledge.ndjson > /tmp/clean.ndjson
mv /tmp/clean.ndjson .shanpan/knowledge.ndjson
rm -f .shanpan/knowledge-ref.json      # forces a re-merge from the ref
```

Then rewind the ref past the probe commits and push with `--force`, or simply
leave them — two junk records are harmless, and rewriting shared history is
worse. Your call.

---

## 4. Several worktrees see one knowledge state

```bash
git worktree add -b wt-probe ../shanpan-wt
cd ../shanpan-wt
git rev-parse refs/shanpan/knowledge
```

- [ ] same sha as in the main worktree
- [ ] `node <main>/dist/cli/index.js sync` here does not conflict with the main one
- [ ] each worktree has its own `.shanpan/graph.db` (correct — the code differs)

```bash
cd - && git worktree remove ../shanpan-wt && git branch -D wt-probe
```

---

## 5. The hooks actually fire

Only the installed configuration was verified in tests, never a real trigger.

```bash
grep -A3 'shanpan managed' .git/hooks/post-merge
git switch main && git switch knowledge-ref     # triggers post-checkout
```

- [ ] the hook files contain `shanpan sync --quiet`
- [ ] a checkout with nothing to sync prints **nothing** (that is what `--quiet` is for)
- [ ] a checkout after someone else pushed knowledge does print a line

In your editor:

- [ ] start a session → `shanpan sync` runs (check `git log -1 refs/shanpan/knowledge`
      or watch for the fetch)
- [ ] end a session → sync runs again
- [ ] neither one makes the editor hang — both are configured async where the
      host supports it

---

## 6. Write a record through the agent, end to end

With the MCP server connected, have the agent record something with provenance
`i`, then:

- [ ] the response carries the `Unvouched —` notice and the agent relays the claim
- [ ] `git show refs/shanpan/knowledge:knowledge.ndjson | tail -1` shows it
- [ ] `git log -1 --format='%s %an' refs/shanpan/knowledge` shows
      `knowledge: add 1 record(s) — <id>` under **your** git identity
- [ ] `git status` shows no new modification from the write itself
      (the tracked cache file will still differ until step 7)

---

## 7. Migration — the log becomes cache ⚠️ only after step 2 succeeded

```bash
git ls-remote origin 'refs/shanpan/*'    # confirm once more it is really there
git rm --cached .shanpan/knowledge.ndjson
```

Then edit `.gitignore`: drop the `!.shanpan/knowledge.ndjson` and
`!.shanpan/knowledge.archive.ndjson` re-includes so `.shanpan/*` covers
everything, and rewrite the comment above them — it currently says the records
are the source of truth and must be committed, which becomes the opposite of
what holds.

```bash
git add .gitignore && git commit -m "Knowledge lives on the ref; the file is cache"
git status --porcelain          # writing a record no longer shows up here
```

### The unfetched clone must be loud

```bash
git clone <repo-url> /tmp/shanpan-c
cd /tmp/shanpan-c && git switch knowledge-ref
npm install && npm run build
node dist/cli/index.js analyze --full
```

- [ ] no `knowledge.ndjson` in the clone
- [ ] a record read through MCP says *"this project keeps its knowledge on
      refs/shanpan/knowledge, which this clone does not have"* — **not** an empty list
- [ ] `get_server_info` reports `knowledge_ref_present: false`
- [ ] `node dist/cli/index.js sync` then fetches everything and the records appear

This is the single most important check on the list. An empty knowledge base and
unfetched knowledge look identical to an agent, and it will trust the first
reading.

---

## 8. Undo

Any step, in reverse:

```bash
# remove the ref from the remote
git push origin :refs/shanpan/knowledge

# remove it locally
git update-ref -d refs/shanpan/knowledge
rm -f .shanpan/knowledge-ref.json

# back to the file as source of truth
git checkout .gitignore
git add .shanpan/knowledge.ndjson
cp ~/shanpan-knowledge-backup.ndjson .shanpan/knowledge.ndjson   # if anything went wrong

# turn the feature off entirely
#   set "knowledge": { "ref": null } in .shanpanrc.json
```

With `ref: null` everything behaves exactly as it did before this branch — that
path is covered by the automated suite, so it is a real escape hatch rather than
a hopeful one.
