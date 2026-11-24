import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import nodeTest from "node:test";
import ts from "typescript";
import { load } from "./ts-loader.mjs";

const test = (name, fn) => nodeTest(name, { timeout: 10000 }, fn);

// Use the queue suite's offline React/process harness, never its registrations.
// AST selection deliberately excludes top-level test calls and test loops.
async function declarations(file, exports, transform = source => source) {
  const url = new URL(file, import.meta.url), source = await readFile(url, "utf8");
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const selected = ast.statements.filter(node => ts.isVariableStatement(node) || ts.isFunctionDeclaration(node)
    || (ts.isExpressionStatement(node) && ts.isBinaryExpression(node.expression)
      && node.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken));
  const body = selected.map(node => node.getText(ast)).join("\n").replaceAll("import.meta.url", JSON.stringify(url.href));
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  return new AsyncFunction("assert", "readFile", "ts", "load", `${transform(body)}\nreturn { ${exports.join(", ")} };`)(assert, readFile, ts, load);
}

// Extend only the test boundary: the native desktop server and supported fake RPC
// replies. Every provider hook and reducer is production code.
const base = await declarations("./queue-send-now.test.mjs", ["harness", "flush", "deferred", "dependencies"], body => {
  const replacements = [
    ['claudeRewindPoint: async () => null },', 'claudeRewindPoint: async () => null, ...extra.api },'],
    ['extra.planningOnly ? "plan" : "default", commands:',
      'extra.nativePermissionMode ? extra.nativePermissionMode(spawns.find(spawn => spawn.id === request.process)?.request, request) : (extra.planningOnly ? "plan" : "default"), commands:'],
    ['response: { current_permission_mode:', `response: request.request?.subtype === "mcp_status" ? (() => {
      if (extra.desktopStatus) return extra.desktopStatus;
      const flags=spawns.find(spawn=>spawn.id===request.process)?.request.flags ?? [], i=flags.indexOf("--mcp-config");
      const config=i>=0?JSON.parse(flags[i+1]).mcpServers.trex_desktop:null;
      const mode=config?.args?.at(-1);
      const read=["desktop_screenshot","desktop_status","desktop_monitors","desktop_wait"];
      const names=mode==="plan"||mode==="observe"?read:[...read,"desktop_click","desktop_move","desktop_drag","desktop_scroll","desktop_type","desktop_key","desktop_actions"];
      return {mcpServers:config?[{name:"trex_desktop",status:"connected",serverInfo:{name:"trex-desktop"},config,tools:names.map(name=>({name}))}]:[]};
    })() : { current_permission_mode:`],
    ['models: [{ id: "offline-model", efforts: ["high", "max"] }]', 'models: extra.models ?? [{ id: "offline-model", efforts: ["high", "max"] }]'],
    ['writes, spawns, actions, queueCalls, queue, clock, line, respond, controlResponse, render, unmount,',
      'options, writes, spawns, actions, queueCalls, queue, clock, line, respond, controlResponse, render, unmount,'],
    ['case "thread/start": case "thread/resume":', 'case "thread/start": case "thread/resume": case "thread/fork":'],
    ['{ thread: { id: conversation }, model: "offline-model" }',
      '{ thread: { id: conversation }, model: "offline-model", ...extra.nativeThread(message, spawns.find(spawn => spawn.id === message.process)?.request) }'],
  ];
  for (const [before, after] of replacements) {
    assert.ok(body.includes(before), `offline harness boundary changed: ${before}`);
    body = body.replaceAll(before, after);
  }
  return body;
});
const { flush, deferred, dependencies } = base;
const browserModule = dependencies["../browser"];
const { DESKTOP_READ_TOOLS, DESKTOP_INPUT_TOOLS } = dependencies["../integrations"];
const cwd = "D:/projects/trex";
const inbox = { "mcp_servers.trex_inbox.command": "offline-inbox", "mcp_servers.trex_inbox.args": ["--session", "tab"] };
const DESKTOP = "C:\\Trex\\trex-agent.exe";
/** What a desktop server with this grant advertises: never input while observing. */
const connectedDesktopTools = mode => ({ data: [{ name: "trex_desktop", runtimeStatus: "connected", toolsError: null,
  tools: Object.fromEntries((mode === "observe" ? DESKTOP_READ_TOOLS : [...DESKTOP_READ_TOOLS, ...DESKTOP_INPUT_TOOLS]).map(name => [name, { name, inputSchema: { type: "object" } }])) }] });
const threadConfig = (h, index = -1) => h.writes.filter(write => ["thread/start", "thread/resume", "thread/fork"].includes(write.method)).at(index)?.params.config;

// Computer control (trex_desktop) is the tool server bound to the chat's permission mode. Its stdio
// grant is immutable: a change of permission class must rebuild it before any user work.
function harness(t, provider, extra = {}) {
  const calls = [], nativeKills = [];
  const nativeThread = (message, launch) => {
    let sandbox = extra.globalSandbox ?? "workspace-write", approvalPolicy = extra.globalApproval ?? "on-request";
    for (let index = 0; index < (launch?.flags.length ?? 0); index++) if (launch.flags[index] === "-c") {
      const entry = /^(sandbox_mode|approval_policy)\s*=\s*"([^"]+)"$/.exec(launch.flags[++index]);
      if (entry?.[1] === "sandbox_mode") sandbox = entry[2];
      if (entry?.[1] === "approval_policy") approvalPolicy = entry[2];
    }
    sandbox = message.params.sandbox ?? message.params.config?.sandbox_mode ?? sandbox;
    approvalPolicy = message.params.approvalPolicy ?? message.params.config?.approval_policy ?? approvalPolicy;
    return { sandbox, approvalPolicy };
  };
  // Trex CLI starts its own desktop engine (see trex-session.test.mjs): here only Claude and Codex bind it.
  const h = base.harness(t, provider, { desktopEnabled: provider !== "trex", resumeRequestedThread: provider === "codex",
    // Codex lists the tools of the thread it just opened.
    mcpStatus: () => connectedDesktopTools(threadConfig(h)?.["mcp_servers.trex_desktop.args"]?.at(-1)),
    ...extra, nativeThread,
    nativePermissionMode: (launch, request) => {
      if (Object.hasOwn(extra, "initializeMode")) return extra.initializeMode;
      if (extra.initializeModes) return extra.initializeModes[h.spawns.findIndex(spawn => spawn.id === request.process)];
      const offset = launch?.flags.lastIndexOf("--permission-mode") ?? -1;
      return offset >= 0 ? launch.flags[offset + 1]
        : dependencies["../workflowSafety"].claudeProfilePermissionMode(launch?.profileArgs ?? null, launch?.shell !== "wsl") ?? "default";
    },
    api: { messageQueueMcpConfig: async () => inbox, agentKill: async procId => { nativeKills.push(procId); },
      trexDesktopMcpConfig: async mode => {
        calls.push(mode);
        if (extra.configWait) await extra.configWait.promise;
        return { command: DESKTOP, args: ["desktop-mcp", "--mode", mode] };
      }, ...extra.api } });
  return Object.assign(h, { desktopCalls: calls, nativeKills });
}

function toolConfig(h, provider, index = -1) {
  if (provider === "claude") {
    const flags = h.spawns.at(index).request.flags, offset = flags.indexOf("--mcp-config");
    assert.ok(offset >= 0, "Claude receives external MCP configuration");
    return JSON.parse(flags[offset + 1]).mcpServers.trex_desktop;
  }
  const config = threadConfig(h, index);
  assert.equal(config["mcp_servers.trex_desktop.enabled"], true);
  assert.equal(config["mcp_servers.trex_inbox.command"], inbox["mcp_servers.trex_inbox.command"], "the bound tools preserve the existing inbox server");
  return { command: config["mcp_servers.trex_desktop.command"], args: config["mcp_servers.trex_desktop.args"] };
}
function assertBound(h, provider, mode, index = -1) {
  const config = toolConfig(h, provider, index);
  assert.equal(config.command, DESKTOP);
  assert.deepEqual(config.args, ["desktop-mcp", "--mode", mode]);
}
const send = h => h.session.send("Offline tool request", [], []);

test("Codex requires its bound tools and verifies this thread's inventory before the first model turn", async t => {
  const h = harness(t, "codex"); h.hold("mcpServerStatus/list");
  const sending = send(h);
  for (let i=0; i<20 && !h.writes.some(write=>write.method==="mcpServerStatus/list"); i++) await h.pump();
  const probe=h.writes.find(write=>write.method==="mcpServerStatus/list");assert.ok(probe);assert.equal(probe.params.threadId,h.conversation);assert.equal(probe.params.serverName,"trex_desktop");assert.equal(h.userWrites.length,0);
  const config=h.writes.find(write=>write.method==="thread/start").params.config;
  assert.equal(config["mcp_servers.trex_desktop.required"],true);assert.equal(config["mcp_servers.trex_desktop.tool_timeout_sec"],120);
  h.respond(probe,connectedDesktopTools("qa"));assert.equal(await sending,true);
  assert.doesNotMatch(JSON.stringify(h.writes),/trex_browser/);
});
for(const [name,inventory] of [
  ["missing server",{data:[]}],
  ["handshake failure",{data:[{name:"trex_desktop",runtimeStatus:"failed",tools:{},toolsError:"Supported MCP protocol: 2025-11-25"}]}],
  ["stale cached tools",{data:[{...connectedDesktopTools("qa").data[0],runtimeStatus:"failed"}]}],
  ["configuration changed",{data:[{...connectedDesktopTools("qa").data[0],runtimeStatus:null}]}],
  ["missing screenshots",{data:[{...connectedDesktopTools("qa").data[0],tools:{desktop_click:{name:"desktop_click"}}}]}],
  ["malformed tool list",{data:[{...connectedDesktopTools("qa").data[0],tools:[]}]}],
]) test("Codex never sends a model turn with "+name,async t=>{
  const h=harness(t,"codex",{mcpStatus:inventory});assert.equal(await send(h),false);assert.equal(h.userWrites.length,0);assert.equal(h.state.process,"failed");assert.ok(h.state.items.some(item=>item.kind==="notice"&&item.text.includes("el control de computadora")));
});
test("Codex retires an old tool inventory reply after an idle permission change",async t=>{
  const h=harness(t,"codex");h.hold("mcpServerStatus/list");const starting=h.session.start();
  for(let i=0;i<20&&!h.writes.some(write=>write.method==="mcpServerStatus/list");i++)await h.pump();
  const old=h.writes.find(write=>write.method==="mcpServerStatus/list");assert.ok(old);h.session.setMode("plan");h.respond(old,connectedDesktopTools("qa"));await starting;
  h.release("mcpServerStatus/list");assert.equal(await send(h),true);assert.equal(h.spawns.length,2);assertBound(h,"codex","observe");
  assert.equal(h.userWrites.length,1);assert.equal(h.userWrites[0].process,h.spawns[1].id);
});
test("Codex without bound tools adds no inventory queries",async t=>{
  const h=harness(t,"codex",{desktopEnabled:false});assert.equal(await send(h),true);
  assert.ok(!h.writes.some(write=>write.method==="mcpServerStatus/list"));
});
test("stopping a fork during tool discovery preserves the original thread's confirmed grant",async t=>{
  const history=[{id:"old-turn",status:"completed",items:[{type:"userMessage",id:"old-user",content:[{type:"text",text:"Original"}]}]}];
  const h=harness(t,"codex",{conversationId:"original-thread",history});await h.ready();const before=h.writes.length;h.hold("mcpServerStatus/list");
  const editing=h.session.edit("old-user","Edited",[],[]);
  for(let i=0;i<20&&!h.writes.slice(before).some(write=>write.method==="mcpServerStatus/list");i++)await h.pump();
  const probe=h.writes.slice(before).find(write=>write.method==="mcpServerStatus/list");assert.ok(probe);h.session.interrupt();h.respond(probe,connectedDesktopTools("qa"));await editing;
  h.release("mcpServerStatus/list");h.render();assert.equal(await send(h),true);assert.equal(h.userWrites.length,1);assert.equal(h.userWrites[0].params.threadId,"original-thread");
});
for(const provider of ["claude","codex"])test(provider+": a failed app-side tool preparation blocks sending instead of silently removing tools",async t=>{
  const wait=deferred();wait.reject(new Error("Synthetic prepare failure"));
  const h=harness(t,provider,{configWait:wait});assert.equal(await send(h),false);assert.equal(h.userWrites.length,0);
});

for (const provider of ["claude", "codex"]) {
  for (const [conversationId, planningOnly] of [null, "saved-conversation"].flatMap(id => [[id, false], [id, true]])) {
    test(`${provider}: ${planningOnly ? "planner " : ""}${conversationId ? "resume" : "startup"} injects the bound desktop MCP without changing native launch`, async t => {
      const h = harness(t, provider, { conversationId, planningOnly }); await h.ready();
      assert.equal(h.spawns.length, 1);
      const mode = planningOnly ? "observe" : "qa";
      assertBound(h, provider, mode);
      assert.deepEqual(h.desktopCalls, [mode]);
      assert.equal(h.spawns[0].request.command, provider);
      if (provider === "claude" && conversationId) {
        const flags = h.spawns[0].request.flags;
        assert.equal(flags[flags.indexOf("--resume") + 1], conversationId);
      }
      if (provider === "codex") assert.equal(h.writes.some(write => write.method === (conversationId ? "thread/resume" : "thread/start")), true);
      assert.equal(await send(h), true);
    });
  }
  test(`${provider}: without bound tools the native provider flow is unchanged`, async t => {
    const h = harness(t, provider, { desktopEnabled: false });
    await h.ready(); assert.equal(await send(h), true);
    assert.equal(h.spawns.length, 1);
    assert.deepEqual(h.desktopCalls, []);
    if (provider === "claude") assert.equal(h.spawns[0].request.flags.includes("--mcp-config"), false);
    else assert.equal(h.writes.find(write => write.method === "thread/start").params.config["mcp_servers.trex_desktop.command"], undefined);
  });
  for (const renderFirst of [false, true]) {
    test(`${provider}: idle permission class rebuild${renderFirst ? " after render" : " before React render"}`, async t => {
      const h = harness(t, provider); await h.ready();
      h.session.setMode("plan"); if (renderFirst) h.render();
      assert.equal(await send(h), true);
      h.render();
      assert.equal(h.spawns.length, 2, "permission class change starts a new native process");
      assertBound(h, provider, "observe");
      assert.equal(h.userWrites.at(-1).process, h.spawns.at(-1).id);
    });
  }
  test(`${provider}: startup discovery race cannot reuse an obsolete permission class`, async t => {
    const configWait = deferred(), h = harness(t, provider, { configWait });
    const oldStart = h.session.start(); await h.pump();
    assert.equal(h.desktopCalls.length, 1);
    h.session.setMode("plan");
    const pending = send(h); await h.pump();
    configWait.resolve();
    await oldStart; assert.equal(await pending, true); h.render();
    assert.equal(h.spawns.length, 1, "obsolete startup does not spawn");
    assertBound(h, provider, "observe");
    assert.deepEqual(h.desktopCalls, ["qa", "observe"]);
  });
  test(`${provider}: obsolete pending native spawn cannot publish its tool class`, async t => {
    const h = harness(t, provider, { hold: ["spawn"] });
    const oldStart = h.session.start(); await h.pump();
    assert.equal(h.spawns.length, 1);
    h.session.setMode("plan");
    const pending = send(h); await h.pump();
    assert.equal(h.spawns.length, 2);
    h.spawns[0].resolve(); await oldStart; await h.pump();
    assert.equal(h.userWrites.length, 0, "old spawn cannot issue work");
    h.spawns[1].resolve(); assert.equal(await pending, true); h.render();
    assertBound(h, provider, "observe");
    assert.equal(h.userWrites[0].process, h.spawns[1].id);
  });
  for (const boundary of ["submission pending", "issued before React render", "issued after render"]) {
    test(`${provider}: active tool class change is rejected (${boundary})`, async t => {
      const h = harness(t, provider); await h.ready();
      const pending = send(h);
      if (boundary !== "submission pending") assert.equal(await pending, true);
      if (boundary === "issued after render") h.render();
      h.session.setMode("plan");
      assert.equal(await pending, true); h.render();
      assert.equal(h.state.modeChoice, "ask");
      assert.equal(h.spawns.length, 1);
      assert.equal(h.desktopCalls.length, 1);
      assert.ok(h.state.items.some(item => item.kind === "notice" && /herramientas conectadas/.test(item.text)));
    });
  }
  test(`${provider}: immutable planner keeps observe and native planning after options and mode changes`, async t => {
    const h = harness(t, provider, { planningOnly: true, mode: "full" }); await h.ready();
    h.options.planningOnly = false; h.options.mode = "full"; h.render();
    h.session.setMode("full"); h.render();
    assert.equal(h.state.modeChoice, "plan"); assertBound(h, provider, "observe");
    assert.equal(await send(h), true);
    if (provider === "claude") {
      const flags = h.spawns[0].request.flags;
      assert.equal(flags[flags.indexOf("--permission-mode") + 1], "plan");
      assert.equal(flags.includes("--dangerously-skip-permissions"), false);
    } else {
      const thread = h.writes.find(write => write.method === "thread/start").params;
      assert.equal(thread.sandbox, "read-only"); assert.equal(thread.approvalPolicy, "on-request");
      const turn = h.userWrites.at(-1).params;
      assert.equal(turn.collaborationMode.mode, "plan"); assert.equal(turn.sandboxPolicy.type, "readOnly");
    }
  });
}

for (const planningOnly of [false, true]) {
  test(`codex: ${planningOnly ? "planner " : ""}native fork retains the bound desktop server and inbox`, async t => {
    const history = [{ id: "old-turn", status: "completed", items: [{ type: "userMessage", id: "old-user", content: [{ type: "text", text: "Original request" }] }] }];
    const h = harness(t, "codex", { conversationId: "original-thread", history, planningOnly }); await h.ready();
    const user = h.state.items.find(item => item.kind === "user"); assert.ok(user);
    await h.session.edit(user.id, "Edited tool request", [], []);
    assert.equal(h.writes.filter(write => write.method === "thread/fork").length, 1);
    assertBound(h, "codex", planningOnly ? "observe" : "qa");
    if (planningOnly) {
      const fork = h.writes.find(write => write.method === "thread/fork").params;
      assert.equal(fork.sandbox, "read-only"); assert.equal(fork.approvalPolicy, "on-request");
      assert.equal(h.userWrites.at(-1).params.collaborationMode.mode, "plan");
    }
    assert.equal(h.spawns.length, 1, "Codex forks within its existing app-server");
  });

  test(`claude: ${planningOnly ? "planner " : ""}native fork obtains the bound desktop MCP for the replacement process`, async t => {
    const h = harness(t, "claude", { planningOnly, api: { claudeRewindPoint: async () => "rewind-point" } }); await h.ready();
    assert.equal(await send(h), true); h.render();
    const user = h.state.items.find(item => item.kind === "user");
    h.line({ type: "system", subtype: "init", session_id: "original-claude" });
    h.complete(user.id); h.render();
    await h.session.edit(user.id, "Edited tool request", [], []);
    assert.equal(h.spawns.length, 2); assertBound(h, "claude", planningOnly ? "observe" : "qa");
    assert.ok(h.spawns[1].request.flags.includes("--fork-session"));
    if (planningOnly) {
      const flags = h.spawns[1].request.flags;
      assert.equal(flags[flags.indexOf("--permission-mode") + 1], "plan");
      assert.equal(flags.includes("--dangerously-skip-permissions"), false);
    }
    assert.equal(h.desktopCalls.length, 2);
  });
}

test("Trex model catalog retains input modalities without persisting catalog as transcript", async t => {
  const catalog = [
    { id: "vision", inputModalities: ["text", "image", 42, null], tools: [{ name: "PRIVATE_CATALOG_MARKER" }] },
    { id: "text-only", inputModalities: ["text"] }, { id: "unspecified" },
  ];
  const h = harness(t, "trex", { models: catalog }); await h.ready();
  const models = h.state.models;
  assert.deepEqual(models.find(model => model.value === "vision").inputModalities, ["text", "image"]);
  assert.deepEqual(models.find(model => model.value === "text-only").inputModalities, ["text"]);
  assert.equal(models.find(model => model.value === "unspecified").inputModalities, undefined);
  assert.doesNotMatch(JSON.stringify(h.state.items), /PRIVATE_CATALOG_MARKER/);
});

const components = await declarations("./queue-workflow-controls.test.mjs", [
  "host", "environment", "evaluate", "panelModule", "baseProps", "elements", "api",
]);

for (const [plannerProvider, executorProvider] of [["claude", "codex"], ["codex", "claude"]]) {
  test(`AgentRoom: ${plannerProvider} planner + ${executorProvider} executor pin independent contexts and enforce their tool classes`, async t => {
    const env = components.environment(), host = components.host(t);
    const { ChatPanel } = components.panelModule(env);
    const forbid = () => assert.fail("Runtime hooks must be mounted through the offline provider harness");
    const module = components.evaluate("room", env, { "../api": components.api, "./ChatView": { ChatPanel },
      "../hooks/useClaudeChat": { useClaudeChat: forbid }, "../hooks/useCodexChat": { useCodexChat: forbid },
      "../hooks/useAntigravityChat": { useAntigravityChat: forbid }, "../hooks/useTrexChat": { useTrexChat: forbid },
      "../hooks/useCoordination": { useCoordination: () => undefined } });
    const participant = (provider, mode) => ({ agent: { provider, profileId: provider, profileName: provider, model: null,
      effort: null, launch: { command: null, args: null, shell: "powershell", env: null } }, conversationId: null, mode });
    const props = { ...components.baseProps(), settings: { desktopEnabled: true },
      room: { id: "room-tools-client", active: "planner", phase: "idle", cycle: 1, order: [],
        planner: participant(plannerProvider, "plan"), executor: participant(executorProvider, executorProvider === "claude" ? "bypassPermissions" : "full") }, onRoomChange() {} };
    const render = input => host.render(() => module.default(input));
    const runtimes = tree => [...components.elements(tree)].filter(node => typeof node.type === "function" && node.props.options && node.props.role);
    const initial = runtimes(render(props));
    assert.equal(initial.length, 2);
    const planner = initial.find(node => node.props.role === "planner").props.options;
    const executor = initial.find(node => node.props.role === "executor").props.options;
    assert.notEqual(planner.chatLabel, executor.chatLabel);
    assert.equal(planner.desktopEnabled, true); assert.equal(executor.desktopEnabled, true);
    assert.equal(planner.mode, "plan"); assert.equal(planner.planningOnly, true);
    assert.equal(executor.mode, executorProvider === "claude" ? "bypassPermissions" : "full"); assert.equal(executor.planningOnly, false);
    assert.notEqual(planner.sessionId, executor.sessionId);
    const changed = runtimes(render({ ...props, settings: { desktopEnabled: false } }));
    for (const node of changed) assert.equal(node.props.options.desktopEnabled, true, "pinned to the original session settings");
    for (const [provider, options, mode] of [[plannerProvider, planner, "observe"], [executorProvider, executor, "full"]]) {
      const h = harness(t, provider, options); await h.ready();
      assertBound(h, provider, mode);
      assert.equal(await send(h), true);
    }
    t.after(() => env.timers.clear());
  });
}

const imageBytes = "OFFLINE_SECRET_BASE64_IMAGE_BYTES";
const artifact = { id: "opaque_Broker_id-7", sha256: "a".repeat(64), mimeType: "image/png", sizeBytes: 42,
  kind: "screenshot", storage: "broker", provenance: { projectId: "project", profile: "default" } };
const imageResult = { content: [{ type: "image", data: imageBytes, mimeType: "image/png" },
  { type: "text", text: JSON.stringify({ artifacts: [artifact] }) }], structuredContent: { artifacts: [artifact] } };

for (const provider of ["claude", "codex", "trex"]) {
  test(`${provider}: tool result becomes metadata with exact artifact id and no image bytes`, async t => {
    const h = harness(t, provider); await h.ready(); assert.equal(await send(h), true); h.render();
    if (provider === "claude") {
      h.line({ type: "assistant", uuid: "tool-message", message: { id: "tool-message", content: [
        { type: "tool_use", id: "desktop-tool", name: "mcp__trex_desktop__desktop_screenshot", input: {} }] } });
      h.line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "desktop-tool", content: imageResult.content }] } });
    } else if (provider === "codex") {
      h.line({ method: "item/completed", params: { threadId: h.conversation, turnId: h.turn,
        item: { type: "mcpToolCall", id: "desktop-tool", server: "trex_desktop", tool: "desktop_screenshot", arguments: {}, status: "completed", result: imageResult } } });
    } else {
      const messageId = h.userWrites.at(-1).params.messageId;
      const params = { sessionId: h.conversation, messageId, id: "desktop-tool" };
      h.line({ method: "tool/start", params: { ...params, toolName: "desktop_screenshot", input: {} } });
      // Trex CLI deliberately sends its sanitized artifact envelope to React.
      h.line({ method: "tool/result", params: { ...params, artifacts: [artifact], output: { text: "Screenshot captured", artifacts: [artifact] } } });
    }
    const item = h.state.items.find(item => item.kind === "tool" && item.id === "desktop-tool"); assert.ok(item);
    assert.equal(item.status, "done");
    assert.deepEqual(item.artifacts, [artifact]);
    assert.doesNotMatch(JSON.stringify(item), new RegExp(imageBytes));
  });
}

test("Claude planner may only look through Your browser: read tools allowed, actions denied", async t => {
  const read = [...browserModule.CHROME_READ_TOOLS];
  assert.deepEqual(read, ["tabs_list", "read_page", "screenshot", "wait_for"]);
  const actions = ["navigate", "click", "type", "fill_form", "select_option", "handle_dialog", "upload_file"];
  const h = harness(t, "claude", { planningOnly: true }); await h.ready();
  for (const tool of [...read, ...actions]) {
    const id = `permission-${tool}`;
    h.line({ type: "control_request", request_id: id, request: { subtype: "can_use_tool", tool_name: `mcp__trex_chrome__${tool}`, input: {} } });
    h.render();
    const item = h.state.items.find(item => item.kind === "permission" && item.id === id); assert.ok(item);
    if (read.includes(tool)) h.session.answer(item, true, false);
    await h.pump();
    const response = h.writes.find(write => write.type === "control_response" && write.response.request_id === id);
    assert.ok(response, `planner must resolve ${tool}`);
    assert.equal(response.response.response.behavior, read.includes(tool) ? "allow" : "deny", tool);
  }
});

for (const provider of ["claude", "codex"]) {
  test(`${provider}: same permission class keeps the existing process`, async t => {
    const h = harness(t, provider); await h.ready();
    h.session.setMode(provider === "claude" ? "acceptEdits" : "auto");
    assert.equal(await send(h), true); h.render();
    assert.equal(h.spawns.length, 1);
    assert.equal(h.desktopCalls.length, 1);
    assertBound(h, provider, "qa");
  });
  test(`${provider}: leaving observe for full rebuilds the immutable desktop server`, async t => {
    const h = harness(t, provider, { mode: "plan" }); await h.ready();
    assertBound(h, provider, "observe");
    h.session.setMode(provider === "claude" ? "bypassPermissions" : "full");
    assert.equal(await send(h), true); h.render();
    assert.equal(h.spawns.length, 2); assertBound(h, provider, "full");
  });
}

for (const permissionArgs of ["--permission-mode bypassPermissions", "--permission-mode=bypassPermissions --dangerously-skip-permissions"]) {
  test(`Claude: idle setMode(plan) overrides tool-bound profile permissions (${permissionArgs})`, async t => {
    const args = `--model offline-profile ${permissionArgs} --append-system-prompt "Keep this prompt"`;
    const h = harness(t, "claude", { args, mode: null }); await h.ready();
    assert.equal(h.spawns[0].request.flags[h.spawns[0].request.flags.indexOf("--permission-mode") + 1], "bypassPermissions", "the profile's native mode is carried into launch flags");
    assertBound(h, "claude", "full");
    h.session.setMode("plan");
    assert.equal(await send(h), true); h.render();
    assert.equal(h.spawns.length, 2);
    const launch = h.spawns[1].request;
    assert.doesNotMatch(launch.profileArgs ?? "", /--permission-mode|--dangerously-skip-permissions/);
    assert.match(launch.profileArgs, /--model offline-profile/);
    assert.match(launch.profileArgs, /--append-system-prompt "Keep this prompt"/);
    assert.equal(launch.flags[launch.flags.indexOf("--permission-mode") + 1], "plan", "native Claude and the immutable tool grant both enter plan");
    assertBound(h, "claude", "observe");
    assert.equal(h.writes.some(write => write.request?.subtype === "set_permission_mode"), false, "reconnect carries native permissions in launch flags");
  });
}

test("Claude: unbound mode change preserves profile arguments and uses native control without rebuilding", async t => {
  const args = '--permission-mode bypassPermissions --append-system-prompt "Keep this prompt"';
  const h = harness(t, "claude", { args, mode: null, desktopEnabled: false }); await h.ready();
  h.session.setMode("plan");
  assert.equal(await send(h), true); h.render();
  assert.equal(h.spawns.length, 1);
  assert.equal(h.spawns[0].request.profileArgs, args);
  assert.ok(h.writes.some(write => write.request?.subtype === "set_permission_mode" && write.request.mode === "plan"));
  assert.deepEqual(h.desktopCalls, []);
});

test("Claude: idle plan fork overrides the profile's bypass permission mode", async t => {
  const args = '--permission-mode bypassPermissions --append-system-prompt "Keep this prompt"';
  const h = harness(t, "claude", { args, mode: null, api: { claudeRewindPoint: async () => "rewind-before-mode-change" } });
  await h.ready(); assert.equal(await send(h), true); h.render();
  const original = h.state.items.find(item => item.kind === "user");
  h.line({ type: "system", subtype: "init", session_id: "claude-profile-conversation" });
  h.complete(original.id); h.render();
  h.session.setMode("plan");
  await h.session.edit(original.id, "Regenerate in native plan mode", [], []); h.render();
  assert.equal(h.spawns.length, 2);
  const launch = h.spawns[1].request;
  assert.ok(launch.flags.includes("--fork-session"));
  assert.doesNotMatch(launch.profileArgs, /--permission-mode|bypassPermissions/);
  assert.match(launch.profileArgs, /--append-system-prompt "Keep this prompt"/);
  assert.equal(launch.flags[launch.flags.indexOf("--permission-mode") + 1], "plan");
  assertBound(h, "claude", "observe");
});

for (const targetMode of ["plan", "auto"]) {
  test(`Codex: completed user turn can be edited after idle full -> ${targetMode}`, async t => {
    const h = harness(t, "codex", { mode: "full" }); await h.ready();
    assert.equal(await send(h), true); h.render();
    const original = h.state.items.find(item => item.kind === "user");
    const originalTurn = h.userWrites[0].params;
    assert.ok(original.providerTurnId);
    h.complete(h.turn); h.render();
    assert.equal(h.state.pendingTurns, 0);
    h.session.setMode(targetMode);
    // Deliberately retain the previous render's ready state and edit closure.
    await h.session.edit(original.id, "Regenerate after permission change", [], []);
    h.render();
    assert.equal(h.spawns.length, 2, "edit reopens the native app-server despite stale process=ready");
    const fork = h.writes.find(write => write.method === "thread/fork"); assert.ok(fork);
    assert.equal(fork.params.beforeTurnId, original.providerTurnId);
    assert.equal(fork.process, h.spawns[1].id);
    assertBound(h, "codex", targetMode === "plan" ? "observe" : "qa");
    const turns = h.writes.filter(write => write.method === "turn/start");
    assert.equal(turns.length, 2);
    assert.equal(turns[1].process, h.spawns[1].id);
    assert.notEqual(turns[1].params.threadId, originalTurn.threadId);
    assert.equal(h.state.items.some(item => item.kind === "user" && item.text === "Regenerate after permission change"), true);
  });
}

test("Codex: completed user turn edit in the same tool class reuses the app-server", async t => {
  const h = harness(t, "codex", { mode: "full" }); await h.ready();
  assert.equal(await send(h), true); h.render();
  const original = h.state.items.find(item => item.kind === "user");
  h.complete(h.turn); h.render();
  h.session.setMode("bypassPermissions");
  await h.session.edit(original.id, "Regenerate in the same tool class", [], []); h.render();
  assert.equal(h.spawns.length, 1);
  assert.equal(h.desktopCalls.length, 1);
  assert.equal(h.writes.filter(write => write.method === "thread/fork").length, 1);
  assertBound(h, "codex", "full");
});

for (const content of [
  JSON.stringify({ artifacts: [artifact] }),
  JSON.stringify({ structuredContent: { artifacts: [artifact] } }),
  [{ type: "text", text: JSON.stringify({ artifacts: [artifact] }) }],
]) {
  test(`Claude: tool_result ${typeof content === "string" ? content.includes("structuredContent") ? "structured JSON string" : "JSON string" : "text blocks"} retains tool artifacts`, async t => {
    const h = harness(t, "claude"); await h.ready();
    h.line({ type: "assistant", uuid: "artifact-call", message: { id: "artifact-call", content: [
      { type: "tool_use", id: "string-result", name: "mcp__trex_desktop__desktop_screenshot", input: {} }] } });
    h.line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "string-result", content }] } });
    const item = h.state.items.find(item => item.kind === "tool" && item.id === "string-result"); assert.ok(item);
    assert.equal(item.status, "done");
    assert.deepEqual(item.artifacts, [artifact]);
    assert.doesNotMatch(JSON.stringify(item.artifacts), new RegExp(imageBytes));
  });
}

test("Claude: ordinary, malformed, oversized and unrelated tool_result strings do not create artifact cards", async t => {
  const h = harness(t, "claude"); await h.ready();
  const inputs = [
    ["mcp__trex_desktop__desktop_status", "Ordinary tool output"],
    ["mcp__trex_desktop__desktop_status", '{"artifacts":'],
    ["mcp__trex_desktop__desktop_status", JSON.stringify({ artifacts: [artifact], padding: "x".repeat(262144) })],
    ["Read", JSON.stringify({ artifacts: [artifact] })],
  ];
  for (const [index, [name, content]] of inputs.entries()) {
    const id = `control-result-${index}`;
    h.line({ type: "assistant", uuid: id, message: { id, content: [{ type: "tool_use", id, name, input: {} }] } });
    h.line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content }] } });
    const item = h.state.items.find(item => item.kind === "tool" && item.id === id); assert.ok(item);
    assert.equal(item.status, "done");
    assert.deepEqual(item.artifacts ?? [], []);
  }
});

for (const [initialMode, reportedMode, expected] of [["bypassPermissions", "plan", "observe"], ["plan", "bypassPermissions", "full"]]) {
  for (const renderFirst of [false, true]) {
    test(`Claude: native status ${initialMode} -> ${reportedMode} retires its grant ${renderFirst ? "after render" : "before React render"}`, async t => {
      const h = harness(t, "claude", { mode: initialMode, conversationId: "native-status-conversation" }); await h.ready();
      const originalProcess = h.spawns[0].id;
      h.line({ type: "system", subtype: "status", permissionMode: reportedMode });
      assert.deepEqual(h.nativeKills, [originalProcess], "retire the exact process holding the obsolete MCP grant");
      if (renderFirst) h.render();
      assert.equal(await send(h), true); h.render();
      assert.equal(h.spawns.length, 2);
      assertBound(h, "claude", expected);
      const flags = h.spawns[1].request.flags;
      assert.equal(flags[flags.indexOf("--permission-mode") + 1], reportedMode);
      assert.equal(flags[flags.indexOf("--resume") + 1], "native-status-conversation");
      assert.equal(h.userWrites.length, 1);
      assert.equal(h.userWrites[0].process, h.spawns[1].id);
    });
  }
  test(`Claude: native init ${initialMode} -> ${reportedMode} replaces the immutable tool grant before render`, async t => {
    const h = harness(t, "claude", { mode: initialMode }); await h.ready();
    h.line({ type: "system", subtype: "init", session_id: "confirmed-native-session", permissionMode: reportedMode });
    assert.deepEqual(h.nativeKills, [h.spawns[0].id]);
    assert.equal(await send(h), true); h.render();
    assert.equal(h.spawns.length, 2);
    assertBound(h, "claude", expected);
    const flags = h.spawns[1].request.flags;
    assert.equal(flags[flags.indexOf("--permission-mode") + 1], reportedMode);
    assert.equal(h.userWrites[0].process, h.spawns[1].id);
  });
}

test("Claude: native class status cancels pending IPC and retires issued work before a new send", async t => {
  const h = harness(t, "claude", { mode: "bypassPermissions", hold: ["user-ipc"] }); await h.ready();
  const pending = send(h); await h.pump();
  const old = h.userWrites[0]; assert.ok(old);
  h.line({ type: "system", subtype: "status", permissionMode: "plan" });
  assert.deepEqual(h.nativeKills, [h.spawns[0].id]);
  assert.equal(await Promise.race([pending, flush().then(() => "still pending")]), false, "retirement settles local requests before native IPC returns");
  h.release("user-ipc");
  assert.equal(await send(h), true); h.render();
  assertBound(h, "claude", "observe");
  assert.equal(h.userWrites.length, 2);
  assert.equal(h.userWrites[1].process, h.spawns[1].id);
  h.resolveIpc(); await h.pump();
  assert.equal(h.state.pendingMessageIds.includes(old.uuid), false, "late old IPC cannot revive the retired turn");
});

for (const scenario of ["same-class", "unknown-mode", "unbound"]) {
  test(`Claude: native status control ${scenario} keeps the existing process`, async t => {
    const extra = scenario === "unbound" ? { desktopEnabled: false } : {};
    const h = harness(t, "claude", { mode: "default", ...extra }); await h.ready();
    const permissionMode = scenario === "same-class" ? "acceptEdits" : scenario === "unknown-mode" ? "unrecognized-native-mode" : "plan";
    h.line({ type: "system", subtype: "status", permissionMode });
    assert.equal(await send(h), true); h.render();
    assert.deepEqual(h.nativeKills, []);
    assert.equal(h.spawns.length, 1);
  });
}

for (const args of ["--permission-mode plan", '--permission-mode "plan"', "--permission-mode=plan"]) {
  test(`Claude: mode=null derives observe from actual profile option (${args})`, async t => {
    const h = harness(t, "claude", { mode: null, args }); await h.ready();
    assertBound(h, "claude", "observe");
    const launch = h.spawns[0].request;
    assert.equal(launch.flags[launch.flags.indexOf("--permission-mode") + 1], "plan");
    assert.equal(await send(h), true);
  });
}

test("Claude: explicit UI mode overrides the profile tool grant", async t => {
  const h = harness(t, "claude", { mode: "bypassPermissions", args: "--permission-mode plan" }); await h.ready();
  assertBound(h, "claude", "full");
  const flags = h.spawns[0].request.flags;
  assert.equal(flags[flags.indexOf("--permission-mode") + 1], "bypassPermissions");
  assert.equal(await send(h), true);
});

test("Claude: permission-looking quoted prompt text keeps the default tool class", async t => {
  const args = '--append-system-prompt "Literal --permission-mode plan"';
  const h = harness(t, "claude", { mode: null, args }); await h.ready();
  assertBound(h, "claude", "qa");
  assert.equal(h.spawns[0].request.profileArgs, args);
  assert.equal(await send(h), true);
});

test("Claude: quoted permission text cannot suppress an actual profile plan mode", async t => {
  const h = harness(t, "claude", { mode: null, args: '--append-system-prompt "Literal --permission-mode bypassPermissions" --permission-mode plan' });
  await h.ready();
  assertBound(h, "claude", "observe");
  const launch = h.spawns[0].request;
  assert.match(launch.profileArgs, /"Literal --permission-mode bypassPermissions"/);
  assert.equal(launch.flags[launch.flags.indexOf("--permission-mode") + 1], "plan");
  assert.equal(await send(h), true);
});

for (const [args, expected, sandbox] of [
  ["--sandbox read-only", "observe", "read-only"], ['--sandbox "read-only"', "observe", "read-only"],
  ["--sandbox=read-only", "observe", "read-only"], ["--sandbox danger-full-access", "full", "danger-full-access"],
  ["--sandbox workspace-write", "qa", "workspace-write"],
]) {
  test(`Codex: mode=null derives tool class from profile sandbox (${args})`, async t => {
    const h = harness(t, "codex", { mode: null, args }); await h.ready();
    assertBound(h, "codex", expected);
    assert.equal(h.writes.find(write => write.method === "thread/start").params.sandbox, sandbox);
    assert.equal(await send(h), true);
  });
}

test("Codex: quoted configuration text is not a sandbox option", async t => {
  const h = harness(t, "codex", { mode: null, args: '--config \'note="--sandbox read-only"\'' }); await h.ready();
  assertBound(h, "codex", "qa");
  assert.equal(h.writes.find(write => write.method === "thread/start").params.sandbox, undefined);
  const flags = h.spawns[0].request.flags;
  assert.equal(flags[0], "app-server");
  assert.equal(flags[flags.indexOf("-c") + 1], 'note="--sandbox read-only"');
  assert.equal(await send(h), true);
});

test("Codex: explicit UI full mode overrides the profile-derived tool class", async t => {
  const h = harness(t, "codex", { mode: "full", args: "--sandbox read-only" }); await h.ready();
  assertBound(h, "codex", "full");
  assert.equal(await send(h), true);
  assert.equal(h.userWrites[0].params.sandboxPolicy.type, "dangerFullAccess");
});

for (const toolsBound of [true, false]) {
  test(`Claude: ${toolsBound ? "bound tools wait for" : "an unbound chat does not wait for"} native initialize before the first user message`, async t => {
    const h = harness(t, "claude", { mode: "bypassPermissions", hold: ["initialize"], ...(toolsBound ? {} : { desktopEnabled: false }) });
    const pending = send(h); await h.pump();
    const initialize = h.writes.find(write => write.request?.subtype === "initialize"); assert.ok(initialize);
    if (toolsBound) {
      assert.equal(h.userWrites.length, 0);
      assert.equal(await Promise.race([pending, flush().then(() => "still pending")]), "still pending");
      h.controlResponse(initialize);
    }
    assert.equal(await pending, true);
    assert.equal(h.userWrites.length, 1);
    assert.deepEqual(h.nativeKills, []);
  });
}

test("Claude: initialize grant mismatch retires the process before user IPC and retries with confirmed permissions", async t => {
  const h = harness(t, "claude", { mode: "bypassPermissions", args: "--restricted", initializeMode: "default" });
  assert.equal(await send(h), false); h.render();
  assert.equal(h.userWrites.length, 0);
  assert.deepEqual(h.nativeKills, [h.spawns[0].id]);
  assertBound(h, "claude", "full");
  assert.equal(await send(h), true); h.render();
  assert.equal(h.spawns.length, 2);
  assertBound(h, "claude", "qa");
  const launch = h.spawns[1].request;
  assert.equal(launch.flags[launch.flags.indexOf("--permission-mode") + 1], "default");
  assert.equal(h.userWrites.length, 1);
  assert.equal(h.userWrites[0].process, h.spawns[1].id);
});

test("Claude: initialize rejection fails tool-bound startup without sending a user message", async t => {
  const h = harness(t, "claude", { mode: "bypassPermissions", hold: ["initialize"] });
  const pending = send(h); await h.pump();
  const initialize = h.writes.find(write => write.request?.subtype === "initialize"); assert.ok(initialize);
  h.controlResponse(initialize, "Offline native initialization rejection");
  assert.equal(await pending, false); h.render();
  assert.equal(h.userWrites.length, 0);
  assert.ok(h.state.items.some(item => item.kind === "notice" && /Offline native initialization rejection/.test(item.text)));
});

test("Claude: retired initialize response cannot replace the newer explicit permission intent", async t => {
  const h = harness(t, "claude", { mode: "bypassPermissions", hold: ["initialize"] });
  const oldStart = h.session.start(); await h.pump();
  const oldInitialize = h.writes.find(write => write.request?.subtype === "initialize"); assert.ok(oldInitialize);
  assert.equal(h.userWrites.length, 0);
  h.session.setMode("plan");
  // This reply arrives after retirement, while native useAgentProcess still
  // identifies the old process and before a replacement has started.
  h.controlResponse(oldInitialize);
  await oldStart;
  assert.deepEqual(h.nativeKills, [], "obsolete acknowledgements cannot retire or rewrite the new intent");
  h.release("initialize");
  assert.equal(await send(h), true); h.render();
  assert.equal(h.spawns.length, 2);
  assertBound(h, "claude", "observe");
  const flags = h.spawns[1].request.flags;
  assert.equal(flags[flags.indexOf("--permission-mode") + 1], "plan");
  assert.equal(h.userWrites.length, 1);
  assert.equal(h.userWrites[0].process, h.spawns[1].id);
});

for (const initializeMode of [undefined, null, "unknown-native-mode"]) {
  test(`Claude: bound tools reject ${initializeMode === undefined ? "missing" : String(initializeMode)} native permission confirmation`, async t => {
    const h = harness(t, "claude", { mode: "bypassPermissions", initializeMode });
    assert.equal(await send(h), false, "an immutable tool grant requires a recognized native permission acknowledgement");
    h.render();
    assert.equal(h.userWrites.length, 0);
    assert.ok(h.state.items.some(item => item.kind === "notice" && item.tone === "error"));
  });
}

for (const provider of ["claude", "codex"]) {
  for (const toolOutput of [true, false]) {
    test(`${provider}: serialized MCP image output ${toolOutput ? "scrubs tool image bytes" : "preserves other servers' text"}`, async t => {
      const h = harness(t, provider); await h.ready();
      const envelope = JSON.stringify({ content: [{ type: "image", data: imageBytes, mimeType: "image/png" },
        { type: "text", text: "Human screenshot explanation" }], artifacts: [artifact] });
      if (provider === "claude") {
        h.line({ type: "assistant", uuid: "serialized-image", message: { id: "serialized-image", content: [
          { type: "tool_use", id: "serialized-image", name: toolOutput ? "mcp__trex_desktop__desktop_screenshot" : "mcp__another_server__inspect", input: {} }] } });
        h.line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "serialized-image", content: envelope }] } });
      } else {
        h.line({ method: "item/completed", params: { threadId: h.conversation, item: { type: "mcpToolCall", id: "serialized-image",
          server: toolOutput ? "trex_desktop" : "another_server", tool: "desktop_screenshot", arguments: {}, status: "completed",
          result: { content: [{ type: "text", text: envelope }] } } } });
      }
      const item = h.state.items.find(item => item.kind === "tool" && item.id === "serialized-image"); assert.ok(item);
      assert.match(item.output, /Human screenshot explanation/);
      if (toolOutput) {
        assert.deepEqual(item.artifacts, [artifact]);
        assert.doesNotMatch(item.output, new RegExp(imageBytes));
        assert.doesNotMatch(JSON.stringify(item), new RegExp(imageBytes));
      } else {
        assert.equal(item.output, envelope);
        assert.deepEqual(item.artifacts ?? [], []);
      }
    });
  }
}

for (const [initialMode, reportedMode] of [["bypassPermissions", "plan"], ["plan", "bypassPermissions"]]) {
  test(`Claude: unbound native ${initialMode} -> ${reportedMode} survives process restart`, async t => {
    const h = harness(t, "claude", { mode: initialMode, desktopEnabled: false }); await h.ready();
    h.line({ type: "system", subtype: "status", permissionMode: reportedMode }); h.render();
    assert.equal(h.state.modeChoice, reportedMode);
    h.exit(); h.render(); await h.ready();
    const flags = h.spawns[1].request.flags;
    assert.equal(flags[flags.indexOf("--permission-mode") + 1], reportedMode, "native status remains the launch choice when no tool is bound");
    assert.deepEqual(h.desktopCalls, []);
    assert.deepEqual(h.nativeKills, []);
    assert.equal(await send(h), true);
  });
}

for (const availability of ["unbound"]) {
  for (const renderFirst of [false, true]) {
    test(`Claude: ${availability} chat preserves active native mode changes ${renderFirst ? "after render" : "before render"}`, async t => {
      const extra = { desktopEnabled: false };
      const h = harness(t, "claude", { mode: "default", ...extra }); await h.ready();
      assert.equal(await send(h), true);
      if (renderFirst) h.render();
      const original = h.userWrites[0];
      h.session.setMode("bypassPermissions"); await h.pump();
      assert.equal(h.state.modeChoice, "bypassPermissions", "settings alone do not impose grant restrictions on native sessions");
      assert.ok(h.writes.some(write => write.request?.subtype === "set_permission_mode" && write.request.mode === "bypassPermissions"));
      assert.equal(h.state.pendingMessageIds.includes(original.uuid), true);
      assert.equal(h.spawns.length, 1);
      assert.deepEqual(h.nativeKills, []);
      assert.equal(h.desktopCalls.length, 0);
      assert.equal(h.state.items.some(item => item.kind === "notice" && /Detén la respuesta.*herramientas conectadas/.test(item.text)), false);
    });
  }
}

test("Claude: old initialize acknowledgement cannot replace a newer confirmed choice in the same QA class", async t => {
  const h = harness(t, "claude", { mode: "acceptEdits", hold: ["initialize"] });
  const startup = h.session.start(); await h.pump();
  const initialize = h.writes.find(write => write.request?.subtype === "initialize"); assert.ok(initialize);
  h.session.setMode("default"); await h.pump();
  assert.ok(h.writes.some(write => write.request?.subtype === "set_permission_mode" && write.request.mode === "default"));
  h.line({ type: "system", subtype: "status", permissionMode: "default" }); h.render();
  assert.equal(h.state.modeChoice, "default");
  h.controlResponse(initialize); await startup; h.render();
  assert.equal(h.state.modeChoice, "default");
  assert.equal(h.state.permissionMode, "default");
  h.release("initialize"); await h.ready();
  const flags = h.spawns[1].request.flags;
  assert.equal(flags[flags.indexOf("--permission-mode") + 1], "default", "the late acceptEdits acknowledgement cannot rewrite the next native launch");
  assertBound(h, "claude", "qa");
  assert.deepEqual(h.nativeKills, []);
});

test("Claude: current initialize acknowledgement still selects the effective native mode within QA", async t => {
  const h = harness(t, "claude", { mode: "default", initializeModes: ["acceptEdits", "acceptEdits"] }); await h.ready();
  await h.ready();
  const flags = h.spawns[1].request.flags;
  assert.equal(flags[flags.indexOf("--permission-mode") + 1], "acceptEdits");
  assertBound(h, "claude", "qa");
  assert.deepEqual(h.nativeKills, []);
});

for (const renderFirst of [false, true]) {
  test(`Claude: stale mode rejection preserves a newer plan selection ${renderFirst ? "after render" : "before render"}`, async t => {
    const h = harness(t, "claude", { mode: "default" }); await h.ready();
    h.hold("set_permission_mode"); h.session.setMode("acceptEdits"); await h.pump();
    const older = h.writes.find(write => write.request?.subtype === "set_permission_mode"); assert.ok(older);
    h.session.setMode("plan");
    if (renderFirst) h.render();
    h.controlResponse(older, "Older native mode request rejected"); h.render();
    assert.equal(h.state.modeChoice, "plan", "a failed older request cannot roll back the newer explicit choice");
    assert.equal(h.state.permissionMode, "plan");
    assert.equal(await send(h), true); h.render();
    const flags = h.spawns[1].request.flags;
    assert.equal(flags[flags.indexOf("--permission-mode") + 1], "plan");
    assertBound(h, "claude", "observe");
  });
}

test("Claude: current mode rejection still restores the prior native and tool choice", async t => {
  const h = harness(t, "claude", { mode: "default" }); await h.ready();
  h.hold("set_permission_mode"); h.session.setMode("acceptEdits"); await h.pump();
  const current = h.writes.find(write => write.request?.subtype === "set_permission_mode"); assert.ok(current);
  h.controlResponse(current, "Current native mode rejected"); h.render();
  assert.equal(h.state.modeChoice, "default");
  assert.equal(h.state.permissionMode, "default");
  assert.ok(h.state.items.some(item => item.kind === "notice" && /Current native mode rejected/.test(item.text)));
  await h.ready();
  const flags = h.spawns[1].request.flags;
  assert.equal(flags[flags.indexOf("--permission-mode") + 1], "default");
  assertBound(h, "claude", "qa");
});

for (const provider of ["claude", "codex"]) test(`${provider}: desktop MCP binds to permission mode and reconnects for planning`, async t => {
  const calls = [];
  const h = harness(t, provider, {
    desktopEnabled: true,
    api: { trexDesktopMcpConfig: async mode => { calls.push(mode); return { command: "C:\\Trex\\trex-agent.exe", args: ["desktop-mcp", "--mode", mode === "observe" ? "plan" : "full"] }; } },
    mcpStatus: { data: [{ name: "trex_desktop", runtimeStatus: "connected", tools: Object.fromEntries(["desktop_screenshot", "desktop_status", "desktop_monitors", "desktop_wait", "desktop_click", "desktop_move", "desktop_drag", "desktop_scroll", "desktop_type", "desktop_key", "desktop_actions"].map(name => [name, { name }])) }] },
  });
  await h.ready();
  assert.deepEqual(calls, ["qa"]);
  if (provider === "claude") {
    const flags=h.spawns[0].request.flags, config=JSON.parse(flags[flags.indexOf("--mcp-config")+1]);
    assert.deepEqual(config.mcpServers.trex_desktop.args, ["desktop-mcp", "--mode", "full"]);
  } else {
    const config=h.writes.find(write => write.method === "thread/start").params.config;
    assert.equal(config["mcp_servers.trex_desktop.required"], true);
    assert.equal(config["mcp_servers.trex_desktop.default_tools_approval_mode"], "prompt");
    assert.ok(h.writes.some(write => write.method === "mcpServerStatus/list" && write.params.serverName === "trex_desktop"));
  }
  if (provider === "codex") for (const name of ["desktop_click", "desktop_move", "desktop_drag", "desktop_scroll", "desktop_type", "desktop_key", "desktop_actions"]) delete h.options.mcpStatus.data[0].tools[name];
  h.session.setMode("plan");
  assert.equal(await send(h), true);
  assert.deepEqual(calls, ["qa", "observe"]);
  assert.equal(h.spawns.length, 2);
  if (provider === "claude") {
    const flags=h.spawns[1].request.flags, config=JSON.parse(flags[flags.indexOf("--mcp-config")+1]);
    assert.deepEqual(config.mcpServers.trex_desktop.args, ["desktop-mcp", "--mode", "plan"]);
  } else {
    const config=h.writes.filter(write => ["thread/start", "thread/resume"].includes(write.method)).at(-1).params.config;
    assert.deepEqual(config["mcp_servers.trex_desktop.args"], ["desktop-mcp", "--mode", "plan"]);
  }
});

for (const provider of ["claude", "codex"]) test(`${provider}: desktop screenshot bytes are not exposed in the chat transcript`, async t => {
  const h=harness(t,provider); await h.ready(); assert.equal(await send(h),true); h.render();
  if (provider === "claude") {
    h.line({ type:"assistant",uuid:"desktop-message",message:{id:"desktop-message",content:[{type:"tool_use",id:"desktop-tool",name:"mcp__trex_desktop__desktop_screenshot",input:{}}]}});
    h.line({type:"user",message:{content:[{type:"tool_result",tool_use_id:"desktop-tool",content:imageResult.content}]}});
  } else {
    h.line({method:"item/completed",params:{threadId:h.conversation,turnId:h.turn,item:{type:"mcpToolCall",id:"desktop-tool",server:"trex_desktop",tool:"desktop_screenshot",arguments:{},status:"completed",result:imageResult}}});
  }
  const item=h.state.items.find(item=>item.kind==="tool"&&item.id==="desktop-tool");
  assert.ok(item); assert.doesNotMatch(JSON.stringify(item),new RegExp(imageBytes));
});

test("Codex planner refuses a desktop server that advertises input tools", async t => {
  const h = harness(t, "codex", { desktopEnabled: true, planningOnly: true,
    api: { trexDesktopMcpConfig: async () => ({ command: "trex-agent", args: ["desktop-mcp", "--mode", "plan"] }) },
    mcpStatus: { data: [{ name: "trex_desktop", runtimeStatus: "connected", tools: { desktop_screenshot: {}, desktop_click: {} } }] },
  });
  assert.equal(await send(h), false);
  assert.equal(h.userWrites.length, 0);
});

test("Claude planner refuses a desktop server that advertises input tools", async t => {
  const h=harness(t,"claude",{desktopEnabled:true,planningOnly:true,
    api:{trexDesktopMcpConfig:async()=>({command:"trex-agent",args:["desktop-mcp","--mode","plan"]})},
    desktopStatus:{mcpServers:[{name:"trex_desktop",status:"connected",serverInfo:{name:"trex-desktop"},config:{command:"trex-agent",args:["desktop-mcp","--mode","plan"]},tools:[{name:"desktop_screenshot"},{name:"desktop_click"}]}]},
  });
  assert.equal(await send(h),false);
  assert.equal(h.userWrites.length,0);
  assert.equal(h.nativeKills.length,1);
});

test("Claude refuses a desktop server from an unexpected executable", async t => {
  const names=["desktop_screenshot","desktop_click","desktop_drag","desktop_scroll","desktop_type","desktop_key"];
  const h=harness(t,"claude",{desktopEnabled:true,
    api:{trexDesktopMcpConfig:async()=>({command:"trusted-agent",args:["desktop-mcp","--mode","full"]})},
    desktopStatus:{mcpServers:[{name:"trex_desktop",status:"connected",serverInfo:{name:"trex-desktop"},config:{command:"different-agent",args:["desktop-mcp","--mode","full"]},tools:names.map(name=>({name}))}]},
  });
  assert.equal(await send(h),false);
  assert.equal(h.userWrites.length,0);
  assert.equal(h.nativeKills.length,1);
});

for (const provider of ["claude", "codex"]) test(`${provider}: planner rejects pointer movement even when all observation tools are present`, async t => {
  const names=["desktop_screenshot","desktop_status","desktop_monitors","desktop_wait","desktop_move"];
  const config={command:"trusted-agent",args:["desktop-mcp","--mode","plan"]};
  const h=harness(t,provider,{desktopEnabled:true,planningOnly:true,
    api:{trexDesktopMcpConfig:async()=>config},
    desktopStatus:{mcpServers:[{name:"trex_desktop",status:"connected",serverInfo:{name:"trex-desktop"},config,tools:names.map(name=>({name}))}]},
    mcpStatus:{data:[{name:"trex_desktop",runtimeStatus:"connected",tools:Object.fromEntries(names.map(name=>[name,{name}]))}]},
  });
  assert.equal(await send(h),false);
  assert.equal(h.userWrites.length,0);
});

const A11Y_READ = ["a11y_snapshot", "a11y_find", "a11y_get", "a11y_is", "a11y_list_windows", "a11y_list_apps", "a11y_list_displays", "a11y_list_surfaces", "a11y_wait", "a11y_status", "a11y_skills_get"];
const A11Y_ACTIONS = ["a11y_click", "a11y_set_value", "a11y_toggle", "a11y_expand", "a11y_select", "a11y_scroll", "a11y_scroll_to", "a11y_launch", "a11y_window", "a11y_batch", "a11y_press"];
const a11yInstructions = (provider, h) => provider === "claude"
  ? (flags => flags[flags.indexOf("--append-system-prompt") + 1])(h.spawns.at(-1).request.flags)
  : h.writes.filter(write => ["thread/start", "thread/resume"].includes(write.method)).at(-1).params.developerInstructions;

for (const provider of ["claude", "codex"]) test(`${provider}: accessibility gateway binds to the permission mode and restarts for planning`, async t => {
  const calls = [];
  const h = harness(t, provider, {
    desktopEnabled: false, a11yEnabled: true,
    accessibility: { accessibilityServer: async mode => { calls.push(mode); return { command: "C:\Trex\trex-agent.exe", args: ["a11y-mcp", "--mode", mode === "observe" ? "plan" : "full"] }; } },
    mcpStatus: { data: [{ name: "trex_a11y", runtimeStatus: "connected", tools: Object.fromEntries([...A11Y_READ, ...A11Y_ACTIONS].map(name => [name, { name }])) }] },
  });
  await h.ready();
  assert.deepEqual(calls, ["qa"]);
  assert.match(a11yInstructions(provider, h), /Accessibility control \(experimental\)/);
  if (provider === "claude") {
    const flags = h.spawns[0].request.flags, config = JSON.parse(flags[flags.indexOf("--mcp-config") + 1]);
    assert.deepEqual(config.mcpServers.trex_a11y.args, ["a11y-mcp", "--mode", "full"]);
    assert.equal(config.mcpServers.trex_desktop, undefined, "it does not replace or enable computer control");
  } else {
    const config = h.writes.find(write => write.method === "thread/start").params.config;
    assert.deepEqual(config["mcp_servers.trex_a11y.args"], ["a11y-mcp", "--mode", "full"]);
    assert.equal(config["mcp_servers.trex_a11y.default_tools_approval_mode"], "prompt");
    assert.equal(config["mcp_servers.trex_desktop.enabled"], undefined);
    assert.ok(h.writes.some(write => write.method === "mcpServerStatus/list" && write.params.serverName === "trex_a11y"));
    for (const name of A11Y_ACTIONS) delete h.options.mcpStatus.data[0].tools[name];
  }
  h.session.setMode("plan");
  assert.equal(await send(h), true);
  assert.deepEqual(calls, ["qa", "observe"]);
  assert.equal(h.spawns.length, 2);
  if (provider === "claude") {
    const flags = h.spawns[1].request.flags, config = JSON.parse(flags[flags.indexOf("--mcp-config") + 1]);
    assert.deepEqual(config.mcpServers.trex_a11y.args, ["a11y-mcp", "--mode", "plan"]);
  } else {
    const config = h.writes.filter(write => ["thread/start", "thread/resume"].includes(write.method)).at(-1).params.config;
    assert.deepEqual(config["mcp_servers.trex_a11y.args"], ["a11y-mcp", "--mode", "plan"]);
  }
});

for (const provider of ["claude", "codex"]) test(`${provider}: where the accessibility engine cannot run the chat starts without it and says why`, async t => {
  const h = harness(t, provider, {
    desktopEnabled: false, a11yEnabled: true,
    accessibility: { accessibilityServer: async (_mode, warn) => { warn("El control por accesibilidad (experimental) no se activó en este chat: El control por accesibilidad solo está disponible en Windows."); return null; } },
  });
  await h.ready();
  assert.equal(await send(h), true);
  assert.doesNotMatch(a11yInstructions(provider, h) ?? "", /Accessibility control/);
  if (provider === "claude") {
    const flags = h.spawns[0].request.flags, index = flags.indexOf("--mcp-config");
    assert.ok(index < 0 || !JSON.parse(flags[index + 1]).mcpServers.trex_a11y);
  } else {
    assert.equal(h.writes.find(write => write.method === "thread/start").params.config["mcp_servers.trex_a11y.enabled"], undefined);
  }
  assert.ok(h.state.items.some(item => item.kind === "notice" && /solo está disponible en Windows/.test(item.text)));
});

// ---- Blender, HyperFrames and the other applications (trex_apps) ----
const { appToolsFor } = dependencies["../apps"];
const appsInstructions = a11yInstructions;
const appsServerFor = calls => async (mode, folder, apps) => {
  calls.push([mode, folder, apps]);
  return { command: "C:\\Trex\\trex-agent.exe", args: ["apps-mcp", "--mode", mode === "observe" ? "plan" : "full", "--cwd", folder, "--apps", apps.join(",")] };
};
const inventory = apps => { const tools = appToolsFor(apps); return { read: tools.read, action: tools.action, all: [...tools.read, ...tools.action] }; };
for (const apps of [["blender"], ["hyperframes"], ["github"], ["blender", "hyperframes", "github"]]) for (const provider of ["claude", "codex"]) test(`${provider}: ${apps.join(" + ")} tools bind to the permission mode, reads never prompt and planning restarts read-only`, async t => {
  const calls = [], tools = inventory(apps);
  const h = harness(t, provider, {
    desktopEnabled: false,
    apps: { appsWanted: () => apps, appsServer: appsServerFor(calls) },
    mcpStatus: { data: [{ name: "trex_apps", runtimeStatus: "connected", tools: Object.fromEntries(tools.all.map(name => [name, { name }])) }] },
  });
  await h.ready();
  assert.deepEqual(calls, [["qa", cwd, apps]], "the folder, the permission class and the applications are fixed at start");
  const text = appsInstructions(provider, h);
  for (const app of apps) assert.match(text, provider === "claude" ? new RegExp(`trex_apps MCP tools \\(${app}_\\*\\)`) : new RegExp(`connected trex_apps MCP tools \\(${app}_\\*\\)`), `${provider} is told about ${app}`);
  for (const other of ["blender", "hyperframes", "github"].filter(app => !apps.includes(app))) assert.doesNotMatch(text, new RegExp(`trex_apps MCP tools \\(${other}_\\*\\)`), `${other} is not announced as served`);
  if (apps.includes("blender")) assert.doesNotMatch(text, /not an open window/, "the headless-only sentence is replaced");
  else assert.match(text, /not an open window/, "Blender is enabled but not served: it keeps the CLI advice instead of a promise of tools");
  const expectedArgs = (mode) => ["apps-mcp", "--mode", mode, "--cwd", cwd, "--apps", apps.join(",")];
  if (provider === "claude") {
    const flags = h.spawns[0].request.flags, config = JSON.parse(flags[flags.indexOf("--mcp-config") + 1]);
    assert.deepEqual(config.mcpServers.trex_apps.args, expectedArgs("full"));
    const allowed = flags.filter((flag, i) => flags[i - 1] === "--allowedTools").join(",");
    for (const name of tools.read) assert.ok(allowed.includes(`mcp__trex_apps__${name}`), `${name} is pre-approved`);
    for (const name of tools.action) assert.ok(!allowed.includes(name), `${name} still goes through the permission prompt`);
  } else {
    const config = h.writes.find(write => write.method === "thread/start").params.config;
    assert.deepEqual(config["mcp_servers.trex_apps.args"], expectedArgs("full"));
    assert.equal(config["mcp_servers.trex_apps.default_tools_approval_mode"], "writes", "only tools that change something ask");
    assert.equal(config["mcp_servers.trex_apps.required"], true);
    assert.ok(h.writes.some(write => write.method === "mcpServerStatus/list" && write.params.serverName === "trex_apps"));
    for (const name of tools.action) delete h.options.mcpStatus.data[0].tools[name];
  }
  h.session.setMode("plan");
  assert.equal(await send(h), true);
  assert.deepEqual(calls, [["qa", cwd, apps], ["observe", cwd, apps]]);
  assert.equal(h.spawns.length, 2, "a change of permission class replaces the session, as for the desktop");
  if (provider === "claude") {
    const flags = h.spawns[1].request.flags, config = JSON.parse(flags[flags.indexOf("--mcp-config") + 1]);
    assert.deepEqual(config.mcpServers.trex_apps.args, expectedArgs("plan"));
  } else {
    const config = h.writes.filter(write => ["thread/start", "thread/resume"].includes(write.method)).at(-1).params.config;
    assert.deepEqual(config["mcp_servers.trex_apps.args"], expectedArgs("plan"));
  }
});

for (const provider of ["claude", "codex"]) test(`${provider}: where the CLI cannot serve applications the chat starts without them and says why`, async t => {
  const h = harness(t, provider, {
    desktopEnabled: false,
    apps: { appsWanted: () => ["blender", "hyperframes"], appsServer: async (_mode, _cwd, _apps, warn) => { warn("Las aplicaciones (Blender, HyperFrames) no se activaron en este chat: Actualiza Trex CLI para controlar aplicaciones."); return null; } },
  });
  await h.ready();
  assert.equal(await send(h), true);
  assert.doesNotMatch(appsInstructions(provider, h) ?? "", /trex_apps/, "no tools, so no promise of tools");
  if (provider === "claude") {
    const flags = h.spawns[0].request.flags, index = flags.indexOf("--mcp-config");
    assert.ok(index < 0 || !JSON.parse(flags[index + 1]).mcpServers.trex_apps);
  } else {
    assert.equal(h.writes.find(write => write.method === "thread/start").params.config["mcp_servers.trex_apps.enabled"], undefined);
  }
  assert.ok(h.state.items.some(item => item.kind === "notice" && /Actualiza Trex CLI/.test(item.text)));
});

test("claude: with every application off or known to be missing, no apps server is requested", async t => {
  let asked = 0;
  const h = harness(t, "claude", { desktopEnabled: false, apps: { appsServer: async () => { asked++; return null; } } });
  await h.ready();
  assert.equal(asked, 0, "the neutral default (no application wanted) never reaches the server");
});
