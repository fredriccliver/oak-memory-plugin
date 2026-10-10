import { z } from 'zod';
import { Pool, type PoolClient } from 'pg';
import { Tiktoken } from 'js-tiktoken/lite';
import cl100k from 'js-tiktoken/ranks/cl100k_base';
import type { Env } from './env.js';
import { getMemoryClient } from './memoryClient.js';
import { LocalOllamaEmbeddingAdapter } from './localEmbeddingAdapter.js';

export const mergeMemoriesSchema = z.object({
  targetMemoryId: z.string().uuid().toLowerCase().describe('UUID to retain, including its recording author.'),
  sourceMemoryIds: z.array(z.string().uuid().toLowerCase()).min(1).max(15).describe('Other UUIDs to absorb and delete.'),
  content: z.string().trim().min(1).max(4000).describe('Complete merged text written by you. Preserve subjects, facts and quotations; the server does not summarize.'),
  expectedContents: z.array(z.object({ memoryId: z.string().uuid().toLowerCase(), content: z.string().max(16000) })).min(2).max(16)
    .describe('Exact content just read for target and every source. Concurrent content changes reject the entire merge; reread before retrying.'),
}).superRefine((input, context) => {
  const ids = [input.targetMemoryId, ...input.sourceMemoryIds];
  const expected = input.expectedContents.map(item => item.memoryId);
  if (new Set(ids).size !== ids.length || new Set(expected).size !== expected.length ||
      expected.length !== ids.length || ids.some(id => !expected.includes(id))) {
    context.addIssue({ code: 'custom', message: 'Use distinct target/source UUIDs and exactly one expected content per UUID.' });
  }
});
export type MergeMemoriesInput = z.infer<typeof mergeMemoriesSchema>;

/** Shared transaction body; callers own BEGIN/COMMIT and store authorization. */
export async function mergeMemoryRows(db: PoolClient, entityId: string, input: MergeMemoriesInput, embedding: number[]) {
  const ids = [input.targetMemoryId, ...input.sourceMemoryIds];
  const rows = await db.query('select id,content from memory.memories where entity_id=$1 and id=any($2::uuid[]) order by id for update', [entityId, ids]);
  if (rows.rowCount !== ids.length) throw new Error('Memory not found');
  const expected = new Map(input.expectedContents.map(item => [item.memoryId, item.content]));
  if (rows.rows.some(row => expected.get(row.id) !== row.content)) throw new Error('Memory content changed; reread before merging');
  // Keep every direction/type. Colliding edges retain the strongest stored signal
  // and its age (do not refresh decay simply because the endpoint was renamed).
  const affected = await db.query('select distinct from_id from memory.edges where entity_id=$1 and (from_id=any($2::uuid[]) or to_id=any($2::uuid[]))', [entityId, ids]);
  await db.query(`insert into memory.edges(entity_id,from_id,to_id,type,origin,strength,created_at,strength_updated_at)
    select distinct on (mapped_from,mapped_to,type) entity_id,mapped_from,mapped_to,type,origin,strength,created_at,strength_updated_at from (
      select e.*,case when from_id=any($3::uuid[]) then $2::uuid else from_id end as mapped_from,
        case when to_id=any($3::uuid[]) then $2::uuid else to_id end as mapped_to
      from memory.edges e where entity_id=$1 and (from_id=any($3::uuid[]) or to_id=any($3::uuid[]))
    ) mapped where mapped_from<>mapped_to
      and exists(select 1 from memory.memories where id=mapped_from and entity_id=$1)
      and exists(select 1 from memory.memories where id=mapped_to and entity_id=$1)
    order by mapped_from,mapped_to,type,strength desc,strength_updated_at desc
    on conflict(from_id,to_id,type) do update set
      origin=case when excluded.strength>memory.edges.strength then excluded.origin else memory.edges.origin end,
      strength_updated_at=case when excluded.strength>memory.edges.strength then excluded.strength_updated_at else memory.edges.strength_updated_at end,
      strength=greatest(memory.edges.strength,excluded.strength),created_at=least(memory.edges.created_at,excluded.created_at)
      where memory.edges.entity_id=excluded.entity_id`,
    [entityId, input.targetMemoryId, input.sourceMemoryIds]);
  await db.query('delete from memory.edges where entity_id=$1 and (from_id=any($2::uuid[]) or to_id=any($2::uuid[]))', [entityId, input.sourceMemoryIds]);
  await db.query('delete from memory.memories where entity_id=$1 and id=any($2::uuid[])', [entityId, input.sourceMemoryIds]);
  await db.query('update memory.memories set content=$1,embedding=$2::vector,updated_at=now() where entity_id=$3 and id=$4', [input.content, `[${embedding.join(',')}]`, entityId, input.targetMemoryId]);
  // Rebuild touched adjacency and remove any old source UUID, including legacy
  // adjacency that did not have a matching edge row. Foreign stores are untouched.
  await db.query(`update memory.memories m set outgoing_edges=array(
    select distinct e.to_id from memory.edges e join memory.memories n on n.id=e.to_id and n.entity_id=$1
    where e.entity_id=$1 and e.from_id=m.id and e.to_id<>m.id),updated_at=now()
    where m.entity_id=$1 and (m.id=any($2::uuid[]) or m.outgoing_edges && $3::uuid[])`,
    [entityId, [input.targetMemoryId, ...affected.rows.map(row => row.from_id)], input.sourceMemoryIds]);
}


const tokens = new Tiktoken(cl100k);
export async function mergeMemories(env: Env, raw: MergeMemoriesInput) {
  const input = mergeMemoriesSchema.parse(raw);
  if (env.policy.scope === null) throw new Error('Memory policy scope is not configured');
  if (tokens.encode(input.content, [], []).length > 4096) throw new Error('Embedding input limit exceeded');
  await getMemoryClient(env); // Prepare the same local engine schema as other tools.
  const pool = new Pool({ connectionString: env.memoryDatabaseUrl, max: 1 });
  const db = await pool.connect().catch(async error => { await pool.end(); throw error; });
  const ids = [input.targetMemoryId, ...input.sourceMemoryIds];
  const checkOriginals = async () => {
    const rows = await db.query('select id,content from memory.memories where entity_id=$1 and id=any($2::uuid[])', [env.memoryEntityId, ids]);
    if (rows.rowCount !== ids.length) throw new Error('Memory not found');
    if (rows.rows.some(row => !input.expectedContents.some(item => item.memoryId === row.id && item.content === row.content))) throw new Error('Memory content changed; reread before merging');
  };
  try {
    await checkOriginals(); // Reject stale/foreign records before Ollama.
    const embedding = await new LocalOllamaEmbeddingAdapter(env.ollamaBaseUrl, env.ollamaEmbeddingModel).generateEmbedding(input.content);
    if (embedding.length !== 1536 || embedding.some(value => !Number.isFinite(value))) throw new Error('Invalid embedding vector');
    await db.query('begin');
    await db.query('select pg_advisory_xact_lock(hashtext($1))', [`merge:${env.memoryEntityId}`]);
    await db.query('select id from memory.memories where entity_id=$1 and id=any($2::uuid[]) order by id for update', [env.memoryEntityId, ids]);
    await checkOriginals();
    // Local stores have no cloud provenance tables. Keep a complete pre-merge
    // snapshot, including source UUIDs/metadata and directed typed relationships.
    await db.query(`create table if not exists memory.merge_history (
      id bigint generated always as identity primary key, entity_id text not null,
      target_memory_id uuid not null, snapshot jsonb not null, created_at timestamptz not null default now())`);
    await db.query(`insert into memory.merge_history(entity_id,target_memory_id,snapshot)
      select $1,$2,jsonb_build_object('memories',(select jsonb_agg(to_jsonb(m)) from memory.memories m where entity_id=$1 and id=any($3::uuid[])),
        'edges',coalesce((select jsonb_agg(to_jsonb(e)) from memory.edges e where entity_id=$1 and (from_id=any($3::uuid[]) or to_id=any($3::uuid[]))),'[]'::jsonb))`, [env.memoryEntityId,input.targetMemoryId,ids]);
    await mergeMemoryRows(db, env.memoryEntityId, input, embedding);
    await db.query('commit');
    return { targetMemoryId: input.targetMemoryId, removedMemoryIds: input.sourceMemoryIds };
  } catch (error) { await db.query('rollback'); throw error; }
  finally { db.release(); await pool.end(); }
}
