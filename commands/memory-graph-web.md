---
description: Open the memory graph as an interactive webpage instead of a terminal view
---

Call the `openMemoryGraph` MCP tool (from the `oak-memory` server) with no arguments. It builds the graph
itself and opens it directly in the user's default browser — a real, draggable, zoomable force-directed
graph, not a terminal view or a chat-rendered diagram.

Report back only what the tool returned: whether it opened, the memory/link counts, and the fallback file
path if the browser did not launch automatically. Don't re-describe the graph's contents in the terminal —
that's what `/memory-graph` is for; this command's entire point is looking at it as a webpage instead.

Notes:
- This is a read-only view. Do not create, update, or delete anything unless the user explicitly asks after
  seeing the graph.
- If the tool reports no memories stored, just relay that — don't try anything else.
