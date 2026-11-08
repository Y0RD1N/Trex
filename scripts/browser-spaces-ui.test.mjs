import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';
import {load} from './ts-loader.mjs';

// Real component and hooks; only DOM positioning, timers and native IPC are replaced.
const url=new URL('./queue-workflow-controls.test.mjs',import.meta.url),source=await readFile(url,'utf8');
const ast=ts.createSourceFile(url.pathname,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
const body=ast.statements.filter(node=>ts.isVariableStatement(node)||ts.isFunctionDeclaration(node)).map(node=>node.getText(ast)).join('\n').replaceAll('import.meta.url',JSON.stringify(url.href));
const harness=await new (Object.getPrototypeOf(async function(){}).constructor)('assert','readFile','test','ts','load',body+'\nreturn {host,react,jsxRuntime,flush};')(assert,readFile,test,ts,load);
const browser=await load('browser');
const componentSource=await readFile(new URL('../src/components/chat/BrowserMenu.tsx',import.meta.url),'utf8');
const compile=new Function('require','exports','window','crypto',ts.transpileModule(componentSource,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText);
const nodes=node=>!node||typeof node!=='object'?[]:Array.isArray(node)?node.flatMap(nodes):[node,...nodes(node.props?.children)];
const text=node=>typeof node==='string'||typeof node==='number'?String(node):Array.isArray(node)?node.map(text).join(''):node&&typeof node==='object'?text(node.props?.children):'';
function fixture(t,extra={}){
  const host=harness.host(t),calls=[],opened=[],stopped=[],timers=new Map();let seq=0,tree;
  const spaces=[{clientId:'team-principal',profile:'BROWSER2',label:'Principal',running:true},{clientId:'team-review',profile:'BROWSER3',label:'Review',running:true}];
  const api={
    async trexBrowserStatus(){return {installed:true,ready:true,compatible:true};},
    async trexBrowserResolveSpace(_cwd,options){return extra.binding??options;},
    async trexBrowserListSpaces(){return extra.listSpaces?extra.listSpaces():{spaces:extra.inventory??spaces};},
    async trexBrowserCall(request){calls.push(request);const forced=extra.reply?.(request);if(forced)return forced;if(extra.failAction?.(request))throw new Error('fixture action failure');const data=request.name==='browser_status'?{running:extra.running??true,tabs:extra.running===false?0:1,paused:false,owner:'self'}:request.name==='browser_tabs'?{tabs:[{tabId:'tab-'+request.clientId,title:'Page '+request.clientId,url:'http://localhost:3000',selected:true}]}:{paused:request.name==='browser_pause'};
      const artifacts=request.name==='browser_take_screenshot'?[{artifactId:'fixture-capture',sha256:'a'.repeat(64),mimeType:'image/png',bytes:10,kind:'screenshot',profile:request.profile,projectId:'project'}]:[];
      return {content:[],isError:false,structuredContent:{ok:true,data,artifacts}};},
    async trexBrowserOpenArtifact(...args){opened.push(args);return {content:[],isError:false};},
    ...extra.api,
  };
  const exports={};compile(name=>{
    if(name==='react')return {...harness.react,useId:()=>harness.react.useRef('spaces-fixture').current};
    if(name==='react/jsx-runtime')return harness.jsxRuntime;
    if(name==='../../api')return api;if(name==='../../browser')return browser;
    if(name==='../DropdownMenu')return {default:'DropdownMenu'};
    if(name==='../Icons')return {CloseIcon:'CloseIcon',GlobeIcon:'GlobeIcon',ImageIcon:'ImageIcon'};
    if(name.endsWith('.css'))return {};throw new Error('Unexpected import '+name);
  },exports,{setInterval:callback=>{const id=++seq;timers.set(id,callback);return id;},clearInterval:id=>timers.delete(id)},{randomUUID:()=>`operation-${++seq}`});
  const render=()=>tree=host.render(()=>exports.default({cwd:'D:/fixture',browser:extra.browser??{enabled:true,...spaces[0]},spaces:extra.localSpaces===false?undefined:Array.isArray(extra.localSpaces)?extra.localSpaces:spaces,onStopAgent:id=>stopped.push(id)}));
  const settle=async()=>{for(let i=0;i<6;i++){await harness.flush();render();}};
  const button=label=>nodes(tree).find(node=>node.type==='button'&&text(node).includes(label));
  render();return {calls,opened,stopped,spaces,render,settle,button,get tree(){return tree;},get timers(){return timers;}};
}
test('switching a browser space binds tab and capture operations to that member only',async t=>{
  const f=fixture(t);f.button('Espacios').props.onClick();await f.settle();
  f.button('Review').props.onClick();await f.settle();f.calls.length=0;
  f.button('Nueva pestaña').props.onClick();await f.settle();
  assert.equal(f.calls.find(call=>call.name==='browser_tabs').profile,'BROWSER3');
  assert.equal(f.calls.find(call=>call.name==='browser_tabs').clientId,'team-review');
  f.button('Tomar captura').props.onClick();await f.settle();
  f.button('Abrir captura').props.onClick();await f.settle();
  assert.equal(f.opened[0][3],'team-review');assert.equal(f.opened[0][4],'BROWSER3');
  assert.ok(!f.calls.some(call=>call.profile==='BROWSER2'));
});
test('closing a space first pauses its inputs; stopping an agent retains its exact identity',async t=>{
  const f=fixture(t);f.button('Espacios').props.onClick();await f.settle();f.button('Review').props.onClick();await f.settle();f.calls.length=0;
  f.button('Cerrar este espacio').props.onClick();await f.settle();
  assert.deepEqual(f.calls.filter(call=>['browser_pause','browser_close'].includes(call.name)).map(call=>[call.name,call.clientId]),[['browser_pause','team-review'],['browser_close','team-review']]);
  f.button('Detener agente').props.onClick();await f.settle();assert.deepEqual(f.stopped,['team-review']);
});

test('an ordinary chat can inspect and control another chat instance from the project overview',async t=>{
  const other={clientId:'other-chat',profile:'BROWSER4',label:'Codex · Caja',running:true,active:true,currentTool:'browser_snapshot',url:'http://127.0.0.1:5176/vender',tabCount:2};
  const f=fixture(t,{localSpaces:false,inventory:[{clientId:'team-principal',profile:'BROWSER2',label:'Principal',running:true},other]});
  f.button('Navegador').props.onClick();await f.settle();
  assert.ok(text(f.tree).includes(other.url));assert.ok(text(f.tree).includes('Inspeccionando'));assert.ok(text(f.tree).includes('2 pestañas'));
  f.button('Codex · Caja').props.onClick();await f.settle();f.calls.length=0;
  f.button('Nueva pestaña').props.onClick();await f.settle();
  assert.equal(f.calls.find(call=>call.name==='browser_tabs').profile,'BROWSER4');assert.equal(f.calls.find(call=>call.name==='browser_tabs').clientId,'other-chat');
  assert.equal(f.calls.find(call=>call.name==='browser_tabs').arguments.url,other.url);
  f.calls.length=0;f.button('Cerrar este espacio').props.onClick();await f.settle();
  assert.deepEqual(f.calls.filter(call=>['browser_pause','browser_close'].includes(call.name)).map(call=>[call.name,call.profile,call.clientId]),[['browser_pause','BROWSER4','other-chat'],['browser_close','BROWSER4','other-chat']]);
  assert.equal(f.button('Detener agente'),undefined,'a panel must not offer an agent-stop handler for another chat');
  assert.ok(!f.calls.some(call=>call.name==='browser_takeover'));
});

test('opening automatic controls resolves their own profile before any browser command',async t=>{
  const f=fixture(t,{localSpaces:false,browser:{enabled:true,automatic:true,profile:'BROWSER1',clientId:'own'},binding:{enabled:true,profile:'BROWSER8',clientId:'own'},inventory:[]});
  f.button('Navegador').props.onClick();await f.settle();f.calls.length=0;
  f.button('Nueva pestaña').props.onClick();await f.settle();
  assert.ok(f.calls.length);assert.ok(f.calls.every(call=>call.profile==='BROWSER8'&&call.clientId==='own'));
});

test('legacy and allocated profiles with the same client remain separate selectable instances',async t=>{
  const inventory=[{clientId:'same',profile:'BROWSER1',label:'Manual',running:true},{clientId:'same',profile:'BROWSER2',label:'Current',running:true}];
  const f=fixture(t,{localSpaces:false,browser:{enabled:true,profile:'BROWSER2',clientId:'same'},inventory});
  f.button('Navegador').props.onClick();await f.settle();
  for(const [label,profile]of [['Manual','BROWSER1'],['Current','BROWSER2']]){
    f.button(label).props.onClick();await f.settle();f.calls.length=0;f.button('Nueva pestaña').props.onClick();await f.settle();
    assert.equal(f.calls.find(call=>call.name==='browser_tabs').profile,profile);
  }
});

test('pending automatic binding cannot issue controls against the shared fallback profile',async t=>{
  let release;const binding=new Promise(resolve=>{release=resolve;});
  const f=fixture(t,{localSpaces:false,browser:{enabled:true,automatic:true,profile:'BROWSER1',clientId:'own'},binding,inventory:[]});
  f.button('Navegador').props.onClick();await f.settle();assert.equal(f.button('Nueva pestaña'),undefined);assert.deepEqual(f.calls,[]);
  release({enabled:true,profile:'BROWSER7',clientId:'own'});await f.settle();f.calls.length=0;
  f.button('Nueva pestaña').props.onClick();await f.settle();assert.ok(f.calls.every(call=>call.profile==='BROWSER7'));
});

test('project refresh preserves the selected instance and a manually entered address',async t=>{
  const inventory=[{clientId:'one',profile:'BROWSER2',label:'First',running:true,url:'http://localhost:5173/'},{clientId:'two',profile:'BROWSER3',label:'Second',running:true,url:'http://localhost:5174/'}];
  const f=fixture(t,{localSpaces:false,browser:{enabled:true,clientId:'one',profile:'BROWSER2'},inventory});
  f.button('Navegador').props.onClick();await f.settle();f.button('Second').props.onClick();await f.settle();
  nodes(f.tree).find(node=>node.type==='input').props.onChange({target:{value:'http://localhost:5199/custom'}});await f.settle();
  inventory.reverse();for(const callback of [...f.timers.values()])callback();await f.settle();f.calls.length=0;
  f.button('Nueva pestaña').props.onClick();await f.settle();
  const request=f.calls.find(call=>call.name==='browser_tabs');assert.equal(request.clientId,'two');assert.equal(request.profile,'BROWSER3');assert.equal(request.arguments.url,'http://localhost:5199/custom');
});

test('a failed inventory query recovers on the next refresh without a permanent installation warning',async t=>{
  let fail=true;
  const f=fixture(t,{listSpaces:async()=>{if(fail)throw new Error('temporary inventory failure');return {spaces:[{clientId:'other',profile:'BROWSER4',label:'Recovered agent',inUse:true,running:true}]};}});
  f.button('Espacios').props.onClick();await f.settle();
  assert.ok(text(f.tree).includes('Se volverá a intentar automáticamente.'));
  fail=false;for(const callback of [...f.timers.values()])callback();await f.settle();
  assert.ok(f.button('Recovered agent'));
  assert.ok(!text(f.tree).includes('No se pudieron consultar las instancias'));
});

test('a successful inventory refresh does not hide a failed browser action',async t=>{
  const f=fixture(t,{failAction:request=>request.name==='browser_tabs'&&request.arguments.action==='new'});
  f.button('Espacios').props.onClick();await f.settle();
  f.button('Nueva pestaña').props.onClick();await f.settle();
  const error='No se pudo conectar con Trex Browser. Comprueba su instalación en Ajustes.';
  assert.ok(text(f.tree).includes(error));
  for(const callback of [...f.timers.values()])callback();await f.settle();
  assert.ok(text(f.tree).includes(error));
});

test('reserved and historical profiles stay hidden until an agent actually opens its browser',async t=>{
  const reserved=[{clientId:'team-principal',profile:'BROWSER2',label:'Principal'},{clientId:'team-review',profile:'BROWSER3',label:'Review'}];
  const inventory=[...reserved.map(space=>({...space,running:false,active:true})),{clientId:'old',profile:'BROWSER4',label:'Historical chat',running:false,inUse:true}];
  const options={localSpaces:reserved,inventory,running:false};
  const f=fixture(t,options);f.button('Navegador').props.onClick();await f.settle();
  assert.ok(text(f.tree).includes('No hay espacios abiertos.'));
  assert.equal(f.button('Historical chat'),undefined);assert.equal(f.button('Review'),undefined);
  assert.ok(!f.calls.some(call=>call.name==='browser_tabs'),'checking the menu must not open tabs');
  inventory[1].running=true;options.running=true;
  for(const callback of [...f.timers.values()])callback();await f.settle();
  assert.ok(f.button('Review'));assert.equal(f.button('Historical chat'),undefined);
  assert.ok(!text(f.tree).includes('No hay espacios abiertos.'));
  inventory[1].running=false;
  for(const callback of [...f.timers.values()])callback();await f.settle();
  assert.equal(f.button('Review'),undefined);
});

const alertText=f=>{const node=nodes(f.tree).find(item=>item.props?.role==='alert');return node?text(node):undefined;};
const noteText=f=>{const node=nodes(f.tree).find(item=>item.props?.role==='status'&&item.props?.className==='chat-browser-note');return node?text(node):undefined;};

test('Mostrar ventana tells why the window was not raised instead of doing nothing',async t=>{
  let outcome;const asked=[];
  const f=fixture(t,{api:{async trexBrowserFocus(...args){asked.push(args);if(typeof outcome==='string'||outcome instanceof Error)throw outcome;return outcome;}}});
  f.button('Espacios').props.onClick();await f.settle();
  outcome={focused:true};f.button('Mostrar ventana').props.onClick();await f.settle();
  assert.deepEqual(asked[0],['D:/fixture','BROWSER2',undefined]);assert.equal(alertText(f),undefined);assert.equal(noteText(f),undefined);
  outcome={focused:false,reason:'external-browser'};f.button('Mostrar ventana').props.onClick();await f.settle();
  assert.match(noteText(f),/Chrome del sistema/);assert.equal(alertText(f),undefined);
  outcome={focused:false};f.button('Mostrar ventana').props.onClick();await f.settle();assert.match(noteText(f),/No se pudo traer la ventana al frente/);
  outcome='Trex Browser indicó: sin ventana';f.button('Mostrar ventana').props.onClick();await f.settle();assert.equal(alertText(f),'Trex Browser indicó: sin ventana');
  outcome=new Error('private diagnostic');f.button('Mostrar ventana').props.onClick();await f.settle();assert.equal(alertText(f),'No se pudo traer la ventana al frente.');
  outcome={focused:true};f.button('Mostrar ventana').props.onClick();await f.settle();assert.equal(alertText(f),undefined,'a successful raise clears the previous failure');
});

test('a failed tab raise still falls back to selecting the tab for an external Chrome',async t=>{
  const f=fixture(t,{api:{async trexBrowserFocus(){return {focused:false,reason:'external-browser'};}}});
  f.button('Espacios').props.onClick();await f.settle();f.calls.length=0;
  f.button('Page team-principal').props.onClick();await f.settle();
  assert.deepEqual(f.calls.filter(call=>call.name==='browser_tabs').map(call=>call.arguments.action),['select']);
});

test('an error result from the status poll is reported and does not read as an idle, unpaused space',async t=>{
  let broken=false;
  const paused={content:[],isError:false,structuredContent:{ok:true,data:{running:true,tabs:1,paused:true,pauseReason:'manual',owner:'self'}}};
  const failed={content:[{type:'text',text:'closing'}],isError:true,structuredContent:{ok:false,error:{code:'PROFILE_CLOSING',message:'closing'}}};
  const f=fixture(t,{reply:request=>request.name==='browser_status'?(broken?failed:paused):undefined});
  f.button('Espacios').props.onClick();await f.settle();
  assert.ok(f.button('Reanudar automatización'));assert.equal(alertText(f),undefined);
  broken=true;for(const callback of [...f.timers.values()])callback();await f.settle();
  assert.match(alertText(f),/No se pudo consultar el estado de este espacio/);
  assert.ok(f.button('Reanudar automatización'),'the last known pause is kept, not reset to "running"');
  broken=false;for(const callback of [...f.timers.values()])callback();await f.settle();
  assert.equal(alertText(f),undefined,'the poll error clears itself once a poll succeeds');
});

test('a poll that throws is reported through the same self-clearing channel',async t=>{
  let broken=false;
  const f=fixture(t,{failAction:request=>broken&&request.name==='browser_status'});
  f.button('Espacios').props.onClick();await f.settle();
  broken=true;for(const callback of [...f.timers.values()])callback();await f.settle();
  assert.match(alertText(f),/No se pudo consultar el estado/);
  broken=false;for(const callback of [...f.timers.values()])callback();await f.settle();assert.equal(alertText(f),undefined);
});

test('Actualizar estado confirms when it finished and reports when it did not',async t=>{
  let refuse=false;
  const f=fixture(t,{reply:request=>refuse&&request.name==='browser_status'&&request.timeoutMs===60000?{content:[],isError:true,structuredContent:{ok:false,error:{code:'UNCERTAIN'}}}:undefined});
  f.button('Espacios').props.onClick();await f.settle();
  f.button('Actualizar estado').props.onClick();await f.settle();
  assert.match(noteText(f),/^Estado actualizado a las \d{1,2}:\d{2}:\d{2}\.$/);
  refuse=true;f.button('Actualizar estado').props.onClick();await f.settle();
  assert.match(alertText(f),/La acción no se confirmó/);assert.equal(noteText(f),undefined);
});

test('personal and sign-in windows show the native reason instead of one generic sentence',async t=>{
  let outcome;const opened=[];
  const api={async trexBrowserOpen(...args){opened.push(args);if(typeof outcome==='string'||outcome instanceof Error)throw outcome;return outcome;}};
  const f=fixture(t,{api,localSpaces:false,browser:{enabled:true,clientId:'own',profile:'BROWSER5'},inventory:[]});
  f.button('Navegador').props.onClick();await f.settle();
  const personal='Este espacio está abierto en otra ventana independiente de Trex Browser. Ciérrala e inténtalo de nuevo.';
  outcome=personal;f.button('Abrir Trex Browser personal').props.onClick();await f.settle();assert.equal(alertText(f),personal);
  outcome={opened:true,reused:false};f.button('Abrir Trex Browser personal').props.onClick();await f.settle();
  assert.equal(alertText(f),undefined);assert.match(noteText(f),/Pestañas personales abiertas/);
  outcome=new Error('private diagnostic');f.button('Abrir Trex Browser personal').props.onClick();await f.settle();assert.equal(alertText(f),'No se pudo abrir Trex Browser.');
  outcome='El servicio de Trex Browser no respondió a tiempo. Vuelve a intentarlo en unos segundos.';
  f.button('Iniciar sesión para este agente').props.onClick();await f.settle();
  assert.deepEqual(opened.at(-1),[{cwd:'D:/fixture',profile:'BROWSER5'}]);assert.match(alertText(f),/no respondió a tiempo/);
  outcome={opened:false,reason:'unknown-profile'};f.button('Iniciar sesión para este agente').props.onClick();await f.settle();assert.match(alertText(f),/todavía no existe/);
  outcome={opened:false,reason:'something-else'};f.button('Iniciar sesión para este agente').props.onClick();await f.settle();assert.match(alertText(f),/No se pudo abrir este espacio/);
  outcome={opened:true};f.button('Iniciar sesión para este agente').props.onClick();await f.settle();assert.equal(alertText(f),undefined);assert.match(noteText(f),/Espacio abierto en la ventana compartida/);
});

test('lean artifacts from an agent (no checksum, no size) get recent-file buttons that open by id',async t=>{
  const lean={artifactId:'3f1f2f0e-0000-4000-8000-000000000001',kind:'screenshot',mimeType:'image/png',width:640,height:480};
  const f=fixture(t,{reply:request=>request.name==='browser_take_screenshot'?{content:[{type:'text',text:JSON.stringify({ok:true,artifacts:[lean]})}],isError:false,structuredContent:{ok:true,artifacts:[lean]}}:undefined});
  f.button('Espacios').props.onClick();await f.settle();
  f.button('Tomar captura').props.onClick();await f.settle();
  const chip=f.button('Abrir captura');assert.ok(chip);assert.equal(chip.props.disabled,false);
  assert.ok(!/NaN|undefined/.test(text(chip)),text(chip));assert.ok(!text(chip).includes('kB'),'an unknown size is not shown as a made-up one');
  chip.props.onClick();await f.settle();
  assert.deepEqual(f.opened[0],[lean.artifactId,'D:/fixture','full','team-principal','BROWSER2']);
});

// ---- Ajustes del navegador ----------------------------------------------------------------
const settingsSource=await readFile(new URL('../src/components/BrowserSettings.tsx',import.meta.url),'utf8');
const compileSettings=new Function('require','exports',ts.transpileModule(settingsSource,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText);
function settingsFixture(t,extra={}){
  const host=harness.host(t),calls=[],engineChanges=[];let tree,statusCalls=0;
  const engine=extra.engine??{engine:'auto',engines:{trex:true,chrome:true},active:'trex'};
  const api={
    async trexBrowserStatus(){statusCalls++;return typeof extra.status==='function'?extra.status(statusCalls):extra.status??{installed:true,ready:true,compatible:true,capabilities:{saveDownloads:true}};},
    async trexBrowserEngine(choice){if(choice){engineChanges.push(choice);engine.engine=choice;if(extra.afterEngine)extra.afterEngine(choice);return {...engine};}if(extra.engineFails)throw new Error('engine unavailable');return {...engine};},
    async trexBrowserSaveFolders(){if(extra.foldersFail)throw new Error('folders unavailable');return {folders:[]};},
    async trexBrowserProfiles(cwd){calls.push(['profiles',cwd]);if(extra.profilesFail)throw new Error('profiles unavailable');return {profiles:extra.profiles??[]};},
  };
  const exports={};compileSettings(name=>{
    if(name==='react')return {...harness.react,useId:()=>harness.react.useRef('settings-fixture').current};
    if(name==='react/jsx-runtime')return harness.jsxRuntime;
    if(name==='@tauri-apps/plugin-dialog')return {open:async()=>null};
    if(name==='../api')return api;if(name==='../browser')return browser;
    if(name==='./Select')return {__esModule:true,default:'Select'};
    if(name==='./Icons')return new Proxy({},{get:(_target,key)=>String(key)});
    if(name.endsWith('.css'))return {};throw new Error('Unexpected import '+name);
  },exports);
  const render=()=>tree=host.render(()=>exports.default({settings:{browserEnabled:true,browserProfile:'BROWSER1'},cwd:extra.cwd??'D:/fixture',onChange(){}}));
  const settle=async()=>{for(let i=0;i<6;i++){await harness.flush();render();}};
  render();return {render,settle,calls,engineChanges,get tree(){return tree;},get statusCalls(){return statusCalls;},
    select:()=>nodes(tree).find(node=>node.type==='Select'),
    button:label=>nodes(tree).find(node=>node.type==='button'&&text(node).includes(label)),
    alerts:()=>nodes(tree).filter(node=>node.props?.role==='alert').map(text)};
}

test('settings no longer offer a manual profile that no chat would ever use',async t=>{
  const f=settingsFixture(t,{profiles:['BROWSER1','BROWSER2','BROWSER3','BROWSER4'].map(id=>({id,name:id,projectId:'p',createdAt:'2026-01-01'}))});
  await f.settle();
  const all=text(f.tree);
  assert.ok(!all.includes('Perfil manual')&&!all.includes('Nuevo perfil')&&!all.includes('Crear perfil'));
  assert.ok(all.includes('Cada chat recibe su propio perfil'));
  assert.ok(all.includes('Este proyecto usa 3 de 98 espacios.'),'BROWSER1 is the manual profile; the rest are chat spaces');
  assert.ok(!all.includes('Quedan pocos'));
});

test('settings warn when the project is close to running out of chat spaces',async t=>{
  const profiles=Array.from({length:92},(_,index)=>({id:`BROWSER${index+2}`,name:'x',projectId:'p',createdAt:'2026-01-01'}));
  const f=settingsFixture(t,{profiles});await f.settle();
  assert.ok(text(f.tree).includes('Este proyecto usa 92 de 98 espacios.'));assert.ok(text(f.tree).includes('Quedan pocos'));
});

test('changing the browser re-checks the status and cannot pick a browser that was not found',async t=>{
  const f=settingsFixture(t,{engine:{engine:'auto',engines:{trex:true,chrome:false},active:'trex'},
    status:count=>count<2?{installed:true,ready:true,compatible:true}:{installed:true,ready:false,compatible:true,error:{code:'missing_browser',message:'No se encontró el navegador de Trex ni Chrome.'}}});
  await f.settle();
  assert.ok(text(f.tree).includes('Listo para usar'));
  const chrome=f.select().props.options.find(option=>option.value==='chrome');
  assert.equal(chrome.disabled,true);assert.match(chrome.label,/no encontrado/);
  assert.equal(f.select().props.options.find(option=>option.value==='auto').disabled,undefined);
  const before=f.statusCalls;
  f.select().props.onChange('auto');await f.settle();
  assert.deepEqual(f.engineChanges,['auto']);
  assert.ok(f.statusCalls>before,'the status is checked again after the choice');
  assert.ok(text(f.tree).includes('Necesita atención'));assert.ok(!text(f.tree).includes('Listo para usar'));
  assert.ok(text(f.tree).includes('No se encontró el navegador de Trex ni Chrome.'));
});

test('failing to read the browser choice or the download folders is said, not hidden',async t=>{
  const f=settingsFixture(t,{engineFails:true,foldersFail:true});await f.settle();
  assert.equal(f.select(),undefined);
  assert.deepEqual(f.alerts().sort(),['No se pudieron leer las carpetas de descargas. Pulsa Comprobar para reintentarlo.','No se pudo leer qué navegador usan los agentes. Pulsa Comprobar para reintentarlo.']);
  assert.ok(f.button('Comprobar'));
});

test('a failing profile listing does not break the status or show an error',async t=>{
  const f=settingsFixture(t,{profilesFail:true});
  await f.settle();assert.deepEqual(f.alerts(),[]);assert.ok(text(f.tree).includes('Listo para usar'));
  assert.ok(f.calls.some(call=>call[0]==='profiles'));assert.ok(!text(f.tree).includes('Este proyecto usa'));
});
