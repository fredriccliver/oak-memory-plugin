import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
const temp = mkdtempSync(path.join(os.tmpdir(), 'oak-desktop-test-'));
const graph = '11111111-1111-4111-8111-111111111111', key = 'oak_' + 'a'.repeat(64);
let revoked = false, reader = false, admin = false, wrongStore = false, writes = 0, mutationRequests = 0;
const result = value => ({content:[{type:'text',text:JSON.stringify(value)}]});
const http = createServer(async (req,res) => {
  if (revoked || req.headers.authorization !== `Bearer ${key}` || req.headers['x-oak-graph'] !== graph) {res.writeHead(401).end();return;}
  const server = new McpServer({name:'fixture',version:'1'});
  server.registerTool('currentMemoryStore',{inputSchema:{}},async()=>result({storeId:wrongStore?'wrong':graph,name:'Fixture',role:reader?'reader':admin?'admin':'owner',authorUserId:'fixture-person'}));
  server.registerTool('listMemories',{inputSchema:{}},async()=>result({memories:[],graphId:graph}));
  for (const name of ['createMemory','updateMemoryPolicy','futureWriteTool']) server.registerTool(name,{inputSchema:{}},async()=>{ mutationRequests++; if(reader)return {...result({error:'Reader denied'}),isError:true}; writes++;return result({created:true});});
  const transport = new StreamableHTTPServerTransport({sessionIdGenerator:undefined});
  res.on('close',()=>{void transport.close();void server.close();});
  await server.connect(transport);await transport.handleRequest(req,res);
});
await new Promise(resolve=>http.listen(0,'127.0.0.1',resolve));
try {
  const output=path.join(temp,'bundle.mcpb');
  assert.equal(spawnSync(process.execPath,['scripts/package-desktop.mjs',output],{encoding:'utf8'}).status,0);
  assert.equal(spawnSync('unzip',['-q',output,'-d',temp]).status,0);
  const manifest=JSON.parse(readFileSync(path.join(temp,'manifest.json'),'utf8'));
  assert.equal(manifest.user_config.personal_key.sensitive,true);
  assert.equal(manifest.user_config.allow_changes.default,false);
  assert.equal(manifest.server.entry_point,'server/desktop.mjs');
  await build({entryPoints:['src/desktop-config.ts'],bundle:true,platform:'node',format:'esm',outfile:path.join(temp,'config.mjs')});
  const {desktopConfig}=await import(pathToFileURL(path.join(temp,'config.mjs')));
  for (const bad of [{},{OAK_DESKTOP_STORE_ID:graph},{OAK_DESKTOP_STORE_ID:'bad',OAK_DESKTOP_PERSONAL_KEY:key},{OAK_DESKTOP_STORE_ID:graph,OAK_DESKTOP_PERSONAL_KEY:'secret'}]) assert.throws(()=>desktopConfig(bad));
  for (const flag of ['', 'yes', '${user_config.allow_changes}', 'false']) assert.equal(desktopConfig({OAK_DESKTOP_STORE_ID:graph,OAK_DESKTOP_PERSONAL_KEY:key,OAK_DESKTOP_ALLOW_CHANGES:flag}).allowChanges,false);
  assert.equal(desktopConfig({OAK_DESKTOP_STORE_ID:graph,OAK_DESKTOP_PERSONAL_KEY:key,OAK_DESKTOP_ALLOW_CHANGES:' TRUE '}).allowChanges,true);
  assert.equal(desktopConfig({OAK_DESKTOP_STORE_ID:graph,OAK_DESKTOP_PERSONAL_KEY:key,OAK_BACKEND:'local'}).config.profiles['desktop-cloud'].backend,'cloud');
  const entry=path.join(temp,manifest.server.entry_point);
  writeFileSync(path.join(temp,'oak-memory.env'),`OAK_DESKTOP_STORE_ID=${graph}\nOAK_DESKTOP_PERSONAL_KEY=${key}\n`);
  const missing=spawnSync(process.execPath,[entry],{encoding:'utf8',timeout:3000,env:{PATH:process.env.PATH,HOME:temp,OAK_CONFIG_DIR:temp,PLUGIN_ROOT:temp}});
  assert.equal(missing.status,1);assert(!missing.stderr.includes(key));
  const original=readFileSync(entry,'utf8');
  assert(original.includes('https://www.openaikits.com/api/mcp'));
  // Only the extracted test copy points to loopback. Shipping code has no endpoint override.
  writeFileSync(entry,original.replaceAll('https://www.openaikits.com/api/mcp',`http://127.0.0.1:${http.address().port}/api/mcp`));
  for(const allow of [false,true]) {
    const client=new Client({name:'desktop-test',version:'1'});
    const env={PATH:process.env.PATH,HOME:temp,OAK_CONFIG_DIR:temp,PLUGIN_ROOT:temp,OAK_DESKTOP_STORE_ID:graph,OAK_DESKTOP_PERSONAL_KEY:key,OAK_DESKTOP_ALLOW_CHANGES:String(allow),MEMORY_DATABASE_URL:'postgres://must-not-be-used'};
    const transport=new StdioClientTransport({command:process.execPath,args:[entry],env,stderr:'pipe'});
    let stderr='';transport.stderr?.on('data',chunk=>stderr+=chunk);
    try {
      await client.connect(transport);
      const tools=(await client.listTools()).tools;
      assert(tools.some(t=>t.name==='listMemories'));
      assert.equal(tools.some(t=>t.name==='createMemory'),allow);
      admin=true;
      assert.equal((await client.callTool({name:'memoryConnectionStatus',arguments:{}})).isError,undefined);admin=false;
      assert.equal((await client.callTool({name:'memoryConnectionStatus',arguments:{}})).isError,undefined);
      assert.equal((await client.callTool({name:'listMemories',arguments:{}})).isError,undefined);
      for(const name of ['createMemory','updateMemoryPolicy','futureWriteTool']) {
        const count=writes;const response=await client.callTool({name,arguments:{}});
        assert.equal(!!response.isError,!allow);assert.equal(writes,count+(allow?1:0));
      }
      reader=true;
      assert(!(await client.listTools()).tools.some(t=>t.name==='createMemory'));
      const beforeReader=mutationRequests;
      assert.equal((await client.callTool({name:'createMemory',arguments:{}})).isError,true);assert.equal(mutationRequests,beforeReader);reader=false;
      wrongStore=true;
      assert.equal((await client.callTool({name:'memoryConnectionStatus',arguments:{}})).isError,true);
      const beforeMismatch=mutationRequests;assert.equal((await client.callTool({name:'createMemory',arguments:{}})).isError,true);assert.equal(mutationRequests,beforeMismatch);wrongStore=false;
      revoked=true;
      assert.equal((await client.callTool({name:'listMemories',arguments:{}})).isError,true);revoked=false;
      assert(!stderr.includes(key));
    } finally {await client.close();}
  }
  console.log('Desktop packaged stdio/cloud tests passed: reads, write opt-in, unknown mutation denial, reader denial, revocation, graph mismatch, no database fallback.');
} finally {await new Promise(resolve=>http.close(resolve));rmSync(temp,{recursive:true,force:true});}
