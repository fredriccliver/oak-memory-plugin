import { desktopConfig } from './desktop-config.js';

async function main() {
  const { config, allowChanges, credentials } = desktopConfig(process.env);
  Object.assign(process.env, credentials);
  // Explicit desktop consent, without inheriting autosave or local policies.
  process.env.OAK_DESKTOP_ISOLATED = 'true';
  if (Object.keys(config.profiles).length > 1) {
    const { startDesktopStoresBridge } = await import('./desktop-stores.js');
    await startDesktopStoresBridge(config, allowChanges);
    return;
  }
  const { startProfileBridge } = await import('./bridge.js');
  await startProfileBridge(config, config.defaultProfile, { readOnly: !allowChanges, respectStoreRole: true, serverName: 'oak-desktop-cloud' });
}
main().catch(() => {
  console.error('[oak-desktop-cloud] Check Stores, Store ID and Personal key in the extension settings. No local store or fallback is used.');
  process.exitCode = 1;
});
