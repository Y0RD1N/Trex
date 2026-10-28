import assert from 'node:assert/strict';
import test from 'node:test';
import { load } from './ts-loader.mjs';
const { chatTasks, teamTasks, activityGroups } = await load('chatTasks');
const { trexToolName, trexToolInput } = await load('trexChat');
const todo=(id,status,todos)=>({kind:'tool',id,name:'TodoWrite',status,input:{todos},output:null,patch:null});
test('only confirmed plan updates alter the list; latest snapshot is authoritative',()=>{
 const accepted=todo('a','done',[{content:'Read',status:'completed'},{content:'Build',status:'in_progress'}]);
 assert.deepEqual(chatTasks([accepted,todo('b','running',[{content:'Build',status:'completed'}])],'Codex').map(t=>t.status),['completed','in_progress']);
 assert.equal(chatTasks([accepted,todo('b','error',[])],'Codex').length,2);
 assert.deepEqual(chatTasks([accepted,todo('b','done',[])],'Codex'),[]);
 assert.equal(chatTasks([accepted], 'Codex')[0].sourceId,'a');
});
test('planned future steps stay pending and never imply execution or success',()=>{
 const snapshot={plan:[{taskKey:'read',memberId:'review',task:'Review code'},{taskKey:'write',memberId:'impl',task:'Implement'}],tasks:[{key:'read',memberId:'review',instruction:'Review code',status:'completed',report:'checked'},{key:'extra',memberId:'impl',instruction:'Investigate uncertainty',status:'uncertain',report:'Review before resuming'}]};
 const tasks=teamTasks(snapshot,[{id:'review',name:'Reviewer'},{id:'impl',name:'Executor'}]);
 assert.deepEqual(tasks.map(t=>t.status),['completed','pending','uncertain']);assert.equal(tasks[1].owner,'Executor');assert.equal(tasks[2].report,'Review before resuming');
 for(const [input,expected] of [['queued','pending'],['claimed','in_progress'],['running','in_progress'],['failed','failed'],['cancelled','cancelled']])assert.equal(teamTasks({tasks:[{key:'a',memberId:'impl',instruction:'A',status:input}]},[])[0].status,expected);
 assert.deepEqual(teamTasks(null,[]),[]);
});
test('worker activity preserves order and pending approvals stay visible outside collapsed activity',()=>{
 const items=[{id:'m',kind:'text'},{id:'u',kind:'user'},{id:'t',kind:'tool'},{id:'p',kind:'permission',state:'pending'},{id:'r',kind:'text'},{id:'end',kind:'text'}];
 const worker={worker:true,memberId:'worker',label:'Worker',provider:'trex'};const labels=Object.fromEntries(['u','t','p','r'].map(id=>[id,worker]));
 const groups=activityGroups(items,labels);assert.deepEqual(groups.map(g=>[g.start,g.end,!!g.author]),[[0,1,false],[1,3,true],[3,4,false],[4,5,true],[5,6,false]]);
 assert.equal(groups.flatMap(g=>items.slice(g.start,g.end)).length,items.length);
});
test('Trex API tools use the same task projection as native agents',()=>{
 assert.equal(trexToolName('update_plan'),'TodoWrite');
 const input=trexToolInput('update_plan',{plan:[{step:'Read',status:'completed'},{step:'Check',status:'in_progress'}]});
 const tasks=chatTasks([todo('tool','done',input.todos)],'TREX1');assert.equal(tasks.length,2);assert.equal(tasks[1].status,'in_progress');
});
test('incremental Claude tasks retain IDs and only confirmed updates complete or remove them',()=>{
 const create={kind:'tool',id:'create',name:'TaskCreate',status:'done',input:{subject:'Inspect code'},output:'Task #7 created successfully: Inspect code'};
 const update={kind:'tool',id:'update',name:'TaskUpdate',status:'done',input:{taskId:'7',status:'completed'}};
 assert.equal(chatTasks([create,{...update,status:'error'}],'Claude')[0].status,'pending');
 assert.equal(chatTasks([create,update],'Claude')[0].status,'completed');
 assert.deepEqual(chatTasks([create,{...update,input:{taskId:'7',status:'deleted'}}],'Claude'),[]);
 assert.equal(chatTasks([todo('old','done',[{content:'Preserve',status:'pending'}]),todo('broken','done',[null])],'Claude')[0].title,'Preserve');
});

test('room task lists stay isolated when agents reuse native task IDs', async () => {
 const {roomTasks}=await load('chatTasks');
 const create=(role,title)=>({kind:'tool',id:`${role}::create`,name:'TaskCreate',status:'done',input:{subject:title},output:'Task #7 created successfully'});
 const update=(role,status)=>({kind:'tool',id:`${role}::update`,name:'TaskUpdate',status:'done',input:{taskId:'7',status}});
 const names={planner:'Planificador',executor:'Ejecutor'};
 const plan=[create('planner','Implementar'),update('planner','pending')];
 assert.deepEqual(roomTasks(plan,names).map(t=>[t.title,t.status,t.owner]),[['Implementar','pending','Planificador']]);
 const execution=[...plan,create('executor','Implementar'),update('executor','in_progress')];
 assert.deepEqual(roomTasks(execution,names).map(t=>[t.title,t.status,t.owner]),[['Implementar','in_progress','Ejecutor']]);
 assert.equal(roomTasks([...execution,{...update('executor','completed'),status:'error'}],names)[0].status,'in_progress');
 assert.equal(roomTasks([...execution,update('executor','completed')],names)[0].status,'completed');
 assert.deepEqual(roomTasks([...execution,{kind:'tool',id:'executor::clear',name:'TodoWrite',status:'done',input:{todos:[]}}],names),[]);
 const nextCycle=[...execution,{kind:'user',id:'planner::new-request',text:'Plan a different feature'}];
 assert.deepEqual(roomTasks(nextCycle,names),[]);
 assert.deepEqual(roomTasks([...nextCycle,create('planner','New feature')],names).map(t=>t.title),['New feature']);
 assert.deepEqual(roomTasks([...plan,{kind:'user',id:'executor::handoff',text:'Implement'}, {kind:'user',id:'planner::next',text:'Plan again'}],names),[]);
});

test('handoff contains only confirmed planner tasks, with status and sanitized text', async () => {
 const {workflowPlanContext,PLANNING_INSTRUCTION,IMPLEMENTATION_INSTRUCTION}=await load('agentWorkflow');
 const source={sessionId:'room',provider:'claude',profileId:'a',profileName:'Planner',title:'Plan',projectId:'p',projectName:'P',cwd:'/tmp'};
 const items=[todo('draft','done',[{content:'Implementar',status:'pending'},{content:'Validar',status:'pending'}]),todo('failed','error',[{content:'Do not transfer',status:'completed'}])];
 const tasks=chatTasks(items,'Planner');
 const handoff=workflowPlanContext('Plan definitivo','Solicitud',source,tasks).content;
 assert.match(handoff,/\[pending\] Implementar/);assert.match(handoff,/\[pending\] Validar/);assert.doesNotMatch(handoff,/Do not transfer/);
 assert.match(PLANNING_INSTRUCTION,/herramientas de tareas/);assert.match(IMPLEMENTATION_INSTRUCTION,/identificadores o estados no se comparten/);
 assert.doesNotMatch(workflowPlanContext('Plan','Solicitud',source,[{title:'api_key=FAKE_SECRET_123456789',status:'pending'}]).content,/FAKE_SECRET/);
 assert.doesNotMatch(workflowPlanContext('Plan','Solicitud',source).content,/Tareas publicadas/);
});
