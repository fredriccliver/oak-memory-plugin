/**
 * Env loading and validation.
 *
 * Order: process.env first, then a plugin-root .env file as fallback (so a
 * user who installs this plugin without exporting shell vars still works).
 * Fails fast to stderr — never stdout, which is the MCP stdio JSON-RPC channel.
 *
 * Deliberately not using the `dotenv` package here: esbuild bundling its CJS
 * internals (a conditional `require('fs')`) into ESM output produces a
 * "Dynamic require of fs is not supported" crash at runtime. Our actual need
 * (parse KEY=VALUE lines, don't override already-set process.env vars) is a
 * few lines — not worth carrying a dependency around a bundler incompatibility.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function loadEnvFile(filePath: string): void {
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    return;
  }
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT ?? path.resolve(moduleDir, '..');
loadEnvFile(path.join(pluginRoot, '.env'));

export interface Env {
  memoryDatabaseUrl: string;
  memoryEntityId: string;
  ollamaBaseUrl: string;
  ollamaEmbeddingModel: string;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    console.error(
      `[claude-memory-plugin] Missing required env var: ${name}. ` +
        `Set it in your shell profile or in ${path.join(pluginRoot, '.env')}.`,
    );
    process.exit(1);
  }
  return value;
}

export function loadEnv(): Env {
  return {
    memoryDatabaseUrl: required('MEMORY_DATABASE_URL'),
    memoryEntityId: process.env.MEMORY_ENTITY_ID?.trim() || 'fredriccliver',
    ollamaBaseUrl: process.env.OLLAMA_BASE_URL?.trim() || 'http://localhost:11434/v1',
    ollamaEmbeddingModel: process.env.OLLAMA_EMBEDDING_MODEL?.trim() || 'nomic-embed-text',
  };
}
