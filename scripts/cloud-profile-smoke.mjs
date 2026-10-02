import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
const temp = mkdtempSync(path.join(os.tmpdir(), 'oak-profiles-test-'));
const a = '11111111-1111-4111-8111-111111111111';
const b = '22222222-2222-4222-8222-222222222222';
const keyA = 'oak_' + 'a'.repeat(64), keyB = 'oak_' + 'b'.repeat(64);
process.env.TEST_OAK_A = keyA; process.env.TEST_OAK_B = keyB;
process.env.OAK_CONFIG_DIR = temp; process.env.PLUGIN_ROOT = temp;
process.env.MEMORY_POLICY_SCOPE = 'important';
let revoked = false;
let mismatchedContext = false;
let delayedContext;
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const requests = [];
const http = createServer(async (req, res) => {
  const graph = req.headers['x-oak-graph'];
  const valid = !revoked && ((graph === a && req.headers.authorization === `Bearer ${keyA}`) || (graph === b && req.headers.authorization === `Bearer ${keyB}`));
  if (!valid) { res.writeHead(401).end(); return; }
  requests.push(graph);
  const server = new McpServer({ name: 'mock-oak', version: '1' });
  const result = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
  server.registerTool('currentMemoryStore', { inputSchema: {} }, async () => {
    const gate = delayedContext;
    if (gate && gate.graph === graph) {
      gate.entered.resolve();
      await gate.release.promise;
    }
    return result({ storeId: mismatchedContext ? 'wrong-graph' : graph, name: graph === a ? 'Personal' : 'Team', role: graph === a ? 'owner' : 'reader', authorUserId: 'person-1', authorDisplayName: 'Person' });
  });
  server.registerTool('listMemoryStores', { inputSchema: {} }, async () => result({ graphs: [a, b] }));
  server.registerTool('recallMemory', { inputSchema: {} }, async () => {
    await new Promise(resolve => setTimeout(resolve, 50)); return result({ graphId: graph });
  });
  server.registerTool('createMemory', { inputSchema: {} }, async () => graph === b ? { ...result({ error: 'reader cannot write' }), isError: true } : result({ graphId: graph }));
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => { void transport.close(); void server.close(); });
  await server.connect(transport);
  await transport.handleRequest(req, res);
});
await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
const endpoint = `http://127.0.0.1:${http.address().port}/api/mcp`;
const config = { defaultProfile: 'personal', profiles: {
  personal: { backend: 'cloud', endpoint, graphId: a, credentialEnv: 'TEST_OAK_A' },
  team: { backend: 'cloud', endpoint, graphId: b, credentialEnv: 'TEST_OAK_B' },
  wrong: { backend: 'cloud', endpoint, graphId: b, credentialEnv: 'TEST_OAK_A' },
  local: { backend: 'local' },
} };
try {
  await build({ entryPoints: ['src/bridge.ts'], bundle: true, platform: 'node', format: 'esm', banner: { js: "import {createRequire} from 'node:module'; const require = createRequire(import.meta.url);" }, outfile: path.join(temp, 'bridge.mjs') });
  await build({ entryPoints: ['src/profiles.ts'], bundle: true, platform: 'node', format: 'esm', outfile: path.join(temp, 'profiles.mjs') });
  const { ProfileSession } = await import(pathToFileURL(path.join(temp, 'bridge.mjs')));
  const hook = spawnSync(process.execPath, ['dist/hook.mjs'], { input: '{}', encoding: 'utf8', env: { ...process.env, MEMORY_POLICY_RECALL: 'minimal', MEMORY_POLICY_AUTOSAVE: 'false' } });
  assert.equal(hook.status, 0);
  const attribution = JSON.parse(hook.stdout).hookSpecificOutput.additionalContext;
  assert.match(attribution, /semantic subject/);
  assert.match(attribution, /local getMemoryPolicy/);
  const { resolveBackend, credential } = await import(pathToFileURL(path.join(temp, 'profiles.mjs')));
  process.env.OAK_BACKEND = 'cloud';
  assert.equal(resolveBackend(config).profile.backend, 'cloud');
  assert.equal(process.env.MEMORY_DATABASE_URL, undefined);
  assert.throws(() => credential({ ...config.profiles.personal, credentialEnv: 'MISSING_KEY' }), /personal graph-bound/);
  process.env.OAK_CONFIG_DEFAULT_PROFILE = 'team';
  assert.equal(resolveBackend(config).name, 'team', 'native starting profile applies to new sessions');
  process.env.OAK_PROFILE = 'personal';
  assert.equal(resolveBackend(config).name, 'personal', 'explicit environment profile overrides native default');
  process.env.OAK_PROFILE = '${user_config.default_profile}';
  assert.equal(resolveBackend(config).name, 'team', 'unexpanded optional field is unset');
  delete process.env.OAK_PROFILE; delete process.env.OAK_CONFIG_DEFAULT_PROFILE;
  process.env.OAK_CONFIG_CLOUD_CREDENTIALS = JSON.stringify({ TEST_OAK_A: keyA, TEST_OAK_B: keyB });
  delete process.env.TEST_OAK_A;
  assert.equal(credential(config.profiles.personal), keyA, 'secure native per-graph key map resolves reference');
  process.env.TEST_OAK_A = keyA;
  process.env.OAK_CONFIG_CLOUD_CREDENTIALS = '{malformed';
  assert.equal(credential(config.profiles.personal), keyA, 'injected per-graph credential takes precedence');
  delete process.env.TEST_OAK_A;
  assert.throws(() => credential(config.profiles.personal), /Invalid secure cloud credential configuration/);
  process.env.TEST_OAK_A = keyA; delete process.env.OAK_CONFIG_CLOUD_CREDENTIALS;

  // Gate the actual mock server context response: no timing assumptions.
  for (const newer of ['team', 'wrong', 'unknown-profile']) {
    const racing = new ProfileSession(config, 'local');
    const gate = { graph: a, entered: deferred(), release: deferred() };
    delayedContext = gate;
    const slowSwitch = racing.select('personal');
    const superseded = assert.rejects(slowSwitch, /superseded/);
    try {
      await gate.entered.promise;
      assert.equal(racing.snapshot().name, 'local', 'validation cannot commit early');
      if (newer === 'team') {
        await racing.select(newer);
        assert.equal(racing.snapshot().name, 'team', 'newer fast switch commits');
      } else {
        await assert.rejects(racing.select(newer));
        assert.equal(racing.snapshot().name, 'local', 'failed newer switch keeps last committed profile');
      }
      gate.release.resolve();
      await superseded;
      assert.equal(racing.snapshot().name, newer === 'team' ? 'team' : 'local', 'late older validation cannot overwrite or revive a switch');
    } finally {
      gate.release.resolve();
      delayedContext = undefined;
      await superseded;
    }
  }
  const session = new ProfileSession(config, 'personal');
  assert.ok((await session.listTools()).tools.some(t => t.name === 'currentMemoryStore'));
  const pending = session.callTool('recallMemory');
  await session.select('team');
  assert.equal(JSON.parse((await pending).content[0].text).graphId, a, 'in-flight call stays on original graph');
  assert.equal(JSON.parse((await session.callTool('recallMemory')).content[0].text).graphId, b);
  assert.equal((await session.callTool('createMemory')).isError, true, 'reader writes denied by server');
  mismatchedContext = true;
  await assert.rejects(session.select('personal'), /Context mismatch/);
  assert.equal(session.snapshot().name, 'team', 'mismatched successful server context must not commit a switch');
  mismatchedContext = false;
  await assert.rejects(session.select('wrong'));
  assert.equal(session.snapshot().name, 'team', 'failed switch keeps existing session');
  await session.listTools();
  revoked = true;
  assert.ok((await session.listTools()).tools.some(t => t.name === 'recallMemory'), 'last discovered schema remains available when authorization is revoked');
  await assert.rejects(session.callTool('recallMemory'));
  assert.equal(session.snapshot().name, 'team', 'revocation does not fall back');
  revoked = false;
  const file = path.join(temp, 'profiles.json'); writeFileSync(file, JSON.stringify(config));
  const client = new Client({ name: 'smoke', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.resolve('dist/index.mjs')], env: { ...process.env, OAK_PROFILES_FILE: file, OAK_PROFILE: 'personal', MEMORY_DATABASE_URL: '', TEST_OAK_A: keyA, TEST_OAK_B: keyB }, stderr: 'pipe' });
  let stderr = ''; transport.stderr?.on('data', chunk => { stderr += chunk; });
  try {
    await client.connect(transport);
    assert.ok((await client.listTools()).tools.some(t => t.name === 'selectMemoryProfile'));
    const identity = JSON.parse((await client.callTool({ name: 'currentMemoryStore', arguments: {} })).content[0].text);
    const connected = JSON.parse((await client.callTool({ name: 'memoryConnectionStatus', arguments: {} })).content[0].text);
    assert.equal(connected.verified, true); assert.equal(connected.store.storeId, a); assert.equal(connected.store.role, 'owner');
    assert.equal(identity.storeId, a); assert.equal(identity.authorUserId, 'person-1'); assert.equal(identity.role, 'owner');
    assert.equal(JSON.parse((await client.callTool({ name: 'getMemoryPolicy', arguments: {} })).content[0].text).policy.scope, 'important');
    assert.equal((await client.callTool({ name: 'selectMemoryProfile', arguments: { profile: 'team' } })).isError, undefined);
    writeFileSync(file, JSON.stringify({ ...config, defaultProfile: 'personal' }));
    assert.equal(JSON.parse((await client.callTool({ name: 'currentMemoryStore', arguments: {} })).content[0].text).storeId, b, 'stored defaults cannot change active session');
    writeFileSync(path.join(temp, 'oak-memory.env'), 'MEMORY_DATABASE_URL=postgresql://test:test@127.0.0.1:1/mock_only\n');
    const localSwitch = await client.callTool({ name: 'selectMemoryProfile', arguments: { profile: 'local' } });
    assert.equal(localSwitch.isError, undefined, 'local profile verification does not connect to DB');
    assert.ok((await client.listTools()).tools.some(t => t.name === 'getMemoryPolicy'));
    await client.callTool({ name: 'selectMemoryProfile', arguments: { profile: 'team' } });
    revoked = true;
    assert.equal((await client.callTool({ name: 'recallMemory', arguments: {} })).isError, true);
    assert.ok((await client.listTools()).tools.some(t => t.name === 'memoryConnectionStatus'), 'status remains discoverable during authentication failure');
    const disconnected = await client.callTool({ name: 'memoryConnectionStatus', arguments: {} });
    assert.equal(disconnected.isError, true);
    assert.equal(JSON.parse(disconnected.content[0].text).profile, 'team');
    assert.equal(JSON.parse(disconnected.content[0].text).verified, false);
    assert.ok(!stderr.includes(keyA) && !stderr.includes(keyB), 'no credentials in diagnostics');
  } finally { await client.close(); }
  revoked = false;
  const runner = spawn(process.execPath, [path.resolve('scripts/local-backend-roundtrip.mjs')], { cwd: temp, stdio: ['pipe', 'pipe', 'pipe'] });
  let runnerOutput = ''; let runnerErrors = '';
  runner.stdout.on('data', data => { runnerOutput += data; });
  runner.stderr.on('data', data => { runnerErrors += data; });
  runner.stdin.end(JSON.stringify({ endpoint, profiles: [
    { name: 'personal', graphId: a, key: keyA, role: 'owner', authorUserId: 'person-1' },
    { name: 'team', graphId: b, key: keyB, role: 'reader', authorUserId: 'person-1' },
  ] }));
  const runnerExit = await new Promise((resolve, reject) => { runner.on('error', reject); runner.on('exit', resolve); });
  assert.equal(runnerExit, 0, 'Runtime fixture runner must pass mocked read-only integration');
  assert.ok(runnerOutput.includes('PASS local backend SDK/stdio integration'));
  assert.ok(!runnerOutput.includes(keyA) && !runnerOutput.includes(keyB) && !runnerErrors.includes(keyA) && !runnerErrors.includes(keyB));
  assert.ok(requests.includes(a) && requests.includes(b));
  console.log('Cloud profiles: SDK transport, no DB startup, identity, isolation, reader denial, revocation, in-flight snapshot, overlapping switch ordering, failed newer switch retention and defaults verified.');
} finally { http.closeAllConnections(); await new Promise(resolve => http.close(resolve)); rmSync(temp, { recursive: true, force: true }); }
