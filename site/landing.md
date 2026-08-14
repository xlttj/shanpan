# Shanpan

**A living graph of your code — with the knowledge welded to every node.**

Shanpan parses your codebase into a graph: every file, class, and method, and the calls between them. Then it ties documentation, decisions, and hard-won lessons directly onto that graph — from the whole module down to a single method. Your AI agent doesn't get a pile of notes. It gets the right knowledge, attached to the exact code it's touching.

---

## A live map of your code

Shanpan builds a graph of your symbols and the relationships between them — who calls what, what contains what, what depends on what. It's queryable. Your agent can ask "who calls this method," "what breaks if I change this signature," "what's the blast radius" — and get a precise answer instead of grepping and guessing.

## Knowledge welded to the graph

Every trap, invariant, and decision is a record anchored to a node in that graph — a method, a class, a file, a directory. It's not documentation sitting in a folder hoping someone reads it. It's structural: the knowledge *is* attached to the code it describes.

## From the whole module down to a single method

This is the part that changes everything. Knowledge attaches at any level and **inherits downward**. A rule pinned to a module applies to every file beneath it. A constraint on a class reaches all its methods. Edit one method, and you see its own notes *plus* everything inherited from its class, its file, and its module — most specific first.

Write "this bounded context must stay idempotent" once, at the directory. Every method in the subtree inherits it, automatically, forever.

## Ask the graph, not the whole repo

Because knowledge lives on the graph, retrieval is exact. When your agent edits a file, the relevant records are injected before the first change — scoped to that file's place in the tree. No searching. No stuffing the entire knowledge base into context and hoping the model finds the right line.

## Every claim carries its source

A memory you can't trust is worse than none. Every record names where it came from — the user, a commit, a test, a document, or an agent's own observation — and weak inferences are marked as weak.

Fabrication fails by construction: if a record cites a source file, that file has to exist, or the record is rejected before it's ever saved. No made-up citations.

## Stays honest as the code moves

The graph is rebuilt as your code changes. Rename, move, or delete a symbol, and Shanpan sees that a record no longer points at anything real and flags the drift. Knowledge doesn't quietly rot into confident, wrong advice.

## It lives in your repository

The knowledge layer is plain text, committed alongside your code. It travels with the repo, reviews in pull requests, and merges cleanly across branches. No external service to sync. Clone the repo, and both the code and its knowledge come with it — the graph rebuilds locally in seconds.

## Records what was tried — and rejected

The most valuable thing lost between sessions is the road not taken. Shanpan keeps rejected approaches as first-class records on the graph, so no one re-proposes the idea that was already ruled out for reasons nobody wrote in the commit.

## Works where you already work

Shanpan plugs into Claude Code, Cursor, and OpenCode — through automatic injection, editor rules, or direct graph queries over MCP. One graph, one source of truth, every tool.

## Start on a codebase that already has history

Point Shanpan at an existing project and it seeds the graph and an initial knowledge layer from what's already there — decision docs, marker comments, reverted commits. You don't start from an empty page.

---

## Why "Shanpan"?

算盘 — the abacus, a device for reckoning. And シャンパン — champagne, as in *drinking your own champagne*, the classier take on eating your own dog food. A tool built by using it on itself, named for the practice that shaped it.

---

## Give your codebase a graph that remembers

Install the CLI, point your agent at it, and stop losing what you learn.

**[Get started]** · **[Read the docs]** · **[View on GitHub]**
