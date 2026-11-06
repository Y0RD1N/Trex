// Token economy: fewer stale refs, compact snapshots and cheap screenshots by
// default, and batch failures an agent can read without replaying steps.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BrowserService } from '../worker/browser.mjs';
import { context } from '../worker/security.mjs';
import { BROWSER_INSTRUCTIONS, agentText, batchFailureText, modelView } from '../worker/tools.mjs';
import { fakePage } from './fixtures/fake-page.mjs';

function fixture(t){
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'trex-browser-tokens-'));
  for(const name of ['artifacts','receipts'])fs.mkdirSync(path.join(home,name));
  t.after(()=>{const resolved=fs.realpathSync(home);assert.equal(path.dirname(resolved),fs.realpathSync(os.tmpdir()));assert.match(path.basename(resolved),/^trex-browser-tokens-/);fs.rmSync(resolved,{recursive:true,force:true});});
  const service=new BrowserService(home),ctx=context({cwd:home,mode:'full',clientId:'owner'}),state=service.state(ctx);
  state.owner=ctx.clientId;state.browser={};
  return {service,ctx,state};
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('a child frame navigating or a read-only evaluate keeps the page refs; only a new document drops them',async t=>{
  const {service,ctx,state}=fixture(t),page=fakePage({tree:[{role:'button',name:'Save',ref:'e1'}]});
  service.attachPage(state,page);const tab=service.tabIdOf(state,page),refs=service.pageState(state,page);
  const snap=(await service.call(ctx,'browser_snapshot',{},'first-snapshot',1000)).data,start=refs.revision;
  assert.deepEqual(snap.elements,[`${tab}-e1 button Save`]);
  refs.refs.set(`${tab}-f1e2`,{pw:'f1e2',role:'button',name:'Ad',n:0,of:1});
  page.emit('framenavigated',{}); // an ad or embed navigating on its own restarts only its refs
  assert.equal(refs.revision,start);assert.ok(refs.refs.has(`${tab}-e1`));assert.equal(refs.refs.has(`${tab}-f1e2`),false);
  page.evaluate=async()=>'read';
  assert.equal((await service.call(ctx,'browser_evaluate',{function:'() => document.title'},'read-only-evaluate',1000)).data.value,'read');
  page.emit('framenavigated',page.mainFrame());await tick(); // same document (pushState)
  assert.equal(refs.revision,start);assert.ok(refs.refs.has(`${tab}-e1`));
  page.doc=2;page.emit('domcontentloaded');await tick();
  assert.equal(refs.revision,start+1);assert.equal(refs.refs.size,0);
});

test('snapshot lists compact elements by default; full:true or compact:false adds the tree',async t=>{
  const {service,ctx,state}=fixture(t),page=fakePage({tree:[{role:'button',name:'Save',ref:'e1'}]});let trees=0;
  const frame=page.mainFrame(),locator=frame.locator;frame.locator=selector=>({...locator(selector),first(){return this;},ariaSnapshot:async()=>{trees++;return '- button "Save"';}});
  state.tabs.set('tab-1',page);state.selected='tab-1';
  const snapshot=args=>service.call(ctx,'browser_snapshot',args,`snapshot-${JSON.stringify(args)}`,1000).then(r=>r.data);
  const compact=await snapshot({});
  assert.equal(trees,0);assert.equal('accessibility' in compact,false);assert.equal('compact' in compact,false);
  assert.deepEqual(compact.elements,['tab-1-e1 button Save']);assert.equal(compact.title,'Fixture');
  assert.equal('accessibility' in await snapshot({compact:true}),false);assert.equal(trees,0);
  for(const args of [{full:true},{compact:false}]){const full=await snapshot(args);assert.match(full.accessibility,/button "Save"/);assert.deepEqual(full.elements,['tab-1-e1 button Save']);}
  assert.equal(trees,2);
});

test('screenshots default to JPEG 70 in CSS pixels; PNG, device pixels and native width stay available',async t=>{
  const {service,ctx,state}=fixture(t),shots=[],sent=[];
  // Smallest headers imageDimensions reads: JPEG SOF0 1024x640 and PNG IHDR 640x480.
  const jpeg=Buffer.from([0xff,0xd8,0xff,0xc0,0x00,0x11,0x08,0x02,0x80,0x04,0x00,...Array(10).fill(0)]);
  const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10,0,0,0,13]),Buffer.from('IHDR'),Buffer.from([0,0,2,128,0,0,1,224])]);
  let viewport={w:640,h:480,x:0,y:0,dpr:2};
  state.tabs.set('tab-1',{evaluate:async()=>viewport,screenshot:async options=>{shots.push(options);return options.type==='png'?png:jpeg;}});state.selected='tab-1';
  service.cdp=async()=>({send:async(method,params)=>{sent.push({method,params});return method==='Page.getLayoutMetrics'?{contentSize:{width:2560},cssContentSize:{width:1280}}:{data:jpeg.toString('base64')};}});
  const shot=args=>service.call(ctx,'browser_take_screenshot',args,`shot-${JSON.stringify(args)}-${shots.length}-${sent.length}`,1000);
  const small=await shot({});
  assert.deepEqual(shots[0],{type:'jpeg',quality:70,scale:'css',fullPage:false,clip:undefined,timeout:10000});
  assert.equal(small.image.mimeType,'image/jpeg');assert.deepEqual([small.artifacts[0].width,small.artifacts[0].height],[1024,640]);
  const exact=await shot({type:'png',scale:'device'});
  assert.deepEqual(shots[1],{type:'png',quality:undefined,scale:'device',fullPage:false,clip:undefined,timeout:10000});
  assert.deepEqual([exact.artifacts[0].mimeType,exact.artifacts[0].width,exact.artifacts[0].height],['image/png',640,480]);
  // A wide, scrolled viewport is captured where it is, at 1024 CSS px; the output
  // scale divides out the session's own device ratio (2560/1280).
  viewport={w:1280,h:800,x:0,y:300,dpr:2};
  await shot({});
  assert.deepEqual(sent.at(-1),{method:'Page.captureScreenshot',params:{format:'jpeg',quality:70,clip:{x:0,y:300,width:1280,height:800,scale:1024/1280/2},captureBeyondViewport:false}});
  await shot({scale:'device',quality:90});
  assert.equal(sent.at(-1).params.clip.scale,1024/1280);assert.equal(sent.at(-1).params.quality,90);
  await shot({fullResolution:true});
  assert.equal(shots.length,3);assert.equal(shots[2].scale,'css');
});

test('a failed batch names the failed, completed and unrun steps; agent text drops step receipts',async t=>{
  const {service,ctx}=fixture(t),execute=service.execute.bind(service);
  service.execute=async(s,c,name,args,signal,id)=>name==='browser_batch'?execute(s,c,name,args,signal,id)
    :args.selector==='#missing'?Promise.reject(new Error('Locator must identify exactly one element')):{data:{done:name},artifacts:[]};
  const steps=[{tool:'browser_navigate',arguments:{url:'http://localhost/'}},{tool:'browser_click',arguments:{selector:'#missing'}},{tool:'browser_press_key',arguments:{key:'Enter'}}];
  const error=await service.call(ctx,'browser_batch',{steps},'failing-batch',1000).then(()=>null,e=>e);
  assert.ok(error?.batchSteps);
  assert.equal(batchFailureText(error.message,error.batchSteps,error.batchTools),
    'Batch stopped at steps[1] browser_click (rejected): Locator must identify exactly one element\nCompleted, do not replay: steps[0] browser_navigate\nNot run: steps[2] browser_press_key');
  assert.equal(batchFailureText('Cancelled',[],['browser_click']),'Batch stopped before steps[0]: Cancelled\nCompleted, do not replay: none\nNot run: steps[0] browser_click');
  const uncertain=[{index:0,tool:'browser_click',receipt:{status:'completed'}},{index:1,tool:'browser_evaluate',receipt:{status:'uncertain'}}];
  assert.match(batchFailureText('Operation cancelled',uncertain,['browser_click','browser_evaluate']),/^Batch stopped at steps\[1\] browser_evaluate \(outcome uncertain\): Operation cancelled\nCompleted, do not replay: steps\[0\] browser_click$/);
  const batch=await service.call(ctx,'browser_batch',{steps:[steps[0],steps[2]]},'passing-batch',1000);
  const view={ok:true,...modelView({data:batch.data,revision:batch.revision,artifacts:batch.artifacts})},lean=agentText(view);
  assert.ok(view.steps.every(step=>step.operationId&&step.receipt.status==='completed'),'receipts stay in structuredContent');
  assert.deepEqual(lean.steps.map(step=>Object.keys(step).sort()),[['data','revision','tool'],['data','revision','tool']]);
  assert.deepEqual(lean.steps.map(step=>step.data.done),['browser_navigate','browser_press_key']);assert.equal(lean.completed,2);
  const artifactStep=agentText({steps:[{index:0,tool:'browser_take_screenshot',operationId:'batch:x:0',receipt:{status:'completed'},artifacts:[{artifactId:'a1',sha256:'f'.repeat(64)}],data:{captured:true}}]});
  assert.deepEqual(artifactStep.steps[0],{tool:'browser_take_screenshot',artifacts:['a1'],data:{captured:true}});
  const plain={ok:true,elements:['tab-1-e1 button Save']};assert.equal(agentText(plain),plain);
});

test('server instructions stay short and keep every rule',()=>{
  assert.ok(BROWSER_INSTRUCTIONS.length<=1050,`${BROWSER_INSTRUCTIONS.length} chars`);
  for(const rule of [/visible browser/,/browser_tabs lists only yours/,/never take over a peer/,/dev server/,/automatically/,/tabId\+revision/,/full:true/,/selector/,/what changed \(effect\)/,/new page loads/,/visuals matter/,/browser_batch/,/never replay/i,/uncertain action/,/untrusted/,/project, profile or mode/,/browser_pause only if the user asks/,/observation works while paused/,/pauseReason/,/browser_resume/,/RECOVERY_PENDING/,/browser_close/,/Report errors accurately/,/desktop tools/])
    assert.match(BROWSER_INSTRUCTIONS,rule);
});
