# Personal and shared memory profiles

The plugin supports local stores and the hosted Streamable HTTP MCP endpoint.
Select a backend/profile before database validation. With no profiles file and no
explicit cloud setting, existing local setup keeps working. Nothing migrates,
synchronizes, or changes existing local memories.

## Configuration and credential handoff

See [Claude Code connection guide](claude-cloud-onboarding.md) for the native
masked configuration menu and preview/released installation distinction.

Persistent access requires a user-approved action. Ask the user to sign in with
email at the service, select a graph, and approve issuing a named personal key.
The website issues it through `POST /api/memory/keys` with
`{ "action": "create", "graphId": "...", "name": "Claude plugin" }` under a
verified web session. The key is shown once. Have the user put it directly in their
private environment/credential manager; do not request the key in chat, log it,
create it autonomously, or install it into live Claude configuration without
approval. Shared `OAK_MCP_TOKEN` credentials are deliberately unsupported.

The plugin reads references to credential environment variables, never raw keys
from `profiles.json`. The existing user env-file loader can provide these vars
from a private `oak-memory.env` after the user approves that configuration step.
Protect such a file with mode 0600. Do not overwrite the existing local env file.
A separate credential manager injecting environment variables is also supported.

Create `~/.config/oak-memory/profiles.json` only after approval (or test it in an
isolated directory using `OAK_CONFIG_DIR`/`OAK_PROFILES_FILE`):

```json
{
  "defaultProfile": "personal-cloud",
  "profiles": {
    "local": { "backend": "local" },
    "personal-cloud": {
      "backend": "cloud",
      "endpoint": "https://www.openaikits.com/api/mcp",
      "graphId": "11111111-1111-4111-8111-111111111111",
      "credentialEnv": "OAK_PERSONAL_KEY"
    },
    "shared-team": {
      "backend": "cloud",
      "endpoint": "https://www.openaikits.com/api/mcp",
      "graphId": "22222222-2222-4222-8222-222222222222",
      "credentialEnv": "OAK_TEAM_KEY"
    }
  }
}
```

Replace example graph IDs with server-provided IDs. Keys have the form
`oak_` followed by 64 lowercase hex characters. Each profile must use the key
issued to that person for that graph. `OAK_PROFILE` overrides the stored default.
`OAK_BACKEND=cloud` requires a configured cloud profile; `OAK_BACKEND=local`
explicitly starts the legacy local server. Backend/profile mismatches fail closed.
HTTPS is required; HTTP is accepted only for loopback mock tests. Endpoints must
not embed credentials, query parameters, or fragments. HTTP redirects fail closed.

The existing memory policy remains in effect. Cloud mutations are blocked while
policy scope is unconfigured. Configure it through the existing workflow after
approval; a network/authentication failure never selects another store.

## Session selection

Call `listMemoryProfiles`, then `selectMemoryProfile({"profile":"shared-team"})`.
Switches affect this MCP session only. The bridge verifies the candidate context
before changing selection; failures keep the prior selection. A newer switch attempt
supersedes pending older validations, even if the newer attempt fails: late older
responses never replace the last committed selection. Display active
graph name/ID, role, and authenticated identity from `currentMemoryStore` after
connecting or switching. `listMemoryStores` discovers authorized member graphs,
but does not grant a credential for them. A graph-bound key cannot be reused for
another graph; approve a separate key and profile first.

A configured local profile also runs through the bridge, allowing switches back
and forth. It uses the existing local env-file configuration and local engine.
The explicit `OAK_BACKEND=local` override starts the legacy server directly.
Changes to stored defaults or profile definitions affect future sessions. An
in-flight call retains the profile/graph captured at dispatch. Every cloud SDK
request carries `Authorization: Bearer <personal key>` and `X-Oak-Graph: <uuid>`;
the backend checks membership/key revocation and graph authorization on every
request, and denies reader writes. The plugin cannot authorize membership itself.

Authenticated author records who submitted a memory. The semantic subject can
be another person. Preserve original quotes and their speaker; do not interpret
quoted “I” as the authenticated author or guess actors. These instructions are
included in server prompts, tool descriptions, and per-turn reminders.

## Verification

`npm test` runs original env-fallback/policy tests and a loopback mocked MCP server
using the real SDK client and stdio bridge. The cloud suite verifies startup
without DB env, identity/role context, graph isolation, reader write denial,
revocation, failed-switch behavior, in-flight graph snapshots, local switching,
stored-default isolation, and credential-free diagnostics. It makes no production
requests and creates no live keys or memories.

## Disposable real-backend integration

After the backend owner starts a disposable local Next/Postgres fixture, run
`npm run test:local-backend` with runtime JSON on stdin. The runner accepts only
an HTTP loopback `/api/mcp` endpoint with an explicit port. JSON contains
`endpoint`, `profiles` (at least two entries with `name`, `graphId`, `key`, `role`,
`authorUserId`), and optional `allowWrites: true`. Supply values through a secure
local runtime handoff; never paste keys into a command, chat, or log. Keys remain
in memory and in the child process environment; temporary profile metadata
contains only environment references and is removed afterward.

The runner checks the actual packaged stdio bridge, tool discovery, graph/role/
author context, profile switching, invalid-key failure with prior-selection
retention, and credential-free diagnostics. With explicit fixture write enablement,
it creates unique disposable memories, verifies list/recall and original quotes,
checks reader denial, and deletes only the memories it created in a cleanup block.
It makes no production requests and never reads live plugin configuration.
