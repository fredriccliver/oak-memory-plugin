import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { fileURLToPath } from 'node:url';
import { attributionInstructions, credential, type Profile, type Profiles } from './profiles.js';
import { loadPolicy } from './env.js';
import { buildServerInstructions } from './policy.js';

type Selection = Readonly<{ name: string; profile: Profile }>;
const text = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] });
const errorResult = () => ({ ...text({ error: 'Selected memory store request failed. Check authentication, graph membership, and connectivity. No fallback was used.' }), isError: true });

export class ProfileSession {
  private selection: Selection;
  private switchRevision = 0;
  constructor(private config: Profiles, name: string) {
    this.selection = this.resolve(name);
  }
  private resolve(name: string): Selection {
    const profile = this.config.profiles[name];
    if (!profile) throw new Error('Unknown memory profile');
    return Object.freeze({ name, profile: Object.freeze({ ...profile }) });
  }
  snapshot(): Selection { return this.selection; }
  profiles() { return Object.entries(this.config.profiles).map(([name, p]) => ({ name, backend: p.backend, graphId: p.backend === 'cloud' ? p.graphId : undefined, active: name === this.selection.name })); }
  async select(name: string) {
    // A newer attempt supersedes pending validations even when it fails. Keep
    // the last committed selection rather than letting an older attempt revive.
    const revision = ++this.switchRevision;
    const next = this.resolve(name);
    // Do not commit a switch until the server has verified this key and graph.
    const context = await this.withClient(next, client => client.callTool({ name: next.profile.backend === 'cloud' ? 'currentMemoryStore' : 'getMemoryPolicy', arguments: {} }));
    if (context.isError) throw new Error('Memory profile verification failed');
    if (revision !== this.switchRevision) throw new Error('Memory profile switch superseded by a newer request');
    this.selection = next;
    return { ...text({ profile: next.name, backend: next.profile.backend, sessionOnly: true }), context };
  }
  async withClient<T>(snapshot: Selection, run: (client: Client) => Promise<T>): Promise<T> {
    const client = new Client({ name: 'oak-memory-profile-bridge', version: '0.2.0' });
    const profile = snapshot.profile;
    const transport = profile.backend === 'cloud'
      ? new StreamableHTTPClientTransport(new URL(profile.endpoint), {
          requestInit: { headers: { Authorization: `Bearer ${credential(profile)}`, 'X-Oak-Graph': profile.graphId } },
          // Credentials must never follow redirects to another origin.
          fetch: (url, init) => fetch(url, { ...init, redirect: 'error' }),
        })
      : new StdioClientTransport({
          command: process.execPath, args: [fileURLToPath(import.meta.url)],
          env: Object.fromEntries(Object.entries({ ...process.env, OAK_BACKEND: 'local', OAK_PROFILE: '' }).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
          stderr: 'ignore',
        });
    try { await client.connect(transport); return await run(client); }
    finally { await client.close().catch(() => {}); }
  }
  async listTools() {
    const snapshot = this.snapshot();
    return this.withClient(snapshot, async client => {
      const tools = [];
      let cursor: string | undefined;
      do { const page = await client.listTools(cursor ? { cursor } : undefined); tools.push(...page.tools); cursor = page.nextCursor; } while (cursor);
      return { tools: tools.filter(t => !['listMemoryProfiles', 'selectMemoryProfile', 'memoryConnectionStatus', ...(snapshot.profile.backend === 'cloud' ? ['getMemoryPolicy'] : [])].includes(t.name)) };
    });
  }
  async callTool(name: string, args: Record<string, unknown> = {}) {
    const snapshot = this.snapshot(); // capture before the first await
    if (snapshot.profile.backend === 'cloud' && ['createMemory', 'updateMemory', 'deleteMemory', 'updateMemoryLink', 'adjustMemoryLinkStrength'].includes(name) && loadPolicy(() => {}).scope === null) {
      return { ...text({ error: 'Configure the client memory policy before storing memories.' }), isError: true };
    }
    return this.withClient(snapshot, client => client.callTool({ name, arguments: args }));
  }
}

export async function startProfileBridge(config: Profiles, name: string) {
  const session = new ProfileSession(config, name);
  const server = new Server({ name: 'oak-memory-plugin', version: '0.2.0' }, {
    capabilities: { tools: { listChanged: true } },
    instructions: `${buildServerInstructions(loadPolicy())}\n\n${attributionInstructions}`,
  });
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    let remote;
    try { remote = await session.listTools(); }
    catch { remote = { tools: [] }; } // Keep setup/status tools discoverable when cloud access fails.
    return { tools: [...remote.tools, ...(session.snapshot().profile.backend === 'cloud' ? [{
      name: 'getMemoryPolicy', description: 'Read the client-selected memory policy and active profile. Server access roles are obtained from currentMemoryStore.', inputSchema: { type: 'object' as const, properties: {} },
    }] : []), {
      name: 'memoryConnectionStatus', description: 'Verify and show the active profile, backend, server-authorized graph, role and recording identity. Returns safe setup errors without exposing credentials or changing stores.', inputSchema: { type: 'object', properties: {} },
    }, {
      name: 'listMemoryProfiles', description: 'List configured local/cloud profiles without revealing credentials.', inputSchema: { type: 'object', properties: {} },
    }, {
      name: 'selectMemoryProfile', description: 'Switch the active memory profile for this session. Cloud graph keys are graph-bound; use a separate profile per graph. Verify and show identity/role afterward. Stored defaults affect future sessions only.',
      inputSchema: { type: 'object', properties: { profile: { type: 'string' } }, required: ['profile'], additionalProperties: false },
    }] };
  });
  server.setRequestHandler(CallToolRequestSchema, async request => {
    try {
      if (request.params.name === 'memoryConnectionStatus') {
        const snapshot = session.snapshot();
        try {
          const context = await session.withClient(snapshot, client => client.callTool({ name: snapshot.profile.backend === 'cloud' ? 'currentMemoryStore' : 'getMemoryPolicy', arguments: {} }));
          if (context.isError) throw new Error('Context unavailable');
          if (snapshot.profile.backend === 'cloud') {
            if (!Array.isArray(context.content)) throw new Error('Context unavailable');
            const store = JSON.parse(context.content.filter(item => item?.type === 'text' && typeof item.text === 'string').map(item => item.text).join(''));
            if (store.storeId !== snapshot.profile.graphId || !['owner', 'editor', 'reader'].includes(store.role) || typeof store.authorUserId !== 'string') throw new Error('Context mismatch');
            return text({ profile: snapshot.name, backend: 'cloud', verified: true, store });
          }
          return text({ profile: snapshot.name, backend: 'local', verified: true, context });
        } catch {
          return { ...text({ profile: snapshot.name, backend: snapshot.profile.backend, verified: false, error: 'Check the profile configuration, personal graph key, membership, and connectivity, then reconnect. No fallback was used.' }), isError: true };
        }
      }
      if (request.params.name === 'getMemoryPolicy' && session.snapshot().profile.backend === 'cloud') {
        return text({ policy: loadPolicy(() => {}), profile: session.snapshot().name, backend: 'cloud' });
      }
      if (request.params.name === 'listMemoryProfiles') return text(session.profiles());
      if (request.params.name === 'selectMemoryProfile') {
        const name = request.params.arguments?.profile;
        if (typeof name !== 'string') return errorResult();
        const selected = await session.select(name);
        await server.notification({ method: 'notifications/tools/list_changed' }).catch(() => {});
        return text(selected);
      }
      return await session.callTool(request.params.name, request.params.arguments);
    } catch { return errorResult(); }
  });
  await server.connect(new StdioServerTransport());
  return server;
}
