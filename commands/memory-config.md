---
description: Show or change what oak-memory remembers about you, when it saves, and how hard it searches
---

Call the `getMemoryPolicy` MCP tool (from the `oak-memory` server) first, always. It reports the policy the
server actually resolved at startup, which is not necessarily what the config files say — read the files
instead and you may report a policy that isn't running.

**If it reports no policy set**, that outranks whatever $ARGUMENTS says — nothing is being stored, and the
only thing worth doing is getting them to choose. Say so in a sentence, say which of the three reasons it is,
and ask them for a scope, offering the four by name with what each one means. Don't editorialize about a
default being in force; there isn't one. Then take their answer and apply it as a change below. If $ARGUMENTS
already names a scope, just apply it — they've answered.

Otherwise, depending on $ARGUMENTS:

**Empty** — show the current policy: the effective scope, autosave, and recall level, one plain-language
sentence on what that combination means in practice, and where to change it. Don't dump the raw rule text
unless asked; summarize it. Mention `/memory-config <what you want>` as the way to change it.

**Anything else** — treat it as the change they want, and make it:

1. Work out which of the three axes they're touching. They may mean any combination:
   - **Scope** (`MEMORY_POLICY_SCOPE`): `preferences`, `important`, `everything`, or `custom`
   - **Autosave** (`MEMORY_POLICY_AUTOSAVE`): `true` (saves proactively) or `false` (only on `/memory-save`)
   - **Recall** (`MEMORY_POLICY_RECALL`): `minimal`, `balanced`, or `aggressive`
2. If it's ambiguous which axis or value they mean, ask rather than guess — this governs what gets written
   about them, so a wrong guess is worse than a question. Watch for requests that sound like one axis but
   mean another: "remember less" is usually scope, "ask me first" is autosave, "you keep forgetting" is
   recall.
3. Edit the env file at the path `getMemoryPolicy` reported. Change only the keys involved; leave the rest of
   the file alone. If a key isn't present yet, append it.
4. For `custom`, also write their rule to the policy file path `getMemoryPolicy` reported. Everything outside
   HTML comments in that file is handed to the model verbatim as the rule, so write it as an instruction
   ("Store only my coding preferences and architecture decisions"), not as a note about the user. Keep any
   existing HTML comment header.
5. Confirm what changed, and tell them it applies **after restarting Claude Code** — the policy is read at
   server startup and the instructions reach the client during the initial handshake, so nothing changes
   mid-session.

Requested change: $ARGUMENTS

Notes:
- Never edit `MEMORY_DATABASE_URL` or any other key here; this command is only about the policy.
- Never pick a scope for them, however obvious it seems or however much they defer to you — an unset scope
  is the one thing here you cannot supply on their behalf. Recommending one is fine; recording an answer
  they never gave is not.
- Changing the policy never touches stored memories. If they want to *remove* what's already there, that's
  `deleteMemory` — and say so explicitly rather than letting them assume a narrower scope retroactively
  forgets anything.
