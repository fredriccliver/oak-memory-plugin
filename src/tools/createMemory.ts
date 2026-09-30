import { z } from 'zod';
import type { Env } from '../env.js';
import { getMemoryClient } from '../memoryClient.js';
import { autosaveRule, scopeRule, type MemoryPolicy } from '../policy.js';
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

/**
 * Restates the policy the server `instructions` already carry. The duplication
 * is deliberate: the two reach the model over different channels, and a client
 * that drops either one still leaves this tool governed.
 */
export function createMemoryDescription(policy: MemoryPolicy): string {
  if (policy.scope === null) {
    return `Storing memories is currently disabled, and calling this tool will fail.

**Why**: ${scopeRule(policy)}

${autosaveRule(policy)}`;
  }
  return `Store a new memory about the user.

**What to store** (the policy this user chose themselves):
${scopeRule(policy)}

Never store general knowledge, summaries of your own answers, or external information.

**When to call this**: ${autosaveRule(policy)}

**Before calling this**: call recallMemory first if you haven't already checked whether this fact (or a
conflicting version of it) already exists — if it does, use updateMemory instead of creating a duplicate.

**Notes**:
- Use relatedMemoryIds to link to relevant existing memories surfaced by recallMemory.
- This is scoped to a single fixed user identity for this plugin installation — do not ask for or pass an
  entity/user id, it is configured server-side.`;
}

export function registerCreateMemory(server: any, env: Env) {
  server.registerTool(
    'createMemory',
    {
      title: 'Create memory',
      description: createMemoryDescription(env.policy),
      inputSchema: createMemoryInputSchema,
    },
    async ({ content, relatedMemoryIds }: { content: string; relatedMemoryIds?: string[] }) => {
      // The description and the server instructions both say this is refused,
      // but neither is binding: a client may drop `instructions`, and a model
      // may call the tool anyway. This is the only place the refusal actually
      // holds, so the check lives here rather than in the prose alone.
      if (env.policy.scope === null) {
        return textResult(
          `Refused: no memory policy is set, so there is no scope permitting this.\n\n` +
            `Nothing was stored. Tell the user what you were about to store, and that choosing a ` +
            `memory policy will let it through — their choice applies after ` +
            `restarting the AI client.`,
          true,
        );
      }
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
