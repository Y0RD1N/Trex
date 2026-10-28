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
const text=node=>typeof node==='string'?node:Array.isArray(node)?node.map(text).join(''):node&&typeof node==='object'?text(node.props?.children):'';
function fixture(t,extra={}){
  const host=harness.host(t),calls=[],opened=[],stopped=[],timers=new Map();let seq=0,tree;
  const spaces=[{clientId:'team-principal',profile:'BROWSER2',label:'Principal'},{clientId:'team-review',profile:'BROWSER3',label:'Review'}];
  const api={
    async trexBrowserStatus(){return {installed:true,ready:true,compatible:true};},
    async trexBrowserResolveSpace(_cwd,options){return extra.binding??options;},
    async trexBrowserListSpaces(){return {spaces:extra.inventory??spaces};},
    async trexBrowserCall(request){calls.push(request);const data=request.name==='browser_status'?{running:true,tabs:1,paused:false,owner:'self'}:request.name==='browser_tabs'?{tabs:[{tabId:'tab-'+request.clientId,title:'Page '+request.clientId,url:'http://localhost:3000',selected:true}]}:{paused:request.name==='browser_pause'};
      const artifacts=request.name==='browser_take_screenshot'?[{artifactId:'fixture-capture',sha256:'a'.repeat(64),mimeType:'image/png',bytes:10,kind:'screenshot',profile:request.profile,projectId:'project'}]:[];
      return {content:[],isError:false,structuredContent:{ok:true,data,artifacts}};},
    async trexBrowserOpenArtifact(...args){opened.push(args);return {content:[],isError:false};},
  };
  const exports={};compile(name=>{
    if(name==='react')return {...harness.react,useId:()=>harness.react.useRef('spaces-fixture').current};
    if(name==='react/jsx-runtime')return harness.jsxRuntime;
    if(name==='../../api')return api;if(name==='../../browser')return browser;
    if(name==='../DropdownMenu')return {default:'DropdownMenu'};
    if(name==='../Icons')return {CloseIcon:'CloseIcon',GlobeIcon:'GlobeIcon',ImageIcon:'ImageIcon'};
    if(name.endsWith('.css'))return {};throw new Error('Unexpected import '+name);
  },exports,{setInterval:callback=>{const id=++seq;timers.set(id,callback);return id;},clearInterval:id=>timers.delete(id)},{randomUUID:()=>`operation-${++seq}`});
  const render=()=>tree=host.render(()=>exports.default({cwd:'D:/fixture',browser:extra.browser??{enabled:true,...spaces[0]},spaces:extra.localSpaces===false?undefined:spaces,onStopAgent:id=>stopped.push(id)}));
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
