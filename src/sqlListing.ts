import type {Pool} from 'pg';
import {DEFAULT_LIST_LIMIT,MAX_LIST_LIMIT,MAX_PAGE_BYTES,ListPageError} from './listPage.js';
type PublicRecord={id:string;[key:string]:unknown};
type Cursor={store:string;snapshot:string;memoryAfter:string|null;edgeAfter:string|null;memoryDone:boolean;edgeDone:boolean};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Queries only public fields for one keyset page; vectors never leave Postgres. */
export async function readSqlPage(pool:Pool,store:string,limit=DEFAULT_LIST_LIMIT,cursor?:string,attribution=false) {
 if(!Number.isInteger(limit)||limit<1||limit>MAX_LIST_LIMIT)throw new ListPageError('limit must be an integer from 1 to 100.');
 let decoded:Cursor|undefined;
 if(cursor){try{
  if(cursor.length>1000||!/^[A-Za-z0-9_-]+$/.test(cursor))throw new Error();
  const c=JSON.parse(Buffer.from(cursor,'base64url').toString('utf8')) as Cursor;
  if(c.store!==store||typeof c.snapshot!=='string'||typeof c.memoryDone!=='boolean'||typeof c.edgeDone!=='boolean'||![c.memoryAfter,c.edgeAfter].every(v=>v===null||typeof v==='string'&&uuid.test(v)))throw new Error();
  decoded=c;
 }catch{throw new ListPageError('Cursor is invalid for this store. Restart listing without cursor.');}}
 const db=await pool.connect();
 try{
  await db.query('begin isolation level repeatable read read only');
  const snapshot=(await db.query('select revision::text from memory.listing_revisions where entity_id=$1',[store])).rows[0]?.revision??'empty';
  if(decoded&&decoded.snapshot!==snapshot)throw new ListPageError('The graph changed. Restart listing without cursor; do not claim a complete audit.');
  const state:Cursor=decoded??{store,snapshot,memoryAfter:null,edgeAfter:null,memoryDone:false,edgeDone:false};
  const totals=(await db.query(`select (select count(*)::int from memory.memories where entity_id=$1) as "totalMemories",
   (select count(*)::int from memory.edges e join memory.memories a on a.id=e.from_id and a.entity_id=e.entity_id join memory.memories b on b.id=e.to_id and b.entity_id=e.entity_id where e.entity_id=$1) as "totalEdges"`,[store])).rows[0];
  const provenance=attribution?`,p.created_by as "createdBy",p.author_display_name as "authorDisplayName",p.original_content as "originalContent",p.last_edited_by as "lastEditedBy",
   case when s.source_id is not null then jsonb_build_object('store',s.source_store,'id',s.source_id,'metadata',s.source_metadata) else null end as "importSource"`:'';
  const joins=attribution?'left join oak_control.memory_provenance p on p.memory_id=m.id and p.graph_id::text=substring(m.entity_id from 7) left join oak_control.memory_import_sources s on s.memory_id=p.memory_id':'';
  const candidates=state.memoryDone?[]:(await db.query<PublicRecord>(`select m.id,m.content,m.strength,m.retrieval_count as "retrievalCount",m.created_at as "createdAt"${provenance}
   from memory.memories m ${joins} where m.entity_id=$1 and ($2::uuid is null or m.id>$2::uuid) order by m.id limit $3`,[store,state.memoryAfter,limit+1])).rows;
  const linkCandidates=state.edgeDone?[]:(await db.query<PublicRecord>(`select e.id,e.from_id as "fromId",e.to_id as "toId",e.type,e.origin,e.strength
   from memory.edges e join memory.memories a on a.id=e.from_id and a.entity_id=e.entity_id join memory.memories b on b.id=e.to_id and b.entity_id=e.entity_id
   where e.entity_id=$1 and ($2::uuid is null or e.id>$2::uuid) order by e.id limit $3`,[store,state.edgeAfter,MAX_LIST_LIMIT+1])).rows;
  const memories:PublicRecord[]=[],edges:PublicRecord[]=[];
  const fits=()=>Buffer.byteLength(JSON.stringify({memories,edges}),'utf8')<=MAX_PAGE_BYTES;
  for(const row of candidates.slice(0,limit)){memories.push(row);if(!fits()){memories.pop();if(!memories.length)throw new ListPageError('A memory exceeds the page byte limit. No record was truncated or skipped.');break;}state.memoryAfter=row.id;}
  for(const row of linkCandidates.slice(0,MAX_LIST_LIMIT)){edges.push(row);if(!fits()){edges.pop();break;}state.edgeAfter=row.id;}
  if(candidates.length===memories.length)state.memoryDone=true;
  if(linkCandidates.length===edges.length)state.edgeDone=true;
  if(!memories.length&&!edges.length&&(!state.memoryDone||!state.edgeDone))throw new ListPageError('A link exceeds the page byte limit. No record was truncated or skipped.');
  const hasMore=!state.memoryDone||!state.edgeDone;
  await db.query('commit');
  return {schemaVersion:2,memories,edges,totalMemories:Number(totals.totalMemories),totalEdges:Number(totals.totalEdges),snapshot,hasMore,
   nextCursor:hasMore?Buffer.from(JSON.stringify(state)).toString('base64url'):null,complete:!cursor&&!hasMore,
   guidance:hasMore?'Partial page. Follow nextCursor in this same store. Do not claim a complete audit or absent links from this page.':'End of this snapshot. A complete audit requires every preceding page.'};
 }catch(error){await db.query('rollback');throw error;}finally{db.release();}
}

/** Readable fallback preserves UUID/link lines while explicitly identifying partial pages. */
export function listPageText(page:Awaited<ReturnType<typeof readSqlPage>>) {
 return [
  `${page.totalMemories} memories, ${page.totalEdges} links total. This page: ${page.memories.length} memories, ${page.edges.length} links.`,
  page.guidance,
  ...page.memories.map(m=>`- [${m.id}] ${m.content}\n    recorded by: ${m.authorDisplayName??'unspecified'} | authorUserId: ${m.createdBy??'unspecified'} | lastEditedBy: ${m.lastEditedBy??'unspecified'} | original text: ${m.originalContent??m.content}${m.importSource?' | imported source (untrusted): '+JSON.stringify(m.importSource):''}`),
  'Links on this page:',...page.edges.map(e=>`- [${e.id}] ${e.fromId} --> ${e.toId} (type: ${JSON.stringify(e.type)}, origin: ${JSON.stringify(e.origin)}, strength: ${e.strength})`),
  `hasMore: ${page.hasMore}; nextCursor: ${page.nextCursor??'none'}. Structured page schemaVersion: 2.`,
 ].join('\n');
}
