---
description: Tidy the memory graph — cluster and link orphans, tune edge strengths, merge duplicates, split overloaded nodes
---

A curation pass over the stored memory graph. You are the gardener: read the whole graph, reason about how it
*should* be shaped, and make it so. This is not a fixed script — the analysis tools hand you evidence, and you
decide the edits.

## 1. Gather evidence

Call **both**, follow every listMemories cursor page including edge-only pages, and read every node's full text — don't act on snippets:

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

## 3. Apply the selected store policy

Read and follow this store policy. Automatic link changes, content updates, deletion, splitting and merging are allowed by default. Execute permitted work without another confirmation; preserve useful facts and provenance and honor explicit scope restrictions. If $ARGUMENTS is given, stay within its scope. Never substitute another store policy.

Inspect actual advertised tool schemas. Prefer mergeMemories when available. If unavailable, state that it is unavailable in this connection; do not claim the product has no such tool. A failed discovery leaves availability unverified. Refresh discovery after schema/version errors. Do not silently fall back to a sequential destructive merge.

## 4. Apply

- **Link** related memories → `updateMemoryLink` (action `add`). Links are directional in storage but read as
  undirected; one `add` per pair is enough.
- **Tune strength** → `adjustMemoryLinkStrength`. Reflect the relationship: ~0.85 for tightly-coupled/
  near-synonymous, ~0.7 for clearly related, ~0.4 for loosely associative. (New links land at 0.7 by default.)
- **Merge** duplicates → `mergeMemories` with the survivor `targetMemoryId`, absorbed `sourceMemoryIds`,
  complete merged `content`, and exact `expectedContents` for every original just read. Links move atomically.
  If an original changed, reread and reconsider before retrying. (As allowed by the selected store policy.)
- **Split** an overloaded node → `createMemory` one focused memory per distinct fact (link them with
  `relatedMemoryIds`), then either `updateMemory` the original down to a single remaining fact or
  `deleteMemory` it if fully superseded. (As allowed by the selected store policy.)
- **Edit** stale or bloated content → `updateMemory`.
- **Remove** a spurious link → `updateMemoryLink` (action `remove`). (As allowed by the selected store policy.)

Note: if `createMemory` reports the policy has no scope set, splitting/merging that creates nodes will be
refused — relay that and stop rather than working around it.

## 5. Show the result

Finish with `openMemoryGraph` and a short summary of what changed — links added, strengths tuned, merges/
splits done, and anything you flagged but left for the user to decide.

After uncertain writes, automatically inspect this same store before retrying; report only verified outcomes.
