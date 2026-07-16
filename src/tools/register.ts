import type { Env } from '../env.js';
import { registerCreateMemory } from './createMemory.js';
import { registerUpdateMemory } from './updateMemory.js';
import { registerUpdateMemoryLink } from './updateMemoryLink.js';
import { registerDeleteMemory } from './deleteMemory.js';
import { registerRecallMemory } from './recallMemory.js';
import { registerListMemories } from './listMemories.js';

export function registerAllTools(server: any, env: Env): void {
  registerRecallMemory(server, env);
  registerListMemories(server, env);
  registerCreateMemory(server, env);
  registerUpdateMemory(server, env);
  registerUpdateMemoryLink(server, env);
  registerDeleteMemory(server, env);
}
