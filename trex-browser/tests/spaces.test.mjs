import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BrowserService } from '../worker/browser.mjs';
import { ensureSpaces } from '../worker/spaces.mjs';
import { context } from '../worker/security.mjs';
import { tools, validateArguments } from '../worker/tools.mjs';

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
