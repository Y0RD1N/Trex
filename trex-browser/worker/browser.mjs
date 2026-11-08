import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { SharedShell } from './shared-shell.mjs';
import { chromium } from 'playwright';
import { Artifacts, MAX_ARTIFACT, MAX_IMAGE, jsonRead, writePrivate, safePath, uploadSnapshot, childEnvironment, sha256, saveTarget, writeNewFile } from './security.mjs';
import { validateArguments } from './tools.mjs';
import { guardBrowser } from './guard.mjs';
import { detectShell, ShellLink, describe, agentState, spaceLabel, readEngine, profileHolder } from './shell.mjs';
import { flatten, compact, diff, line, candidates, clean, FIELDS } from './observe.mjs';

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
// Page actions that report what they changed; the refs they leave stay valid.
const REPORTED=new Set(['browser_click','browser_type','browser_fill_form','browser_press_key','browser_select_option','browser_hover','browser_drag','browser_mouse','browser_file_upload']);
// Aria refs carry their frame: e5 or, for another frame (or a later main document), f2e5.
const refPrefix=ref=>/^(f\d+)?/.exec(String(ref))[1]||'';
const stale=message=>Object.assign(new Error(message),{code:'STALE_SNAPSHOT'});
const NEW_PAGE='Stale revision: this tab loaded a new page; take a new browser_snapshot';
const escapeRegExp=v=>v.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
// A target resolved differently than asked (re-rendered ref, case-insensitive name) says so.
const noted=(target,data)=>target?.trexNote?{...data,note:target.trexNote}:data;
// Playwright's trial run performs the actionability checks without any input.
// A target that never becomes usable (behind a modal dialog or an overlay,
// hidden, disabled) then fails with certainty instead of as a timed-out action
// whose outcome is uncertain: nothing happened, so the page is not paused.
// Only fixed phrases leave this function: the call log quotes page markup.
// A field that cannot take the input (missing, hidden, disabled, read-only, or a select without the
// requested option) fails with certainty and names the reason; otherwise the 10 s fill/select timeout
// would pause the whole space as "uncertain" although nothing happened.
async function ensureFillable(target,verb,{values}={}){
  const fail=reason=>{throw Object.assign(new Error(`Nothing was ${verb}: ${reason}.`),{code:'NOT_ACTIONABLE'});};
  try{await target.waitFor({state:'visible',timeout:5000});}catch(e){if(e?.name!=='TimeoutError')throw e;fail('the element is missing or not visible after 5 s');}
  if(!await target.isEnabled({timeout:2000}).catch(()=>true))fail('it is disabled');
  if(values){
    const options=await target.evaluate(e=>e.tagName==='SELECT'?[...e.options].map(o=>({value:o.value,label:(o.label||o.text||'').trim()})):null).catch(()=>null);
    if(Array.isArray(options)){const known=new Set(options.flatMap(o=>[o.value,o.label]));const missing=values.filter(v=>!known.has(String(v)));
      if(missing.length)fail(`no option matches ${missing.map(v=>JSON.stringify(v)).join(', ')}. Options: ${options.slice(0,20).map(o=>JSON.stringify(o.label||o.value)).join(', ')}${options.length>20?', …':''}`);}
  }else if(!await target.isEditable({timeout:2000}).catch(()=>true))fail('it is read-only');
}
async function ensureActionable(target,action,options){
  try{await target[action]({...options,trial:true,timeout:10000});}
  catch(e){
    if(e?.name!=='TimeoutError')throw e;
    const log=String(e.message||'');
    const reason=/intercepts pointer events/.test(log)?'another element covers it (an open dialog, menu or overlay)'
      :/element is not visible/.test(log)?'it is not visible'
      :/element is not enabled/.test(log)?'it is disabled'
      :/element is not stable/.test(log)?'it kept moving'
      :'it never became usable within 10 s';
    const verb=action==='hover'?'hovered':'clicked';
    throw Object.assign(new Error(`Nothing was ${verb}: ${reason}. Close or finish what is in the way (for example an open dialog), or act inside it, then retry.`),{code:'NOT_ACTIONABLE'});
  }
}
const PAUSE_CONTROL=new Set(['browser_resume','browser_takeover','browser_artifact','browser_pause','browser_close','browser_stop_video','browser_stop_trace','browser_perf_stop','browser_cpu_profile_stop']);
function pausedError(s){return Object.assign(new Error(s.pauseReason==='manual'?'Page controls were paused explicitly. Observation, screenshots and logs remain available; resume only when the user is ready.':'A previous page action has an uncertain outcome. Observation remains available: inspect browser_snapshot/browser_take_screenshot, then the owner may call browser_resume. Do not replay the previous action.'),{code:'PAUSED'});}
export class BrowserService {
  constructor(home){this.home=home;this.artifacts=new Artifacts(home);this.sessions=new Map();this.operations=new Map();this.shellHosts=new Map();}
  profileDir(ctx){return path.join(this.home,'projects',ctx.projectId,ctx.profile);}
  profiles(ctx){const dir=path.join(this.home,'projects',ctx.projectId);safePath(dir,{allowMissing:true});if(!fs.existsSync(dir))return [];return fs.readdirSync(dir).filter(n=>/^BROWSER[1-9][0-9]?$/.test(n)).map(id=>({id,name:id,projectId:ctx.projectId,...jsonRead(path.join(dir,id,'profile.json'),{})}));}
  createProfile(ctx){const dir=this.profileDir(ctx);safePath(dir,{allowMissing:true});fs.mkdirSync(dir,{recursive:true,mode:0o700});const manifest=path.join(dir,'profile.json');if(!fs.existsSync(manifest))writePrivate(manifest,JSON.stringify({createdAt:new Date().toISOString()}));return this.profiles(ctx).find(p=>p.id===ctx.profile);}
  key(ctx){return `${ctx.projectId}/${ctx.profile}`;}
  state(ctx){const key=this.key(ctx);let s=this.sessions.get(key);if(!s){s={key,ctx,owner:null,generation:0,paused:false,pauseReason:null,pauseOperation:null,revision:0,pageStates:new Map(),tabs:new Map(),frames:new Map(),refs:new Map(),events:[],network:new Map(),capture:null,queue:Promise.resolve(),active:null};this.sessions.set(key,s);}return s;}
  pageState(s,p){s.pageStates||=new Map();if(!s.pageStates.has(p))s.pageStates.set(p,{revision:0,refs:new Map(),frames:new Map(),snap:null,doc:undefined});return s.pageStates.get(p);}
  resultRevision(s,args,result){const page=s.tabs.get(args.tabId||s.selected);return result.data?.revision??(page?this.pageState(s,page).revision:s.revision);}
  // Refs are Playwright aria refs: they live as long as their element. Only a new
  // document (or a pause, takeover or closed tab) invalidates them all.
  invalidate(s,p){const state=this.pageState(s,p);state.revision++;state.refs.clear();state.snap=null;state.doc=undefined;s.revision++;}
  invalidateAll(s){for(const p of s.tabs.values())this.invalidate(s,p);s.refs.clear();s.frames.clear();}
  tabIdOf(s,p){for(const [id,page] of s.tabs)if(page===p)return id;return null;}
  pushEvent(s,event){s.eventSeq=(s.eventSeq||0)+1;s.events.push({seq:s.eventSeq,...event,at:Date.now()});while(s.events.length>300)s.events.shift();}
  /** A new document restarts aria refs from e1, so every earlier ref goes stale. Its time origin identifies it. */
  newDocument(s,p,doc){const state=this.pageState(s,p);if(state.doc!==undefined&&state.doc!==doc)this.invalidate(s,p);state.doc=doc;}
  async checkDocument(s,p){const doc=await p.mainFrame().evaluate(()=>performance.timeOrigin);if([...s.tabs.values()].includes(p))this.newDocument(s,p,doc);return doc;}
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
    if(browser.shell){await this.openSharedShell(s,ctx,browser);return;}
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
  async applicationShell(browser){
    let slot=this.shellHosts.get('global');
    if(slot?.host?.closing){await slot.host.closing;if(this.shellHosts.get('global')===slot)this.shellHosts.delete('global');slot=null;}
    if(slot)return slot.promise;
    slot={};this.shellHosts.set('global',slot);
    slot.promise=SharedShell.launch({root:this.home,executablePath:browser.executablePath,artifacts:path.join(this.home,'artifacts'),projectLabel:'Trex Browser',
      onEvent:message=>{
        const origin=[...this.sessions.values()].find(state=>state.key===message?.profile)
          || [...this.sessions.values()].find(state=>state.sharedHost===slot.host);
        return origin?this.shellEvent(origin,message):undefined;
      },
      onFailure:error=>{for(const state of this.sessions.values())if(state.sharedHost===slot.host){state.supervisorError=error.message;this.pause(state,'runtime',state.active);state.active?.controller.abort();}},
      onClosed:host=>{if(this.shellHosts.get('global')===slot)this.shellHosts.delete('global');},
    }).then(host=>(slot.host=host)).catch(error=>{if(this.shellHosts.get('global')===slot)this.shellHosts.delete('global');throw error;});
    return slot.promise;
  }
  async openWindow(input){
    const browser=detectShell('auto');if(!browser)throw new Error('Trex Browser shell is not installed');
    let profile='personal',label='Personal',project='';
    if(input.personal!==true){
      const ctx=input.ctx,manifest=this.profiles(ctx).find(p=>p.id===ctx.profile);
      if(!manifest)return {opened:false,reason:'unknown-profile'};
      profile=this.key(ctx);label=spaceLabel(manifest.space?.label)||ctx.profile;project=path.basename(ctx.cwd);
    }
    const userData=profile==='personal'?path.join(this.home,'personal','user-data'):path.join(this.profileDir(input.ctx),'user-data');
    safePath(userData,{allowMissing:true});
    if(profileHolder(userData))throw Object.assign(new Error('Close the older separate Trex Browser window before opening this profile in the shared window.'),{code:'PROFILE_IN_USE'});
    const host=await this.applicationShell(browser);
    return host.openHuman({profile,label,project,url:input.url});
  }
  async openSharedShell(s,ctx,browser){
    s.startupStage='shared-window';const host=await this.applicationShell(browser);s.sharedHost=host;
    const scope=await host.open({profile:s.key,label:s.spaceLabel,project:path.basename(ctx.cwd),model:s.spaceModel,clientId:s.spaceClientId||ctx.clientId});
    s.browser=scope.context;s.shell=scope.link;s.supervisorError=null;
    s.cdps=new Map();s.networkConditions=new WeakMap();s.emulationOffline=false;
    const opened=s.browser;
    opened.on('page',page=>this.attachPage(s,page));
    opened.on('close',()=>{if(s.browser!==opened)return;s.browser=null;s.shell=null;this.invalidateAll(s);s.tabs.clear();s.pageStates.clear();s.selected=null;s.refs.clear();s.capture=null;s.generation++;});
    for(const page of opened.pages())this.attachPage(s,page);
    if(!s.tabs.size)this.attachPage(s,await s.shell.newTab());
    s.startupStage=null;if(!s.owner)s.owner=ctx.clientId;this.notifyShell(s);
  }
  attachPage(s,p){if(s.shell?.isUi(p)||[...s.tabs.values()].includes(p))return;const id=`tab-${++s.revision}`;s.tabs.set(id,p);this.pageState(s,p);s.selected||=id;
    p.on('close',()=>{this.invalidate(s,p);s.tabs.delete(id);s.pageStates.delete(p);s.cdps?.delete(p);s.revision++;if(s.selected===id)s.selected=s.tabs.keys().next().value;});
    // Same-document navigations keep refs; a new document drops them. A child
    // frame (ad, embed) restarts its own refs when it navigates: only those go.
    p.on('domcontentloaded',()=>{this.checkDocument(s,p).catch(()=>{});});
    p.on('framenavigated',frame=>{if(frame===p.mainFrame()){this.checkDocument(s,p).catch(()=>{});return;}const state=s.pageStates?.get(p);for(const [ref,entry] of state?.refs||[])if(refPrefix(entry.pw)!==(state.prefix??''))state.refs.delete(ref);});
    p.on('dialog',dialog=>{s.dialog={dialog,tabId:id,type:dialog.type(),message:text(dialog.message())};});
    p.on('console',m=>this.pushEvent(s,{kind:'console',type:m.type(),text:text(m.text()),tabId:id}));
    p.on('pageerror',e=>this.pushEvent(s,{kind:'pageerror',type:'pageerror',text:text(e.message),tabId:id}));
    p.on('request',r=>{const requestId=`req-${++s.requestSeq|| (s.requestSeq=1)}`;s.network.set(requestId,{request:r,meta:{requestId,url:text(r.url()),method:r.method(),resourceType:r.resourceType(),tabId:id,at:Date.now()}});if(s.network.size>300)s.network.delete(s.network.keys().next().value);});
    p.on('requestfailed',r=>{const entry=[...s.network.values()].find(x=>x.request===r);if(entry)entry.meta.failed=text(r.failure()?.errorText||'failed').slice(0,120);});
    p.on('response',r=>{const entry=[...s.network.values()].find(x=>x.request===r.request());if(entry){entry.response=r;Object.assign(entry.meta,{status:r.status(),contentType:r.headers()['content-type']||'',contentLength:r.headers()['content-length']||null});}});
    p.on('download',download=>{
      // Tracked so browser_save_download can wait for it and the action's effect can name it.
      const name=text(path.basename(download.suggestedFilename())).slice(0,240);
      const entry={downloadId:`dl-${s.downloadSeq=(s.downloadSeq||0)+1}`,name,tabId:id,state:'progressing',at:Date.now()};
      s.downloads||=[];s.downloads.push(entry);while(s.downloads.length>50)s.downloads.shift();
      const file=this.artifacts.temp();
      entry.done=download.saveAs(file).then(async()=>{const stat=fs.statSync(file);if(stat.size>MAX_ARTIFACT){fs.rmSync(file,{force:true});throw new Error('Download exceeds 64 MiB');}const meta=await this.artifacts.addFile(file,'application/octet-stream','download',s.ctx,{suggestedFilename:name});entry.state='completed';entry.artifactId=meta.artifactId;entry.bytes=meta.bytes;this.pushEvent(s,{kind:'download',artifact:meta});})
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
    this.spacesTimers||=new Map();if(this.spacesTimers.has('global'))return;
    const timer=setTimeout(async()=>{this.spacesTimers.delete('global');
      const sessions=[...this.sessions.values()].filter(x=>x.browser||x.opening);const shells=sessions.filter(x=>x.shell),host=this.shellHosts.get('global')?.host;if(!shells.length&&!host)return;
      const running=await Promise.all(sessions.map(async x=>{const p=x.tabs.get(x.selected);return {clientId:this.spaceClient(x),label:x.spaceLabel||x.ctx.profile,profile:x.key,project:path.basename(x.ctx.cwd),model:x.spaceModel||'',
        state:agentState(x),...(x.paused?{tool:x.pauseOperation?.tool||'',detail:''}:{tool:x.active?.name||x.lastOp?.name||'',detail:x.active||x.lastOp?(x.active||x.lastOp).detail??describe((x.active||x.lastOp).name,(x.active||x.lastOp).args):''}),
        tabCount:x.tabs.size,url:p&&!p.isClosed()?p.url():'',title:p&&!p.isClosed()?text(await p.title().catch(()=>'')).slice(0,200):'',thumbnail:x.thumbnail||null,events:(x.activity||[]).slice(-10)};}));
      if(host&&!host.closed&&!host.closing)host.link.push('setSpaces',running);
      else for(const x of shells)x.shell?.push('setSpaces',running.map(sp=>({...sp,self:sp.profile===x.key})));
    },250);timer.unref?.();this.spacesTimers.set('global',timer);
  }
  /** Live thumbnails only while the shared agents center is open. */
  thumbnails(projectId){
    this.thumbTimers||=new Map();const open=()=>[...this.sessions.values()].some(x=>x.shell&&x.centerOpen);
    if(!open()){clearInterval(this.thumbTimers.get('global'));this.thumbTimers.delete('global');return;}
    if(this.thumbTimers.has('global'))return;
    const tick=async()=>{if(!open())return this.thumbnails(projectId);
      await Promise.all([...this.sessions.values()].filter(x=>x.browser&&(!x.centerOpen||x.shell?.shared)).map(async x=>{const p=x.tabs.get(x.selected);if(!p||p.isClosed())return;
        try{const jpeg=await p.screenshot({type:'jpeg',quality:45,scale:'css',timeout:2500});x.thumbnail=`data:image/jpeg;base64,${jpeg.toString('base64')}`;}catch{}}));
      this.pushSpaces(projectId);};
    tick();const timer=setInterval(tick,2500);timer.unref?.();this.thumbTimers.set('global',timer);
  }
  /** Host request (never an agent tool): raise a space's window, optionally on one tab. */
  async focusSpace(ctx,tabId=null){
    const s=this.sessions.get(this.key(ctx));
    if(!s?.browser)return {focused:false,reason:'closed'};
    if(!s.shell)return {focused:false,reason:'external-browser'};
    if(tabId){const p=s.tabs.get(tabId);if(!p)throw new Error('Tab not found');s.selected=tabId;await s.shell.select(p);}
    return {focused:!!await s.shell.focus()};
  }
  async shellEvent(s,m){
    if(m?.type==='center'){for(const state of this.sessions.values())if(state===s||s.sharedHost&&state.sharedHost===s.sharedHost)state.centerOpen=!!m.open;this.thumbnails(s.ctx.projectId);return;}
    if(m?.type!=='control')return;
    const t=m.clientId==='self'?s:[...this.sessions.values()].find(x=>this.spaceClient(x)===m.clientId&&(!m.profile||x.key===m.profile));
    if(!t||!t.browser)throw new Error('Este espacio ya no está abierto. Actualiza el panel.');
    // Human controls reuse the explicit pause semantics; uncertain pauses still need inspection by the owner.
    if(m.action==='pause'||m.action==='takeover'){
      // Inspection must preserve uncertain/runtime pauses, never turn them into a resumable manual pause.
      if(!t.paused)this.pause(t,'manual');
      t.generation++;
      if(t.active&&!t.active.controller.signal.aborted)t.active.controller.abort();
      if(m.action==='takeover'&&!await t.shell?.focus())throw new Error('El espacio quedó pausado, pero no se pudo mostrar su ventana.');
    }
    else if(m.action==='resume'){
      if(t.supervisorError||t.paused&&t.pauseReason!=='manual')throw new Error('Este espacio requiere revisar la operación anterior antes de reanudarlo desde el agente.');
      if(t.active?.controller.signal.aborted)throw new Error('La acción anterior aún está terminando. Revisa el espacio antes de reanudar.');
      if(t.paused){this.unpause(t);t.generation++;}
    }
    else if(m.action==='focus'){
      if(!await t.shell?.focus())throw new Error('No se pudo mostrar la ventana de este espacio.');
    }
    else if(m.action==='screenshot'){
      const result=await this.call(t.ctx,'browser_take_screenshot',{type:'jpeg',quality:80},`shell-${randomUUID()}`,12000);
      return {ok:true,image:result.image};
    }
    else throw new Error('Acción del navegador no disponible.');
    this.notifyShell(t);
    return {ok:true,action:m.action};
  }
  page(s,args={}){const p=s.tabs.get(args.tabId||s.selected);if(!p)throw new Error('Tab not found; list browser_tabs');return p;}
  frame(s,args){const p=this.page(s,args);if(!args.frameId)return p.mainFrame();const f=this.pageState(s,p).frames.get(args.frameId);if(!f||f.page()!==p||f.isDetached())throw new Error('Frame is stale; list browser_frames');return f;}
  /** Resolves the target of a pointer/keyboard tool and shows the agent cursor there. */
  async locator(s,args,signal){const target=await this.locate(s,args,signal);this.pointAt(s,target);return target;}
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
    return {page:p,url:p&&!p.isClosed()?p.url():'',title:p&&!p.isClosed()?await Promise.race([p.title(),sleep(300).then(()=>null)]).catch(()=>null):null,tabs:s.tabs.size,eventSeq:s.eventSeq||0,dialog:s.dialog,downloads:s.downloads?.length||0,downloadSeq:s.downloadSeq||0};
  }
  async effectOf(s,args,before,reported){
    const after=await this.pageFacts(s,args),effect={};
    // A reported action already compared the page model (URL, title, new document).
    if(!reported&&after.url&&after.url!==before.url){effect.navigated=true;effect.url=after.url;}
    if(!reported&&after.title!=null&&before.title!=null&&after.title!==before.title)effect.title=text(after.title).slice(0,200);
    if(after.tabs!==before.tabs)effect.tabs=after.tabs;
    if(s.dialog&&s.dialog!==before.dialog)effect.dialog={type:s.dialog.type,message:s.dialog.message};
    const errors=s.events.filter(e=>e.seq>before.eventSeq).filter(e=>e.kind==='pageerror'||e.kind==='console'&&e.type==='error').map(e=>e.text.slice(0,200));
    if(errors.length)effect.consoleErrors=errors.slice(-3);
    const started=(s.downloads||[]).filter(d=>Number(d.downloadId.slice(3))>before.downloadSeq);
    if(started.length)effect.downloads=started.map(d=>({downloadId:d.downloadId,name:d.name,state:d.state}));
    return effect;
  }
  async locate(s,args,signal){
    const p=this.page(s,args);
    if(args.ref)return this.resolveRef(s,p,args,signal);
    const f=this.frame(s,args);let locator,count;
    if(args.role){
      locator=f.getByRole(args.role,{name:args.name,exact:true});count=await locator.count();
      // A name that differs only in letter case still names one element.
      if(!count&&args.name){const loose=f.getByRole(args.role,{name:new RegExp(`^\\s*${escapeRegExp(args.name.trim())}\\s*$`,'i')});if(await loose.count()===1){loose.trexNote=`matched name "${args.name}" ignoring case`;return loose;}}
    }else if(args.selector){locator=f.locator(args.selector);count=await locator.count();}
    else throw new Error('An element ref/revision or explicit selector/role is required');
    if(count===1)return locator;
    throw await this.targetError(s,p,args,locator,count,signal);
  }
  /** A target matching zero or several elements: the count and up to five candidates with fresh refs. */
  async targetError(s,p,args,locator,count,signal){
    const tabId=this.tabIdOf(s,p),lines=[];
    try{
      if(count>1)for(let i=0;i<Math.min(count,5);i++){const {entries}=flatten(await locator.nth(i).ariaSnapshotJSON({mode:'ai',timeout:1000}));if(entries[0])lines.push(line(entries[0],tabId));}
      // A whole-page read restores the refs those scoped reads replaced and finds look-alikes.
      const model=await this.observe(s,p,signal);
      if(!count)for(const entry of candidates(model.entries,{role:args.role,name:args.name??String(args.selector||'').replace(/[^\p{L}\p{N}]+/gu,' ')}))lines.push(line(entry,tabId));
    }catch(e){if(signal?.aborted)throw e;}
    const what=args.role?`Role ${args.role}${args.name!==undefined?` "${args.name}"`:''}`:`Selector ${args.selector}`;
    return new Error(`${what} matched ${count} elements; exactly one is required${lines.length?`. Candidates (revision ${this.pageState(s,p).revision}):\n${lines.join('\n')}`:''}`);
  }
  /** A ref from this document: still present, re-rendered (same role, name and position), or gone. */
  async resolveRef(s,p,args,signal){
    const state=this.pageState(s,p),tabId=this.tabIdOf(s,p),revision=args.revision;
    if(revision!==state.revision)throw stale(NEW_PAGE);
    if(!args.ref.startsWith(`${tabId}-`))throw new Error(`Ref ${args.ref} belongs to another tab; pass its tabId`);
    const entry=state.refs.get(args.ref);if(!entry)throw new Error(`Unknown ref ${args.ref}; take a browser_snapshot`);
    await this.checkDocument(s,p);if(state.revision!==revision)throw stale(NEW_PAGE);
    let target=p.getByRef(entry.pw);if(await target.count()===1)return target;
    // Not in the latest read (re-rendered, or a scoped read replaced the registry): read the page again.
    const model=await this.observe(s,p,signal);if(state.revision!==revision)throw stale(NEW_PAGE);
    target=p.getByRef(entry.pw);if(await target.count()===1)return target;
    // Re-rendered elements are matched by role, name and position, and only while
    // as many of them exist as before: a deleted row never redirects to the next one.
    const same=model.entries.filter(e=>e.role===entry.role&&e.name===entry.name);
    if(same.length===entry.of){const pick=same[entry.n];target=p.getByRef(pick.ref);target.trexNote=`${args.ref} was re-rendered; now ${tabId}-${pick.ref}`;return target;}
    const lines=(same.length?same:candidates(model.entries,{role:entry.role,name:entry.name})).slice(0,5).map(e=>line(e,tabId));
    throw stale(`Ref ${args.ref} (${entry.role}${entry.name?` "${entry.name}"`:''}) is gone; ${same.length} element${same.length===1?'':'s'} like it now${lines.length?`. Candidates:\n${lines.join('\n')}`:''}`);
  }
  /** Reads the page model (one AI aria snapshot of the frame tree) and registers its refs. */
  async observe(s,p,signal,{frameId,selector}={}){
    const state=this.pageState(s,p),tabId=this.tabIdOf(s,p),main=p.mainFrame(),f=frameId?this.frame(s,{tabId,frameId}):main;
    const generation=s.generation,owner=s.owner;
    const read=async()=>{
      const [doc,url,title]=await main.evaluate(()=>[performance.timeOrigin,location.href,document.title]);
      // A selector that matches nothing is a mistake of the caller, not a slow page: say so instead of timing out.
      if(selector&&await f.locator(selector).count().catch(()=>1)===0)throw Object.assign(new Error(`No element matches the selector ${JSON.stringify(String(selector).slice(0,120))}. Take a browser_snapshot without a selector to see the page.`),{code:'NOT_FOUND'});
      const tree=await (selector?f.locator(selector).first():f.locator('body')).ariaSnapshotJSON({mode:'ai',timeout:5000});
      if(await main.evaluate(()=>performance.timeOrigin)!==doc)throw stale('The page loaded a new document while being read');
      return {doc,url:f===main?url:f.url(),title:clean(title,200),tree};
    };
    // Pages that navigate right after load (SPA redirects) destroy the context mid-read: retry briefly.
    let got;
    for(let attempt=0;;attempt++){
      try{got=await read();break;}
      catch(e){if(attempt>=3||signal?.aborted||!(e.code==='STALE_SNAPSHOT'||/context was destroyed|navigat|detached/i.test(e.message)))throw e;
        await p.waitForLoadState('domcontentloaded',{timeout:3000}).catch(()=>{});await sleep(250);signal?.throwIfAborted();}
    }
    signal?.throwIfAborted();
    if(s.generation!==generation||s.owner!==owner)throw stale('Page or browser ownership changed while reading; take a new browser_snapshot');
    this.newDocument(s,p,got.doc);
    const model={doc:got.doc,url:got.url,title:got.title,revision:state.revision,...flatten(got.tree)};
    this.register(state,tabId,model.entries);
    if(!frameId){const root=(Array.isArray(got.tree)?got.tree[0]:got.tree)?.ref;if(root)state.prefix=refPrefix(root);}
    // A scoped read replaced that frame's ref registry: a whole-page read restores it.
    if(selector)await this.observe(s,p,signal);
    else if(!frameId)state.snap=model;
    return model;
  }
  register(state,tabId,entries){
    const counts=new Map(),key=e=>`${e.role}\n${e.name}`;
    for(const e of entries){e.n=counts.get(key(e))||0;counts.set(key(e),e.n+1);}
    for(const e of entries){const id=`${tabId}-${e.ref}`;state.refs.delete(id);state.refs.set(id,{pw:e.ref,role:e.role,name:e.name,n:e.n,of:counts.get(key(e))});}
    while(state.refs.size>5000)state.refs.delete(state.refs.keys().next().value);
  }
  /** required is not part of the aria snapshot: read it for listed fields, in parallel. */
  async fieldStates(p,entries){
    const extra=new Map();if(typeof p.getByRef!=='function')return extra;
    await Promise.all(entries.filter(e=>FIELDS.has(e.role)&&!e.framed).slice(0,60).map(async e=>{try{if(await p.getByRef(e.ref).evaluate(el=>!!(el.required||el.getAttribute('aria-required')==='true'),undefined,{timeout:1000}))extra.set(e.ref,['required']);}catch{}}));
    return extra;
  }
  dialogOpen(s,p){return !!s.dialog&&s.tabs.get(s.dialog.tabId)===p;}
  /** Waits up to about 1 s for an action's effects: a navigation it started, then a quiet DOM. */
  async settle(p,signal,ms=1000){
    const end=Date.now()+ms,left=()=>Math.max(0,end-Date.now());let navigating=false,loaded=false;
    const onRequest=r=>{try{if(r.isNavigationRequest()&&r.frame()===p.mainFrame())navigating=true;}catch{}},onLoad=()=>{loaded=true;};
    const quiet=()=>Promise.race([p.mainFrame().evaluate(limit=>new Promise(resolve=>{let timer;const finish=()=>{observer.disconnect();resolve();};const observer=new MutationObserver(()=>{clearTimeout(timer);timer=setTimeout(finish,150);});observer.observe(document,{subtree:true,childList:true,attributes:true,characterData:true});timer=setTimeout(finish,150);setTimeout(finish,limit);}),left()).catch(()=>{}),sleep(left())]);
    p.on('request',onRequest);p.on('domcontentloaded',onLoad);
    try{
      await quiet();
      if(navigating&&!loaded&&left())await new Promise(resolve=>{const done=()=>{clearTimeout(timer);p.off('domcontentloaded',done);resolve();},timer=setTimeout(done,left());p.on('domcontentloaded',done);});
      if(navigating&&left())await quiet();
    }finally{p.off('request',onRequest);p.off('domcontentloaded',onLoad);}
    signal?.throwIfAborted();
  }
  /** The model an action is compared with: what the agent last saw on this document. */
  async baseline(s,p,signal){
    const state=this.pageState(s,p);if(state.snap&&state.snap.revision===state.revision)return state.snap;
    try{return await this.observe(s,p,signal);}catch(e){if(signal?.aborted)throw e;return null;}
  }
  /** What an action changed: new elements with refs, removed count, changed values and states, new text, URL and title. */
  async report(s,p,signal,before){
    if(!before||this.dialogOpen(s,p))return null;
    await this.settle(p,signal);
    if(this.dialogOpen(s,p)||p.isClosed?.())return null;
    let after;try{after=await this.observe(s,p,signal);}catch(e){if(signal?.aborted)throw e;return null;}
    return diff(before,after,this.tabIdOf(s,p));
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
      catch(error){
        // The dialog may be gone already: the person answered it natively, or the page or the shell closed it.
        // Nothing is left to answer, so the outcome is known (not uncertain) and the space must not pause.
        if(/No dialog is showing|already handled/i.test(String(error?.message))){
          const p=s.tabs.get(dialog.tabId);
          return {data:{handled:false,alreadyClosed:true,note:'The dialog was already closed (answered by the person or closed by the page); your answer was not applied. Take a browser_snapshot to see the result.'},artifacts:[],generation:s.generation,revision:p?this.pageState(s,p).revision:s.revision};
        }
        this.pause(s,'uncertain',{id:operationId,name});
        throw Object.assign(new Error(`Dialog response is uncertain (${String(error?.message||error).split('\n')[0].slice(0,160)}); inspect before resuming`),{code:'UNCERTAIN'});
      }
      // An answer changes no document by itself: refs stay. Report what it changed (a confirm that deletes a row).
      const p=s.tabs.get(dialog.tabId),snap=p&&s.pageStates?.get(p)?.snap;
      const effect=snap?await Promise.race([this.report(s,p,AbortSignal.timeout(4000),snap).catch(()=>null),sleep(4000).then(()=>null)]):null;
      return {data:{handled:true,...(effect&&Object.keys(effect).length?{effect}:{})},artifacts:[],generation:s.generation,revision:p?this.pageState(s,p).revision:s.revision};
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
    const cancelled=()=>Object.assign(new Error(!op.started?'Queued operation cancelled before execution':observation?'Observation cancelled or timed out; browser remains available. Retry this read with a new operationId.':'Operation cancelled or timed out; inspect with browser_snapshot or browser_take_screenshot, then browser_resume before a new action. Never replay the uncertain action.'),{code:!op.started?'CANCELLED':observation?(op.timedOut?'READ_TIMEOUT':'CANCELLED'):'UNCERTAIN',...(op.batchSteps?{batchSteps:op.batchSteps.map(step=>({...step})),batchTools:args.steps.map(step=>step.tool)}:{})});
    const timer=setTimeout(()=>{op.timedOut=true;controller.abort();},timeoutMs);timer.unref();
    const execute=async()=>{
      if(controller.signal.aborted)throw Object.assign(new Error('Operation cancelled before execution'),{code:'CANCELLED'});
      if(s.closing&&name!=='browser_close'&&name!=='browser_artifact')throw Object.assign(new Error('This profile is closing; wait for browser_close to finish before reopening it.'),{code:'PROFILE_CLOSING'});
      if(s.paused&&!observation&&!PAUSE_CONTROL.has(name))throw pausedError(s);
      if(s.owner&&s.owner!==ctx.clientId&&!['browser_status','browser_takeover','browser_artifact'].includes(name))throw Object.assign(new Error('Profile owned by another client; explicit browser_takeover required'),{code:'OWNERSHIP'});
      op.started=true;if(!observation&&!recoveryTakeover)s.active=op;this.recordActivity(s,op);const abort=()=>{if(!observation){this.pause(s,'uncertain',op);this.interrupt(s).catch(()=>{});}};controller.signal.addEventListener('abort',abort,{once:true});
      if(EFFECT_TOOLS.has(name)||name==='browser_batch')s.lastActionAt=Date.now();
      try{const before=EFFECT_TOOLS.has(name)&&s.browser?await this.pageFacts(s,args).catch(()=>null):null;
        const pending=this.execute(s,ctx,name,args,controller.signal,operationId);const result=observation?await abortableRead(pending,controller.signal):await pending;
        if(before&&result?.data&&typeof result.data==='object'&&!controller.signal.aborted){const effect=await this.effectOf(s,args,before,result.reported).catch(()=>null);if(effect&&Object.keys(effect).length)result.data={...result.data,effect:{...effect,...result.data.effect}};}if(controller.signal.aborted)throw cancelled();if(observation&&name!=='browser_artifact'&&s.owner&&s.owner!==ctx.clientId)throw Object.assign(new Error('Browser ownership changed during observation'),{code:'OWNERSHIP'});return {...result,generation:s.generation,revision:this.resultRevision(s,args,result)};}
      catch(e){if(observation&&(controller.signal.aborted||e.name==='TimeoutError'))throw controller.signal.aborted?cancelled():Object.assign(new Error('Observation timed out; browser remains available. Retry the read with a new operationId.'),{code:'READ_TIMEOUT'});if(e.name==='TimeoutError'){this.pause(s,'uncertain',op);await this.interrupt(s);throw Object.assign(new Error('Browser action timed out and may have affected the page; inspect before resuming, do not replay'),{code:'UNCERTAIN',...(e.batchSteps?{batchSteps:e.batchSteps,batchTools:e.batchTools}:{})});}throw e;}
      finally{controller.signal.removeEventListener('abort',abort);if(s.active===op)s.active=null;this.notifyShell(s);}
    };
    // Page actions stay serialized; a hung action must not hide the page from
    // screenshots, snapshots, logs or status used to diagnose its outcome.
    const work=observation||recoveryClose||recoveryTakeover?execute():s.queue.then(execute);if(!observation&&!recoveryTakeover)s.queue=work.catch(()=>{});
    let rejectOnAbort;
    try{return await Promise.race([work,new Promise((_,reject)=>{rejectOnAbort=()=>{if(op.started&&!observation)this.pause(s,'uncertain',op);reject(cancelled());};controller.signal.addEventListener('abort',rejectOnAbort,{once:true});})]);}
    finally{clearTimeout(timer);controller.signal.removeEventListener('abort',rejectOnAbort);op.finishedAt=Date.now();if(this.operations.size>1000){for(const [id,old] of this.operations)if(old.finishedAt){this.operations.delete(id);if(this.operations.size<800)break;}}}
  }
  async executeBatch(s,ctx,args,signal,operationId){
    const op=this.operations.get(operationId),steps=[],artifacts=[],batchTools=args.steps.map(step=>step.tool);if(op)op.batchSteps=steps;
    let image,bytes=0;
    for(const [index,step] of args.steps.entries()){
      signal.throwIfAborted();
      const id=`batch:${sha256(operationId)}:${index}`,receipt={index,tool:step.tool,operationId:id,receipt:{status:'uncertain',manualReview:true,replaySafe:false}};
      const persist=()=>writePrivate(path.join(this.home,'receipts',`${sha256(id)}.json`),JSON.stringify({operationId:id,parentOperationId:operationId,name:step.tool,projectId:ctx.projectId,profile:ctx.profile,clientHash:sha256(ctx.clientId),at:new Date().toISOString(),receipt:receipt.receipt}));
      const prior=jsonRead(path.join(this.home,'receipts',`${sha256(id)}.json`),null);if(prior)throw Object.assign(new Error('Duplicate batch step; never replay automatically'),{code:'DUPLICATE_OPERATION',batchSteps:steps,batchTools});
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
        error.batchSteps=steps;error.batchTools=batchTools;throw error;
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
    // Inventory queries are passive. A fresh profile has no tabs until the
    // agent navigates, creates a tab, or requests another page operation.
    if(name==='browser_tabs'&&(!a.action||a.action==='list')&&!s.browser&&!s.opening)return out({tabs:[]});
    await this.ensure(s,ctx);signal.throwIfAborted();if(s.owner&&s.owner!==ctx.clientId)throw Object.assign(new Error('Profile owned by another client; explicit browser_takeover required'),{code:'OWNERSHIP'});// Closing the last tab left every tool failing with "Tab not found" (even new and list) until browser_close.
    // Listing and creating tabs do not need a current page, and navigating opens one when none is left.
    if(!s.tabs.size&&name==='browser_navigate'){const tab=s.shell?await s.shell.newTab():await s.browser.newPage();this.attachPage(s,tab);s.selected=[...s.tabs].find(([,v])=>v===tab)[0];}
    const tabsOnly=name==='browser_tabs'&&(!a.action||a.action==='list'||a.action==='new');
    const p=tabsOnly?s.tabs.get(a.tabId||s.selected)??null:this.page(s,a);
    const before=REPORTED.has(name)&&!this.dialogOpen(s,p)?await this.baseline(s,p,signal):null;
    const result=await this.act(s,ctx,name,a,signal,p,out);
    if(before&&result?.data){const effect=await this.report(s,p,signal,before);if(effect){result.reported=true;if(Object.keys(effect).length)result.data={...result.data,effect};}}
    return result;
  }
  async act(s,ctx,name,a,signal,p,out){
    switch(name){
      case 'browser_navigate': await p.goto(navigateUrl(a.url),{waitUntil:'domcontentloaded'});return out({url:p.url()});
      case 'browser_navigate_back': await p.goBack({waitUntil:'domcontentloaded'});return out({url:p.url()});
      case 'browser_reload': await p.reload({waitUntil:'domcontentloaded'});return out({url:p.url()});
      case 'browser_tabs':{
        if(a.action==='new'){const destination=a.url?navigateUrl(a.url):null;const tab=s.shell?await s.shell.newTab():await s.browser.newPage();this.attachPage(s,tab);s.selected=[...s.tabs].find(([,v])=>v===tab)[0];if(destination)await tab.goto(destination,{waitUntil:'domcontentloaded'});}
        if(a.action==='select'){this.page(s,a);s.selected=a.tabId;if(s.shell)await s.shell.select(this.page(s));else await this.page(s).bringToFront();}
        if(a.action==='close')await this.page(s,a).close();
        return out({tabs:await Promise.all([...s.tabs].map(async([tabId,page])=>({tabId,url:page.url(),title:text(await page.title().catch(()=>'')),selected:tabId===s.selected}))),dialog:s.dialog?{type:s.dialog.type,message:s.dialog.message,tabId:s.dialog.tabId}:null});
      }
      case 'browser_frames':{const state=this.pageState(s,p);state.frames.clear();const frames=p.frames().map((frame,i)=>{const frameId=`${[...s.tabs].find(([,v])=>v===p)[0]}-frame-${i}-${s.revision}`;state.frames.set(frameId,frame);return {frameId,url:frame.url(),name:frame.name(),main:frame===p.mainFrame()};});return out({frames});}
      case 'browser_handle_dialog':{if(!s.dialog)throw new Error('No pending dialog');const d=s.dialog;s.dialog=null;if(a.accept)await d.dialog.accept(a.promptText);else await d.dialog.dismiss();return out({handled:true});}
      case 'browser_snapshot':{
        // The element list by default; full:true (or compact:false) adds the aria tree for reading.
        const full=a.full===true||a.full===undefined&&a.compact===false,f=this.frame(s,a),tabId=this.tabIdOf(s,p);
        // The plain tree first: any aria read replaces the frame's ref registry, and the model read restores it.
        const accessibility=full?await (a.selector?f.locator(a.selector).first():f.locator('body')).ariaSnapshot({timeout:2500}).catch(()=>''):'';signal.throwIfAborted();
        const model=await this.observe(s,p,signal,{frameId:a.frameId,selector:a.selector});
        const {lines,omitted,more}=compact(model.entries,tabId,{extra:await this.fieldStates(p,model.entries)});
        return out({tabId,url:model.url,title:model.title,revision:this.pageState(s,p).revision,...(full?{accessibility:text(accessibility).slice(0,16000),...(accessibility.length>16000?{truncated:'tree cut at 16000 chars: use selector to scope'}:{})}:{}),...(omitted?{omitted}:{}),elements:lines,...(more?{more:`${more} more elements: scope with selector`}:{}),untrustedContent:true});
      }
      case 'browser_click':{const target=await this.locator(s,a,signal),options={button:a.button||'left',clickCount:bounded(a.clickCount,1,3,1)};await ensureActionable(target,'click',options);signal.throwIfAborted();await target.click({...options,timeout:10000,noWaitAfter:true});return out(noted(target,{clicked:true}));}
      case 'browser_hover':{const target=await this.locator(s,a,signal);await ensureActionable(target,'hover',{});signal.throwIfAborted();await target.hover({timeout:10000});return out(noted(target,{hovered:true}));}
      case 'browser_drag':{const src=await this.locator(s,{...a,...a.source},signal),dst=await this.locator(s,{...a,...a.destination},signal);await src.scrollIntoViewIfNeeded({timeout:5000}).catch(()=>{});const from=await src.boundingBox();if(!from)throw new Error('Drag elements must be visible');await p.mouse.move(from.x+from.width/2,from.y+from.height/2);await p.mouse.down();try{await dst.scrollIntoViewIfNeeded({timeout:5000}).catch(()=>{});const to=await dst.boundingBox();if(!to)throw new Error('Drag elements must be visible');await p.mouse.move(to.x+to.width/2,to.y+to.height/2,{steps:12});}finally{await p.mouse.up();}return out({dragged:true});}
      case 'browser_mouse':{const button=a.button||'left';if(a.action==='move'||a.action==='click'){if(!Number.isFinite(a.x)||!Number.isFinite(a.y))throw new Error('x and y required');if(a.action==='move')await p.mouse.move(a.x,a.y,{steps:bounded(a.steps,1,100,1)});else await p.mouse.click(a.x,a.y,{button});}else if(a.action==='wheel')await p.mouse.wheel(a.deltaX||0,a.deltaY||0);else await p.mouse[a.action]({button});return out({mouse:a.action});}
      case 'browser_press_key':await p.keyboard.press(a.key);return out({pressed:a.key});
      // Inputs are read back: masks, maxlength or page scripts can store something else.
      case 'browser_type':{const target=await this.locator(s,a,signal);await ensureFillable(target,'typed');signal.throwIfAborted();await target.fill(a.text,{timeout:10000});const mismatch=await this.readBack(target,a.text);if(a.submit)await target.press('Enter',{timeout:10000});return out(noted(target,{typed:true,...(mismatch?{mismatch}:{})}));}
      case 'browser_fill_form':{if(a.fields.length>50)throw new Error('Maximum 50 fields');const mismatches=[];for(const [index,field] of a.fields.entries()){if(signal.aborted)throw new Error('Cancelled');const target=await this.locator(s,{...a,...field},signal);const kind=await target.evaluate(e=>({tag:e.tagName,type:e.type})).catch(()=>({}));await ensureFillable(target,'filled',kind.tag==='SELECT'?{values:[String(field.value??'')]}:{});const flag=typeof field.value==='boolean'?field.value:(kind.type==='checkbox'||kind.type==='radio')&&/^(true|false|on|off|1|0|yes|no)$/i.test(String(field.value))?/^(true|on|1|yes)$/i.test(String(field.value)):undefined;if(flag!==undefined)await target.setChecked(flag,{timeout:10000});else if(kind.tag==='SELECT')await target.selectOption(String(field.value??''),{timeout:10000});else await target.fill(String(field.value??''),{timeout:10000});const mismatch=await this.readBack(target,flag!==undefined?flag:String(field.value??''));if(mismatch)mismatches.push({field:index,...mismatch});}return out({filled:a.fields.length,...(mismatches.length?{mismatches}:{})});}
      case 'browser_select_option':{const target=await this.locator(s,a,signal);await ensureFillable(target,'selected',{values:a.values});signal.throwIfAborted();await target.selectOption(a.values,{timeout:10000});const selected=await target.evaluate(e=>e.selectedOptions?[...e.selectedOptions].map(o=>(o.label||o.text||'').trim()):null).catch(()=>null);return out(noted(target,{selected:selected??true}));}
      case 'browser_evaluate':{if(a.function.length>32768)throw new Error('JavaScript limit 32 KiB');const data=await this.frame(s,a).evaluate(({source,arg})=>{const fn=(0,eval)(`(${source})`);if(typeof fn!=='function')throw new Error('function must be a JavaScript function expression');return fn(arg);},{source:a.function,arg:a.arg});if(JSON.stringify(data)?.length>65536)throw new Error('Evaluation result exceeds 64 KiB');return out({value:data,untrustedContent:true});}
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
      case 'browser_console_messages':{
        if(a.full){const events=s.events.slice(-bounded(a.limit,1,300,100));if(a.clear)s.events=[];return out({events,cursor:s.eventSeq||0,untrustedContent:true});}
        // Newest last; level is a minimum severity; since is the cursor of an earlier read.
        const RANK={error:0,pageerror:0,assert:0,warning:1,info:2,log:2,debug:3,trace:3},rank=e=>RANK[e.kind==='console'?e.type:e.kind]??2,limit=bounded(a.limit,1,300,20);
        const merged=[];
        for(const e of s.events){
          if(a.since!==undefined&&e.seq<=a.since||a.level&&rank(e)>RANK[a.level])continue;
          const item=e.kind==='console'||e.kind==='pageerror'?{seq:e.seq,type:e.type,text:e.text.length>300?`${e.text.slice(0,300)}…`:e.text,tabId:e.tabId}:(({at,...rest})=>rest)(e);
          const prev=merged.at(-1);if(prev&&prev.type===item.type&&prev.text!==undefined&&prev.text===item.text){prev.count=(prev.count||1)+1;prev.seq=item.seq;continue;}
          merged.push(item);
        }
        const events=merged.slice(-limit);if(a.clear)s.events=[];
        return out({events,...(merged.length>events.length?{earlier:merged.length-events.length}:{}),cursor:s.eventSeq||0,untrustedContent:true});
      }
      case 'browser_network_requests':{
        // Documents, xhr and fetch plus any failure by default; types or all:true widen it.
        const DEFAULT=new Set(['document','xhr','fetch']),failed=m=>!!m.failed||m.status>=400,types=a.types?new Set(a.types):null,match=a.url?.toLowerCase();
        const all=[...s.network.values()].map(x=>x.meta);
        const kept=all.filter(m=>(a.all?true:types?types.has(m.resourceType):DEFAULT.has(m.resourceType)||failed(m))&&(!a.failed||failed(m))&&(!match||m.url.toLowerCase().includes(match))&&(a.status===undefined||m.status===a.status));
        const shortUrl=u=>u.length>160?u.slice(0,157)+'...':u;
        return out({requests:kept.slice(-bounded(a.limit,1,300,a.all?100:30)).map(({requestId,url,method,resourceType,status,contentType,tabId,failed})=>({requestId,method,url:shortUrl(url),type:resourceType,...(status!==undefined?{status}:{}),...(failed?{failed}:{}),...(contentType?{contentType:contentType.split(';')[0]}:{}),tabId})),...(kept.length<all.length?{skipped:all.length-kept.length}:{}),untrustedContent:true});}
      case 'browser_network_body':{const entry=s.network.get(a.requestId);if(!entry)throw new Error('Request ID expired');let body;
        if(a.kind==='request')body=entry.request.postDataBuffer()||Buffer.alloc(0);
        else{if(!entry.response)throw new Error('Response unavailable');await abortableRead(entry.response.finished(),signal);if(signal.aborted)throw new Error('Read cancelled');body=await abortableRead(entry.response.body(),signal);}
        if(body.length>MAX_ARTIFACT)throw new Error('Body exceeds 64 MiB');
        // A window of the body: 16 KB from offset by default, up to 1 MiB per read.
        const offset=Math.min(body.length,a.offset||0),part=body.subarray(offset,offset+bounded(a.maxBytes,1,1024*1024,16384)),rest=body.length-offset-part.length;
        return out({body:part.toString('utf8'),bytes:body.length,...(offset?{offset}:{}),...(rest>0?{remaining:rest,next:offset+part.length}:{}),untrustedContent:true});}
      case 'browser_route':if(a.action==='clear')await s.browser.unrouteAll({behavior:'wait'});else {if(!a.url||a.url.length>2048||(a.body||'').length>1024*1024)throw new Error('Bounded URL and body required');await s.browser.route(a.url,route=>route.fulfill({status:bounded(a.status,100,599,200),body:a.body||'',contentType:a.contentType||'text/plain'}));}return out({mocked:a.action});
      case 'browser_file_upload':{if(a.paths.length>20)throw new Error('Maximum 20 upload files');const files=[];let total=0;for(const name of a.paths){const file=uploadSnapshot(ctx.cwd,name);total+=file.buffer.length;if(total>MAX_ARTIFACT)throw new Error('Combined uploads exceed 64 MiB');files.push(file);}await (await this.locator(s,a,signal)).setInputFiles(files,{timeout:10000});return out({uploaded:files.length});}
      case 'browser_take_screenshot':{
        // JPEG 70 in CSS pixels by default; PNG, device pixels and native width are arguments.
        const type=a.type||'jpeg',quality=type==='jpeg'?bounded(a.quality,1,100,70):undefined,scale=a.scale||'css';let bytes;
        const vp=!a.fullPage&&!a.clip&&!a.fullResolution&&typeof p.evaluate==='function'?await p.evaluate(()=>({w:innerWidth,h:innerHeight,x:visualViewport?.pageLeft??scrollX,y:visualViewport?.pageTop??scrollY,dpr:devicePixelRatio||1})).catch(()=>null):null;
        if(vp&&vp.w>1024){
          // A wide viewport is captured where it is scrolled, 1024 CSS px wide. The output is
          // clip x scale x this session's device ratio (1 under viewport emulation), divided out here.
          const c=await this.cdp(s,p),metrics=await c.send('Page.getLayoutMetrics'),ratio=metrics?.contentSize?.width/metrics?.cssContentSize?.width||1;
          const shot=await c.send('Page.captureScreenshot',{format:type,...(quality?{quality}:{}),clip:{x:vp.x,y:vp.y,width:vp.w,height:vp.h,scale:1024/vp.w*(scale==='device'?vp.dpr:1)/ratio},captureBeyondViewport:false});bytes=Buffer.from(shot.data,'base64');}
        else bytes=await p.screenshot({type,quality,scale,fullPage:!!a.fullPage,clip:a.clip,timeout:10000});
        signal.throwIfAborted();if(bytes.length>MAX_IMAGE)throw new Error('Screenshot exceeds 4 MiB; choose JPEG, lower quality, viewport, or a smaller clip');
        // Width and height are read from the encoded image, so they are the real pixel size.
        const meta=await this.artifacts.add(bytes,`image/${type}`,'screenshot',ctx,imageDimensions(bytes,type));return {...out({captured:true},[meta]),image:{type:'image',mimeType:meta.mimeType,data:bytes.toString('base64')}};}
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
      case 'browser_wait_for':{const hasTarget=!!(a.text||a.selector||a.role||a.ref);if(!hasTarget&&a.time===undefined)throw new Error('A text, locator or time in seconds is required');const deadline=Date.now()+bounded(a.time!==undefined?a.time*1000:undefined,0,60000,10000);if(!hasTarget){while(Date.now()<deadline){if(signal.aborted)throw new Error('Cancelled');await sleep(Math.min(100,deadline-Date.now()));}return out({waited:true});}let loc;
        if(a.ref){const state=this.pageState(s,p);if(a.revision!==state.revision)throw stale(NEW_PAGE);const entry=state.refs.get(a.ref);if(!entry||!a.ref.startsWith(`${this.tabIdOf(s,p)}-`))throw new Error('Unknown ref for this tab');loc=p.getByRef(entry.pw);}
        else loc=a.text?this.frame(s,a).getByText(a.text,{exact:false}):a.role?this.frame(s,a).getByRole(a.role,{name:a.name,exact:true}):this.frame(s,a).locator(a.selector);
        while(Date.now()<=deadline){if(signal.aborted)throw new Error('Cancelled');const count=await loc.count();const visible=count>0&&await loc.first().isVisible();if(a.state==='hidden'?!visible:a.state==='detached'?count===0:a.state==='attached'?count>0:visible)return out({matched:true});await sleep(100);}throw new Error('Wait timed out');}
      default:throw new Error('Unknown tool');
    }
  }
  /** The value or checked state a field holds now, when it differs from what was set. */
  async readBack(target,expected){
    const got=await target.evaluate(e=>({password:e.type==='password',value:'value' in e&&e.tagName!=='BUTTON'?String(e.value):e.isContentEditable?e.innerText:null,checked:e.checked,editable:!!e.isContentEditable,chosen:e.tagName==='SELECT'?[...e.options].filter(o=>o.selected).flatMap(o=>[o.value,(o.label||o.text||'').trim()]):null})).catch(()=>null);
    if(!got)return null;
    // A select holds an option, which may be named by its value or its label.
    if(Array.isArray(got.chosen))return got.chosen.includes(String(expected))?null:{expected:String(expected).slice(0,200),actual:got.chosen.slice(0,2).join(' / ').slice(0,200)};
    if(typeof expected==='boolean')return got.checked===expected?null:{expected,actual:!!got.checked};
    if(got.value===null||(got.editable?clean(got.value,1e6)===clean(expected,1e6):got.value===expected))return null;
    return got.password?{expected:'(hidden)',actual:`(hidden, ${got.value.length} chars)`}:{expected:expected.slice(0,200),actual:got.value.slice(0,200)};
  }
  async startCapture(s,ctx,kind,p,a){
    if(s.capture)throw new Error(`Capture ${s.capture.kind} is active; stop it first`);const file=this.artifacts.temp();const capture={kind,file,page:p,ctx,startedAt:new Date().toISOString()};s.capture=capture;
    try{
      if(kind==='video'){capture.size=p.viewportSize()||{width:1280,height:800};await p.screencast.start({path:file,size:capture.size});}
      if(kind==='trace')await s.browser.tracing.start({screenshots:false,snapshots:true,sources:false});
      if(kind==='perf'){const c=await this.cdp(s,p);capture.cdp=c;await c.send('Tracing.start',{transferMode:'ReturnAsStream',categories:'devtools.timeline,v8,blink.user_timing',options:'record-continuously'});}
      if(kind==='cpu'){const c=await this.cdp(s,p);capture.cdp=c;await c.send('Profiler.enable');await c.send('Profiler.start');}
      const duration=bounded(a.maxDurationMs,1000,120000,60000);capture.timer=setTimeout(()=>{if(s.capture===capture)this.stopCapture(s,ctx,kind).then(r=>{this.pushEvent(s,{kind:'capture-finalized',artifacts:r.artifacts});}).catch(()=>{});},duration);capture.timer.unref();
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
    if(s.sharedHost){const host=s.sharedHost;s.sharedHost=null;await host.release(s.key);s.browser=null;s.shell=null;this.invalidateAll(s);s.tabs.clear();s.pageStates.clear();s.selected=null;s.refs.clear();return;}
    const context=s.browser,guard=s.guard;if(!context&&!guard)return;
    let closing=Promise.resolve();if(context){const browser=context.browser();closing=(browser?browser.close({reason:'Trex Browser profile stopped by its owner'}):context.close());}
    if(guard){await Promise.race([closing.catch(()=>{}),sleep(3000)]);try{await guard.stop();}catch(e){this.pause(s,'runtime',s.active);throw Object.assign(new Error(`Owned browser shutdown is uncertain (${e.message}); manual review required`),{code:'UNCERTAIN'});}if(s.guard===guard)s.guard=null;closing.catch(()=>{});s.browser=null;this.invalidateAll(s);s.tabs.clear();s.pageStates.clear();s.selected=null;s.refs.clear();}
    else await closing;
  }
  async shutdown(){await Promise.allSettled([...this.sessions.values()].map(async s=>{if(s.capture)try{await this.stopCapture(s,s.capture.ctx,s.capture.kind);}catch{}await this.closeProfile(s);}));await Promise.allSettled([...this.shellHosts.values()].map(async slot=>(await slot.promise).shutdown()));}
}
