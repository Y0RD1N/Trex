import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { load } from './ts-loader.mjs';
const teamHelpers=await load('agentTeam'),roomHelpers=await load('agentRoom');
const profiles=await load('profiles'),state=await load('chatState'),{DEFAULT_SETTINGS}=await load('api');
const safety=await load('workflowSafety');
const handoff=await load('handoff');
const source=await readFile(new URL('../src/App.tsx',import.meta.url),'utf8');
const ast=ts.createSourceFile('App.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
function handler(name,scope){let found;function visit(node){if(ts.isVariableDeclaration(node)&&node.name.getText(ast)===name)found=node.initializer;ts.forEachChild(node,visit);}visit(ast);assert.ok(found);const js=ts.transpileModule('const candidate='+found.getText(ast),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;return new Function('scope','with(scope){'+js+';return candidate;}')(scope);}
function harness(captured=false){
 const project={id:'project',name:'Test',path:'D:/test'},settings={...DEFAULT_SETTINGS},opened=[],prepared=[],errors=[];
 const existing={id:'existing',projectId:'project',activity:'idle',kind:'codex',profileId:'codex-default',profileName:'Codex',conversationId:'550e8400-e29b-41d4-a716-446655440000',command:'codex',args:'',shell:'powershell',launchMode:'arg',env:null,chatMode:'auto'};
 let tabs=captured?[existing]:[];
 const scope={...profiles,...state,...teamHelpers,...safety,...handoff,workflowStartingRef:{current:false},workflowProject:project,configRef:{current:{settings,projects:[project]}},trexInstalledRef:{current:true},IS_WINDOWS:true,handoffTargetReason:()=>null,
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
