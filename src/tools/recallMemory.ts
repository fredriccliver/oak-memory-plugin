import { MAX_MEMORY_HOPS } from '@openaikits/memory';
import { pathDetails } from './memoryPaths.js';
import { z } from 'zod';
import type { Env } from '../env.js';
import { recall } from '../memoryClient.js';
import { recallRule, type MemoryPolicy } from '../policy.js';
import { formatMemory, textResult } from './format.js';

export const recallMemoryInputSchema = {
  query: z
    .string()
    .describe('Natural-language description of what to recall about the user.'),
  topK: z.number().int().min(1).max(50).optional().describe('Number of vector starting points before graph expansion.'),
  hops: z.number().int().min(0).max(MAX_MEMORY_HOPS).optional().describe('Graph expansion depth. Zero searches vector starting points only.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe('Maximum number of memories to return (default 10, max 50).'),
};

/** Mirrors the server `instructions`; see createMemoryDescription for why. */
export function recallMemoryDescription(policy: MemoryPolicy): string {
  return `Search long-term memory for facts about the user relevant to a query.

**When to use** (the recall level this user chose at install time — "${policy.recall}"):
${recallRule(policy)}

Regardless of the level above, always call this before createMemory, to check whether a similar or
conflicting memory already exists — that check is about not writing duplicates, not about how eagerly
to search.

**Output**: ranked list of memories with their UUID, content, similarity/strength scores, and linked memory
UUIDs. Use these UUIDs directly with updateMemory / updateMemoryLink / deleteMemory — never invent a UUID or
use a display index.

Set topK for starting points, hops for connection depth (zero is vector-only), and limit for the number returned. Recall does not reinforce links. The result identifies how each memory was reached. If this store
exposes recordMemoryUse, use the returned receipt only for a memory actually applied to a concrete work output.`;
}

export function registerRecallMemory(server: any, env: Env) {
  server.registerTool(
    'recallMemory',
    {
      title: 'Recall memory',
      description: recallMemoryDescription(env.policy),
      inputSchema: recallMemoryInputSchema,
    },
    async ({ query, limit, topK, hops }: { query: string; limit?: number; topK?:number; hops?:number }) => {
      const ranked = await recall(env, query, limit, {topK,hops});
      const { memories }=ranked;
      if (memories.length === 0) {
        return { ...textResult('No memories found for this query.'), structuredContent: { memories: [], paths: [], truncated: false } };
      }
      const lines = memories.map(formatMemory).join('\n');
      const result = textResult(`Found ${memories.length} memor${memories.length === 1 ? 'y' : 'ies'}:\n${lines}`);
      const details={paths:pathDetails(env,ranked.paths??[]),truncated:ranked.truncated ?? false};
      return {...result,content:[...result.content,{type:'text',text:JSON.stringify(details)}],structuredContent:{...details,memories:memories.map(({id,content,outgoingEdges,similarity,strength})=>({id,content,outgoingEdges,similarity,strength}))}};
    },
  );
}
