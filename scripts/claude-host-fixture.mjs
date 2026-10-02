/** Real installed Claude host + disposable backend; deterministic local model responses. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const toolPrefix = 'mcp__plugin_oak-memory_oak-memory__';
let temporary, modelServer, phase = 'fixture input', activePlan;
const evidence = { host: 'Claude Code', model: 'local deterministic response fixture; no live model/account validation', checks: [] };
const pass = check => { evidence.checks.push(check); console.log(`PASS ${check}`); };
function flatten(value) {
  if (typeof value === 'string') {
    try {
      const decoded = JSON.parse(value);
      if (Array.isArray(decoded) || (decoded && typeof decoded === 'object' && ('content' in decoded || 'text' in decoded))) return flatten(decoded);
    } catch { /* natural-language tool content */ }
    return value;
  }
  if (Array.isArray(value)) return value.map(flatten).join('\n');
  if (value && typeof value === 'object' && ('text' in value || 'content' in value)) return flatten(value.text ?? value.content);
  return JSON.stringify(value);
}
function contextFrom(text) {
  // The real host may compact text JSON or append host reminders. Compare
  // explicit returned scalar fields rather than require its display to be JSON.
  const scalar = field => {
    const match = text.match(new RegExp('(?:^|[\\s{,])"?' + field + '"?\\s*:\\s*"?([^\\s,"{}]+)'));
    return match?.[1];
  };
  const storeId = scalar('storeId'), role = scalar('role'), authorUserId = scalar('authorUserId');
  if (!storeId || !role || !authorUserId) throw new Error('Context wrapper unsupported');
  return { storeId, role, authorUserId };
}

function invoke(args, env, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.OAK_CLAUDE_BINARY ?? '/Users/miridih/.local/bin/claude', args, { cwd: path.join(temporary, 'work'), env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('Isolated Claude host timed out')); }, 120000);
    let eventBuffer = '';
    child.stdout.on('data', chunk => {
      stdout += chunk;
      if (args[0] === '-p') {
        eventBuffer += chunk;
        let newline;
        while ((newline = eventBuffer.indexOf('\n')) >= 0) {
          const line = eventBuffer.slice(0, newline); eventBuffer = eventBuffer.slice(newline + 1);
          try {
            const event = JSON.parse(line);
            if (event.type === 'system' && event.subtype === 'init') {
              const statuses = {};
              for (const server of event.mcp_servers ?? []) statuses[server.status] = (statuses[server.status] ?? 0) + 1;
              console.log(`HOST initialized installed plugin session; MCP status counts ${JSON.stringify(statuses)}`);
            }
            // Host tool payloads are deliberately not logged.
            if (event.type === 'result') console.log(`HOST completed (${event.is_error ? 'error' : 'success'})`);
          } catch { /* raw events are never logged */ }
        }
      }
    }); child.stderr.on('data', chunk => {
      stderr += chunk;
      if (args[0] === '-p') {
        const categories = ['auth', 'permission', 'model', 'network', 'login', 'API', 'error'].filter(tag => chunk.toString().toLowerCase().includes(tag.toLowerCase()));
        if (categories.length) console.log(`HOST diagnostic categories: ${categories.join(', ')}`);
      }
    });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('exit', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    child.stdin.end(input ?? '');
  });
}
function respond(res, request, block, reason) {
  const message = { id: `msg_${randomUUID()}`, type: 'message', role: 'assistant', model: request.model, content: [block], stop_reason: reason, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 10 } };
  if (!request.stream) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(message)); return; }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  const event = (type, value) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
  event('message_start', { message: { ...message, content: [], stop_reason: null } });
  if (block.type === 'tool_use') {
    event('content_block_start', { index: 0, content_block: { ...block, input: {} } });
    event('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } });
  } else {
    event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
    event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: block.text } });
  }
  event('content_block_stop', { index: 0 });
  event('message_delta', { delta: { stop_reason: reason, stop_sequence: null }, usage: { output_tokens: 10 } });
  event('message_stop', {}); res.end();
}
try {
  let input = ''; for await (const chunk of process.stdin) input += chunk;
  const fixture = JSON.parse(input); input = '';
  const endpoint = new URL(fixture.endpoint);
  assert.ok(endpoint.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(endpoint.hostname) && endpoint.port && endpoint.pathname === '/api/mcp' && !endpoint.search && !endpoint.hash && !endpoint.username && !endpoint.password);
  assert.ok(fixture.allowWrites === true && ['owner', 'editor', 'reader'].every(role => fixture.profiles.some(p => p.role === role)), 'Disposable owner/editor/reader fixtures required');
  const first = fixture.profiles.find(p => p.role === 'owner');
  temporary = mkdtempSync(path.join(os.tmpdir(), 'oak-claude-host-'));
  for (const name of ['home', 'config', 'oak', 'work']) mkdirSync(path.join(temporary, name));
  const profiles = {}, keyEnv = {}, created = [];
  for (const [index, profile] of fixture.profiles.entries()) {
    assert.ok(/^[a-z][a-z0-9-]*$/.test(profile.name) && /^oak_[0-9a-f]{64}$/.test(profile.key));
    const ref = `OAK_HOST_FIXTURE_KEY_${index}`; keyEnv[ref] = profile.key;
    profiles[profile.name] = { backend: 'cloud', endpoint: endpoint.href, graphId: profile.graphId, credentialEnv: ref };
  }
  profiles['invalid-key'] = { ...profiles[first.name], credentialEnv: 'OAK_HOST_INVALID_KEY' };
  keyEnv.OAK_HOST_INVALID_KEY = 'oak_' + '0'.repeat(64);
  profiles['offline'] = { ...profiles[first.name], endpoint: 'http://127.0.0.1:9/api/mcp' };
  const profileFile = path.join(temporary, 'oak', 'profiles.json');
  writeFileSync(profileFile, JSON.stringify({ defaultProfile: first.name, profiles }), { mode: 0o600 });
  const env = { PATH: process.env.PATH ?? '', HOME: path.join(temporary, 'home'), CLAUDE_CONFIG_DIR: path.join(temporary, 'config'), OAK_CONFIG_DIR: path.join(temporary, 'oak'), MEMORY_POLICY_SCOPE: 'important', MEMORY_POLICY_AUTOSAVE: 'false', MEMORY_DATABASE_URL: '', ...keyEnv,
    ANTHROPIC_API_KEY: 'disposable-local-model-stub', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', ENABLE_TOOL_SEARCH: 'false' };
  phase = 'isolated marketplace installation';
  for (const args of [['plugin', 'marketplace', 'add', root, '--scope', 'user'], ['plugin', 'install', 'oak-memory@oak-memory', '--scope', 'user']]) assert.equal((await invoke(args, env)).code, 0);
  const installed = JSON.parse((await invoke(['plugin', 'list', '--json'], env)).stdout);
  const plugin = installed.find(p => p.id === 'oak-memory@oak-memory'); assert.ok(plugin?.enabled && plugin.scope === 'user');
  assert.equal(readFileSync(path.join(plugin.installPath, 'dist', 'index.mjs'), 'utf8'), readFileSync(path.join(root, 'dist', 'index.mjs'), 'utf8'));
  evidence.version = (await invoke(['--version'], env)).stdout.trim();
  evidence.bundleSha256 = createHash('sha256').update(readFileSync(path.join(plugin.installPath, 'dist', 'index.mjs'))).digest('hex');
  pass('marketplace install to isolated user scope; installed bundle matches tested source');
  phase = 'native nonsecret configuration';
  assert.equal((await invoke(['plugin', 'configure', 'oak-memory@oak-memory', '--values-stdin'], env, JSON.stringify({ profiles_file: profileFile, default_profile: first.name }))).code, 0);
  const options = JSON.parse((await invoke(['plugin', 'configure', 'oak-memory@oak-memory', '--json'], env)).stdout);
  assert.ok(JSON.stringify(options).includes('profiles_file'));
  pass('native profile file and starting-profile configuration; fixture keys remain environment-only');
  modelServer = createServer(async (req, res) => {
    let request;
    try {
      let body = ''; for await (const chunk of req) body += chunk;
      if (req.url?.includes('count_tokens')) { res.writeHead(200, { 'content-type': 'application/json' }).end('{"input_tokens":100}'); return; }
      request = JSON.parse(body || '{}');
      assert.ok(!fixture.profiles.some(p => body.includes(p.key)), 'Credential reached model request');
      if (!req.url?.includes('/messages')) { res.writeHead(200, { 'content-type': 'application/json' }).end('{}'); return; }
      const plan = activePlan;
      if (!plan) { respond(res, request, { type: 'text', text: 'Local fixture idle.' }, 'end_turn'); return; }
      if (plan.pending) {
        const results = request.messages.flatMap(m => Array.isArray(m.content) ? m.content : []).filter(b => b.type === 'tool_result' && b.tool_use_id === plan.pending.id);
        if (!results.length) { respond(res, request, { type: 'text', text: 'Local fixture background response.' }, 'end_turn'); return; }
        plan.pending.verify(flatten(results.at(-1).content), results.at(-1)); plan.pending = undefined;
      }
      const step = plan.steps.shift();
      if (!step) { plan.done = true; respond(res, request, { type: 'text', text: 'OAK_HOST_FIXTURE_PASS (deterministic model fixture).' }, 'end_turn'); return; }
      plan.lastTool = step.tool;
      const name = toolPrefix + step.tool;
      if (!request.tools?.some(t => t.name === name)) {
        assert.ok(request.tools?.some(t => t.name === 'WaitForMcpServers'), 'Installed plugin MCP tool not advertised');
        const id = `tool_${randomUUID()}`;
        plan.steps.unshift(step); plan.pending = { id, verify: () => {} };
        respond(res, request, { type: 'tool_use', id, name: 'WaitForMcpServers', input: {} }, 'tool_use'); return;
      }
      const id = `tool_${randomUUID()}`; plan.pending = { id, verify: step.verify };
      respond(res, request, { type: 'tool_use', id, name, input: typeof step.input === 'function' ? step.input() : step.input ?? {} }, 'tool_use');
    } catch (error) { if (activePlan) { activePlan.failed = true; console.log('MODEL assertion failed (sanitized)'); activePlan.failureCategory = error.message === 'Installed plugin MCP tool not advertised' ? 'tool-not-advertised' : error.message === 'Credential reached model request' ? 'credential-redaction' : error.message === 'Tool returned failure' ? 'tool-failed' : error.message === 'Context wrapper unsupported' ? 'context-wrapper' : error.message === 'Context graph mismatch' ? 'context-graph' : error.message === 'Context role mismatch' ? 'context-role' : error.message === 'Context author mismatch' ? 'context-author' : 'response-assertion'; } if (request) respond(res, request, { type: 'text', text: 'OAK_HOST_FIXTURE_FAILED (sanitized).' }, 'end_turn'); else res.writeHead(500).end(); }
  });
  await new Promise(resolve => modelServer.listen(0, '127.0.0.1', resolve));
  env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${modelServer.address().port}`;
  const steps = [];
  const expectOkay = (text, block) => assert.ok(!block.is_error && !text.includes('Selected memory store request failed'), 'Tool returned failure');
  const contextStep = profile => ({ tool: 'currentMemoryStore', verify: (text, block) => { expectOkay(text, block); let c;
    try { c = contextFrom(text); } catch {
      let decoded; try { decoded = JSON.parse(text); } catch {}
      const knownKeys = decoded && typeof decoded === 'object' ? Object.keys(decoded).filter(k => ['result','data','structuredContent','content','text','storeId','role','name','authorUserId','authorDisplayName','output'].includes(k)) : [];
      console.log(`CONTEXT diagnostic ${JSON.stringify({ parsed: decoded !== undefined, knownKeys, hasStoreField: text.includes('storeId'), serializedTextBlocks: text.includes('"text"'), permissionMessage: /permission|denied|not allowed/i.test(text), startsWithJson: /^[\s]*[\[{"]/.test(text), chars: text.length })}`);
      throw new Error('Context wrapper unsupported');
    }
    if (c.storeId !== profile.graphId) throw new Error('Context graph mismatch');
    if (c.role !== profile.role) throw new Error('Context role mismatch');
    if (c.authorUserId !== profile.authorUserId) throw new Error('Context author mismatch'); } });
  for (const profile of fixture.profiles) {
    steps.push({ tool: 'selectMemoryProfile', input: { profile: profile.name }, verify: expectOkay }, contextStep(profile), { tool: 'listMemoryStores', verify: expectOkay });
    const content = `Disposable installed-Claude fixture ${randomUUID()}: Alice said "I prefer tea". Speaker: Alice. Recording author is distinct.`;
    let memoryId;
    steps.push({ tool: 'createMemory', input: { content, speaker: 'unspecified' }, verify: (text, block) => {
      if (profile.role === 'reader') { assert.ok(block.is_error || text.includes('Forbidden')); return; }
      expectOkay(text, block); memoryId = text.match(/\[([0-9a-f-]{36})\]/i)?.[1]; assert.ok(memoryId); created.push({ profile: profile.name, graphId: profile.graphId, memoryId });
      assert.ok(text.includes(profile.authorUserId));
    } });
    if (profile.role !== 'reader') {
      steps.push({ tool: 'listMemories', verify: (text, block) => { expectOkay(text, block); assert.ok(text.includes(memoryId) && text.includes(profile.authorUserId) && text.includes('Alice said "I prefer tea"')); for (const m of created) if (m.graphId !== profile.graphId) assert.ok(!text.includes(m.memoryId)); } }, { tool: 'recallMemory', input: { query: content }, verify: (text, block) => { expectOkay(text, block); assert.ok(text.includes(memoryId)); } });
    }
  }
  const last = fixture.profiles.at(-1);
  for (const name of ['invalid-key', 'offline']) steps.push({ tool: 'selectMemoryProfile', input: { profile: name }, verify: (text, block) => assert.ok(block.is_error || text.includes('Selected memory store request failed')) }, contextStep(last));
  // Delete only IDs created by this run, through the actual installed host.
  for (const profile of fixture.profiles.filter(p => p.role !== 'reader')) {
    steps.push({ tool: 'selectMemoryProfile', input: { profile: profile.name }, verify: expectOkay }, { tool: 'listMemories', verify: expectOkay });
    steps.push({ tool: 'deleteMemory', input: () => ({ memoryId: created.find(m => m.profile === profile.name)?.memoryId }), verify: expectOkay });
  }
  async function hostRun(planSteps, label, prompt) {
    phase = label; activePlan = { steps: planSteps, done: false, failed: false };
    const run = await invoke(['-p', prompt, '--model', 'claude-sonnet-4-6', '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--max-turns', '50', '--tools', '', '--allowedTools', ...['selectMemoryProfile','currentMemoryStore','listMemoryStores','createMemory','listMemories','recallMemory','deleteMemory','listMemoryProfiles','memoryConnectionStatus','getMemoryPolicy'].map(name => toolPrefix + name), 'WaitForMcpServers'], env);
    assert.ok(!fixture.profiles.some(p => run.stdout.includes(p.key) || run.stderr.includes(p.key)), 'Fixture credential reached host diagnostics');
    if (run.code !== 0 || !activePlan.done || activePlan.failed) {
      phase += ` (${activePlan.failureCategory ?? (run.code === null ? 'host-timeout' : 'host-incomplete')})`;
      throw new Error('Host fixture failed');
    }
    const lines = run.stdout.split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return {}; } });
    const init = lines.find(item => item.type === 'system' && item.subtype === 'init'); assert.ok(init);
    assert.ok(JSON.stringify(init).includes('memory-connect') && JSON.stringify(init).includes('memory-status') && JSON.stringify(init).includes('memory-profile'), 'Installed commands missing');
    pass(label); activePlan = undefined;
  }
  await hostRun(steps, 'actual installed Claude tool dispatch: owner/editor/reader/private, quote/author, isolation, errors and fixture cleanup', 'Run the isolated OAK memory host fixture. Use only the provided memory tools; do not expose credentials.');
  await hostRun([{ tool: 'listMemoryProfiles', verify: text => { const blocks = text.match(/\{[^{}]*\}/g) ?? []; assert.ok(blocks.some(block => new RegExp('\"?name\"?\\s*:\\s*\"?' + first.name + '(?:\"|\\s|,)').test(block) && /\"?active\"?\s*:\s*true/.test(block))); } }, contextStep(first)], 'new Claude process restores configured starting profile', 'Verify the starting memory profile in this new session.');
  await hostRun([{ tool: 'memoryConnectionStatus', verify: (text, block) => { expectOkay(text, block); assert.ok(/\"?verified\"?\s*:\s*true/.test(text)); const c = contextFrom(text); assert.equal(c.storeId, first.graphId); assert.equal(c.role, first.role); assert.equal(c.authorUserId, first.authorUserId); } }], 'installed memory-status slash command dispatch', '/oak-memory:memory-status');
  function checkPrivateFiles(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) checkPrivateFiles(file);
      else if (entry.isFile()) {
        const content = readFileSync(file);
        assert.ok(!fixture.profiles.some(profile => content.includes(profile.key)), 'Fixture key was persisted');
      }
    }
  }
  phase = 'isolated credential persistence scan'; checkPrivateFiles(temporary);
  pass('isolated configuration/cache/log scan contains no fixture graph keys');
  evidence.cleanStartWithoutDatabase = true; evidence.fixtureKeysPersisted = false;
  evidence.installScope = 'isolated user'; evidence.localConfigurationChanged = false;
  if (process.env.OAK_CLAUDE_EVIDENCE_FILE) writeFileSync(process.env.OAK_CLAUDE_EVIDENCE_FILE, JSON.stringify(evidence, null, 2) + '\n');
  pass('actual Claude host fixture completed; live model adherence and real user connectivity remain unverified');
} catch {
  console.error(`FAIL isolated Claude host fixture at ${phase}${activePlan?.lastTool ? ` / ${activePlan.lastTool}` : ''}. Raw host/model/backend diagnostics suppressed.`); process.exitCode = 1;
} finally {
  if (modelServer) { modelServer.closeAllConnections(); await new Promise(resolve => modelServer.close(resolve)); }
  if (temporary) { try { rmSync(temporary, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); } catch { console.error('Fixture directory cleanup pending; credentials were never written there.'); process.exitCode = 1; } }
}
