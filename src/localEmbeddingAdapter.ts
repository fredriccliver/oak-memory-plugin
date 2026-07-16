/**
 * Local embedding adapter — reuses the engine's OpenAIAdapter unmodified,
 * pointed at a local Ollama instance's OpenAI-compatible /v1/embeddings
 * endpoint (Ollama doesn't validate the apiKey, any non-empty string works).
 *
 * The DB schema hardcodes `embedding VECTOR(1536)` (matching OpenAI's
 * dimension), but local embedding models (e.g. nomic-embed-text) output
 * fewer dimensions (768). Zero-padding to 1536 is lossless for cosine
 * similarity: padding both vectors being compared with the same number of
 * zeros changes neither their dot product nor their norms, so similarity
 * rankings are identical to the unpadded 768-dim vectors — this is purely a
 * storage-format compatibility shim, not an approximation.
 *
 * generateMemory/validateConsistency are unused by this plugin (only
 * MemoryToolHandler + runRankedRetrieval are used, both of which only touch
 * generateEmbedding/generateQueryEmbedding) — delegated straight through to
 * the inner adapter, which itself throws "not yet implemented" for both,
 * matching upstream's own OpenAIAdapter behavior.
 */

import { OpenAIAdapter, type AIModelAdapter } from '@openaikits/memory';

const TARGET_DIMENSIONS = 1536;

function padTo(vector: number[], size: number): number[] {
  if (vector.length === size) return vector;
  if (vector.length > size) return vector.slice(0, size);
  return [...vector, ...new Array(size - vector.length).fill(0)];
}

export class LocalOllamaEmbeddingAdapter implements AIModelAdapter {
  private readonly inner: OpenAIAdapter;

  constructor(baseURL: string, embeddingModel: string) {
    this.inner = new OpenAIAdapter({
      apiKey: 'ollama-local-unused',
      baseURL,
      embeddingModel,
    });
  }

  async generateEmbedding(text: string): Promise<number[]> {
    return padTo(await this.inner.generateEmbedding(text), TARGET_DIMENSIONS);
  }

  async generateEmbeddings(texts: string[]): Promise<number[][]> {
    const embeddings = await this.inner.generateEmbeddings(texts);
    return embeddings.map(embedding => padTo(embedding, TARGET_DIMENSIONS));
  }

  generateMemory(
    ...args: Parameters<AIModelAdapter['generateMemory']>
  ): ReturnType<AIModelAdapter['generateMemory']> {
    return this.inner.generateMemory(...args);
  }

  validateConsistency(
    ...args: Parameters<AIModelAdapter['validateConsistency']>
  ): ReturnType<AIModelAdapter['validateConsistency']> {
    return this.inner.validateConsistency(...args);
  }
}
