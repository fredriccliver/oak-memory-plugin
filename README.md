# oak-memory-plugin

An OAK.memory plugin for **Codex and Claude Code** that provides persistent, cross-project long-term memory
about you, backed by a real vector+graph database rather than flat markdown notes.

Claude Code's built-in memory is a folder of markdown notes. That's fine for lightweight preferences, but it
doesn't do semantic search, doesn't rank by relevance, and doesn't model relationships between facts.
This plugin integrates [OAK.memory](https://openaikits.com) — an autonomous memory
infrastructure for AI ([`@openaikits/memory`](https://github.com/fredriccliver/Memory),
[technical paper](https://lnkd.in/gqgzejUV)) — exposed as an MCP server, so Codex and Claude can recall and store facts
about you the same way across every project and every session.

OAK.memory's premise is that memory belongs in the stack as **infrastructure**, the way inference and model
providers already are — general-purpose and domain-independent, not re-invented per application. Its core idea
is the **entity-specific associative network**: associations differ per individual, so personalization comes
from the memory graph rather than from fine-tuning the model. This plugin is one consumer of that
infrastructure; the engine itself knows nothing about the AI client using it.

## Cloud profiles and graph selection

Cloud mode needs Node and a personal graph-bound API key. It does not require Docker,
Ollama, or `MEMORY_DATABASE_URL`. See [cloud profile setup](docs/cloud-profiles.md)
for the approval handoff and configuration. Local and cloud stores stay separate;
there is no migration or synchronization. Existing installations without profiles
keep their current local configuration.

## Local requirements

This plugin is **not zero-install**, and installing it does **not** provision anything on its own — there is
no auto-setup on install. It runs a real database and a local embedding model, which you stand up **once**
with `npm run setup` before the plugin works:

- **[Docker](https://www.docker.com/products/docker-desktop/)** — runs the Postgres + pgvector container that
  holds your memories.
- **[Ollama](https://ollama.com/download)** — generates embeddings locally (`bge-m3`, ~270 MB, pulled for
  you). No API key; nothing leaves your machine.
- **Node.js 22+** and a **local checkout of this repo** — `npm run setup` lives here and is where the one-time
  provisioning runs. A marketplace install only copies the packaged plugin; it does not clone a development
  checkout from which setup can run.

```bash
git clone https://github.com/fredriccliver/oak-memory-plugin
cd oak-memory-plugin
npm install
npm run setup     # starts Postgres, pulls the model, writes shared config, asks your memory policy
```

Until `npm run setup` has written `MEMORY_DATABASE_URL` (normally into
`~/.config/oak-memory/oak-memory.env`), the server exits at
startup — the database URL is the one setting with no safe default. Once setup passes, register the plugin
(see [Install](#install)) and the memory is live in every project. Full details and manual/hosted-DB
alternatives are in [Setup](#setup).

## Why this exists

This is deliberately **not** a replacement for project-scoped `AGENTS.md`, `CLAUDE.md`, or file-based
project memory. Those own "facts about this project." This plugin owns "facts about *you*" — your preferences,
experiences, and decisions — in the selected personal or shared memory graph. If you
ever need to split that (e.g. a work identity vs. a personal identity), see [Entity scoping](#entity-scoping).

## Architecture

```
Codex / Claude Code  <-- MCP -->  this plugin's stdio server  -->  @openaikits/memory  -->  Postgres (pgvector)
                                                                            |
                                                                  Ollama (local embeddings)
```

Retrieval is **hybrid vector-graph**: semantic similarity finds entry points, graph traversal pulls in what's
associated with them. Edges are *pure structural connections* — they carry no semantic embedding of their own,
so what a link "means" is interpreted at query time rather than frozen when the link is created. That's why
`updateMemoryLink` takes no description, and why `/memory-graph` renders links as bare connections: there is no
edge semantics to display, by design.

Embeddings run **fully locally** via [Ollama](https://ollama.com) (`bge-m3` by default) — no
OpenAI API key, no per-call cost, no data leaving the machine. See [Local embeddings](#local-embeddings) for
how this is wired given the engine's schema hardcodes a different vector width than local models produce.

Every memory operation is **model-initiated tool calling**: nothing intercepts your prompt to search on your
behalf, and nothing writes without the model deciding to. What a `UserPromptSubmit` hook adds is timing, not
authority — it restates your policy alongside each prompt, so recalling and saving are decided next to the
work instead of by a system-prompt instruction that has been decaying since session start. It is closer to
`MemoryConnector.prepareContext()` than to `onAfterResponse()`: it primes the turn, then gets out of the way.
See [Memory policy](#memory-policy).

Claude Code also exposes slash commands for explicit invocation. In Codex, use ordinary requests such as
"remember this", "what do you remember about my workflow?", or "show my memory graph"; the bundled skill
maps those requests to the same MCP tools.

## Tools exposed

| Tool | Purpose |
|---|---|
| `recallMemory` | Search memory for facts relevant to a query (ranked by similarity, graph links, recency, strength). The main read-path tool — call it before answering anything that might depend on prior context, and before `createMemory` to avoid duplicates. |
| `listMemories` | Dump *every* memory and every link — the whole graph, no query, no ranking. For seeing/auditing what's stored rather than finding what's relevant. Backs `/memory-graph`. |
| `openMemoryGraph` | Render the same graph as an interactive, force-directed HTML page and open it in the default browser. Backs `/memory-graph-web`. |
| `suggestMemoryLinks` | Read-only structural analysis: all-pairs embedding similarity surfacing orphans, link candidates (near-duplicates flagged), each edge's stored strength vs. actual similarity, and oversized split candidates. Evidence for a curation pass; writes nothing. Backs `/memory-organise`. |
| `createMemory` | Store a new fact/preference/experience about you. |
| `updateMemory` | Update an existing memory (by UUID) when info has changed. |
| `updateMemoryLink` | Add/remove a link between two memories so they're more likely to surface together later. |
| `adjustMemoryLinkStrength` | Set an existing link's strength (0–1, both directions) — the tuning knob `updateMemoryLink` doesn't expose (it fixes new links at 0.7). Stronger links co-surface harder in recall. |
| `deleteMemory` | Delete a memory. Irreversible — used sparingly. |
| `getMemoryPolicy` | Report the policy the server actually resolved at startup. Reads no memories. Reports the *effective* policy, which isn't always what the config says — see [Memory policy](#memory-policy). |

Local tools use the configured local identity (`MEMORY_ENTITY_ID`). Cloud tools use the selected server-authorized personal or shared graph — the
model never supplies or sees an entity/user id.

## Slash commands

| Command | Purpose |
|---|---|
| `/memory-recall <query>` | Explicitly recall memories relevant to a query. |
| `/memory-save <text>` | Explicitly store a fact right now, without waiting for the model to decide it's worth keeping. |
| `/memory-graph [filter]` | Show everything stored: a terminal summary plus a rendered node graph (published as an Artifact, since terminals can't draw mermaid) with reciprocal links merged and unlinked memories flagged. |
| `/memory-graph-web` | Open the same graph as a real webpage instead: a draggable, zoomable, force-directed view in your default browser rather than the terminal or a chat-rendered diagram. |
| `/memory-organise [scope]` | Curate the graph by reasoning: cluster and link orphans, tune edge strengths, and — with your confirmation — merge duplicates or split overloaded memories. Additive edits apply directly; lossy ones ask first. |
| `/memory-config [change]` | Show the effective policy, or change it in words ("only remember my preferences", "stop saving unless I ask"). |

## Memory policy

Nothing here searches or writes on your behalf. `recallMemory` and `createMemory` are ordinary tools the model
chooses to call, exactly like reading a file. So what governs memory is what the model is *told*, and the
policy is how you set that.

Your choices are compiled into a rule and handed to the model over three channels: the MCP `instructions`
field, which the client injects into the system prompt at session start; the tool descriptions themselves;
and a `UserPromptSubmit` hook, which restates the rule alongside every prompt. The first two are belt and
braces — a client that ignores `instructions` still renders tool descriptions, and a client that defers tool
schemas until first use still shows `instructions`.

The third is there because being told is not the same as acting on it. Both of the other channels are read
once and then spend the session competing with whatever you actually asked for — and the turn that produces a
fact worth keeping is precisely the turn the model is busy doing something else. Autosave failed that way in
practice: not by refusing, but by never coming up. A rule that arrives and loses is indistinguishable from one
that never arrived. So the fix is timing rather than authority: the hook fires when the harness says so, and
puts the rule next to the work instead of an hour behind it.

It reads the same policy the server does — one `loadPolicy()`, one verdict — and says only what your policy
actually asks for. Turn `MEMORY_POLICY_AUTOSAVE` off and the saving half disappears; set `MEMORY_POLICY_RECALL`
to `minimal` and the searching half does; do both and the hook goes silent entirely. It enforces your policy,
it does not outrank it.

> **Why not `Stop`?** It was built and tested first, and it worked — the turn boundary is strictly better
> timing for saving, since it also catches facts that surface mid-turn from a file or a command, which this
> hook only sees on your next prompt. It was dropped because blocking a stop forces the model to emit another
> message, and there is no empty message: every answer picked up a trailing *"No memory-worthy content in this
> turn."* Under `claude -p`, where only the last message is printed, that line **replaced the answer** —
> `claude -p "reply with one word: ping"` printed the memory check instead of `ping`. Prompting for silence
> doesn't fix it; silence has to be structural. This hook adds context and no message, so the same prompt
> prints `ping`.

Three independent axes, chosen at `npm run setup` and changeable any time:

| Axis | Variable | Values | Setup wizard default |
|---|---|---|---|
| **What to remember** | `MEMORY_POLICY_SCOPE` | `preferences`, `important`, `everything`, `custom` | `everything` |
| **When to save** | `MEMORY_POLICY_AUTOSAVE` | `true` (proactively), `false` (only when explicitly asked) | `true` |
| **How hard to search** | `MEMORY_POLICY_RECALL` | `minimal`, `balanced`, `aggressive` | `balanced` |

The scope has no runtime default: if `MEMORY_POLICY_SCOPE` is absent or invalid, writes fail closed. The
`everything` value above is only the choice preselected by the interactive setup wizard.

Reading and writing are separate axes because they have different costs. Writing is the side with the privacy
question, so it gets its own switch; searching what you already chose to store costs nothing but a lookup.
That's also why an explicit save or recall request overrides its own axis and not the other — making the
request *is* the decision the policy exists to make on your behalf. Claude Code also exposes those requests
as `/memory-save` and `/memory-recall`.

`custom` takes your rule from `oak-memory-policy.md` beside the selected config file (override with
`MEMORY_POLICY_FILE`).
Everything outside HTML comments in that file is handed to the model verbatim, so write it as an instruction
— "Store only my coding preferences and architecture decisions" — not as notes. Edit it any time; no rebuild.

To change the policy:

```bash
npm run setup -- --reconfigure   # re-asks all three; a plain re-run never re-asks
```

or `/memory-config stop saving unless I ask` inside Claude Code.

> **A policy change needs a restart.** The server reads its policy at startup, and the client receives
> `instructions` during the initialize handshake. Neither is re-read mid-session.

> **Narrowing the scope is not forgetting.** It governs what gets written from now on and never touches what's
> already stored. To remove existing memories, use `/memory-graph` to see them and `deleteMemory` to drop them.

A bad policy value is never fatal — unlike a missing `MEMORY_DATABASE_URL`, the server stays readable and
warns on stderr. Content creation or updates, new links, and link-strength changes fail closed until the scope
is fixed; deletion and link removal remain available for cleanup. `custom` with a missing or empty rule
behaves the same way. This means the config file can disagree with what's running, which is why
`getMemoryPolicy` reports the resolved policy instead of just reading the file back.

## Setup

```bash
npm install
npm run setup
```

`npm run setup` is idempotent — it checks each piece and only does what's missing, so re-running it is safe and
is also the fastest way to diagnose a broken install. It starts the Postgres container (named volume,
`--restart unless-stopped`, so memories survive both `docker rm` and a reboot), creates the `vector` extension,
pulls the embedding model, writes the selected config file, ensures the Claude and Codex bundles are present
and synchronized, and finishes with a smoke test that makes
a **real database call** — because startup and `tools/list` both pass even when the database is unreachable.

It needs [Docker](https://www.docker.com/products/docker-desktop/) and [Ollama](https://ollama.com/download)
installed; it tells you which one is missing and stops rather than half-configuring anything.

`OAK_CONTAINER` / `OAK_VOLUME` / `OAK_PORT` / `OAK_IMAGE` override what it provisions — useful for a second,
separate memory instance, or for exercising setup against a throwaway container without touching a real store:

```bash
OAK_CONTAINER=oak-test OAK_VOLUME=oak-test-vol OAK_PORT=55499 \
  OAK_CONFIG_DIR=/tmp/oak-test npm run setup
```

<details>
<summary>Why Postgres, rather than an embedded database that needs no Docker?</summary>

Because each AI client session spawns its **own** MCP server process. An embedded engine like
[PGlite](https://pglite.dev) is [single-connection](https://github.com/electric-sql/pglite/issues/324) —
several processes against one data directory corrupt the WAL. Real Postgres handles that concurrency natively.
Zero-install would mean either risking your memory graph or running a database daemon anyway, just without
supervision or restart-on-boot. So the goal here is making Postgres effortless to set up, not removing it.

</details>

<details>
<summary>Manual setup / other databases (hosted Supabase, etc.)</summary>

1. **A Postgres database where the `pgvector` extension is installable**, reachable from wherever the AI client
   runs. Options:
   - **Dedicated local container (recommended for a personal, cross-project memory store)** — don't reuse
     another project's dev database; that ties this plugin's durability to that project's lifecycle:
     ```bash
     docker run -d --name oak-memory-pg -e POSTGRES_PASSWORD=postgres -p 55432:5432 pgvector/pgvector:pg16
     ```
     → `MEMORY_DATABASE_URL=postgresql://postgres:postgres@localhost:55432/postgres`
   - Hosted Supabase project: Dashboard → Settings → Database → Connection string → **Transaction pooler**
     URI (use the Shared Pooler if your network is IPv4-only). Supabase ships pgvector by default.
2. **Enable the `vector` extension once, before first connect:**
   ```bash
   docker exec oak-memory-pg psql -U postgres -c "CREATE EXTENSION IF NOT EXISTS vector;"
   ```
   This is required even though `Memory.initialize()` also runs `CREATE EXTENSION IF NOT EXISTS vector`
   itself as part of its automatic schema setup (`ensureTablesExist()`, which idempotently creates every
   other table/index/function too — no other manual migration step is needed). The engine's own connection
   bootstrap (`initDatabase()`) registers the pgvector type with `pg` **before** running that schema setup,
   so on a genuinely fresh database (extension never created) the very first connection fails with
   `"vector type not found in the database"`. Pre-creating the extension once works around the ordering.
3. **[Ollama](https://ollama.com) running locally with an embedding model pulled:**
   ```bash
   ollama pull bge-m3
   ```
   No API key, no external network calls, no per-call cost.

</details>

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `MEMORY_DATABASE_URL` | Yes | Postgres connection string (pgvector extension required). |
| `MEMORY_ENTITY_ID` | No (default `fredriccliver`) | The fixed identity all memories are scoped to. See [Entity scoping](#entity-scoping). |
| `OLLAMA_BASE_URL` | No (default `http://localhost:11434/v1`) | Ollama's OpenAI-compatible endpoint. |
| `OLLAMA_EMBEDDING_MODEL` | No (default `bge-m3`) | Embedding model to request from Ollama. Must be multilingual if you store memories in a language other than English — see [Local embeddings](#local-embeddings). Changing it invalidates every stored embedding. |
| `MEMORY_POLICY_SCOPE` | Yes for writes | What may be remembered. If unset or invalid, writes are refused. See [Memory policy](#memory-policy). |
| `MEMORY_POLICY_AUTOSAVE` | No (default `true`) | Whether to save unprompted. |
| `MEMORY_POLICY_RECALL` | No (default `balanced`) | How hard to search before answering. |
| `MEMORY_POLICY_FILE` | No (default beside `oak-memory.env`) | Where a `custom` scope's rule text lives. |

`src/env.ts` resolves these in order, first value wins:

1. `process.env` — exported before launching the client.
2. `<plugin root>/.env` — convenient when running from a checkout.
3. `~/.config/oak-memory/oak-memory.env` — **the one to use for a new installed plugin.**
4. `~/.claude/oak-memory.env` — compatibility fallback for an existing Claude Code installation.

Prefer (3). It sits outside every client's replaceable plugin cache and can be shared by Codex and Claude
Code. Existing `~/.claude/oak-memory.env` installations remain supported and are used automatically until the
shared config sets `MEMORY_DATABASE_URL`; an empty shared file or one missing that required value cannot mask
a working legacy configuration. During migration, whichever standard file supplies the database URL is the
primary file and missing values fall back to the other one, so moving the URL before the policy does not
silently disable writes. Set `OAK_CONFIG_DIR` to explicitly choose one client-neutral location with no legacy
fallback.

The primary file always wins for keys it contains, including invalid values; fallback is for missing values,
not error recovery. If a partially migrated policy is reported as invalid, remove the mistaken policy key
from the primary file to keep using the legacy value, or run `npm run setup -- --reconfigure` to write a
complete policy into the primary file.

> Claude Code's `${VAR}` substitution in `.mcp.json` does **not** resolve to an empty string when `VAR` is
> unset — it passes the literal `"${VAR}"` through. `readEnvVar()` treats that shape as unset, so an unset
> var falls through to the files above instead of becoming a garbage connection string.

## Local embeddings

`src/localEmbeddingAdapter.ts` reuses the engine's `OpenAIAdapter` **unmodified**, pointed at Ollama's
OpenAI-compatible `/v1/embeddings` route (Ollama doesn't validate the `apiKey`, so any non-empty string
works) — no custom HTTP client needed.

The one wrinkle: the engine's Postgres schema hardcodes `embedding VECTOR(1536)` (OpenAI's dimension), while
`bge-m3` outputs 1024-dimensional vectors. The adapter zero-pads every embedding from 1024 → 1536
before it's stored. This is **not** an approximation — padding both sides of a cosine-similarity comparison
with the same number of trailing zeros changes neither the dot product nor either vector's norm, so
similarity rankings are mathematically identical to using the raw 1024-dim vectors directly. It's purely a
storage-format compatibility shim to satisfy the fixed-width column.

### Why the model must be multilingual

The default is `bge-m3` rather than the more common `nomic-embed-text` because retrieval quality collapses
silently on non-English text otherwise. Measured cosine similarity between a paraphrase pair and an unrelated
pair — the gap between them is what ranking actually depends on:

| | same meaning | unrelated | gap |
|---|---|---|---|
| `nomic-embed-text`, English | 0.888 | 0.328 | **+0.56** |
| `nomic-embed-text`, Korean | 0.771 | 0.740 | **+0.03** |
| `bge-m3`, English | 0.956 | 0.431 | **+0.53** |
| `bge-m3`, Korean | 0.782 | 0.349 | **+0.43** |

A 0.03 gap is noise: `nomic-embed-text` cannot tell a Korean paraphrase from an unrelated Korean sentence, so
recall returns essentially arbitrary memories while still reporting confident-looking scores. `bge-m3` also
embeds across languages (a Korean query against equivalent English content scores 0.787), so memories stay
findable regardless of which language they were written in.

Changing `OLLAMA_EMBEDDING_MODEL` invalidates every stored embedding — vectors from different models are not
comparable. Existing memories must be re-embedded (delete and re-create them) or they become unfindable.

## Entity scoping

`entityId` is the axis OAK.memory's **entity-specific associative network** turns on — each entity gets its own
graph, and an entity can be a user, persona, workspace, or agent. This plugin deliberately collapses that to
**one fixed global identity** via `MEMORY_ENTITY_ID`, because the goal is "the same memory follows me
everywhere," not per-project memory graphs. If you ever want separate memory spaces (e.g. work vs. personal),
point different client environments at different `MEMORY_ENTITY_ID` values — they share the same database,
just different logical graphs.

This is also why `/memory-graph` is a genuinely useful view rather than a debug tool: the associative network
*is* the personalization, so being able to see and prune it is how you steer what the client recalls.

## Install

Choose [cloud connection](docs/claude-cloud-onboarding.md) or local setup. Cloud mode skips Docker/Ollama/database provisioning. For local mode, run [`npm run setup`](#setup) first.

### Codex

The repository includes a Codex marketplace and a self-contained package under `plugins/oak-memory`. Build,
register, and install it locally:

```bash
npm run build
codex plugin marketplace add /absolute/path/to/oak-memory-plugin
codex plugin add oak-memory@oak-memory-local
```

Start a new Codex task after installation so the skill and MCP tools are loaded. Review and trust the bundled
`UserPromptSubmit` hook when Codex asks; non-managed hooks do not run until they are trusted.

> **Required for full policy behavior:** approve that hook before relying on proactive recall or autosave.
> The MCP tools still work without it, but the per-prompt policy reminder is absent, so those proactive
> behaviors can become less reliable without an obvious error.

Codex injects `PLUGIN_ROOT` for installed plugin hooks; the hook command uses it to locate the packaged
`dist/hook.mjs`. During verification, confirm the hook appears in the trust prompt and that a fresh task loads
the OAK.memory skill. If either is absent, treat the installation as incomplete rather than relying on the MCP
server alone.

### Claude Code

This repo remains its own Claude marketplace (`.claude-plugin/marketplace.json`), so the existing integration
and slash commands continue to work. Register it in
`~/.claude/settings.json`:

```jsonc
{
  "extraKnownMarketplaces": {
    "oak-memory": {
      "source": { "source": "directory", "path": "/absolute/path/to/oak-memory-plugin" }
    }
  },
  "enabledPlugins": { "oak-memory@oak-memory": true }
}
```

Restart Claude Code. No shell exports, no `--plugin-dir` flag, no per-project setup.

> **Working inside this repo?** The root `.mcp.json` is the *plugin's* MCP config, where
> `${CLAUDE_PLUGIN_ROOT}` is substituted. Claude Code also picks that file up as a *project* `.mcp.json` when
> you open this directory — and there the variable is **not** substituted, so the server dies at startup with
> `Cannot find module '.../${CLAUDE_PLUGIN_ROOT}/dist/index.mjs'` (surfacing as `-32000`). `.claude/settings.local.json`
> therefore lists `oak-memory` under `disabledMcpjsonServers`: the installed plugin provides the server, so the
> project-level copy must stay off.

## Development

```bash
npm install          # postinstall runs `npm run build` automatically
npm run setup        # idempotent: provision DB + model + config, then smoke-test
npm test             # typecheck + config-migration regression test
npm run typecheck    # tsc --noEmit
npm run build        # build shared bundles, then sync the self-contained Codex package
```

Both bundles are committed, because `hooks/hooks.json` and `.mcp.json` point at `dist/` and an install is not
guaranteed to run a build. The hook bundle pulls in only `src/policy.ts` and `src/env.ts` — no engine, no
`pg`, node builtins only — so none of the bundling constraints below apply to it. It reads the policy through
the same `loadPolicy()` the server uses, deliberately: a hook that resolved the policy its own way could prompt
for a write the user had configured off.

`dist/index.mjs` is a **self-contained** bundle: it runs with no `node_modules` beside it. This is a hard
requirement, not a nicety — installing copies the plugin into `~/.claude/plugins/cache/...` **without**
`node_modules`, so anything left external resolves to nothing at runtime.

Two things make that work, and breaking either reintroduces a nasty failure mode:

- **Only `pg-native` is external.** It's an optional native addon `pg` probes for and works fine without;
  everything else (`pg`, `pgvector`, `@langchain/*`) is bundled. Marking `pg` external produced
  `Cannot find package 'pg'` — but *only after relocation*, and *only on the first DB call*: the server still
  started and `tools/list` still passed, so a smoke test that stops at "the tools are registered" misses it.
- **A `createRequire` banner is injected.** `pg` is CJS and does `require('events')` internally; in ESM output
  that throws `Dynamic require of "events" is not supported`. The banner defines a real `require` in module
  scope. (Same class of bundler/ESM problem `src/env.ts` documents for `dotenv`.)

Any smoke test for this must therefore run the bundle **from a directory with no `node_modules`** and make a
**real database call**. Anything less passes while broken.

**Gotchas** (both worth knowing if you touch the build):
- `@openaikits/memory` is a GitHub-tarball dependency (pinned to commit
  `961829f092caacf0e1960734f7d3c5a6a1d72da9`, not a floating branch) that ships TypeScript source only — no
  prebuilt `dist/` (gitignored upstream), even though its own `package.json` `main`/`types`/`exports` point at
  `./dist/*`. Both `tsconfig.json` (`paths`) and the `build` script (esbuild `--alias`) redirect
  `@openaikits/memory` straight to `node_modules/@openaikits/memory/src/index.ts` — the same pattern the
  `chloe` project uses (`scripts/bundle-openaikits-memory.mjs`). Building the dependency's own `dist/` via its
  `tsc` script was tried first and technically works, but its emitted ESM output omits `.js` extensions on
  relative imports (e.g. `export * from './types'`), which Node's strict ESM resolver rejects at runtime
  (`ERR_MODULE_NOT_FOUND`) — bundling straight from source sidesteps that entirely, since esbuild resolves
  and inlines those relative imports itself rather than asking Node to.
- `pg`, `pgvector`, `@langchain/*` **are** bundled; only `pg-native` is external. Marking them `--external`
  was the earlier approach — it dodged `"Dynamic require of \"events\" is not supported"`, but at the cost of
  a runtime `node_modules` dependency that silently breaks once the plugin is installed (copied to the cache
  without one). The `--banner:js` `createRequire` shim fixes the dynamic-require problem at its root instead,
  which is what lets everything bundle. Don't re-add these externals to "fix" a require error — that trades a
  loud build-time problem for a quiet install-time one.
- `dotenv` isn't used at all (see `src/env.ts`) for the same class of reason — its CJS internals hit the same
  bundling issue. A dozen-line hand-rolled `.env` parser was simpler than working around it.

## Verification / smoke test

Do this standalone, before wiring the plugin into Codex or Claude Code:

0. **Relocation check — the one that actually matters.** Copy `dist/index.mjs` alone into an empty directory
   (no `node_modules`, no `.env`), set `PLUGIN_ROOT` (or legacy `CLAUDE_PLUGIN_ROOT`) to it, and call a tool that **hits the database**
   (`listMemories` is the cheapest — it skips the Ollama embedding round-trip). This reproduces installed-plugin
   conditions exactly. Startup and `tools/list` succeeding prove nothing here: both passed while `pg` was
   unresolvable, and the failure only appeared on the first DB call.
1. `node dist/index.mjs` with real env vars set — it should block on stdio without crashing (confirms env
   validation and the DB connection both succeeded).
2. `npx @modelcontextprotocol/inspector node dist/index.mjs` — opens a local web UI to list the 10 registered
   tools, inspect their schemas, and invoke them manually while watching raw JSON-RPC responses.
3. Functional sequence via the inspector:
   - `createMemory({content: "Lives in Seoul and works as a software engineer"})` → expect success + a UUID.
   - `recallMemory({query: "Where do I live?"})` → expect that memory in the ranked results.
   - `updateMemory({memoryId, content: "Moved to Busan"})` → `recallMemory` again with the same query →
     confirm the updated content comes back.
   - `deleteMemory({memoryId})` → `recallMemory` again → confirm it's gone.
4. Only after 1–3 pass: test it loaded into a real Codex or Claude Code session (see below) before any permanent
   install.

For Codex, install the local package as described above, start a fresh task, approve the bundled
`UserPromptSubmit` hook, and verify the OAK.memory skill plus all 10 MCP tools are present. Exercise
`getMemoryPolicy` and one real database-backed read from the installed `plugins/oak-memory/dist` package;
the root bundle passing does not by itself prove the packaged path is wired correctly.

### Testing inside a real Claude Code session

`claude plugin validate <path>` checks the manifest without loading anything:
```bash
claude plugin validate ~/Projects/oak-memory-plugin
```

`--plugin-dir <path>` loads a plugin for one session only — no marketplace, no permanent install, exactly
what you want for iterating:
```bash
MEMORY_DATABASE_URL="postgresql://postgres:postgres@localhost:55432/postgres" \
  claude --plugin-dir ~/Projects/oak-memory-plugin
```
Then in the session, ask something like *"what MCP tools do you have with 'Memory' in the name?"* to confirm
all 10 registered (they show up as `mcp__plugin_oak-memory_oak-memory__<toolName>`).

For a scripted one-shot test (`-p`), MCP tool calls need explicit permission since there's no TTY to approve
them interactively — pass `--allowedTools` with the exact tool names:
```bash
MEMORY_DATABASE_URL="postgresql://postgres:postgres@localhost:55432/postgres" \
  claude --plugin-dir ~/Projects/oak-memory-plugin \
  --allowedTools "mcp__plugin_oak-memory_oak-memory__createMemory" "mcp__plugin_oak-memory_oak-memory__recallMemory" \
  -p "Use createMemory to remember: 'Favorite programming language is Rust.' Then use recallMemory with query 'favorite programming language' and report what it finds."
```

The real test — since `-p` runs are one-shot processes with zero shared context — is running that, then
running a **second, separate** `-p` invocation with only `recallMemory` allowed and confirming it finds the
fact with no prior conversation:
```bash
MEMORY_DATABASE_URL="postgresql://postgres:postgres@localhost:55432/postgres" \
  claude --plugin-dir ~/Projects/oak-memory-plugin \
  --allowedTools "mcp__plugin_oak-memory_oak-memory__recallMemory" \
  -p "This is a brand new session with no prior context. Use recallMemory with query 'what programming language do I like' and tell me what it finds."
```
This is the actual "survives across sessions" property the plugin exists to deliver — verified working
2026-07-17.

**Gotcha found via this test**: Claude Code's `.mcp.json` `${VAR}` substitution does not fall back to an
empty string when the variable is unset in the ambient environment — it passes the **literal, unexpanded
`"${VAR}"` string** through as the env value instead. A plain `value?.trim() || default` fallback doesn't
catch that (a non-empty garbage string is still truthy), so `src/env.ts`'s `readEnvVar()` explicitly treats
anything matching `/^\$\{.*\}$/` as unset. `.mcp.json` itself only declares `MEMORY_DATABASE_URL` (no safe
default, so it must be explicitly passed) — `MEMORY_ENTITY_ID`/`OLLAMA_BASE_URL`/`OLLAMA_EMBEDDING_MODEL`
are deliberately left out of it so they fall through to the ambient shell environment or the `.env` file
instead of risking a literal placeholder being injected.

### Permanent install (once you're happy with local testing)

See [Install](#install) — declaring the marketplace in `~/.claude/settings.json` is the durable, reviewable
form. The CLI equivalent:

```bash
claude plugin validate ~/Projects/oak-memory-plugin   # manifest check, loads nothing
claude plugin marketplace add ~/Projects/oak-memory-plugin
claude plugin install oak-memory
```
(Exact subcommand behavior may vary by Claude Code version — `claude plugin --help` is authoritative.)

## License

[PolyForm Shield License 1.0.0](https://polyformproject.org/licenses/shield/1.0.0) — see `LICENSE` and `NOTICE`.

Free to use for any purpose **except** building a product that competes with OAK.memory /
[`@openaikits/memory`](https://github.com/fredriccliver/Memory). Personal use, internal tooling, and
non-competing products are all fine; a competing memory product or service is not.
