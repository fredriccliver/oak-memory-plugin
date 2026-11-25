import { z } from 'zod';
import { issueMemoryUseReceipt, MAX_MEMORY_HOPS, normalizeMemoryTuning, traverseMemory, type MemoryPath, type MemoryLinkChange } from '@openaikits/memory';
import type { Env } from '../env.js';
import { getMemoryClient, memoryUseScope, recordWorkMemoryUse } from '../memoryClient.js';
import { formatMemory, textResult } from './format.js';

export function pathDetails(env: Env, paths: MemoryPath[]) {
  return paths.map(path => ({...path,receipt:issueMemoryUseReceipt(memoryUseScope(env),path)}));
}

export function registerMemoryPathTools(server: any, env: Env) {
  server.registerTool('traverseMemory', {
    title: 'Explore memory connections',
    description: 'Follow links from an existing memory in this store without changing strength. Returns bounded paths.',
    inputSchema: {
      memoryId: z.string().uuid(),
      hops: z.number().int().min(1).max(MAX_MEMORY_HOPS).optional(),
      limit: z.number().int().min(1).max(50).optional(),
    },
  }, async ({memoryId,hops,limit}: {memoryId:string;hops?:number;limit?:number}) => {
    const { storage }=await getMemoryClient(env);
    const result=await traverseMemory(storage,env.memoryEntityId,memoryId,{hops,limit,decayLambda:normalizeMemoryTuning().decayLambda});
    const paths=pathDetails(env,result.paths);
    const details = {
      paths, truncated: result.truncated,
      memories: result.memories.map(({id,content})=>({id,content})),
      edges: result.edges.map(({id,fromId,toId,type,strength,origin})=>({id,fromId,toId,type,strength,origin})),
    };
    const text = result.memories.map(formatMemory).join('\n') || 'No connected memories found.';
    return {
      ...textResult(text + '\n' + JSON.stringify({paths, edges:details.edges, truncated:details.truncated})),
      structuredContent: details,
    };
  });
  server.registerTool('recordMemoryUse', {
    title: 'Record memories used in work',
    description: 'Submit once per task and store with receipts for memories actually used in an output. Exploring a path does not count. Optional linkChanges may apply a used shortcut or adjust an inspected, unused edge.',
    inputSchema: {
      workId: z.string().trim().min(1).max(160),
      uses: z.array(z.object({receipt:z.string().min(1).max(1600),output:z.string().trim().min(1).max(300)})).min(1).max(20),
      linkChanges: z.array(z.discriminatedUnion('action',[
        z.object({action:z.literal('shortcut'),receipt:z.string().min(1).max(1600)}),
        z.object({action:z.literal('weaken'),receipt:z.string().min(1).max(1600),edgeId:z.string().uuid(),strength:z.number().min(0).max(1)}),
        z.object({action:z.literal('unlink'),receipt:z.string().min(1).max(1600),edgeId:z.string().uuid()}),
      ])).max(8).optional(),
    },
  }, async ({workId,uses,linkChanges}: {workId:string;uses:{receipt:string;output:string}[];linkChanges?:MemoryLinkChange[]}) => {
    try {
      const result=await recordWorkMemoryUse(env,workId,uses,linkChanges);
      return {...textResult(result.alreadyRecorded ? 'This work was already recorded.' : 'Memory use recorded.'),structuredContent:result};
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (/receipt|memory use report|contributing multi-hop path|inspected, unused edge|A used path has changed/.test(message) &&
          !(error instanceof Error && 'code' in error))
        return {...textResult('The work report or its path receipt is stale or invalid. Inspect the same store before retrying.', true),structuredContent:{error:'invalid_memory_use'}};
      return {...textResult('The work report could not be confirmed. Check the same store before retrying.', true),structuredContent:{error:'memory_use_unconfirmed'}};
    }
  });
}
