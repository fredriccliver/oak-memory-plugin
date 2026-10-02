/**
 * Entrypoint: MCP stdio server exposing @openaikits/memory to AI clients.
 *
 * IMPORTANT: stdio transport uses stdout for JSON-RPC framing. Never use
 * console.log anywhere in this process — all diagnostics go to console.error.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { resolveBackend } from './profiles.js';
import { startProfileBridge } from './bridge.js';
import { loadEnv } from './env.js';
import { registerAllTools } from './tools/register.js';
import { closeMemoryClient } from './memoryClient.js';
import { buildServerInstructions } from './policy.js';

async function main() {
  const selection = resolveBackend();
  if (selection) {
    await startProfileBridge(selection.config, selection.name);
    return;
  }
  const env = loadEnv();

  // `instructions` is the only channel that reaches the model without it having
  // to look at a tool first: the client injects it into the system prompt at
  // session start. That is what turns this from a set of tools the model might
  // notice into a policy it follows.
  const server = new McpServer(
    { name: 'oak-memory-plugin', version: '0.2.0' },
    { instructions: buildServerInstructions(env.policy) },
  );

  registerAllTools(server, env);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  const shutdown = async () => {
    await closeMemoryClient();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(error => {
  console.error('[oak-memory-plugin] Startup failed. Check backend/profile configuration and credentials.');
  process.exit(1);
});
