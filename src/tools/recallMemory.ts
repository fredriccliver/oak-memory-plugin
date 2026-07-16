import { z } from 'zod';
import type { Env } from '../env.js';
import { recall } from '../memoryClient.js';
import { recallRule, type MemoryPolicy } from '../policy.js';
import { formatMemory, textResult } from './format.js';

export const recallMemoryInputSchema = {
  query: z
    .string()
    .describe('Natural-language description of what to recall about the user.'),
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
use a display index.`;
}

export function registerRecallMemory(server: any, env: Env) {
  server.registerTool(
    'recallMemory',
    {
      title: 'Recall memory',
      description: recallMemoryDescription(env.policy),
      inputSchema: recallMemoryInputSchema,
    },
    async ({ query, limit }: { query: string; limit?: number }) => {
      const { memories } = await recall(env, query, limit);
      if (memories.length === 0) {
        return textResult('No memories found for this query.');
      }
      const lines = memories.map(formatMemory).join('\n');
      return textResult(`Found ${memories.length} memor${memories.length === 1 ? 'y' : 'ies'}:\n${lines}`);
    },
  );
}
