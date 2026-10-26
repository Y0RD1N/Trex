import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
import {promisify} from 'node:util';
import {test} from 'node:test';
const run=promisify(execFile),codex=process.env.TREX_BROWSER_TEST_CODEX,native=process.env.TREX_BROWSER_TEST_NATIVE;

// Exercises the actual Codex -> MCP -> native launcher -> broker -> Chrome
// chain. No turn/start, authentication, model or provider requests are made.
test('actual Codex discovers and opens Trex Browser autonomously without a model turn',{
  skip:process.platform!=='win32'||!codex||!native,timeout:90000,
},async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'trex-codex-mcp-')),workspace=path.join(root,'workspace'),home=path.join(root,'private-browser'),codexHome=path.join(root,'codex-home');
  await fs.mkdir(workspace);await fs.mkdir(codexHome);
  const env=Object.fromEntries(Object.entries(process.env).filter(([name])=>['SYSTEMROOT','WINDIR','USERPROFILE','APPDATA','LOCALAPPDATA','TEMP','TMP','PATH'].includes(name.toUpperCase())));
  Object.assign(env,{CODEX_HOME:codexHome,TREX_BROWSER_HOME:home,HTTP_PROXY:'http://127.0.0.1:9',HTTPS_PROXY:'http://127.0.0.1:9',ALL_PROXY:'http://127.0.0.1:9',NO_PROXY:'127.0.0.1,localhost'});
  if(process.env.TREX_BROWSER_TEST_VISIBLE!=='1')env.TREX_BROWSER_HEADLESS='1';
  const server=http.createServer((_req,res)=>{res.writeHead(200,{'content-type':'text/html'});res.end('<!doctype html><title>Trex autonomous browser test</title><button onclick="this.textContent=\'Verified click\'">Test automatic opening</button>');});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const child=spawn(codex,['app-server'],{env,cwd:workspace,windowsHide:true,stdio:['pipe','pipe','pipe']});
  const pending=new Map();let sequence=0,buffer='',timer;const methods=[];
  child.stderr.resume();child.on('error',error=>{for(const entry of pending.values())entry.reject(error);});
  child.stdout.on('data',chunk=>{
    buffer+=chunk;
    if(Buffer.byteLength(buffer)>12*1024*1024){for(const entry of pending.values())entry.reject(new Error('Unexpectedly large Codex diagnostic frame'));return;}
    for(;;){const end=buffer.indexOf('\n');if(end<0)break;const line=JSON.parse(buffer.slice(0,end));buffer=buffer.slice(end+1);const entry=pending.get(line.id);if(!entry||line.method)continue;pending.delete(line.id);line.error?entry.reject(new Error(line.error.message)):entry.resolve(line.result);}
  });
  const rpc=(method,params)=>new Promise((resolve,reject)=>{
    const id=++sequence;methods.push(method);const timeout=setTimeout(()=>{pending.delete(id);reject(new Error('Timed out: '+method));},30000);
    pending.set(id,{resolve:value=>{clearTimeout(timeout);resolve(value);},reject:error=>{clearTimeout(timeout);reject(error);}});
    child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');
  });
  timer=setTimeout(()=>{for(const entry of pending.values())entry.reject(new Error('Actual Codex integration deadline'));},70000);
  try{
    // Match trex_browser_mcp_config: the application prepares the service before
    // the MCP subprocess enters Codex's job, which forbids job breakaway.
    const prepared=JSON.parse((await run(native,['prepare','--json'],{env,windowsHide:true,timeout:30000})).stdout);
    assert.equal(prepared.ready,true);
    const broker=JSON.parse(await fs.readFile(path.join(home,'broker.json'),'utf8'));
    assert.deepEqual(await fs.readdir(path.join(home,'projects')),[],'Preparing the service must not open Chrome or create profiles');
    await rpc('initialize',{clientInfo:{name:'trex-browser-integration',version:'1'},capabilities:{experimentalApi:true}});
    child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'initialized'})+'\n');
    const browserEnv={TREX_BROWSER_HOME:home,...(env.TREX_BROWSER_HEADLESS?{TREX_BROWSER_HEADLESS:env.TREX_BROWSER_HEADLESS}:{})};
    const result=await rpc('thread/start',{cwd:workspace,sandbox:'workspace-write',approvalPolicy:'on-request',config:{
      'mcp_servers.trex_browser.command':native,'mcp_servers.trex_browser.args':['mcp','--cwd',workspace,'--mode','qa','--client','codex-integration','--profile','BROWSER1'],
      'mcp_servers.trex_browser.env':browserEnv,'mcp_servers.trex_browser.enabled':true,'mcp_servers.trex_browser.required':true,
      'mcp_servers.trex_browser.startup_timeout_sec':30,'mcp_servers.trex_browser.tool_timeout_sec':120,
    }});
    const threadId=result.thread.id;
    const inventory=await rpc('mcpServerStatus/list',{threadId,serverName:'trex_browser',detail:'toolsAndAuthOnly'});
    const browser=inventory.data.find(server=>server.name==='trex_browser');assert.ok(browser);assert.equal(browser.runtimeStatus,'connected');assert.equal(browser.toolsError,null);
    for(const name of ['browser_navigate','browser_snapshot','browser_status'])assert.ok(browser.tools[name]);
    assert.equal(JSON.parse(await fs.readFile(path.join(home,'broker.json'),'utf8')).pid,broker.pid,'MCP connects to the app-prepared service');
    assert.deepEqual(await fs.readdir(path.join(home,'projects')),[],'Discovery must not open Chrome');
    const tool=(name,args={})=>rpc('mcpServer/tool/call',{threadId,server:'trex_browser',tool:name,arguments:args});
    const navigation=await tool('browser_navigate',{url:'http://127.0.0.1:'+server.address().port});
    assert.notEqual(navigation.isError,true,navigation.structuredContent?.error?.message);assert.equal(navigation.structuredContent.ok,true);
    assert.equal((await tool('browser_click',{role:'button',name:'Test automatic opening'})).structuredContent.ok,true);
    const snapshot=await tool('browser_snapshot');assert.match(JSON.stringify(snapshot.structuredContent.data),/Verified click/);
    const screenshot=await tool('browser_take_screenshot');assert.equal(screenshot.structuredContent.artifacts[0].mimeType,'image/png');assert.ok(screenshot.structuredContent.artifacts[0].bytes>0);
    assert.equal((await tool('browser_close')).structuredContent.ok,true);
    assert.ok(!methods.includes('turn/start'));t.diagnostic('Real Codex connection, first navigation, mouse click, DOM snapshot and screenshot succeeded without manual opening or model calls.');
  }finally{
    clearTimeout(timer);
    // Stop the exact live client tree before closing stdin so MCP descendants
    // cannot retain a fixture directory after its parent has exited.
    if(child.exitCode===null){await run(path.join(process.env.SystemRoot,'System32','taskkill.exe'),['/PID',String(child.pid),'/T','/F'],{windowsHide:true}).catch(()=>undefined);await new Promise(resolve=>{if(child.exitCode!==null)resolve();else child.once('exit',resolve);});}
    for(const entry of pending.values())entry.reject(new Error('Integration fixture closed'));pending.clear();
    child.stdin.destroy();child.stdout.destroy();child.stderr.destroy();
    let stopped=false;
    try{await run(native,['stop'],{env,windowsHide:true,timeout:20000});stopped=true;}
    finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));if(stopped)await fs.rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:200});else t.diagnostic('Private fixture retained because broker shutdown was not confirmed: '+root);}
  }
});
