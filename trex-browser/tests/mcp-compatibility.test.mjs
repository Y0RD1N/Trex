import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {MCP_VERSIONS,PROTOCOL,mcpInitialization} from '../worker/tools.mjs';

for(const version of MCP_VERSIONS)test('MCP negotiates '+version+' without changing the component doctor version',()=>{
  const result=mcpInitialization({protocolVersion:version});assert.equal(result.protocolVersion,version);assert.equal(PROTOCOL,'2025-11-25');assert.deepEqual(result.capabilities,{tools:{listChanged:false}});assert.match(result.instructions,/browser_navigate/);assert.match(result.instructions,/automatically/);
});
test('unknown MCP version returns the newest supported version; malformed requests reject',()=>{
  assert.equal(mcpInitialization({protocolVersion:'2099-01-01'}).protocolVersion,PROTOCOL);
  for(const protocolVersion of [undefined,null,0,'','x'.repeat(65)])assert.throws(()=>mcpInitialization({protocolVersion}),/protocolVersion/);
});
test('actual worker accepts the installed Codex MCP version and exposes navigation before any browser starts',{timeout:15000},async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'trex-browser-mcp-compat-')),home=path.join(root,'private-home');
  const child=spawn(process.execPath,[path.resolve('worker/worker.mjs'),'mcp','--cwd',root,'--mode','qa','--client','compatibility-test'],{env:{...process.env,TREX_BROWSER_HOME:home},windowsHide:true,stdio:['pipe','pipe','pipe']});
  let output='',error='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>error+=chunk);
  const timer=setTimeout(()=>child.kill(),10000);
  try{
    child.stdin.end([JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'codex-regression',version:'1'}}}),JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'}),JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/list',params:{}}),''].join('\n'));
    const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});assert.equal(code,0,error);
    const frames=output.trim().split('\n').map(line=>JSON.parse(line));assert.equal(frames.find(frame=>frame.id===1).result.protocolVersion,'2025-06-18');
    const tools=frames.find(frame=>frame.id===2).result.tools;for(const name of ['browser_navigate','browser_snapshot','browser_status'])assert.ok(tools.some(tool=>tool.name===name));
    await assert.rejects(fs.access(home));
  }finally{clearTimeout(timer);if(child.exitCode===null)child.kill();await fs.rm(root,{recursive:true,force:true});}
});
