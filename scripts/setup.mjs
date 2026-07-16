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
 * Claude Code session spawns its own MCP server process, and PGlite is
 * single-connection — several processes against one data directory corrupt the
 * WAL. A real Postgres handles that concurrency natively, so the goal here is
 * to make it effortless to set up, not to remove it.
 */

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CONTAINER = 'oak-memory-pg';
const VOLUME = 'oak-memory-pgdata';
const IMAGE = 'pgvector/pgvector:pg16';
const PORT = 55432;
const DB_URL = `postgresql://postgres:postgres@localhost:${PORT}/postgres`;
const OLLAMA_MODEL = 'nomic-embed-text';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envFile = path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude'), 'oak-memory.env');

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
    // `docker start` before every Claude Code session.
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

async function waitForPostgres() {
  step('Postgres readiness');
  for (let attempt = 0; attempt < 60; attempt++) {
    if (tryRun('docker', ['exec', CONTAINER, 'pg_isready', '-U', 'postgres']).ok) {
      ok('Postgres accepting connections');
      return;
    }
    await sleep(1000);
  }
  fail(`Postgres in ${CONTAINER} did not become ready within 60s.`, `Check: docker logs ${CONTAINER}`);
}

function ensureVectorExtension() {
  step('pgvector extension');
  // Must exist *before* the engine's first connect: initDatabase() registers the
  // pgvector type with `pg` before ensureTablesExist() runs its own
  // CREATE EXTENSION, so a genuinely fresh database otherwise fails that first
  // connection with "vector type not found in the database".
  const res = tryRun('docker', [
    'exec', CONTAINER, 'psql', '-U', 'postgres', '-c', 'CREATE EXTENSION IF NOT EXISTS vector;',
  ]);
  if (!res.ok) fail('Could not create the vector extension.', res.out);
  ok('vector extension present');
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

// ---------------------------------------------------------------- Config

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
# Lives outside the plugin on purpose: installing/updating replaces
# ~/.claude/plugins/cache/oak-memory/..., so this is the copy that survives.
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
  const bundle = path.join(repoRoot, 'dist', 'index.mjs');
  if (!fs.existsSync(bundle)) {
    info('dist/index.mjs missing — building');
    execFileSync('npm', ['run', 'build'], { cwd: repoRoot, stdio: 'inherit' });
  }
  ok('dist/index.mjs present');
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

  ensureDocker();
  ensureContainer();
  await waitForPostgres();
  ensureVectorExtension();
  await ensureOllama();
  ensureEnvFile();
  ensureBuild();
  const passed = await smokeTest();

  if (!passed) {
    console.log('\n\x1b[33mSetup finished, but the smoke test did not pass.\x1b[0m See the warnings above.\n');
    process.exit(1);
  }

  console.log(`
\x1b[32m\x1b[1mReady.\x1b[0m

Register the plugin in ~/.claude/settings.json (once), then restart Claude Code:

  "extraKnownMarketplaces": {
    "oak-memory": { "source": { "source": "directory", "path": "${repoRoot}" } }
  },
  "enabledPlugins": { "oak-memory@oak-memory": true }

Then try:  /memory-save I prefer TDD   ·   /memory-graph
`);
}

main().catch(error => {
  console.error(`\n\x1b[31m✗ Unexpected error:\x1b[0m ${error?.message ?? error}`);
  process.exit(1);
});
