import type { Profiles } from './profiles.js';

const endpoint = 'https://www.openaikits.com/api/mcp';
const optional = (value?: string) => {
  const trimmed = value?.trim();
  return !trimmed || /^\$\{.*\}$/.test(trimmed) ? undefined : trimmed;
};

// Desktop configuration never consults existing local files or another profile.
export function desktopConfig(env: NodeJS.ProcessEnv): { config: Profiles; allowChanges: boolean; credentials: Record<string, string> } {
  const profiles: Profiles['profiles'] = Object.create(null);
  const credentials: Record<string, string> = {};
  const ids = new Set<string>();
  const add = (id: unknown, key: unknown, name: unknown) => {
    if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id.trim())) throw new Error('Invalid store ID');
    if (typeof key !== 'string' || !/^oak_[0-9a-f]{64}$/.test(key.trim())) throw new Error('Invalid personal key');
    if (typeof name !== 'string' || !name.trim() || name.length > 80 || /[\x00-\x1f]/.test(name)) throw new Error('Invalid store name');
    const graphId = id.trim().toLowerCase();
    if (ids.has(graphId) || Object.hasOwn(profiles, name.trim())) throw new Error('Duplicate store');
    ids.add(graphId);
    const credentialEnv = `OAK_DESKTOP_KEY_${ids.size}`;
    credentials[credentialEnv] = key.trim();
    profiles[name.trim()] = { backend: 'cloud', endpoint, graphId, credentialEnv };
  };
  const graphId = optional(env.OAK_DESKTOP_STORE_ID);
  const key = optional(env.OAK_DESKTOP_PERSONAL_KEY);
  if (graphId || key) add(graphId, key, 'desktop-cloud');
  const raw = optional(env.OAK_DESKTOP_STORES);
  if (raw) {
    let stores: unknown;
    try { stores = JSON.parse(raw); } catch { throw new Error('Invalid stores configuration'); }
    if (!Array.isArray(stores) || stores.length === 0 || stores.length > 20) throw new Error('Invalid stores configuration');
    for (const [index, store] of stores.entries()) {
      if (!store || typeof store !== 'object' || Array.isArray(store)) throw new Error('Invalid store configuration');
      add(store.storeId, store.personalKey, store.name ?? `desktop-cloud-${index + 1}`);
    }
  }
  const names = Object.keys(profiles);
  if (!names.length) throw new Error('Configure at least one store');
  // Only explicit true enables changes; missing/unexpanded values fail closed.
  return { allowChanges: optional(env.OAK_DESKTOP_ALLOW_CHANGES)?.toLowerCase() === 'true',
    config: { defaultProfile: names[0], profiles }, credentials };
}
