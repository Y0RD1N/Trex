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
