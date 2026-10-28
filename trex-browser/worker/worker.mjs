#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { privateHome, readPrivate, writePrivate, jsonRead, context, MAX_JSON, safePath, sha256, childEnvironment } from './security.mjs';
import { BrowserService, detectBrowser, isObservation } from './browser.mjs';
import { ensureSpaces } from './spaces.mjs';
import { VERSION, PROTOCOL, tools, MODES, mcpInitialization } from './tools.mjs';

const entry=fileURLToPath(import.meta.url);
function ffmpegRuntime(){
  try{
    const require=createRequire(import.meta.url);const packageDir=path.dirname(require.resolve('playwright-core/package.json'));
    const revision=JSON.parse(fs.readFileSync(path.join(packageDir,'browsers.json'),'utf8')).browsers.find(b=>b.name==='ffmpeg').revision;
    const base=process.env.PLAYWRIGHT_BROWSERS_PATH;
    if(!base||base==='0')return {available:false,error:'Packaged PLAYWRIGHT_BROWSERS_PATH/ffmpeg runtime is missing'};
    const executable=path.join(base,`ffmpeg-${revision}`,process.platform==='win32'?'ffmpeg-win64.exe':process.platform==='darwin'?'ffmpeg-mac':'ffmpeg-linux');
    safePath(executable);return {available:fs.statSync(executable).isFile(),revision};
  }catch{return {available:false,error:'Pinned Playwright ffmpeg executable is missing or unsafe'};}
}
const delay=ms=>new Promise(r=>setTimeout(r,ms));
function encode(value){const body=JSON.stringify(value);if(Buffer.byteLength(body)>MAX_JSON)throw new Error('Result exceeds 8 MiB output limit');return body;}
function emit(value){process.stdout.write(encode(value)+'\n');}
function errorResult(error,operationId,ctx){return {content:[{type:'text',text:cleanError(error.message)}],isError:true,structuredContent:{ok:false,operationId,...(ctx?{projectId:ctx.projectId,profile:ctx.profile}:{}),artifacts:error.batchSteps?.flatMap(step=>step.artifacts||[])||[],...(error.batchSteps?{data:{steps:error.batchSteps}}:{}),error:{code:error.code||'BROWSER_ERROR',message:cleanError(error.message)},receipt:{status:error.code==='UNCERTAIN'?'uncertain':error.code==='CANCELLED'?'cancelled':'rejected',manualReview:error.code==='UNCERTAIN',replaySafe:false}}};}
function cleanError(message){return String(message||'Browser operation failed').replace(/(?:[A-Za-z]:\\|\/)(?:[^\s:'"<>]+[\\/])+[^\s:'"<>]*/g,'[private path]').slice(0,2000);}
function toolResult(result,operationId,ctx){const structuredContent={ok:true,operationId,projectId:ctx.projectId,profile:ctx.profile,generation:result.generation,revision:result.revision,data:result.data,artifacts:result.artifacts||[],receipt:{status:'completed',manualReview:false,replaySafe:false}};return {content:[{type:'text',text:encode(structuredContent)},...(result.image?[result.image]:[])],structuredContent};}
function argMap(argv){const result={_:[]};for(let i=0;i<argv.length;i++){const arg=argv[i];if(arg.startsWith('--')){const key=arg.slice(2);if(['json','stdin-json','version'].includes(key))result[key]=true;else{if(!argv[i+1]||argv[i+1].startsWith('--'))throw new Error(`Missing --${key} value`);result[key]=argv[++i];}}else result._.push(arg);}return result;}
function boundArgs(args){return context({cwd:args.cwd,mode:args.mode||'observe',clientId:args.client||args['client-id']||'settings',profile:args.profile});}
async function stdinJson(){let input='';for await(const chunk of process.stdin){input+=chunk;if(Buffer.byteLength(input)>1024*1024)throw new Error('Input exceeds 1 MiB');}return JSON.parse(input);}
function file(home,name){return path.join(home,name);}
function endpoint(home){return jsonRead(file(home,'broker.json'),null);}
function token(home){return readPrivate(file(home,'broker.token')).toString('utf8');}
async function ipc(home,route,body,timeoutMs=10000,signal){const state=endpoint(home);if(!state||!Number.isInteger(state.port)||state.port<1||state.port>65535)throw new Error('Broker is not running');const secret=token(home);if(!/^[a-f0-9]{64}$/.test(secret))throw new Error('Invalid broker credential');const response=await fetch(`http://127.0.0.1:${state.port}${route}`,{method:'POST',headers:{'content-type':'application/json','authorization':`Bearer ${secret}`},body:encode(body),signal:signal?AbortSignal.any([AbortSignal.timeout(timeoutMs),signal]):AbortSignal.timeout(timeoutMs)});const value=await response.json();if(!response.ok)throw new Error(value.error||'Broker request rejected');return value;}
async function running(home){try{return await ipc(home,'/health',{},1000);}catch{return false;}}
async function ensureBroker(home){
  if(await running(home))return;
  const env=childEnvironment();
  const native=process.env.TREX_BROWSER_LAUNCHER;
  const executable=native||process.execPath;
  const args=native?['__spawn-broker']:[entry,'launch-daemon'];
  const child=spawn(executable,args,{env,windowsHide:true,detached:true,stdio:['ignore','ignore','pipe']});
  let diagnostic='';child.stderr.on('data',chunk=>{if(diagnostic.length<4096)diagnostic+=chunk.toString().slice(0,4096-diagnostic.length);});
  // Windows descendants can retain an inherited pipe writer after this short
  // helper exits. Waiting for ChildProcess.close would then wait for the broker
  // itself. Process exit establishes launch completion; health authenticates it.
  await new Promise((resolve,reject)=>{
    const finish=error=>{clearTimeout(timer);child.stderr.destroy();child.unref();error?reject(error):resolve();};
    const timer=setTimeout(()=>{child.kill();finish(new Error('Detached broker launch timed out'));},10000);
    child.once('error',finish);
    child.once('exit',code=>setImmediate(()=>finish(code===0?null:new Error(cleanError(diagnostic)||'Detached broker launch failed; start Trex Browser outside a restrictive process job or allow Windows job breakaway'))));
  });
  for(let i=0;i<100;i++){if(await running(home))return;await delay(100);}
  throw new Error('Broker startup timed out; inspect private installation/runtime');
}
async function doCall(input,signal){let ctx,dispatched=false;const operationId=input.operationId||crypto.randomUUID();try{
  ctx=context(input);if(typeof operationId!=='string'||! /^[A-Za-z0-9:_-]{1,160}$/.test(operationId))throw new Error('Invalid operationId');
  if(!input.arguments||typeof input.arguments!=='object')throw new Error('arguments object required');
  const timeoutMs=input.timeoutMs===undefined?30000:input.timeoutMs;if(!Number.isInteger(timeoutMs)||timeoutMs<100||timeoutMs>90000)throw new Error('timeoutMs must be 100..90000');
  signal?.throwIfAborted();const home=privateHome();await ensureBroker(home);signal?.throwIfAborted();const {grantId}=await ipc(home,'/grant',ctx);signal?.throwIfAborted();
  dispatched=true;return await ipc(home,'/call',{grantId,name:input.name,arguments:input.arguments,operationId,timeoutMs},timeoutMs+10000,signal);
}catch(e){if(signal?.aborted||dispatched&&!e.code){const observation=isObservation(input.name,input.arguments);e=Object.assign(new Error(dispatched&&!observation?'Transport cancelled; inspect operation before resuming':observation?'Observation cancelled; browser remains available':'Cancelled before dispatch'),{code:dispatched&&!observation?'UNCERTAIN':'CANCELLED'});}return errorResult(e,operationId,ctx);}}
async function daemon(){
  const home=privateHome();const lock=file(home,'broker.lock');let fd;
  try{fd=fs.openSync(lock,'wx',0o600);fs.writeFileSync(fd,String(process.pid));}catch(e){if(e.code!=='EEXIST')throw e;if(await running(home))return;
    const owner=Number(readPrivate(lock).toString());let alive=false;try{process.kill(owner,0);alive=true;}catch{}if(alive)throw new Error('Broker startup already in progress');safePath(lock);fs.rmSync(lock);return daemon();}
  const service=new BrowserService(home);const secret=crypto.randomBytes(32).toString('hex');writePrivate(file(home,'broker.token'),secret);const grants=new Map();
  const server=http.createServer(async(req,res)=>{
    const send=(status,value)=>{const body=encode(value);res.writeHead(status,{'content-type':'application/json','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(body);};
    const expected=`127.0.0.1:${server.address().port}`;const auth=Buffer.from(req.headers.authorization||'');
    if(req.headers.host!==expected||req.headers.origin!==undefined||req.method!=='POST'||req.headers['content-type']!=='application/json'||!['127.0.0.1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress)||auth.length!==71||!crypto.timingSafeEqual(auth,Buffer.from(`Bearer ${secret}`))){send(403,{error:'Forbidden'});return;}
    try{let raw='';for await(const chunk of req){raw+=chunk;if(Buffer.byteLength(raw)>1024*1024)throw new Error('Input exceeds 1 MiB');}const body=JSON.parse(raw||'{}');
      if(req.url==='/health'){send(200,{ok:true,version:VERSION,pid:process.pid});return;}
      if(req.url==='/grant'){const ctx=context(body);const grantId=crypto.randomBytes(32).toString('hex');grants.set(grantId,{ctx,expires:Date.now()+120000});if(grants.size>2000)for(const [id,g] of grants)if(g.expires<Date.now())grants.delete(id);send(200,{grantId});return;}
      if(req.url==='/spaces'){const ctx=context(body);send(200,ensureSpaces(service,ctx,body.members));return;}
      if(req.url==='/profiles'){const ctx=context(body);if(body.action==='create')service.createProfile(ctx);send(200,{profiles:service.profiles(ctx)});return;}
      if(req.url==='/shutdown'){send(200,{stopping:true});setImmediate(()=>shutdown());return;}
      if(req.url!=='/call'){send(404,{error:'Unknown route'});return;}
      const grant=grants.get(body.grantId);if(!grant||grant.expires<Date.now())throw new Error('Grant expired');grants.delete(body.grantId);const ctx=grant.ctx;
      let result,reservation;try{if(typeof body.operationId!=='string'||!/^[A-Za-z0-9:_-]{1,160}$/.test(body.operationId))throw new Error('Invalid operationId');if(!Number.isInteger(body.timeoutMs)||body.timeoutMs<100||body.timeoutMs>90000)throw new Error('Invalid timeoutMs');reservation=file(home,`receipts/${sha256(body.operationId)}.json`);if(jsonRead(reservation,null))throw Object.assign(new Error('Duplicate operationId; inspect earlier outcome and never replay automatically'),{code:'DUPLICATE_OPERATION'});
        writePrivate(reservation,JSON.stringify({operationId:body.operationId,name:body.name,projectId:ctx.projectId,clientHash:sha256(ctx.clientId),profile:ctx.profile,at:new Date().toISOString(),receipt:{status:'uncertain',manualReview:true,replaySafe:false}}));
        const disconnected=()=>{if(!res.writableEnded)try{service.cancel(ctx,body.operationId);}catch{}};
        res.once('close',disconnected);
        if(res.destroyed)throw Object.assign(new Error('Client disconnected before dispatch'),{code:'CANCELLED'});
        const r=await service.call(ctx,body.name,body.arguments,body.operationId,body.timeoutMs);result=toolResult(r,body.operationId,ctx);
      }catch(e){result=errorResult(e,body.operationId,ctx);}
      // Never persist arguments, site content, images, credentials, or base64.
      const receipt={operationId:body.operationId,name:body.name,projectId:ctx.projectId,clientHash:sha256(ctx.clientId),profile:ctx.profile,at:new Date().toISOString(),receipt:result.structuredContent.receipt};if(reservation&&result.structuredContent.error?.code!=='DUPLICATE_OPERATION')writePrivate(reservation,JSON.stringify(receipt));
      const receipts=fs.readdirSync(file(home,'receipts'));if(receipts.length>1000)for(const name of receipts.slice(0,receipts.length-1000))fs.rmSync(file(home,`receipts/${name}`));
      send(200,result);
    }catch(e){send(400,{error:cleanError(e.message)});}
  });
  server.requestTimeout=10000;server.headersTimeout=5000;server.maxConnections=32;
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  writePrivate(file(home,'broker.json'),JSON.stringify({port:server.address().port,pid:process.pid,version:VERSION}));
  let closing=false;async function shutdown(){if(closing)return;closing=true;const killTimer=setTimeout(()=>process.exit(0),15000);killTimer.unref();await service.shutdown();server.close();for(const name of ['broker.json','broker.token','broker.lock']){safePath(file(home,name),{allowMissing:true});fs.rmSync(file(home,name),{force:true});}fs.closeSync(fd);process.exit(0);}
  process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
}
async function mcp(args){
  const ctx=boundArgs(args);const pending=new Map();const rl=readline.createInterface({input:process.stdin,crlfDelay:Infinity});
  for await(const line of rl){if(Buffer.byteLength(line)>1024*1024){emit({jsonrpc:'2.0',id:null,error:{code:-32700,message:'Input too large'}});continue;}let req;try{req=JSON.parse(line);}catch{emit({jsonrpc:'2.0',id:null,error:{code:-32700,message:'Parse error'}});continue;}
    if(req.method==='notifications/cancelled'){pending.get(req.params?.requestId)?.controller.abort();continue;}
    if(req.id===undefined)continue;
    (async()=>{let ownedPending;try{let result;
      if(req.method==='initialize')result=mcpInitialization(req.params);
      else if(req.method==='ping')result={};
      else if(req.method==='tools/list')result={tools:tools(ctx.mode)};
      else if(req.method==='tools/call'){if(pending.has(req.id))throw new Error('Duplicate pending JSON-RPC request ID');const op=crypto.randomUUID(),controller=new AbortController();ownedPending={operationId:op,controller};pending.set(req.id,ownedPending);result=await doCall({...ctx,name:req.params?.name,arguments:req.params?.arguments||{},operationId:op},controller.signal);}
      else{emit({jsonrpc:'2.0',id:req.id,error:{code:-32601,message:'Method not found'}});return;}
      emit({jsonrpc:'2.0',id:req.id,result});
    }catch(e){emit({jsonrpc:'2.0',id:req.id,error:{code:-32602,message:cleanError(e.message)}});}finally{if(ownedPending&&pending.get(req.id)===ownedPending)pending.delete(req.id);}})();
  }
  // Cancel only this adapter's in-flight IDs. The broker and peer grants survive.
  for(const {controller} of pending.values())controller.abort();
}
async function main(){const args=argMap(process.argv.slice(2));const command=args._[0];
  if(command==='--version'||args.version||command==='version'){emit({version:VERSION});return;}
  if(command==='tools'){emit({tools:tools(args.mode||'full')});return;}
  if(command==='doctor'){
    const browser=detectBrowser(),ffmpeg=ffmpegRuntime();emit({version:VERSION,protocolVersion:PROTOCOL,runtime:{node:process.versions.node.startsWith('24.'),playwright:true,ffmpeg:ffmpeg.available,nodeVersion:process.versions.node,playwrightVersion:'1.64.1',expectedNodeVersion:'24.22.1',...(!ffmpeg.available?{videoError:ffmpeg.error}:{})},browser,capabilities:{spaces:true,batch:true,pageScopedRefs:true,standalone:true,persistentProfiles:true,sandbox:true,screenshots:true,video:ffmpeg.available,trace:true,cdpDiagnostics:true,authenticatedBroker:true,appPreparation:true,modes:MODES},tools:tools(args.mode||'full')});return;
  }
  // The app calls this outside the agent's restrictive MCP process job. Only
  // the authenticated service is prepared; Chrome opens on first navigation.
  if(command==='prepare'){await ensureBroker(privateHome());emit({ready:true,protocolVersion:PROTOCOL});return;}
  if(command==='launch-daemon'){const child=spawn(process.execPath,[entry,'daemon'],{detached:true,stdio:'ignore',windowsHide:true,env:childEnvironment()});child.unref();return;}
  if(command==='daemon'){await daemon();return;}
  if(command==='mcp'){await mcp(args);return;}
  if(command==='call'){if(!args['stdin-json'])throw new Error('call requires --stdin-json');emit(await doCall(await stdinJson()));return;}
  if(command==='artifact-open'){const input=await stdinJson();emit(await doCall({...input,name:'browser_artifact',arguments:{artifactId:input.artifactId,open:true}}));return;}
  if(command==='spaces'){if(!args['stdin-json'])throw new Error('spaces requires --stdin-json');const input=await stdinJson(),ctx=context({...input,mode:'observe',clientId:'host-spaces'}),home=privateHome();await ensureBroker(home);emit(await ipc(home,'/spaces',{...ctx,members:input.members}));return;}
  if(command==='profiles'){const ctx=boundArgs(args);const home=privateHome();await ensureBroker(home);emit(await ipc(home,'/profiles',{...ctx,action:args._[1]||'list'}));return;}
  if(['pause','resume','stop','status','takeover'].includes(command)){const home=privateHome();if(command==='stop'&&!args.cwd){if(!await running(home)){emit({stopping:false,running:false});return;}emit(await ipc(home,'/shutdown',{}));return;}emit(await doCall({...boundArgs(args),name:`browser_${command==='stop'?'close':command}`,arguments:{}}));return;}
  throw new Error('Commands: --version, doctor --json, prepare --json, tools --json, profiles list|create --cwd ABS, mcp --cwd ABS --mode observe|qa|full --client ID, call --stdin-json, artifact-open --stdin-json, pause|resume|status|takeover|stop');
}
main().catch(e=>{emit(errorResult(e));process.exitCode=1;});
