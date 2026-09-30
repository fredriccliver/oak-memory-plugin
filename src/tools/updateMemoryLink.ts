import { z } from 'zod';
import type { Env } from '../env.js';
import { getMemoryClient } from '../memoryClient.js';
import { scopeRule, type MemoryPolicy } from '../policy.js';
import { formatMemory, textResult } from './format.js';

export const updateMemoryLinkInputSchema = {
  fromMemoryId: z.string().describe('Source memory UUID (from a recallMemory result).'),
  toMemoryId: z.string().describe('Target memory UUID (from a recallMemory result).'),
  action: z.enum(['add', 'remove']).describe('Whether to add or remove the link.'),
};

export function updateMemoryLinkDescription(policy: MemoryPolicy): string {
  const policyNote =
    policy.scope === null
      ? `\n\nAdding links is currently disabled and will fail because no write scope is configured.\n\n` +
        `**Why**: ${scopeRule(policy)}\n\nRemoving links remains available for cleanup.`
      : '';
  return `Add or remove a link between two memories.

**Purpose**: linking improves future recall — memories found via different queries or long chains may not
surface together otherwise. Linking increases the chance related memories are used together.

**When to use**:
- Two memories returned by recallMemory are clearly related and not yet linked (action: "add")
- A previously valid relationship between two memories no longer holds (action: "remove")

**Notes**:
- Use real UUIDs from recallMemory results, not labels.
- For a bidirectional link, call this twice (fromMemoryId<->toMemoryId).
- Only add links when the relation is clear; don't re-link already-linked pairs.${policyNote}`;
}

export function registerUpdateMemoryLink(server: any, env: Env) {
  server.registerTool(
    'updateMemoryLink',
    {
      title: 'Update memory link',
      description: updateMemoryLinkDescription(env.policy),
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
      if (env.policy.scope === null && action === 'add') {
        return textResult(
          `Refused: no memory policy is set, so there is no scope permitting new memory links.\n\n` +
            `Nothing was changed. Removing an existing link remains available for cleanup.`,
          true,
        );
      }
      const { toolHandler } = await getMemoryClient(env);
      const result = await toolHandler.handleUpdateMemoryLink({ fromMemoryId, toMemoryId, action });
      if (!result.success || !result.data) {
        return textResult(`Failed to update memory link: ${result.error ?? 'unknown error'}`, true);
      }
      return textResult(`Updated link (${action}).\n${formatMemory(result.data)}`);
    },
  );
}
