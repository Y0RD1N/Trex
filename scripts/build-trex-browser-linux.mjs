import {spawnSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {chmodSync,copyFileSync,cpSync,existsSync,lstatSync,mkdirSync,readFileSync,readdirSync,renameSync,rmSync,writeFileSync} from 'node:fs';
import {dirname,join,relative,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {NODE_VERSION,LINUX_NODE_ARCHIVES,verifyNodeArchive,assertPinnedLock,cleanBuildEnvironment,assertBrowserMcpHandshake,packageShell} from './browser-build-common.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),installer=join(root,'src-tauri/installer');
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
export function assertLinuxExecutable(filename,arch){const bytes=readFileSync(filename);if(bytes.length<4096||!bytes.subarray(0,4).equals(Buffer.from([127,69,76,70]))||bytes[4]!==2||bytes[5]!==1||bytes.readUInt16LE(18)!==({x64:62,arm64:183}[arch]))throw new Error('Expected a real native Linux ELF executable.');}
function run(binary,args,options={}){const result=spawnSync(binary,args,{cwd:root,shell:false,stdio:'inherit',timeout:15*60_000,...options});if(result.error)throw result.error;if(result.status!==0)throw new Error('Linux browser component build failed.');return result.stdout;}
async function download(url,limit){const response=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(180000)});if(!response.ok)throw new Error('Official Node download failed.');const chunks=[];let bytes=0;for await(const chunk of response.body){bytes+=chunk.length;if(bytes>limit)throw new Error('Official download exceeded its bound.');chunks.push(chunk)}return Buffer.concat(chunks);}
function removeOwnedBuild(path){const p=resolve(path);if(!p.startsWith(resolve(installer)+sep)||p===resolve(installer)||existsSync(p)&&lstatSync(p).isSymbolicLink())throw new Error('Unsafe Linux build cleanup.');rmSync(p,{recursive:true,force:true});}
function files(directory,prefix=''){const result=[];for(const item of readdirSync(directory,{withFileTypes:true})){const name=join(prefix,item.name),path=join(directory,item.name);if(item.isSymbolicLink())throw new Error('Linux runtime contains a link.');if(item.isDirectory())result.push(...files(path,name));else if(item.isFile())result.push(name);else throw new Error('Unsupported runtime entry.')}return result.sort();}
// Trex Browser shell: shared packaging (see browser-build-common.mjs), plus a
// check that the packaged executable is a real native ELF for this target.
export function packageLinuxShell(core,runtime,arch){const shell=packageShell(core,runtime,{platform:'linux'});assertLinuxExecutable(join(runtime,shell.executable),arch);return shell;}
export async function buildLinuxBrowser(argv=[]){
  if(process.platform!=='linux')throw new Error('Build the private Linux Browser runtime on a Linux host.');
  if(process.env.NODE_TLS_REJECT_UNAUTHORIZED==='0')throw new Error('Verified TLS is required.');
  const target=process.env.TAURI_ENV_TARGET_TRIPLE,arch=target?(target.startsWith('x86_64-')?'x64':target.startsWith('aarch64-')?'arm64':''):process.arch;
  if(!LINUX_NODE_ARCHIVES[arch]||arch!==process.arch)throw new Error('Linux browser builds require the native x64/arm64 architecture.');
  const debug=argv.includes('--debug')||process.env.TAURI_ENV_DEBUG==='true',core=join(root,'trex-browser');
  const packageJson=JSON.parse(readFileSync(join(core,'package.json'),'utf8')),lock=JSON.parse(readFileSync(join(core,'package-lock.json'),'utf8'));assertPinnedLock(packageJson,lock);
  const host=/^host: (.+)$/m.exec(run('rustc',['-vV'],{encoding:'utf8',stdio:['ignore','pipe','inherit']}))?.[1]?.trim();
  const cargo=['build','--locked','--manifest-path',join(core,'Cargo.toml'),'--target-dir',join(core,'target')];if(!debug)cargo.push('--release');if(target&&target!==host)cargo.push('--target',target);run('cargo',cargo);
  const launcher=join(core,'target',...(target&&target!==host?[target]:[]),debug?'debug':'release','trex-browser');assertLinuxExecutable(launcher,arch);
  const cache=join(installer,'.cache',`node-v${NODE_VERSION}-linux-${arch}`);mkdirSync(cache,{recursive:true});const filename=`node-v${NODE_VERSION}-linux-${arch}.tar.xz`,archive=join(cache,filename),release=`https://nodejs.org/dist/v${NODE_VERSION}`;
  const manifest=(await download(`${release}/SHASUMS256.txt`,128*1024)).toString('utf8'),bytes=existsSync(archive)?readFileSync(archive):await download(`${release}/${filename}`,128*1024*1024);verifyNodeArchive(bytes,manifest,arch,'linux');if(!existsSync(archive))writeFileSync(archive,bytes,{flag:'wx'});
  const work=join(installer,'payload',`.browser-linux-build-${randomUUID()}`);mkdirSync(work,{recursive:true,mode:0o700});
  try{
    const extracted=join(work,'archive');mkdirSync(extracted);run('/usr/bin/tar',['-xf',archive,'-C',extracted]);const distribution=join(extracted,`node-v${NODE_VERSION}-linux-${arch}`),payload=join(work,'browser-linux'),runtime=join(payload,'trex-browser-runtime');mkdirSync(runtime,{recursive:true});
    copyFileSync(launcher,join(payload,'trex-browser'));chmodSync(join(payload,'trex-browser'),0o755);copyFileSync(join(distribution,'bin/node'),join(runtime,'node'));chmodSync(join(runtime,'node'),0o755);copyFileSync(join(distribution,'LICENSE'),join(runtime,'NODE_LICENSE'));
    for(const name of ['package.json','package-lock.json'])copyFileSync(join(core,name),join(runtime,name));for(const name of readdirSync(join(core,'worker')).filter(name=>name.endsWith('.mjs')))copyFileSync(join(core,'worker',name),join(runtime,name));
    const config=join(work,'npmrc'),globalConfig=join(work,'global.npmrc');writeFileSync(globalConfig,'');writeFileSync(config,'registry=https://registry.npmjs.org/\nstrict-ssl=true\n');
    const env={...cleanBuildEnvironment(process.env),HOME:join(work,'home'),XDG_CONFIG_HOME:join(work,'config'),XDG_DATA_HOME:join(work,'data'),XDG_STATE_HOME:join(work,'state'),TREX_BROWSER_HOME:join(work,'private-home'),NPM_CONFIG_USERCONFIG:config,NPM_CONFIG_GLOBALCONFIG:globalConfig,NPM_CONFIG_CACHE:join(work,'npm-cache'),PLAYWRIGHT_BROWSERS_PATH:join(runtime,'ffmpeg'),PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD:'1'};
    const node=join(runtime,'node');run(node,[join(distribution,'lib/node_modules/npm/bin/npm-cli.js'),'ci','--omit=dev','--ignore-scripts','--no-audit','--no-fund'],{cwd:runtime,env});delete env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD;
    run(node,[join(runtime,'node_modules/playwright/cli.js'),'install','ffmpeg'],{cwd:runtime,env});
    const bin=join(runtime,'node_modules/.bin');if(existsSync(bin))removeOwnedBuild(bin);const links=join(runtime,'ffmpeg/.links');if(existsSync(links))removeOwnedBuild(links);
    const encoders=files(join(runtime,'ffmpeg')).filter(name=>/ffmpeg-linux$/.test(name));if(encoders.length!==1)throw new Error('Pinned Linux ffmpeg is missing.');const ffmpeg=join(runtime,'ffmpeg',encoders[0]);assertLinuxExecutable(ffmpeg,arch);chmodSync(ffmpeg,0o755);run(ffmpeg,['-version'],{encoding:'utf8',stdio:['ignore','pipe','inherit']});
    const shell=packageLinuxShell(core,runtime,arch);
    const assets=files(payload).map(name=>({path:name,bytes:lstatSync(join(payload,name)).size,sha256:sha256(readFileSync(join(payload,name))),mode:lstatSync(join(payload,name)).mode&0o777}));
    writeFileSync(join(runtime,'runtime-manifest.json'),JSON.stringify({version:packageJson.version,platform:'linux',architecture:arch,hashStage:'before-package-signing',node:NODE_VERSION,nodeArchiveSha256:LINUX_NODE_ARCHIVES[arch],playwright:packageJson.dependencies.playwright,ffmpeg:relative(payload,ffmpeg),shell,assets},null,2)+'\n');
    const probe=JSON.parse(run(join(payload,'trex-browser'),['doctor','--json'],{cwd:payload,env,encoding:'utf8',stdio:['ignore','pipe','inherit'],timeout:15000}));if(!probe.runtime?.node||!probe.runtime?.playwright||!probe.runtime?.ffmpeg)throw new Error('Linux private runtime doctor failed.');if(probe.browser?.channel!=='trex-shell')throw new Error('The packaged Trex Browser shell was not detected by doctor.');
    const input=[{jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-06-18'}},{jsonrpc:'2.0',id:2,method:'tools/list'}].map(JSON.stringify).join('\n')+'\n';assertBrowserMcpHandshake(run(join(payload,'trex-browser'),['mcp','--cwd',work,'--mode','observe','--client','linux-build-check'],{cwd:payload,env,input,encoding:'utf8',stdio:['pipe','pipe','inherit'],timeout:15000}));
    const destination=join(installer,'payload/browser-linux'),previous=join(work,'previous');if(existsSync(destination)){if(lstatSync(destination).isSymbolicLink())throw new Error('Linked payload destination.');try{renameSync(destination,previous)}catch(error){if(error.code!=='EXDEV')throw error;files(destination);cpSync(destination,previous,{recursive:true});removeOwnedBuild(destination);}}try{renameSync(payload,destination)}catch(error){if(existsSync(previous))renameSync(previous,destination);throw error}
    if(debug){const debugRoot=join(core,'target/debug');mkdirSync(debugRoot,{recursive:true});if(resolve(launcher)!==resolve(join(debugRoot,'trex-browser')))copyFileSync(launcher,join(debugRoot,'trex-browser'));cpSync(join(destination,'trex-browser-runtime'),join(debugRoot,'trex-browser-runtime'),{recursive:true});}
    if(argv.includes('--standalone')){const output=join(installer,'output');mkdirSync(output,{recursive:true});const final=join(output,`TrexBrowser_${packageJson.version}_linux_${arch}.tar.xz`),temporary=join(output,`.TrexBrowser-${randomUUID()}.tar.xz`);run('/usr/bin/tar',['-cJf',temporary,'-C',destination,'trex-browser','trex-browser-runtime']);renameSync(temporary,final);console.log(`Linux standalone archive: ${final}`);}
    console.log(`Trex Browser Linux payload verified: Node ${NODE_VERSION}, Playwright ${packageJson.dependencies.playwright}.`);
  }finally{removeOwnedBuild(work)}
}
