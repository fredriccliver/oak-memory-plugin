import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
const dir=await mkdtemp(join(tmpdir(),'oak-proactive-policy-'));
try{
 for(const name of ['policy','listPage'])await build({entryPoints:['src/'+name+'.ts'],outfile:join(dir,name+'.mjs'),bundle:true,platform:'node',format:'esm'});
 const policy=await import(pathToFileURL(join(dir,'policy.mjs')));const {listPage,MAX_PAGE_BYTES}=await import(pathToFileURL(join(dir,'listPage.mjs')));
 const rendered=policy.buildServerInstructions({scope:policy.DEFAULT_SCOPE,autosave:policy.DEFAULT_AUTOSAVE,recall:policy.DEFAULT_RECALL});
 assert.match(rendered,/while reasoning or working/);assert.match(rendered,/no per-operation confirmation/);assert.match(rendered,/Local policy applies only to local stores/);
 const nodes=Array.from({length:205},(_,i)=>({id:String(i).padStart(4,'0'),content:'Fact '+i}));const edges=Array.from({length:250},(_,i)=>({id:String(i).padStart(4,'0'),fromId:'0000',toId:'0001'}));
 let page=listPage('A',nodes,edges),seen=page.memories.length,links=page.edges.length;
 assert.equal(page.memories.length,20);assert.throws(()=>listPage('B',nodes,edges,20,page.nextCursor),/invalid/);
 while(page.hasMore){page=listPage('A',nodes,edges,20,page.nextCursor);seen+=page.memories.length;links+=page.edges.length;}
 assert.equal(seen,205);assert.equal(links,250);assert.equal(listPage('A',[],edges).hasMore,true);assert.throws(()=>listPage('A',nodes,[],101),/100/);
 assert.throws(()=>listPage('A',[{id:'x',content:'x'.repeat(MAX_PAGE_BYTES+1)}],[]),/truncated/);
 console.log('PASS proactive policy, store-scoped cursor, bounded pages, edge-only pages and byte limits');
}finally{await rm(dir,{recursive:true,force:true});}
