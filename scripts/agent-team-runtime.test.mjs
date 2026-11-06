import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { load } from "./ts-loader.mjs";
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const helpers=await load("agentTeam"), {initialChatState}=await load("chatState");
const taskHelpers=await load("chatTasks");
const budgetHelpers=await load("teamBudget"), usageHelpers=await load("teamUsage");
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
function harness(t,{phase="running",prepareWait,prepareError,claimWait,pollWait,initial=null,restoredHistory=false,setup,settings={},readerWorkers=false,masterMode=null,budget,usage,reviewRole,memberBrowser}={}){
  let team={id:"team-test",epoch:"epoch-1",phase,master:member("principal","claude","coordinator"),workers:[member("implement","trex","implementation",true),member("review","codex",reviewRole??"review")],order:[],initial,error:null};
  if(budget!==undefined)team.budget=budget;
  if(memberBrowser)for(const m of [team.master,...team.workers])if(typeof memberBrowser[m.id]==="boolean")m.browser=memberBrowser[m.id];
  if(usage!==undefined)team.usage=usage;
  if(readerWorkers)team.workers[0].canWrite=false;
  if(masterMode){team.master.mode=masterMode;team.master.canWrite=masterMode!=="plan";}
  if(setup!==undefined)team.setup=setup;
  if(restoredHistory)for(const member of [team.master,...team.workers])member.conversationId="550e8400-e29b-41d4-a716-446655440000";
  let snapshot={id:team.id,epoch:team.epoch,phase:phase==="paused"?"paused":"running",tasks:[],heartbeat:1};
  const h=component.host(t), env=component.environment(), intervals=new Map(), calls=[], notices=[], sessions={}, delivered=[];
  let timer=0, tree;
  env.window.setInterval=callback=>{const id=++timer;intervals.set(id,callback);return id;};env.window.clearInterval=id=>intervals.delete(id);
  const api={
    async trexBrowserStatus(){return {ready:true,capabilities:{spaces:true}};},
    async trexBrowserSpaces(_cwd,members){return {spaces:members.map((member,index)=>({...member,profile:"BROWSER"+(index+2)}))};},
    formatError:error=>error?.message??String(error),
    async agentTeamOpen(next,_cwd,resume=false){calls.push(["open",next.epoch,resume]);snapshot={...snapshot,epoch:next.epoch,phase:"running"};return structuredClone(snapshot);},
    async agentTeamSnapshot(){return structuredClone(snapshot);},
    async agentTeamPoll(){calls.push(["poll"]);if(pollWait)await pollWait.promise;return structuredClone(snapshot);},
    async agentTeamPause(binding){calls.push(["pause",binding.epoch]);snapshot={...snapshot,phase:"paused",tasks:snapshot.tasks.map(task=>["claimed","running"].includes(task.status)?{...task,status:"uncertain"}:task.status==="queued"?{...task,status:"cancelled"}:task)};return structuredClone(snapshot);},
    async agentTeamClaim(_binding,taskId){calls.push(["claim"]);if(claimWait)await claimWait.promise;const task=snapshot.tasks.find(task=>task.status==="queued" && (!taskId||task.id===taskId) && helpers.teamTaskRunnable(snapshot,task,[team.master,...team.workers]));if(task)task.status="claimed";return structuredClone(snapshot);},
    async agentTeamFinish(binding,id,status,report){calls.push(["finish",binding.epoch,id,status,report]);const task=snapshot.tasks.find(task=>task.id===id);assert.ok(task);assert.equal(binding.epoch,snapshot.epoch);task.status=status;task.report=report;return structuredClone(snapshot);},
    async prepareHandoff(context,options){calls.push(["prepare",context,options]);if(prepareError)throw new Error(prepareError);if(prepareWait)await prepareWait.promise;return {id:"handoff",createdAt:1,cwd:"D:/test",content:context.content,truncated:false,sourceLabel:"principal",sourceProvider:"claude",sourceSessionId:"team-test"};},
    async loadHandoff(id){calls.push(["load",id]);return {id,content:"Saved context from the previous chat"};},
  };
  for(const m of [team.master,...team.workers]){
    const session={provider:m.agent.provider,state:{...initialChatState(),process:"ready",model:"model-"+m.agent.provider,modelChoice:"model-"+m.agent.provider},queue:{ready:true,error:null,snapshot:{messages:[],receipt:null},client:{},async enqueue(text,images,previews){calls.push(["enqueue",m.id,text,images,previews]);return {id:"queued-message",text,images,previews};}},
      async send(text,images,previews,display){delivered.push({member:m.id,text,images,previews,display});session.state={...session.state,pendingTurns:1,pendingMessageIds:["user-"+m.id],items:[...session.state.items,{kind:"user",id:"user-"+m.id,text,images:0,previews:[]}]};return session.accept??true;},
      interrupt(){calls.push(["interrupt",m.id]);},answer(item,allowed){calls.push(["answer",m.id,item.id,allowed]);},async start(){calls.push(["start",m.id]);},setModel(){},setEffort(){},setMode(){},notice(){},runCommand(){return false;},refreshSkills:async()=>{},reset(){},edit:async()=>{},setFast(){}};
    sessions[m.id]=session;
  }
  const teamApi={
    async agentTeamFinishTask(binding,id,status,report,usage){calls.push(["finish",binding.epoch,id,status,report,usage]);const task=snapshot.tasks.find(task=>task.id===id);assert.ok(task);assert.equal(binding.epoch,snapshot.epoch);task.status=status;task.report=report;task.usage=usage;return structuredClone(snapshot);},
    async agentTeamPublishUsage(binding,report){calls.push(["usage",report,binding.epoch]);return structuredClone(snapshot);},
  };
  const exports={};compiled(name=>{
    if(name==="react")return component.react;if(name==="react/jsx-runtime")return component.jsxRuntime;if(name==="../api")return api;
    if(name==="../agentTeam")return helpers;if(name==="../chatTasks")return taskHelpers;
    if(name==="../teamBudget")return budgetHelpers;if(name==="../teamUsage")return usageHelpers;if(name==="../teamApi")return teamApi;if(component.dependencies[name])return component.dependencies[name];
    if(name.endsWith(".css"))return {};if(name==="./ChatView")return {ChatPanel:"ChatPanel"};
    if(name.startsWith("../hooks/use"))return new Proxy({},{get:()=>()=>assert.fail("Native hooks are represented by their published session boundary")});
    if(name==="./AgentIcon")return {default:"AgentIcon"};if(name==="./Icons")return {RotateIcon:"RotateIcon",StopIcon:"StopIcon"};
    if(name==="./AgentTeamToolbar")return {default:"AgentTeamToolbar"};
    throw new Error("Unexpected TeamView dependency "+name);
  },exports,env.window,env.requestAnimationFrame,{randomUUID:()=>"epoch-"+(++timer)});
  const props={sessionId:"tab",cwd:"D:/test",settings,projectName:"Test",projectId:"project",visible:true,focused:true,onTeamChange:next=>{team=next;},onMessage:text=>notices.push(text),onRunning(){},onExit(){}};
  const render=()=>{tree=h.render(()=>exports.default({...props,team}));return tree;};
  const publish=()=>{render();for(const node of nodes(tree).filter(node=>node.props?.options&&node.props?.publish))node.props.publish(node.props.id,node.props.epoch,{...sessions[node.props.id]});render();};
  const settle=async()=>{for(let i=0;i<6;i++){await component.flush();publish();}};
  const tick=async()=>{for(const callback of [...intervals.values()])callback();await settle();};
  const panel=()=>nodes(tree).find(node=>node.type==="ChatPanel").props;
  const button=label=>label==="Revisado: reanudar"?{props:{onClick:()=>{render();return nodes(tree).find(node=>node.props?.onResume).props.onResume();}}}:nodes(tree).find(node=>node.type==="button"&&nodes(node.props.children).length===0&&String(node.props.children).includes(label))
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
  assert.equal(runtimes.length,3);for(const node of runtimes){const {id,options}=node.props;assert.equal(options.queueId,"t-team-test-"+id);assert.equal(options.sessionId,"team-test-"+id+"-epoch-1");assert.equal(options.planningOnly,id!=="implement");assert.equal(!!options.team,id==="principal");assert.equal(options.visible,id==="principal");}
  assert.match(runtimes[0].props.options.planningInstruction,/coordinate/);assert.match(runtimes[2].props.options.planningInstruction,/read-only collaborator/);
});
test("writable principal yields before delegation, then resumes once all reports finish",async t=>{
  const h=harness(t,{masterMode:"acceptEdits"});await h.settle();const runtime=nodes(h.tree).find(node=>node.props?.id==="principal"&&node.props.options);
  assert.equal(runtime.props.options.mode,"acceptEdits");assert.equal(runtime.props.options.planningOnly,false);assert.equal(h.panel().planningOnly,false);
  assert.equal(await h.panel().session.send("Plan and edit",[],[]),true);h.publish();h.queue();await h.tick();
  assert.equal(h.calls.filter(call=>call[0]==="claim").length,0);assert.equal(h.delivered.length,1);
  h.complete("principal");h.publish();await h.tick();assert.deepEqual(h.delivered.map(value=>value.member),["principal","implement"]);
  assert.equal(h.panel().session.state.pendingTurns>0,true);
  assert.equal(await h.panel().session.send("Keep this clarification",[{kind:"image"}],["preview"]),true);
  assert.deepEqual(h.calls.find(call=>call[0]==="enqueue").slice(1),["principal","Keep this clarification",[{kind:"image"}],["preview"]]);
  assert.equal(h.delivered.length,2);h.complete("implement");h.publish();await h.tick();
  assert.deepEqual(h.delivered.map(value=>value.member),["principal","implement","principal"]);
});
test("delegation is claimed once, sends full instructions, and returns only the attributed final report",async t=>{
  const h=harness(t);await h.settle();h.queue();await h.tick();assert.equal(h.delivered.length,1);assert.equal(h.delivered[0].member,"implement");assert.match(h.delivered[0].text,/Implement the specific change/);assert.match(h.delivered[0].text,/Verify the task/);assert.equal(h.snapshot.tasks[0].status,"running");
  assert.match(h.delivered[0].text,/Resultado, Archivos\/evidencias, Validación, Hallazgos y Limitaciones/);assert.match(h.delivered[0].text,/500 palabras/);assert.doesNotMatch(h.delivered[0].text,/Presupuesto orientativo/);
  await h.tick();assert.equal(h.delivered.length,1);h.complete("implement");h.publish();await h.tick();assert.equal(h.snapshot.tasks[0].status,"completed");assert.equal(h.snapshot.tasks[0].report,"Implementation verified");
});
test("browsing members receive their own browser identity, the principal none, while legacy tasks remain serial",async t=>{
  const h=harness(t,{settings:{browserEnabled:true,browserProfile:"BROWSER1"}});await h.settle();
  const runtimes=nodes(h.tree).filter(node=>node.props?.options);
  assert.equal(runtimes[0].props.id,"principal");assert.equal(runtimes[0].props.options.browser.enabled,false);
  for(const [index,runtime] of runtimes.slice(1).entries())assert.deepEqual(runtime.props.options.browser,{enabled:true,profile:"BROWSER"+(index+2),clientId:"team-test-"+runtime.props.id});
  h.queue();h.snapshot.tasks.push({id:"review-task",epoch:"epoch-1",key:"review-key",memberId:"review",instruction:"Review after implementation",status:"queued",report:null,createdAt:2,updatedAt:2});
  await h.tick();await h.tick();await h.tick();
  assert.deepEqual(h.delivered.map(item=>item.member),["implement"]);
  assert.equal(h.snapshot.tasks[1].status,"queued");
  h.complete("implement");h.publish();await h.tick();await h.tick();
  assert.deepEqual(h.delivered.map(item=>item.member),["implement","review"]);
  assert.equal(h.snapshot.tasks[0].status,"completed");assert.equal(h.snapshot.tasks[1].status,"running");
  // Git context by role: the implementer gets branch/status, the reviewer also the per-file summary.
  const prepared=h.calls.filter(call=>call[0]==="prepare");
  assert.deepEqual(prepared.map(call=>call[2]),[{git:"status"},{git:"stat"}]);
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
test("oversized reports keep their status and reach the native store whole",async t=>{
  const h=harness(t);await h.settle();h.queue();await h.tick();const report="Verified code and test results. ".repeat(1200);h.complete("implement","completed",report);h.publish();await h.tick();
  assert.equal(h.snapshot.tasks[0].status,"completed");assert.equal(h.snapshot.tasks[0].report,report.trim());assert.equal(h.sessions.implement.state.items.at(-1).text,report);assert.equal(h.team.phase,"running");
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
  assert.deepEqual(h.calls.find(c=>c[0]==="prepare")[2],{git:"status"});
  // The delegation rules live in the trex_team tool descriptions, not in this message.
  assert.match(sent.text,/descripciones de las herramientas trex_team/);assert.doesNotMatch(sent.text,/No consultes en bucle|Economía|dependsOn:\[\]/);
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

test("independent readers dispatch together; a dependent step waits and Stop interrupts both",async t=>{
  const h=harness(t,{readerWorkers:true,settings:{browserEnabled:true,browserProfile:"BROWSER1"}});await h.settle();
  h.queue();h.snapshot.tasks.push({id:"review-task",epoch:"epoch-1",key:"review-key",memberId:"review",instruction:"Independent review",status:"queued",report:null,createdAt:2,updatedAt:2});
  h.snapshot.plan=[{taskKey:"key",memberId:"implement",task:"Implement the specific change",dependsOn:[]},{taskKey:"review-key",memberId:"review",task:"Independent review",dependsOn:[]}];
  await h.tick();await h.tick();assert.deepEqual(h.delivered.map(item=>item.member),["implement","review"]);
  assert.equal(h.snapshot.tasks.filter(task=>task.status==="running").length,2);
  h.complete("review","completed","Independent result");h.publish();await h.tick();
  assert.equal(h.snapshot.tasks[1].status,"completed");assert.equal(h.snapshot.tasks[0].status,"running");
  h.panel().session.interrupt();await h.settle();assert.equal(h.team.phase,"paused");assert.equal(h.snapshot.tasks[0].status,"uncertain");assert.equal(h.snapshot.tasks[1].status,"completed");
});
test("an explicit dependency blocks even a free reader until its prerequisite completes",async t=>{
  const h=harness(t,{readerWorkers:true});await h.settle();h.queue();
  h.snapshot.tasks.push({id:"review-task",epoch:"epoch-1",key:"review-key",memberId:"review",instruction:"Review result",status:"queued",report:null,createdAt:2,updatedAt:2});
  h.snapshot.plan=[{taskKey:"key",memberId:"implement",task:"Implement the specific change",dependsOn:[]},{taskKey:"review-key",memberId:"review",task:"Review result",dependsOn:["key"]}];
  await h.tick();await h.tick();assert.deepEqual(h.delivered.map(item=>item.member),["implement"]);
  h.complete("implement");h.publish();await h.tick();await h.tick();assert.deepEqual(h.delivered.map(item=>item.member),["implement","review"]);
});

test("a principal that returned early receives one review turn when parallel reports finish",async t=>{
  const h=harness(t,{readerWorkers:true});await h.settle();h.queue();
  h.snapshot.tasks.push({id:"review-task",epoch:"epoch-1",key:"review-key",memberId:"review",instruction:"Independent review",status:"queued",report:null,createdAt:2,updatedAt:2});
  h.snapshot.plan=[{taskKey:"key",memberId:"implement",task:"Implement the specific change",dependsOn:[]},{taskKey:"review-key",memberId:"review",task:"Independent review",dependsOn:[]}];
  await h.tick();await h.tick();h.complete("principal","completed","Tasks queued");h.publish();await h.tick();
  assert.equal(h.team.phase,"running");h.complete("implement");h.complete("review","completed","Review verified");h.publish();await h.tick();await h.tick();
  const feedback=h.delivered.filter(item=>item.member==="principal");assert.equal(feedback.length,1);assert.match(feedback[0].text,/trex_task_status sin taskId/);assert.match(feedback[0].text,/review-key \(completed\)/);
  assert.ok(feedback[0].text.length<200,"the reports prompt stays short: its rules are in trex_task_status");
  await h.tick();assert.equal(h.delivered.filter(item=>item.member==="principal").length,1);
});

test("a new user message cannot trigger a duplicate reports review before its native acknowledgement",async t=>{
  const h=harness(t);await h.settle();h.queue();await h.tick();h.complete("implement");h.publish();await h.tick();h.complete("principal");h.publish();await h.tick();assert.equal(h.team.phase,"completed");
  const gate=deferred(),requested=[],original=h.sessions.principal.send;
  h.sessions.principal.send=async(...args)=>{requested.push(args[0]);await gate.promise;return original(...args);};
  h.publish();const sending=h.panel().session.send("A different new idea",[],[]);await h.settle();await h.tick();await h.tick();
  assert.deepEqual(requested,["A different new idea"]);gate.resolve();assert.equal(await sending,true);await h.settle();
});

test("restored team history retains human browser artifact controls without starting its agents",async t=>{
  const h=harness(t,{phase:"paused",restoredHistory:true,settings:{browserEnabled:true,browserProfile:"BROWSER1"}});await h.settle();
  assert.equal(h.panel().browser.enabled,true);assert.deepEqual(h.panel().browserSpaces,[]);
  for(const runtime of nodes(h.tree).filter(node=>node.props?.options))assert.equal(runtime.props.options.browser.enabled,false);
  assert.equal(h.delivered.length,0);
});

const apiUsage=(input,output,cached=0,cost=null)=>({inputTokens:input,outputTokens:output,reasoningTokens:null,cachedReadTokens:cached,cachedWriteTokens:0,totalTokens:input+output+cached,requests:1,costUsd:cost,partial:false,costPartial:false});
test("usage of each turn accrues to the member ledger and each finished delegation records its delta",async t=>{
  const h=harness(t);await h.settle();h.queue();await h.tick();const s=h.sessions.implement;
  s.state={...s.state,apiUsage:apiUsage(100,50,1000,0.01)};h.publish();
  assert.equal(h.team.usage.implement.newTokens,150);assert.equal(h.team.usage.implement.cacheReadTokens,1000);
  h.complete("implement");h.publish();await h.tick();
  const finish=h.calls.find(call=>call[0]==="finish"&&call[3]==="completed");assert.equal(finish[5].newTokens,150);assert.equal(finish[5].costUsd,0.01);
  const report=h.calls.filter(call=>call[0]==="usage").at(-1)[1];
  assert.equal(report.epoch,h.team.epoch);assert.deepEqual(report.members.map(member=>[member.memberId,member.coordinator]),[["principal",true],["implement",false],["review",false]]);
});
test("history loaded by a restored conversation is not charged to the team",async t=>{
  const h=harness(t);await h.settle();const s=h.sessions.review;
  s.state={...s.state,historyCount:4,apiUsage:apiUsage(90000,9000)};h.publish();
  assert.equal(h.team.usage?.review,undefined);
});
test("an exhausted budget fails the next delegation and pauses the team for the user",async t=>{
  const h=harness(t,{budget:{teamTokens:1000,memberTokens:null},usage:{principal:{newTokens:1500,cacheReadTokens:0,outputTokens:0,costUsd:null,requests:null}}});
  await h.settle();h.queue();await h.tick();
  assert.equal(h.delivered.length,0);assert.equal(h.snapshot.tasks[0].status,"failed");assert.match(h.snapshot.tasks[0].report,/Presupuesto agotado/);
  assert.equal(h.team.phase,"paused");assert.match(h.team.error,/Presupuesto agotado.*Amplía el presupuesto/);
});
test("a soft budget note travels with the delegation while budget remains",async t=>{
  const h=harness(t,{budget:{teamTokens:500000,memberTokens:null}});await h.settle();h.queue();await h.tick();
  assert.match(h.delivered[0].text,/Presupuesto orientativo restante: 500\.000 tokens/);
});
test("a member whose account is out of quota is not started and the coordinator is told why",async t=>{
  const h=harness(t);await h.settle();const s=h.sessions.implement;
  s.state={...s.state,plan:{plan:null,windows:[{id:"session",label:"Sesión (5 h)",percent:99,resetsAt:null,severity:"critical",headline:true}],extra:null,resetCredits:0}};h.publish();
  h.queue();await h.tick();
  assert.equal(h.delivered.length,0);assert.equal(h.snapshot.tasks[0].status,"failed");assert.match(h.snapshot.tasks[0].report,/99 % de su cuota/);assert.equal(h.team.phase,"running");
});
test("a member with a half-full context is summarized once before its next delegation",async t=>{
  const h=harness(t);await h.settle();const s=h.sessions.implement,commands=[],notes=[];
  s.supportsCompact=true;s.runCommand=name=>{commands.push(name);return true;};s.notice=(_tone,text)=>notes.push(text);
  s.state={...s.state,historyCount:2,usage:{used:70000,window:100000,parts:[],reserve:null,total:null}};h.publish();
  h.queue();await h.tick();
  assert.deepEqual(commands,["compact"]);assert.equal(h.delivered.length,0);assert.match(notes[0],/70 %/);
  s.state={...s.state,usage:{used:8000,window:100000,parts:[],reserve:null,total:null}};h.publish();await h.tick();
  assert.equal(h.delivered.length,1);assert.deepEqual(commands,["compact"]);
});
test("budget and per-member browser choices travel with the team",async t=>{
  const h=harness(t,{setup:{context:null},budget:{teamTokens:500000,memberTokens:null},memberBrowser:{review:false},settings:{browserEnabled:true,browserProfile:"BROWSER1"}});await h.settle();
  assert.deepEqual(h.team.budget,{teamTokens:500000,memberTokens:null});assert.equal(h.team.workers[1].browser,false);
  const runtimes=Object.fromEntries(nodes(h.tree).filter(node=>node.props?.options).map(node=>[node.props.id,node.props.options.browser.enabled]));
  assert.deepEqual(runtimes,{principal:false,implement:true,review:false});
});
test("researchers receive no Git snapshot",async t=>{
  const h=harness(t,{readerWorkers:true,reviewRole:"research"});await h.settle();
  h.snapshot.tasks.push({id:"research-task",epoch:"epoch-1",key:"research-key",memberId:"review",instruction:"Investigate the API",status:"queued",report:null,createdAt:2,updatedAt:2});
  await h.tick();assert.deepEqual(h.calls.filter(call=>call[0]==="prepare").map(call=>call[2]),[{git:"none"}]);
});

test("the role block reaches each live member session once; later delegations get a one-line reminder",async t=>{
  const h=harness(t);await h.settle();const s=h.sessions.implement;s.state={...s.state,sessionId:"conversation-a"};h.publish();
  h.queue();await h.tick();assert.equal(h.delivered.length,1);
  const first=h.delivered[0].text;assert.match(first,/# Función e instrucciones de esta delegación/);assert.match(first,/Verify the task/);assert.match(first,/500 palabras/);
  const issue=(id)=>{s.state={...s.state,pendingTurns:0,items:[...s.state.items,{kind:"text",id:"reply-"+id,messageId:"answer-"+id,text:"Done "+id,final:true}],
    lastCompletion:{id:"done-before-"+id,status:"completed",messageIds:["message-before-"+id],itemIds:["reply-"+id]}};h.publish();h.snapshot.tasks.push({id,epoch:h.team.epoch,key:id+"-key",memberId:"implement",instruction:"Follow-up "+id,status:"queued",report:null,createdAt:3,updatedAt:3});};
  const reset=()=>{s.state={...s.state,pendingTurns:0,pendingMessageIds:[],items:[]};h.publish();};
  issue("second");await h.tick();reset();await h.tick();
  const second=h.delivered.at(-1);assert.equal(h.delivered.length,2);assert.match(second.text,/Follow-up second/);
  assert.doesNotMatch(second.text,/# Función e instrucciones|Verify the task|Si la tarea tiene varios pasos/);
  assert.match(second.text,/misma función \(Implementación\)/);assert.ok(second.text.length<first.length);
  // A different native conversation (a new session) receives the block again.
  issue("third");s.state={...s.state,sessionId:"conversation-b"};h.publish();await h.tick();reset();await h.tick();
  assert.equal(h.delivered.length,3);assert.match(h.delivered[2].text,/# Función e instrucciones de esta delegación/);
});
test("a summarized member session and a new epoch receive the role block again",async t=>{
  const h=harness(t);await h.settle();const s=h.sessions.implement,commands=[];
  s.supportsCompact=true;s.runCommand=name=>{commands.push(name);return true;};
  h.queue();await h.tick();assert.equal(h.delivered.length,1);
  h.complete("implement");s.state={...s.state,pendingTurns:0,pendingMessageIds:[],items:[],historyCount:2,usage:{used:70000,window:100000,parts:[],reserve:null,total:null}};h.publish();
  h.snapshot.tasks.push({id:"after",epoch:h.team.epoch,key:"after-key",memberId:"implement",instruction:"After compaction",status:"queued",report:null,createdAt:3,updatedAt:3});
  await h.tick();assert.deepEqual(commands,["compact"]);
  s.state={...s.state,usage:{used:8000,window:100000,parts:[],reserve:null,total:null}};h.publish();await h.tick();
  assert.equal(h.delivered.length,2);assert.match(h.delivered[1].text,/After compaction/);assert.match(h.delivered[1].text,/# Función e instrucciones de esta delegación/);
});
test("computer and accessibility control follow the user's switches for every team member",async t=>{
  // Son integraciones que elige la persona: ningún rol las pierde por defecto.
  const h=harness(t,{settings:{desktopEnabled:true,a11yEnabled:true}});await h.settle();
  const options=Object.fromEntries(nodes(h.tree).filter(node=>node.props?.options).map(node=>[node.props.id,[node.props.options.desktopEnabled,node.props.options.a11yEnabled]]));
  assert.deepEqual(options,{principal:[true,true],implement:[true,true],review:[true,true]});
  const off=harness(t,{settings:{desktopEnabled:false,a11yEnabled:false},masterMode:"acceptEdits"});await off.settle();
  for(const node of nodes(off.tree).filter(node=>node.props?.options))assert.deepEqual([node.props.options.desktopEnabled,node.props.options.a11yEnabled],[false,false],"the user's switches decide");
});
