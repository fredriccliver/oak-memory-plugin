---
description: Show or switch the selected local/cloud memory profile
---

Call `listMemoryProfiles` to show configured profiles. If the user names a profile,
call `selectMemoryProfile` with that name, then show the server-verified active
graph, role, and authenticated identity from `currentMemoryStore` (or local
`getMemoryPolicy`). This selection is for this session only; stored defaults apply
to future sessions. A failed switch keeps the prior profile. Never silently fall
back to local after network or authentication errors.

To connect a new graph, use `listMemoryStores` for discovery. Each cloud graph
requires its own personal graph-bound key/profile. Discovery grants no key.
Follow `docs/cloud-profiles.md`: explain the concrete credential/configuration
step and obtain user action-time approval before issuing or persistently storing
access. Hand off email login and one-time key entry to the user. Never ask for a
secret in chat or put keys in logs. Do not modify existing local configuration or
migrate memories. Do not install live Claude configuration without approval.

Authenticated author and semantic subject are distinct. Preserve original quotes
and speakers, and never guess who a quoted “I” describes.
