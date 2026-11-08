import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import { load } from "./ts-loader.mjs";
const terminalModule = await load("agentTerminals");
const lineBatchModule = await load("lineBatch");
const code = ts.transpileModule(await readFile(new URL("../src/hooks/chatSession.ts",import.meta.url),"utf8"),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
const compile = new Function("require","exports",code);
const tick = () => new Promise(resolve=>setImmediate(resolve));
const same=(a,b)=>a&&b&&a.length===b.length&&a.every((v,i)=>Object.is(v,b[i]));
function harness(t){
  const slots=[],effects=[],lines=new Map(),exits=new Map(),forwarded=[],killed=[],writes=[];let cursor=0,current;
  const hooks={
    useRef(value){return slots[cursor++]??={current:value}},
    useMemo(callback,deps){const i=cursor++;if(!same(slots[i]?.deps,deps))slots[i]={deps,value:callback()};return slots[i].value},
    useCallback(fn,deps){return hooks.useMemo(()=>fn,deps)},
    useReducer(reducer,initial){const i=cursor++;slots[i]??={value:initial};const slot=slots[i];slot.dispatch??=action=>{slot.value=reducer(slot.value,action)};return[slot.value,slot.dispatch]},
    useEffect(effect,deps){const i=cursor++;if(!same(slots[i]?.deps,deps))effects.push(()=>{slots[i]?.cleanup?.();slots[i]={deps,cleanup:effect()}})},
  };
  const api={agentSpawn:async()=>{},agentKill:async id=>{killed.push(id)},agentTerminalOutput:async()=>({available:false,text:"",truncated:false}),
    listenAgentLine:async(id,fn)=>{lines.set(id,fn);return()=>lines.delete(id)},listenAgentExit:async(id,fn)=>{exits.set(id,fn);return()=>exits.delete(id)},listenAgentStderr:async()=>()=>{},
    agentWrite:async(id,line)=>{const request=JSON.parse(line);writes.push({runtime:id,...request});if(request.method==="thread/backgroundTerminals/list")queueMicrotask(()=>lines.get(id)?.(JSON.stringify({id:request.id,result:{data:[{processId:"42",itemId:"a",command:"dev server",cwd:"D:/project"}]}})))},
  };
  const exports={};compile(name=>name==="react"?hooks:name==="../api"?api:name==="../agentTerminals"?terminalModule:name==="../lineBatch"?lineBatchModule:(()=>{throw Error(name)})(),exports);
  const render=()=>{cursor=0;current=exports.useAgentProcess("tab",{onLine:(line,id)=>forwarded.push({id,line}),onExit(){},onStderr(){}},"codex");for(const effect of effects.splice(0))effect();return current};
  render();t.after(()=>{for(const slot of slots)slot?.cleanup?.()});
  return{render,lines,exits,forwarded,killed,writes,get current(){return render()}};
}
test("The actual transport exposes owned terminal state and consumes only its own RPC replies",async t=>{
  const h=harness(t);const id=await h.current.spawn({cwd:"D:/project",command:"codex",flags:["app-server"]});h.current.bindTerminals("thread");await h.current.terminals.refresh();
  assert.equal(h.current.terminals.snapshot.entries[0].command,"dev server");assert.equal(h.forwarded.length,0);
  h.lines.get(id)(JSON.stringify({method:"turn/completed",params:{threadId:"thread"}}));
  // Las líneas se entregan por tandas (lineBatch): una llegada a menos de 50 ms de otra espera a la siguiente.
  await new Promise(resolve=>setTimeout(resolve,80));assert.equal(h.forwarded.length,1);
  assert.equal(h.current.terminals.snapshot.entries[0].state,"running");
});
test("Transport replacement rejects old observers without clearing or writing to the new runtime",async t=>{
  const h=harness(t);const first=await h.current.spawn({cwd:"D:/project",command:"codex",flags:[]}),oldLine=h.lines.get(first),oldExit=h.exits.get(first);
  const second=await h.current.spawn({cwd:"D:/project",command:"codex",flags:[]});h.current.bindTerminals("new-thread");await h.current.terminals.refresh();
  oldExit(0);oldLine(JSON.stringify({method:"item/commandExecution/outputDelta",params:{threadId:"new-thread",itemId:"a",delta:"STALE"}}));
  assert.equal(h.current.terminals.snapshot.status,"ready");assert.equal(h.current.terminals.snapshot.entries[0].output,"");
  assert.deepEqual(h.killed,[first]);assert.ok(h.writes.every(write=>write.runtime===second));
});
