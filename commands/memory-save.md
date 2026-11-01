---
description: Save a fact using the selected store policy
---

Read the selected store policy with the actual getMemoryPolicy tool. Cloud uses the cloud store policy; local uses that local store policy. New local stores default to automatic management. An invalid or unavailable existing policy suspends mutations; do not replace it with a default. An explicit save request needs no repeated approval within that store policy. Do not silently override a store restriction; update that store policy only when the user requests it and permissions allow.

Use the actual exposed tool schemas. Check recallMemory for duplicates in this same store, then update the matching fact or create it. Report confirmed results only. If a response is uncertain, automatically inspect the store before retrying. Do not assume failure means unchanged.

Text to remember: $ARGUMENTS
