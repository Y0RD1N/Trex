import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { load } from './ts-loader.mjs';
const teamHelpers=await load('agentTeam'),roomHelpers=await load('agentRoom');
const profiles=await load('profiles'),state=await load('chatState'),{DEFAULT_SETTINGS}=await load('api');
const safety=await load('workflowSafety');
const permissions=await load('agentPermissions');
const handoff=await load('handoff');
const source=await readFile(new URL('../src/App.tsx',import.meta.url),'utf8');
const ast=ts.createSourceFile('App.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
function handler(name,scope){let found;function visit(node){if(ts.isVariableDeclaration(node)&&node.name.getText(ast)===name)found=node.initializer;ts.forEachChild(node,visit);}visit(ast);assert.ok(found);const js=ts.transpileModule('const candidate='+found.getText(ast),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;return new Function('scope','with(scope){'+js+';return candidate;}')(scope);}
function harness(captured=false){
 const project={id:'project',name:'Test',path:'D:/test'},settings={...DEFAULT_SETTINGS},opened=[],prepared=[],errors=[];
 const existing={id:'existing',projectId:'project',activity:'idle',kind:'codex',profileId:'codex-default',profileName:'Codex',conversationId:'550e8400-e29b-41d4-a716-446655440000',command:'codex',args:'',shell:'powershell',launchMode:'arg',env:null,chatMode:'auto'};
 let tabs=captured?[existing]:[];
 const scope={...profiles,...state,...teamHelpers,...safety,...handoff,...permissions,workflowStartingRef:{current:false},workflowProject:project,configRef:{current:{settings,projects:[project]}},trexInstalledRef:{current:true},IS_WINDOWS:true,handoffTargetReason:()=>null,
  workflowSourceRef:{current:captured?{context:{source:{sessionId:'existing'},content:'Saved prior discussion'},itemIds:['old-user']}:null},tabsRef:{current:tabs},
  crypto:{randomUUID:()=> '550e8400-e29b-41d4-a716-446655440001'},workflowSurfaceRef:{current:null},setWorkflowError:error=>{if(error)errors.push(error);},setWorkflowSubmitting(){},setWorkflowProject(){},setActiveTabId(){},
  requestAnimationFrame:callback=>callback(),waitForMotion:(_surface,callback)=>callback(),showToast:message=>errors.push(message),formatError:error=>String(error),
  prepareHandoff:async context=>{prepared.push(context);return {id:'saved-context',sourceLabel:'Old chat',content:context.content};},
  readQueuedMessages:async()=>({messages:[],receipt:null,outbox:[]}),setTabs:update=>{tabs=update(tabs);},openTab:(...args)=>{opened.push(args);return true;}};
 return {scope,opened,prepared,errors,get tabs(){return tabs;}};
}
const choice=profileId=>({profileId,model:null,effort:null});
const teamRequest=()=>({master:{...choice('claude-default'),id:'principal',name:'Principal',role:'coordinator',instructions:'Plan and review',canWrite:false},workers:[{...choice('codex-default'),id:'implement',name:'Implementer',role:'implementation',instructions:'Implement and validate',canWrite:true},{...choice('claude-default'),id:'review',name:'Reviewer',role:'review',instructions:'Review changes',canWrite:false}]});
test('saving a two-agent configuration opens an idle chat without an idea or pending model delivery',async()=>{
 const h=harness();await handler('startWorkflow',h.scope)({planner:choice('claude-default'),executor:choice('codex-default')});assert.deepEqual(h.errors,[]);assert.equal(h.prepared.length,0);assert.equal(h.opened.length,1);
 const room=h.opened[0][6];assert.equal(room.phase,'idle');assert.equal(room.cycle,0);assert.equal(room.active,'planner');assert.equal(room.pending,null);assert.equal(room.setupContext,null);assert.equal(roomHelpers.normalizeAgentRoom(room).phase,'idle');
});
test('saving an ordered team only creates a chat and keeps first-message setup pending',async()=>{
 const h=harness();const request=teamRequest();request.workers.reverse();await handler('startTeam',h.scope)(request);assert.deepEqual(h.errors,[]);assert.equal(h.prepared.length,0);assert.equal(h.opened.length,1);
 const team=h.opened[0][7];assert.equal(team.initial,null);assert.deepEqual(team.setup,{context:null});assert.deepEqual(team.workers.map(w=>w.id),['review','implement']);assert.equal(team.master.canWrite,false);
});
test('workflow setup applies explicit permissions to planner and executor, including an inherited chat',async()=>{
 const h=harness(true);await handler('startWorkflow',h.scope)({planner:{...choice('claude-default'),mode:'acceptEdits'},executor:{...choice('codex-default'),mode:'full'}});
 assert.deepEqual(h.errors,[]);const room=h.tabs[0].agentRoom;assert.equal(room.planner.mode,'acceptEdits');assert.equal(room.executor.mode,'full');
 assert.equal(roomHelpers.normalizeAgentRoom(room).planner.mode,'acceptEdits');
});
test('team setup preserves a writable principal and independent native permissions for each member',async()=>{
 const h=harness();const request=teamRequest();request.master.mode='acceptEdits';request.master.canWrite=true;request.workers[0].mode='full';request.workers[1].mode='plan';
 await handler('startTeam',h.scope)(request);assert.deepEqual(h.errors,[]);const team=h.opened[0][7];
 assert.equal(team.master.canWrite,true);assert.equal(team.master.mode,'acceptEdits');assert.equal(team.workers[0].mode,'full');assert.equal(team.workers[1].canWrite,false);
 assert.match(teamHelpers.teamInstruction(team),/wait:false/);assert.match(teamHelpers.teamInstruction(team),/termina la respuesta/);
});
for(const name of ['startWorkflow','startTeam'])test(name+': converting a chat preserves context for the next explicit message without auto-delivery',async()=>{
 const h=harness(true);await handler(name,h.scope)(name==='startTeam'?teamRequest():{planner:choice('claude-default'),executor:choice('codex-default')});assert.deepEqual(h.errors,[]);assert.equal(h.prepared.length,1);assert.equal(h.prepared[0].content,'Saved prior discussion');assert.equal(h.opened.length,0);
 const room=h.tabs[0].agentRoom,team=h.tabs[0].agentTeam;if(room){assert.equal(room.phase,'idle');assert.equal(room.pending,null);assert.equal(room.setupContext.id,'saved-context');assert.equal(room.setupContext.pending,false);}else{assert.equal(team.initial,null);assert.equal(team.setup.context.id,'saved-context');assert.equal(team.setup.context.pending,false);}
});
test('new setup references survive normalization and restoration; malformed setup cannot enter persisted config',()=>{
 const h=harness();const req=teamRequest();const member=raw=>({...raw,agent:{...choice(raw.profileId),provider:raw.profileId.startsWith('claude')?'claude':'codex',profileName:raw.name,launch:{profileId:raw.profileId,profileName:raw.name,command:raw.profileId.startsWith('claude')?'claude':'codex',args:null,shell:'powershell',launchMode:'arg',env:null}},conversationId:null});
 const team={id:'team',epoch:'epoch',master:member(req.master),workers:req.workers.map(member),phase:'running',order:[],initial:null,setup:{context:{id:'prior',pending:false,sourceLabel:'Earlier chat'}},error:null};
 const normalized=teamHelpers.normalizeAgentTeam(team);assert.deepEqual(normalized.setup,team.setup);assert.deepEqual(teamHelpers.restoreAgentTeam(normalized).setup,team.setup);
 for(const setup of [true,[],{context:'invalid'},{context:{id:'../bad'}}])assert.equal(teamHelpers.normalizeAgentTeam({...team,setup}),null);
 const context=teamHelpers.teamPlanningContext(normalized,'My idea',{sessionId:'chat',provider:'claude',profileId:'claude-default',profileName:'Principal',title:'Plan',projectId:'project',projectName:'Test',cwd:'D:/test'},'Prior discussion');assert.match(context.content,/My idea/);assert.match(context.content,/Prior discussion/);assert.ok(context.content.indexOf('1. implement')<context.content.indexOf('2. review'));
});
test('a converted room targets its inherited chat at the role that does not resume it, without a stored Git snapshot',async()=>{
 const h=harness(true),modes=[];const prepare=h.scope.prepareHandoff;h.scope.prepareHandoff=async(context,options)=>{modes.push(options?.git);return prepare(context);};
 await handler('startWorkflow',h.scope)({planner:choice('claude-default'),executor:choice('codex-default')});assert.deepEqual(h.errors,[]);
 const room=h.tabs[0].agentRoom;assert.equal(room.executor.conversationId,'550e8400-e29b-41d4-a716-446655440000');assert.equal(room.setupRole,'planner');assert.deepEqual(modes,['none']);
 assert.equal(roomHelpers.normalizeAgentRoom(room).setupRole,'planner');
});
test('a team whose principal resumes the converted chat does not receive that chat again as setup context',async()=>{
 const h=harness(true),modes=[];const prepare=h.scope.prepareHandoff;h.scope.prepareHandoff=async(context,options)=>{modes.push(options?.git);return prepare(context);};
 const request=teamRequest();request.master={...request.master,...choice('codex-default')};request.workers[0]={...request.workers[0],...choice('claude-default')};
 await handler('startTeam',h.scope)(request);assert.deepEqual(h.errors,[]);
 const team=h.tabs[0].agentTeam;assert.equal(team.master.conversationId,'550e8400-e29b-41d4-a716-446655440000');assert.deepEqual(team.setup,{context:null});assert.deepEqual(modes,[]);
 const other=harness(true),otherModes=[];const prepareOther=other.scope.prepareHandoff;other.scope.prepareHandoff=async(context,options)=>{otherModes.push(options?.git);return prepareOther(context);};
 await handler('startTeam',other.scope)(teamRequest());assert.equal(other.tabs[0].agentTeam.setup.context.id,'saved-context');assert.deepEqual(otherModes,['status']);
});
