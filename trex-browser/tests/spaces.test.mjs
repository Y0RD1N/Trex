import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BrowserService } from '../worker/browser.mjs';
import { ensureSpaces, listSpaces } from '../worker/spaces.mjs';
import { context } from '../worker/security.mjs';
import { tools, validateArguments } from '../worker/tools.mjs';
import { randomUUID } from 'node:crypto';

function fixture(t){
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'trex-browser-spaces-'));
  for(const name of ['artifacts','receipts'])fs.mkdirSync(path.join(home,name));
  t.after(()=>{const resolved=fs.realpathSync(home);assert.equal(path.dirname(resolved),fs.realpathSync(os.tmpdir()));assert.match(path.basename(resolved),/^trex-browser-spaces-/);fs.rmSync(resolved,{recursive:true,force:true});});
  return {home,service:new BrowserService(home),ctx:context({cwd:home,mode:'full',clientId:'host'})};
}
test('space allocations preserve manual profiles, persist identities and never start Chrome',t=>{
  const {service,ctx}=fixture(t);service.createProfile({...ctx,profile:'BROWSER2'});
  const members=[{clientId:'one',label:'Research'},{clientId:'two',label:'Review'}];
  const result=ensureSpaces(service,ctx,members);
  assert.deepEqual(result.spaces.map(space=>space.profile),['BROWSER3','BROWSER4']);
  assert.deepEqual(ensureSpaces(service,ctx,members),result);
  assert.equal(service.sessions.size,0);
  const reopened=new BrowserService(service.home);assert.deepEqual(ensureSpaces(reopened,ctx,members),result);
  assert.equal(ensureSpaces(service,ctx,[{clientId:'three',label:'Third'}]).spaces[0].profile,'BROWSER5');
});
test('invalid or oversized allocations do not partially reserve profiles',t=>{
  const {service,ctx}=fixture(t);
  for(const members of [[],[{clientId:'one',label:'A'},{clientId:'one',label:'B'}],[{clientId:'one',label:'A',profile:'BROWSER1'}],Array.from({length:10},(_,i)=>({clientId:String(i),label:'A'}))])assert.throws(()=>ensureSpaces(service,ctx,members));
  assert.deepEqual(service.profiles(ctx),[]);
  for(let i=2;i<99;i++)service.createProfile({...ctx,profile:`BROWSER${i}`});
  assert.throws(()=>ensureSpaces(service,ctx,[{clientId:'one',label:'A'},{clientId:'two',label:'B'}]),/No free browser profiles/);
  assert.equal(service.profiles(ctx).length,97);assert.ok(!service.profiles(ctx).some(profile=>profile.id==='BROWSER99'));
});

test('the project overview reports all allocated and live manual instances without changing their owners',t=>{
  const {service,ctx}=fixture(t);
  const bindings=ensureSpaces(service,ctx,[{clientId:'one',label:'Codex · Chat'},{clientId:'two',label:'Claude · Review'}]).spaces;
  const a=service.state({...ctx,profile:bindings[0].profile,clientId:'one'});a.owner='one';a.browser={};a.selected='page';a.tabs.set('page',{url:()=> 'http://127.0.0.1:5176/vender'});
  const controller=new AbortController();service.operations.set('working',{ctx:{...ctx,profile:bindings[0].profile,clientId:'one'},name:'browser_snapshot',started:true,controller});
  service.createProfile({...ctx,profile:'BROWSER1'});const manual=service.state({...ctx,profile:'BROWSER1'});manual.owner='one';manual.browser={};
  const before=service.sessions.size,result=listSpaces(service,ctx);
  assert.equal(result.spaces.length,3);assert.equal(service.sessions.size,before);
  const working=result.spaces.find(space=>space.profile===bindings[0].profile);
  assert.equal(working.active,true);assert.equal(working.currentTool,'browser_snapshot');assert.equal(working.url,'http://127.0.0.1:5176/vender');assert.equal(working.tabCount,1);
  assert.equal(result.spaces.find(space=>space.profile===bindings[1].profile).running,false);
  assert.equal(a.owner,'one');assert.equal(a.paused,false);assert.equal(manual.owner,'one');
  assert.deepEqual(listSpaces(service,{...ctx,projectId:'other-project'}),{spaces:[]});
});

test('status and tab inventory leave every reserved agent browser unopened, including inside a batch',async t=>{
  const {service,ctx}=fixture(t);
  const bindings=ensureSpaces(service,ctx,[{clientId:'one',label:'Principal'},{clientId:'two',label:'Review'},{clientId:'three',label:'Research'}]).spaces;
  let opened=0;service.open=async()=>{opened++;throw new Error('Inventory must not launch a browser');};
  for(const space of bindings){
    const bound={...ctx,...space};
    assert.equal((await service.call(bound,'browser_status',{},randomUUID(),1000)).data.running,false);
    for(const args of [{},{action:'list'}])assert.deepEqual((await service.call(bound,'browser_tabs',args,randomUUID(),1000)).data.tabs,[]);
    const batch=await service.call(bound,'browser_batch',{steps:[{tool:'browser_tabs',arguments:{action:'list'}}]},randomUUID(),1000);
    assert.deepEqual(batch.data.steps[0].data.tabs,[]);
  }
  assert.equal(opened,0);assert.equal(service.shellHosts.size,0);
  assert.ok([...service.sessions.values()].every(state=>!state.browser&&!state.opening));
  assert.equal(service.profiles(ctx).length,bindings.length,'the stable bindings remain saved for later use');
});

test('the agents center publishes only actual browser sessions, never saved or merely inspected profiles',async t=>{
  const {service,ctx}=fixture(t);
  const bindings=ensureSpaces(service,ctx,[{clientId:'one',label:'Principal'},{clientId:'two',label:'Review'},{clientId:'three',label:'Research'}]).spaces;
  const first=service.state({...ctx,...bindings[0]}),second=service.state({...ctx,...bindings[1]});
  service.state({...ctx,...bindings[2]});
  const published=[];const sink={push:(name,spaces)=>{if(name==='setSpaces')published.push(spaces);}};
  first.browser={};first.shell=sink;
  const update=async()=>{service.pushSpaces(ctx.projectId);await new Promise(resolve=>setTimeout(resolve,300));return published.at(-1);};
  assert.deepEqual((await update()).map(space=>space.profile),[first.key]);
  second.browser={};second.shell=sink;
  assert.deepEqual((await update()).map(space=>space.profile),[first.key,second.key]);
  first.browser=null;first.shell=null;
  assert.deepEqual((await update()).map(space=>space.profile),[second.key]);
  assert.equal(service.profiles(ctx).length,3,'closing a browser must preserve its saved profile');
});
test('batch validation preserves bound policy and rejects every later nested input before dispatch',()=>{
  assert.equal(tools('full').find(tool=>tool.name==='browser_batch').annotations.readOnlyHint,false);
  assert.equal(tools('observe').find(tool=>tool.name==='browser_batch').annotations.readOnlyHint,true);
  assert.doesNotThrow(()=>validateArguments('browser_batch',{steps:[{tool:'browser_press_key',arguments:{key:'Enter'}}]},'full'));
  assert.throws(()=>validateArguments('browser_batch',{steps:[{tool:'browser_snapshot',arguments:{}},{tool:'browser_click',arguments:{selector:'button'}}]},'observe'),{code:'POLICY_DENIED'});
  assert.throws(()=>validateArguments('browser_batch',{steps:[{tool:'browser_batch',arguments:{steps:[]}}]},'full'));
  assert.throws(()=>validateArguments('browser_batch',{steps:[{tool:'browser_snapshot',arguments:{clientId:'other'}}]},'full'),{code:'POLICY_DENIED'});
  assert.throws(()=>validateArguments('browser_batch',{steps:[{tool:'browser_console_messages',arguments:{clear:true}}]},'observe'),{code:'POLICY_DENIED'});
  assert.throws(()=>validateArguments('browser_batch',{steps:[{tool:'browser_click',arguments:{selector:'a'}},{tool:'browser_fill_form',arguments:{fields:[{selector:'a',value:'x'},null]}}]},'full'));
});
test('batch output limit stops later actions and returns bounded completed-step evidence',async t=>{
  const {service,ctx}=fixture(t);let dispatched=0;
  const execute=service.execute.bind(service);
  service.execute=async(s,c,name,args,signal,id)=>name==='browser_batch'?execute(s,c,name,args,signal,id):(dispatched++,{data:{text:'x'.repeat(1024*1024+1)},artifacts:[]});
  let error;try{await service.call(ctx,'browser_batch',{steps:[{tool:'browser_snapshot',arguments:{}},{tool:'browser_snapshot',arguments:{}}]},'bounded-batch',1000);}catch(value){error=value;}
  assert.ok(error);assert.equal(dispatched,1);assert.equal(error.batchSteps[0].receipt.status,'completed');assert.equal(error.batchSteps[0].data.omitted,true);assert.ok(JSON.stringify(error.batchSteps).length<2048);
  assert.equal(service.state(ctx).paused,false);
});
test('a concurrent snapshot cannot dispose a ref while its issued click is still using it',async t=>{
  const {service,ctx}=fixture(t),state=service.state(ctx);let finish,started,disposed=false;
  const waiting=new Promise(resolve=>{finish=resolve;}),issued=new Promise(resolve=>{started=resolve;});
  const element={isConnected:true,outerHTML:'<button>Fixture</button>',tagName:'BUTTON',innerText:'Fixture',getAttribute:()=>null};
  const previous={evaluate:async fn=>fn(element),click:async()=>{started();await waiting;assert.equal(disposed,false);},dispose:async()=>{disposed=true;}};
  const fresh={evaluate:async fn=>fn(element),dispose:async()=>{}};
  const frame={url:()=> 'http://localhost/fixture',locator:()=>({elementHandles:async()=>[fresh],ariaSnapshot:async()=> 'button Fixture'})};
  const page={mainFrame:()=>frame};state.browser={};state.owner=ctx.clientId;state.tabs.set('fixture',page);state.selected='fixture';
  service.pageState(state,page).refs.set('previous',{handle:previous,frame,fingerprint:element.outerHTML});
  const pending=service.call(ctx,'browser_click',{ref:'previous',revision:0},'leased-click',5000);await issued;
  const snapshot=await service.call(ctx,'browser_snapshot',{},'concurrent-snapshot',5000);assert.ok(snapshot.data.elements.length);assert.equal(disposed,false);
  finish();await pending;assert.equal(disposed,true);
});
