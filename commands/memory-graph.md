---
description: Show all stored memories and how they link together as a graph
---

Call the `listMemories` MCP tool (from the `oak-memory` server) to get every stored memory and every link
between them, then show the user their memory graph.

Present it in two parts:

1. **In the terminal** — a short readable summary: how many memories and links there are, then the memories
   themselves grouped into connected clusters, with unlinked ones listed separately at the end. Use each
   memory's own words rather than paraphrasing them into something tidier. Don't dump raw UUIDs into prose;
   short 8-character prefixes are enough for the reader to match a node to a link.

2. **As a visual graph** — render the graph as a mermaid `graph TD` diagram and publish it with the Artifact
   tool so the user can actually see the node connections. One node per memory, labelled with a short excerpt
   of its content (truncate to roughly 40 characters, and escape any `"` in the text). Draw reciprocal links
   as `---` and one-directional links as `-->`. Style nodes by strength so weak memories are visibly faded,
   and give unlinked memories a dashed border so orphans stand out. If there are no links at all, say so
   plainly instead of publishing an empty diagram.

$ARGUMENTS may narrow what to show (for example a topic, or "orphans" to focus on unlinked memories). If it's
empty, show everything.

Notes:
- This is a read-only view. Do not create, update, or delete anything unless the user explicitly asks after
  seeing the graph.
- If there are no memories at all, just say so — don't publish an empty artifact.
