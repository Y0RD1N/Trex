import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { context, workspaceFile, safePath, Artifacts, sha256, childEnvironment } from '../worker/security.mjs';
import { tools, validateArguments } from '../worker/tools.mjs';
import { BrowserService } from '../worker/browser.mjs';

test('observe tools are a fixed narrow subset; outer policy cannot be overridden',()=>{
  assert.deepEqual(tools('observe').map(t=>t.name),['browser_navigate','browser_navigate_back','browser_reload','browser_tabs','browser_frames','browser_snapshot','browser_console_messages','browser_network_requests','browser_network_body','browser_take_screenshot','browser_wait_for','browser_artifact','browser_status','browser_cancel']);
  for(const name of ['browser_click','browser_evaluate','browser_file_upload','browser_start_video','browser_emulate','browser_takeover'])assert.throws(()=>validateArguments(name,{},'observe'));
  for(const key of ['cwd','mode','profile','clientId','grantId','token'])assert.throws(()=>validateArguments('browser_snapshot',{[key]:'override'},'full'));
  assert.throws(()=>validateArguments('browser_tabs',{action:'new'},'observe'));
  assert.throws(()=>validateArguments('browser_artifact',{artifactId:'id',open:true},'observe'));
  assert.throws(()=>validateArguments('browser_evaluate',{function:42},'full'));
});
test('workspace files reject traversal and hard links; artifacts verify identity and integrity',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'trex-browser-security-'));
  try{
    const workspace=path.join(dir,'workspace');fs.mkdirSync(workspace);const file=path.join(workspace,'upload.txt');fs.writeFileSync(file,'fixture');
    const ctx=context({cwd:workspace,mode:'qa',clientId:'client',profile:'BROWSER1'});
    assert.equal(workspaceFile(workspace,'upload.txt'),file);
    fs.writeFileSync(path.join(dir,'outside.txt'),'outside');assert.throws(()=>workspaceFile(workspace,'../outside.txt'));
    fs.linkSync(file,path.join(workspace,'linked.txt'));assert.throws(()=>safePath(file));fs.unlinkSync(path.join(workspace,'linked.txt'));
    assert.throws(()=>context({...ctx,profile:'../../Chrome'}));assert.throws(()=>context({...ctx,cwd:'relative'}));
    const home=path.join(dir,'home');fs.mkdirSync(path.join(home,'artifacts'),{recursive:true});const artifacts=new Artifacts(home);
    const meta=await artifacts.add(Buffer.from('test'),'application/json','test',ctx);
    assert.equal(meta.sha256,sha256('test'));assert.equal(meta.bytes,4);assert.ok(!('path' in meta));
    assert.equal(artifacts.get(meta.artifactId,ctx).bytes.toString(),'test');assert.throws(()=>artifacts.get(meta.artifactId,{...ctx,projectId:'another'}));
    assert.throws(()=>artifacts.get('../outside.txt',ctx));fs.writeFileSync(path.join(home,'artifacts',meta.artifactId),'changed');assert.throws(()=>artifacts.get(meta.artifactId,ctx));
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('child environment never enumerates or forwards provider credentials or Node injection',()=>{
  const blocked=['OPENAI_API_KEY','ANTHROPIC_API_KEY','NODE_OPTIONS','NODE_PATH'];const previous=new Map(blocked.map(k=>[k,process.env[k]]));
  try{for(const key of blocked)process.env[key]='must-not-forward';const env=childEnvironment();for(const key of blocked)assert.ok(!(key in env));}
  finally{for(const [key,value] of previous)if(value===undefined)delete process.env[key];else process.env[key]=value;}
});
test('cancelling a finished operation cannot pause the shared profile',async()=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'trex-browser-cancel-'));
  try{fs.mkdirSync(path.join(home,'artifacts'));const service=new BrowserService(home);const ctx=context({cwd:home,mode:'full',clientId:'same-client'});
    await service.call(ctx,'browser_resume',{},'finished-status',1000);
    assert.throws(()=>service.cancel(ctx,'finished-status'),/Active operation not found/);
    const next=await service.call(ctx,'browser_status',{},'next-status',1000);assert.equal(next.data.paused,false);
  }finally{fs.rmSync(home,{recursive:true,force:true});}
});
test('nested form validation rejects every field before any action and wait units are explicit',async()=>{
  assert.throws(()=>validateArguments('browser_fill_form',{fields:[{selector:'#name',value:'changed'},null]},'full'));
  assert.throws(()=>validateArguments('browser_fill_form',{fields:[{selector:'#name',value:'changed'},{selector:'#other',value:{bad:true}}]},'full'));
  assert.throws(()=>validateArguments('browser_drag',{source:{selector:'a',mode:'full'},destination:{selector:'b'}},'full'));
  assert.throws(()=>validateArguments('browser_take_screenshot',{clip:{x:0,y:0,width:'bad',height:10}},'full'));
  assert.throws(()=>validateArguments('browser_wait_for',{time:1000},'observe'));
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'trex-browser-form-validation-'));
  try{fs.mkdirSync(path.join(home,'artifacts'));const service=new BrowserService(home);const ctx=context({cwd:home,mode:'full',clientId:'owner'});let actions=0;service.execute=async()=>{actions++;return {data:{},artifacts:[]};};
    await assert.rejects(service.call(ctx,'browser_fill_form',{fields:[{selector:'#name',value:'changed'},null]},'invalid-form',1000));assert.equal(actions,0);
  }finally{fs.rmSync(home,{recursive:true,force:true});}
});
test('upload uses immutable validated bytes even when an awaited locator swaps the path',async()=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'trex-browser-upload-race-'));const previousDev=process.env.TREX_BROWSER_DEV,previousLauncher=process.env.TREX_BROWSER_LAUNCHER;
  try{process.env.TREX_BROWSER_DEV='1';delete process.env.TREX_BROWSER_LAUNCHER;fs.mkdirSync(path.join(home,'artifacts'));const workspace=path.join(home,'workspace');fs.mkdirSync(workspace);const upload=path.join(workspace,'upload.txt'),outside=path.join(home,'outside-fixture.txt');fs.writeFileSync(upload,'allowed upload');fs.writeFileSync(outside,'outside fixture');
    const service=new BrowserService(home),ctx=context({cwd:workspace,mode:'full',clientId:'owner'}),state=service.state(ctx);state.browser={};state.tabs.set('tab',{});state.selected='tab';let consumed;
    service.locator=async()=>{fs.unlinkSync(upload);fs.linkSync(outside,upload);await Promise.resolve();return {setInputFiles:async files=>{consumed=files[0];}};};
    await service.call(ctx,'browser_file_upload',{selector:'input',paths:['upload.txt']},'upload-race',1000);
    assert.equal(consumed.name,'upload.txt');assert.equal(consumed.buffer.toString(),'allowed upload');assert.notEqual(consumed.buffer.toString(),fs.readFileSync(upload,'utf8'));assert.equal(fs.statSync(upload).nlink,2);
  }finally{if(previousDev===undefined)delete process.env.TREX_BROWSER_DEV;else process.env.TREX_BROWSER_DEV=previousDev;if(previousLauncher===undefined)delete process.env.TREX_BROWSER_LAUNCHER;else process.env.TREX_BROWSER_LAUNCHER=previousLauncher;fs.rmSync(home,{recursive:true,force:true});}
});
test('the owner can handle a synchronous dialog without waiting behind its blocked action',async()=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'trex-browser-dialog-'));
  try{fs.mkdirSync(path.join(home,'artifacts'));const service=new BrowserService(home),ctx=context({cwd:home,mode:'full',clientId:'owner'}),state=service.state(ctx);state.owner=ctx.clientId;state.browser={};state.tabs.set('tab',{});state.selected='tab';let accept;
    const dialogWait=new Promise(resolve=>{accept=resolve;});service.frame=()=>({evaluate:()=>dialogWait});
    const action=service.call(ctx,'browser_evaluate',{function:'() => alert("fixture")'},'sync-alert',2000);await new Promise(resolve=>setImmediate(resolve));state.dialog={type:'alert',message:'fixture',tabId:'tab',dialog:{accept:async()=>accept('accepted'),dismiss:async()=>accept('dismissed')}};
    const status=await service.call(ctx,'browser_status',{},'dialog-status',1000);assert.equal(status.data.dialog.type,'alert');
    await assert.rejects(service.call({...ctx,clientId:'foreign'},'browser_handle_dialog',{accept:true},'foreign-dialog',1000),{code:'OWNERSHIP'});
    const handled=await service.call(ctx,'browser_handle_dialog',{accept:true},'owner-dialog',1000);assert.equal(handled.data.handled,true);assert.equal((await action).data.value,'accepted');assert.equal(state.paused,false);
  }finally{fs.rmSync(home,{recursive:true,force:true});}
});
test('foreign calls and unissued queued cancellations cannot pause the owner',async()=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'trex-browser-ownership-'));
  try{fs.mkdirSync(path.join(home,'artifacts'));const service=new BrowserService(home);const ctx=context({cwd:home,mode:'full',clientId:'owner'});const state=service.state(ctx);state.owner=ctx.clientId;
    state.queue=new Promise(resolve=>setTimeout(resolve,300));
    await assert.rejects(service.call({...ctx,clientId:'foreign'},'browser_click',{selector:'button'},'foreign-queued',100),{code:'OWNERSHIP'});
    assert.equal(state.paused,false);assert.equal(state.owner,'owner');
    await assert.rejects(service.call(ctx,'browser_click',{selector:'button'},'owner-unissued',100),{code:'CANCELLED'});
    assert.equal(state.paused,false);await state.queue;assert.equal(state.paused,false);
  }finally{fs.rmSync(home,{recursive:true,force:true});}
});
test('an unfinished response body read releases the queue on cancellation',async()=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'trex-browser-held-response-'));
  try{fs.mkdirSync(path.join(home,'artifacts'));const service=new BrowserService(home);const ctx=context({cwd:home,mode:'full',clientId:'owner'});const state=service.state(ctx);state.owner=ctx.clientId;state.browser={};state.tabs.set('fixture-tab',{});state.selected='fixture-tab';
    let bodyRead=false;state.network.set('held',{response:{headers:()=>({'content-length':'4'}),finished:()=>new Promise(()=>{}),body:()=>{bodyRead=true;return Buffer.from('test');}}});
    await assert.rejects(service.call(ctx,'browser_network_body',{requestId:'held'},'held-response',100),{code:'READ_TIMEOUT'});
    await Promise.race([state.queue,new Promise((_,reject)=>setTimeout(()=>reject(new Error('Read held the profile queue')),1000))]);
    assert.equal(state.active,null);assert.equal(bodyRead,false);assert.equal(state.paused,false);
    const resumed=await service.call(ctx,'browser_resume',{},'resume-after-read',1000);assert.equal(resumed.data.paused,false);
    const next=await service.call(ctx,'browser_status',{},'status-after-read',1000);assert.equal(next.data.running,true);
  }finally{fs.rmSync(home,{recursive:true,force:true});}
});
