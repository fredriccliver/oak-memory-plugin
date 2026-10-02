# Use OAK.memory in Claude Code

Cloud memory needs Node.js 22 or later and a personal graph-bound key. It needs
no Docker, Ollama, or database URL. Local and cloud graphs are separate stores.

## Install a verified checkout

Cloud profiles were introduced in PR #4 on
`feat/cloud-profiles-graph-selection`. The repository default branch is `master`.
Before PR #4 is merged, use its branch checkout below. After the PR is merged,
use `--branch master` instead. A repository merge does not imply an npm package
release.

The published feature checkout workflow was verified on Claude Code 2.1.286:

```sh
git clone --branch feat/cloud-profiles-graph-selection https://github.com/fredriccliver/oak-memory-plugin.git oak-memory-preview
cd oak-memory-preview
npm ci
claude plugin validate .claude-plugin/plugin.json
claude plugin marketplace add "$PWD" --scope user
claude plugin install oak-memory@oak-memory --scope user
claude plugin list
```

These are Claude Code's supported marketplace commands, verified with version
2.1.286. `npm ci` builds the bundled server and hook; installing the plugin does
not install dependencies or run local database setup. For a released version,
use the released marketplace only after its manifest/bundles include cloud
profiles. The CLI says which scope is installed. `user` applies across projects;
`project` applies to a shared project, and `local` applies only to your machine
in that project. Choose a scope deliberately.

For an isolated preview, use a separate HOME and CLAUDE_CONFIG_DIR for **every**
Claude command. This avoids changing an existing installation:

```sh
mkdir -p /tmp/oak-memory-preview/home /tmp/oak-memory-preview/claude
export HOME=/tmp/oak-memory-preview/home
export CLAUDE_CONFIG_DIR=/tmp/oak-memory-preview/claude
```

Keep your ordinary local plugin and memory configuration untouched. Do not
replace an existing user's default graph or store credentials without their
explicit setup handoff. Installing in an isolated scope does not authenticate a
real Claude account or prove live cloud connectivity.

## Connect a graph

1. Sign in with email on the OAK.memory dashboard. Select your personal or shared
   graph and review your owner/editor/reader role.
2. Download **nonsecret** `profiles.json`. The download contains graph IDs,
   endpoint, and credential environment references, never keys. Save it outside
   the replaceable plugin cache. Do not overwrite an existing local config.
3. After approving personal access, create a named key for the selected graph.
   A key is bound to your account and that graph. Another graph needs another key.
4. In Claude Code, open `/plugin`, select installed `oak-memory@oak-memory`, then
   **Configure**. Set **Memory profiles file** to the absolute downloaded path.
   **Starting memory profile** is optional; leave it empty to use the JSON default.
5. Enter the key map only in **Personal graph keys (secure)**, the masked field.
   Claude stores sensitive configuration in its secure credential store. Each
   object key is a `credentialEnv` reference from your profile file. Use a private
   environment/credential manager instead if you prefer. Never paste keys into
   chat, a profile download, a URL, screenshots, or CLI arguments.
6. Restart Claude Code. Run `/oak-memory:memory-status` to verify the server's
   graph, role and recording identity before using memories.

The nonsecret profile file schema is:

```json
{
  "defaultProfile": "personal-cloud",
  "profiles": {
    "personal-cloud": {
      "backend": "cloud",
      "endpoint": "https://www.openaikits.com/api/mcp",
      "graphId": "11111111-1111-4111-8111-111111111111",
      "credentialEnv": "OAK_PERSONAL_KEY"
    },
    "team-cloud": {
      "backend": "cloud",
      "endpoint": "https://www.openaikits.com/api/mcp",
      "graphId": "22222222-2222-4222-8222-222222222222",
      "credentialEnv": "OAK_TEAM_KEY"
    },
    "local": { "backend": "local" }
  }
}
```

Replace the example UUIDs with the authorized dashboard values. For a self-hosted
service, the download uses that service's HTTPS `/api/mcp` endpoint; HTTP is
accepted only on loopback for disposable tests. No credential belongs in this file.

In the masked field, the expected shape is an object such as
`{"OAK_PERSONAL_KEY":"<enter privately>","OAK_TEAM_KEY":"<enter privately>"}`.
The actual keys are `oak_` plus 64 lowercase hex characters. This is not a command
or downloadable file, and the placeholders are not usable credentials. Only the
matching selected profile's key is sent to its endpoint. Redirects fail closed.

To configure the **nonsecret** fields from the terminal instead of the menu:

```sh
printf '%s\n' '{"profiles_file":"/absolute/path/to/profiles.json","default_profile":"personal-cloud"}' |
  claude plugin configure oak-memory@oak-memory --values-stdin
```

Never put a key in a command line. Native nonsecret fields live under pluginConfigs
in the selected Claude settings directory. Native sensitive fields use secure
storage. Alternatively, the plugin's default profile path is
`~/.config/oak-memory/profiles.json`; `OAK_CONFIG_DIR` changes that directory, and
`OAK_PROFILES_FILE` explicitly selects another file. `OAK_PROFILE` explicitly
selects a starting profile. Explicit environment values take precedence over
native defaults. An existing `oak-memory.env` remains supported; a private
credential file must be mode 0600 and must not overwrite local database settings.

## Use and switch

- `/oak-memory:memory-connect`: guided connection steps; no secrets in chat.
- `/oak-memory:memory-status`: show `Memory: profile / graph | role | recorded by identity`.
- `/oak-memory:memory-profile`: list configured profiles or select one by name.
- `/oak-memory:memory-recall` and `/oak-memory:memory-save`: read or remember,
  subject to the client policy and server role.

A switch validates the matching graph-bound key and reconnects the SDK transport.
It changes this session only. The latest switch attempt supersedes pending older
attempts; a failed newer switch preserves the last committed profile. Calls
already in progress keep their captured graph. Restarting Claude loads the stored
starting profile again. Changing stored defaults applies to future sessions.
Graph discovery alone never grants a key or permission.

Owner and editor writes are still subject to the client's configured memory
policy. Reader writes are denied by the server. Configure memory scope through
the existing memory-config workflow; an unconfigured scope blocks mutations.
Recording author says who submitted a memory. It does not redefine the semantic
subject or the speaker of an original quote.

## Safe recovery

Missing/malformed keys, expired membership, a mismatched graph, or an unreachable
endpoint produce a visible connection error. Use memory-status to identify the
selected profile, check its nonsecret configuration and key/membership privately,
then reconnect or restart. Setup/status tools remain available during cloud auth
failure. The plugin never silently falls back to the local database.

If no profile file is configured, an existing local installation keeps its
original behavior and settings. `OAK_BACKEND=local` explicitly starts the legacy
local server. No store migration or memory synchronization occurs.

## Verification boundaries

Marketplace installation and native nonsecret configuration were tested in a
fresh isolated Claude config/home with Claude Code 2.1.286. The real host fixture
uses the actual installed plugin and disposable Next/Postgres backend, with a
local deterministic model-response fixture. Its evidence can prove loading,
commands, transport, tool dispatch, role errors, profile switching and restart
behavior. It cannot prove live-model adherence or real user-account connectivity.
No production keys or live client settings are needed for those fixture checks.
A final optional real-auth session requires the user's login and personal-key
handoff after implementation and independent checks are complete.

Official workflow references: [install plugins](https://code.claude.com/docs/en/plugins/install),
[CLI commands](https://code.claude.com/docs/en/plugins/cli-reference), and
[user configuration](https://code.claude.com/docs/en/plugins/manifest-reference#user-configuration).
