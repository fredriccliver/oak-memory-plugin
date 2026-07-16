import { z } from 'zod';
import type { Env } from '../env.js';
import { recall } from '../memoryClient.js';
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

export const recallMemoryDescription = `Search long-term memory for facts about the user relevant to a query.

**Call this proactively** whenever the user references themselves, their past preferences, prior decisions,
or asks something that might depend on something you were told before in an earlier session — do not assume
you don't know something about this user without checking first.

**When to use**:
- Before answering a question that might depend on the user's personal context
- Before calling createMemory, to check whether a similar or conflicting memory already exists
- When the user says something like "remember when..." or "like I told you before..."

**Output**: ranked list of memories with their UUID, content, similarity/strength scores, and linked memory
UUIDs. Use these UUIDs directly with updateMemory / updateMemoryLink / deleteMemory — never invent a UUID or
use a display index.`;

export function registerRecallMemory(server: any, env: Env) {
  server.registerTool(
    'recallMemory',
    {
      title: 'Recall memory',
      description: recallMemoryDescription,
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
