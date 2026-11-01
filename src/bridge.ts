import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, ListResourcesRequestSchema, ReadResourceRequestSchema, ListResourceTemplatesRequestSchema, McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { fileURLToPath } from 'node:url';
import { attributionInstructions, credential, type Profile, type Profiles } from './profiles.js';
import { storeInstructions, recoveryInstructions } from './policy.js';

type Selection = Readonly<{ name: string; profile: Profile }>;
const text = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] });
const errorResult = () => ({ ...text({ error: 'Selected memory store request failed. Check authentication, graph membership, and connectivity. No fallback was used. If this was a mutation, its outcome is unverified: inspect this same store before any retry.' }), isError: true });
const cloudReadTools = new Set(['currentMemoryStore', 'listMemoryStores', 'listMemories', 'recallMemory', 'suggestMemoryLinks']);

function verifiedCloudStore(context: Awaited<ReturnType<Client['callTool']>>, profile: Extract<Profile, { backend: 'cloud' }>) {
  if (context.isError || !Array.isArray(context.content)) throw new Error('Context unavailable');
  const store = JSON.parse(context.content.filter(item => item?.type === 'text' && typeof item.text === 'string').map(item => item.text).join(''));
  if (store.storeId !== profile.graphId || !['owner', 'admin', 'editor', 'reader'].includes(store.role) || typeof store.authorUserId !== 'string') throw new Error('Context mismatch');
  return store;
}

export class ProfileSession {
  private selection: Selection;
  private policies=new Map<string,unknown>();
  async initializePolicy(snapshot=this.snapshot()) {
    if(this.policies.has(snapshot.name))return this.policies.get(snapshot.name);
    const result=await this.withClient(snapshot,client=>client.callTool({name:'getMemoryPolicy',arguments:snapshot.profile.backend==='cloud'?{storeId:snapshot.profile.graphId,initialize:true}:{}}));
    if(result.isError)throw new Error('Selected store policy unavailable');
    this.policies.set(snapshot.name,result);return result;
  }
  private switchRevision = 0;
  private toolLists = new Map<string, Awaited<ReturnType<Client['listTools']>>>();
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
    if (next.profile.backend === 'cloud') verifiedCloudStore(context, next.profile);
    if (revision !== this.switchRevision) throw new Error('Memory profile switch superseded by a newer request');
    const policy=await this.initializePolicy(next);
    if(revision!==this.switchRevision)throw new Error('Memory profile switch superseded by a newer request');
    this.selection = next;
    return { ...text({ profile: next.name, backend: next.profile.backend, sessionOnly: true,applyPolicyToSelectedStore:true }), context, policy };
  }
  async withClient<T>(snapshot: Selection, run: (client: Client) => Promise<T>): Promise<T> {
    const client = new Client({ name: 'oak-memory-profile-bridge', version: '0.3.0' });
    const profile = snapshot.profile;
    const transport = profile.backend === 'cloud'
      ? new StreamableHTTPClientTransport(new URL(profile.endpoint), {
          requestInit: { headers: { Authorization: `Bearer ${credential(profile)}`, 'X-Oak-Graph': profile.graphId } },
          // Credentials must never follow redirects to another origin.
          fetch: (url, init) => fetch(url, { ...init, redirect: 'error' }),
        })
      : new StdioClientTransport({
          command: process.execPath, args: [fileURLToPath(import.meta.url)],
          env: Object.fromEntries(Object.entries({ ...process.env, OAK_BACKEND: 'local', OAK_PROFILE: '', ...(profile.entityId?{MEMORY_ENTITY_ID:profile.entityId}:{}), ...(profile.policy?{MEMORY_POLICY_SCOPE:profile.policy.scope??'invalid',MEMORY_POLICY_AUTOSAVE:String(profile.policy.autosave),MEMORY_POLICY_RECALL:profile.policy.recall,MEMORY_POLICY_TEXT:profile.policy.customText??''}:{}) }).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
          stderr: 'ignore',
        });
    try { await client.connect(transport); return await run(client); }
    finally { await client.close().catch(() => {}); }
  }
  async listTools() {
    const snapshot = this.snapshot();
    try {
      const listed = await this.withClient(snapshot, async client => {
      const tools = [];
      let cursor: string | undefined;
      do { const page = await client.listTools(cursor ? { cursor } : undefined); tools.push(...page.tools); cursor = page.nextCursor; } while (cursor);
      return { tools: tools.filter(t => !['listMemoryProfiles', 'selectMemoryProfile', 'memoryConnectionStatus', ...[]].includes(t.name)) };
      });
      this.toolLists.set(snapshot.name, listed);
      return listed;
    } catch (error) {
      // Discovery cache grants no access: every call still authenticates anew.
      const previous = this.toolLists.get(snapshot.name);
      if (previous) return { ...previous, tools: previous.tools.map(tool => {
        // Keep safe discovery available during an outage, without advertising an unreadable UI.
        const meta = { ...tool._meta };
        for (const field of ['ui', 'ui/resourceUri', 'openai/outputTemplate', 'openai/widgetAccessible']) delete meta[field];
        return { ...tool, _meta: meta };
      }) };
      throw error;
    }
  }
  async listResources() {
    const snapshot = this.snapshot();
    if (snapshot.profile.backend !== 'cloud') return { resources: [] };
    return this.withClient(snapshot, async client => {
      const resources = [];
      let cursor: string | undefined;
      do {
        const page = await client.listResources(cursor ? { cursor } : undefined);
        resources.push(...page.resources.filter(resource => resource.uri.startsWith('ui://oak-memory/')));
        cursor = page.nextCursor;
      } while (cursor);
      return { resources };
    });
  }
  async readResource(uri: string) {
    const snapshot = this.snapshot();
    if (snapshot.profile.backend !== 'cloud' || !uri.startsWith('ui://oak-memory/')) {
      throw new McpError(ErrorCode.InvalidParams, 'Only OAK cloud UI resources are available.');
    }
    // Authenticate each resource read against the captured profile. No cache or fallback.
    return this.withClient(snapshot, client => client.readResource({ uri }));
  }
  async callTool(name: string, args: Record<string, unknown> = {}) {
    const snapshot = this.snapshot(); // capture before the first await
    if(snapshot.profile.backend==='cloud') {
      if(args.storeId!==undefined&&args.storeId!==snapshot.profile.graphId)return {...text({error:'Tool target differs from the selected profile store.'}),isError:true};
      args={...args,...(name==='listMemoryStores'?{}:{storeId:snapshot.profile.graphId})};
    }
    if(['createMemory','updateMemory','mergeMemories','deleteMemory','updateMemoryLink','adjustMemoryLinkStrength','updateMemoryPolicy'].includes(name))await this.initializePolicy(snapshot);
    const result=await this.withClient(snapshot,client=>client.callTool({name,arguments:args}));
    if(name==='getMemoryPolicy'&&!result.isError&&args.initialize===true)this.policies.set(snapshot.name,result);
    return result;
  }
}

export async function startProfileBridge(config: Profiles, name: string, options: { readOnly?: boolean; serverName?: string; respectStoreRole?: boolean } = {}) {
  const session = new ProfileSession(config, name);
  let initialPolicy:unknown;
  try{initialPolicy=await session.initializePolicy();}catch{initialPolicy={error:'Selected store policy unavailable. Authorized reads may continue; suspend all mutations until its policy loads successfully. Never substitute a default or local policy.'};}
  const server = new Server({ name: options.serverName ?? 'oak-memory-plugin', version: '0.3.0' }, {
    capabilities: { tools: { listChanged: true }, resources: { listChanged: true } },
    instructions: `${storeInstructions}\n${attributionInstructions}\nSelected store policy (apply only to its profile): ${JSON.stringify(initialPolicy)}\n${recoveryInstructions}${options.readOnly ? '\nThis connection permits reads only. Memory changes are disabled in the desktop extension settings.' : ''}`,
  });
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    try { return await session.listResources(); }
    catch (error) {
      if (error instanceof McpError && error.code === ErrorCode.MethodNotFound) return { resources: [] };
      throw new McpError(ErrorCode.InternalError, 'OAK UI discovery failed. Check the active cloud profile and connection.');
    }
  });
  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({ resourceTemplates: [] }));
  server.setRequestHandler(ReadResourceRequestSchema, async request => {
    if (session.snapshot().profile.backend !== 'cloud' || !request.params.uri.startsWith('ui://oak-memory/')) {
      throw new McpError(ErrorCode.InvalidParams, 'Only OAK cloud UI resources are available.');
    }
    try { return await session.readResource(request.params.uri); }
    catch { throw new McpError(ErrorCode.InternalError, 'OAK UI unavailable. Check the active cloud profile and connection.'); }
  });
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    let remote;
    try { remote = await session.listTools(); }
    catch { remote = { tools: [] }; } // Keep setup/status tools discoverable when cloud access fails.
    let canChange = !options.readOnly;
    const snapshot = session.snapshot();
    if (canChange && options.respectStoreRole && snapshot.profile.backend === 'cloud') {
      try {
        const context = await session.withClient(snapshot, client => client.callTool({ name: 'currentMemoryStore', arguments: {} }));
        canChange = ['owner', 'admin', 'editor'].includes(verifiedCloudStore(context, snapshot.profile).role);
      } catch { canChange = false; }
    }
    return { tools: [...remote.tools.filter(tool => canChange || cloudReadTools.has(tool.name)), {
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
            const store = verifiedCloudStore(context, snapshot.profile);
            return text({ profile: snapshot.name, backend: 'cloud', verified: true, store });
          }
          return text({ profile: snapshot.name, backend: 'local', verified: true, verificationScope: 'local configuration only; database connectivity is not checked', context });
        } catch {
          return { ...text({ profile: snapshot.name, backend: snapshot.profile.backend, verified: false, error: 'Check the profile configuration, personal graph key, membership, and connectivity, then reconnect. No fallback was used. If this was a mutation, its outcome is unverified: inspect this same store before any retry.' }), isError: true };
        }
      }
      if (request.params.name === 'listMemoryProfiles') return text(session.profiles());
      if (request.params.name === 'selectMemoryProfile') {
        const name = request.params.arguments?.profile;
        if (typeof name !== 'string') return errorResult();
        const selected = await session.select(name);
        await server.notification({ method: 'notifications/tools/list_changed' }).catch(() => {});
        await server.notification({ method: 'notifications/resources/list_changed' }).catch(() => {});
        return text(selected);
      }
      if (options.readOnly && !cloudReadTools.has(request.params.name)) {
        return { ...text({ error: 'This desktop extension is read-only. Enable Allow memory changes in its settings only after approving writes to this store.' }), isError: true };
      }
      if (options.respectStoreRole && !cloudReadTools.has(request.params.name)) {
        const snapshot = session.snapshot();
        if (snapshot.profile.backend !== 'cloud') return errorResult();
        const context = await session.withClient(snapshot, client => client.callTool({ name: 'currentMemoryStore', arguments: {} }));
        if (!['owner', 'admin', 'editor'].includes(verifiedCloudStore(context, snapshot.profile).role)) {
          return { ...text({ error: 'The selected store role does not permit memory changes.' }), isError: true };
        }
      }
      return await session.callTool(request.params.name, request.params.arguments);
    } catch { return errorResult(); }
  });
  await server.connect(new StdioServerTransport());
  return server;
}
