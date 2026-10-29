import test from "node:test";
import assert from "node:assert/strict";
import { load } from "./ts-loader.mjs";
const { parseAntigravityUsage, acpContext, AntigravityUsageReader } = await load("antigravityUsage");
const { antigravityReducer } = await load("antigravityChat");
const { trexReducer } = await load("trexChat");
const { initialChatState, contextPercent } = await load("chatState");
const { readApiUsage } = await load("tokenUsage");
const report = `### Session Usage
- **Session total:** 13,224 tokens (prompt: 13,138, completion: 6, thinking: 80)

### Quota Limits
- **Gemini Models**
  *(Models within this group: Gemini Flash, Gemini Pro)*
  - **Weekly Limit Remaining:** 95% remaining (resets Nov 01, 2026, 16:02 UTC)
- **Claude and GPT models**
  *(Models within this group: Claude Opus, Claude Sonnet, GPT-OSS)*
  - **Weekly Limit Remaining:** 100% remaining (resets Nov 01, 2026, 16:02 UTC)`;
test("official ACP report keeps thinking separate from completion and reads real scoped quotas", () => {
  const result = parseAntigravityUsage(report, "Google AI Plus");
  assert.equal(result.apiUsage.totalTokens, 13224);
  assert.equal(result.apiUsage.outputTokens, 6); assert.equal(result.apiUsage.reasoningTokens, 80);
  assert.equal(result.apiUsage.costUsd, null); assert.equal(result.apiUsage.requests, null);
  assert.deepEqual(result.plan.windows.map(w => w.percent), [5, 0]);
  assert.equal(result.plan.windows[0].resetsAt, Date.UTC(2026,10,1,16,2));
  assert.equal(result.plan.plan, "Google AI Plus");
});
test("quota parser refuses unexpected formats and never guesses UTC or zero usage", () => {
  assert.throws(() => parseAntigravityUsage("not a usage report"), /formato/);
  assert.throws(() => parseAntigravityUsage(report.replaceAll("% remaining", "% left")), /cuotas/);
  assert.throws(() => parseAntigravityUsage(report.replace("13,224", "13,24")), /inválidos/);
  assert.equal(parseAntigravityUsage(report.replaceAll(" UTC", "")).plan.windows[0].resetsAt, null);
  assert.equal(parseAntigravityUsage("### Session Usage\n- **Session total:** data not available yet").apiUsage, null);
});
test("context snapshots are accepted while idle, preserve compaction decreases, and reject other sessions", () => {
  let state = { ...initialChatState(), sessionId: "session" };
  const update = (s, used, id = "session") => antigravityReducer(s, { type: "acpUpdate", sessionId: id, turn: null, replay: false, update: { sessionUpdate: "usage_update", used, size: 1000 } });
  state = update(state, 800); assert.equal(contextPercent(state.usage),80);
  state = update(state,200); assert.equal(contextPercent(state.usage),20);
  assert.equal(update(state,900,"other"),state);
  for(const value of [-1,1.5,NaN,Infinity,"200"]) assert.equal(acpContext({ used:value,size:1000 }),null);
  state = antigravityReducer(state,{type:"model",model:"other-model"}); assert.equal(contextPercent(state.usage),null);
});
test("usage reader only runs advertised native commands and captures chunks without chat items", async () => {
  const reader = new AntigravityUsageReader(); let calls=0;
  const rpc = { async call(method,params) {
    calls++; assert.equal(method,"session/prompt"); assert.deepEqual(params.prompt,[{type:"text",text:"/usage"}]);
    assert.equal(reader.observe("other",{sessionUpdate:"agent_message_chunk",content:{type:"text",text:"wrong"}}),false);
    for(const part of [report.slice(0,100),report.slice(100)]) assert.equal(reader.observe("session",{sessionUpdate:"agent_message_chunk",content:{type:"text",text:part}}),true);
    return {stopReason:"end_turn"};
  } };
  await assert.rejects(reader.read(rpc,"session",null),/no anuncia/); assert.equal(calls,0);
  reader.observe("session",{sessionUpdate:"available_commands_update",availableCommands:[{name:"usage"}]});
  assert.equal((await reader.read(rpc,"session",null)).plan.windows.length,2); assert.equal(calls,1);
});
test("a usage report is an absolute snapshot and cannot double an ACP turn's totals", () => {
  let state={...initialChatState(),sessionId:"session"};
  state=antigravityReducer(state,{type:"send",id:"turn",text:"test",now:0});
  state=antigravityReducer(state,{type:"acpFinished",id:"turn",result:{stopReason:"end_turn",usage:{inputTokens:13138,outputTokens:6,thoughtTokens:80,totalTokens:13224,cachedReadTokens:0,cachedWriteTokens:0}},now:1});
  const result=parseAntigravityUsage(report);
  state=antigravityReducer(state,{type:"acpUsageSnapshot",sessionId:"session",...result});
  assert.equal(state.apiUsage.totalTokens,13224); assert.equal(state.apiUsage.cachedReadTokens,0);
  assert.equal(state.items.filter(i=>i.kind==="user").length,1);
  const again=antigravityReducer(state,{type:"acpUsageSnapshot",sessionId:"session",...result}); assert.deepEqual(again.apiUsage,state.apiUsage);
});
test("Trex live snapshots and terminal replies use absolute totals, including actual zero cost", () => {
  const metrics={inputTokens:150,outputTokens:30,totalTokens:180,cachedReadTokens:80,reasoningTokens:18,requests:2,costUsd:0,partial:false,costPartial:false};
  let state={...initialChatState(),sessionId:"session",model:"mock"};
  state=trexReducer(state,{type:"send",id:"turn",text:"test",now:0});
  const params={sessionId:"session",messageId:"turn",usage:{contextModel:"mock",contextTokens:60,contextWindow:1000,inputTokens:150,outputTokens:30,apiUsage:metrics},apiUsage:metrics};
  state=trexReducer(state,{type:"trexEvent",method:"usage/updated",params,now:1});
  state=trexReducer(state,{type:"trexEvent",method:"turn/completed",params:{...params,status:"completed"},now:2});
  assert.equal(state.usage.total,180); assert.equal(state.usage.used,60); assert.equal(state.costUsd,0);
  assert.equal(state.apiUsage.requests,2);
  const restored=trexReducer(state,{type:"trexReady",result:{sessionId:"session",model:"mock",items:[],usage:{...params.usage,totalTokens:180}},models:[]});
  assert.deepEqual(restored.apiUsage,readApiUsage(metrics)); assert.equal(restored.costUsd,0);
  const fresh=trexReducer(restored,{type:"trexReady",result:{sessionId:"new",model:"mock",items:[]},models:[]});
  assert.equal(fresh.apiUsage,null); assert.equal(fresh.costUsd,null);
});
