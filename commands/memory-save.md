---
description: Explicitly save a fact to long-term memory
---

The user wants this remembered explicitly, right now — don't wait for your own judgment about whether it's worth storing.

1. Call `recallMemory` with a short query derived from the text below to check whether a similar or conflicting memory already exists.
2. If a similar memory exists, call `updateMemory` on it. Otherwise call `createMemory` with the text below as `content`.
3. Confirm briefly what was stored.

Text to remember: $ARGUMENTS
