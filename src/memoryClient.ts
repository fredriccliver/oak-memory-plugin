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

export async function closeMemoryClient(): Promise<void> {
  if (memoryInstance) {
    await memoryInstance.close();
  }
}
