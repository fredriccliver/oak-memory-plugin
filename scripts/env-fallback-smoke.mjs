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

const transport = new StdioClientTransport({
  command: 'node',
  args: [new URL('../dist/index.mjs', import.meta.url).pathname],
  env: { ...process.env, HOME: root },
  stderr: 'pipe',
});
const client = new Client({ name: 'oak-env-fallback-smoke', version: '1.0.0' });
try {
  await client.connect(transport);
  const result = await client.callTool({ name: 'getMemoryPolicy', arguments: {} });
  const text = result.content?.find((item) => item.type === 'text')?.text ?? '';
  for (const expected of ['**Scope**: preferences', '**Autosave**: off', '**Recall**: minimal']) {
    if (!text.includes(expected)) throw new Error(`Missing expected policy output: ${expected}\n${text}`);
  }
  console.log('shared database URL + legacy policy fallback: passed');
} finally {
  await client.close();
  fs.rmSync(root, { recursive: true, force: true });
}
