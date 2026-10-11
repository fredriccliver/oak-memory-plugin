import type { Profiles } from './profiles.js';

// Desktop configuration never consults existing local files or another profile.
export function desktopConfig(env: NodeJS.ProcessEnv): { config: Profiles; allowChanges: boolean } {
  const graphId = env.OAK_DESKTOP_STORE_ID?.trim();
  const key = env.OAK_DESKTOP_PERSONAL_KEY?.trim();
  if (!graphId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(graphId)) throw new Error('Invalid store ID');
  if (!key || !/^oak_[0-9a-f]{64}$/.test(key)) throw new Error('Invalid personal key');
  const flag = env.OAK_DESKTOP_ALLOW_CHANGES ?? 'false';
  if (!['true', 'false'].includes(flag)) throw new Error('Invalid change permission');
  return {
    allowChanges: flag === 'true',
    config: { defaultProfile: 'desktop-cloud', profiles: {
      'desktop-cloud': { backend: 'cloud', endpoint: 'https://www.openaikits.com/api/mcp', graphId, credentialEnv: 'OAK_DESKTOP_PERSONAL_KEY' },
    } },
  };
}
