import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-env-fallback-'));
fs.mkdirSync(path.join(root, '.config', 'oak-memory'), { recursive: true });
fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
fs.writeFileSync(
  path.join(root, '.config', 'oak-memory', 'oak-memory.env'),
  'MEMORY_DATABASE_URL=postgresql://unused\n',
);
fs.writeFileSync(
  path.join(root, '.claude', 'oak-memory.env'),
  'MEMORY_POLICY_SCOPE=preferences\nMEMORY_POLICY_AUTOSAVE=false\nMEMORY_POLICY_RECALL=minimal\n',
);

const childEnv = { ...process.env, HOME: root };
for (const name of [
  'OAK_CONFIG_DIR',
  'CLAUDE_CONFIG_DIR',
  'PLUGIN_ROOT',
  'CLAUDE_PLUGIN_ROOT',
  'MEMORY_DATABASE_URL',
  'MEMORY_ENTITY_ID',
  'MEMORY_POLICY_SCOPE',
  'MEMORY_POLICY_AUTOSAVE',
  'MEMORY_POLICY_RECALL',
  'MEMORY_POLICY_FILE',
  'OLLAMA_BASE_URL',
  'OLLAMA_EMBEDDING_MODEL',
]) {
  delete childEnv[name];
}

const transport = new StdioClientTransport({
  command: 'node',
  args: [new URL('../dist/index.mjs', import.meta.url).pathname],
  env: childEnv,
  stderr: 'pipe',
});
const client = new Client({ name: 'oak-env-fallback-smoke', version: '1.0.0' });
try {
  await client.connect(transport);
  const result = await client.callTool({ name: 'getMemoryPolicy', arguments: {} });
  const text = result.content?.find((item) => item.type === 'text')?.text ?? '';
  for (const expected of [
    '**Scope**: preferences',
    '**Autosave**: off',
    '**Recall**: minimal',
    path.join(root, '.claude', 'oak-memory.env'),
  ]) {
    if (!text.includes(expected)) throw new Error(`Missing expected policy output: ${expected}\n${text}`);
  }
  console.log('shared database URL + legacy policy fallback: passed');
} finally {
  await client.close();
  fs.rmSync(root, { recursive: true, force: true });
}

const unconfiguredRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-env-unconfigured-'));
fs.mkdirSync(path.join(unconfiguredRoot, '.config', 'oak-memory'), { recursive: true });
fs.writeFileSync(
  path.join(unconfiguredRoot, '.config', 'oak-memory', 'oak-memory.env'),
  'MEMORY_DATABASE_URL=postgresql://unused\n',
);
const unconfiguredEnv = { ...childEnv, HOME: unconfiguredRoot };
const unconfiguredTransport = new StdioClientTransport({
  command: 'node',
  args: [new URL('../dist/index.mjs', import.meta.url).pathname],
  env: unconfiguredEnv,
  stderr: 'pipe',
});
const unconfiguredClient = new Client({ name: 'oak-unconfigured-write-smoke', version: '1.0.0' });
try {
  await unconfiguredClient.connect(unconfiguredTransport);
  const result = await unconfiguredClient.callTool({
    name: 'updateMemory',
    arguments: { memoryId: '00000000-0000-0000-0000-000000000000', content: 'must not write' },
  });
  const text = result.content?.find((item) => item.type === 'text')?.text ?? '';
  if (!result.isError || !text.includes('Nothing was changed')) {
    throw new Error(`Unconfigured updateMemory was not refused:\n${text}`);
  }
  console.log('unconfigured memory content update guard: passed');
} finally {
  await unconfiguredClient.close();
  fs.rmSync(unconfiguredRoot, { recursive: true, force: true });
}
