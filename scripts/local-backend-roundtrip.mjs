/** Disposable backend integration. Runtime fixture JSON arrives on stdin; keys stay in memory. */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

let temporary;
let client;
let stage = 'fixture input';
const resultText = result => result.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
const expectSuccess = result => assert.ok(!result.isError, 'Fixture tool call failed');
try {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const fixture = JSON.parse(input); input = '';
  const endpoint = new URL(fixture.endpoint);
  assert.ok(endpoint.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(endpoint.hostname) && endpoint.port && endpoint.pathname === '/api/mcp' && !endpoint.search && !endpoint.hash && !endpoint.username && !endpoint.password, 'Only disposable loopback MCP endpoints are permitted');
  assert.ok(Array.isArray(fixture.profiles) && fixture.profiles.length >= 2, 'At least two fixture profiles required');
  const profiles = {};
  const credentialEnv = {};
  for (const [index, profile] of fixture.profiles.entries()) {
    assert.ok(typeof profile.name === 'string' && /^[a-z][a-z0-9-]*$/.test(profile.name) && !profiles[profile.name]);
    assert.ok(/^[0-9a-f-]{36}$/i.test(profile.graphId) && /^oak_[0-9a-f]{64}$/.test(profile.key));
    assert.ok(['owner', 'editor', 'reader'].includes(profile.role) && typeof profile.authorUserId === 'string');
    const reference = `OAK_FIXTURE_KEY_${index}`;
    profiles[profile.name] = { backend: 'cloud', endpoint: endpoint.href, graphId: profile.graphId, credentialEnv: reference };
    credentialEnv[reference] = profile.key;
  }
  const first = fixture.profiles[0];
  profiles['invalid-key'] = { ...profiles[first.name], credentialEnv: 'OAK_FIXTURE_INVALID_KEY' };
  credentialEnv.OAK_FIXTURE_INVALID_KEY = 'oak_' + '0'.repeat(64);
  temporary = mkdtempSync(path.join(os.tmpdir(), 'oak-local-backend-'));
  const profileFile = path.join(temporary, 'profiles.json');
  // Profile metadata only. Never write keys to a file, including temporary files.
  writeFileSync(profileFile, JSON.stringify({ defaultProfile: first.name, profiles }), { mode: 0o600 });
  client = new Client({ name: 'oak-disposable-backend-integration', version: '1' });
  const transport = new StdioClientTransport({
    command: process.execPath, args: [path.join(repoRoot, 'dist/index.mjs')],
    env: {
      PATH: process.env.PATH ?? '', HOME: temporary,
      OAK_CONFIG_DIR: temporary, PLUGIN_ROOT: temporary,
      OAK_PROFILES_FILE: profileFile, OAK_BACKEND: 'cloud', OAK_PROFILE: first.name,
      MEMORY_POLICY_SCOPE: 'important', MEMORY_DATABASE_URL: '', ...credentialEnv,
    }, stderr: 'pipe',
  });
  let secretLogged = false;
  transport.stderr?.on('data', data => {
    if (fixture.profiles.some(p => data.toString().includes(p.key))) secretLogged = true;
  });
  stage = 'stdio bridge initialization';
  await client.connect(transport);
  const available = await client.listTools();
  for (const name of ['currentMemoryStore', 'listMemoryStores', 'selectMemoryProfile', 'listMemoryProfiles', 'getMemoryPolicy']) assert.ok(available.tools.some(tool => tool.name === name), 'Required integration tool missing');
  const created = [];
  try {
    for (const profile of fixture.profiles) {
      stage = `profile context ${profile.name}`;
      expectSuccess(await client.callTool({ name: 'selectMemoryProfile', arguments: { profile: profile.name } }));
      const contextResult = await client.callTool({ name: 'currentMemoryStore', arguments: {} }); expectSuccess(contextResult);
      const context = JSON.parse(resultText(contextResult));
      assert.equal(context.storeId, profile.graphId); assert.equal(context.role, profile.role); assert.equal(context.authorUserId, profile.authorUserId);
      expectSuccess(await client.callTool({ name: 'listMemoryStores', arguments: {} }));
      console.log(`PASS context and discovery: ${profile.name} (${profile.role})`);
      if (fixture.allowWrites === true) {
        const isolated = await client.callTool({ name: 'listMemories', arguments: {} }); expectSuccess(isolated);
        for (const memory of created) {
          if (profiles[memory.profile].graphId !== profile.graphId) assert.ok(!resultText(isolated).includes(memory.memoryId), 'Other graph fixture memory leaked');
        }
        stage = `fixture memory roundtrip ${profile.name}`;
        const content = `Disposable oak plugin fixture ${randomUUID()}: Alice said "I prefer tea". Speaker: Alice. Recording author is distinct.`;
        const create = await client.callTool({ name: 'createMemory', arguments: { content, speaker: 'unspecified' } });
        if (profile.role === 'reader') {
          assert.equal(create.isError, true); console.log(`PASS reader write denial: ${profile.name}`); continue;
        }
        expectSuccess(create);
        const memoryId = resultText(create).match(/\[([0-9a-f-]{36})\]/i)?.[1];
        assert.ok(memoryId, 'Created fixture memory UUID missing'); created.push({ profile: profile.name, memoryId });
        const list = await client.callTool({ name: 'listMemories', arguments: {} }); expectSuccess(list);
        assert.ok(resultText(list).includes(profile.authorUserId), 'Recording author provenance missing');
        assert.ok(resultText(list).includes(memoryId) && resultText(list).includes('Alice said "I prefer tea"'), 'Fixture memory or original quote missing');
        const recall = await client.callTool({ name: 'recallMemory', arguments: { query: content } }); expectSuccess(recall);
        assert.ok(resultText(recall).includes(memoryId), 'Fixture memory recall missing');
        console.log(`PASS create/list/recall and preserved quote: ${profile.name}`);
      }
    }
    stage = 'failed credential switch';
    assert.equal((await client.callTool({ name: 'selectMemoryProfile', arguments: { profile: 'invalid-key' } })).isError, true);
    const unchanged = JSON.parse(resultText(await client.callTool({ name: 'currentMemoryStore', arguments: {} })));
    assert.equal(unchanged.storeId, fixture.profiles.at(-1).graphId);
    assert.ok(!secretLogged, 'Fixture credential found in plugin diagnostics');
    console.log('PASS failed credential switch retains active profile; no credential diagnostics');
  } finally {
    for (const memory of created) {
      stage = 'disposable fixture cleanup';
      expectSuccess(await client.callTool({ name: 'selectMemoryProfile', arguments: { profile: memory.profile } }));
      expectSuccess(await client.callTool({ name: 'deleteMemory', arguments: { memoryId: memory.memoryId } }));
    }
    if (created.length) console.log(`PASS cleanup: ${created.length} disposable fixture memories deleted`);
  }
  console.log('PASS local backend SDK/stdio integration');
} catch {
  // Do not print SDK/backend errors or fixture payloads; they may echo credentials.
  console.error(`FAIL local backend integration at ${stage}. Fixture payload and backend diagnostics suppressed.`);
  process.exitCode = 1;
} finally {
  if (client) await client.close().catch(() => {});
  if (temporary) rmSync(temporary, { recursive: true, force: true });
}
