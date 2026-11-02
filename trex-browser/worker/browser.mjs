import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { Artifacts, MAX_ARTIFACT, MAX_IMAGE, jsonRead, writePrivate, safePath, uploadSnapshot, childEnvironment, sha256, saveTarget, writeNewFile } from './security.mjs';
import { validateArguments } from './tools.mjs';
import { guardBrowser } from './guard.mjs';
import { detectShell, ShellLink, describe, agentState, spaceLabel, readEngine, profileHolder } from './shell.mjs';

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
export function detectBrowser(engine='auto') {
  // The Trex shell (our own Electron browser) is preferred when installed,
  // unless the user chose the system Chrome in Trex settings.
  const shell=detectShell(engine);if(shell)return shell;
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
  if(name==='browser_batch')return Array.isArray(args.steps)&&args.steps.every(step=>isObservation(step.tool,step.arguments));
  return ['browser_frames','browser_snapshot','browser_take_screenshot','browser_network_requests','browser_network_body','browser_wait_for'].includes(name)
    || name==='browser_console_messages'&&!args.clear
    || name==='browser_tabs'&&(!args.action||args.action==='list')
    || name==='browser_artifact'&&!args.open;
}
// Page actions whose results carry a compact summary of what visibly changed.
const EFFECT_TOOLS=new Set(['browser_click','browser_type','browser_fill_form','browser_press_key','browser_select_option','browser_hover','browser_drag','browser_mouse','browser_navigate','browser_navigate_back','browser_reload','browser_file_upload','browser_handle_dialog','browser_evaluate']);
const PAUSE_CONTROL=new Set(['browser_resume','browser_takeover','browser_artifact','browser_pause','browser_close','browser_stop_video','browser_stop_trace','browser_perf_stop','browser_cpu_profile_stop']);
function pausedError(s){return Object.assign(new Error(s.pauseReason==='manual'?'Page controls were paused explicitly. Observation, screenshots and logs remain available; resume only when the user is ready.':'A previous page action has an uncertain outcome. Observation remains available: inspect browser_snapshot/browser_take_screenshot, then the owner may call browser_resume. Do not replay the previous action.'),{code:'PAUSED'});}
export class BrowserService {
  constructor(home){this.home=home;this.artifacts=new Artifacts(home);this.sessions=new Map();this.operations=new Map();}
  profileDir(ctx){return path.join(this.home,'projects',ctx.projectId,ctx.profile);}
  profiles(ctx){const dir=path.join(this.home,'projects',ctx.projectId);safePath(dir,{allowMissing:true});if(!fs.existsSync(dir))return [];return fs.readdirSync(dir).filter(n=>/^BROWSER[1-9][0-9]?$/.test(n)).map(id=>({id,name:id,projectId:ctx.projectId,...jsonRead(path.join(dir,id,'profile.json'),{})}));}
  createProfile(ctx){const dir=this.profileDir(ctx);safePath(dir,{allowMissing:true});fs.mkdirSync(dir,{recursive:true,mode:0o700});const manifest=path.join(dir,'profile.json');if(!fs.existsSync(manifest))writePrivate(manifest,JSON.stringify({createdAt:new Date().toISOString()}));return this.profiles(ctx).find(p=>p.id===ctx.profile);}
  key(ctx){return `${ctx.projectId}/${ctx.profile}`;}
  state(ctx){const key=this.key(ctx);let s=this.sessions.get(key);if(!s){s={key,ctx,owner:null,generation:0,paused:false,pauseReason:null,pauseOperation:null,revision:0,pageStates:new Map(),tabs:new Map(),frames:new Map(),refs:new Map(),events:[],network:new Map(),capture:null,queue:Promise.resolve(),active:null};this.sessions.set(key,s);}return s;}
  pageState(s,p){s.pageStates||=new Map();if(!s.pageStates.has(p))s.pageStates.set(p,{revision:0,refs:new Map(),frames:new Map()});return s.pageStates.get(p);}
  resultRevision(s,args,result){const page=s.tabs.get(args.tabId||s.selected);return result.data?.revision??(page?this.pageState(s,page).revision:s.revision);}
  retireRefs(s,refs){s.retiredRefs||=new Set();for(const ref of refs.values())s.retiredRefs.add(ref.handle);this.drainRefs(s);}
  drainRefs(s){if(s.refLeases)return;for(const handle of s.retiredRefs||[])handle.dispose?.().catch(()=>{});s.retiredRefs?.clear();}
  invalidate(s,p){const state=this.pageState(s,p);state.revision++;this.retireRefs(s,state.refs);state.refs.clear();s.revision++;}
  invalidateAll(s){for(const p of s.tabs.values())this.invalidate(s,p);s.refs.clear();s.frames.clear();}
  pause(s,reason,op=null){
    // An interrupted action must not erase an explicit human pause.
    if(s.paused&&s.pauseReason==='manual'&&reason!=='manual')return;
    if(s.paused&&s.pauseReason==='runtime'&&reason==='uncertain')return;
    s.paused=true;s.pauseReason=reason;s.pauseOperation=op?{operationId:op.id,tool:op.name}:null;s.revision++;this.invalidateAll(s);this.notifyShell(s);
  }
  unpause(s){s.paused=false;s.pauseReason=null;s.pauseOperation=null;this.notifyShell(s);}
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
    const browser=detectBrowser(readEngine(this.home));if(!browser.available)throw new Error('Install Google Chrome (or Microsoft Edge) before opening a browser');
    this.createProfile(ctx);const userData=path.join(this.profileDir(ctx),'user-data');safePath(userData,{allowMissing:true});
    if(profileHolder(userData))throw Object.assign(new Error('This profile is open in a person\'s Trex Browser window (sign-in). Ask the user to close that window, then navigate again.'),{code:'PROFILE_IN_USE'});
    const space=this.profiles(ctx).find(p=>p.id===ctx.profile)?.space;s.spaceLabel=spaceLabel(space?.label)||ctx.profile;s.spaceModel=typeof space?.model==='string'?space.model:'';s.spaceClientId=space?.clientId||null;
    // The shell sizes its own tab views; viewport emulation would desynchronise them.
    // Electron parents JS dialogs to its window; a hidden Wayland window cannot be
    // exported as a parent, so headless shell runs (tests/CI) use XWayland.
    const shellArgs=browser.shell&&process.env.TREX_BROWSER_HEADLESS==='1'&&process.platform==='linux'&&process.env.DISPLAY?['--ozone-platform=x11']:[];
    const shellEnv=browser.shell?{TREX_SPACE_LABEL:s.spaceLabel,TREX_PROJECT_LABEL:path.basename(ctx.cwd),...(process.env.TREX_BROWSER_DEV==='1'&&process.env.TREX_SHELL_DEV==='1'?{TREX_SHELL_DEV:'1'}:{})}:{};
    s.startupStage='launch';s.browser=await chromium.launchPersistentContext(userData,{executablePath:browser.executablePath,headless:process.env.TREX_BROWSER_HEADLESS==='1',chromiumSandbox:true,acceptDownloads:true,viewport:browser.shell?null:{width:1280,height:800},timeout:20000,args:['--disable-component-update',...shellArgs],downloadsPath:path.join(this.home,'artifacts'),env:{...childEnvironment(),...shellEnv}});
    s.cdps=new Map();s.networkConditions=new WeakMap();s.emulationOffline=false;
    // A single owner owns Playwright/CDP. Never attach to a user's existing browser.
    try{s.guard=await guardBrowser(s.browser,browser.executablePath,phase=>{s.startupStage=phase;},error=>{s.supervisorError=error.message;this.pause(s,'runtime',s.active);s.active?.controller.abort();});s.supervisorError=null;}catch(e){const failed=s.browser;s.browser=null;this.pause(s,'runtime');failed.browser().close().catch(()=>{});throw Object.assign(new Error(`Owned browser supervisor could not establish control (${s.startupStage}); inspect the browser before resuming`),{code:'UNCERTAIN'});}
    s.browser.setDefaultTimeout(10000);s.browser.setDefaultNavigationTimeout(15000);
    if(browser.shell){s.startupStage='shell';try{s.shell=await ShellLink.connect(s.browser,m=>this.shellEvent(s,m));}catch(e){const failed=s.browser;s.browser=null;failed.close().catch(()=>{});throw e;}}
    s.browser.on('page',p=>this.attachPage(s,p));
    s.browser.on('close',()=>{s.browser=null;s.shell=null;this.invalidateAll(s);s.tabs.clear();s.pageStates.clear();s.selected=null;s.refs.clear();s.capture=null;s.generation++;const guard=s.guard;if(guard){const timer=setTimeout(()=>guard.stop().then(()=>{if(s.guard===guard)s.guard=null;}).catch(()=>{}),3000);timer.unref();}});
    for(const p of s.browser.pages())this.attachPage(s,p);
    if(!s.tabs.size)this.attachPage(s,s.shell?await s.shell.newTab():await s.browser.newPage());
    s.startupStage=null;
    if(!s.owner)s.owner=ctx.clientId;
    this.notifyShell(s);
  }
  attachPage(s,p){if(s.shell?.isUi(p)||[...s.tabs.values()].includes(p))return;const id=`tab-${++s.revision}`;s.tabs.set(id,p);this.pageState(s,p);s.selected||=id;
    p.on('close',()=>{this.invalidate(s,p);s.tabs.delete(id);s.pageStates.delete(p);s.cdps?.delete(p);s.revision++;if(s.selected===id)s.selected=s.tabs.keys().next().value;});
    p.on('domcontentloaded',()=>this.invalidate(s,p));
    p.on('framenavigated',()=>this.invalidate(s,p));
    p.on('dialog',dialog=>{s.dialog={dialog,tabId:id,type:dialog.type(),message:text(dialog.message())};});
    p.on('console',m=>{s.events.push({kind:'console',type:m.type(),text:text(m.text()),tabId:id,at:Date.now()});if(s.events.length>300)s.events.shift();});
    p.on('pageerror',e=>{s.events.push({kind:'pageerror',text:text(e.message),tabId:id,at:Date.now()});if(s.events.length>300)s.events.shift();});
    p.on('request',r=>{const requestId=`req-${++s.requestSeq|| (s.requestSeq=1)}`;s.network.set(requestId,{request:r,meta:{requestId,url:text(r.url()),method:r.method(),resourceType:r.resourceType(),tabId:id,at:Date.now()}});if(s.network.size>300)s.network.delete(s.network.keys().next().value);});
    p.on('response',r=>{const entry=[...s.network.values()].find(x=>x.request===r.request());if(entry){entry.response=r;Object.assign(entry.meta,{status:r.status(),contentType:r.headers()['content-type']||'',contentLength:r.headers()['content-length']||null});}});
    p.on('download',download=>{
      // Tracked so browser_save_download can wait for it and the action's effect can name it.
      const name=text(path.basename(download.suggestedFilename())).slice(0,240);
      const entry={downloadId:`dl-${s.downloadSeq=(s.downloadSeq||0)+1}`,name,tabId:id,state:'progressing',at:Date.now()};
      s.downloads||=[];s.downloads.push(entry);while(s.downloads.length>50)s.downloads.shift();
      const file=this.artifacts.temp();
      entry.done=download.saveAs(file).then(async()=>{const stat=fs.statSync(file);if(stat.size>MAX_ARTIFACT){fs.rmSync(file,{force:true});throw new Error('Download exceeds 64 MiB');}const meta=await this.artifacts.addFile(file,'application/octet-stream','download',s.ctx,{suggestedFilename:name});entry.state='completed';entry.artifactId=meta.artifactId;entry.bytes=meta.bytes;s.events.push({kind:'download',artifact:meta,at:Date.now()});while(s.events.length>300)s.events.shift();})
        .catch(async e=>{entry.state='failed';entry.error=text(await download.failure().catch(()=>null)||e.message).slice(0,200);fs.rmSync(file,{force:true});});
    });
  }
  // ---- Trex shell: live agent state, agents center and human controls ----
  spaceClient(s){return s.spaceClientId||s.owner||s.ctx.profile;}
  displayLabel(label){return spaceLabel(label);}
  recordActivity(s,op){
    // Show what the agent targets by name, not by its internal ref.
    if(op.detail===undefined){const ref=op.args?.ref;let named='';if(ref)for(const state of (s.pageStates||new Map()).values()){const r=state.refs.get(ref);if(r?.name){named=r.name;break;}}op.detail=named||describe(op.name,op.args);}
    s.lastOp={name:op.name,args:op.args,at:Date.now(),detail:op.detail};
    if(!['browser_status','browser_artifact','browser_wait_for'].includes(op.name)){s.activity||=[];s.activity.push({id:op.id,at:Date.now(),tool:op.name,detail:op.detail});if(s.activity.length>20)s.activity.shift();}
    this.notifyShell(s);
  }
  notifyShell(s){
    clearTimeout(s.shellTimer);
    const state=agentState(s),op=s.active||s.lastOp;
    const tool=state==='working'?op?.name||'':state==='paused'||state==='review'?s.pauseOperation?.tool||'':'';
    s.shell?.push('setAgent',{label:s.spaceLabel||s.ctx.profile,model:s.spaceModel||'',state,tool,detail:state==='working'&&op?op.detail??describe(op.name,op.args):'',step:''});
    // Working decays to idle once no operation has run for a moment.
    if(state==='working'){s.shellTimer=setTimeout(()=>this.notifyShell(s),1600);s.shellTimer.unref?.();}
    this.pushSpaces(s.ctx.projectId);
  }
  pushSpaces(projectId){
    this.spacesTimers||=new Map();if(this.spacesTimers.has(projectId))return;
    const timer=setTimeout(async()=>{this.spacesTimers.delete(projectId);
      const sessions=[...this.sessions.values()].filter(x=>x.ctx.projectId===projectId);const shells=sessions.filter(x=>x.shell);if(!shells.length)return;
      const running=await Promise.all(sessions.map(async x=>{const p=x.tabs.get(x.selected);return {clientId:this.spaceClient(x),label:x.spaceLabel||x.ctx.profile,profile:x.ctx.profile,model:x.spaceModel||'',
        state:agentState(x),...(x.paused?{tool:x.pauseOperation?.tool||'',detail:''}:{tool:x.active?.name||x.lastOp?.name||'',detail:x.active||x.lastOp?(x.active||x.lastOp).detail??describe((x.active||x.lastOp).name,(x.active||x.lastOp).args):''}),
        tabCount:x.tabs.size,url:p&&!p.isClosed()?p.url():'',title:p&&!p.isClosed()?text(await p.title().catch(()=>'')).slice(0,200):'',thumbnail:x.thumbnail||null,events:(x.activity||[]).slice(-10)};}));
      const known=new Set(sessions.map(x=>x.ctx.profile));
      const idle=this.profiles(sessions[0].ctx).filter(p=>p.space&&!known.has(p.id)).map(p=>({clientId:p.space.clientId,label:spaceLabel(p.space.label),model:typeof p.space.model==='string'?p.space.model:'',profile:p.id,state:'closed',tabCount:0}));
      for(const x of shells)x.shell?.push('setSpaces',[...running,...idle].map(sp=>({...sp,self:sp.profile===x.ctx.profile})));
    },250);timer.unref?.();this.spacesTimers.set(projectId,timer);
  }
  /** Live thumbnails only while some agents center of the project is open. */
  thumbnails(projectId){
    this.thumbTimers||=new Map();const open=()=>[...this.sessions.values()].some(x=>x.ctx.projectId===projectId&&x.shell&&x.centerOpen);
    if(!open()){clearInterval(this.thumbTimers.get(projectId));this.thumbTimers.delete(projectId);return;}
    if(this.thumbTimers.has(projectId))return;
    const tick=async()=>{if(!open())return this.thumbnails(projectId);
      await Promise.all([...this.sessions.values()].filter(x=>x.ctx.projectId===projectId&&x.browser&&!x.centerOpen).map(async x=>{const p=x.tabs.get(x.selected);if(!p||p.isClosed())return;
        try{const jpeg=await p.screenshot({type:'jpeg',quality:45,scale:'css',timeout:2500});x.thumbnail=`data:image/jpeg;base64,${jpeg.toString('base64')}`;}catch{}}));
      this.pushSpaces(projectId);};
    tick();const timer=setInterval(tick,2500);timer.unref?.();this.thumbTimers.set(projectId,timer);
  }
  /** Host request (never an agent tool): raise a space's window, optionally on one tab. */
  async focusSpace(ctx,tabId=null){
    const s=this.sessions.get(this.key(ctx));
    if(!s?.browser)return {focused:false,reason:'closed'};
    if(!s.shell)return {focused:false,reason:'external-browser'};
    if(tabId){const p=s.tabs.get(tabId);if(!p)throw new Error('Tab not found');s.selected=tabId;await s.shell.select(p);}
    return {focused:!!await s.shell.focus()};
  }
  shellEvent(s,m){
    if(m?.type==='center'){s.centerOpen=!!m.open;this.thumbnails(s.ctx.projectId);return;}
    if(m?.type!=='control')return;
    const t=m.clientId==='self'?s:[...this.sessions.values()].find(x=>x.ctx.projectId===s.ctx.projectId&&this.spaceClient(x)===m.clientId);
    if(!t)return;
    // Human controls reuse the explicit pause semantics; uncertain pauses still need inspection by the owner.
    if(m.action==='pause'||m.action==='takeover'){if(!(t.paused&&t.pauseReason==='manual')){this.pause(t,'manual');t.generation++;}if(m.action==='takeover')t.shell?.focus();}
    else if(m.action==='resume'){if(t.paused&&t.pauseReason==='manual'&&!t.active?.controller.signal.aborted)this.unpause(t);}
    else if(m.action==='focus')t.shell?.focus();
    this.notifyShell(t);
  }
  page(s,args={}){const p=s.tabs.get(args.tabId||s.selected);if(!p)throw new Error('Tab not found; list browser_tabs');return p;}
  frame(s,args){const p=this.page(s,args);if(!args.frameId)return p.mainFrame();const f=this.pageState(s,p).frames.get(args.frameId);if(!f||f.page()!==p||f.isDetached())throw new Error('Frame is stale; list browser_frames');return f;}
  /** Resolves the target of a pointer/keyboard tool and shows the agent cursor there. */
  async locator(s,args){const target=await this.locate(s,args);this.pointAt(s,target);return target;}
  pointAt(s,target){
    if(!s.shell||!target?.boundingBox)return;
    Promise.race([target.boundingBox(),sleep(600).then(()=>null)]).then(box=>{if(box&&s.shell)s.shell.call('setCursor',{x:box.x+box.width/2,y:box.y+Math.min(box.height/2,24)}).catch(()=>{});}).catch(()=>{});
    // Selector-based actions: show the element's own text rather than the CSS selector.
    const op=s.active;if(op&&!op.args?.ref&&op.args?.selector&&op.detail===describe(op.name,op.args))
      Promise.race([target.evaluate(e=>(e.getAttribute('aria-label')||e.innerText||e.getAttribute('placeholder')||e.getAttribute('title')||e.getAttribute('name')||'').trim().replace(/\s+/g,' ').slice(0,60)),sleep(600).then(()=>'')])
        .then(name=>{if(name&&s.active===op){op.detail=name;if(s.lastOp)s.lastOp.detail=name;const last=s.activity?.at(-1);if(last?.id===op.id)last.detail=name;this.notifyShell(s);}}).catch(()=>{});
  }
  /** What a page action visibly changed, so the agent needs fewer follow-up reads. */
  async pageFacts(s,args){
    const p=s.tabs.get(args?.tabId||s.selected);
    return {page:p,url:p&&!p.isClosed()?p.url():'',title:p&&!p.isClosed()?await Promise.race([p.title(),sleep(300).then(()=>null)]).catch(()=>null):null,tabs:s.tabs.size,events:s.events.length,dialog:s.dialog,downloads:s.downloads?.length||0,downloadSeq:s.downloadSeq||0};
  }
  async effectOf(s,args,before){
    const after=await this.pageFacts(s,args),effect={};
    if(after.url&&after.url!==before.url){effect.navigated=true;effect.url=after.url;}
    if(after.title!=null&&before.title!=null&&after.title!==before.title)effect.title=text(after.title).slice(0,200);
    if(after.tabs!==before.tabs)effect.tabs=after.tabs;
    if(s.dialog&&s.dialog!==before.dialog)effect.dialog={type:s.dialog.type,message:s.dialog.message};
    const errors=s.events.slice(before.events).filter(e=>e.kind==='pageerror'||e.kind==='console'&&e.type==='error').map(e=>e.text.slice(0,200));
    if(errors.length)effect.consoleErrors=errors.slice(-3);
    const started=(s.downloads||[]).filter(d=>Number(d.downloadId.slice(3))>before.downloadSeq);
    if(started.length)effect.downloads=started.map(d=>({downloadId:d.downloadId,name:d.name,state:d.state}));
    return effect;
  }
  async locate(s,args){
    if(args.ref){const state=this.pageState(s,this.page(s,args));if(args.revision!==state.revision)throw Object.assign(new Error('Stale snapshot revision; take a new browser_snapshot'),{code:'STALE_SNAPSHOT'});const ref=state.refs.get(args.ref);if(!ref)throw new Error('Unknown ref');if(ref.frame!==this.frame(s,args))throw new Error('Ref belongs to another frame');if(!await ref.handle.evaluate(e=>e.isConnected))throw new Error('Element is detached; refresh snapshot');const current=await ref.handle.evaluate(e=>e.outerHTML.slice(0,8192));if(current!==ref.fingerprint)throw Object.assign(new Error('Element changed; refresh snapshot'),{code:'STALE_SNAPSHOT'});return ref.handle;}
    const f=this.frame(s,args);let locator;
    if(args.role)locator=f.getByRole(args.role,{name:args.name,exact:true});else if(args.selector)locator=f.locator(args.selector);else throw new Error('An element ref/revision or explicit selector/role is required');
    if(await locator.count()!==1)throw new Error('Locator must identify exactly one element');return locator;
  }
  async cdp(s,p){s.cdps||=new Map();if(!s.cdps.has(p))s.cdps.set(p,await s.browser.newCDPSession(p));return s.cdps.get(p);}
  cancel(ctx,id){const op=this.operations.get(id);if(!op||op.finishedAt||op.ctx.projectId!==ctx.projectId||op.ctx.clientId!==ctx.clientId||op.ctx.profile!==ctx.profile)throw new Error('Active operation not found for this client/project/profile');op.controller.abort();return {operationId:id,cancelRequested:true};}
  async interrupt(s){
    if(!s.browser||!s.active)return;const active=s.active,op={name:active.activeTool||active.name,args:active.activeArgs||active.args};
    if(!['browser_navigate','browser_navigate_back','browser_reload','browser_evaluate','browser_type','browser_press_key','browser_click'].includes(op.name))return;
    try{const p=this.page(s,op.args);const c=await this.cdp(s,p);if(op.name==='browser_evaluate'){await c.send('Runtime.terminateExecution');
      // terminateExecution also terminates the *next* script when none is running (an
      // evaluate awaiting fetch). Consume it before anything can resume that script;
      // otherwise its continuation is killed, its promise never settles and the
      // cancelled action never finishes. Only then stop loading, which aborts the fetch.
      await c.send('Runtime.evaluate',{expression:'void 0'}).catch(()=>{});}
      await c.send('Page.stopLoading');}catch{}
  }
  async call(ctx,name,args,operationId,timeoutMs){
    validateArguments(name,args,ctx.mode);
    if(name==='browser_batch')for(const step of args.steps)if(step.tool==='browser_navigate'||step.tool==='browser_tabs'&&step.arguments.url)navigateUrl(step.arguments.url);
    const s=this.state(ctx);
    if(name==='browser_cancel')return {data:this.cancel(ctx,args.operationId),artifacts:[]};
    if(name==='browser_status')return {data:{...this.status(s,ctx),dialog:s.dialog?{type:s.dialog.type,message:s.dialog.message,tabId:s.dialog.tabId,untrustedContent:true}:null},artifacts:[],generation:s.generation,revision:s.revision};
    if(s.closing&&name!=='browser_artifact')throw Object.assign(new Error('This profile is closing; wait for browser_close to finish before reopening it.'),{code:'PROFILE_CLOSING'});
    if(name==='browser_handle_dialog'){
      if(s.owner&&s.owner!==ctx.clientId)throw Object.assign(new Error('Only the current owner may handle a dialog'),{code:'OWNERSHIP'});
      if(!s.dialog)throw new Error('No pending dialog');const dialog=s.dialog;s.dialog=null;
      try{await abortableRead(args.accept?dialog.dialog.accept(args.promptText):dialog.dialog.dismiss(),AbortSignal.timeout(timeoutMs));}
      catch{ this.pause(s,'uncertain',{id:operationId,name});throw Object.assign(new Error('Dialog response is uncertain; inspect before resuming'),{code:'UNCERTAIN'}); }
      s.revision++;this.invalidateAll(s);return {data:{handled:true},artifacts:[],generation:s.generation,revision:s.revision};
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
    const cancelled=()=>Object.assign(new Error(!op.started?'Queued operation cancelled before execution':observation?'Observation cancelled or timed out; browser remains available. Retry this read with a new operationId.':'Operation cancelled or timed out; inspect with browser_snapshot or browser_take_screenshot, then browser_resume before a new action. Never replay the uncertain action.'),{code:!op.started?'CANCELLED':observation?(op.timedOut?'READ_TIMEOUT':'CANCELLED'):'UNCERTAIN',...(op.batchSteps?{batchSteps:op.batchSteps.map(step=>({...step}))}:{})});
    const timer=setTimeout(()=>{op.timedOut=true;controller.abort();},timeoutMs);timer.unref();
    const execute=async()=>{
      if(controller.signal.aborted)throw Object.assign(new Error('Operation cancelled before execution'),{code:'CANCELLED'});
      if(s.closing&&name!=='browser_close'&&name!=='browser_artifact')throw Object.assign(new Error('This profile is closing; wait for browser_close to finish before reopening it.'),{code:'PROFILE_CLOSING'});
      if(s.paused&&!observation&&!PAUSE_CONTROL.has(name))throw pausedError(s);
      if(s.owner&&s.owner!==ctx.clientId&&!['browser_status','browser_takeover','browser_artifact'].includes(name))throw Object.assign(new Error('Profile owned by another client; explicit browser_takeover required'),{code:'OWNERSHIP'});
      op.started=true;if(!observation&&!recoveryTakeover)s.active=op;this.recordActivity(s,op);const abort=()=>{if(!observation){this.pause(s,'uncertain',op);this.interrupt(s).catch(()=>{});}};controller.signal.addEventListener('abort',abort,{once:true});
      s.refLeases=(s.refLeases||0)+1;
      if(EFFECT_TOOLS.has(name)||name==='browser_batch')s.lastActionAt=Date.now();
      try{const before=EFFECT_TOOLS.has(name)&&s.browser?await this.pageFacts(s,args).catch(()=>null):null;
        const pending=this.execute(s,ctx,name,args,controller.signal,operationId);const result=observation?await abortableRead(pending,controller.signal):await pending;
        if(before&&result?.data&&typeof result.data==='object'&&!controller.signal.aborted){const effect=await this.effectOf(s,args,before).catch(()=>null);if(effect&&Object.keys(effect).length)result.data={...result.data,effect};}if(controller.signal.aborted)throw cancelled();if(observation&&name!=='browser_artifact'&&s.owner&&s.owner!==ctx.clientId)throw Object.assign(new Error('Browser ownership changed during observation'),{code:'OWNERSHIP'});return {...result,generation:s.generation,revision:this.resultRevision(s,args,result)};}
      catch(e){if(observation&&(controller.signal.aborted||e.name==='TimeoutError'))throw controller.signal.aborted?cancelled():Object.assign(new Error('Observation timed out; browser remains available. Retry the read with a new operationId.'),{code:'READ_TIMEOUT'});if(e.name==='TimeoutError'){this.pause(s,'uncertain',op);await this.interrupt(s);throw Object.assign(new Error('Browser action timed out and may have affected the page; inspect before resuming, do not replay'),{code:'UNCERTAIN',...(e.batchSteps?{batchSteps:e.batchSteps}:{})});}throw e;}
      finally{controller.signal.removeEventListener('abort',abort);if(s.active===op)s.active=null;s.refLeases--;this.drainRefs(s);this.notifyShell(s);}
    };
    // Page actions stay serialized; a hung action must not hide the page from
    // screenshots, snapshots, logs or status used to diagnose its outcome.
    const work=observation||recoveryClose||recoveryTakeover?execute():s.queue.then(execute);if(!observation&&!recoveryTakeover)s.queue=work.catch(()=>{});
    let rejectOnAbort;
    try{return await Promise.race([work,new Promise((_,reject)=>{rejectOnAbort=()=>{if(op.started&&!observation)this.pause(s,'uncertain',op);reject(cancelled());};controller.signal.addEventListener('abort',rejectOnAbort,{once:true});})]);}
    finally{clearTimeout(timer);controller.signal.removeEventListener('abort',rejectOnAbort);op.finishedAt=Date.now();if(this.operations.size>1000){for(const [id,old] of this.operations)if(old.finishedAt){this.operations.delete(id);if(this.operations.size<800)break;}}}
  }
  async executeBatch(s,ctx,args,signal,operationId){
    const op=this.operations.get(operationId),steps=[],artifacts=[];if(op)op.batchSteps=steps;
    let image,bytes=0;
    for(const [index,step] of args.steps.entries()){
      signal.throwIfAborted();
      const id=`batch:${sha256(operationId)}:${index}`,receipt={index,tool:step.tool,operationId:id,receipt:{status:'uncertain',manualReview:true,replaySafe:false}};
      const persist=()=>writePrivate(path.join(this.home,'receipts',`${sha256(id)}.json`),JSON.stringify({operationId:id,parentOperationId:operationId,name:step.tool,projectId:ctx.projectId,profile:ctx.profile,clientHash:sha256(ctx.clientId),at:new Date().toISOString(),receipt:receipt.receipt}));
      const prior=jsonRead(path.join(this.home,'receipts',`${sha256(id)}.json`),null);if(prior)throw Object.assign(new Error('Duplicate batch step; never replay automatically'),{code:'DUPLICATE_OPERATION',batchSteps:steps});
      steps.push(receipt);persist();if(op){op.activeTool=step.tool;op.activeArgs=step.arguments;}
      try{
        const result=await this.execute(s,ctx,step.tool,step.arguments,signal,id);signal.throwIfAborted();
        receipt.receipt={status:'completed',manualReview:false,replaySafe:false};persist();
        receipt.revision=this.resultRevision(s,step.arguments,result);
        receipt.artifacts=result.artifacts||[];artifacts.push(...receipt.artifacts);if(result.image)image=result.image;
        const size=Buffer.byteLength(JSON.stringify(result.data??{}));
        if(bytes+size>1024*1024){receipt.data={omitted:true,reason:'Batch text output limit'};throw new Error('Batch text output exceeds 1 MiB; request smaller reads');}
        bytes+=size;receipt.data=result.data;
      }catch(error){
        if(receipt.receipt.status!=='completed'){const uncertain=!isObservation(step.tool,step.arguments)&&(signal.aborted||error.name==='TimeoutError'||error.code==='UNCERTAIN');receipt.receipt={status:uncertain?'uncertain':'rejected',manualReview:uncertain,replaySafe:false};persist();}
        error.batchSteps=steps;throw error;
      }
    }
    return {data:{steps,completed:steps.length},artifacts,...(image?{image}:{})};
  }
  async execute(s,ctx,name,a,signal,operationId){
    // A snapshot that races a page navigation (SPA redirects, YouTube) is
    // re-read once the page settles. Ownership changes are never retried.
    if(name==='browser_snapshot'&&!a.__retry){
      for(let attempt=0;;attempt++){
        const generation=s.generation,owner=s.owner;
        try{return await this.execute(s,ctx,name,{...a,__retry:true},signal,operationId);}
        catch(e){if(attempt>=2||e.code!=='STALE_SNAPSHOT'||s.generation!==generation||s.owner!==owner||a.revision!==undefined)throw e;
          const p=s.tabs.get(a.tabId||s.selected);await p?.waitForLoadState('domcontentloaded',{timeout:3000}).catch(()=>{});await sleep(400);signal.throwIfAborted();}
      }
    }
    const out=(data={},artifacts=[])=>({data,artifacts});
    if(name==='browser_batch')return this.executeBatch(s,ctx,a,signal,operationId);
    if(name==='browser_status')return out(this.status(s,ctx));
    if(name==='browser_pause'){this.pause(s,'manual');s.generation++;return out(this.status(s,ctx));}
    if(name==='browser_resume'){if(s.owner&&s.owner!==ctx.clientId)throw new Error('Only owner may resume');if(s.supervisorError)throw Object.assign(new Error('Browser supervisor is unavailable; close this profile and reopen it before continuing.'),{code:'RUNTIME_UNAVAILABLE'});this.unpause(s);s.owner=ctx.clientId;s.generation++;return out(this.status(s,ctx));}
    if(name==='browser_takeover'){const pendingAction=s.active?.controller.signal.aborted;if(pendingAction)for(const pending of this.operations.values())if(pending.controller.signal!==signal&&!pending.observation&&!pending.finishedAt&&pending.ctx.projectId===ctx.projectId&&pending.ctx.profile===ctx.profile&&pending.ctx.clientId===s.owner)pending.controller.abort();s.owner=ctx.clientId;s.ctx=ctx;if(s.supervisorError)this.pause(s,'runtime');else if(!pendingAction)this.unpause(s);s.generation++;s.revision++;this.invalidateAll(s);return out(this.status(s,ctx));}
    if(name==='browser_artifact')return this.artifact(ctx,a);
    if(name==='browser_save_download')return this.saveDownload(s,ctx,a,signal);
    if(name==='browser_close'){s.closing=true;try{let artifacts=[];if(s.capture)artifacts=(await this.stopCapture(s,ctx,s.capture.kind)).artifacts;if(s.opening)await s.opening;await this.closeProfile(s);s.owner=null;s.supervisorError=null;this.unpause(s);return out({closed:true,...this.status(s,ctx)},artifacts);}finally{s.closing=false;}}
    await this.ensure(s,ctx);signal.throwIfAborted();if(s.owner&&s.owner!==ctx.clientId)throw Object.assign(new Error('Profile owned by another client; explicit browser_takeover required'),{code:'OWNERSHIP'});const p=this.page(s,a);const actionDone=()=>this.invalidate(s,p);
    switch(name){
      case 'browser_navigate': await p.goto(navigateUrl(a.url),{waitUntil:'domcontentloaded'});return out({url:p.url()});
      case 'browser_navigate_back': await p.goBack({waitUntil:'domcontentloaded'});return out({url:p.url()});
      case 'browser_reload': await p.reload({waitUntil:'domcontentloaded'});return out({url:p.url()});
      case 'browser_tabs':{
        if(a.action==='new'){const tab=s.shell?await s.shell.newTab():await s.browser.newPage();this.attachPage(s,tab);s.selected=[...s.tabs].find(([,v])=>v===tab)[0];if(a.url)await tab.goto(navigateUrl(a.url),{waitUntil:'domcontentloaded'});}
        if(a.action==='select'){this.page(s,a);s.selected=a.tabId;if(s.shell)await s.shell.select(this.page(s));else await this.page(s).bringToFront();}
        if(a.action==='close')await this.page(s,a).close();
        return out({tabs:await Promise.all([...s.tabs].map(async([tabId,page])=>({tabId,url:page.url(),title:text(await page.title().catch(()=>'')),selected:tabId===s.selected}))),dialog:s.dialog?{type:s.dialog.type,message:s.dialog.message,tabId:s.dialog.tabId}:null});
      }
      case 'browser_frames':{const state=this.pageState(s,p);state.frames.clear();const frames=p.frames().map((frame,i)=>{const frameId=`${[...s.tabs].find(([,v])=>v===p)[0]}-frame-${i}-${s.revision}`;state.frames.set(frameId,frame);return {frameId,url:frame.url(),name:frame.name(),main:frame===p.mainFrame()};});return out({frames});}
      case 'browser_handle_dialog':{if(!s.dialog)throw new Error('No pending dialog');const d=s.dialog;s.dialog=null;if(a.accept)await d.dialog.accept(a.promptText);else await d.dialog.dismiss();actionDone();return out({handled:true});}
      case 'browser_snapshot':{
        const state=this.pageState(s,p),f=this.frame(s,a),generation=s.generation,refs=new Map(),elements=[];let revision=state.revision;const selector='a,button,input,textarea,select,[role],[tabindex],summary';
        // Pages that navigate right after load (SPA redirects) destroy the context mid-read: retry briefly.
        const root=a.selector?f.locator(a.selector).first():f.locator('body');
        let handles;for(let attempt=0;;attempt++){try{handles=await (a.selector?root.locator(selector):f.locator(selector)).elementHandles();if(attempt)revision=state.revision;break;}catch(e){if(attempt>=3||!/context was destroyed|navigat/i.test(e.message))throw e;await p.waitForLoadState('domcontentloaded',{timeout:3000}).catch(()=>{});await sleep(250);signal.throwIfAborted();}}
        let published=false;
        try{
          for(const [i,handle] of handles.slice(0,500).entries()){signal.throwIfAborted();const ref=`${[...s.tabs].find(([,page])=>page===p)[0]}-e${i+1}`;const info=await handle.evaluate(e=>{
              // Visible and actionable: what a compact snapshot keeps (refs stay valid either way).
              let visible=true;
              try{const r=e.getBoundingClientRect(),st=getComputedStyle(e);visible=r.width>0&&r.height>0&&st.visibility!=='hidden'&&st.display!=='none'&&!e.closest('[aria-hidden="true"],[hidden],[inert]');}catch{}
              const tag=e.tagName.toLowerCase(),role=e.getAttribute('role'),type=e.getAttribute('type');
              const ACT=['button','link','checkbox','radio','switch','tab','menuitem','menuitemcheckbox','menuitemradio','option','combobox','textbox','searchbox','slider','spinbutton','treeitem'];
              const actionable=!e.disabled&&e.getAttribute('aria-disabled')!=='true'&&(role?ACT.includes(role):(tag==='a'&&!!e.hasAttribute?.('href'))||tag==='button'||tag==='select'||tag==='textarea'||tag==='summary'||(tag==='input'&&type!=='hidden')||!!e.isContentEditable);
              return {tag,role,name:(e.getAttribute('aria-label')||e.innerText||e.getAttribute('placeholder')||e.getAttribute('title')||e.getAttribute('name')||e.getAttribute('value')||'').slice(0,500),type,visible,actionable,fingerprint:e.outerHTML.slice(0,8192)};
            }).catch(()=>null);if(info){refs.set(ref,{handle,frame:f,fingerprint:info.fingerprint,name:text(info.name||'').trim().slice(0,80)});delete info.fingerprint;elements.push({ref,...info});}}
          const flags=new Map(elements.map(e=>[e.ref,{visible:e.visible,actionable:e.actionable}]));for(const e of elements){delete e.visible;delete e.actionable;}
          const accessibility=a.compact?'':await root.ariaSnapshot({timeout:2500}).catch(()=>'');signal.throwIfAborted();if(state.revision!==revision||s.generation!==generation||s.owner!==ctx.clientId)throw Object.assign(new Error('Page or browser ownership changed while reading; take a new browser_snapshot'),{code:'STALE_SNAPSHOT'});
          this.retireRefs(s,state.refs);state.revision++;state.refs=refs;published=true;let listed=elements,omitted=0;
          {
            // Keep only visible, actionable elements; named ones, or unnamed fields (inputs need no label to be typed into).
            const out=[];let last='';
            for(const e of elements){
              const f=flags.get(e.ref),name=(e.name||'').trim().replace(/\s+/g,' ').slice(0,80),field=['input','textarea','select'].includes(e.tag)||['textbox','searchbox','combobox'].includes(e.role);
              if(!f?.visible||!f?.actionable||(!name&&!field)){omitted++;continue;}
              const key=name||`#${e.ref}`;if(key===last){omitted++;continue;}last=key; // the same control repeated (button + link, thumbnail + title)
              // One line per element: "<ref> <kind> <name>" (JSON objects repeated keys on every element).
              out.push(`${e.ref} ${e.role||e.tag}${e.type&&e.type!=='submit'?`[${e.type}]`:''}${name?` ${name}`:''}`);
            }
            listed=out;
          }
          return out({tabId:[...s.tabs].find(([,page])=>page===p)[0],url:f.url(),revision:state.revision,...(a.compact?{compact:true,title:text(await p.title().catch(()=>'')).slice(0,200)}:{accessibility:text(accessibility).slice(0,16000),...(accessibility.length>16000?{truncated:'tree cut at 16000 chars: use selector to scope'}:{})}),omitted,elements:listed,untrustedContent:true});
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
      case 'browser_emulate':{
        if(a.colorScheme)await p.emulateMedia({colorScheme:a.colorScheme});
        if(a.offline!==undefined){await s.browser.setOffline(a.offline);s.emulationOffline=a.offline;}
        const c=await this.cdp(s,p);if(a.cpuRate!==undefined)await c.send('Emulation.setCPUThrottlingRate',{rate:bounded(a.cpuRate,1,20,1)});
        if(a.offline!==undefined||[a.latency,a.downloadThroughput,a.uploadThroughput].some(v=>v!==undefined)){
          s.networkConditions||=new WeakMap();
          const previous=s.networkConditions.get(p)||{latency:0,downloadThroughput:-1,uploadThroughput:-1};
          const next={latency:bounded(a.latency,0,10000,previous.latency),downloadThroughput:bounded(a.downloadThroughput,-1,1e9,previous.downloadThroughput),uploadThroughput:bounded(a.uploadThroughput,-1,1e9,previous.uploadThroughput)};
          s.networkConditions.set(p,next);
          // Context offline mode and custom CDP throttling are separate control
          // sessions. Keep them in agreement on every previously throttled tab;
          // otherwise navigator.onLine can be false while fetch still succeeds.
          for(const page of a.offline!==undefined?s.browser.pages():[p]){
            const conditions=s.networkConditions.get(page),session=page===p?c:s.cdps?.get(page);
            if(conditions&&session)await session.send('Network.emulateNetworkConditions',{...conditions,offline:s.emulationOffline===true});
          }
        }
        return out({emulated:true});
      }
      case 'browser_console_messages':{const events=s.events.slice(-bounded(a.limit,1,300,100));if(a.clear)s.events=[];return out({events,untrustedContent:true});}
      case 'browser_network_requests':{const STATIC=new Set(['image','font','stylesheet','media']);const all=[...s.network.values()].map(x=>x.meta);const kept=a.all?all:all.filter(m=>!STATIC.has(m.resourceType));
        const shortUrl=u=>u.length>160?u.slice(0,157)+'...':u;
        return out({requests:kept.slice(-bounded(a.limit,1,300,a.all?100:30)).map(({requestId,url,method,resourceType,status,contentType,tabId})=>({requestId,method,url:shortUrl(url),type:resourceType,...(status!==undefined?{status}:{}),...(contentType?{contentType:contentType.split(';')[0]}:{}),tabId})),...(kept.length<all.length?{skippedStatic:all.length-kept.length}:{}),untrustedContent:true});}
      case 'browser_network_body':{const entry=s.network.get(a.requestId);if(!entry)throw new Error('Request ID expired');let body;if(a.kind==='request'){body=entry.request.postDataBuffer()||Buffer.alloc(0);}else{if(!entry.response)throw new Error('Response unavailable');const headers=entry.response.headers();const len=Number(headers['content-length']);if(!Number.isFinite(len)||len<0||len>1024*1024||headers['content-encoding']&&headers['content-encoding']!=='identity')throw new Error('Response body requires uncompressed Content-Length <= 1 MiB');await abortableRead(entry.response.finished(),signal);if(signal.aborted)throw new Error('Read cancelled');body=await abortableRead(entry.response.body(),signal);}if(body.length>1024*1024)throw new Error('Body exceeds 1 MiB');return out({body:body.toString('utf8'),bytes:body.length,untrustedContent:true});}
      case 'browser_route':if(a.action==='clear')await s.browser.unrouteAll({behavior:'wait'});else {if(!a.url||a.url.length>2048||(a.body||'').length>1024*1024)throw new Error('Bounded URL and body required');await s.browser.route(a.url,route=>route.fulfill({status:bounded(a.status,100,599,200),body:a.body||'',contentType:a.contentType||'text/plain'}));}return out({mocked:a.action});
      case 'browser_file_upload':{if(a.paths.length>20)throw new Error('Maximum 20 upload files');const files=[];let total=0;for(const name of a.paths){const file=uploadSnapshot(ctx.cwd,name);total+=file.buffer.length;if(total>MAX_ARTIFACT)throw new Error('Combined uploads exceed 64 MiB');files.push(file);}await (await this.locator(s,a)).setInputFiles(files,{timeout:10000});actionDone();return out({uploaded:files.length});}
      case 'browser_take_screenshot':{const type=a.type||'png';let bytes;
        const vp=!a.fullPage&&!a.clip&&!a.fullResolution&&typeof p.evaluate==='function'?await p.evaluate(()=>({w:innerWidth,h:innerHeight})).catch(()=>null):null;
        if(vp&&vp.w>1024){const c=await this.cdp(s,p);const shot=await c.send('Page.captureScreenshot',{format:type,...(type==='jpeg'?{quality:bounded(a.quality,1,100,80)}:{}),clip:{x:0,y:0,width:vp.w,height:vp.h,scale:1024/vp.w},captureBeyondViewport:false});bytes=Buffer.from(shot.data,'base64');}
        else bytes=await p.screenshot({type,quality:type==='jpeg'?bounded(a.quality,1,100,80):undefined,fullPage:!!a.fullPage,clip:a.clip,timeout:10000});signal.throwIfAborted();if(bytes.length>MAX_IMAGE)throw new Error('Screenshot exceeds 4 MiB; choose JPEG, lower quality, viewport, or a smaller clip');const meta=await this.artifacts.add(bytes,`image/${type}`,'screenshot',ctx,imageDimensions(bytes,type));return {...out({captured:true},[meta]),image:{type:'image',mimeType:meta.mimeType,data:bytes.toString('base64')}};}
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
        if(a.ref){const state=this.pageState(s,p);if(a.revision!==state.revision)throw Object.assign(new Error('Stale snapshot revision; refresh browser_snapshot'),{code:'STALE_SNAPSHOT'});const ref=state.refs.get(a.ref);if(!ref||ref.frame!==this.frame(s,a))throw new Error('Unknown or foreign-frame ref');handle=ref.handle;}
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
  /** Copies a finished download into the workspace or an authorized folder (full mode). */
  async saveDownload(s,ctx,a,signal){
    const wait=bounded(a.wait,0,25,20)*1000,deadline=Date.now()+wait;
    const pause=async ms=>{await abortableRead(sleep(ms),signal);};
    let entry=null,name,bytes;
    if(a.artifactId){const got=this.artifacts.get(a.artifactId,ctx);if(got.meta.kind!=='download')throw new Error('Only download artifacts can be saved');name=got.meta.suggestedFilename;bytes=got.bytes;}
    else{
      // Without an id: the newest download, unless it is already saved or failed
      // (then wait for a new one). A download older than the last page action may
      // be stale while the one that action starts is still on its way: give it 2 s.
      const newest=()=>(s.downloads||[]).at(-1);
      const usable=d=>d&&!d.savedTo&&d.state!=='failed'?d:null;
      if(a.downloadId){entry=(s.downloads||[]).find(d=>d.downloadId===a.downloadId);if(!entry)throw new Error('Unknown downloadId for this browser');}
      else{
        const first=newest(),grace=Math.min(deadline,Date.now()+2000);
        if(!first||first.at<(s.lastActionAt||0))while(newest()===first&&Date.now()<grace)await pause(150);
        entry=usable(newest());
        while(!entry&&Date.now()<deadline){await pause(200);entry=newest()!==first?usable(newest()):null;}
      }
      if(!entry)throw Object.assign(new Error('No new download in this browser. Start it first (click its download button), then call browser_save_download.'),{code:'NO_DOWNLOAD'});
      if(entry.state==='progressing')await abortableRead(Promise.race([entry.done,sleep(Math.max(0,deadline-Date.now()))]),signal);
      if(entry.state==='progressing')return {data:{saved:false,downloadId:entry.downloadId,name:entry.name,state:'progressing',hint:'Still downloading; call browser_save_download again with this downloadId.'}};
      if(entry.state==='failed')throw new Error(`Download failed: ${entry.error||'unknown error'}`);
      const got=this.artifacts.get(entry.artifactId,ctx);name=entry.name;bytes=got.bytes;
    }
    const target=saveTarget({cwd:ctx.cwd,home:this.home,destination:a.destination,suggestedName:name});
    signal.throwIfAborted();
    const file=writeNewFile(target.dir,target.name,bytes);if(entry)entry.savedTo=file;
    return {data:{saved:true,path:file,name:path.basename(file),bytes:bytes.length,sha256:sha256(bytes),...(entry?{downloadId:entry.downloadId}:{})}};
  }
  async artifact(ctx,a){const {meta,file,bytes}=this.artifacts.get(a.artifactId,ctx);const result={data:{artifact:meta},artifacts:[meta]};
    if(a.open){const ext={'image/png':'.png','image/jpeg':'.jpg','video/webm':'.webm'}[meta.mimeType];if(!ext)throw new Error('Only generated PNG/JPEG/WebM artifacts may be opened');const openFile=`${file}${ext}`;safePath(openFile,{allowMissing:true});writePrivate(openFile,bytes);if(process.platform==='win32'){const explorer=path.join(process.env.SystemRoot||'C:\\Windows','explorer.exe');const child=spawn(explorer,[openFile],{windowsHide:true,stdio:'ignore'});child.on('error',()=>{});child.unref();}else{const child=spawn(process.platform==='darwin'?'/usr/bin/open':'/usr/bin/xdg-open',[openFile],{stdio:'ignore'});child.on('error',()=>{});child.unref();}result.data.opened=true;}
    if(a.read){if(bytes.length>MAX_IMAGE)throw new Error('Artifact read limit 4 MiB; use artifact-open for video');if(meta.mimeType.startsWith('image/'))result.image={type:'image',mimeType:meta.mimeType,data:bytes.toString('base64')};else if(meta.mimeType==='application/json')result.data.text=bytes.toString('utf8');else throw new Error('This artifact is metadata/open only');}return result;
  }
  async closeProfile(s){
    const context=s.browser,guard=s.guard;if(!context&&!guard)return;
    let closing=Promise.resolve();if(context){const browser=context.browser();closing=(browser?browser.close({reason:'Trex Browser profile stopped by its owner'}):context.close());}
    if(guard){await Promise.race([closing.catch(()=>{}),sleep(3000)]);try{await guard.stop();}catch(e){this.pause(s,'runtime',s.active);throw Object.assign(new Error(`Owned browser shutdown is uncertain (${e.message}); manual review required`),{code:'UNCERTAIN'});}if(s.guard===guard)s.guard=null;closing.catch(()=>{});s.browser=null;this.invalidateAll(s);s.tabs.clear();s.pageStates.clear();s.selected=null;s.refs.clear();}
    else await closing;
  }
  async shutdown(){await Promise.allSettled([...this.sessions.values()].map(async s=>{if(s.capture)try{await this.stopCapture(s,s.capture.ctx,s.capture.kind);}catch{}await this.closeProfile(s);}));}
}
