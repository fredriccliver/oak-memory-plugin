import { z } from 'zod';
import type { Env } from '../env.js';
import { getMemoryClient } from '../memoryClient.js';
import { textResult } from './format.js';

export const deleteMemoryInputSchema = {
  memoryId: z.string().describe('UUID of the memory to delete (from a recallMemory result).'),
};

export const deleteMemoryDescription = `Delete a memory. Irreversible — use sparingly.

**When to use**:
- The stored information is clearly wrong and there's nothing worth keeping
- The information is no longer needed at all

**Notes**: prefer updateMemory in almost every case. Only delete as a last resort.`;

export function registerDeleteMemory(server: any, env: Env) {
  server.registerTool(
    'deleteMemory',
    {
      title: 'Delete memory',
      description: deleteMemoryDescription,
      inputSchema: deleteMemoryInputSchema,
    },
    async ({ memoryId }: { memoryId: string }) => {
      const { toolHandler } = await getMemoryClient(env);
      const result = await toolHandler.handleDeleteMemory({ memoryId });
      if (!result.success) {
        return textResult(`Failed to delete memory: ${result.error ?? 'unknown error'}`, true);
      }
      return textResult(`Deleted memory ${memoryId}.`);
    },
  );
}
