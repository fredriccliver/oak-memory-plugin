import { createHash } from 'node:crypto';

export const DEFAULT_LIST_LIMIT = 20;
export const MAX_LIST_LIMIT = 100;
export const MAX_PAGE_BYTES = 32768;
type RecordWithId = { id: string; [key: string]: unknown };
export class ListPageError extends Error {}

/** Complete records, deterministic ordering, bounded payloads and a store-bound snapshot cursor. */
export function listPage(store: string, memories: RecordWithId[], edges: RecordWithId[], limit=DEFAULT_LIST_LIMIT, cursor?: string) {
 if (!Number.isInteger(limit) || limit<1 || limit>MAX_LIST_LIMIT) throw new ListPageError('limit must be an integer from 1 to 100.');
 const nodes=[...memories].sort((a,b)=>a.id.localeCompare(b.id));
 const links=[...edges].sort((a,b)=>a.id.localeCompare(b.id));
 const snapshot=createHash('sha256').update(JSON.stringify([nodes,links])).digest('hex');
 let memoryOffset=0,edgeOffset=0;
 if(cursor) {
  try {
   if(cursor.length>1000 || !/^[A-Za-z0-9_-]+$/.test(cursor))throw new Error();
   const c=JSON.parse(Buffer.from(cursor,'base64url').toString('utf8'));
   if(c.store!==store || c.snapshot!==snapshot || !Number.isSafeInteger(c.memoryOffset)||!Number.isSafeInteger(c.edgeOffset)||c.memoryOffset<0||c.edgeOffset<0||c.memoryOffset>nodes.length||c.edgeOffset>links.length)throw new Error();
   memoryOffset=c.memoryOffset;edgeOffset=c.edgeOffset;
  } catch { throw new ListPageError('Cursor is invalid for this store or the graph changed. Restart listing without cursor; do not claim a complete audit.'); }
 }
 const pageMemories:RecordWithId[]=[],pageEdges:RecordWithId[]=[];
 const fits=()=>Buffer.byteLength(JSON.stringify({memories:pageMemories,edges:pageEdges}),'utf8')<=MAX_PAGE_BYTES;
 while(memoryOffset<nodes.length && pageMemories.length<limit) {
  pageMemories.push(nodes[memoryOffset]);
  if(!fits()){pageMemories.pop();if(!pageMemories.length)throw new ListPageError('A memory exceeds the page byte limit. No record was truncated or skipped; use a targeted read.');break;}
  memoryOffset++;
 }
 while(edgeOffset<links.length && pageEdges.length<MAX_LIST_LIMIT) {
  pageEdges.push(links[edgeOffset]);if(!fits()){pageEdges.pop();break;}edgeOffset++;
 }
 if(!pageMemories.length&&!pageEdges.length&&(memoryOffset<nodes.length||edgeOffset<links.length))throw new ListPageError('An edge exceeds the page byte limit. No edge was truncated or skipped.');
 const hasMore=memoryOffset<nodes.length||edgeOffset<links.length;
 return {memories:pageMemories,edges:pageEdges,totalMemories:nodes.length,totalEdges:links.length,hasMore,
  nextCursor:hasMore?Buffer.from(JSON.stringify({store,snapshot,memoryOffset,edgeOffset})).toString('base64url'):null,
  snapshot,complete:!cursor&&!hasMore,
  guidance:hasMore?'Partial page. Continue with nextCursor in the same store; do not claim all memories or incident links have been read.':'End of this snapshot. A complete audit requires every preceding page.'};
}
