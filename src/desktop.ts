import { desktopConfig } from './desktop-config.js';

async function main() {
  const { config, allowChanges } = desktopConfig(process.env);
  // Explicit desktop consent, without inheriting autosave or local policies.
  process.env.MEMORY_POLICY_SCOPE = allowChanges ? 'important' : '';
  process.env.MEMORY_POLICY_AUTOSAVE = 'false';
  process.env.MEMORY_POLICY_RECALL = 'minimal';
  process.env.OAK_DESKTOP_ISOLATED = 'true';
  const { startProfileBridge } = await import('./bridge.js');
  await startProfileBridge(config, config.defaultProfile, { readOnly: !allowChanges, respectStoreRole: true, serverName: 'oak-desktop-cloud' });
}
main().catch(() => {
  console.error('[oak-desktop-cloud] Check Store ID and Personal key in the extension settings. No local store or fallback is used.');
  process.exitCode = 1;
});
