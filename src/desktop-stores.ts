import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { ProfileSession } from './bridge.js';
import { attributionInstructions, type Profiles } from './profiles.js';
import { loadPolicy } from './env.js';
import { buildServerInstructions } from './policy.js';

const text = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] });
const failure = () => ({ ...text({ error: 'Store request failed. Check configuration, key, membership and connectivity. No fallback was used.' }), isError: true });
const reads = new Set(['currentMemoryStore', 'listMemoryStores', 'listMemories', 'recallMemory', 'suggestMemoryLinks']);
const searches = new Set(['recallMemory', 'listMemories']);
const localNames = new Set(['listMemoryStores', 'currentMemoryStore', 'getMemoryPolicy', 'listMemoryProfiles', 'selectMemoryProfile', 'memoryConnectionStatus']);

// A fixed session per store prevents selection changes from rerouting a pending call.
export async function startDesktopStoresBridge(config: Profiles, allowChanges: boolean) {
  const entries = Object.entries(config.profiles).map(([name, profile]) => {
    if (profile.backend !== 'cloud') throw new Error('Desktop requires cloud stores');
    return { name, storeId: profile.graphId, session: new ProfileSession(config, name) };
  });
  type Entry = typeof entries[number];
  let active = entries.find(entry => entry.name === config.defaultProfile)!;
  let revision = 0;
  const verify = async (entry: Entry) => {
    const result = await entry.session.callTool('currentMemoryStore');
    if (result.isError || !Array.isArray(result.content)) throw new Error('Store unavailable');
    const store = JSON.parse(result.content.filter(item => item.type === 'text').map(item => item.text).join(''));
    if (store.storeId !== entry.storeId || !['owner', 'admin', 'editor', 'reader'].includes(store.role) || typeof store.authorUserId !== 'string') throw new Error('Store mismatch');
    return store;
  };
  const status = async (entry: Entry) => {
    try { return { profile: entry.name, storeId: entry.storeId, verified: true, store: await verify(entry) }; }
    catch { return { profile: entry.name, storeId: entry.storeId, verified: false, error: 'Check this store’s key, membership and connectivity. No fallback was used.' }; }
  };
  const route = async (entry: Entry, name: string, args: Record<string, unknown>) => {
    try {
      if (!reads.has(name) && !allowChanges) return { ...text({ error: 'This desktop extension is read-only. Enable Allow memory changes in its settings to permit changes.' }), isError: true };
      const store = await verify(entry);
      if (!reads.has(name) && !['owner', 'admin', 'editor'].includes(store.role)) return { ...text({ error: 'The selected store role does not permit memory changes.' }), isError: true };
      return await entry.session.callTool(name, { ...args, storeId: entry.storeId });
    } catch { return failure(); }
  };
  const server = new Server({ name: 'oak-desktop-cloud', version: '0.2.0' }, {
    capabilities: { tools: { listChanged: true } },
    instructions: `${buildServerInstructions(loadPolicy())}\n\n${attributionInstructions}\nMultiple cloud stores are configured. listMemoryStores shows configured stores and verified identities. recallMemory and listMemories search all configured stores unless storeId is supplied. Results retain their store attribution; do not mix people or projects across stores. All mutations require an explicit storeId and use only that store’s key. Selecting a profile affects status and single-store reads, not the default all-store search.${allowChanges ? '' : ' Memory changes are disabled in extension settings.'}`,
  });
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const discovered = await Promise.all(entries.map(async entry => {
      try {
        const listed = await entry.session.listTools();
        let writable = false;
        if (allowChanges) {
          try { writable = ['owner', 'admin', 'editor'].includes((await verify(entry)).role); } catch { /* Fail closed for this store. */ }
        }
        return listed.tools.filter(tool => !localNames.has(tool.name) && (reads.has(tool.name) || writable));
      } catch { return []; }
    }));
    const tools = new Map<string, Tool>();
    for (const tool of discovered.flat()) {
      const { outputSchema: _outputSchema, ...rest } = tool; // Search output is grouped by store.
      const required = (tool.inputSchema.required ?? []).filter(field => field !== 'storeId');
      if (!searches.has(tool.name)) required.push('storeId');
      tools.set(tool.name, { ...rest,
        description: `${tool.description ?? ''}\n${searches.has(tool.name) ? 'Omit storeId to search all configured stores; results are grouped and attributed by store.' : 'Provide the configured storeId. Only that store is contacted.'}`,
        inputSchema: { ...tool.inputSchema, properties: { ...tool.inputSchema.properties, storeId: { type: 'string', enum: entries.map(entry => entry.storeId), description: 'Target cloud store ID.' } }, required },
      });
    }
    const empty = { type: 'object' as const, properties: {}, additionalProperties: false };
    return { tools: [...tools.values(),
      { name: 'listMemoryStores', description: 'List only configured stores, verifying each store’s identity and role. Failed stores remain visible with verified:false; credentials are never returned.', inputSchema: empty },
      { name: 'listMemoryProfiles', description: 'List configured cloud profiles and store IDs without credentials.', inputSchema: empty },
      { name: 'memoryConnectionStatus', description: 'Verify every configured store and show the selected profile.', inputSchema: empty },
      { name: 'getMemoryPolicy', description: 'Read the desktop client memory policy and selected profile. Autosave stays off.', inputSchema: empty },
      { name: 'currentMemoryStore', description: 'Verify the specified store, or the selected profile when storeId is omitted.', inputSchema: { type: 'object', properties: { storeId: { type: 'string', enum: entries.map(entry => entry.storeId) } }, additionalProperties: false } },
      { name: 'selectMemoryProfile', description: 'Verify and select a profile for status and single-store reads in this session. Searches without storeId still search all configured stores; mutations require storeId.', inputSchema: { type: 'object', properties: { profile: { type: 'string', enum: entries.map(entry => entry.name) } }, required: ['profile'], additionalProperties: false } },
    ] };
  });
  server.setRequestHandler(CallToolRequestSchema, async request => {
    const name = request.params.name;
    const args = request.params.arguments ?? {};
    try {
      if (name === 'listMemoryProfiles') return text(entries.map(entry => ({ name: entry.name, backend: 'cloud', graphId: entry.storeId, active: entry === active })));
      if (name === 'listMemoryStores' || name === 'memoryConnectionStatus') {
        const stores = await Promise.all(entries.map(status));
        return { ...text({ profile: active.name, backend: 'cloud', stores, partialFailure: stores.some(store => !store.verified) }), ...(stores.every(store => !store.verified) ? { isError: true } : {}) };
      }
      if (name === 'getMemoryPolicy') return text({ policy: loadPolicy(() => {}), profile: active.name, backend: 'cloud', allowChanges });
      if (name === 'selectMemoryProfile') {
        const attempt = ++revision;
        const next = entries.find(entry => entry.name === args.profile);
        if (!next) return failure();
        const store = await verify(next);
        if (attempt !== revision) return failure();
        active = next;
        return text({ profile: next.name, backend: 'cloud', sessionOnly: true, store });
      }
      const supplied = Object.hasOwn(args, 'storeId');
      const target = supplied ? entries.find(entry => entry.storeId === args.storeId) : undefined;
      if (supplied && !target) return failure(); // Never broaden an invalid explicit target.
      if (name === 'currentMemoryStore') return text(await verify(target ?? active));
      if (searches.has(name)) {
        const stores = await Promise.all((target ? [target] : entries).map(async entry => {
          const result = await route(entry, name, args);
          return { storeId: entry.storeId, profile: entry.name, isError: result.isError === true, result };
        }));
        return { ...text({ stores, partialFailure: stores.some(store => store.isError) }), ...(stores.every(store => store.isError) ? { isError: true } : {}) };
      }
      if (!target) return { ...text({ error: 'An explicit configured storeId is required for this tool. No store was contacted.' }), isError: true };
      return await route(target, name, args);
    } catch { return failure(); }
  });
  await server.connect(new StdioServerTransport());
  return server;
}
