/**
 * Env loading and validation.
 *
 * Resolution order, first hit wins: process.env, then a plugin-root .env, then
 * a user-level file outside the plugin. The user-level file is the one that
 * matters for an installed plugin: both Claude Code and Codex install plugins
 * into replaceable caches, so config kept outside that tree survives updates.
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
import {
  DEFAULT_AUTOSAVE,
  DEFAULT_RECALL,
  MEMORY_SCOPES,
  RECALL_LEVELS,
  type MemoryPolicy,
  type MemoryScope,
  type RecallLevel,
  type UnconfiguredReason,
} from './policy.js';

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
    if (readEnvVar(key) === undefined) {
      process.env[key] = value;
    }
  }
}

function envFileSets(filePath: string, name: string): boolean {
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    return false;
  }

  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1 || line.slice(0, eq).trim() !== name) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    return value.length > 0 && !/^\$\{.*\}$/.test(value);
  }
  return false;
}

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot =
  process.env.PLUGIN_ROOT ?? process.env.CLAUDE_PLUGIN_ROOT ?? path.resolve(moduleDir, '..');
const sharedConfigDir =
  process.env.OAK_CONFIG_DIR ?? path.join(os.homedir(), '.config', 'oak-memory');
const sharedEnvFile = path.join(sharedConfigDir, 'oak-memory.env');
const legacyClaudeConfigDir =
  process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');
const legacyEnvFile = path.join(legacyClaudeConfigDir, 'oak-memory.env');

// Existing Claude-only installs keep working without migration. New installs
// use a client-neutral location shared by Claude Code and Codex. A stray empty
// shared file must not mask a complete legacy configuration.
const userEnvFile =
  process.env.OAK_CONFIG_DIR ||
  envFileSets(sharedEnvFile, 'MEMORY_DATABASE_URL') ||
  !envFileSets(legacyEnvFile, 'MEMORY_DATABASE_URL')
    ? sharedEnvFile
    : legacyEnvFile;
const fallbackUserEnvFile = process.env.OAK_CONFIG_DIR
  ? undefined
  : userEnvFile === sharedEnvFile
    ? legacyEnvFile
    : sharedEnvFile;

// A custom policy is prose, and prose wraps. It lives in its own file rather
// than an env var because the KEY=VALUE parser above is line-oriented and would
// silently truncate a multi-line rule at the first newline.
const defaultPolicyFile = path.join(path.dirname(userEnvFile), 'oak-memory-policy.md');
const fallbackPolicyFile = fallbackUserEnvFile
  ? path.join(path.dirname(fallbackUserEnvFile), 'oak-memory-policy.md')
  : undefined;

// loadEnvFile never overwrites an already-set var, so earlier calls win.
// "Already set" means readEnvVar-set: an unexpanded `${VAR}` from .mcp.json
// counts as unset, so these files can supply the value it failed to expand.
loadEnvFile(path.join(pluginRoot, '.env'));
loadEnvFile(userEnvFile);
// During migration, the selected file is authoritative but the other standard
// location may still contain policy values that have not moved yet. Fill only
// missing values from it; loadEnvFile never overwrites an earlier source.
if (fallbackUserEnvFile) loadEnvFile(fallbackUserEnvFile);

export interface Env {
  memoryDatabaseUrl: string;
  memoryEntityId: string;
  ollamaBaseUrl: string;
  ollamaEmbeddingModel: string;
  policy: MemoryPolicy;
  /** Resolved paths, reported by getMemoryPolicy so the user knows what to edit. */
  envFile: string;
  /** Legacy/shared compatibility source used only to fill missing values. */
  fallbackEnvFile?: string;
  policyFile: string;
}

/**
 * Some MCP clients' `${VAR}` substitution does not fall back to an
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

function resolvePolicyFile(): string {
  const explicit = readEnvVar('MEMORY_POLICY_FILE');
  if (explicit) return explicit;
  if (fallbackPolicyFile && !fs.existsSync(defaultPolicyFile) && fs.existsSync(fallbackPolicyFile)) {
    return fallbackPolicyFile;
  }
  return defaultPolicyFile;
}

function parseBool(value: string | undefined, fallback: boolean, warn: Warn): boolean {
  if (value === undefined) return fallback;
  const normalized = value.toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  warn(`[oak-memory-plugin] MEMORY_POLICY_AUTOSAVE="${value}" is not a boolean — using ${fallback}.`);
  return fallback;
}

/**
 * Where a misconfiguration gets reported. The server logs it once at startup,
 * where someone debugging a dead plugin will look; the Stop hook runs every
 * turn and stays silent, because the same warning repeated forever is noise
 * nobody reads and the server has already said it.
 */
type Warn = (message: string) => void;

/**
 * Never fatal, unlike a missing database URL — exiting would strand the user
 * with no tools and an explanation only in a log they will never open. The
 * server stays up, keeps serving the memories they already have, and refuses
 * to write until it knows what it is allowed to write.
 *
 * No path here falls back to a scope. Every way of arriving without one — never
 * set, misspelled, or a custom rule whose file went missing — resolves to
 * scope: null, which reads to the model as "store nothing, go ask them". The
 * temptation is to keep the plugin useful by assuming a scope, but the only
 * assumption broad enough to be useful is also the one that collects the most,
 * so an unanswered question would quietly resolve into the answer the user was
 * least likely to have given. Better visibly inert than silently maximal.
 *
 * Exported because the Stop hook has to reach the same verdict as the server:
 * it fires on turns the server never sees, and a hook that read the policy its
 * own way could prompt for a write the user configured off. One reader, one
 * answer.
 */
export function loadPolicy(warn: Warn = console.error): MemoryPolicy {
  const rawRecall = readEnvVar('MEMORY_POLICY_RECALL') ?? DEFAULT_RECALL;
  let recall = rawRecall as RecallLevel;
  if (!RECALL_LEVELS.includes(recall)) {
    warn(
      `[oak-memory-plugin] Unknown MEMORY_POLICY_RECALL "${rawRecall}" — using "${DEFAULT_RECALL}".\n` +
        `  Valid values: ${RECALL_LEVELS.join(', ')}`,
    );
    recall = DEFAULT_RECALL;
  }
  // Recall does get a default: reading back what the user already chose to store
  // costs them nothing but latency, so guessing wrong here is cheap in a way
  // guessing a scope is not.

  // autosave is forced off alongside a null scope rather than defaulted, so
  // anything that reads the flag without checking the scope still fails closed.
  const unconfigured = (reason: UnconfiguredReason): MemoryPolicy => ({
    scope: null,
    autosave: false,
    recall,
    reason,
  });

  const rawScope = readEnvVar('MEMORY_POLICY_SCOPE');
  if (rawScope === undefined) {
    warn(
      `[oak-memory-plugin] No MEMORY_POLICY_SCOPE set — storing nothing until there is one.\n` +
        `  Run the memory configuration workflow, or \`npm run setup -- --reconfigure\`,\n` +
        `  or set it in ${userEnvFile}. Valid values: ${MEMORY_SCOPES.join(', ')}`,
    );
    return unconfigured('unset');
  }

  const scope = rawScope as MemoryScope;
  if (!MEMORY_SCOPES.includes(scope)) {
    warn(
      `[oak-memory-plugin] Unknown MEMORY_POLICY_SCOPE "${rawScope}" — storing nothing until it is fixed.\n` +
        `  Valid values: ${MEMORY_SCOPES.join(', ')}`,
    );
    return unconfigured('invalid');
  }

  const autosave = parseBool(readEnvVar('MEMORY_POLICY_AUTOSAVE'), DEFAULT_AUTOSAVE, warn);

  if (scope !== 'custom') return { scope, autosave, recall };

  const policyFile = resolvePolicyFile();
  let customText = '';
  try {
    // The file's contents become the rule verbatim, so its own explanatory
    // header has to go — otherwise setup's instructions to the user get handed
    // to the model as if they were the user's policy.
    customText = fs
      .readFileSync(policyFile, 'utf8')
      .replace(/<!--[\s\S]*?-->/g, '')
      .trim();
  } catch {
    /* reported below */
  }
  if (!customText) {
    warn(
      `[oak-memory-plugin] MEMORY_POLICY_SCOPE=custom but ${policyFile} is missing or empty — ` +
        `storing nothing until it has a rule.\n` +
        `  Write your rule there, or re-run \`npm run setup -- --reconfigure\`.`,
    );
    return unconfigured('custom-missing');
  }
  return { scope, autosave, recall, customText };
}

export function loadEnv(): Env {
  return {
    memoryDatabaseUrl: required('MEMORY_DATABASE_URL'),
    memoryEntityId: readEnvVar('MEMORY_ENTITY_ID') ?? 'fredriccliver',
    ollamaBaseUrl: readEnvVar('OLLAMA_BASE_URL') ?? 'http://localhost:11434/v1',
    ollamaEmbeddingModel: readEnvVar('OLLAMA_EMBEDDING_MODEL') ?? 'bge-m3',
    policy: loadPolicy(),
    envFile: userEnvFile,
    fallbackEnvFile: fallbackUserEnvFile,
    policyFile: resolvePolicyFile(),
  };
}
