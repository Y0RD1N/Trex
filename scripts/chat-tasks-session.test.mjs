import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { load } from "./ts-loader.mjs";
const { claudeInboxReply } = await load("inboxProtocol");

// Reuse the offline React/native boundaries, without registering their suites.
async function declarations(file, names) {
  const url = new URL(file, import.meta.url), source = await readFile(url, "utf8");
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const selected = ast.statements.filter(node => ts.isVariableStatement(node) || ts.isFunctionDeclaration(node)
    || (ts.isExpressionStatement(node) && ts.isBinaryExpression(node.expression)
      && node.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken));
  const body = selected.map(node => node.getText(ast)).join("\n").replaceAll("import.meta.url", JSON.stringify(url.href));
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  return new AsyncFunction("assert", "readFile", "ts", "load", `${body}\nreturn { ${names.join(",")} };`)(assert, readFile, ts, load);
}
const ui = await declarations("./queue-workflow-controls.test.mjs", ["host", "environment", "panelModule", "baseProps", "queueStore", "find", "elements", "noop"]);
const native = await declarations("./queue-send-now.test.mjs", ["harness"]);
const { initialChatState } = await load("chatState");
const { chatReducer, claudeChatFlags } = await load("claudeChat");
const { codexReducer } = await load("codexChat");
const { trexReducer } = await load("trexChat");
const { chatTasks } = await load("chatTasks");

const taskToolName = "mcp__trex_inbox__trex_update_tasks";
const taskPlan = { plan: [{ step: "Revisar los archivos", status: "in_progress" }, { step: "Probar los cambios", status: "pending" }] };
test("the app's always-attached MCP advertises task tracking without native task tools", async () => {
  const reply = await claudeInboxReply("tasks-list", { subtype: "mcp_message", server_name: "trex_inbox", message: { id: 1, method: "tools/list" } }, () => assert.fail("discovery must not consume messages"));
  const tools = JSON.parse(reply.line).response.response.mcp_response.result.tools;
  assert.ok(tools.some(tool => tool.name === "trex_update_tasks"));
});
test("the app task tool accepts a validated list without consuming the inbox", async () => {
  const reply = await claudeInboxReply("tasks-call", { subtype: "mcp_message", server_name: "trex_inbox", message: { id: 2, method: "tools/call", params: { name: "trex_update_tasks", arguments: taskPlan } } }, () => assert.fail("tasks must not consume messages"));
  const response = JSON.parse(reply.line).response.response.mcp_response;
  assert.equal(response.error, undefined);
  assert.equal(response.result.isError, false);
  assert.deepEqual(response.result.structuredContent.plan, taskPlan.plan);
});
test("Claude app task results become visible only after acceptance and restore from real protocol history", () => {
  const entries = [
    { type: "assistant", message: { content: [{ type: "tool_use", id: "app-tasks", name: taskToolName, input: taskPlan }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "app-tasks", content: JSON.stringify(taskPlan) }] } },
  ];
  const pending = chatReducer(initialChatState("default"), { type: "line", event: entries[0], now: 1 });
  assert.deepEqual(chatTasks(pending.items, "Claude"), []);
  const accepted = chatReducer(pending, { type: "line", event: entries[1], now: 2 });
  assert.deepEqual(chatTasks(accepted.items, "Claude").map(task => task.status), ["in_progress", "pending"]);
  const restored = chatReducer(initialChatState("plan"), { type: "history", entries });
  assert.deepEqual(chatTasks(restored.items, "Claude").map(task => task.title), taskPlan.plan.map(step => step.step));
});
test("Codex's app MCP task result updates the ordinary task panel", () => {
  const item = { type: "mcpToolCall", id: "app-tasks", server: "trex_inbox", tool: "trex_update_tasks", arguments: taskPlan, status: "completed", result: { isError: false, content: [], structuredContent: taskPlan } };
  const state = codexReducer(initialChatState("auto"), { type: "rpc", message: { method: "item/completed", params: { item, turnId: "turn-1" } }, scope: "process", now: 1 });
  assert.deepEqual(chatTasks(state.items, "Codex").map(task => task.status), ["in_progress", "pending"]);
});
test("Claude planning permits native task metadata and app tasks while rejecting workspace writes", async t => {
  const h = native.harness(t, "claude", { mode: "plan", planningOnly: true }); await h.ready();
  for (const tool of ["TodoWrite", "TaskCreate", "TaskUpdate", "TaskList", "TaskGet", taskToolName]) {
    h.line({ type: "control_request", request_id: tool, request: { subtype: "can_use_tool", tool_name: tool, input: {} } }); await h.pump();
    const response = h.writes.findLast(write => write.response?.request_id === tool);
    // Native task permissions may use the normal UI. They must never be silently denied by the planner guard.
    assert.notEqual(response?.response?.response?.behavior, "deny", tool);
    if (tool === taskToolName) assert.equal(response?.response?.response?.behavior, "allow");
  }
  h.line({ type: "control_request", request_id: "no-write", request: { subtype: "can_use_tool", tool_name: "Write", input: { file_path: "file.ts", content: "bad" } } }); await h.pump();
  assert.equal(h.writes.findLast(write => write.response?.request_id === "no-write").response.response.behavior, "deny");
});

test("app task validation rejects malformed, oversized and partially invalid lists without reading messages", async () => {
  for (const input of [null, [], {}, {plan:[],cwd:"elsewhere"}, {plan:[...taskPlan.plan,null]},
    {plan:[{step:"A",status:"in_progress"},{step:"B",status:"in_progress"}]},
    {plan:[{step:" ",status:"pending"}]}, {plan:[{step:"A",status:"deleted"}]},
    {plan:[{step:"A",status:"pending",command:"run"}]}, {plan:[{step:"x".repeat(2001),status:"pending"}]},
    {plan:Array.from({length:65},()=>({step:"A",status:"pending"}))},
    {plan:Array.from({length:20},()=>({step:"x".repeat(1999),status:"pending"}))}]) {
    const reply=await claudeInboxReply("invalid-tasks",{subtype:"mcp_message",server_name:"trex_inbox",message:{id:7,method:"tools/call",params:{name:"trex_update_tasks",arguments:input}}},()=>assert.fail("invalid tasks must not consume messages"));
    assert.equal(JSON.parse(reply.line).response.response.mcp_response.error?.code,-32602);
  }
});

test("failed, unconfirmed, malformed and foreign task responses cannot replace an accepted task list", () => {
  const accepted={kind:"tool",id:"previous",name:"TodoWrite",status:"done",input:{todos:[{content:"Keep",status:"pending"}]},output:null,patch:null};
  for(const variant of ["failed","missing-result","malformed","foreign","pending"]) {
    const item={type:"mcpToolCall",id:"new",server:variant==="foreign"?"foreign":"trex_inbox",tool:"trex_update_tasks",arguments:variant==="malformed"?{plan:[null]}:taskPlan,status:variant==="pending"?"inProgress":"completed",result:variant==="missing-result"?null:{isError:variant==="failed",content:[]}};
    const state=codexReducer({...initialChatState("auto"),items:[accepted]},{type:"rpc",message:{method:"item/completed",params:{item,turnId:"turn"}},scope:"p",now:1});
    assert.deepEqual(chatTasks(state.items,"Codex").map(task=>task.title),["Keep"],variant);
  }
  for(const failed of [true,false]) {
    const tool={type:"assistant",message:{content:[{type:"tool_use",id:"new",name:taskToolName,input:taskPlan}]}};
    let state=chatReducer({...initialChatState("default"),items:[accepted]},{type:"line",event:tool,now:1});
    if(failed)state=chatReducer(state,{type:"line",event:{type:"user",message:{content:[{type:"tool_result",tool_use_id:"new",is_error:true,content:"Rejected"}]}},now:2});
    else state=chatReducer(state,{type:"line",event:{type:"result",subtype:"success",uuid:"terminal"},now:2});
    assert.deepEqual(chatTasks(state.items,"Claude").map(task=>task.title),["Keep"]);
  }
});

for (const provider of ["claude","codex"]) test(`${provider}: app task acceptance opens the existing task panel in an ordinary chat`, t => {
  const environment=ui.environment(),component=ui.host(t),{ChatPanel}=ui.panelModule(environment);
  const input=provider==="claude"?[
    {type:"assistant",message:{content:[{type:"tool_use",id:"app-tasks",name:taskToolName,input:taskPlan}]}},
    {type:"user",message:{content:[{type:"tool_result",tool_use_id:"app-tasks",content:JSON.stringify(taskPlan)}]}},
  ]:[{method:"item/completed",params:{item:{type:"mcpToolCall",id:"app-tasks",server:"trex_inbox",tool:"trex_update_tasks",arguments:taskPlan,status:"completed",result:{isError:false,content:[]}},turnId:"turn"}}];
  let state=initialChatState(provider==="claude"?"default":"auto");
  const session={provider,state,queue:ui.queueStore(),notice:ui.noop,refreshSkills:ui.noop};
  const render=()=>component.render(()=>ChatPanel({...ui.baseProps(),provider,session}));
  render();for(const event of input)state=provider==="claude"?chatReducer(state,{type:"line",event,now:1}):codexReducer(state,{type:"rpc",message:event,scope:"p",now:1});
  session.state=state;const tree=render();
  const panel=ui.find(tree,node=>node.type==="./chat/TaskPanel:default");
  assert.deepEqual(panel.props.tasks.map(task=>task.title),taskPlan.plan.map(step=>step.step));
  assert.equal(state.modeChoice,provider==="claude"?"default":"auto");
});

function taskEvents(provider, stage) {
  const done = stage === "done";
  const tasks = [{ content: "Revisar el código", status: "completed" }, { content: "Validar los cambios", status: done ? "completed" : "in_progress" }];
  if (provider === "claude") {
    const id = `tasks-${stage}`;
    return [
      { type: "assistant", message: { content: [{ type: "tool_use", id, name: "TodoWrite", input: { todos: tasks } }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: "Tasks updated", is_error: stage === "error" }] } },
    ];
  }
  const plan = tasks.map(task => ({ step: task.content, status: task.status }));
  if (provider === "codex") return [{ method: "turn/plan/updated", params: { threadId: "thread", turnId: "turn",
    plan: plan.map(task => ({ ...task, status: task.status === "in_progress" ? "inProgress" : task.status })) } }];
  const params = { sessionId: "conversation", messageId: "user" };
  return [
    { method: "tool/start", params: { ...params, id: `tasks-${stage}`, toolName: "update_plan", input: { plan } } },
    { method: "tool/result", params: { ...params, id: `tasks-${stage}`, output: "Tasks updated", isError: stage === "error" } },
  ];
}
function apply(provider, state, event) {
  if (provider === "claude") return chatReducer(state, { type: "line", event, now: 5 });
  if (provider === "codex") return codexReducer(state, { type: "rpc", message: event, scope: "process", now: 5 });
  return trexReducer(state, { type: "trexEvent", ...event, now: 5 });
}
const modes = { claude: ["default", "bypassPermissions"], codex: ["auto", "full"], trex: ["ask", "full"] };
for (const [provider, choices] of Object.entries(modes)) for (const mode of choices) {
  test(`${provider}/${mode}: ordinary chat exposes tasks, opens accepted lists, and preserves manual collapse`, t => {
    const env = ui.environment(), component = ui.host(t), { ChatPanel } = ui.panelModule(env);
    const forbidden = () => assert.fail("Opening tasks must not send, launch, or change modes");
    const session = { provider, state: { ...initialChatState(mode), process: "ready", sessionId: "conversation" },
      queue: ui.queueStore(), start: forbidden, send: forbidden, setMode: forbidden, notice: forbidden, refreshSkills: ui.noop };
    let tree;
    const props = { ...ui.baseProps(), provider, mode, session };
    const render = () => tree = component.render(() => ChatPanel(props));
    const toggle = () => ui.find(tree, node => node.props.className === "chat-task-toggle");
    const panels = () => [...ui.elements(tree)].filter(node => node.type === "./chat/TaskPanel:default");
    render();
    assert.equal(toggle().props["aria-expanded"], false);
    toggle().props.onClick(); render();
    assert.equal(panels().length, 1); assert.deepEqual(panels()[0].props.tasks, []);
    panels()[0].props.onClose(); render(); assert.equal(panels().length, 0);
    session.state = { ...session.state, pendingTurns: 1, pendingMessageIds: ["user"] };
    const events = taskEvents(provider, "working");
    session.state = apply(provider, session.state, events[0]); render();
    if (events.length > 1) {
      assert.equal(panels().length, 0, "unconfirmed task input cannot publish a list");
      session.state = apply(provider, session.state, events[1]); render();
    }
    assert.equal(panels().length, 1, "the first accepted task list opens automatically in a normal chat");
    assert.deepEqual(panels()[0].props.tasks.map(task => task.status), ["completed", "in_progress"]);
    assert.equal(session.state.modeChoice, mode, "task tracking keeps the selected native mode");
    panels()[0].props.onClose(); render();
    for (const event of taskEvents(provider, "done")) session.state = apply(provider, session.state, event);
    render(); assert.equal(panels().length, 0, "progress must not reopen a manually collapsed list");
    toggle().props.onClick(); render();
    assert.deepEqual(panels()[0].props.tasks.map(task => task.status), ["completed", "completed"]);
    assert.equal(toggle().props["aria-expanded"], true);
    assert.equal(session.state.modeChoice, mode);
    // Mounting a chat whose accepted history is already loaded opens its list too.
    const restored = ui.host(t).render(() => ChatPanel(props));
    assert.equal(ui.find(restored, node => node.type === "./chat/TaskPanel:default").props.tasks.length, 2);
  });

  test(`${provider}/${mode}: native startup includes task guidance without entering planning mode or sending a turn`, async t => {
    const h = native.harness(t, provider, { mode }); await h.ready();
    let instructions;
    if (provider === "claude") {
      const flags = h.spawns[0].request.flags;
      instructions = flags[flags.indexOf("--append-system-prompt") + 1];
      assert.ok(!flags.includes("plan"));
    } else {
      const start = h.writes.find(write => write.method === (provider === "trex" ? "session/start" : "thread/start"));
      instructions = start.params[provider === "trex" ? "instructions" : "developerInstructions"];
      if (provider === "trex") assert.equal(start.params.mode, mode);
    }
    if (provider === "trex") {
      // Trex CLI pide la lista con update_plan, sin marcar lo no verificado y sin mutar al planificar
      // en su propio prompt de sistema: la app solo añade lo que falta.
      assert.match(instructions, /Skip task lists for simple questions/);
      assert.doesNotMatch(instructions, /never execute a mutation in read-only planning mode/);
    } else {
      assert.match(instructions, /ordinary chats/);
      assert.match(instructions, provider === "claude" ? /TaskCreate\/TaskUpdate/ : /update_plan/);
      assert.match(instructions, /completed only after verifying/);
      assert.match(instructions, /never execute a mutation in read-only planning mode/);
    }
    assert.match(instructions, /Blender/);
    assert.match(instructions, /HyperFrames/);
    assert.match(instructions, /GitHub/);
    assert.doesNotMatch(instructions, /desktop_status|desktop_monitors|browser_navigate/);
    assert.equal(h.userWrites.length, 0);
    assert.equal(h.state.modeChoice, mode);
  });
}

test("Claude's custom system instructions retain precedence", () => {
  for (const args of ['--append-system-prompt "My workflow"', "--system-prompt-file custom.md"]) {
    assert.equal(claudeChatFlags(args, null).includes("--append-system-prompt"), false);
  }
});

test("Claude with a custom system prompt still gets capability guidance through the app MCP server", async () => {
  assert.equal(claudeChatFlags('--append-system-prompt "My workflow"',null).includes("--append-system-prompt"),false);
  const reply=await claudeInboxReply("init-tools",{subtype:"mcp_message",server_name:"trex_inbox",message:{jsonrpc:"2.0",id:1,method:"initialize",params:{protocolVersion:"2025-06-18"}}},()=>assert.fail("initialization must not read queued messages"), { desktop: true, browser: true });
  const result=JSON.parse(reply.line).response.response.mcp_response.result;
  for (const term of ["GitHub","Blender","HyperFrames","trex_desktop","desktop_screenshot","browser_navigate"]) assert.ok(result.instructions.includes(term),term);
});

test("normal Claude history restores incremental tasks without a live turn or fabricated completion", () => {
  const entries = [
    { type: "assistant", message: { content: [{ type: "tool_use", id: "create", name: "TaskCreate", input: { subject: "Validar los cambios" } }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "create", content: 'Task #7 created successfully: Validar los cambios' }] } },
    { type: "assistant", message: { content: [{ type: "tool_use", id: "update", name: "TaskUpdate", input: { taskId: "7", status: "in_progress" } }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "update", content: "Updated" }] } },
  ];
  const state = chatReducer(initialChatState("default"), { type: "history", entries });
  assert.deepEqual(chatTasks(state.items, "Claude").map(task => [task.title, task.status]), [["Validar los cambios", "in_progress"]]);
  assert.equal(state.lastCompletion, null); assert.equal(state.pendingTurns, 0); assert.equal(state.modeChoice, "default");
});
