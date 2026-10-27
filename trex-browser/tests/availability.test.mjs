import test from 'node:test';import assert from 'node:assert/strict';import fs from'node:fs';import os from'node:os';import path from'node:path';
import{BrowserService,isObservation}from'../worker/browser.mjs';import{context}from'../worker/security.mjs';
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve}};
function fixture(t){
 // Production's HTTP server keeps the broker alive while its unref'ed operation
 // timer expires. The in-memory fixture needs its own bounded referenced handle.
 const keepAlive=setTimeout(()=>{},15000);t.after(()=>clearTimeout(keepAlive));
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'trex-browser-availability-'));fs.mkdirSync(path.join(home,'artifacts'));t.after(()=>{assert.equal(path.dirname(home),os.tmpdir());assert.ok(path.basename(home).startsWith('trex-browser-availability-'));fs.rmSync(home,{recursive:true,force:true})});const service=new BrowserService(home),ctx=context({cwd:home,mode:'full',clientId:'owner'}),state=service.state(ctx);state.owner=ctx.clientId;return {service,ctx,state}}
test('observation classification excludes navigation, tab selection, log clearing, input and opening host files',()=>{
 for(const name of ['browser_snapshot','browser_take_screenshot','browser_frames','browser_network_requests','browser_network_body','browser_wait_for'])assert.equal(isObservation(name),true);
 assert.equal(isObservation('browser_tabs',{action:'list'}),true);assert.equal(isObservation('browser_console_messages'),true);assert.equal(isObservation('browser_artifact',{read:true}),true);
 for(const [name,args]of[['browser_navigate',{}],['browser_tabs',{action:'select'}],['browser_tabs',{action:'close'}],['browser_console_messages',{clear:true}],['browser_artifact',{open:true}],['browser_click',{}],['browser_evaluate',{}],['browser_hover',{}]])assert.equal(isObservation(name,args),false,name);
});
test('manual pause permits observe-mode screenshots and reads while keeping page controls paused',async t=>{
 const{service,ctx,state}=fixture(t),execute=service.execute.bind(service);let reads=0;
 service.execute=async(s,c,name,args,signal)=>isObservation(name,args)?(reads++,{data:{observed:true},artifacts:[]}):execute(s,c,name,args,signal);
 await service.call(ctx,'browser_pause',{},'manual-pause',1000);assert.equal(state.pauseReason,'manual');
 for(const [name,args]of[['browser_take_screenshot',{}],['browser_snapshot',{}],['browser_frames',{}],['browser_console_messages',{}],['browser_network_requests',{}],['browser_network_body',{requestId:'request'}],['browser_wait_for',{time:0}],['browser_tabs',{action:'list'}]])assert.equal((await service.call({...ctx,mode:'observe'},name,args,name,1000)).data.observed,true);
 assert.equal(reads,8);assert.equal(state.paused,true);assert.equal(state.pauseReason,'manual');
 for(const [name,args]of[['browser_click',{selector:'button'}],['browser_navigate',{url:'http://localhost/'}],['browser_tabs',{action:'select',tabId:'tab'}],['browser_console_messages',{clear:true}]])await assert.rejects(service.call(ctx,name,args,'blocked-'+name,1000),{code:'PAUSED'});
 await assert.rejects(service.call({...ctx,clientId:'foreign'},'browser_take_screenshot',{},'foreign-read',1000),{code:'OWNERSHIP'});assert.equal(state.owner,ctx.clientId);
});
test('read timeout releases its operation without pausing or blocking a later action',async t=>{
 const{service,ctx,state}=fixture(t);let clicks=0;service.execute=async(s,c,name)=>name==='browser_take_screenshot'?new Promise(()=>{}):(clicks++,{data:{clicked:true},artifacts:[]});
 await assert.rejects(service.call(ctx,'browser_take_screenshot',{},'slow-read',100),{code:'READ_TIMEOUT'});
 assert.equal(state.paused,false);assert.equal(state.active,null);assert.equal(state.pauseReason,null);
 await service.call(ctx,'browser_click',{selector:'button'},'next-action',1000);assert.equal(clicks,1);
});
test('a read timeout cannot interrupt or take over an ongoing action',async t=>{
 const{service,ctx,state}=fixture(t),action=deferred();let interrupts=0;service.interrupt=async()=>{interrupts++};service.execute=async(s,c,name)=>name==='browser_click'?action.promise:new Promise(()=>{});
 const pending=service.call(ctx,'browser_click',{selector:'button'},'real-action',2000);await Promise.resolve();await Promise.resolve();assert.equal(state.active.id,'real-action');
 await assert.rejects(service.call(ctx,'browser_snapshot',{},'slow-snapshot',100),{code:'READ_TIMEOUT'});assert.equal(state.active.id,'real-action');assert.equal(state.paused,false);assert.equal(interrupts,0);action.resolve({data:{clicked:true},artifacts:[]});await pending;
});
test('uncertain mutation stays paused but cannot block observation or replay itself',async t=>{
 const{service,ctx,state}=fixture(t),action=deferred(),execute=service.execute.bind(service);let clicks=0;
 service.execute=async(s,c,name,args,signal)=>name==='browser_click'?(clicks++,action.promise):isObservation(name,args)?{data:{observed:true},artifacts:[]}:execute(s,c,name,args,signal);
 await assert.rejects(service.call(ctx,'browser_click',{selector:'button'},'uncertain-click',100),{code:'UNCERTAIN'});assert.equal(state.paused,true);assert.equal(state.pauseReason,'uncertain');assert.deepEqual(state.pauseOperation,{operationId:'uncertain-click',tool:'browser_click'});
 assert.equal((await service.call(ctx,'browser_take_screenshot',{},'inspect-pending',1000)).data.observed,true);assert.equal(state.active.id,'uncertain-click');assert.equal(clicks,1);
 await assert.rejects(service.call(ctx,'browser_click',{selector:'button'},'uncertain-click',1000),{code:'DUPLICATE_OPERATION'});
 action.resolve({data:{clicked:true},artifacts:[]});await state.queue;
 await assert.rejects(service.call({...ctx,clientId:'foreign'},'browser_resume',{},'foreign-resume',1000),{code:'OWNERSHIP'});
 const resumed=await service.call(ctx,'browser_resume',{},'reviewed-resume',1000);assert.equal(resumed.data.paused,false);assert.equal(resumed.data.pauseReason,null);assert.equal(clicks,1);
});
test('manual pause reason survives cancellation of the previously active action',async t=>{
 const{service,ctx,state}=fixture(t),action=deferred();service.execute=()=>action.promise;const pending=service.call(ctx,'browser_click',{selector:'button'},'active-before-manual',2000);await Promise.resolve();await Promise.resolve();
 const rejected=assert.rejects(pending,{code:'UNCERTAIN'});await service.call(ctx,'browser_pause',{},'human-pause',1000);await rejected;assert.equal(state.pauseReason,'manual');assert.equal(state.paused,true);action.resolve({data:{},artifacts:[]});await state.queue;
});
test('late cancelled snapshot never clears newer refs or publishes a stale revision',async t=>{
 const{service,ctx,state}=fixture(t),handles=deferred();state.browser={};state.tabs.set('tab',{});state.selected='tab';service.frame=()=>({locator:selector=>selector==='body'?{ariaSnapshot:async()=>''}:{elementHandles:()=>handles.promise},url:()=> 'http://localhost/'});
 await assert.rejects(service.call(ctx,'browser_snapshot',{},'cancelled-snapshot',100),{code:'READ_TIMEOUT'});state.refs.set('newer',{value:true});const revision=state.revision;handles.resolve([]);await new Promise(r=>setTimeout(r,20));assert.equal(state.refs.has('newer'),true);assert.equal(state.revision,revision);assert.equal(state.paused,false);
});
test('late cancelled screenshot does not publish an artifact',async t=>{
 const{service,ctx,state}=fixture(t),shot=deferred();state.browser={};state.tabs.set('tab',{screenshot:()=>shot.promise});state.selected='tab';let published=0;service.artifacts.add=async()=>{published++;return{}};
 await assert.rejects(service.call(ctx,'browser_take_screenshot',{},'cancelled-shot',100),{code:'READ_TIMEOUT'});shot.resolve(Buffer.alloc(24));await new Promise(r=>setTimeout(r,20));assert.equal(published,0);assert.equal(state.paused,false);
});
test('concurrent observations share one browser startup',async t=>{
 const{service,ctx,state}=fixture(t),opening=deferred();let launches=0;service.open=async()=>{launches++;await opening.promise;state.browser={}};const first=service.ensure(state,ctx),second=service.ensure(state,ctx);assert.equal(launches,1);opening.resolve();await Promise.all([first,second]);assert.equal(state.opening,null);
});
test('ownership change cannot deliver an old clients pending observation',async t=>{
 const{service,ctx,state}=fixture(t),read=deferred();service.execute=()=>read.promise;const pending=service.call(ctx,'browser_take_screenshot',{},'old-owner-read',2000);state.owner='new-owner';state.generation++;read.resolve({data:{private:'not delivered'},artifacts:[]});await assert.rejects(pending,{code:'OWNERSHIP'});assert.equal(state.owner,'new-owner');assert.equal(state.paused,false);
});
test('a snapshot racing takeover cannot replace the new owners refs',async t=>{
 const{service,ctx,state}=fixture(t),handles=deferred();state.browser={};state.tabs.set('tab',{});state.selected='tab';service.frame=()=>({locator:selector=>selector==='body'?{ariaSnapshot:async()=>''}:{elementHandles:()=>handles.promise},url:()=> 'http://localhost/'});
 const pending=service.call(ctx,'browser_snapshot',{},'old-snapshot',2000);await Promise.resolve();await Promise.resolve();state.generation++;state.owner='new-owner';state.refs.set('new-owner-ref',{value:true});handles.resolve([]);await assert.rejects(pending,{code:'STALE_SNAPSHOT'});assert.equal(state.refs.has('new-owner-ref'),true);
});
test('explicit recovery close bypasses a stuck action and cancels queued intents without replay',async t=>{
 const{service,ctx,state}=fixture(t),action=deferred(),execute=service.execute.bind(service);let clicks=0;service.closeProfile=async()=>{state.browser=null;state.tabs.clear();action.resolve({data:{stopped:true},artifacts:[]})};
 service.execute=async(s,c,name,args,signal)=>name==='browser_click'?(clicks++,action.promise):execute(s,c,name,args,signal);
 const first=service.call(ctx,'browser_click',{selector:'button'},'stuck-action',100);const uncertain=assert.rejects(first,{code:'UNCERTAIN'});await Promise.resolve();await Promise.resolve();
 const queued=service.call(ctx,'browser_click',{selector:'button'},'queued-before-recovery',2000);const cancelled=assert.rejects(queued,{code:'CANCELLED'});
 await uncertain;
 await assert.rejects(service.call(ctx,'browser_resume',{},'resume-too-soon',1000),{code:'RECOVERY_PENDING'});
 const closed=await service.call(ctx,'browser_close',{},'explicit-close',1000);await cancelled;assert.equal(closed.data.closed,true);assert.equal(state.paused,false);assert.equal(state.active,null);assert.equal(clicks,1);assert.equal(state.closing,false);
});
test('recovery close cannot silently overwrite a concurrent clients accepted takeover',async t=>{
 const{service,ctx,state}=fixture(t),action=deferred(),closing=deferred(),execute=service.execute.bind(service);service.closeProfile=async()=>{action.resolve({data:{stopped:true},artifacts:[]});await closing.promise};service.execute=async(s,c,name,args,signal)=>name==='browser_click'?action.promise:execute(s,c,name,args,signal);
 const pending=service.call(ctx,'browser_click',{selector:'button'},'stuck-before-takeover',100),uncertain=assert.rejects(pending,{code:'UNCERTAIN'});await Promise.resolve();await Promise.resolve();
 const takeover=service.call({...ctx,clientId:'other'},'browser_takeover',{},'queued-takeover',2000),rejected=assert.rejects(takeover,{code:'PROFILE_CLOSING'});await uncertain;const close=service.call(ctx,'browser_close',{},'recover-and-close',2000);await rejected;assert.equal(state.owner,ctx.clientId);await assert.rejects(service.call(ctx,'browser_pause',{},'pause-during-close',1000),{code:'PROFILE_CLOSING'});closing.resolve();await close;assert.equal(state.owner,null);assert.equal(state.closing,false);
});
test('a new owner can recover a stuck profile without resuming or replaying old inputs',async t=>{
 const{service,ctx,state}=fixture(t),action=deferred(),execute=service.execute.bind(service),next={...ctx,clientId:'next-owner'};let clicks=0;service.closeProfile=async()=>action.resolve({data:{stopped:true},artifacts:[]});service.execute=async(s,c,name,args,signal)=>name==='browser_click'?(clicks++,action.promise):execute(s,c,name,args,signal);
 const first=service.call(ctx,'browser_click',{selector:'button'},'old-stuck',100),uncertain=assert.rejects(first,{code:'UNCERTAIN'});await Promise.resolve();await Promise.resolve();const queued=service.call(ctx,'browser_click',{selector:'button'},'old-queued',2000),cancelled=assert.rejects(queued,{code:'CANCELLED'});await uncertain;
 const taken=await service.call(next,'browser_takeover',{},'explicit-new-owner',1000);await cancelled;assert.equal(taken.data.owner,'self');assert.equal(taken.data.paused,true);assert.equal(state.active.id,'old-stuck');assert.equal(taken.data.pendingAction.cancelRequested,true);
 await assert.rejects(service.call(next,'browser_resume',{},'still-pending',1000),{code:'RECOVERY_PENDING'});await service.call(next,'browser_close',{},'new-owner-recovery',1000);assert.equal(clicks,1);assert.equal(state.paused,false);
});
test('taking ownership cannot silently ignore a runtime supervisor failure',async t=>{
 const{service,ctx,state}=fixture(t);state.supervisorError='Supervisor fixture unavailable';service.pause(state,'runtime');const next={...ctx,clientId:'replacement'};const taken=await service.call(next,'browser_takeover',{},'runtime-takeover',1000);assert.equal(taken.data.owner,'self');assert.equal(taken.data.paused,true);assert.equal(taken.data.pauseReason,'runtime');await assert.rejects(service.call(next,'browser_resume',{},'runtime-resume',1000),{code:'RUNTIME_UNAVAILABLE'});
});
test('same-owner recovery takeover cannot cancel itself',async t=>{
 const{service,ctx,state}=fixture(t),action=deferred(),execute=service.execute.bind(service);service.execute=async(s,c,name,args,signal)=>name==='browser_click'?action.promise:execute(s,c,name,args,signal);await assert.rejects(service.call(ctx,'browser_click',{selector:'button'},'same-owner-stuck',100),{code:'UNCERTAIN'});const result=await service.call(ctx,'browser_takeover',{},'same-owner-takeover',1000);assert.equal(result.data.paused,true);assert.equal(result.data.owner,'self');action.resolve({data:{},artifacts:[]});await state.queue;
});
