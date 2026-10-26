import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { load } from "./ts-loader.mjs";
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const helpers=await load("agentTeam"), {initialChatState}=await load("chatState");
const taskHelpers=await load("chatTasks");
async function declarations(file,returns){
  const url=new URL(file,import.meta.url), source=await readFile(url,"utf8"), ast=ts.createSourceFile(url.pathname,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
  const body=ast.statements.filter(node=>ts.isVariableStatement(node)||ts.isFunctionDeclaration(node)).map(node=>node.getText(ast)).join("\n").replaceAll("import.meta.url",JSON.stringify(url.href));
  return new (Object.getPrototypeOf(async function(){}).constructor)("assert","readFile","test","ts","load",body+"\nreturn "+returns)(assert,readFile,test,ts,load);
}
const component=await declarations("./queue-workflow-controls.test.mjs","{host,react,jsxRuntime,environment,dependencies,flush}");
const source=await readFile(new URL("../src/components/AgentTeamView.tsx",import.meta.url),"utf8");
const compiled=new Function("require","exports","window","requestAnimationFrame","crypto",ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText);
const agent=(provider)=>({profileId:provider,profileName:provider,provider,model:"model-"+provider,effort:"high",launch:{profileId:provider,profileName:provider,command:provider,args:null,shell:"powershell",launchMode:"arg",env:null}});
const member=(id,provider,role,canWrite=false)=>({id,name:id,role,canWrite,instructions:"Verify the task",agent:agent(provider),conversationId:null});
function nodes(node){if(!node||typeof node!=="object")return [];if(Array.isArray(node))return node.flatMap(nodes);return [node,...nodes(node.props?.children),...nodes(node.props?.toolbar)];}
function harness(t,{phase="running",prepareWait,prepareError,claimWait,pollWait,initial=null,restoredHistory=false,setup}={}){
  let team={id:"team-test",epoch:"epoch-1",phase,master:member("principal","claude","coordinator"),workers:[member("implement","trex","implementation",true),member("review","codex","review")],order:[],initial,error:null};
  if(setup!==undefined)team.setup=setup;
  if(restoredHistory)for(const member of [team.master,...team.workers])member.conversationId="550e8400-e29b-41d4-a716-446655440000";
  let snapshot={id:team.id,epoch:team.epoch,phase:phase==="paused"?"paused":"running",tasks:[],heartbeat:1};
  const h=component.host(t), env=component.environment(), intervals=new Map(), calls=[], notices=[], sessions={}, delivered=[];
  let timer=0, tree;
  env.window.setInterval=callback=>{const id=++timer;intervals.set(id,callback);return id;};env.window.clearInterval=id=>intervals.delete(id);
  const api={formatError:error=>error?.message??String(error),
    async agentTeamOpen(next,_cwd,resume=false){calls.push(["open",next.epoch,resume]);snapshot={...snapshot,epoch:next.epoch,phase:"running"};return structuredClone(snapshot);},
    async agentTeamSnapshot(){return structuredClone(snapshot);},
    async agentTeamPoll(){calls.push(["poll"]);if(pollWait)await pollWait.promise;return structuredClone(snapshot);},
    async agentTeamPause(binding){calls.push(["pause",binding.epoch]);snapshot={...snapshot,phase:"paused",tasks:snapshot.tasks.map(task=>["claimed","running"].includes(task.status)?{...task,status:"uncertain"}:task.status==="queued"?{...task,status:"cancelled"}:task)};return structuredClone(snapshot);},
    async agentTeamClaim(){calls.push(["claim"]);if(claimWait)await claimWait.promise;const task=snapshot.tasks.find(task=>task.status==="queued");if(task)task.status="claimed";return structuredClone(snapshot);},
    async agentTeamFinish(binding,id,status,report){calls.push(["finish",binding.epoch,id,status,report]);const task=snapshot.tasks.find(task=>task.id===id);assert.ok(task);assert.equal(binding.epoch,snapshot.epoch);task.status=status;task.report=report;return structuredClone(snapshot);},
    async prepareHandoff(context){calls.push(["prepare",context]);if(prepareError)throw new Error(prepareError);if(prepareWait)await prepareWait.promise;return {id:"handoff",createdAt:1,cwd:"D:/test",content:context.content,truncated:false,sourceLabel:"principal",sourceProvider:"claude",sourceSessionId:"team-test"};},
    async loadHandoff(id){calls.push(["load",id]);return {id,content:"Saved context from the previous chat"};},
  };
  for(const m of [team.master,...team.workers]){
    const session={provider:m.agent.provider,state:{...initialChatState(),process:"ready",model:"model-"+m.agent.provider,modelChoice:"model-"+m.agent.provider},queue:{ready:true,error:null,snapshot:{messages:[],receipt:null},client:{}},
      async send(text,images,previews,display){delivered.push({member:m.id,text,images,previews,display});session.state={...session.state,pendingTurns:1,pendingMessageIds:["user-"+m.id],items:[...session.state.items,{kind:"user",id:"user-"+m.id,text,images:0,previews:[]}]};return session.accept??true;},
      interrupt(){calls.push(["interrupt",m.id]);},answer(item,allowed){calls.push(["answer",m.id,item.id,allowed]);},async start(){calls.push(["start",m.id]);},setModel(){},setEffort(){},setMode(){},notice(){},runCommand(){return false;},refreshSkills:async()=>{},reset(){},edit:async()=>{},setFast(){}};
    sessions[m.id]=session;
  }
  const exports={};compiled(name=>{
    if(name==="react")return component.react;if(name==="react/jsx-runtime")return component.jsxRuntime;if(name==="../api")return api;
    if(name==="../agentTeam")return helpers;if(name==="../chatTasks")return taskHelpers;if(component.dependencies[name])return component.dependencies[name];
    if(name.endsWith(".css"))return {};if(name==="./ChatView")return {ChatPanel:"ChatPanel"};
    if(name.startsWith("../hooks/use"))return new Proxy({},{get:()=>()=>assert.fail("Native hooks are represented by their published session boundary")});
    if(name==="./AgentIcon")return {default:"AgentIcon"};if(name==="./Icons")return {RotateIcon:"RotateIcon",StopIcon:"StopIcon"};
    throw new Error("Unexpected TeamView dependency "+name);
  },exports,env.window,env.requestAnimationFrame,{randomUUID:()=>"epoch-"+(++timer)});
  const props={sessionId:"tab",cwd:"D:/test",settings:{},projectName:"Test",projectId:"project",visible:true,focused:true,onTeamChange:next=>{team=next;},onMessage:text=>notices.push(text),onRunning(){},onExit(){}};
  const render=()=>{tree=h.render(()=>exports.default({...props,team}));return tree;};
  const publish=()=>{render();for(const node of nodes(tree).filter(node=>node.props?.options&&node.props?.publish))node.props.publish(node.props.id,node.props.epoch,{...sessions[node.props.id]});render();};
  const settle=async()=>{for(let i=0;i<6;i++){await component.flush();publish();}};
  const tick=async()=>{for(const callback of [...intervals.values()])callback();await settle();};
  const panel=()=>nodes(tree).find(node=>node.type==="ChatPanel").props;
  const button=label=>nodes(tree).find(node=>node.type==="button"&&nodes(node.props.children).length===0&&String(node.props.children).includes(label))
    ??nodes(tree).find(node=>node.type==="button"&&JSON.stringify(node.props.children).includes(label));
  const queue=()=>{snapshot.tasks.push({id:"task",epoch:team.epoch,key:"key",memberId:"implement",instruction:"Implement the specific change",status:"queued",report:null,createdAt:1,updatedAt:1});};
  const complete=(id,status="completed",report="Implementation verified",messageId="user-"+id)=>{const s=sessions[id];s.state={...s.state,pendingTurns:0,items:[...s.state.items,{kind:"text",id:"reply-"+id,messageId:"answer",text:report,final:true}],lastCompletion:{id:"done-"+id,status,messageIds:[messageId],itemIds:["reply-"+id]}};};
  publish();return {sessions,calls,notices,delivered,render,publish,settle,tick,panel,button,queue,complete,get team(){return team;},get snapshot(){return snapshot;},get tree(){return tree;},dispose:()=>h.dispose()};
}
test("an unfinished published plan cannot be presented as a completed team",async t=>{
  const h=harness(t);await h.settle();
  h.snapshot.plan=[{taskKey:"not-issued",memberId:"implement",task:"Still pending"}];
  h.complete("principal");h.publish();await h.tick();
  assert.equal(h.team.phase,"paused");assert.match(h.team.error,/tareas del plan pendientes/);assert.equal(h.delivered.length,0);
});
test("only principal receives delegation; participants retain distinct native models and policies",async t=>{
  const h=harness(t);await h.settle();const runtimes=nodes(h.tree).filter(node=>node.props?.options);
  assert.equal(runtimes.length,3);for(const node of runtimes){const {id,options}=node.props;assert.equal(options.queueId,"team-test-"+id);assert.equal(options.sessionId,"team-test-"+id+"-epoch-1");assert.equal(options.planningOnly,id!=="implement");assert.equal(!!options.team,id==="principal");assert.equal(options.visible,id==="principal");}
  assert.match(runtimes[0].props.options.planningInstruction,/coordinate/);assert.match(runtimes[2].props.options.planningInstruction,/read-only collaborator/);
});
test("delegation is claimed once, sends full instructions, and returns only the attributed final report",async t=>{
  const h=harness(t);await h.settle();h.queue();await h.tick();assert.equal(h.delivered.length,1);assert.equal(h.delivered[0].member,"implement");assert.match(h.delivered[0].text,/Implement the specific change/);assert.match(h.delivered[0].text,/Verify the task/);assert.equal(h.snapshot.tasks[0].status,"running");
  await h.tick();assert.equal(h.delivered.length,1);h.complete("implement");h.publish();await h.tick();assert.equal(h.snapshot.tasks[0].status,"completed");assert.equal(h.snapshot.tasks[0].report,"Implementation verified");
});
test("Stop during context preparation prevents provider delivery and preserves uncertainty",async t=>{
  const wait=deferred(),h=harness(t,{prepareWait:wait});await h.settle();h.queue();await h.tick();h.panel().session.interrupt();wait.resolve();await h.settle();
  assert.equal(h.delivered.length,0);assert.equal(h.team.phase,"paused");assert.equal(h.snapshot.tasks[0].status,"uncertain");assert.equal(h.calls.filter(c=>c[0]==="interrupt").length,3);
});
test("unconfirmed send pauses the whole team without automatic retry",async t=>{
  const h=harness(t);await h.settle();h.sessions.implement.accept=false;h.queue();await h.tick();assert.equal(h.delivered.length,1);assert.equal(h.team.phase,"paused");assert.equal(h.snapshot.tasks[0].status,"uncertain");await h.tick();assert.equal(h.delivered.length,1);
});
test("unrelated or stale completions cannot finish an active delegation",async t=>{
  const h=harness(t);h.sessions.implement.state.items=[{kind:"user",id:"old",text:"old"}];await h.settle();h.queue();await h.tick();h.complete("implement","completed","Old report","old");h.publish();await h.tick();assert.equal(h.snapshot.tasks[0].status,"running");
  h.sessions.implement.state.lastCompletion={...h.sessions.implement.state.lastCompletion,id:"actual",messageIds:["user-implement"]};h.publish();await h.tick();assert.equal(h.snapshot.tasks[0].status,"completed");
});
test("worker exit without a terminal pauses instead of silently leaving the coordinator waiting",async t=>{
  const h=harness(t);await h.settle();h.queue();await h.tick();h.sessions.implement.state={...h.sessions.implement.state,process:"exited"};h.publish();await h.tick();assert.equal(h.team.phase,"paused");assert.equal(h.snapshot.tasks[0].status,"uncertain");
});
test("interrupted worker without a final report remains uncertain",async t=>{
  const h=harness(t);await h.settle();h.queue();await h.tick();h.sessions.implement.state={...h.sessions.implement.state,lastCompletion:{id:"interrupted",status:"interrupted",messageIds:["user-implement"],itemIds:[]}};h.publish();await h.tick();assert.equal(h.snapshot.tasks[0].status,"uncertain");assert.equal(h.team.phase,"paused");
});
test("oversized reports fail clearly while the original participant history is retained",async t=>{
  const h=harness(t);await h.settle();h.queue();await h.tick();const report="Verified code and test results. ".repeat(1200);h.complete("implement","completed",report);h.publish();await h.tick();assert.equal(h.snapshot.tasks[0].status,"failed");assert.match(h.snapshot.tasks[0].report,/supera 32 KiB/);assert.equal(h.sessions.implement.state.items.at(-1).text,report);
});
test("permission replies use the source participant's original identity",async t=>{
  const h=harness(t);await h.settle();for(const id of ["principal","implement","review"])h.sessions[id].state={...h.sessions[id].state,items:[{kind:"permission",id:"same",toolUseId:"tool",toolName:"Read",input:{},state:"pending",suggestions:[],request:{}}]};h.publish();
  const panel=h.panel(), item=panel.session.state.items.find(item=>item.id==="review::same");panel.session.answer(item,true,false);assert.deepEqual(h.calls.filter(c=>c[0]==="answer"),[["answer","review","same",true]]);
});
test("explicit resume creates a new epoch and leaves old uncertain work unissued",async t=>{
  const h=harness(t);await h.settle();h.queue();await h.tick();h.panel().session.interrupt();await h.settle();const before=h.delivered.length;
  await h.button("Revisado: reanudar").props.onClick();await h.settle();assert.notEqual(h.team.epoch,"epoch-1");assert.equal(h.team.phase,"running");assert.equal(h.snapshot.tasks[0].status,"uncertain");await h.tick();assert.equal(h.delivered.length,before);assert.equal(h.calls.filter(c=>c[0]==="open").at(-1)[2],true);
});
test("a pending heartbeat cannot send after Stop",async t=>{
  const h=harness(t);await h.settle();const send=h.panel().session.send("New instruction",[],[]);h.panel().session.interrupt();assert.equal(await send,false);assert.equal(h.delivered.length,0);
});
test("paused restoration never opens or sends until explicit review",async t=>{
  const h=harness(t,{phase:"paused",initial:{id:"initial",pending:true,sourceLabel:"previous"}});await h.settle();assert.equal(h.calls.filter(c=>c[0]==="open").length,0);assert.equal(h.panel().inputLocked,true);assert.equal(h.panel().handoffRestored,true);assert.equal(await h.panel().session.send("do not send",[],[]),false);assert.equal(h.delivered.length,0);
});
test("lease refresh continues while context preparation waits for the device",async t=>{
  const wait=deferred(),h=harness(t,{prepareWait:wait});await h.settle();h.queue();await h.tick();const before=h.calls.filter(call=>call[0]==="poll").length;await h.tick();
  assert.ok(h.calls.filter(call=>call[0]==="poll").length>before);assert.equal(h.delivered.length,0);h.panel().session.interrupt();wait.resolve();await h.settle();assert.equal(h.delivered.length,0);
});
test("restored histories can be inspected read-only before enabling delegation",async t=>{
  const h=harness(t,{phase:"paused",restoredHistory:true});await h.settle();const runtimes=nodes(h.tree).filter(node=>node.props?.options);
  for(const {props:{options}}of runtimes){assert.equal(options.visible,true);assert.equal(options.planningOnly,true);assert.equal(options.mode,"plan");assert.equal(options.team,undefined);assert.equal(options.browser.enabled,false);}
  assert.equal(h.calls.filter(call=>call[0]==="open").length,0);assert.equal(h.delivered.length,0);assert.equal(h.panel().inputLocked,true);
});

test("saving a configured team never sends; first chat message carries roles, order and attachments exactly once",async t=>{
  const h=harness(t,{setup:{context:null}});await h.settle();await h.tick();
  assert.equal(h.delivered.length,0);assert.equal(h.calls.filter(c=>c[0]==="prepare").length,0);assert.equal(h.panel().handoff,null);
  const images=[{mediaType:"image/png",data:"synthetic"}],previews=["fixture-preview"];
  assert.equal(await h.panel().session.send("Plan my idea",images,previews),true);h.publish();
  assert.equal(h.delivered.length,1);const sent=h.delivered[0];assert.equal(sent.member,"principal");assert.equal(sent.display,"Plan my idea");assert.deepEqual(sent.images,images);assert.deepEqual(sent.previews,previews);
  assert.match(sent.text,/1\. implement/);assert.match(sent.text,/2\. review/);assert.match(sent.text,/Plan my idea/);assert.equal(h.team.setup,null);
  const before=h.calls.filter(c=>c[0]==="prepare").length;await h.panel().session.send("One clarification",[],[]);assert.equal(h.calls.filter(c=>c[0]==="prepare").length,before);
});
test("inherited team context waits for an explicit message and is then consumed",async t=>{
  const h=harness(t,{setup:{context:{id:"prior",pending:false,sourceLabel:"Previous chat"}}});await h.settle();assert.equal(h.calls.some(c=>c[0]==="load"),false);
  await h.panel().session.send("Use the saved discussion",[],[]);assert.equal(h.calls.filter(c=>c[0]==="load").length,1);assert.match(h.delivered[0].text,/Saved context from the previous chat/);assert.equal(h.team.setup,null);
});
test("preparation failure retains setup and sends nothing",async t=>{
  const h=harness(t,{setup:{context:null},prepareError:"Offline preparation failed"});await h.settle();assert.equal(await h.panel().session.send("Keep this idea",[],[]),false);h.publish();
  assert.deepEqual(h.team.setup,{context:null});assert.equal(h.delivered.length,0);assert.match(h.notices[0],/preparation failed/);assert.equal(h.panel().inputLocked,false);
});
test("double submission and Stop during first-message preparation never issue a duplicate or stale message",async t=>{
  const wait=deferred(),h=harness(t,{setup:{context:null},prepareWait:wait});await h.settle();const first=h.panel().session.send("First idea",[],[]);await h.settle();
  assert.equal(await h.panel().session.send("Duplicate",[],[]),false);h.panel().session.interrupt();wait.resolve();assert.equal(await first,false);await h.settle();
  assert.equal(h.delivered.length,0);assert.deepEqual(h.team.setup,{context:null});assert.equal(h.team.phase,"paused");
});
test("uncertain first-message acceptance pauses and never silently resends",async t=>{
  const h=harness(t,{setup:{context:null}});await h.settle();h.sessions.principal.accept=false;assert.equal(await h.panel().session.send("Uncertain idea",[],[]),false);await h.tick();
  assert.equal(h.delivered.length,1);assert.equal(h.team.phase,"paused");assert.deepEqual(h.team.setup,{context:null});
});
