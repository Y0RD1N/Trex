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
function fixture(t){
  const host=harness.host(t),calls=[],opened=[],stopped=[],timers=new Map();let seq=0,tree;
  const spaces=[{clientId:'team-principal',profile:'BROWSER2',label:'Principal'},{clientId:'team-review',profile:'BROWSER3',label:'Review'}];
  const api={
    async trexBrowserStatus(){return {installed:true,ready:true,compatible:true};},
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
  const render=()=>tree=host.render(()=>exports.default({cwd:'D:/fixture',browser:{enabled:true,...spaces[0]},spaces,onStopAgent:id=>stopped.push(id)}));
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
