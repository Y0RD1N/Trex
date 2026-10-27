import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { load } from "./ts-loader.mjs";

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
    assert.match(instructions, /ordinary chats/);
    assert.match(instructions, provider === "claude" ? /TaskCreate\/TaskUpdate/ : /update_plan/);
    assert.match(instructions, /completed only after verifying/);
    assert.equal(h.userWrites.length, 0);
    assert.equal(h.state.modeChoice, mode);
  });
}

test("Claude's custom system instructions retain precedence", () => {
  for (const args of ['--append-system-prompt "My workflow"', "--system-prompt-file custom.md"]) {
    assert.equal(claudeChatFlags(args, null).includes("--append-system-prompt"), false);
  }
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
