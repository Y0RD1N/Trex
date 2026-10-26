import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
export const MAX_IMAGE = 4*1024*1024, MAX_JSON=8*1024*1024, MAX_ARTIFACT=64*1024*1024;
export const sha256 = data=>crypto.createHash('sha256').update(data).digest('hex');
export function childEnvironment() {
  const env={};
  for(const name of ['SystemRoot','SYSTEMROOT','WINDIR','COMSPEC','TEMP','TMP','USERPROFILE','LOCALAPPDATA','APPDATA','PROGRAMFILES','PROGRAMFILES(X86)','ProgramW6432','PATH','PATHEXT','HOME','LANG','LC_ALL','LC_CTYPE','TZ','TMPDIR','XDG_CONFIG_HOME','XDG_DATA_HOME','XDG_CACHE_HOME','XDG_STATE_HOME','XDG_RUNTIME_DIR','DBUS_SESSION_BUS_ADDRESS','DISPLAY','WAYLAND_DISPLAY','XAUTHORITY','XDG_SESSION_TYPE','XDG_CURRENT_DESKTOP','TREX_BROWSER_HOME','TREX_BROWSER_NATIVE_VERIFIED','TREX_BROWSER_DEV','TREX_BROWSER_HEADLESS','TREX_BROWSER_LAUNCHER','TREX_BROWSER_RUNTIME','PLAYWRIGHT_BROWSERS_PATH'])if(process.env[name]!==undefined)env[name]=process.env[name];
  return env;
}
export function safePath(target, {allowMissing=false}={}) {
  const absolute=path.resolve(target); const parsed=path.parse(absolute);
  let current=parsed.root;
  for(const component of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current=path.join(current,component);
    let stat;try{stat=fs.lstatSync(current);}catch(e){if(allowMissing&&e.code==='ENOENT')return absolute;throw e;}
    if(stat.isSymbolicLink()||(!stat.isDirectory()&&stat.nlink!==1)) throw new Error('Links/reparse points and hard-linked files are forbidden');
  }
  return absolute;
}
export function privateHome() {
  const stateRoot=process.platform==='linux'?(process.env.XDG_STATE_HOME&&path.isAbsolute(process.env.XDG_STATE_HOME)?process.env.XDG_STATE_HOME:path.join(os.homedir(),'.local/state')):null;
  const home=path.resolve(process.env.TREX_BROWSER_HOME||(stateRoot?path.join(stateRoot,'trex-browser'):path.join(process.env.LOCALAPPDATA||os.homedir(),process.platform==='win32'?'TrexBrowser':'.trex-browser')));
  safePath(home,{allowMissing:true});
  if(process.platform==='win32'&&process.env.TREX_BROWSER_NATIVE_VERIFIED!=='1'&&process.env.TREX_BROWSER_DEV!=='1') throw new Error('Use the native trex-browser launcher to verify the private home ACL');
  fs.mkdirSync(home,{recursive:true,mode:0o700});
  safePath(home);
  if(process.platform!=='win32') {
    const stat=fs.statSync(home); if(stat.uid!==process.getuid()||(stat.mode&0o077)!==0)throw new Error('Private home requires current-user ownership and private 0700 permissions');
  } else if(process.env.TREX_BROWSER_DEV==='1'&&process.env.TREX_BROWSER_NATIVE_VERIFIED!=='1') {
    // Only an explicit development invocation may provision its own isolated ACL.
    const sid=execFileSync('whoami.exe',['/user','/fo','csv','/nh'],{encoding:'utf8',windowsHide:true,timeout:5000}).match(/S-1-5-[0-9-]+/)?.[0];
    if(!sid)throw new Error('Cannot identify current Windows user');
    execFileSync('icacls.exe',[home,'/inheritance:r','/grant:r',`*${sid}:(OI)(CI)F`,'*S-1-5-18:(OI)(CI)F'],{stdio:'pipe',windowsHide:true,timeout:5000});
  }
  for(const dir of ['projects','artifacts','receipts']) {const p=path.join(home,dir);safePath(p,{allowMissing:true});fs.mkdirSync(p,{recursive:true,mode:0o700});}
  return home;
}
export function readPrivate(file) { safePath(file);return fs.readFileSync(file); }
export function writePrivate(file,data) {
  safePath(file,{allowMissing:true});const temp=`${file}.${crypto.randomUUID()}.tmp`;
  const fd=fs.openSync(temp,fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_WRONLY,0o600);
  try{fs.writeFileSync(fd,data);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  try{safePath(file,{allowMissing:true});fs.renameSync(temp,file);}catch(e){fs.rmSync(temp,{force:true});throw e;}
}
export function jsonRead(file,fallback) {try{return JSON.parse(readPrivate(file));}catch(e){if(e.code==='ENOENT')return fallback;throw e;}}
export function project(cwd) {
  if(typeof cwd!=='string'||!path.isAbsolute(cwd))throw new Error('cwd must be absolute');
  const resolved=fs.realpathSync(cwd);if(!fs.statSync(resolved).isDirectory())throw new Error('cwd must be a directory');
  const canonical=process.platform==='win32'?resolved.toLowerCase():resolved;
  return {cwd:resolved,projectId:sha256(canonical).slice(0,24)};
}
export function context(input) {
  if(!input||typeof input!=='object')throw new Error('Request object required');
  const p=project(input.cwd);
  if(!['observe','qa','full'].includes(input.mode))throw new Error('mode must be observe|qa|full');
  if(typeof input.clientId!=='string'||input.clientId.length<1||input.clientId.length>160||/[\x00-\x1f]/.test(input.clientId))throw new Error('Invalid clientId');
  const profile=input.profile||'BROWSER1';if(!/^BROWSER[1-9][0-9]?$/.test(profile))throw new Error('profile must be BROWSER1..BROWSER99');
  return {...p,mode:input.mode,clientId:input.clientId,profile};
}
export function workspaceFile(cwd,input) {
  if(typeof input!=='string')throw new Error('Upload path must be a string');
  const file=safePath(path.resolve(cwd,input));const rel=path.relative(cwd,file);
  if(!rel||rel.startsWith(`..${path.sep}`)||rel==='..'||path.isAbsolute(rel))throw new Error('Upload is outside workspace');
  const stat=fs.statSync(file);if(!stat.isFile()||stat.size>MAX_ARTIFACT)throw new Error('Upload must be a bounded regular file');return file;
}
export function uploadSnapshot(cwd,input){
  const file=workspaceFile(cwd,input);const launcher=process.env.TREX_BROWSER_LAUNCHER;
  let buffer;
  if(launcher){
    buffer=execFileSync(launcher,['__upload-snapshot','--cwd',cwd,'--path',file],{env:childEnvironment(),windowsHide:true,timeout:10000,maxBuffer:MAX_ARTIFACT+1,stdio:['ignore','pipe','pipe']});
  }else{
    if(process.env.TREX_BROWSER_DEV!=='1')throw new Error('Native upload snapshot helper required');
    const before=fs.lstatSync(file);const fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));
    try{const opened=fs.fstatSync(fd);if(!opened.isFile()||opened.nlink!==1||opened.size>MAX_ARTIFACT||opened.dev!==before.dev||opened.ino!==before.ino)throw new Error('Upload identity changed');safePath(file);const current=fs.lstatSync(file);if(current.dev!==opened.dev||current.ino!==opened.ino)throw new Error('Upload identity changed');buffer=fs.readFileSync(fd);const after=fs.fstatSync(fd);if(after.nlink!==1||after.size!==opened.size||after.mtimeMs!==opened.mtimeMs||buffer.length>MAX_ARTIFACT)throw new Error('Upload changed while reading');safePath(file);
    }finally{fs.closeSync(fd);}
  }
  if(buffer.length>MAX_ARTIFACT)throw new Error('Upload snapshot exceeds 64 MiB');return {name:path.basename(file),mimeType:'application/octet-stream',buffer};
}
export class Artifacts {
  constructor(home){this.home=home;this.dir=path.join(home,'artifacts');this.index=path.join(this.dir,'index.json');this.items=jsonRead(this.index,[]);this.prune();}
  prune(){const cutoff=Date.now()-7*86400000;let total=0;const keep=[];for(const a of [...this.items].reverse()){if(Date.parse(a.createdAt)>cutoff&&total+a.bytes<=512*1024*1024&&keep.length<200){keep.unshift(a);total+=a.bytes;}else{for(const suffix of ['', '.png','.jpg','.webm']){const f=path.join(this.dir,a.artifactId+suffix);safePath(f,{allowMissing:true});fs.rmSync(f,{force:true});}}}this.items=keep;this.save();}
  save(){writePrivate(this.index,JSON.stringify(this.items));}
  temp(){return path.join(this.dir,`pending-${crypto.randomUUID()}`);}
  async addFile(source,mimeType,kind,ctx,extra={}) {
    safePath(source);const stat=fs.statSync(source);if(!stat.isFile()||stat.size>MAX_ARTIFACT) {fs.rmSync(source,{force:true});throw new Error('Artifact exceeds 64 MiB limit');}
    const bytes=readPrivate(source);const artifactId=crypto.randomUUID();const dest=path.join(this.dir,artifactId);
    writePrivate(dest,bytes);fs.rmSync(source,{force:true});
    const meta={artifactId,mimeType,bytes:bytes.length,sha256:sha256(bytes),kind,projectId:ctx.projectId,profile:ctx.profile,createdAt:new Date().toISOString(),...extra};
    this.items.push(meta);this.prune();return meta;
  }
  async add(data,mimeType,kind,ctx,extra={}) {const file=this.temp();writePrivate(file,data);return this.addFile(file,mimeType,kind,ctx,extra);}
  get(id,ctx){if(typeof id!=='string'||! /^[a-f0-9-]{36}$/.test(id))throw new Error('Invalid artifact ID');const a=this.items.find(a=>a.artifactId===id&&a.projectId===ctx.projectId&&a.profile===ctx.profile);if(!a)throw new Error('Artifact not found for this project/profile');const file=path.join(this.dir,id);safePath(file);const stat=fs.statSync(file);if(!stat.isFile()||stat.size!==a.bytes||stat.size>MAX_ARTIFACT)throw new Error('Artifact integrity mismatch');const bytes=readPrivate(file);if(bytes.length!==a.bytes||sha256(bytes)!==a.sha256)throw new Error('Artifact integrity mismatch');return {meta:a,file,bytes};}
}
