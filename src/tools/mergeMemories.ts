import { z } from 'zod';
import type { Env } from '../env.js';
import { mergeMemories, mergeMemoriesSchema, type MergeMemoriesInput } from '../mergeMemories.js';
import { textResult } from './format.js';

export function registerMergeMemories(server: any, env: Env) {
  server.registerTool('mergeMemories', {
    title: 'Merge memories',
    description: `Merge duplicate memories atomically. Read full originals first. Supply targetMemoryId to retain, 1–15 distinct sourceMemoryIds, your complete merged content (up to 4,000 characters/4,096 tokens), and exactly one expectedContents snapshot per target/source UUID. The client judges and writes the text; preserve subjects, facts and quotations. Keeps target creation/retrieval metadata (strength, retrieval count and decay anchors); source statistics are archived, not combined. Choose the survivor accordingly. Keeps the target UUID and redirects incoming/outgoing typed links, retaining the strongest colliding link. Deletes absorbed source records. Local pre-merge records and links are archived in memory.merge_history; no restore tool is provided. If an original changed, reread before retrying. Requires a configured memory policy scope. Local merges use Ollama and have no cloud credit charge.`,
    inputSchema: mergeMemoriesSchema.innerType().shape,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, async (input: MergeMemoriesInput) => {
    if (env.policy.scope === null) return textResult('Refused: no memory policy scope is configured. Nothing was changed. Reconfigure memory, restart the AI client, then retry.', true);
    try { return textResult(JSON.stringify(await mergeMemories(env, input))); }
    catch (error) {
      const safe = ['Memory not found', 'Memory content changed; reread before merging', 'Embedding input limit exceeded', 'Invalid embedding vector'];
      const message = error instanceof z.ZodError ? 'Use distinct UUIDs and exactly one expected content per UUID.' : error instanceof Error && safe.includes(error.message) ? error.message : 'Merge failed; no partial merge was committed. Check local database and Ollama, then reread before retrying.';
      return textResult(message, true);
    }
  });
}
