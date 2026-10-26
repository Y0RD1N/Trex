import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { Artifacts, MAX_ARTIFACT, MAX_IMAGE, jsonRead, writePrivate, safePath, uploadSnapshot, childEnvironment } from './security.mjs';
import { validateArguments } from './tools.mjs';
import { guardBrowser } from './guard.mjs';

const bounded=(v,min,max,fallback)=>v===undefined?fallback:Math.min(max,Math.max(min,Number(v)));
const text=v=>String(v).slice(0,32768);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function abortableRead(promise,signal){
  if(signal.aborted)return Promise.reject(Object.assign(new Error('Read cancelled'),{code:'CANCELLED'}));
  return new Promise((resolve,reject)=>{const abort=()=>reject(Object.assign(new Error('Read cancelled'),{code:'CANCELLED'}));signal.addEventListener('abort',abort,{once:true});Promise.resolve(promise).then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));});
}
function imageDimensions(bytes,type){
  if(type==='png'&&bytes.length>=24)return {width:bytes.readUInt32BE(16),height:bytes.readUInt32BE(20)};
  if(type==='jpeg'){let offset=2;while(offset+9<bytes.length){if(bytes[offset++]!==0xff)break;let marker=bytes[offset++];while(marker===0xff)marker=bytes[offset++];if(marker===0xd9||marker===0xda)break;const size=bytes.readUInt16BE(offset);if(size<2||offset+size>bytes.length)break;if([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker))return {height:bytes.readUInt16BE(offset+3),width:bytes.readUInt16BE(offset+5)};offset+=size;}}
  return {};
}
export function detectBrowser() {
  const candidates=process.platform==='win32' ? [
    ['chrome',path.join(process.env.PROGRAMFILES||'C:\\Program Files','Google/Chrome/Application/chrome.exe')],
    ['chrome',path.join(process.env['PROGRAMFILES(X86)']||'C:\\Program Files (x86)','Google/Chrome/Application/chrome.exe')],
    ['chrome',path.join(process.env.LOCALAPPDATA||'','Google/Chrome/Application/chrome.exe')],
    ['msedge',path.join(process.env.PROGRAMFILES||'C:\\Program Files','Microsoft/Edge/Application/msedge.exe')],
    ['msedge',path.join(process.env['PROGRAMFILES(X86)']||'C:\\Program Files (x86)','Microsoft/Edge/Application/msedge.exe')],
  ] : process.platform==='darwin' ? [['chrome','/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],['msedge','/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']] : [['chrome','/opt/google/chrome/chrome'],['chromium','/usr/lib64/chromium-browser/chromium-browser'],['chromium','/usr/lib/chromium/chromium'],['chromium','/usr/lib/chromium-browser/chromium-browser'],['msedge','/opt/microsoft/msedge/msedge']];
  for(const [channel,executablePath] of candidates)try{if(fs.statSync(executablePath).isFile())return {available:true,channel,executablePath};}catch{}
  return {available:false,channel:null};
}
function navigateUrl(input){let u;try{u=new URL(input);}catch{throw new Error('Valid http(s) URL required');}if(!['http:','https:'].includes(u.protocol)||u.username||u.password)throw new Error('Only http(s) URLs without embedded credentials are allowed');return u.href;}
// Observation does not send input to a page. It remains available during a
// pause and cannot make an unrelated page action uncertain when it times out.
export function isObservation(name,args={}){
  return ['browser_frames','browser_snapshot','browser_take_screenshot','browser_network_requests','browser_network_body','browser_wait_for'].includes(name)
    || name==='browser_console_messages'&&!args.clear
    || name==='browser_tabs'&&(!args.action||args.action==='list')
    || name==='browser_artifact'&&!args.open;
}
const PAUSE_CONTROL=new Set(['browser_resume','browser_takeover','browser_artifact','browser_pause','browser_close','browser_stop_video','browser_stop_trace','browser_perf_stop','browser_cpu_profile_stop']);
function pausedError(s){return Object.assign(new Error(s.pauseReason==='manual'?'Page controls were paused explicitly. Observation, screenshots and logs remain available; resume only when the user is ready.':'A previous page action has an uncertain outcome. Observation remains available: inspect browser_snapshot/browser_take_screenshot, then the owner may call browser_resume. Do not replay the previous action.'),{code:'PAUSED'});}
export class BrowserService {
  constructor(home){this.home=home;this.artifacts=new Artifacts(home);this.sessions=new Map();this.operations=new Map();}
  profileDir(ctx){return path.join(this.home,'projects',ctx.projectId,ctx.profile);}
  profiles(ctx){const dir=path.join(this.home,'projects',ctx.projectId);safePath(dir,{allowMissing:true});if(!fs.existsSync(dir))return [];return fs.readdirSync(dir).filter(n=>/^BROWSER[1-9][0-9]?$/.test(n)).map(id=>({id,name:id,projectId:ctx.projectId,...jsonRead(path.join(dir,id,'profile.json'),{})}));}
  createProfile(ctx){const dir=this.profileDir(ctx);safePath(dir,{allowMissing:true});fs.mkdirSync(dir,{recursive:true,mode:0o700});const manifest=path.join(dir,'profile.json');if(!fs.existsSync(manifest))writePrivate(manifest,JSON.stringify({createdAt:new Date().toISOString()}));return this.profiles(ctx).find(p=>p.id===ctx.profile);}
  key(ctx){return `${ctx.projectId}/${ctx.profile}`;}
  state(ctx){const key=this.key(ctx);let s=this.sessions.get(key);if(!s){s={key,ctx,owner:null,generation:0,paused:false,pauseReason:null,pauseOperation:null,revision:0,tabs:new Map(),frames:new Map(),refs:new Map(),events:[],network:new Map(),capture:null,queue:Promise.resolve(),active:null};this.sessions.set(key,s);}return s;}
  pause(s,reason,op=null){
    // An interrupted action must not erase an explicit human pause.
    if(s.paused&&s.pauseReason==='manual'&&reason!=='manual')return;
    if(s.paused&&s.pauseReason==='runtime'&&reason==='uncertain')return;
    s.paused=true;s.pauseReason=reason;s.pauseOperation=op?{operationId:op.id,tool:op.name}:null;s.revision++;s.refs.clear();
  }
  unpause(s){s.paused=false;s.pauseReason=null;s.pauseOperation=null;}
  status(s,ctx){return {running:!!s.browser,paused:s.paused,pauseReason:s.paused?s.pauseReason:null,pauseOperation:s.paused?s.pauseOperation:null,pendingAction:s.active?{operationId:s.active.id,tool:s.active.name,cancelRequested:s.active.controller.signal.aborted}:null,observationAvailable:!s.supervisorError&&!s.closing,owner:s.owner===ctx.clientId?'self':s.owner?'other':null,generation:s.generation,capture:s.capture?{kind:s.capture.kind,startedAt:s.capture.startedAt}:null,tabs:s.tabs.size,...(s.supervisorError?{supervisorError:s.supervisorError}:{})};}
  async ensure(s,ctx){
    if(s.closing)throw Object.assign(new Error('This profile is closing; wait for browser_close to finish before reopening it.'),{code:'PROFILE_CLOSING'});
    if(s.opening)return s.opening;
    if(s.browser)return;
    const opening=this.open(s,ctx);s.opening=opening;
    try{await opening;}finally{if(s.opening===opening)s.opening=null;}
  }
  async open(s,ctx){
    if(s.guard){await s.guard.stop();s.guard=null;}
    const browser=detectBrowser();if(!browser.available)throw new Error('Install Google Chrome (or Microsoft Edge) before opening a browser');
    this.createProfile(ctx);const userData=path.join(this.profileDir(ctx),'user-data');safePath(userData,{allowMissing:true});
    s.startupStage='launch';s.browser=await chromium.launchPersistentContext(userData,{executablePath:browser.executablePath,headless:process.env.TREX_BROWSER_HEADLESS==='1',chromiumSandbox:true,acceptDownloads:true,viewport:{width:1280,height:800},timeout:20000,args:['--disable-component-update'],downloadsPath:path.join(this.home,'artifacts'),env:childEnvironment()});
    // A single owner owns Playwright/CDP. Never attach to a user's existing browser.
    try{s.guard=await guardBrowser(s.browser,browser.executablePath,phase=>{s.startupStage=phase;},error=>{s.supervisorError=error.message;this.pause(s,'runtime',s.active);s.active?.controller.abort();});s.supervisorError=null;}catch(e){const failed=s.browser;s.browser=null;this.pause(s,'runtime');failed.browser().close().catch(()=>{});throw Object.assign(new Error(`Owned browser supervisor could not establish control (${s.startupStage}); inspect the browser before resuming`),{code:'UNCERTAIN'});}
    s.browser.setDefaultTimeout(10000);s.browser.setDefaultNavigationTimeout(15000);
    s.browser.on('page',p=>this.attachPage(s,p));
    s.browser.on('close',()=>{s.browser=null;s.tabs.clear();s.refs.clear();s.capture=null;s.generation++;const guard=s.guard;if(guard){const timer=setTimeout(()=>guard.stop().then(()=>{if(s.guard===guard)s.guard=null;}).catch(()=>{}),3000);timer.unref();}});
    for(const p of s.browser.pages())this.attachPage(s,p);
    if(!s.tabs.size)this.attachPage(s,await s.browser.newPage());
    s.startupStage=null;
    if(!s.owner)s.owner=ctx.clientId;
  }
  attachPage(s,p){if([...s.tabs.values()].includes(p))return;const id=`tab-${++s.revision}`;s.tabs.set(id,p);s.selected||=id;
    p.on('close',()=>{s.tabs.delete(id);s.revision++;if(s.selected===id)s.selected=s.tabs.keys().next().value;});
    p.on('domcontentloaded',()=>{s.revision++;s.refs.clear();});
    p.on('framenavigated',()=>{s.revision++;s.refs.clear();});
    p.on('dialog',dialog=>{s.dialog={dialog,tabId:id,type:dialog.type(),message:text(dialog.message())};});
    p.on('console',m=>{s.events.push({kind:'console',type:m.type(),text:text(m.text()),tabId:id,at:Date.now()});if(s.events.length>300)s.events.shift();});
    p.on('pageerror',e=>{s.events.push({kind:'pageerror',text:text(e.message),tabId:id,at:Date.now()});if(s.events.length>300)s.events.shift();});
    p.on('request',r=>{const requestId=`req-${++s.requestSeq|| (s.requestSeq=1)}`;s.network.set(requestId,{request:r,meta:{requestId,url:text(r.url()),method:r.method(),resourceType:r.resourceType(),tabId:id,at:Date.now()}});if(s.network.size>300)s.network.delete(s.network.keys().next().value);});
    p.on('response',r=>{const entry=[...s.network.values()].find(x=>x.request===r.request());if(entry){entry.response=r;Object.assign(entry.meta,{status:r.status(),contentType:r.headers()['content-type']||'',contentLength:r.headers()['content-length']||null});}});
    p.on('download',download=>{const file=this.artifacts.temp();download.saveAs(file).then(async()=>{const stat=fs.statSync(file);if(stat.size>MAX_ARTIFACT){fs.rmSync(file,{force:true});return;}const meta=await this.artifacts.addFile(file,'application/octet-stream','download',s.ctx,{suggestedFilename:text(path.basename(download.suggestedFilename()))});s.events.push({kind:'download',artifact:meta,at:Date.now()});while(s.events.length>300)s.events.shift();}).catch(()=>{});});
  }
  page(s,args={}){const p=s.tabs.get(args.tabId||s.selected);if(!p)throw new Error('Tab not found; list browser_tabs');return p;}
  frame(s,args){const p=this.page(s,args);if(!args.frameId)return p.mainFrame();const f=s.frames.get(args.frameId);if(!f||f.page()!==p||f.isDetached())throw new Error('Frame is stale; list browser_frames');return f;}
  async locator(s,args){
    if(args.ref){if(args.revision!==s.revision)throw Object.assign(new Error('Stale snapshot revision; take a new browser_snapshot'),{code:'STALE_SNAPSHOT'});const ref=s.refs.get(args.ref);if(!ref)throw new Error('Unknown ref');if(ref.frame!==this.frame(s,args))throw new Error('Ref belongs to another frame');if(!await ref.handle.evaluate(e=>e.isConnected))throw new Error('Element is detached; refresh snapshot');const current=await ref.handle.evaluate(e=>e.outerHTML.slice(0,8192));if(current!==ref.fingerprint)throw Object.assign(new Error('Element changed; refresh snapshot'),{code:'STALE_SNAPSHOT'});return ref.handle;}
    const f=this.frame(s,args);let locator;
    if(args.role)locator=f.getByRole(args.role,{name:args.name,exact:true});else if(args.selector)locator=f.locator(args.selector);else throw new Error('An element ref/revision or explicit selector/role is required');
    if(await locator.count()!==1)throw new Error('Locator must identify exactly one element');return locator;
  }
  async cdp(s,p){s.cdps||=new Map();if(!s.cdps.has(p))s.cdps.set(p,await s.browser.newCDPSession(p));return s.cdps.get(p);}
  cancel(ctx,id){const op=this.operations.get(id);if(!op||op.finishedAt||op.ctx.projectId!==ctx.projectId||op.ctx.clientId!==ctx.clientId||op.ctx.profile!==ctx.profile)throw new Error('Active operation not found for this client/project/profile');op.controller.abort();return {operationId:id,cancelRequested:true};}
  async interrupt(s){
    if(!s.browser||!s.active)return;const op=s.active;
    if(!['browser_navigate','browser_navigate_back','browser_reload','browser_evaluate','browser_type','browser_press_key','browser_click'].includes(op.name))return;
    try{const p=this.page(s,op.args);const c=await this.cdp(s,p);await c.send('Page.stopLoading');if(op.name==='browser_evaluate')await c.send('Runtime.terminateExecution');}catch{}
  }
  async call(ctx,name,args,operationId,timeoutMs){
    validateArguments(name,args,ctx.mode);const s=this.state(ctx);
    if(name==='browser_cancel')return {data:this.cancel(ctx,args.operationId),artifacts:[]};
    if(name==='browser_status')return {data:{...this.status(s,ctx),dialog:s.dialog?{type:s.dialog.type,message:s.dialog.message,tabId:s.dialog.tabId,untrustedContent:true}:null},artifacts:[],generation:s.generation,revision:s.revision};
    if(s.closing&&name!=='browser_artifact')throw Object.assign(new Error('This profile is closing; wait for browser_close to finish before reopening it.'),{code:'PROFILE_CLOSING'});
    if(name==='browser_handle_dialog'){
      if(s.owner&&s.owner!==ctx.clientId)throw Object.assign(new Error('Only the current owner may handle a dialog'),{code:'OWNERSHIP'});
      if(!s.dialog)throw new Error('No pending dialog');const dialog=s.dialog;s.dialog=null;
      try{await abortableRead(args.accept?dialog.dialog.accept(args.promptText):dialog.dialog.dismiss(),AbortSignal.timeout(timeoutMs));}
      catch{ this.pause(s,'uncertain',{id:operationId,name});throw Object.assign(new Error('Dialog response is uncertain; inspect before resuming'),{code:'UNCERTAIN'}); }
      s.revision++;s.refs.clear();return {data:{handled:true},artifacts:[],generation:s.generation,revision:s.revision};
    }
    if(name==='browser_pause'){
      if(s.owner&&s.owner!==ctx.clientId)throw Object.assign(new Error('Only the current owner may pause'),{code:'OWNERSHIP'});
      this.pause(s,'manual');s.generation++;if(s.active)s.active.controller.abort();
      return {data:this.status(s,ctx),artifacts:[],generation:s.generation,revision:s.revision};
    }
    // Reject foreign mutations before they can wait behind an owner's action.
    if(s.owner&&s.owner!==ctx.clientId&&!['browser_status','browser_takeover','browser_artifact'].includes(name))throw Object.assign(new Error('Profile owned by another client; explicit browser_takeover required'),{code:'OWNERSHIP'});
    if(this.operations.has(operationId))throw Object.assign(new Error('Duplicate operationId: never replay automatically; inspect the previous receipt'),{code:'DUPLICATE_OPERATION'});
    const observation=isObservation(name,args);
    if(s.paused&&!observation&&!PAUSE_CONTROL.has(name))throw pausedError(s);
    if(name==='browser_resume'&&s.active?.controller.signal.aborted)throw Object.assign(new Error('The cancelled page action has not settled. Observation remains available. After inspecting, call browser_close to discard this execution, then explicitly navigate again. Do not replay the previous action.'),{code:'RECOVERY_PENDING'});
    const recoveryClose=name==='browser_close'&&s.paused;
    const recoveryTakeover=name==='browser_takeover'&&s.paused&&s.active?.controller.signal.aborted;
    if(recoveryClose)for(const pending of this.operations.values())if(!pending.observation&&!pending.finishedAt&&pending.ctx.projectId===ctx.projectId&&pending.ctx.profile===ctx.profile&&pending.ctx.clientId===ctx.clientId)pending.controller.abort();
    const controller=new AbortController();const op={id:operationId,ctx,controller,name,args,observation};this.operations.set(operationId,op);
    const cancelled=()=>Object.assign(new Error(!op.started?'Queued operation cancelled before execution':observation?'Observation cancelled or timed out; browser remains available. Retry this read with a new operationId.':'Operation cancelled or timed out; inspect with browser_snapshot or browser_take_screenshot, then browser_resume before a new action. Never replay the uncertain action.'),{code:!op.started?'CANCELLED':observation?(op.timedOut?'READ_TIMEOUT':'CANCELLED'):'UNCERTAIN'});
    const timer=setTimeout(()=>{op.timedOut=true;controller.abort();},timeoutMs);timer.unref();
    const execute=async()=>{
      if(controller.signal.aborted)throw Object.assign(new Error('Operation cancelled before execution'),{code:'CANCELLED'});
      if(s.closing&&name!=='browser_close'&&name!=='browser_artifact')throw Object.assign(new Error('This profile is closing; wait for browser_close to finish before reopening it.'),{code:'PROFILE_CLOSING'});
      if(s.paused&&!observation&&!PAUSE_CONTROL.has(name))throw pausedError(s);
      if(s.owner&&s.owner!==ctx.clientId&&!['browser_status','browser_takeover','browser_artifact'].includes(name))throw Object.assign(new Error('Profile owned by another client; explicit browser_takeover required'),{code:'OWNERSHIP'});
      op.started=true;if(!observation&&!recoveryTakeover)s.active=op;const abort=()=>{if(!observation){this.pause(s,'uncertain',op);this.interrupt(s).catch(()=>{});}};controller.signal.addEventListener('abort',abort,{once:true});
      try{const pending=this.execute(s,ctx,name,args,controller.signal);const result=observation?await abortableRead(pending,controller.signal):await pending;if(controller.signal.aborted)throw cancelled();if(observation&&name!=='browser_artifact'&&s.owner&&s.owner!==ctx.clientId)throw Object.assign(new Error('Browser ownership changed during observation'),{code:'OWNERSHIP'});return {...result,generation:s.generation,revision:s.revision};}
      catch(e){if(observation&&(controller.signal.aborted||e.name==='TimeoutError'))throw controller.signal.aborted?cancelled():Object.assign(new Error('Observation timed out; browser remains available. Retry the read with a new operationId.'),{code:'READ_TIMEOUT'});if(e.name==='TimeoutError'){this.pause(s,'uncertain',op);await this.interrupt(s);throw Object.assign(new Error('Browser action timed out and may have affected the page; inspect before resuming, do not replay'),{code:'UNCERTAIN'});}throw e;}
      finally{controller.signal.removeEventListener('abort',abort);if(s.active===op)s.active=null;}
    };
    // Page actions stay serialized; a hung action must not hide the page from
    // screenshots, snapshots, logs or status used to diagnose its outcome.
    const work=observation||recoveryClose||recoveryTakeover?execute():s.queue.then(execute);if(!observation&&!recoveryTakeover)s.queue=work.catch(()=>{});
    let rejectOnAbort;
    try{return await Promise.race([work,new Promise((_,reject)=>{rejectOnAbort=()=>{if(op.started&&!observation)this.pause(s,'uncertain',op);reject(cancelled());};controller.signal.addEventListener('abort',rejectOnAbort,{once:true});})]);}
    finally{clearTimeout(timer);controller.signal.removeEventListener('abort',rejectOnAbort);op.finishedAt=Date.now();if(this.operations.size>1000){for(const [id,old] of this.operations)if(old.finishedAt){this.operations.delete(id);if(this.operations.size<800)break;}}}
  }
  async execute(s,ctx,name,a,signal){
    const out=(data={},artifacts=[])=>({data,artifacts});
    if(name==='browser_status')return out(this.status(s,ctx));
    if(name==='browser_pause'){this.pause(s,'manual');s.generation++;return out(this.status(s,ctx));}
    if(name==='browser_resume'){if(s.owner&&s.owner!==ctx.clientId)throw new Error('Only owner may resume');if(s.supervisorError)throw Object.assign(new Error('Browser supervisor is unavailable; close this profile and reopen it before continuing.'),{code:'RUNTIME_UNAVAILABLE'});this.unpause(s);s.owner=ctx.clientId;s.generation++;return out(this.status(s,ctx));}
    if(name==='browser_takeover'){const pendingAction=s.active?.controller.signal.aborted;if(pendingAction)for(const pending of this.operations.values())if(pending.controller.signal!==signal&&!pending.observation&&!pending.finishedAt&&pending.ctx.projectId===ctx.projectId&&pending.ctx.profile===ctx.profile&&pending.ctx.clientId===s.owner)pending.controller.abort();s.owner=ctx.clientId;s.ctx=ctx;if(s.supervisorError)this.pause(s,'runtime');else if(!pendingAction)this.unpause(s);s.generation++;s.revision++;s.refs.clear();return out(this.status(s,ctx));}
    if(name==='browser_artifact')return this.artifact(ctx,a);
    if(name==='browser_close'){s.closing=true;try{let artifacts=[];if(s.capture)artifacts=(await this.stopCapture(s,ctx,s.capture.kind)).artifacts;if(s.opening)await s.opening;await this.closeProfile(s);s.owner=null;s.supervisorError=null;this.unpause(s);return out({closed:true,...this.status(s,ctx)},artifacts);}finally{s.closing=false;}}
    await this.ensure(s,ctx);signal.throwIfAborted();if(s.owner&&s.owner!==ctx.clientId)throw Object.assign(new Error('Profile owned by another client; explicit browser_takeover required'),{code:'OWNERSHIP'});const p=this.page(s,a);const actionDone=()=>{s.revision++;s.refs.clear();};
    switch(name){
      case 'browser_navigate': await p.goto(navigateUrl(a.url),{waitUntil:'domcontentloaded'});return out({url:p.url()});
      case 'browser_navigate_back': await p.goBack({waitUntil:'domcontentloaded'});return out({url:p.url()});
      case 'browser_reload': await p.reload({waitUntil:'domcontentloaded'});return out({url:p.url()});
      case 'browser_tabs':{
        if(a.action==='new'){const tab=await s.browser.newPage();this.attachPage(s,tab);s.selected=[...s.tabs].find(([,v])=>v===tab)[0];if(a.url)await tab.goto(navigateUrl(a.url),{waitUntil:'domcontentloaded'});}
        if(a.action==='select'){this.page(s,a);s.selected=a.tabId;await this.page(s).bringToFront();}
        if(a.action==='close')await this.page(s,a).close();
        return out({tabs:await Promise.all([...s.tabs].map(async([tabId,page])=>({tabId,url:page.url(),title:text(await page.title().catch(()=>'')),selected:tabId===s.selected}))),dialog:s.dialog?{type:s.dialog.type,message:s.dialog.message,tabId:s.dialog.tabId}:null});
      }
      case 'browser_frames':{s.frames.clear();const frames=p.frames().map((frame,i)=>{const frameId=`${[...s.tabs].find(([,v])=>v===p)[0]}-frame-${i}-${s.revision}`;s.frames.set(frameId,frame);return {frameId,url:frame.url(),name:frame.name(),main:frame===p.mainFrame()};});return out({frames});}
      case 'browser_handle_dialog':{if(!s.dialog)throw new Error('No pending dialog');const d=s.dialog;s.dialog=null;if(a.accept)await d.dialog.accept(a.promptText);else await d.dialog.dismiss();actionDone();return out({handled:true});}
      case 'browser_snapshot':{
        const f=this.frame(s,a),revision=s.revision,generation=s.generation,refs=new Map(),elements=[];const selector='a,button,input,textarea,select,[role],[tabindex],summary';const handles=await f.locator(selector).elementHandles();let published=false;
        try{
          for(const [i,handle] of handles.slice(0,500).entries()){signal.throwIfAborted();const ref=`e${i+1}`;const info=await handle.evaluate(e=>({tag:e.tagName.toLowerCase(),role:e.getAttribute('role'),name:(e.getAttribute('aria-label')||e.innerText||e.getAttribute('placeholder')||e.getAttribute('name')||'').slice(0,500),type:e.getAttribute('type'),fingerprint:e.outerHTML.slice(0,8192)})).catch(()=>null);if(info){refs.set(ref,{handle,frame:f,fingerprint:info.fingerprint});delete info.fingerprint;elements.push({ref,...info});}}
          const accessibility=await f.locator('body').ariaSnapshot({timeout:2500}).catch(()=>'');signal.throwIfAborted();if(s.revision!==revision||s.generation!==generation||s.owner!==ctx.clientId)throw Object.assign(new Error('Page or browser ownership changed while reading; take a new browser_snapshot'),{code:'STALE_SNAPSHOT'});
          s.revision++;s.refs=refs;published=true;return out({url:f.url(),revision:s.revision,accessibility:text(accessibility),elements,untrustedContent:true});
        }finally{if(!published)for(const handle of handles)handle.dispose?.().catch(()=>{});}
      }
      case 'browser_click':await (await this.locator(s,a)).click({button:a.button||'left',clickCount:bounded(a.clickCount,1,3,1),timeout:10000,noWaitAfter:true});actionDone();return out({clicked:true});
      case 'browser_hover':await (await this.locator(s,a)).hover({timeout:10000});return out({hovered:true});
      case 'browser_drag':{const src=await this.locator(s,{...a,...a.source}),dst=await this.locator(s,{...a,...a.destination});const from=await src.boundingBox(),to=await dst.boundingBox();if(!from||!to)throw new Error('Drag elements must be visible');await p.mouse.move(from.x+from.width/2,from.y+from.height/2);await p.mouse.down();try{await p.mouse.move(to.x+to.width/2,to.y+to.height/2,{steps:12});}finally{await p.mouse.up();}actionDone();return out({dragged:true});}
      case 'browser_mouse':{const button=a.button||'left';if(a.action==='move'||a.action==='click'){if(!Number.isFinite(a.x)||!Number.isFinite(a.y))throw new Error('x and y required');if(a.action==='move')await p.mouse.move(a.x,a.y,{steps:bounded(a.steps,1,100,1)});else await p.mouse.click(a.x,a.y,{button});}else if(a.action==='wheel')await p.mouse.wheel(a.deltaX||0,a.deltaY||0);else await p.mouse[a.action]({button});actionDone();return out({mouse:a.action});}
      case 'browser_press_key':await p.keyboard.press(a.key);actionDone();return out({pressed:a.key});
      case 'browser_type':{const loc=await this.locator(s,a);await loc.fill(a.text,{timeout:10000});if(a.submit)await loc.press('Enter',{timeout:10000});actionDone();return out({typed:true});}
      case 'browser_fill_form':{if(a.fields.length>50)throw new Error('Maximum 50 fields');for(const field of a.fields){if(signal.aborted)throw new Error('Cancelled');const loc=await this.locator(s,{...a,...field});if(typeof field.value==='boolean')await loc.setChecked(field.value,{timeout:10000});else await loc.fill(String(field.value??''),{timeout:10000});}actionDone();return out({filled:a.fields.length});}
      case 'browser_select_option':await (await this.locator(s,a)).selectOption(a.values,{timeout:10000});actionDone();return out({selected:true});
      case 'browser_evaluate':{if(a.function.length>32768)throw new Error('JavaScript limit 32 KiB');const data=await this.frame(s,a).evaluate(({source,arg})=>{const fn=(0,eval)(`(${source})`);if(typeof fn!=='function')throw new Error('function must be a JavaScript function expression');return fn(arg);},{source:a.function,arg:a.arg});actionDone();if(JSON.stringify(data)?.length>65536)throw new Error('Evaluation result exceeds 64 KiB');return out({value:data,untrustedContent:true});}
      case 'browser_resize':await p.setViewportSize({width:bounded(a.width,200,3840,1280),height:bounded(a.height,200,2160,800)});return out({viewport:p.viewportSize()});
      case 'browser_emulate':{if(a.colorScheme)await p.emulateMedia({colorScheme:a.colorScheme});if(a.offline!==undefined)await s.browser.setOffline(a.offline);const c=await this.cdp(s,p);if(a.cpuRate!==undefined)await c.send('Emulation.setCPUThrottlingRate',{rate:bounded(a.cpuRate,1,20,1)});if([a.latency,a.downloadThroughput,a.uploadThroughput].some(v=>v!==undefined))await c.send('Network.emulateNetworkConditions',{offline:a.offline||false,latency:bounded(a.latency,0,10000,0),downloadThroughput:bounded(a.downloadThroughput,-1,1e9,-1),uploadThroughput:bounded(a.uploadThroughput,-1,1e9,-1)});return out({emulated:true});}
      case 'browser_console_messages':{const events=s.events.slice(-bounded(a.limit,1,300,100));if(a.clear)s.events=[];return out({events,untrustedContent:true});}
      case 'browser_network_requests':return out({requests:[...s.network.values()].slice(-bounded(a.limit,1,300,100)).map(x=>x.meta),untrustedContent:true});
      case 'browser_network_body':{const entry=s.network.get(a.requestId);if(!entry)throw new Error('Request ID expired');let body;if(a.kind==='request'){body=entry.request.postDataBuffer()||Buffer.alloc(0);}else{if(!entry.response)throw new Error('Response unavailable');const headers=entry.response.headers();const len=Number(headers['content-length']);if(!Number.isFinite(len)||len<0||len>1024*1024||headers['content-encoding']&&headers['content-encoding']!=='identity')throw new Error('Response body requires uncompressed Content-Length <= 1 MiB');await abortableRead(entry.response.finished(),signal);if(signal.aborted)throw new Error('Read cancelled');body=await abortableRead(entry.response.body(),signal);}if(body.length>1024*1024)throw new Error('Body exceeds 1 MiB');return out({body:body.toString('utf8'),bytes:body.length,untrustedContent:true});}
      case 'browser_route':if(a.action==='clear')await s.browser.unrouteAll({behavior:'wait'});else {if(!a.url||a.url.length>2048||(a.body||'').length>1024*1024)throw new Error('Bounded URL and body required');await s.browser.route(a.url,route=>route.fulfill({status:bounded(a.status,100,599,200),body:a.body||'',contentType:a.contentType||'text/plain'}));}return out({mocked:a.action});
      case 'browser_file_upload':{if(a.paths.length>20)throw new Error('Maximum 20 upload files');const files=[];let total=0;for(const name of a.paths){const file=uploadSnapshot(ctx.cwd,name);total+=file.buffer.length;if(total>MAX_ARTIFACT)throw new Error('Combined uploads exceed 64 MiB');files.push(file);}await (await this.locator(s,a)).setInputFiles(files,{timeout:10000});actionDone();return out({uploaded:files.length});}
      case 'browser_take_screenshot':{const type=a.type||'png';const bytes=await p.screenshot({type,quality:type==='jpeg'?bounded(a.quality,1,100,80):undefined,fullPage:!!a.fullPage,clip:a.clip,timeout:10000});signal.throwIfAborted();if(bytes.length>MAX_IMAGE)throw new Error('Screenshot exceeds 4 MiB; choose JPEG, lower quality, viewport, or a smaller clip');const meta=await this.artifacts.add(bytes,`image/${type}`,'screenshot',ctx,imageDimensions(bytes,type));return {...out({captured:true},[meta]),image:{type:'image',mimeType:meta.mimeType,data:bytes.toString('base64')}};}
      case 'browser_start_video':return this.startCapture(s,ctx,'video',p,a);
      case 'browser_start_trace':return this.startCapture(s,ctx,'trace',p,a);
      case 'browser_perf_start':return this.startCapture(s,ctx,'perf',p,a);
      case 'browser_cpu_profile_start':return this.startCapture(s,ctx,'cpu',p,a);
      case 'browser_stop_video':return this.stopCapture(s,ctx,'video');
      case 'browser_stop_trace':return this.stopCapture(s,ctx,'trace');
      case 'browser_perf_stop':return this.stopCapture(s,ctx,'perf');
      case 'browser_cpu_profile_stop':return this.stopCapture(s,ctx,'cpu');
      case 'browser_heap_snapshot':{
        if(s.capture)throw new Error('Another capture is active');const c=await this.cdp(s,p);const file=this.artifacts.temp();const fd=fs.openSync(file,'wx',0o600);let size=0,overflow=false;const onChunk=({chunk})=>{size+=Buffer.byteLength(chunk);if(size<=MAX_ARTIFACT)fs.writeSync(fd,chunk);else overflow=true;};s.capture={kind:'heap',startedAt:new Date().toISOString()};c.on('HeapProfiler.addHeapSnapshotChunk',onChunk);try{await c.send('HeapProfiler.takeHeapSnapshot',{reportProgress:false});}finally{c.off('HeapProfiler.addHeapSnapshotChunk',onChunk);fs.closeSync(fd);s.capture=null;}if(overflow){fs.rmSync(file,{force:true});throw new Error('Heap exceeds 64 MiB limit');}const meta=await this.artifacts.addFile(file,'application/json','heap',ctx);return out({},[meta]);
      }
      case 'browser_wait_for':{const hasTarget=!!(a.text||a.selector||a.role||a.ref);if(!hasTarget&&a.time===undefined)throw new Error('A text, locator or time in seconds is required');const deadline=Date.now()+bounded(a.time!==undefined?a.time*1000:undefined,0,60000,10000);if(!hasTarget){while(Date.now()<deadline){if(signal.aborted)throw new Error('Cancelled');await sleep(Math.min(100,deadline-Date.now()));}return out({waited:true});}let handle,loc;
        if(a.ref){if(a.revision!==s.revision)throw Object.assign(new Error('Stale snapshot revision; refresh browser_snapshot'),{code:'STALE_SNAPSHOT'});const ref=s.refs.get(a.ref);if(!ref||ref.frame!==this.frame(s,a))throw new Error('Unknown or foreign-frame ref');handle=ref.handle;}
        else loc=a.text?this.frame(s,a).getByText(a.text,{exact:false}):a.role?this.frame(s,a).getByRole(a.role,{name:a.name,exact:true}):this.frame(s,a).locator(a.selector);
        while(Date.now()<=deadline){if(signal.aborted)throw new Error('Cancelled');const count=handle?(await handle.evaluate(e=>e.isConnected)?1:0):await loc.count();const visible=count>0&&(handle?await handle.isVisible():await loc.first().isVisible());if(a.state==='hidden'?!visible:a.state==='detached'?count===0:a.state==='attached'?count>0:visible)return out({matched:true});await sleep(100);}throw new Error('Wait timed out');}
      default:throw new Error('Unknown tool');
    }
  }
  async startCapture(s,ctx,kind,p,a){
    if(s.capture)throw new Error(`Capture ${s.capture.kind} is active; stop it first`);const file=this.artifacts.temp();const capture={kind,file,page:p,ctx,startedAt:new Date().toISOString()};s.capture=capture;
    try{
      if(kind==='video'){capture.size=p.viewportSize()||{width:1280,height:800};await p.screencast.start({path:file,size:capture.size});}
      if(kind==='trace')await s.browser.tracing.start({screenshots:false,snapshots:true,sources:false});
      if(kind==='perf'){const c=await this.cdp(s,p);capture.cdp=c;await c.send('Tracing.start',{transferMode:'ReturnAsStream',categories:'devtools.timeline,v8,blink.user_timing',options:'record-continuously'});}
      if(kind==='cpu'){const c=await this.cdp(s,p);capture.cdp=c;await c.send('Profiler.enable');await c.send('Profiler.start');}
      const duration=bounded(a.maxDurationMs,1000,120000,60000);capture.timer=setTimeout(()=>{if(s.capture===capture)this.stopCapture(s,ctx,kind).then(r=>{s.events.push({kind:'capture-finalized',artifacts:r.artifacts,at:Date.now()});while(s.events.length>300)s.events.shift();}).catch(()=>{});},duration);capture.timer.unref();
      capture.sizeTimer=setInterval(()=>{try{if(fs.statSync(file).size>MAX_ARTIFACT&&s.capture===capture)this.stopCapture(s,ctx,kind).catch(()=>{});}catch{}},1000);capture.sizeTimer.unref();
      return {data:{recording:true,kind,maxDurationMs:duration},artifacts:[]};
    }catch(e){s.capture=null;fs.rmSync(file,{force:true});throw e;}
  }
  async stopCapture(s,ctx,kind){
    const c=s.capture;if(!c||c.kind!==kind)throw new Error(`No active ${kind} capture`);if(c.stopping)throw new Error('Capture is finalizing');c.stopping=true;clearTimeout(c.timer);clearInterval(c.sizeTimer);
    try{
      if(kind==='video')await c.page.screencast.stop();
      if(kind==='trace')await s.browser.tracing.stop({path:c.file});
      if(kind==='cpu'){const {profile}=await c.cdp.send('Profiler.stop');writePrivate(c.file,JSON.stringify(profile));await c.cdp.send('Profiler.disable');}
      if(kind==='perf'){
        const stream=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Trace finalization timeout')),20000);c.cdp.once('Tracing.tracingComplete',e=>{clearTimeout(timer);resolve(e.stream);});});await c.cdp.send('Tracing.end');const handle=await stream;const fd=fs.openSync(c.file,'wx',0o600);let bytes=0;
        try{for(;;){const part=await c.cdp.send('IO.read',{handle,size:65536});const data=Buffer.from(part.data,part.base64Encoded?'base64':'utf8');bytes+=data.length;if(bytes>MAX_ARTIFACT)throw new Error('Trace exceeds 64 MiB');fs.writeSync(fd,data);if(part.eof)break;}}finally{fs.closeSync(fd);await c.cdp.send('IO.close',{handle});}
      }
      const mime=kind==='video'?'video/webm':kind==='trace'?'application/zip':'application/json';const meta=await this.artifacts.addFile(c.file,mime,kind,ctx,kind==='video'?{...c.size,durationMs:Date.now()-Date.parse(c.startedAt)}:{});return {data:{finalized:true,kind},artifacts:[meta]};
    }finally{s.capture=null;fs.rmSync(c.file,{force:true});}
  }
  async artifact(ctx,a){const {meta,file,bytes}=this.artifacts.get(a.artifactId,ctx);const result={data:{artifact:meta},artifacts:[meta]};
    if(a.open){const ext={'image/png':'.png','image/jpeg':'.jpg','video/webm':'.webm'}[meta.mimeType];if(!ext)throw new Error('Only generated PNG/JPEG/WebM artifacts may be opened');const openFile=`${file}${ext}`;safePath(openFile,{allowMissing:true});writePrivate(openFile,bytes);if(process.platform==='win32'){const explorer=path.join(process.env.SystemRoot||'C:\\Windows','explorer.exe');const child=spawn(explorer,[openFile],{windowsHide:true,stdio:'ignore'});child.on('error',()=>{});child.unref();}else{const child=spawn(process.platform==='darwin'?'/usr/bin/open':'/usr/bin/xdg-open',[openFile],{stdio:'ignore'});child.on('error',()=>{});child.unref();}result.data.opened=true;}
    if(a.read){if(bytes.length>MAX_IMAGE)throw new Error('Artifact read limit 4 MiB; use artifact-open for video');if(meta.mimeType.startsWith('image/'))result.image={type:'image',mimeType:meta.mimeType,data:bytes.toString('base64')};else if(meta.mimeType==='application/json')result.data.text=bytes.toString('utf8');else throw new Error('This artifact is metadata/open only');}return result;
  }
  async closeProfile(s){
    const context=s.browser,guard=s.guard;if(!context&&!guard)return;
    let closing=Promise.resolve();if(context){const browser=context.browser();closing=(browser?browser.close({reason:'Trex Browser profile stopped by its owner'}):context.close());}
    if(guard){await Promise.race([closing.catch(()=>{}),sleep(3000)]);try{await guard.stop();}catch(e){this.pause(s,'runtime',s.active);throw Object.assign(new Error(`Owned browser shutdown is uncertain (${e.message}); manual review required`),{code:'UNCERTAIN'});}if(s.guard===guard)s.guard=null;closing.catch(()=>{});s.browser=null;s.tabs.clear();s.refs.clear();}
    else await closing;
  }
  async shutdown(){await Promise.allSettled([...this.sessions.values()].map(async s=>{if(s.capture)try{await this.stopCapture(s,s.capture.ctx,s.capture.kind);}catch{}await this.closeProfile(s);}));}
}
