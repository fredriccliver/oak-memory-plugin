/**
 * Entrypoint: MCP stdio server exposing @openaikits/memory as Claude Code tools.
 *
 * IMPORTANT: stdio transport uses stdout for JSON-RPC framing. Never use
 * console.log anywhere in this process — all diagnostics go to console.error.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadEnv } from './env.js';
import { registerAllTools } from './tools/register.js';
import { closeMemoryClient } from './memoryClient.js';

async function main() {
  const env = loadEnv();

  const server = new McpServer({
    name: 'claude-memory-plugin',
    version: '0.1.0',
  });

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
  console.error('[claude-memory-plugin] Fatal error during startup:', error);
  process.exit(1);
});
