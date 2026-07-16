import { z } from 'zod';
import type { Env } from '../env.js';
import { getMemoryClient } from '../memoryClient.js';
import { formatMemory, textResult } from './format.js';

export const updateMemoryInputSchema = {
  memoryId: z
    .string()
    .describe('UUID of the memory to update (from a recallMemory result, not a table index).'),
  content: z
    .string()
    .describe('Updated memory content (natural language). Store the changed personal info.'),
};

export const updateMemoryDescription = `Update an existing memory.

**When to use**:
- recallMemory returned a memory whose info has since changed or was inaccurate
- The user corrects or updates something you already have stored about them

**Criteria**:
- Memory has "Lives in NYC", user says "I moved to Boston" → updateMemory, not createMemory
- Prefer update over delete-then-create; updating preserves existing links.

**Notes**: memoryId must be a real UUID from a recallMemory result.`;

export function registerUpdateMemory(server: any, env: Env) {
  server.registerTool(
    'updateMemory',
    {
      title: 'Update memory',
      description: updateMemoryDescription,
      inputSchema: updateMemoryInputSchema,
    },
    async ({ memoryId, content }: { memoryId: string; content: string }) => {
      const { toolHandler } = await getMemoryClient(env);
      const result = await toolHandler.handleUpdateMemory({ memoryId, content });
      if (!result.success || !result.data) {
        return textResult(`Failed to update memory: ${result.error ?? 'unknown error'}`, true);
      }
      return textResult(`Updated memory.\n${formatMemory(result.data)}`);
    },
  );
}
