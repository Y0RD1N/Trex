import assert from "node:assert/strict";
import test from "node:test";
import { load } from "./ts-loader.mjs";
const { normalizeAgentTeam, restoreAgentTeam, mergeTeamItems, teamCombinedState, teamInstruction, TEAM_TOOLS }=await load("agentTeam");
const { initialChatState }=await load("chatState");
const { chatReducer }=await load("claudeChat");
const agent=(provider,id=provider)=>({profileId:id,profileName:id,provider,model:"model-"+id,effort:"high",launch:{profileId:id,profileName:id,command:provider==="trex"?"trex-agent":provider,args:null,shell:"powershell",launchMode:"arg",env:null}});
const member=(id,provider,role,canWrite=false)=>({id,name:id,role,canWrite,instructions:"Perform "+role,agent:agent(provider),conversationId:null});
const team=()=>({id:"team-test",epoch:"epoch-1",phase:"running",master:member("principal","claude","coordinator"),workers:[member("implement","trex","implementation",true),member("review","codex","review")],order:[],initial:null,error:null});
const state=items=>({...initialChatState(),items});
const user=id=>({kind:"user",id,text:id,images:0,previews:[]});
const text=(id,body=id)=>({kind:"text",id,messageId:id,text:body,final:true});
test("team snapshots support mixed providers and independent model/effort on the same account",()=>{
  const raw=team(), saved=normalizeAgentTeam(raw);assert.deepEqual(saved,raw);assert.notStrictEqual(saved.master.agent.launch,raw.master.agent.launch);
  raw.workers[0].agent=agent("claude");raw.workers[0].agent.model="different-model";raw.workers[0].agent.effort="max";
  const result=normalizeAgentTeam(raw);assert.equal(result.master.agent.model,"model-claude");assert.equal(result.workers[0].agent.model,"different-model");assert.equal(result.workers[0].agent.effort,"max");
  assert.deepEqual(normalizeAgentTeam(JSON.parse(JSON.stringify(result))),result);
});
test("team configuration rejects duplicate identities, invalid launches, too many members and inconsistent permissions",()=>{
  for(const mutation of [t=>{t.master.mode="plan";t.master.canWrite=true;},t=>{t.workers[0].mode="full";t.workers[0].canWrite=false;},t=>t.workers=[],t=>t.workers=Array.from({length:9},(_,i)=>member("w-"+i,"codex","review")),t=>t.workers[0].id=t.master.id,t=>t.workers[0].role="coordinator",t=>t.workers[0].role="__proto__",t=>t.workers[0].agent.provider="shell",t=>t.workers[0].agent.launch.profileId="different",t=>t.workers[0].conversationId="not-a-conversation",t=>t.master.agent.model="--bad model",t=>t.epoch="../epoch",t=>t.master.id="x".repeat(25)]){
    const value=team();mutation(value);assert.equal(normalizeAgentTeam(value),null);
  }
});
test("restoration always pauses without altering histories, launch settings or pending initial context",()=>{
  const raw=team();raw.master.conversationId="550e8400-e29b-41d4-a716-446655440000";raw.initial={id:"handoff",pending:true,sourceLabel:"context"};
  for(const phase of ["running","completed","failed","paused"]){raw.phase=phase;const restored=restoreAgentTeam(raw);assert.equal(restored.phase,"paused");assert.equal(restored.master,raw.master);assert.equal(restored.initial.pending,true);assert.match(restored.error,/ninguna delegación se repetirá/);}
});
test("saved team text is redacted without altering model and account identity",()=>{
  const raw=team();raw.master.instructions="api_key=AUDIT_FAKE_ONLY\nKeep constraints.";raw.error="access_token=AUDIT_FAKE_ONLY";
  const result=normalizeAgentTeam(raw);assert.ok(!JSON.stringify(result).includes("AUDIT_FAKE_ONLY"));assert.match(result.master.instructions,/Keep constraints/);assert.equal(result.master.agent.profileId,"claude");
});
test("team instructions name exact configured collaborators; stable task keys are a tool rule",()=>{
  const value=teamInstruction(team());for(const name of ["implement","review","trex_team"])assert.ok(value.includes(name));assert.equal(TEAM_TOOLS.length,4);
});
test("three providers can share native IDs without crossing permission ownership",()=>{
  const t=team(), members=[t.master,...t.workers];
  const permission={kind:"permission",id:"same",toolUseId:"tool",toolName:"Write",input:{file_path:"a.ts"},state:"pending",suggestions:[],description:"",request:{}};
  const sessions=Object.fromEntries(members.map(m=>[m.id,state([user("user"),permission,text("answer")])]));
  const merged=mergeTeamItems(members,sessions,[]);assert.equal(merged.items.length,9);
  for(const m of members){assert.deepEqual(merged.owners[m.id+"::same"],{memberId:m.id,originalId:"same"});assert.equal(merged.items.find(i=>i.id===m.id+"::same").toolUseId,m.id+"::tool");}
  assert.deepEqual(mergeTeamItems(members,sessions,merged.order),merged);
});
test("missing histories preserve interleaving anchors; late hydration inserts users before their report",()=>{
  const t=team(), members=[t.master,...t.workers];const order=["principal::old-user","principal::plan","implement::local-user","implement::result","review::findings","principal::close"];
  const sessions={principal:state([text("plan"),text("close")]),implement:{...state([user("native-user"),text("result")]),historyCount:2},review:state([text("findings")])};
  const merged=mergeTeamItems(members,sessions,order);
  assert.deepEqual(merged.items.map(i=>i.id),["principal::plan","implement::native-user","implement::result","review::findings","principal::close"]);assert.ok(merged.order.includes("implement::local-user"));
  assert.deepEqual(mergeTeamItems(members,sessions,merged.order),merged);
});
test("actual Claude split-block hydration keeps two cycles and original approval targets",()=>{
  const t=team(), members=[t.master,...t.workers];let main=initialChatState();let result={order:[]};
  const blocks=i=>[{type:"thinking",thinking:"Reason "+i},{type:"text",text:"Plan "+i+" A"},{type:"text",text:"Plan "+i+" B"}];
  const line=event=>({type:"line",event,now:1000});const stream=event=>line({type:"stream_event",event});
  for(const i of [1,2]){
    main=[{type:"send",id:"local-"+i,text:"Task "+i,now:0},stream({type:"message_start",message:{id:"msg-"+i}}),...blocks(i).flatMap((block,n)=>[
      stream({type:"content_block_start",index:[0,1,3][n],content_block:block}),line({type:"assistant",message:{id:"msg-"+i,content:[block],stop_reason:n===2?"end_turn":null}})]),line({type:"result",uuid:"result-"+i,subtype:"success",is_error:false,duration_ms:1000})].reduce(chatReducer,main);
    result=mergeTeamItems(members,{principal:main,implement:state([text("result"+i)])},result.order);
  }
  const entries=[1,2].flatMap(i=>[{type:"user",uuid:"native-"+i,message:{role:"user",content:"Task "+i}},...blocks(i).map((block,n)=>({type:"assistant",uuid:"record-"+i+"-"+n,message:{id:"msg-"+i,role:"assistant",content:[block],stop_reason:n===2?"end_turn":null}}))]);
  const history=chatReducer(initialChatState(),{type:"history",entries});
  const merged=mergeTeamItems(members,{principal:history,implement:state([text("result2")])},result.order);
  for(const i of [1,2])assert.deepEqual(merged.items.filter(v=>v.kind==="text" && v.id.startsWith("principal::msg-"+i)).map(v=>v.text),["Plan "+i+" A","Plan "+i+" B"]);
  assert.deepEqual(mergeTeamItems(members,{principal:history,implement:state([text("result2")])},merged.order),merged);
});
test("aggregate usage belongs to the main model while activity and completions keep namespaced owners",()=>{
  const t=team(), members=[t.master,...t.workers];const main={...state([user("same"),text("answer")]),pendingTurns:1,pendingMessageIds:["same"],usage:{contextTokens:100,window:1000,totalTokens:400},lastCompletion:{id:"completion",status:"completed",messageIds:["same"],itemIds:["answer"]}};
  const worker={...state([user("same"),text("answer")]),pendingTurns:2,pendingMessageIds:["same"],usage:{contextTokens:800,window:2000,totalTokens:900}};
  const sessions={principal:main,implement:worker};const merged=mergeTeamItems(members,sessions,[]);const combined=teamCombinedState(main,sessions,merged.items,"principal",merged.owners);
  assert.equal(combined.usage,main.usage);assert.equal(combined.pendingTurns,3);assert.deepEqual(combined.pendingMessageIds,["principal::same","implement::same"]);assert.deepEqual(combined.lastCompletion.itemIds,["principal::answer"]);
});
test("withMemberPermission changes one member and keeps mode and canWrite coherent",async()=>{
  const { withMemberPermission, permissionChangeNote } = await load("agentTeam");
  const make=(id,provider,canWrite=false)=>({id,name:id,role:id==="principal"?"coordinator":"implementation",instructions:"x",canWrite,agent:{profileId:provider,profileName:provider,provider,model:null,launch:{profileId:provider,profileName:provider,command:provider,args:"",shell:"",launchMode:"arg",env:null}},conversationId:null});
  const team={id:"t",epoch:"e",phase:"running",master:make("principal","claude"),workers:[make("w1","codex"),make("w2","antigravity")],order:[],initial:null,error:null};
  const up=withMemberPermission(team,"w1","auto");
  assert.equal(up.workers[0].mode,"auto");assert.equal(up.workers[0].canWrite,true);
  assert.equal(up.master,team.master,"others are untouched");assert.equal(team.workers[0].canWrite,false,"the input is not mutated");
  assert.equal(withMemberPermission(up,"w1","plan").workers[0].canWrite,false);
  assert.equal(withMemberPermission(team,"principal","acceptEdits").master.canWrite,true);
  assert.equal(withMemberPermission(team,"missing","auto"),null);
  assert.equal(withMemberPermission(team,"w1","bypassPermissions"),null,"a mode the assistant does not have");
  assert.equal(withMemberPermission(team,"w2","plan"),null,"Antigravity cannot be made read-only");
  assert.match(permissionChangeNote(up.workers[0]),/^w1: .*puede modificar archivos/);
  assert.match(permissionChangeNote(withMemberPermission(up,"w1","plan").workers[0]),/solo lectura/);
});
