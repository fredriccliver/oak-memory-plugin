---
description: Connect Claude Code to a personal or shared cloud memory graph
---

Guide the user through cloud connection without requesting a key in conversation.

1. Show whether `listMemoryProfiles` is available. Use `memoryConnectionStatus` for safe connection errors. For a connected profile, use
   its `currentMemoryStore` context and display graph name/ID, role, and authenticated author.
2. If setup is needed, have the user sign in with email at the Memory dashboard,
   select a graph, and download its nonsecret `profiles.json`. Graph discovery is
   not permission to issue credentials. Explain the concrete key issuance/config
   step and obtain action-time approval before the user completes it.
3. Have them open `/plugin`, select `oak-memory@oak-memory`, and choose Configure.
   Set Memory profiles file to the absolute downloaded-file path. Starting memory
   profile is optional. Enter the JSON map of per-graph keys only in the masked
   Personal graph keys (secure) field; Claude stores it securely. Do not display,
   inspect, echo, screenshot, or log secrets. Never paste keys into this chat.
   A private environment/credential manager is an alternative.
4. Restart Claude Code after changing persistent configuration. Run
   `/oak-memory:memory-status` to verify graph, role and authenticated identity.
   A missing/expired key or membership is a visible error; never fall back locally.
5. Use `/oak-memory:memory-profile` to select another configured graph for this
   session. Each graph needs its own matching personal key/profile. Stored defaults
   apply to new sessions, while in-flight calls retain their graph.

Cloud mode needs no Docker, Ollama, or DB URL. Existing local configuration and
memories remain separate. Do not replace the user's existing local default or
install production keys without their approved handoff. See
`docs/claude-cloud-onboarding.md` for exact installation and configuration paths.
