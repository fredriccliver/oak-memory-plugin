import { z } from 'zod';
import type { Env } from '../env.js';
import { getMemoryClient } from '../memoryClient.js';
import { formatMemory, textResult } from './format.js';

export const updateMemoryLinkInputSchema = {
  fromMemoryId: z.string().describe('Source memory UUID (from a recallMemory result).'),
  toMemoryId: z.string().describe('Target memory UUID (from a recallMemory result).'),
  action: z.enum(['add', 'remove']).describe('Whether to add or remove the link.'),
};

export const updateMemoryLinkDescription = `Add or remove a link between two memories.

**Purpose**: linking improves future recall — memories found via different queries or long chains may not
surface together otherwise. Linking increases the chance related memories are used together.

**When to use**:
- Two memories returned by recallMemory are clearly related and not yet linked (action: "add")
- A previously valid relationship between two memories no longer holds (action: "remove")

**Notes**:
- Use real UUIDs from recallMemory results, not labels.
- For a bidirectional link, call this twice (fromMemoryId<->toMemoryId).
- Only add links when the relation is clear; don't re-link already-linked pairs.`;

export function registerUpdateMemoryLink(server: any, env: Env) {
  server.registerTool(
    'updateMemoryLink',
    {
      title: 'Update memory link',
      description: updateMemoryLinkDescription,
      inputSchema: updateMemoryLinkInputSchema,
    },
    async ({
      fromMemoryId,
      toMemoryId,
      action,
    }: {
      fromMemoryId: string;
      toMemoryId: string;
      action: 'add' | 'remove';
    }) => {
      const { toolHandler } = await getMemoryClient(env);
      const result = await toolHandler.handleUpdateMemoryLink({ fromMemoryId, toMemoryId, action });
      if (!result.success || !result.data) {
        return textResult(`Failed to update memory link: ${result.error ?? 'unknown error'}`, true);
      }
      return textResult(`Updated link (${action}).\n${formatMemory(result.data)}`);
    },
  );
}
