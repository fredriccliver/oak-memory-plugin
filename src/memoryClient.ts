/**
 * Lazy singleton wrapper around @openaikits/memory.
 *
 * Initialization is deferred to the first tool call (not module load) so a
 * transient DB hiccup at process spawn doesn't kill the stdio server before
 * the MCP client even connects.
 */

import {
  Memory,
  StorageType,
  MemoryToolHandler,
  runRankedRetrieval,
  normalizeMemoryTuning,
  type MemoryStorage,
} from '@openaikits/memory';
// Aliased on import: the package root exports a *class* also named `Memory`
// (imported above), which would shadow this interface in the type namespace.
// Same collision `tools/format.ts` documents, resolved by renaming instead.
import type { Memory as MemoryNode, MemoryEdge } from '@openaikits/memory/types';
import {Pool} from 'pg';
import {readSqlPage} from './sqlListing.js';
import type { Env } from './env.js';
import { LocalOllamaEmbeddingAdapter } from './localEmbeddingAdapter.js';

let memoryInstance: Memory | undefined;
let initPromise: Promise<{ storage: MemoryStorage; toolHandler: MemoryToolHandler }> | undefined;

async function init(env: Env): Promise<{ storage: MemoryStorage; toolHandler: MemoryToolHandler }> {
  const memory = new Memory();
  await memory.initialize(
    {
      type: StorageType.POSTGRES,
      connectionString: env.memoryDatabaseUrl,
      schema: 'memory',
    },
    {
      aiAdapter: new LocalOllamaEmbeddingAdapter(env.ollamaBaseUrl, env.ollamaEmbeddingModel),
    },
  );
  memoryInstance = memory;
  const storage = memory.getStorage();
  const toolHandler = new MemoryToolHandler(storage);
  return { storage, toolHandler };
}

export function getMemoryClient(env: Env): Promise<{ storage: MemoryStorage; toolHandler: MemoryToolHandler }> {
  if (!initPromise) {
    initPromise = init(env).catch(error => {
      // Allow a retry on the next call instead of caching a permanent failure.
      initPromise = undefined;
      throw error;
    });
  }
  return initPromise;
}

const DEFAULT_RECALL_LIMIT = 10;
const MAX_RECALL_LIMIT = 50;

export async function recall(
  env: Env,
  query: string,
  limit: number = DEFAULT_RECALL_LIMIT,
) {
  const { storage } = await getMemoryClient(env);
  const tuning = normalizeMemoryTuning();
  const boundedLimit = Math.min(Math.max(1, limit), MAX_RECALL_LIMIT);
  return runRankedRetrieval(storage, env.memoryEntityId, query, tuning, boundedLimit);
}

/**
 * Every memory for the configured entity, plus every edge between them.
 *
 * Unlike `recall`, this is not a ranked/embedding search — it's a full dump for
 * visualization, so it deliberately skips the embedding round-trip to Ollama.
 * `getEdgesByEntity` is the authoritative edge source: a node's `outgoingEdges`
 * only carries the forward direction, so reading edges separately is what lets
 * the graph show reciprocal links as one undirected connection.
 */
export async function listAll(env: Env): Promise<{ memories: MemoryNode[]; edges: MemoryEdge[] }> {
  const { storage } = await getMemoryClient(env);
  const [memories, edges] = await Promise.all([
    storage.getMemoriesByEntity(env.memoryEntityId),
    storage.getEdgesByEntity(env.memoryEntityId),
  ]);
  return { memories, edges };
}

export async function closeMemoryClient(): Promise<void> {
  await listingPool?.end();listingPool=undefined;listingReady=undefined;
  if (memoryInstance) {
    await memoryInstance.close();
  }
}

let listingPool:Pool|undefined;
let listingReady:Promise<void>|undefined;
/** Existing local stores install the small revision tracker once; reads thereafter use keyset pages. */
export async function listMemoryPage(env:Env,limit?:number,cursor?:string) {
 await getMemoryClient(env);
 if(!listingPool){listingPool=new Pool({connectionString:env.memoryDatabaseUrl,max:1,idleTimeoutMillis:1000});listingPool.on('error',()=>console.error('[oak-memory] listing connection failed'));}
 if(!listingReady)listingReady=(async()=>{
  const ready=await listingPool!.query("select to_regclass('memory.listing_revisions') as tracker");
  if(!ready.rows[0].tracker) {
   const db=await listingPool!.connect();
   try{await db.query('begin');await db.query('select pg_advisory_xact_lock(7916501)');
    if(!(await db.query("select to_regclass('memory.listing_revisions') as tracker")).rows[0].tracker)await db.query("create index if not exists listing_memories_entity_id on memory.memories(entity_id,id);\ncreate index if not exists listing_edges_entity_id on memory.edges(entity_id,id);\n-- Cheap snapshot invalidation permits bounded DB keyset reads without loading every vector/body.\ncreate table if not exists memory.listing_revisions (\n entity_id text primary key,\n revision uuid not null default gen_random_uuid()\n);\ncreate or replace function memory.invalidate_listing() returns trigger language plpgsql security invoker set search_path='' as $$\nbegin\n if TG_OP <> 'INSERT' then\n  insert into memory.listing_revisions as r(entity_id) values(old.entity_id)\n   on conflict(entity_id) do update set revision=gen_random_uuid();\n end if;\n if TG_OP <> 'DELETE' and (TG_OP <> 'UPDATE' or new.entity_id is distinct from old.entity_id) then\n  insert into memory.listing_revisions as r(entity_id) values(new.entity_id)\n   on conflict(entity_id) do update set revision=gen_random_uuid();\n end if;\n return null;\nend $$;\ndrop trigger if exists invalidate_memory_listing on memory.memories;\ncreate trigger invalidate_memory_listing after insert or update or delete on memory.memories for each row execute function memory.invalidate_listing();\ndrop trigger if exists invalidate_edge_listing on memory.edges;\ncreate trigger invalidate_edge_listing after insert or update or delete on memory.edges for each row execute function memory.invalidate_listing();\ninsert into memory.listing_revisions(entity_id)\n select entity_id from memory.memories union select entity_id from memory.edges\n on conflict(entity_id) do nothing;\n\nalter table memory.listing_revisions enable row level security;\nrevoke all on memory.listing_revisions from public;\nrevoke all on function memory.invalidate_listing() from public;\n");
    await db.query('commit');
   }catch(error){await db.query('rollback');throw error;}finally{db.release();}
  }
 })().catch(error=>{listingReady=undefined;throw error;});
 await listingReady;
 return readSqlPage(listingPool,env.memoryEntityId,limit,cursor);
}
