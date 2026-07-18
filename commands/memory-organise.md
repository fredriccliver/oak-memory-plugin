---
description: Tidy the memory graph — cluster and link orphans, tune edge strengths, merge duplicates, split overloaded nodes
---

A curation pass over the stored memory graph. You are the gardener: read the whole graph, reason about how it
*should* be shaped, and make it so. This is not a fixed script — the analysis tools hand you evidence, and you
decide the edits.

## 1. Gather evidence

Call **both**, and read every node's full text — don't act on snippets:

- `listMemories` — full content, current links, per-node strength and age.
- `suggestMemoryLinks` — all-pairs embedding similarity: orphans (+ nearest neighbour), link candidates
  (near-duplicates flagged), existing links (stored strength vs actual similarity), and large multi-topic
  nodes. Pass `minSimilarity` lower if you want more candidates surfaced.

## 2. Reason about the shape

Build a mental model before touching anything:

- **Clusters** — which memories are one topic? (e.g. a product's work; a set of design preferences.)
- **Orphans** — unlinked memories that clearly belong to a cluster; note where each attaches.
- **Near-duplicates** — pairs the tool flags high-similarity: genuinely the same fact, or distinct facets
  worth keeping apart?
- **Overloaded nodes** — one memory carrying several independent facts, better split so each recalls on its own.
- **Mis-weighted / spurious links** — edges far weaker or stronger than the content warrants, or linking
  things that aren't really related.

## 3. Decide the edits, and confirm the lossy ones

Sort your intended changes into two buckets:

- **Additive / reversible — just do them, then report**: adding links between related memories; tuning edge
  strengths to match how related things are.
- **Lossy or destructive — describe first and get an explicit yes**: merging duplicates (one memory gets
  deleted), splitting a node in a way that deletes the original, removing links, or rewriting content
  substantially. Deletion is irreversible; never do it on your own initiative here. List exactly what you'd
  merge/split/delete and why, then wait.

If `$ARGUMENTS` is given, treat it as scope or intent (e.g. "just the design memories", "be aggressive about
merging", "only fix links, don't touch content") and stay within it.

## 4. Apply

- **Link** related memories → `updateMemoryLink` (action `add`). Links are directional in storage but read as
  undirected; one `add` per pair is enough.
- **Tune strength** → `adjustMemoryLinkStrength`. Reflect the relationship: ~0.85 for tightly-coupled/
  near-synonymous, ~0.7 for clearly related, ~0.4 for loosely associative. (New links land at 0.7 by default.)
- **Merge** duplicates → `updateMemory` on the survivor to fold in anything unique from the other, re-`add`
  any links the other carried, then `deleteMemory` the redundant one. (Confirmed in step 3.)
- **Split** an overloaded node → `createMemory` one focused memory per distinct fact (link them with
  `relatedMemoryIds`), then either `updateMemory` the original down to a single remaining fact or
  `deleteMemory` it if fully superseded. (Confirmed in step 3.)
- **Edit** stale or bloated content → `updateMemory`.
- **Remove** a spurious link → `updateMemoryLink` (action `remove`). (Confirmed in step 3.)

Note: if `createMemory` reports the policy has no scope set, splitting/merging that creates nodes will be
refused — relay that and stop rather than working around it.

## 5. Show the result

Finish with `openMemoryGraph` and a short summary of what changed — links added, strengths tuned, merges/
splits done, and anything you flagged but left for the user to decide.
