// src/env.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// src/policy.ts
var MEMORY_SCOPES = ["preferences", "important", "everything", "custom"];
var RECALL_LEVELS = ["minimal", "balanced", "aggressive"];
var DEFAULT_AUTOSAVE = true;
var DEFAULT_RECALL = "balanced";
var RECALL_RULES = {
  minimal: 'Call `recallMemory` only when the user points at the past themselves \u2014 "remember when", "like I told you", "my usual setup" \u2014 or explicitly asks you to search memory. Otherwise do not go looking; answer from what is in front of you.',
  balanced: "Call `recallMemory` when the question plausibly depends on this user's preferences, past decisions, or personal context \u2014 especially before advising, recommending, or making a choice on their behalf. Skip it for self-contained or mechanical requests where nothing about them would change the answer.",
  aggressive: "Call `recallMemory` before every substantive answer, not just the ones that obviously depend on personal context \u2014 assume something relevant is stored until a search says otherwise. Prefer several narrow queries over one broad one. Never conclude you don't know something about this user without checking first: an empty result costs one call, a wrong assumption costs their trust."
};
function recallRule(policy) {
  return RECALL_RULES[policy.recall];
}
var SCOPE_RULES = {
  preferences: "Store ONLY the user's preferences: how they like to communicate, their workflow habits, and the tools, languages, and coding styles they favour or avoid. Do not store biographical facts, project details, or one-off decisions \u2014 however interesting they seem.",
  important: "Store the user's preferences, plus the durable facts that change how you should work with them: decisions they have committed to, constraints they operate under, and background that stays true across sessions. Skip trivia and anything that expires within days.",
  everything: "Store any durable personal fact about the user: preferences, experiences, opinions, background, and working context."
};
var UNCONFIGURED_RULES = {
  unset: "Nothing may be stored. This user has never chosen what you are allowed to remember about them, so there is no scope in force \u2014 and an unanswered question is not permission. Do not guess a scope on their behalf.",
  invalid: "Nothing may be stored. This user's configured scope is not a value this server recognises \u2014 likely a typo \u2014 so no scope is in force. Do not guess at what they meant.",
  "custom-missing": "Nothing may be stored. This user wrote their own scope rule, but the file holding it is missing or empty, so no scope is in force. Writing a custom rule is how someone narrows what you may keep \u2014 treating the lost rule as permission to keep more would invert their intent."
};
function scopeRule(policy) {
  if (policy.scope === null) return UNCONFIGURED_RULES[policy.reason ?? "unset"];
  if (policy.scope === "custom") return policy.customText;
  return SCOPE_RULES[policy.scope];
}
function buildTurnReminder(policy) {
  const duties = [];
  if (policy.recall !== "minimal") {
    duties.push(`### Search before you answer

${recallRule(policy)}`);
  }
  if (policy.scope !== null && policy.autosave) {
    duties.push(
      `### Keep what this turn reveals

${scopeRule(policy)}

Never store general knowledge or summaries of your own answers. In a shared graph, keep the authenticated author distinct from the semantic subject and preserve original quotes; never guess actors.

If something fits, call \`recallMemory\` first to catch an existing or conflicting version, then \`createMemory\` \u2014 or \`updateMemory\` on what you found, rather than storing a near-duplicate.`
    );
  }
  if (duties.length === 0) return null;
  return `<oak-memory-reminder>
Automatic reminder, injected on every prompt. The user did not write this, did not ask for it, and is
not waiting on an answer to it. You have persistent memory in the selected graph; these are the standing duties
their policy attaches to it.

${duties.join("\n\n")}

Fold this into the turn you were actually asked to do: no permission requests, no announcing the check,
no reporting that you found nothing. If none of it applies \u2014 the common case \u2014 ignore it entirely.
</oak-memory-reminder>`;
}

// src/env.ts
function loadEnvFile(filePath) {
  let content;
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch {
    return;
  }
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') || value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1);
    }
    if (readEnvVar(key) === void 0) {
      process.env[key] = value;
    }
  }
}
function envFileSets(filePath, name) {
  let content;
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch {
    return false;
  }
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1 || line.slice(0, eq).trim() !== name) continue;
    let value = line.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') || value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1);
    }
    return value.length > 0 && !/^\$\{.*\}$/.test(value);
  }
  return false;
}
var moduleDir = path.dirname(fileURLToPath(import.meta.url));
var pluginRoot = process.env.PLUGIN_ROOT ?? process.env.CLAUDE_PLUGIN_ROOT ?? path.resolve(moduleDir, "..");
var sharedConfigDir = process.env.OAK_CONFIG_DIR ?? path.join(os.homedir(), ".config", "oak-memory");
var sharedEnvFile = path.join(sharedConfigDir, "oak-memory.env");
var legacyClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
var legacyEnvFile = path.join(legacyClaudeConfigDir, "oak-memory.env");
var userEnvFile = process.env.OAK_CONFIG_DIR || envFileSets(sharedEnvFile, "MEMORY_DATABASE_URL") || !envFileSets(legacyEnvFile, "MEMORY_DATABASE_URL") ? sharedEnvFile : legacyEnvFile;
var fallbackUserEnvFile = process.env.OAK_CONFIG_DIR ? void 0 : userEnvFile === sharedEnvFile ? legacyEnvFile : sharedEnvFile;
var defaultPolicyFile = path.join(path.dirname(userEnvFile), "oak-memory-policy.md");
var fallbackPolicyFile = fallbackUserEnvFile ? path.join(path.dirname(fallbackUserEnvFile), "oak-memory-policy.md") : void 0;
loadEnvFile(path.join(pluginRoot, ".env"));
loadEnvFile(userEnvFile);
if (fallbackUserEnvFile) loadEnvFile(fallbackUserEnvFile);
function readEnvVar(name) {
  const value = process.env[name];
  if (value === void 0) return void 0;
  const trimmed = value.trim();
  if (trimmed.length === 0) return void 0;
  if (/^\$\{.*\}$/.test(trimmed)) return void 0;
  return trimmed;
}
function resolvePolicyFile() {
  const explicit = readEnvVar("MEMORY_POLICY_FILE");
  if (explicit) return explicit;
  if (fallbackPolicyFile && !fs.existsSync(defaultPolicyFile) && fs.existsSync(fallbackPolicyFile)) {
    return fallbackPolicyFile;
  }
  return defaultPolicyFile;
}
function parseBool(value, fallback, warn) {
  if (value === void 0) return fallback;
  const normalized = value.toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "off"].includes(normalized)) return false;
  warn(`[oak-memory-plugin] MEMORY_POLICY_AUTOSAVE="${value}" is not a boolean \u2014 using ${fallback}.`);
  return fallback;
}
function loadPolicy(warn = console.error) {
  const rawRecall = readEnvVar("MEMORY_POLICY_RECALL") ?? DEFAULT_RECALL;
  let recall = rawRecall;
  if (!RECALL_LEVELS.includes(recall)) {
    warn(
      `[oak-memory-plugin] Unknown MEMORY_POLICY_RECALL "${rawRecall}" \u2014 using "${DEFAULT_RECALL}".
  Valid values: ${RECALL_LEVELS.join(", ")}`
    );
    recall = DEFAULT_RECALL;
  }
  const unconfigured = (reason) => ({
    scope: null,
    autosave: false,
    recall,
    reason
  });
  const rawScope = readEnvVar("MEMORY_POLICY_SCOPE");
  if (rawScope === void 0) {
    warn(
      `[oak-memory-plugin] No MEMORY_POLICY_SCOPE set \u2014 storing nothing until there is one.
  Run the memory configuration workflow, or \`npm run setup -- --reconfigure\`,
  or set it in ${userEnvFile}. Valid values: ${MEMORY_SCOPES.join(", ")}`
    );
    return unconfigured("unset");
  }
  const scope = rawScope;
  if (!MEMORY_SCOPES.includes(scope)) {
    warn(
      `[oak-memory-plugin] Unknown MEMORY_POLICY_SCOPE "${rawScope}" \u2014 storing nothing until it is fixed.
  Valid values: ${MEMORY_SCOPES.join(", ")}`
    );
    return unconfigured("invalid");
  }
  const autosave = parseBool(readEnvVar("MEMORY_POLICY_AUTOSAVE"), DEFAULT_AUTOSAVE, warn);
  if (scope !== "custom") return { scope, autosave, recall };
  const policyFile = resolvePolicyFile();
  let customText = "";
  try {
    customText = fs.readFileSync(policyFile, "utf8").replace(/<!--[\s\S]*?-->/g, "").trim();
  } catch {
  }
  if (!customText) {
    warn(
      `[oak-memory-plugin] MEMORY_POLICY_SCOPE=custom but ${policyFile} is missing or empty \u2014 storing nothing until it has a rule.
  Write your rule there, or re-run \`npm run setup -- --reconfigure\`.`
    );
    return unconfigured("custom-missing");
  }
  return { scope, autosave, recall, customText };
}

// src/profiles.ts
var attributionInstructions = `Memories belong to the selected graph, which may be shared. Before using memories, show the active graph, role, and authenticated identity using currentMemoryStore. Authenticated author is provenance, not the semantic subject of a memory. Preserve original quotes verbatim; quoted "I" refers to its original speaker. Never guess actors or turn someone else's statement into the authenticated author's fact. After switching profiles, check context again. Never silently fall back to a local store.`;

// src/hook.ts
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}
async function main() {
  await readStdin();
  const policy = loadPolicy(() => {
  });
  const reminder = buildTurnReminder(policy);
  if (reminder === null) return;
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: `${reminder}

${attributionInstructions}`
      }
    })
  );
}
main().catch(() => {
});
