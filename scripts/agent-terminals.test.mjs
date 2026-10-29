import assert from "node:assert/strict";
import test from "node:test";
import { load } from "./ts-loader.mjs";
const { AgentTerminals } = await load("agentTerminals");
const tick = () => new Promise(resolve => setImmediate(resolve));
function harness(t, provider = "codex") {
  let tracker, process = "runtime-1", jobs = [{ processId: "42", itemId: "item-a", command: "npm run dev", cwd: "D:/project" }, { processId: "43", itemId: "item-b", command: "npm test -- --watch", cwd: "D:/project" }];
  const requests = [], held = [], logs = [];
  let hold = false, error = null, listOverride = null;
  const reply = (request, result, runtime = process) => tracker.observe(JSON.stringify(provider === "claude" ? { type: "control_response", response: { request_id: request.request_id, subtype: "success", response: result } } : { id: request.id, result }), runtime);
  tracker = new AgentTerminals(provider, async (runtime, raw) => {
    const request = JSON.parse(raw); requests.push({ runtime, ...request });
    if (hold) { held.push({ runtime, request }); return; }
    queueMicrotask(() => {
      if (error) { tracker.observe(JSON.stringify({ id: request.id, error: { code: -32601, message: error } }), runtime); return; }
      if (provider === "claude") reply(request, {}, runtime);
      else if (request.method === "process/write") reply(request, { accepted: true }, runtime);
      else if (/terminate|stop/.test(request.method)) { jobs = jobs.filter(row => (row.processId ?? row.id) !== request.params.processId); reply(request, { terminated: true }, runtime); }
      else if (request.method === "process/read") reply(request, { text: "tail of output", truncated: true }, runtime);
      else reply(request, listOverride ?? (provider === "trex" ? { processes: jobs.map(({processId, ...row}) => ({...row,id:processId,status:"running"})) } : { data: jobs, nextCursor: null }), runtime);
    });
  }, async (runtime, task) => { logs.push({ runtime, task }); return { text: "provider log", truncated: false, available: true }; });
  tracker.attach(process, "D:/project");
  t.after(() => tracker.detach());
  return { tracker, requests, held, logs, reply,
    line: event => tracker.observe(JSON.stringify(event), process),
    async ready() { tracker.bind("thread-1"); await tracker.refresh(); },
    set jobs(value) { jobs = value; }, set error(value) { error = value; }, set hold(value) { hold = value; }, set list(value) { listOverride = value; },
    restart() { process = "runtime-2"; tracker.attach(process, "D:/project"); },
  };
}
test("Codex uses owned provider process IDs, preserves peers and does not clear at turn completion", async t => {
  const h = harness(t); await h.ready();
  assert.equal(h.tracker.snapshot.entries.length, 2);
  h.line({ method: "turn/completed", params: { threadId: "thread-1" } });
  assert.equal(h.tracker.snapshot.entries.filter(e => e.state === "running").length, 2);
  const entry = h.tracker.snapshot.entries[0]; await h.tracker.stop(entry.id);
  assert.deepEqual(h.requests.find(r => r.method.includes("terminate")).params, { threadId: "thread-1", processId: "42" });
  assert.equal(h.tracker.snapshot.entries.find(e => e.id === entry.id).state, "stopped");
  assert.equal(h.tracker.snapshot.entries.filter(e => e.state === "running").length, 1);
  await h.tracker.stop("an-arbitrary-os-pid"); assert.equal(h.requests.filter(r => r.method.includes("terminate")).length, 1);
});

test("Trex interactive input uses the owned session and refuses finished, foreign and noninteractive terminals", async t => {
  const h = harness(t, "trex");
  h.jobs = [{ processId: "pty-1", itemId: "input", command: "interactive command", cwd: "D:/project", interactive: true }];
  await h.ready();
  const entry = h.tracker.snapshot.entries[0]; assert.equal(entry.canWrite, true);
  await h.tracker.sendInput(entry.id, "áé 中文 🦖\n");
  assert.deepEqual(h.requests.find(r => r.method === "process/write").params, { sessionId: "thread-1", processId: "pty-1", text: "áé 中文 🦖\n" });
  await assert.rejects(h.tracker.sendInput("foreign", "no\n"));
  await assert.rejects(h.tracker.sendInput(entry.id, "bad\0"));
  h.jobs = []; await h.tracker.refresh(); assert.equal(h.tracker.snapshot.entries[0].canWrite, false);
  await assert.rejects(h.tracker.sendInput(entry.id, "after exit\n"));
  assert.equal(h.requests.filter(r => r.method === "process/write").length, 1);
});
test("Codex output is bounded and joined by thread and item, not by display command", async t => {
  const h = harness(t); await h.ready();
  h.line({ method: "item/commandExecution/outputDelta", params: { threadId: "thread-1", itemId: "item-a", delta: "x".repeat(100000) + "TAIL" } });
  assert.equal(h.tracker.snapshot.entries[0].output.length, 65536);
  assert.ok(h.tracker.snapshot.entries[0].output.endsWith("TAIL"));
  assert.equal(h.tracker.snapshot.entries[0].truncated,true);
  h.line({ method: "item/commandExecution/outputDelta", params: { threadId: "thread-1", itemId: "item-a", delta: "🔭".repeat(40000)+"TAIL" } });
  assert.ok(new TextEncoder().encode(h.tracker.snapshot.entries[0].output).length<=65536);
  assert.ok(!h.tracker.snapshot.entries[0].output.includes('�'));
  h.line({ method: "item/commandExecution/outputDelta", params: { threadId: "another-thread", itemId: "item-a", delta: "FOREIGN" } });
  assert.ok(!h.tracker.snapshot.entries[0].output.includes("FOREIGN"));
});
test("A reused provider process ID with a different command item cannot retarget an old terminal row", async t => {
  const h=harness(t);await h.ready();const old=h.tracker.snapshot.entries[0];
  h.jobs=[{processId:"42",itemId:"new-command",command:"different server",cwd:"D:/project"}];await h.tracker.refresh();
  const replacement=h.tracker.snapshot.entries.find(e=>e.command==="different server");assert.notEqual(replacement.id,old.id);
  assert.equal(h.tracker.snapshot.entries.find(e=>e.id===old.id).state,"completed");await h.tracker.stop(old.id);
  assert.equal(h.requests.filter(r=>r.method.includes("terminate")).length,0);
});
test("Old generation responses and late output cannot repopulate a new runtime", async t => {
  const h = harness(t); h.hold = true; h.tracker.bind("thread-1"); const old = h.tracker.refresh(); await tick();
  h.restart(); h.reply(h.held[0].request, { data: [{processId:"bad",command:"old",cwd:"old"}] }, "runtime-1"); await old;
  assert.equal(h.tracker.snapshot.entries.length, 0);
  h.hold = false; await h.ready(); assert.equal(h.tracker.snapshot.entries.length, 2);
  h.tracker.observe(JSON.stringify({method:"item/commandExecution/outputDelta",params:{threadId:"thread-1",itemId:"item-a",delta:"OLD"}}),"runtime-1");
  assert.equal(h.tracker.snapshot.entries[0].output, "");
});
test("Unavailable methods and malformed lists are not reported as a confirmed empty list", async t => {
  const h = harness(t); h.error = "method not found"; await h.ready(); assert.equal(h.tracker.snapshot.status, "unsupported");
  h.error = null; await h.tracker.refresh(); assert.equal(h.tracker.snapshot.entries.length, 2);
  h.list = { data: [null] }; await h.tracker.refresh(); assert.equal(h.tracker.snapshot.status, "error"); assert.equal(h.tracker.snapshot.entries.length, 2);
});
test("Repeated pagination cursors terminate with partial-state error", async t => {
  const h = harness(t); h.list = { data: [], nextCursor: "same" }; await h.ready();
  assert.equal(h.tracker.snapshot.status, "error"); assert.equal(h.requests.length, 2);
});
test("A poll during a rejected stop cannot leave the replacement snapshot stuck in stopping", async t=>{
  const h=harness(t);await h.ready();const id=h.tracker.snapshot.entries[0].id;h.hold=true;
  const stopping=h.tracker.stop(id), rejected=assert.rejects(stopping,/denied/);await tick();
  const refresh=h.tracker.refresh();await tick();h.reply(h.held.find(x=>x.request.method.endsWith('/list')).request,{data:[{processId:'42',itemId:'item-a',command:'npm run dev',cwd:'D:/project'}]});await refresh;
  const request=h.held.find(x=>x.request.method.endsWith('/terminate')).request;h.line({id:request.id,error:{message:'denied'}});await rejected;
  assert.equal(h.tracker.snapshot.entries.find(e=>e.id===id).state,'running');
});
test("A read completing across a poll updates the same owned terminal's new snapshot", async t=>{
  const h=harness(t,'trex');await h.ready();const id=h.tracker.snapshot.entries[0].id;h.hold=true;const read=h.tracker.read(id);await tick();
  const refresh=h.tracker.refresh();await tick();h.reply(h.held.find(x=>x.request.method==='process/list').request,{processes:[{id:'42',command:'npm run dev',cwd:'D:/project',status:'running'}]});await refresh;
  h.reply(h.held.find(x=>x.request.method==='process/read').request,{text:'new live output',truncated:false});await read;
  assert.equal(h.tracker.snapshot.entries.find(e=>e.id===id).output,'new live output');
});
test("Codex native subagent terminal scopes are included once they are delegated", async t => {
  const h = harness(t); await h.ready();
  h.line({method:"item/started",params:{threadId:"thread-1",item:{id:"delegation",type:"collabAgentToolCall",receiverThreadIds:["child"]}}});
  await h.tracker.refresh(); assert.ok(h.requests.some(r => r.params.threadId === "child"));
});
test("Claude counts Bash tasks, not subagent jobs, and uses stop_task with confirmed lifecycle", async t => {
  const h = harness(t,"claude"); await h.ready();
  h.line({type:"system",subtype:"task_started",session_id:"thread-1",task_id:"subagent",task_type:"local_agent"});
  h.line({type:"system",subtype:"task_started",session_id:"thread-1",task_id:"shell",task_type:"local_bash",description:"npm run dev"});
  assert.equal(h.tracker.snapshot.entries.length, 1);
  const entry = h.tracker.snapshot.entries[0]; await h.tracker.stop(entry.id);
  assert.deepEqual(h.requests[0].request, {subtype:"stop_task",task_id:"shell"});
  assert.equal(h.tracker.snapshot.entries[0].state,"stopping");
  h.line({type:"system",subtype:"task_updated",session_id:"thread-1",task_id:"shell",patch:{status:"killed"}});
  assert.equal(h.tracker.snapshot.entries[0].state,"stopped");
  h.line({type:"system",subtype:"task_started",session_id:"thread-1",task_id:"shell",task_type:"local_bash"});
  assert.equal(h.tracker.snapshot.entries[0].state,"stopped");
});
test("Claude terminal tombstones reject out-of-order start and full snapshots reconcile to empty", async t => {
  const h = harness(t,"claude"); await h.ready();
  h.line({type:"system",subtype:"task_notification",task_id:"old",status:"completed"});
  h.line({type:"system",subtype:"task_started",task_id:"old",task_type:"local_bash"}); assert.equal(h.tracker.snapshot.entries.length,0);
  h.line({type:"system",subtype:"background_tasks_changed",tasks:[{taskId:"live",taskType:"local_bash",description:"watch"},{taskId:"agent",taskType:"local_agent"}]});
  assert.equal(h.tracker.snapshot.entries.length,1);
  h.line({type:"system",subtype:"background_tasks_changed",tasks:[]}); assert.equal(h.tracker.snapshot.entries[0].state,"completed");
});
test("Claude associates Bash commands/output and reads logs using only the owned runtime/task ID", async t => {
  const h = harness(t,"claude"); await h.ready();
  h.line({type:"assistant",message:{content:[{type:"tool_use",id:"bash",name:"Bash",input:{command:"npm run dev"}}]}});
  h.line({type:"system",subtype:"task_started",task_id:"task",tool_use_id:"bash"});
  h.line({type:"user",message:{content:[{type:"tool_result",tool_use_id:"bash",content:"Local server ready"}]}});
  let entry = h.tracker.snapshot.entries[0]; assert.equal(entry.command,"npm run dev"); assert.equal(entry.output,"Local server ready");
  h.line({type:"system",subtype:"background_tasks_changed",tasks:[{task_id:"task",task_type:"local_bash",description:"Short provider label"}]});
  assert.equal(h.tracker.snapshot.entries[0].command,"npm run dev");
  await h.tracker.read(entry.id); assert.deepEqual(h.logs,[{runtime:"runtime-1",task:"task"}]); assert.equal(h.tracker.snapshot.entries[0].output,"provider log");
});
test("Trex background RPC retains output and uses the session-owned ID for stop", async t => {
  const h = harness(t,"trex"); await h.ready(); const entry = h.tracker.snapshot.entries[0];
  await h.tracker.read(entry.id); assert.equal(h.tracker.snapshot.entries[0].output,"tail of output"); assert.equal(h.tracker.snapshot.entries[0].truncated,true);
  await h.tracker.stop(entry.id); assert.deepEqual(h.requests.find(r=>r.method==="process/stop").params,{sessionId:"thread-1",processId:"42"});
});
test("History-shaped tool rows and ordinary command completion do not fabricate background terminals", async t => {
  const h = harness(t); h.jobs=[]; await h.ready();
  h.line({id:"history",result:{data:[{type:"commandExecution",id:"past",command:"npm run dev",status:"inProgress"}]}});
  h.line({method:"item/completed",params:{threadId:"thread-1",item:{type:"commandExecution",id:"past",command:"npm run dev",status:"completed"}}});
  assert.equal(h.tracker.snapshot.entries.length,0);
});
