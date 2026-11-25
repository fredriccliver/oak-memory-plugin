---
description: Recall stored memories relevant to a query
---

Call the `recallMemory` MCP tool (from the `oak-memory` server) with the query below, then summarize what was found conversationally. If nothing is found, say so plainly — don't guess or fabricate memories.

Search regardless of the configured recall level: running this command is an explicit request, which
outranks a policy about when to search unprompted.

When the tool supports them, use `topK` for starting memories and `hops` for connection depth. If
results are truncated, refine the query or traverse a returned memory for more context. Report use only
for an applied memory with a returned receipt when the selected store exposes `recordMemoryUse`.

Query: $ARGUMENTS
