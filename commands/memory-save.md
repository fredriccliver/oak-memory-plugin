---
description: Explicitly save a fact to long-term memory
---

The user wants this remembered explicitly, right now — don't wait for your own judgment about whether it's worth storing.

This overrides the configured memory policy on both axes: store it even when autosave is off, and even when
the fact falls outside the configured scope. Asking for something to be remembered *is* the decision the
policy exists to make on their behalf — running this command means they've made it themselves.

1. Call `recallMemory` with a short query derived from the text below to check whether a similar or conflicting memory already exists.
2. If a similar memory exists, call `updateMemory` on it. Otherwise call `createMemory` with the text below as `content`.
3. Confirm briefly what was stored.

Text to remember: $ARGUMENTS
