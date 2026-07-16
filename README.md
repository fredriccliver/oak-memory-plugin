# claude-memory-plugin

A Claude Code plugin that gives Claude a **persistent, cross-project long-term memory** about you — backed by
a real vector+graph database, not markdown files.

Claude Code's built-in memory is a folder of markdown notes. That's fine for lightweight preferences, but it
doesn't do semantic search, doesn't rank by relevance, and doesn't model relationships between facts. This
plugin wraps [`@openaikits/memory`](https://github.com/fredriccliver/Memory) — a Postgres+pgvector-backed
vector/graph memory engine — as an MCP server, so Claude can recall and store facts about you the same way
across every project and every session.

## Why this exists

This is deliberately **not** a replacement for project-scoped `CLAUDE.md` files or Claude Code's file-based
auto-memory. Those own "facts about this project." This plugin owns "facts about *you*" — your preferences,
experiences, and decisions — as a single flat identity shared across all your machines and projects. If you
ever need to split that (e.g. a work identity vs. a personal identity), see [Entity scoping](#entity-scoping).

## Architecture

```
Claude Code  <-- MCP tool calls -->  this plugin's stdio server  -->  @openaikits/memory  -->  Postgres (pgvector)
                                                                            |
                                                                  Ollama (local embeddings)
```

Embeddings run **fully locally** via [Ollama](https://ollama.com) (`nomic-embed-text` by default) — no
OpenAI API key, no per-call cost, no data leaving the machine. See [Local embeddings](#local-embeddings) for
how this is wired given the engine's schema hardcodes a different vector width than local models produce.

Claude Code has no per-turn "inject context automatically" hook (unlike a typical chat-app integration of
this engine, which uses `MemoryConnector.prepareContext()`/`onAfterResponse()`). Every memory operation here
is **model-initiated tool calling** — Claude only recalls or saves when it decides to, guided by the detailed
tool descriptions below. Two slash commands (`/memory-recall`, `/memory-save`) exist for explicit manual
invocation when you don't want to rely on the model noticing on its own.

## Tools exposed

| Tool | Purpose |
|---|---|
| `recallMemory` | Search memory for facts relevant to a query (ranked by similarity, graph links, recency, strength). The only read-path tool — call it before answering anything that might depend on prior context, and before `createMemory` to avoid duplicates. |
| `createMemory` | Store a new fact/preference/experience about you. |
| `updateMemory` | Update an existing memory (by UUID) when info has changed. |
| `updateMemoryLink` | Add/remove a link between two memories so they're more likely to surface together later. |
| `deleteMemory` | Delete a memory. Irreversible — used sparingly. |

All four write tools are scoped to a single fixed identity (`MEMORY_ENTITY_ID`, see below) configured
server-side — the model never supplies or sees an entity/user id.

## Prerequisites

1. **A Postgres database where the `pgvector` extension is installable**, reachable from wherever Claude Code
   runs. Options:
   - **Dedicated local container (recommended for a personal, cross-project memory store)** — don't reuse
     another project's dev database; that ties this plugin's durability to that project's lifecycle:
     ```bash
     docker run -d --name claude-memory-pg -e POSTGRES_PASSWORD=postgres -p 55432:5432 pgvector/pgvector:pg16
     ```
     → `MEMORY_DATABASE_URL=postgresql://postgres:postgres@localhost:55432/postgres`
   - Hosted Supabase project: Dashboard → Settings → Database → Connection string → **Transaction pooler**
     URI (use the Shared Pooler if your network is IPv4-only). Supabase ships pgvector by default.
2. **Enable the `vector` extension once, before first connect:**
   ```bash
   docker exec claude-memory-pg psql -U postgres -c "CREATE EXTENSION IF NOT EXISTS vector;"
   ```
   This is required even though `Memory.initialize()` also runs `CREATE EXTENSION IF NOT EXISTS vector`
   itself as part of its automatic schema setup (`ensureTablesExist()`, which idempotently creates every
   other table/index/function too — no other manual migration step is needed). The engine's own connection
   bootstrap (`initDatabase()`) registers the pgvector type with `pg` **before** running that schema setup,
   so on a genuinely fresh database (extension never created) the very first connection fails with
   `"vector type not found in the database"`. Pre-creating the extension once works around the ordering.
3. **[Ollama](https://ollama.com) running locally with an embedding model pulled:**
   ```bash
   ollama pull nomic-embed-text
   ```
   No API key, no external network calls, no per-call cost.

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `MEMORY_DATABASE_URL` | Yes | Postgres connection string (pgvector extension required). |
| `MEMORY_ENTITY_ID` | No (default `fredriccliver`) | The fixed identity all memories are scoped to. See [Entity scoping](#entity-scoping). |
| `OLLAMA_BASE_URL` | No (default `http://localhost:11434/v1`) | Ollama's OpenAI-compatible endpoint. |
| `OLLAMA_EMBEDDING_MODEL` | No (default `nomic-embed-text`) | Embedding model to request from Ollama. |

Supply these either via your shell profile (exported before launching `claude`), or by creating a `.env`
file at the root of this plugin once installed — `src/env.ts` checks `process.env` first, then falls back to
that file.

## Local embeddings

`src/localEmbeddingAdapter.ts` reuses the engine's `OpenAIAdapter` **unmodified**, pointed at Ollama's
OpenAI-compatible `/v1/embeddings` route (Ollama doesn't validate the `apiKey`, so any non-empty string
works) — no custom HTTP client needed.

The one wrinkle: the engine's Postgres schema hardcodes `embedding VECTOR(1536)` (OpenAI's dimension), while
`nomic-embed-text` outputs 768-dimensional vectors. The adapter zero-pads every embedding from 768 → 1536
before it's stored. This is **not** an approximation — padding both sides of a cosine-similarity comparison
with the same number of trailing zeros changes neither the dot product nor either vector's norm, so
similarity rankings are mathematically identical to using the raw 768-dim vectors directly. It's purely a
storage-format compatibility shim to satisfy the fixed-width column.

## Entity scoping

`@openaikits/memory` is multi-tenant (`entityId` can be a user, persona, workspace, or agent). This plugin
deliberately collapses that to **one fixed global identity** via `MEMORY_ENTITY_ID`, because the goal is "the
same memory follows me everywhere," not per-project memory graphs. If you ever want separate memory spaces
(e.g. work vs. personal), point different Claude Code environments at different `MEMORY_ENTITY_ID` values —
they share the same database, just different logical graphs.

## Install (local path, before any marketplace listing)

Build first, then point Claude Code at this directory as a local plugin (check `/plugin` or
`claude plugin --help` for the exact subcommand on your installed version):

```bash
npm install
npm run build
```

## Development

```bash
npm install          # postinstall runs `npm run build` automatically
npm run typecheck    # tsc --noEmit
npm run build         # esbuild -> dist/index.mjs
```

`node_modules` must stay present alongside `dist/index.mjs` at runtime — `pg`, `pgvector`, `@langchain/core`,
and `@langchain/openai` are deliberately left **external** (not bundled) rather than committing a fully
self-contained single file. `dist/index.mjs` is still committed for convenience/diffability, but isn't
runnable standalone without `node_modules`.

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
- `pg`, `pgvector`, `@langchain/core`, `@langchain/openai` are explicitly `--external`. Bundling them (the
  first approach tried) broke at runtime with `"Dynamic require of \"fs\"/\"events\" is not supported"` —
  esbuild's CJS→ESM interop shim can't handle these packages' conditional/dynamic `require()` calls of Node
  builtins. Letting Node load them normally from `node_modules` (as they're designed to run) avoids the whole
  class of interop bugs. `@modelcontextprotocol/sdk` and `zod` bundle fine and stay inlined.
- `dotenv` isn't used at all (see `src/env.ts`) for the same class of reason — its CJS internals hit the same
  bundling issue. A dozen-line hand-rolled `.env` parser was simpler than working around it.

## Verification / smoke test

Do this standalone, before wiring the plugin into Claude Code:

1. `node dist/index.mjs` with real env vars set — it should block on stdio without crashing (confirms env
   validation and the DB connection both succeeded).
2. `npx @modelcontextprotocol/inspector node dist/index.mjs` — opens a local web UI to list the 5 registered
   tools, inspect their schemas, and invoke them manually while watching raw JSON-RPC responses.
3. Functional sequence via the inspector:
   - `createMemory({content: "Lives in Seoul and works as a software engineer"})` → expect success + a UUID.
   - `recallMemory({query: "Where do I live?"})` → expect that memory in the ranked results.
   - `updateMemory({memoryId, content: "Moved to Busan"})` → `recallMemory` again with the same query →
     confirm the updated content comes back.
   - `deleteMemory({memoryId})` → `recallMemory` again → confirm it's gone.
4. Only after 1–3 pass: install into Claude Code from the local path and do one real end-to-end session
   test — tell Claude a fact, start a genuinely new session, ask a question that requires recall, confirm it
   retrieves the fact (either proactively, or via `/memory-recall`).

## License

Apache-2.0 (matching the upstream [`@openaikits/memory`](https://github.com/fredriccliver/Memory) engine —
see `LICENSE` and `NOTICE`).
