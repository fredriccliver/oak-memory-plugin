import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type Profile = { backend: 'local' } | {
  backend: 'cloud'; endpoint: string; graphId: string; credentialEnv: string;
};
export type Profiles = { defaultProfile: string; profiles: Record<string, Profile> };
export const attributionInstructions = `Memories belong to the selected graph, which may be shared. Before using memories, show the active graph, role, and authenticated identity using memoryConnectionStatus when available, otherwise cloud currentMemoryStore or local getMemoryPolicy. Authenticated author is provenance, not the semantic subject of a memory. Preserve original quotes verbatim; quoted "I" refers to its original speaker. Never guess actors or turn someone else's statement into the authenticated author's fact. After switching profiles, check context again. Never silently fall back to a local store.`;

// Claude optional userConfig values can be empty or unexpanded on older clients.
function optionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return !value || /^\$\{.*\}$/.test(value) ? undefined : value;
}

export function readProfiles(): Profiles | undefined {
  const file = optionalEnv('OAK_PROFILES_FILE') ?? optionalEnv('OAK_CONFIG_PROFILES_FILE') ?? path.join(process.env.OAK_CONFIG_DIR ?? path.join(os.homedir(), '.config', 'oak-memory'), 'profiles.json');
  if (!fs.existsSync(file)) {
    if (optionalEnv('OAK_PROFILE') || optionalEnv('OAK_CONFIG_DEFAULT_PROFILE') || optionalEnv('OAK_PROFILES_FILE') || optionalEnv('OAK_CONFIG_PROFILES_FILE')) throw new Error('Oak profiles file is missing');
    return undefined;
  }
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8')) as Profiles;
    if (!value.profiles || typeof value.defaultProfile !== 'string') throw new Error();
    for (const [name, profile] of Object.entries(value.profiles)) {
      if (!name || !profile || !['local', 'cloud'].includes(profile.backend)) throw new Error();
      if (profile.backend === 'cloud') {
        const url = new URL(profile.endpoint);
        if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) throw new Error();
        if (url.username || url.password || url.search || url.hash || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(profile.graphId) || !/^[A-Z_][A-Z0-9_]*$/.test(profile.credentialEnv)) throw new Error();
      }
    }
    if (!Object.hasOwn(value.profiles, value.defaultProfile)) throw new Error();
    return value;
  } catch { throw new Error('Invalid Oak profiles configuration'); }
}

export function resolveBackend(config?: Profiles): { name: string; profile: Profile; config: Profiles } | undefined {
  const backend = optionalEnv('OAK_BACKEND');
  if (backend && !['local', 'cloud'].includes(backend)) throw new Error('Unknown OAK_BACKEND');
  if (backend === 'local') return undefined;
  config ??= readProfiles();
  const name = optionalEnv('OAK_PROFILE') ?? optionalEnv('OAK_CONFIG_DEFAULT_PROFILE') ?? config?.defaultProfile;
  if (!name) {
    if (backend === 'cloud') throw new Error('Cloud mode requires an explicit configured profile');
    return undefined;
  }
  const profile = config?.profiles[name];
  if (!profile) throw new Error('Unknown Oak profile');
  if (backend && backend !== profile.backend) throw new Error('Oak backend/profile mismatch');
  return { name, profile: Object.freeze({ ...profile }), config: config! };
}

export function credential(profile: Profile): string {
  if (profile.backend !== 'cloud') throw new Error('Cloud credential requested for local profile');
  let key = optionalEnv(profile.credentialEnv);
  if (!key) {
    const raw = optionalEnv('OAK_CLOUD_CREDENTIALS') ?? optionalEnv('OAK_CONFIG_CLOUD_CREDENTIALS');
    if (raw) {
      try {
        const values = JSON.parse(raw);
        if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error();
        const selected = values[profile.credentialEnv];
        if (typeof selected === 'string') key = selected.trim();
      } catch { throw new Error('Invalid secure cloud credential configuration'); }
    }
  }
  if (!key || !/^oak_[0-9a-f]{64}$/.test(key)) throw new Error('Cloud profile needs a personal graph-bound key; use the approved credential handoff');
  return key;
}
