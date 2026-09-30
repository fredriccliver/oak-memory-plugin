#!/usr/bin/env node
/**
 * One-command setup: `npm run setup`.
 *
 * Idempotent by design — every step checks before it acts, so re-running is
 * safe and only does what's actually missing. Never destroys an existing
 * container or overwrites existing config; if something is already there but
 * wrong, it says so and leaves the decision to you.
 *
 * Deliberately NOT replacing Postgres with an embedded engine (PGlite): each
 * AI client session spawns its own MCP server process, and PGlite is
 * single-connection — several processes against one data directory corrupt the
 * WAL. A real Postgres handles that concurrency natively, so the goal here is
 * to make it effortless to set up, not to remove it.
 */

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

// Overridable so this script can be exercised end-to-end against a throwaway
// container without touching a real memory store — and so a second, separate
// memory instance is possible without editing the source.
const CONTAINER = process.env.OAK_CONTAINER ?? 'oak-memory-pg';
const VOLUME = process.env.OAK_VOLUME ?? 'oak-memory-pgdata';
const IMAGE = process.env.OAK_IMAGE ?? 'pgvector/pgvector:pg16';
const PORT = Number(process.env.OAK_PORT ?? 55432);
const DB_URL = `postgresql://postgres:postgres@localhost:${PORT}/postgres`;
const OLLAMA_MODEL = process.env.OLLAMA_EMBEDDING_MODEL ?? 'bge-m3';

// Re-running is safe and re-asks nothing; `--reconfigure` is the way to revisit
// an answer, so an accidental re-run can never quietly rewrite the policy.
const RECONFIGURE = process.argv.includes('--reconfigure');

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sharedConfigDir = process.env.OAK_CONFIG_DIR ?? path.join(os.homedir(), '.config', 'oak-memory');
const sharedEnvFile = path.join(sharedConfigDir, 'oak-memory.env');
const legacyConfigDir = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');
const legacyEnvFile = path.join(legacyConfigDir, 'oak-memory.env');

// Keep this selection predicate in sync with src/env.ts. Setup must write the
// same primary file the installed MCP server will read.
function envFileSets(filePath, name) {
  try {
    return fs
      .readFileSync(filePath, 'utf8')
      .split('\n')
      .some(rawLine => {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) return false;
        const eq = line.indexOf('=');
        if (eq === -1 || line.slice(0, eq).trim() !== name) return false;
        const value = line.slice(eq + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
        return value.length > 0 && !/^\$\{.*\}$/.test(value);
      });
  } catch {
    return false;
  }
}

const envFile =
  process.env.OAK_CONFIG_DIR ||
  envFileSets(sharedEnvFile, 'MEMORY_DATABASE_URL') ||
  !envFileSets(legacyEnvFile, 'MEMORY_DATABASE_URL')
    ? sharedEnvFile
    : legacyEnvFile;
const policyFile = path.join(path.dirname(envFile), 'oak-memory-policy.md');

const ok = msg => console.log(`  \x1b[32m✓\x1b[0m ${msg}`);
const info = msg => console.log(`  \x1b[36m→\x1b[0m ${msg}`);
const warn = msg => console.log(`  \x1b[33m!\x1b[0m ${msg}`);
const step = msg => console.log(`\n\x1b[1m${msg}\x1b[0m`);

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: 'pipe', ...opts }).trim();
}

function tryRun(cmd, args, opts = {}) {
  try {
    return { ok: true, out: run(cmd, args, opts) };
  } catch (error) {
    return { ok: false, out: String(error.stdout ?? '') + String(error.stderr ?? '') };
  }
}

function fail(message, remedy) {
  console.error(`\n\x1b[31m✗ ${message}\x1b[0m`);
  if (remedy) console.error(`\n${remedy}\n`);
  process.exit(1);
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// ---------------------------------------------------------------- Docker

function ensureDocker() {
  step('Docker');
  if (!tryRun('docker', ['--version']).ok) {
    fail(
      'Docker is not installed.',
      'Install Docker Desktop: https://www.docker.com/products/docker-desktop/\nThen re-run `npm run setup`.',
    );
  }
  if (!tryRun('docker', ['info']).ok) {
    fail('Docker is installed but the daemon is not running.', 'Start Docker Desktop, then re-run `npm run setup`.');
  }
  ok('Docker is running');
}

function containerState() {
  const res = tryRun('docker', ['inspect', CONTAINER, '--format', '{{.State.Running}}']);
  if (!res.ok) return 'missing';
  return res.out === 'true' ? 'running' : 'stopped';
}

function ensureContainer() {
  step('Postgres container');
  const state = containerState();

  if (state === 'running') {
    ok(`${CONTAINER} already running`);
  } else if (state === 'stopped') {
    info(`${CONTAINER} exists but is stopped — starting it`);
    run('docker', ['start', CONTAINER]);
    ok(`${CONTAINER} started`);
  } else {
    info(`creating ${CONTAINER} (${IMAGE}) on port ${PORT}`);
    // A *named* volume, so memories survive `docker rm` of the container, and
    // `--restart unless-stopped`, so they survive a reboot without a manual
    // `docker start` before every AI client session.
    run('docker', [
      'run', '-d',
      '--name', CONTAINER,
      '--restart', 'unless-stopped',
      '-e', 'POSTGRES_PASSWORD=postgres',
      '-p', `${PORT}:5432`,
      '-v', `${VOLUME}:/var/lib/postgresql/data`,
      IMAGE,
    ]);
    ok(`${CONTAINER} created (named volume ${VOLUME}, restarts with Docker)`);
  }

  // Flag durability gaps on a container this script didn't create, rather than
  // silently recreating it — it may be holding real memories.
  const policy = tryRun('docker', ['inspect', CONTAINER, '--format', '{{.HostConfig.RestartPolicy.Name}}']);
  if (policy.ok && policy.out === 'no') {
    warn(`${CONTAINER} has restart policy "no" — it will not come back after a reboot.`);
    warn(`  To fix: docker update --restart unless-stopped ${CONTAINER}`);
  }
  const anon = tryRun('docker', [
    'inspect', CONTAINER, '--format', '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{.Name}}{{end}}{{end}}',
  ]);
  if (anon.ok && anon.out && anon.out !== VOLUME && /^[0-9a-f]{64}$/.test(anon.out)) {
    warn(`${CONTAINER} stores data in an anonymous volume — \`docker rm\` would strand your memories.`);
  }
}

/**
 * Waits for the *real* server, not the temporary one.
 *
 * On a fresh volume the postgres image runs initdb, brings up a temporary server
 * for its init scripts, shuts it down, then starts the real one. That temp server
 * listens on the unix socket **only** — so `pg_isready` (socket by default) reports
 * ready during init, and the next command then fails with "No such file or
 * directory" as the socket goes away underneath it. Forcing TCP sidesteps the whole
 * window: nothing answers on TCP until the real server is up, which is also the
 * path the plugin itself connects over.
 */
async function waitForPostgres() {
  step('Postgres readiness');
  for (let attempt = 0; attempt < 90; attempt++) {
    if (tryRun('docker', ['exec', CONTAINER, 'psql', '-U', 'postgres', '-h', '127.0.0.1', '-tc', 'SELECT 1']).ok) {
      ok('Postgres accepting connections');
      return;
    }
    if (attempt === 3) info('waiting for first-time database initialization…');
    await sleep(1000);
  }
  fail(`Postgres in ${CONTAINER} did not become ready within 90s.`, `Check: docker logs ${CONTAINER}`);
}

async function ensureVectorExtension() {
  step('pgvector extension');
  // Must exist *before* the engine's first connect: initDatabase() registers the
  // pgvector type with `pg` before ensureTablesExist() runs its own
  // CREATE EXTENSION, so a genuinely fresh database otherwise fails that first
  // connection with "vector type not found in the database".
  let last = '';
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = tryRun('docker', [
      'exec', CONTAINER, 'psql', '-U', 'postgres', '-h', '127.0.0.1',
      '-c', 'CREATE EXTENSION IF NOT EXISTS vector;',
    ]);
    if (res.ok) {
      ok('vector extension present');
      return;
    }
    last = res.out;
    await sleep(2000);
  }
  fail('Could not create the vector extension.', last);
}

// ---------------------------------------------------------------- Ollama

async function ensureOllama() {
  step('Ollama (local embeddings)');
  if (!tryRun('ollama', ['--version']).ok) {
    fail(
      'Ollama is not installed.',
      'Install it: https://ollama.com/download  (or: brew install ollama)\nThen re-run `npm run setup`.',
    );
  }

  const list = tryRun('ollama', ['list']);
  if (!list.ok) {
    fail('Ollama is installed but not responding.', 'Start it (`ollama serve`, or launch the app), then re-run `npm run setup`.');
  }

  if (list.out.includes(OLLAMA_MODEL)) {
    ok(`${OLLAMA_MODEL} already pulled`);
  } else {
    info(`pulling ${OLLAMA_MODEL} (~270MB, one time)`);
    try {
      execFileSync('ollama', ['pull', OLLAMA_MODEL], { stdio: 'inherit' });
    } catch {
      fail(`Failed to pull ${OLLAMA_MODEL}.`, `Try manually: ollama pull ${OLLAMA_MODEL}`);
    }
    ok(`${OLLAMA_MODEL} pulled`);
  }
}

// ---------------------------------------------------------------- Policy

// Kept in step with src/policy.ts by hand: this script runs before `npm run
// build`, so it cannot import from the bundle it is about to produce.
const DEFAULT_SCOPE = 'everything';
const DEFAULT_RECALL = 'balanced';

const SCOPES = [
  ['preferences', 'tone, workflow habits, tooling and style choices'],
  ['important', 'preferences, plus decisions, constraints, and durable context'],
  ['everything', 'any durable personal fact about you'],
  ['custom', 'write your own rule'],
];

const TRIGGERS = [
  ['proactive', 'your AI assistant decides, and saves as it learns'],
  ['manual', 'nothing is stored unless you explicitly ask the assistant'],
];

const RECALLS = [
  ['minimal', 'only when you point at the past yourself'],
  ['balanced', 'when the question plausibly depends on your context'],
  ['aggressive', 'before almost every answer — thorough, but costs a lookup each time'],
];

const POLICY_FILE_HEADER = `<!--
  oak-memory custom policy.

  Everything outside HTML comments in this file is handed to the AI assistant verbatim as
  the rule for what to remember about you — so write it as an instruction, not
  as notes. Comments like this one are stripped. Edits apply to the next
  AI client session; no rebuild needed.
-->`;

const describe = policy =>
  `${policy.scope} · ${policy.autosave ? 'saves proactively' : 'saves only when asked'}` +
  ` · ${policy.recall} recall`;

async function choose(rl, title, options, defaultKey) {
  console.log(`\n  \x1b[1m${title}\x1b[0m`);
  options.forEach(([key, blurb], i) => {
    const suffix = key === defaultKey ? ' \x1b[2m(default)\x1b[0m' : '';
    console.log(`    ${i + 1}) \x1b[36m${key.padEnd(11)}\x1b[0m ${blurb}${suffix}`);
  });
  for (;;) {
    const answer = (await rl.question(`  → 1-${options.length}, or enter for ${defaultKey}: `)).trim();
    if (!answer) return defaultKey;
    const index = Number(answer);
    if (Number.isInteger(index) && index >= 1 && index <= options.length) return options[index - 1][0];
    const named = options.find(([key]) => key === answer.toLowerCase());
    if (named) return named[0];
    warn(`"${answer}" is not one of those — pick 1-${options.length}.`);
  }
}

/** Returns the policy to write, or null to leave an existing one untouched. */
async function resolvePolicy() {
  step('Memory policy');

  const existing = readEnvFile();
  const currentValue = name =>
    existing
      .match(new RegExp(`^\\s*${name}\\s*=\\s*(.+)$`, 'm'))?.[1]
      .trim()
      .replace(/^(['"])(.*)\1$/, '$2');
  const currentScope = currentValue('MEMORY_POLICY_SCOPE');
  if (currentScope && !RECONFIGURE) {
    const currentAutosave = currentValue('MEMORY_POLICY_AUTOSAVE');
    const currentRecall = currentValue('MEMORY_POLICY_RECALL');
    const problems = [];
    if (!SCOPES.some(([scope]) => scope === currentScope)) {
      problems.push(`MEMORY_POLICY_SCOPE=${currentScope}`);
    }
    if (currentAutosave && !['true', 'false'].includes(currentAutosave.toLowerCase())) {
      problems.push(`MEMORY_POLICY_AUTOSAVE=${currentAutosave}`);
    }
    if (currentRecall && !RECALLS.some(([recall]) => recall === currentRecall)) {
      problems.push(`MEMORY_POLICY_RECALL=${currentRecall}`);
    }
    if (problems.length > 0) {
      fail(
        `Invalid memory policy in ${envFile}: ${problems.join(', ')}`,
        'The primary config intentionally wins over legacy fallback, even when invalid.\n' +
          'Fix or remove those keys, or run `npm run setup -- --reconfigure` to replace them.',
      );
    }
    ok(
      'already configured — ' +
        describe({
          scope: currentScope,
          autosave: currentAutosave?.toLowerCase() !== 'false',
          recall: currentRecall ?? DEFAULT_RECALL,
        }),
    );
    info('to change it: npm run setup -- --reconfigure');
    return null;
  }

  const defaults = { scope: DEFAULT_SCOPE, autosave: true, recall: DEFAULT_RECALL };

  // Piped stdin (CI, `curl | node`) has no one to answer, and blocking on a
  // question nobody sees would hang the install. Take the defaults and say so.
  if (!process.stdin.isTTY) {
    info(`no terminal attached — using the default: ${describe(defaults)}`);
    info('to choose: run `npm run setup -- --reconfigure` from a terminal');
    return defaults;
  }

  console.log('\n  Three questions decide how your AI assistant uses memory. All changeable later');
  console.log('  \x1b[2mwith `npm run setup -- --reconfigure`, or the memory configuration workflow.\x1b[0m');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const scope = await choose(rl, 'What should your AI assistant remember?', SCOPES, DEFAULT_SCOPE);
    const trigger = await choose(rl, 'When should it save?', TRIGGERS, 'proactive');
    const recall = await choose(rl, 'How hard should it search before answering?', RECALLS, DEFAULT_RECALL);

    let customText;
    if (scope === 'custom') {
      console.log('\n  \x1b[1mYour rule\x1b[0m — one line here; expand it in the file afterwards.');
      console.log('  \x1b[2me.g. Only my coding preferences and architecture decisions. Skip small talk.\x1b[0m');
      do {
        customText = (await rl.question('  → ')).trim();
        if (!customText) warn('a custom policy needs a rule — type one, or Ctrl-C to start over.');
      } while (!customText);
    }

    return { scope, autosave: trigger === 'proactive', recall, customText };
  } catch (error) {
    // readline rejects a pending question when stdin closes — Ctrl+D, or a
    // caller that attached a terminal but no keyboard. Neither is a crash, and
    // neither tells us what the user wanted, so land on the same defaults the
    // no-terminal path uses rather than aborting an otherwise fine install.
    if (error?.code !== 'ABORT_ERR') throw error;
    console.log();
    warn(`no answer given — using the default: ${describe(defaults)}`);
    info('to choose: npm run setup -- --reconfigure');
    return defaults;
  } finally {
    rl.close();
  }
}

function applyPolicy(policy) {
  if (!policy) return;

  if (policy.scope === 'custom') {
    fs.mkdirSync(path.dirname(policyFile), { recursive: true });
    fs.writeFileSync(policyFile, `${POLICY_FILE_HEADER}\n\n${policy.customText}\n`);
    ok(`wrote your rule to ${policyFile}`);
  }

  upsertEnvVars({
    MEMORY_POLICY_SCOPE: policy.scope,
    MEMORY_POLICY_AUTOSAVE: String(policy.autosave),
    MEMORY_POLICY_RECALL: policy.recall,
  });
  ok(`policy: ${describe(policy)}`);
}

// ---------------------------------------------------------------- Config

function readEnvFile() {
  try {
    return fs.readFileSync(envFile, 'utf8');
  } catch {
    return '';
  }
}

/** Rewrites keys in place so --reconfigure replaces rather than appends. */
function upsertEnvVars(pairs) {
  let content = readEnvFile();
  for (const [key, value] of Object.entries(pairs)) {
    // `\s*` never crosses a `#`, so commented-out defaults stay commented out
    // and a real assignment gets appended below them.
    const assignment = new RegExp(`^\\s*${key}\\s*=.*$`, 'm');
    if (assignment.test(content)) {
      content = content.replace(assignment, `${key}=${value}`);
    } else {
      content += `${content && !content.endsWith('\n') ? '\n' : ''}${key}=${value}\n`;
    }
  }
  fs.mkdirSync(path.dirname(envFile), { recursive: true });
  fs.writeFileSync(envFile, content);
}

function ensureEnvFile() {
  step('Configuration');
  if (fs.existsSync(envFile)) {
    const existing = fs.readFileSync(envFile, 'utf8');
    if (/^\s*MEMORY_DATABASE_URL\s*=/m.test(existing)) {
      ok(`${envFile} already sets MEMORY_DATABASE_URL — leaving it alone`);
      return;
    }
    fs.appendFileSync(envFile, `\nMEMORY_DATABASE_URL=${DB_URL}\n`);
    ok(`appended MEMORY_DATABASE_URL to ${envFile}`);
    return;
  }

  fs.mkdirSync(path.dirname(envFile), { recursive: true });
  fs.writeFileSync(
    envFile,
    `# oak-memory plugin configuration — written by \`npm run setup\`.
#
# Lives outside the plugin on purpose: installing/updating replaces plugin
# caches, so this client-neutral copy survives and can be shared by Codex and Claude Code.
#
# Memories live in the \`${CONTAINER}\` container's \`${VOLUME}\` volume.
MEMORY_DATABASE_URL=${DB_URL}

# Optional — defaults shown; uncomment to override.
# MEMORY_ENTITY_ID=fredriccliver
# OLLAMA_BASE_URL=http://localhost:11434/v1
# OLLAMA_EMBEDDING_MODEL=${OLLAMA_MODEL}
`,
  );
  ok(`wrote ${envFile}`);
}

function ensureBuild() {
  step('Build');
  const sharedDir = path.join(repoRoot, 'dist');
  const codexDir = path.join(repoRoot, 'plugins', 'oak-memory', 'dist');
  const bundleNames = ['index.mjs', 'hook.mjs'];
  const bundlesMatch = bundleNames.every(name => {
    const sharedBundle = path.join(sharedDir, name);
    const codexBundle = path.join(codexDir, name);
    return (
      fs.existsSync(sharedBundle) &&
      fs.existsSync(codexBundle) &&
      fs.readFileSync(sharedBundle).equals(fs.readFileSync(codexBundle))
    );
  });

  if (!bundlesMatch) {
    info('client bundles missing or out of sync — building');
    execFileSync('npm', ['run', 'build'], { cwd: repoRoot, stdio: 'inherit' });
  }
  ok('Claude and Codex bundles present and synchronized');
}

// ---------------------------------------------------------------- Smoke test

/**
 * Exercises the real MCP surface end to end. `listMemories` is the cheapest tool
 * that actually reaches Postgres — startup and tools/list both pass even when the
 * database is unreachable, so neither proves anything on its own.
 */
function smokeTest() {
  step('Smoke test');
  return new Promise(resolve => {
    const child = spawn('node', [path.join(repoRoot, 'dist', 'index.mjs')], {
      env: { ...process.env, MEMORY_DATABASE_URL: DB_URL },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => (stdout += d));
    child.stderr.on('data', d => (stderr += d));

    const send = msg => child.stdin.write(JSON.stringify(msg) + '\n');
    send({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'setup', version: '1' } },
    });
    setTimeout(() => send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'listMemories', arguments: {} } }), 500);

    const finish = () => {
      child.kill();
      for (const line of stdout.split('\n').filter(Boolean)) {
        try {
          const msg = JSON.parse(line);
          if (msg.id !== 2) continue;
          if (msg.result && !msg.result.isError) {
            ok('server started, tools registered, database reachable');
            const text = msg.result.content?.[0]?.text ?? '';
            info(text.split('\n')[0]);
            return resolve(true);
          }
          warn(`listMemories failed: ${msg.result?.content?.[0]?.text ?? JSON.stringify(msg.error)}`);
          return resolve(false);
        } catch {
          /* not a JSON-RPC line */
        }
      }
      warn('no response from the server');
      if (stderr.trim()) warn(stderr.trim().split('\n')[0]);
      resolve(false);
    };

    setTimeout(finish, 15000);
  });
}

// ---------------------------------------------------------------- Main

async function main() {
  console.log('\n\x1b[1moak-memory setup\x1b[0m — checks what exists, only does what is missing.');

  // Asked before the slow steps so you can answer once and walk away, rather
  // than being ambushed by a question after two minutes of pulling images.
  const policy = await resolvePolicy();

  ensureDocker();
  ensureContainer();
  await waitForPostgres();
  await ensureVectorExtension();
  await ensureOllama();
  ensureEnvFile();
  applyPolicy(policy);
  ensureBuild();
  const passed = await smokeTest();

  if (!passed) {
    console.log('\n\x1b[33mSetup finished, but the smoke test did not pass.\x1b[0m See the warnings above.\n');
    process.exit(1);
  }

  console.log(`
\x1b[32m\x1b[1mReady.\x1b[0m

The shared configuration is ready at ${envFile}.

For Claude Code, register the plugin in ~/.claude/settings.json and restart:

  "extraKnownMarketplaces": {
    "oak-memory": { "source": { "source": "directory", "path": "${repoRoot}" } }
  },
  "enabledPlugins": { "oak-memory@oak-memory": true }

For Codex, add this repository as a local marketplace, install oak-memory,
then start a new task. See README.md for the exact commands.

Then try: "Remember that I prefer TDD" · "Show my memory graph"
`);
}

main().catch(error => {
  console.error(`\n\x1b[31m✗ Unexpected error:\x1b[0m ${error?.message ?? error}`);
  process.exit(1);
});
