---
description: Show the active memory profile, graph, access role and recording identity
---

Call `memoryConnectionStatus` to verify the active profile and its server-authorized context.
Call `listMemoryProfiles` when comparing configured profiles. For cloud, use the
returned `currentMemoryStore` context and present a compact indicator:

`Memory: <profile> / <graph name> | <role> | recorded by <authenticated identity>`

Include the graph ID if the user needs to distinguish same-named graphs. Explain
that the recording author is distinct from semantic subjects and quoted speakers.
For local mode, show the local backend and configured identity from `getMemoryPolicy`.
Do not guess an identity from prior conversations or treat a failed status as a
successful connection. Report errors with the selected profile and a safe next
step (check key/membership/network, then retry), without showing credentials.
Use `/oak-memory:memory-connect` for setup and `/oak-memory:memory-profile` to switch.
