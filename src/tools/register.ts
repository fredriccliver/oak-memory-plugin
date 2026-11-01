import { getMemoryClient } from '../memoryClient.js';
import type { Env } from '../env.js';
import { registerCreateMemory } from './createMemory.js';
import { registerMergeMemories } from './mergeMemories.js';
import { registerUpdateMemory } from './updateMemory.js';
import { registerUpdateMemoryLink } from './updateMemoryLink.js';
import { registerAdjustMemoryLinkStrength } from './adjustMemoryLinkStrength.js';
import { registerDeleteMemory } from './deleteMemory.js';
import { registerRecallMemory } from './recallMemory.js';
import { registerListMemories } from './listMemories.js';
import { registerSuggestMemoryLinks } from './suggestMemoryLinks.js';
import { registerOpenMemoryGraph } from './openMemoryGraph.js';
import { registerGetMemoryPolicy } from './getMemoryPolicy.js';

export function registerAllTools(server: any, env: Env): void {
  const target=server;
  const writes=new Set(['createMemory','updateMemory','mergeMemories','updateMemoryLink','adjustMemoryLinkStrength','deleteMemory']);
  server={registerTool:(name:string,definition:any,handler:(input:any)=>Promise<any>)=>target.registerTool(name,definition,async(input:any)=>{
    if(writes.has(name)) {
      if(env.policy.scope===null)return {isError:true,content:[{type:'text',text:'This local store policy is unavailable. Nothing was changed; no mutation was attempted. Repair it before retrying.'}]};
      const ids=[input.memoryId,input.fromMemoryId,input.toMemoryId,input.targetMemoryId,...(input.sourceMemoryIds??[]),...(input.relatedMemoryIds??[])].filter(Boolean);
      if(ids.length){const {storage}=await getMemoryClient(env);for(const id of ids){const memory=await storage.getMemory(id);if(!memory||memory.entityId!==env.memoryEntityId)return {isError:true,content:[{type:'text',text:'Memory not found in the selected local store. No mutation was attempted.'}]};}}
    }
    return handler(input);
  })};
  registerRecallMemory(server, env);
  registerListMemories(server, env);
  registerSuggestMemoryLinks(server, env);
  registerOpenMemoryGraph(server, env);
  registerGetMemoryPolicy(server, env);
  registerCreateMemory(server, env);
  registerUpdateMemory(server, env);
  registerMergeMemories(server, env);
  registerUpdateMemoryLink(server, env);
  registerAdjustMemoryLinkStrength(server, env);
  registerDeleteMemory(server, env);
}
