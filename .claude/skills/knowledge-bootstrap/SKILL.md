---
name: knowledge-bootstrap
description: Seed an existing project's knowledge base for the first time. Use once, when specgraph has just been added to a codebase that has history but no records yet.
---

# Knowledge Bootstrap

A codebase carries knowledge in places a scanner cannot guess: decisions in a
wiki, caveats in a CONTRIBUTING file, rationale in commit threads, conventions
only the team knows. Your job is to find where knowledge actually lives in THIS
project and drive the tools accordingly — not to trust defaults.

The "specgraph bootstrap" command is a deterministic scanner. It reliably reads
three mechanical sources — marker comments, git reverts, and structured decision
docs — but it only looks where you point it. You supply the judgment about where
that is and what is worth keeping.

## Do not assume — ask

Before running anything, ask the user:

1. **Where are decisions and design documents kept?** ADRs, an "architecture/"
   folder, a docs site, a wiki, long-lived issues? Do not assume "docs/adr".
2. **Are there sources outside the repo?** Notion, Confluence, Linear, a design
   doc drive. You may be able to reach these through connected tools even though
   the CLI cannot.
3. **Does the team use its own comment tags?** Beyond HACK/FIXME/XXX, some use
   KLUDGE, REVIEW, DEBT, or a "@"-prefixed convention.

If the user does not know or defers, survey the repo yourself (list top-level
dirs, look for docs/, adr/, architecture/, *.md at root) and propose what you
found before writing anything.

## The process

1. **Run "specgraph analyze" first.** Marker gotchas attach to files and symbols
   need to exist for later record subjects to resolve.

2. **Dry-run before writing.** Always start with:
   specgraph bootstrap --dry-run --doc <where-decisions-live> --marker <custom-tag>
   Point --doc at whatever the user told you (a file or a directory, repeatable).
   Add --marker for each project-specific tag. Pass --no-adr if the auto-detected
   ADR directories are wrong for this project.

3. **Review the candidate counts and cull.** A project with 400 FIXMEs does not
   have 400 pieces of knowledge — it has a backlog. If the marker count is huge,
   the markers are noise, not caveats: narrow the marker set, or skip markers and
   record only the genuinely load-bearing ones by hand. A thin, trusted base
   beats a large, noisy one.

4. **Commit the run** by dropping --dry-run once the counts look right.

5. **Read prose docs yourself.** The scanner only understands structured ADRs
   (an H1 title and a "## Decision" section). A prose design doc, a README
   rationale, a wiki page — read it and record what it decided with "add_record",
   provenance "d:<path>" (or "u" if it came from the user, not a file). Do not
   point --doc at unstructured prose and expect a good claim.

6. **Pull from sources only you can reach.** If the team keeps decisions in a
   connected tool (Notion, Confluence, Linear), read the relevant pages and
   record the decisions and rejected approaches you find. Provenance is a matter
   of judgment here: use "d:" with a URL-ish pointer, or "u" if the user
   confirmed it in conversation.

7. **Verify.** Run "specgraph records index" then "specgraph check". Resolve any
   unresolved subjects — usually a symbol id that needs "search_symbols" to fix.

## Provenance stays honest

The scanner sets provenance for you: n:file:line for markers, g:sha for reverts,
d:path for docs. When YOU add records from judgment, set it just as honestly —
"d:" for something you read, "u:" for something the user stated, and "i:" only
when you inferred it with no source. Never invent a reason to fill a gap. See the
record-knowledge skill for the discipline.

## This runs once

Bootstrap seeds a base. It is not how the knowledge base stays current — that is
the per-task loop in knowledge-lookup and record-knowledge. Bootstrap is
deliberately partial; say so to the user when you finish, and point them at the
ongoing loop.

<!-- specgraph-managed-skill -->
