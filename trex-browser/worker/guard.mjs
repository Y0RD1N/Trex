import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { childEnvironment } from './security.mjs';

function deadline(promise,ms,message){let timer;return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(message)),ms);})]).finally(()=>clearTimeout(timer));}

// The native guard retains verified process handles, including on broker crash.
// There is no process-name lookup or late PID-based termination in this worker.
export async function guardBrowser(context,executablePath,onPhase=()=>{},onFailure=()=>{}){
  if(!['win32','linux'].includes(process.platform))return null;
  let launcher=process.env.TREX_BROWSER_LAUNCHER;
  if(!launcher&&process.env.TREX_BROWSER_DEV==='1'){
    const debug=fileURLToPath(new URL(process.platform==='win32'?'../target/debug/trex-browser.exe':'../target/debug/trex-browser',import.meta.url));
    if(fs.existsSync(debug))launcher=debug;
  }
  if(!launcher)throw new Error('Native browser process supervisor is required');
  onPhase('guard_cdp_session');const cdp=await deadline(context.browser().newBrowserCDPSession(),5000,'Owned browser CDP session timed out');
  let pid;try{onPhase('guard_process_info');const info=await deadline(cdp.send('SystemInfo.getProcessInfo'),5000,'Owned browser process info timed out');pid=info.processInfo.find(p=>p.type==='browser')?.id;}finally{onPhase('guard_cdp_detach');await deadline(cdp.detach(),5000,'Owned browser CDP detach timed out');}
  if(!Number.isSafeInteger(pid)||pid<=0)throw new Error('Cannot identify the owned browser process');
  onPhase('guard_native_ready');const child=spawn(launcher,['__guard-browser','--pid',String(pid),'--exe',path.resolve(executablePath)],{env:childEnvironment(),windowsHide:true,stdio:['pipe','pipe','pipe']});
  let readyResolve,readyReject,stoppedResolve,buffer='',error='',stopPromise;
  child.stdin.on('error',()=>{});
  const ready=new Promise((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});
  const stopped=new Promise(resolve=>{stoppedResolve=resolve;});
  child.stdout.on('data',chunk=>{buffer+=chunk.toString();if(buffer.length>16384){readyReject(new Error('Invalid browser supervisor response'));return;}for(;;){const end=buffer.indexOf('\n');if(end<0)break;const line=buffer.slice(0,end);buffer=buffer.slice(end+1);try{const value=JSON.parse(line);if(value.ready===true)readyResolve();if(value.stopped===true)stoppedResolve();}catch{readyReject(new Error('Invalid browser supervisor response'));}}});
  child.stderr.on('data',chunk=>{error=(error+chunk.toString()).slice(-2000);});
  // Windows descendants can inherit pipe handles. Process exit plus the native
  // flushed confirmation establishes completion without waiting for pipe EOF.
  const exited=new Promise((resolve,reject)=>{child.once('error',e=>{readyReject(e);reject(e);});child.once('exit',code=>{setImmediate(()=>{if(code!==0){const stage=error.match(/GUARD_STAGE=[A-Z_]+/g)?.slice(-4).join(', ');const failure=new Error(`Native browser supervisor rejected process ownership or could not stop its owned process${stage?` (${stage})`:''}`);try{onFailure(failure);}catch{}readyReject(failure);reject(failure);}else{readyReject(new Error('Browser supervisor ended before readiness'));resolve();}});});});
  exited.catch(()=>{});
  try{await deadline(ready,5000,'Browser supervisor readiness timed out');}
  catch(e){child.stdin.destroy();await deadline(exited.catch(()=>{}),6000,'Browser supervisor cleanup timed out').catch(()=>{});throw e;}
  return {
    async stop(){
      if(!stopPromise)stopPromise=(async()=>{if(child.exitCode===null&&!child.stdin.destroyed)child.stdin.end('stop\n');await deadline(Promise.all([exited,stopped]),8000,'Owned browser process did not stop within its limit');child.stdin.destroy();child.stdout.destroy();child.stderr.destroy();})();
      return stopPromise;
    },
  };
}
