import { z } from 'zod';
import type { Env } from '../env.js';
import { getMemoryClient } from '../memoryClient.js';
import { formatMemory, textResult } from './format.js';

export const createMemoryInputSchema = {
  content: z
    .string()
    .describe(
      'Memory content (natural language). Store this entity\'s personal info, experience, view, or fact. ' +
        'Do not store general knowledge or summaries. E.g. "Prefers TDD and writes tests before implementation."',
    ),
  relatedMemoryIds: z
    .array(z.string())
    .optional()
    .describe(
      'Optional list of existing memory UUIDs (from a prior recallMemory call) to link to this new memory.',
    ),
};

export const createMemoryDescription = `Store a new memory about the user.

**What Memory stores**: the user's personal information, experiences, preferences, tone, and facts.
- Store: personal info, experiences, preferences, opinions, facts about this specific user
- Do not store: general knowledge, summaries of answers, external information

**When to use**:
- You learn the user's personal info, experience, or preference for the first time
- The user explicitly shares a fact about themselves
- You discover something about the user not already covered by recallMemory results

**Before calling this**: call recallMemory first if you haven't already checked whether this fact (or a
conflicting version of it) already exists — if it does, use updateMemory instead of creating a duplicate.

**Notes**:
- Use relatedMemoryIds to link to relevant existing memories surfaced by recallMemory.
- This is scoped to a single fixed user identity for this plugin installation — do not ask for or pass an
  entity/user id, it is configured server-side.`;

export function registerCreateMemory(server: any, env: Env) {
  server.registerTool(
    'createMemory',
    {
      title: 'Create memory',
      description: createMemoryDescription,
      inputSchema: createMemoryInputSchema,
    },
    async ({ content, relatedMemoryIds }: { content: string; relatedMemoryIds?: string[] }) => {
      const { toolHandler } = await getMemoryClient(env);
      const result = await toolHandler.handleCreateMemory({
        content,
        entityId: env.memoryEntityId,
        relatedMemoryIds,
      });
      if (!result.success || !result.data) {
        return textResult(`Failed to create memory: ${result.error ?? 'unknown error'}`, true);
      }
      return textResult(`Created memory.\n${formatMemory(result.data)}`);
    },
  );
}
