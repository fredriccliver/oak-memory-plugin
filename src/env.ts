/**
 * Env loading and validation.
 *
 * Resolution order, first hit wins: process.env, then a plugin-root .env, then
 * a user-level file outside the plugin. The user-level file is the one that
 * matters for an installed plugin: installing copies the plugin into
 * ~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/, so a .env sitting
 * in the source repo is both gitignored (may not be copied) and version-scoped
 * (wiped on the next update). Config kept outside that tree survives both.
 * The plugin-root .env remains the convenient path when running from a checkout.
 *
 * Fails fast to stderr — never stdout, which is the MCP stdio JSON-RPC channel.
 *
 * Deliberately not using the `dotenv` package here: esbuild bundling its CJS
 * internals (a conditional `require('fs')`) into ESM output produces a
 * "Dynamic require of fs is not supported" crash at runtime. Our actual need
 * (parse KEY=VALUE lines, don't override already-set process.env vars) is a
 * few lines — not worth carrying a dependency around a bundler incompatibility.
 */

import fs from 'node:fs';
import os from 'node:os';
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
const claudeConfigDir =
  process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');
const userEnvFile = path.join(claudeConfigDir, 'oak-memory.env');

// loadEnvFile never overwrites an already-set var, so earlier calls win.
loadEnvFile(path.join(pluginRoot, '.env'));
loadEnvFile(userEnvFile);

export interface Env {
  memoryDatabaseUrl: string;
  memoryEntityId: string;
  ollamaBaseUrl: string;
  ollamaEmbeddingModel: string;
}

/**
 * Claude Code's `.mcp.json` `${VAR}` substitution does not fall back to an
 * empty string when VAR is unset in the ambient environment — it passes the
 * literal, unexpanded `"${VAR}"` string through as the value instead. A plain
 * `?.trim() || default` fallback doesn't catch that (a non-empty garbage
 * string is still truthy), so treat anything matching this shape as unset too.
 */
function readEnvVar(name: string): string | undefined {
  const value = process.env[name];
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (/^\$\{.*\}$/.test(trimmed)) return undefined;
  return trimmed;
}

function required(name: string): string {
  const value = readEnvVar(name);
  if (!value) {
    console.error(
      `[oak-memory-plugin] Missing required env var: ${name}.\n` +
        `  Set it in ${userEnvFile} (recommended — survives plugin updates),\n` +
        `  or ${path.join(pluginRoot, '.env')}, or export it in your shell profile.`,
    );
    process.exit(1);
  }
  return value;
}

export function loadEnv(): Env {
  return {
    memoryDatabaseUrl: required('MEMORY_DATABASE_URL'),
    memoryEntityId: readEnvVar('MEMORY_ENTITY_ID') ?? 'fredriccliver',
    ollamaBaseUrl: readEnvVar('OLLAMA_BASE_URL') ?? 'http://localhost:11434/v1',
    ollamaEmbeddingModel: readEnvVar('OLLAMA_EMBEDDING_MODEL') ?? 'nomic-embed-text',
  };
}
