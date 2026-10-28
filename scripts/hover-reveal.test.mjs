import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const code = ts.transpileModule(await readFile(new URL("../src/hooks/useHoverReveal.ts", import.meta.url), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const compile = new Function("require", "exports", "window", "document", code);

function harness(t, extra = {}) {
  const slots = [], listeners = new Map(), timers = new Map(); let cursor = 0, dirty = false, effects = [], now = 0, serial = 0;
  const same = (a,b) => a && b && a.length === b.length && a.every((v,i) => Object.is(v,b[i]));
  const react = {
    useState(initial) { const slot = slots[cursor++] ??= { value: initial }; return [slot.value, value => { if (slot.value !== value) { slot.value = value; dirty = true; } }]; },
    useRef(initial) { return slots[cursor++] ??= { current: initial }; },
    useCallback(fn,deps) { const i=cursor++; if(!same(slots[i]?.deps,deps))slots[i]={deps,value:fn};return slots[i].value; },
    useEffect(fn,deps) { const i=cursor++,previous=slots[i];if(!same(previous?.deps,deps))effects.push(()=>{previous?.cleanup?.();slots[i]={deps,cleanup:fn()};}); },
  };
  const window = { setTimeout(fn,delay){const id=++serial;timers.set(id,{at:now+delay,fn});return id;},clearTimeout:id=>timers.delete(id),
    addEventListener:(name,fn)=>listeners.set(name,fn),removeEventListener:(name,fn)=>{if(listeners.get(name)===fn)listeners.delete(name);} };
  const document = { querySelector:()=>null,documentElement:{addEventListener:window.addEventListener,removeEventListener:window.removeEventListener} };
  const exports={};compile(name=>{assert.equal(name,"react");return react;},exports,window,document);
  const options={enabled:true,edge:"left",extent:260,...extra};let state;
  const render=()=>{for(let i=0;i<15;i++){cursor=0;dirty=false;effects=[];state=exports.useHoverReveal(options);for(const effect of effects)effect();if(!dirty)return state;}throw Error("Reveal did not settle");};
  const advance=ms=>{const end=now+ms;for(;;){const next=[...timers].filter(([,v])=>v.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!next)break;now=next[1].at;timers.delete(next[0]);next[1].fn();render();}now=end;render();};
  render();t.after(()=>{for(const slot of slots)slot?.cleanup?.();});
  return {get state(){return state;},move(x,y,buttons=0){listeners.get("pointermove")({clientX:x,clientY:y,buttons});render();},advance};
}

test("sidebar can reveal inside the native resize border rather than requiring a precise edge pixel", t=>{
  const h=harness(t);h.move(12,300);h.advance(79);assert.equal(h.state.revealed,false);h.advance(1);assert.equal(h.state.revealed,true);
});
test("the top bar also has a usable hover strip and leaves the sidebar corner free", t=>{
  const h=harness(t,{edge:"top",extent:42,openFrom:28});h.move(12,12);h.advance(100);assert.equal(h.state.revealed,false);
  h.move(200,12);h.advance(80);assert.equal(h.state.revealed,true);
});
test("jitter and a brief excursion do not close and reopen the sidebar", t=>{
  const h=harness(t);h.move(12,300);h.advance(80);h.move(268,300);h.advance(400);assert.equal(h.state.revealed,true);
  h.move(290,300);h.advance(160);h.move(100,300);h.advance(500);assert.equal(h.state.revealed,true);
  h.move(290,300);h.advance(360);assert.equal(h.state.revealed,false);
});
test("dragging or merely crossing the edge cannot reveal the panel", t=>{
  const h=harness(t);h.move(12,300,1);h.advance(500);assert.equal(h.state.revealed,false);
  h.move(12,300);h.advance(40);h.move(30,300);h.advance(100);assert.equal(h.state.revealed,false);
});
