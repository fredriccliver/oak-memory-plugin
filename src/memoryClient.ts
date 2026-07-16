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
  if (memoryInstance) {
    await memoryInstance.close();
  }
}
