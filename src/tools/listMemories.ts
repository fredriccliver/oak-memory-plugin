import type { Env } from '../env.js';
import { z } from 'zod';
import { listMemoryPage } from '../memoryClient.js';
import { ListPageError } from '../listPage.js';
import { listPageText } from '../sqlListing.js';
import { textResult } from './format.js';
export const listMemoriesDescription = "Browse memories and links in one store without ranking. Returns a bounded page (default 20 memories, maximum 100; links and response bytes are separately bounded), totals, hasMore and nextCursor. Continue with the same storeId and cursor until hasMore=false for a complete audit. Never infer an absent memory or link from one page. A changed graph invalidates the snapshot cursor: restart the audit. Use recallMemory for relevant context. Connection checks should use currentMemoryStore or memoryConnectionStatus without reading memory bodies.";
export const listMemoriesInputSchema={limit:z.number().int().min(1).max(100).optional().describe('Memories per page: default 20, maximum 100.'),cursor:z.string().max(1000).optional().describe('nextCursor from the previous page in this same store and unchanged snapshot.')};
export function registerListMemories(server:any,env:Env) {
 server.registerTool('listMemories',{title:'Browse memories',description:listMemoriesDescription,inputSchema:listMemoriesInputSchema},async({limit,cursor}:{limit?:number;cursor?:string})=>{
  try {
   const page=await listMemoryPage(env,limit,cursor);
   const text=listPageText(page);
   return {...textResult(text),structuredContent:page};
  }catch(error){if(error instanceof ListPageError)return textResult(error.message,true);throw error;}
 });
}
