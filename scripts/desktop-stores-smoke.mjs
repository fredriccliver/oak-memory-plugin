import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
const temp = mkdtempSync(path.join(os.tmpdir(), 'oak-desktop-stores-'));
const stores = ['1', '2', '3', '4'].map((n, i) => ({ name: `Store ${n}`, storeId: `${n.repeat(8)}-${n.repeat(4)}-4${n.repeat(3)}-8${n.repeat(3)}-${n.repeat(12)}`, personalKey: 'oak_' + 'abcd'[i].repeat(64) }));
const result = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
const parsed = response => JSON.parse(response.content[0].text);
let revoked = false, mismatch = false, writes = [], requests = [], wrongKeys = 0;
const http = createServer(async (req, res) => {
  const store = stores.find(store => store.storeId === req.headers['x-oak-graph']);
  if (!store || req.headers.authorization !== `Bearer ${store.personalKey}`) { wrongKeys++; res.writeHead(401).end(); return; }
  requests.push(store.storeId);
  if (revoked && store === stores[2]) { res.writeHead(401).end(); return; }
  const server = new McpServer({ name: 'fixture', version: '1' });
  const role = store === stores[1] ? 'reader' : 'owner';
  server.registerTool('currentMemoryStore', { inputSchema: {} }, async () => result({ storeId: mismatch && store === stores[3] ? 'wrong' : store.storeId, name: store.name, role, authorUserId: `user-${store.name}` }));
  for (const name of ['recallMemory', 'listMemories']) server.registerTool(name, { inputSchema: {} }, async () => result({ memories: [{ content: store.name }], storeId: store.storeId }));
  for (const name of ['createMemory', 'futureWriteTool']) server.registerTool(name, { inputSchema: {} }, async () => { writes.push(store.storeId); return result({ storeId: store.storeId }); });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => { void transport.close(); void server.close(); });
  await server.connect(transport); await transport.handleRequest(req, res);
});
await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
try {
  const output = path.join(temp, 'bundle.mcpb');
  assert.equal(spawnSync(process.execPath, ['scripts/package-desktop.mjs', output], { encoding: 'utf8' }).status, 0);
  assert.equal(spawnSync('unzip', ['-q', output, '-d', temp]).status, 0);
  const manifest = JSON.parse(readFileSync(path.join(temp, 'manifest.json'), 'utf8'));
  assert.equal(manifest.user_config.stores.sensitive, true);
  assert.equal(manifest.user_config.store_id.required, false);
  await build({ entryPoints: ['src/desktop-config.ts'], bundle: true, platform: 'node', format: 'esm', outfile: path.join(temp, 'config.mjs') });
  const { desktopConfig } = await import(pathToFileURL(path.join(temp, 'config.mjs')));
  const cfg = desktopConfig({ OAK_DESKTOP_STORES: JSON.stringify(stores) });
  assert.equal(Object.keys(cfg.config.profiles).length, 4);
  assert.equal(Object.keys(cfg.credentials).length, 4);
  assert(!JSON.stringify(cfg.config).includes(stores[0].personalKey));
  assert.equal(Object.keys(desktopConfig({ OAK_DESKTOP_STORE_ID: stores[0].storeId, OAK_DESKTOP_PERSONAL_KEY: stores[0].personalKey, OAK_DESKTOP_STORES: JSON.stringify(stores.slice(1)) }).config.profiles).length, 4);
  for (const raw of ['bad', '{}', '[]', JSON.stringify([stores[0], stores[0]]), JSON.stringify([{ ...stores[0], personalKey: 'bad' }]), JSON.stringify([stores[0], { ...stores[1], name: stores[0].name }])]) {
    assert.throws(() => desktopConfig({ OAK_DESKTOP_STORES: raw }));
    assert.throws(() => desktopConfig({ OAK_DESKTOP_STORE_ID: stores[0].storeId, OAK_DESKTOP_PERSONAL_KEY: stores[0].personalKey, OAK_DESKTOP_STORES: raw }));
  }
  const entry = path.join(temp, manifest.server.entry_point);
  writeFileSync(entry, readFileSync(entry, 'utf8').replaceAll('https://www.openaikits.com/api/mcp', `http://127.0.0.1:${http.address().port}/api/mcp`));
  for (const allow of [false, true]) {
    const client = new Client({ name: 'desktop-stores-test', version: '1' });
    const transport = new StdioClientTransport({ command: process.execPath, args: [entry], env: { PATH: process.env.PATH, HOME: temp, OAK_CONFIG_DIR: temp, OAK_DESKTOP_STORES: JSON.stringify(stores), OAK_DESKTOP_ALLOW_CHANGES: String(allow), MEMORY_DATABASE_URL: 'postgres://must-not-be-used' }, stderr: 'pipe' });
    let stderr = ''; transport.stderr?.on('data', chunk => stderr += chunk);
    try {
      await client.connect(transport);
      const tools = (await client.listTools()).tools;
      assert.equal(tools.some(tool => tool.name === 'createMemory'), allow);
      if (allow) assert(tools.find(tool => tool.name === 'createMemory').inputSchema.required.includes('storeId'));
      assert(!tools.find(tool => tool.name === 'recallMemory').inputSchema.required.includes('storeId'));
      assert.equal(parsed(await client.callTool({ name: 'listMemoryStores', arguments: {} })).stores.filter(store => store.verified).length, 4);
      for (const name of ['recallMemory', 'listMemories']) {
        const grouped = parsed(await client.callTool({ name, arguments: {} }));
        assert.deepEqual(grouped.stores.map(store => store.storeId), stores.map(store => store.storeId));
        for (const item of grouped.stores) assert.equal(parsed(item.result).storeId, item.storeId);
        requests = [];
        const scoped = parsed(await client.callTool({ name, arguments: { storeId: stores[2].storeId } }));
        assert.equal(scoped.stores.length, 1); assert(requests.every(id => id === stores[2].storeId));
      }
      requests = []; const before = writes.length;
      assert.equal((await client.callTool({ name: 'createMemory', arguments: {} })).isError, true);
      assert.equal(requests.length, 0); assert.equal(writes.length, before);
      for (const name of ['recallMemory', 'listMemories', 'createMemory']) {
        assert.equal((await client.callTool({ name, arguments: { storeId: 'unknown' } })).isError, true);
        assert.equal(requests.length, 0);
      }
      for (const name of ['createMemory', 'futureWriteTool']) {
        const previous = writes.length;
        const response = await client.callTool({ name, arguments: { storeId: stores[0].storeId } });
        assert.equal(!!response.isError, !allow); assert.equal(writes.length, previous + (allow ? 1 : 0));
        if (allow) assert.equal(writes.at(-1), stores[0].storeId);
        assert.equal((await client.callTool({ name, arguments: { storeId: stores[1].storeId } })).isError, true);
        assert.equal(writes.length, previous + (allow ? 1 : 0));
      }
      await client.callTool({ name: 'selectMemoryProfile', arguments: { profile: stores[1].name } });
      assert.equal(parsed(await client.callTool({ name: 'currentMemoryStore', arguments: {} })).storeId, stores[1].storeId);
      assert.equal(parsed(await client.callTool({ name: 'recallMemory', arguments: {} })).stores.length, 4);
      revoked = true; mismatch = true;
      const partial = parsed(await client.callTool({ name: 'recallMemory', arguments: {} }));
      assert.equal(partial.partialFailure, true); assert.deepEqual(partial.stores.map(store => store.isError), [false, false, true, true]);
      const listed = parsed(await client.callTool({ name: 'listMemoryStores', arguments: {} }));
      assert.deepEqual(listed.stores.map(store => store.verified), [true, true, false, false]);
      assert.equal((await client.callTool({ name: 'selectMemoryProfile', arguments: { profile: stores[3].name } })).isError, true);
      assert.equal(parsed(await client.callTool({ name: 'currentMemoryStore', arguments: {} })).storeId, stores[1].storeId);
      const priorWrites = writes.length;
      assert.equal((await client.callTool({ name: 'createMemory', arguments: { storeId: stores[3].storeId } })).isError, true);
      assert.equal(writes.length, priorWrites);
      revoked = false; mismatch = false;
      assert.equal(parsed(await client.callTool({ name: 'listMemories', arguments: {} })).partialFailure, false);
      assert(stores.every(store => !stderr.includes(store.personalKey)));
      assert.equal(wrongKeys, 0);
    } finally { revoked = false; mismatch = false; await client.close(); }
  }
  console.log('Desktop four-store bundle passed: all-store and scoped search, source attribution, matching keys, explicit write targets, read-only and reader denial, partial failures, recovery, failed switch retention, and legacy configuration.');
} finally { http.closeAllConnections(); await new Promise(resolve => http.close(resolve)); rmSync(temp, { recursive: true, force: true }); }
