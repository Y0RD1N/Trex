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

// Extend only the test boundary: native browser discovery and supported fake RPC
// replies. Every provider hook, reducer and browser adapter is production code.
const base = await declarations("./queue-send-now.test.mjs", ["harness", "flush", "deferred", "dependencies"], body => {
  const replacements = [
    ['"../browserConnection": { connectBrowser: () => assert.fail("Unexpected browser discovery in a browser-disabled session") },',
      '"../browserConnection": extra.browserConnection ?? { connectBrowser: () => assert.fail("Unexpected browser discovery in a browser-disabled session") },'],
    ['claudeRewindPoint: async () => null },', 'claudeRewindPoint: async () => null, ...extra.api },'],
    ['extra.planningOnly ? "plan" : "default", commands:',
      'extra.nativePermissionMode ? extra.nativePermissionMode(spawns.find(spawn => spawn.id === request.process)?.request, request) : (extra.planningOnly ? "plan" : "default"), commands:'],
    ['response: { current_permission_mode:', `response: request.request?.subtype === "mcp_status" ? (() => {
      if (extra.desktopStatus) return extra.desktopStatus;
      const flags=spawns.find(spawn=>spawn.id===request.process)?.request.flags ?? [], i=flags.indexOf("--mcp-config");
      const config=i>=0?JSON.parse(flags[i+1]).mcpServers.trex_desktop:null;
      const mode=config?.args?.at(-1);
      const read=["desktop_screenshot","desktop_status","desktop_monitors","desktop_wait"];
      const names=mode==="plan"?read:[...read,"desktop_click","desktop_move","desktop_drag","desktop_scroll","desktop_type","desktop_key","desktop_actions"];
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
const connectionSource = await readFile(new URL("../src/browserConnection.ts", import.meta.url), "utf8");
const connectionCode = ts.transpileModule(connectionSource, { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
} }).outputText;
const browser = Object.freeze({ enabled: true, profile: "BROWSER17", clientId: "room-browser-client" });
const cwd = "D:/projects/trex";
const inbox = { "mcp_servers.trex_inbox.command": "offline-inbox", "mcp_servers.trex_inbox.args": ["--session", "tab"] };

function harness(t, provider, extra = {}) {
  const calls = [], nativeKills = [], status = extra.status ?? { installed: true, ready: true, compatible: true };
  const native = {
    async trexBrowserStatus() { calls.push({ method: "status" }); return typeof status === "function" ? status() : status; },
    async trexBrowserResolveSpace(_cwd, options) {
      calls.push({method:"space",clientId:options.clientId});
      return {enabled:options.enabled,clientId:options.clientId,profile:options.clientId.endsWith("-planner")?"BROWSER2":options.clientId.endsWith("-executor")?"BROWSER3":"BROWSER4"};
    },
    async trexBrowserMcpConfig(...args) {
      calls.push({ method: "config", args });
      if (extra.configWait) await extra.configWait.promise;
      return { command: "C:\\Trex Browser\\trex-browser.exe", args: ["mcp", "--cwd", args[0], "--mode", args[1], "--client-id", args[2], "--profile", args[3]] };
    },
  };
  const exports = {};
  new Function("require", "exports", connectionCode)(name => {
    if (name === "./api") return native;
    if (name === "./browser") return browserModule;
    assert.fail(`Unexpected browser adapter import: ${name}`);
  }, exports);
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
  const h = base.harness(t, provider, { browser, resumeRequestedThread: provider === "codex", ...extra, browserConnection: exports, nativeThread,
    nativePermissionMode: (launch, request) => {
      if (Object.hasOwn(extra, "initializeMode")) return extra.initializeMode;
      if (extra.initializeModes) return extra.initializeModes[h.spawns.findIndex(spawn => spawn.id === request.process)];
      const offset = launch?.flags.lastIndexOf("--permission-mode") ?? -1;
      return offset >= 0 ? launch.flags[offset + 1]
        : dependencies["../workflowSafety"].claudeProfilePermissionMode(launch?.profileArgs ?? null, launch?.shell !== "wsl") ?? "default";
    },
    api: { messageQueueMcpConfig: async () => inbox, agentKill: async procId => { nativeKills.push(procId); }, trexBrowserResolveSpace:native.trexBrowserResolveSpace, ...extra.api } });
  return Object.assign(h, { browserCalls: calls, nativeKills });
}

function browserConfig(h, provider, index = -1) {
  if (provider === "claude") {
    const flags = h.spawns.at(index).request.flags, offset = flags.indexOf("--mcp-config");
    assert.ok(offset >= 0, "Claude receives external MCP configuration");
    return JSON.parse(flags[offset + 1]).mcpServers.trex_browser;
  }
  const config = h.writes.filter(write => ["thread/start", "thread/resume", "thread/fork"].includes(write.method)).at(index).params.config;
  assert.equal(config["mcp_servers.trex_browser.enabled"], true);
  assert.equal(config["mcp_servers.trex_inbox.command"], inbox["mcp_servers.trex_inbox.command"], "browser preserves the existing inbox server");
  return { command: config["mcp_servers.trex_browser.command"], args: config["mcp_servers.trex_browser.args"] };
}
function assertBrowser(h, provider, mode, index = -1, binding=browser) {
  const config = browserConfig(h, provider, index);
  assert.equal(config.command, "C:\\Trex Browser\\trex-browser.exe");
  assert.deepEqual(config.args, ["mcp", "--cwd", cwd, "--mode", mode, "--client-id", binding.clientId, "--profile", binding.profile]);
}
const send = h => h.session.send("Offline browser request", [], []);

const connectedBrowserTools = () => ({ data: [{ name: "trex_browser", runtimeStatus: "connected", toolsError: null,
  tools: Object.fromEntries(["browser_navigate", "browser_snapshot", "browser_status"].map(name => [name, { name, inputSchema: { type: "object" } }])) }] });
test("Codex requires browser startup and verifies this thread's inventory before the first model turn", async t => {
  const h = harness(t, "codex"); h.hold("mcpServerStatus/list");
  const sending = send(h);
  for (let i=0; i<20 && !h.writes.some(write=>write.method==="mcpServerStatus/list"); i++) await h.pump();
  const probe=h.writes.find(write=>write.method==="mcpServerStatus/list");assert.ok(probe);assert.equal(probe.params.threadId,h.conversation);assert.equal(probe.params.serverName,"trex_browser");assert.equal(h.userWrites.length,0);
  const config=h.writes.find(write=>write.method==="thread/start").params.config;
  assert.equal(config["mcp_servers.trex_browser.required"],true);assert.equal(config["mcp_servers.trex_browser.startup_timeout_sec"],30);assert.equal(config["mcp_servers.trex_browser.tool_timeout_sec"],120);
  h.respond(probe,connectedBrowserTools());assert.equal(await sending,true);
  assert.match(h.writes.find(write=>write.method==="thread/start").params.developerInstructions,/browser_navigate/);
  assert.match(h.writes.find(write=>write.method==="thread/start").params.developerInstructions,/automatically opens the visible project browser/);
});
for(const [name,inventory] of [
  ["missing server",{data:[]}],
  ["handshake failure",{data:[{name:"trex_browser",runtimeStatus:"failed",tools:{},toolsError:"Supported MCP protocol: 2025-11-25"}]}],
  ["stale cached tools",{data:[{...connectedBrowserTools().data[0],runtimeStatus:"failed"}]}],
  ["configuration changed",{data:[{...connectedBrowserTools().data[0],runtimeStatus:null}]}],
  ["missing navigation",{data:[{...connectedBrowserTools().data[0],tools:{browser_snapshot:{name:"browser_snapshot"}}}]}],
  ["malformed tool list",{data:[{...connectedBrowserTools().data[0],tools:[]}]}],
]) test("Codex never sends a model turn with "+name,async t=>{
  const h=harness(t,"codex",{mcpStatus:inventory});assert.equal(await send(h),false);assert.equal(h.userWrites.length,0);assert.equal(h.state.process,"failed");assert.ok(h.state.items.some(item=>item.kind==="notice"&&item.text.includes("Trex Browser")));
});
test("Codex retires an old browser inventory reply after an idle permission change",async t=>{
  const h=harness(t,"codex");h.hold("mcpServerStatus/list");const starting=h.session.start();
  for(let i=0;i<20&&!h.writes.some(write=>write.method==="mcpServerStatus/list");i++)await h.pump();
  const old=h.writes.find(write=>write.method==="mcpServerStatus/list");assert.ok(old);h.session.setMode("plan");h.respond(old,connectedBrowserTools());await starting;
  h.release("mcpServerStatus/list");assert.equal(await send(h),true);assert.equal(h.spawns.length,2);assertBrowser(h,"codex","observe");
  assert.equal(h.userWrites.length,1);assert.equal(h.userWrites[0].process,h.spawns[1].id);
});
test("Codex without an attached browser adds neither inventory queries nor browser instructions",async t=>{
  const h=harness(t,"codex",{status:{installed:false,ready:false,compatible:false}});assert.equal(await send(h),true);
  assert.ok(!h.writes.some(write=>write.method==="mcpServerStatus/list"));assert.ok(!h.writes.find(write=>write.method==="thread/start").params.developerInstructions.includes("Trex Browser is connected"));
});
test("stopping a fork during browser discovery preserves the original thread's confirmed grant",async t=>{
  const history=[{id:"old-turn",status:"completed",items:[{type:"userMessage",id:"old-user",content:[{type:"text",text:"Original"}]}]}];
  const h=harness(t,"codex",{conversationId:"original-thread",history});await h.ready();const before=h.writes.length;h.hold("mcpServerStatus/list");
  const editing=h.session.edit("old-user","Edited",[],[]);
  for(let i=0;i<20&&!h.writes.slice(before).some(write=>write.method==="mcpServerStatus/list");i++)await h.pump();
  const probe=h.writes.slice(before).find(write=>write.method==="mcpServerStatus/list");assert.ok(probe);h.session.interrupt();h.respond(probe,connectedBrowserTools());await editing;
  h.release("mcpServerStatus/list");h.render();assert.equal(await send(h),true);assert.equal(h.userWrites.length,1);assert.equal(h.userWrites[0].params.threadId,"original-thread");
});
for(const provider of ["claude","codex"])test(provider+": a failed app-side browser preparation blocks sending instead of silently removing tools",async t=>{
  const wait=deferred();wait.reject(new Error("Synthetic prepare failure"));
  const h=harness(t,provider,{configWait:wait});assert.equal(await send(h),false);assert.equal(h.userWrites.length,0);assert.ok(h.state.items.some(item=>item.kind==="notice"&&item.text.includes("Trex Browser")));
});

for (const provider of ["claude", "codex"]) {
  for (const [conversationId, planningOnly] of [null, "saved-conversation"].flatMap(id => [[id, false], [id, true]])) {
    test(`${provider}: ${planningOnly ? "planner " : ""}${conversationId ? "resume" : "startup"} injects external browser MCP without changing native launch`, async t => {
      const h = harness(t, provider, { conversationId, planningOnly }); await h.ready();
      assert.equal(h.spawns.length, 1);
      const mode = planningOnly ? "observe" : "qa";
      assertBrowser(h, provider, mode);
      assert.deepEqual(h.browserCalls.map(call => call.method), ["status", "config"]);
      assert.deepEqual(h.browserCalls[1].args, [cwd, mode, browser.clientId, browser.profile]);
      assert.equal(h.spawns[0].request.command, provider);
      if (provider === "claude" && conversationId) {
        const flags = h.spawns[0].request.flags;
        assert.equal(flags[flags.indexOf("--resume") + 1], conversationId);
      }
      if (provider === "codex") assert.equal(h.writes.some(write => write.method === (conversationId ? "thread/resume" : "thread/start")), true);
      assert.equal(await send(h), true);
    });
  }
  for (const missing of ["disabled", "not-installed"]) {
    test(`${provider}: ${missing} browser preserves native provider flow`, async t => {
      const h = harness(t, provider, missing === "disabled" ? { browser: { ...browser, enabled: false } }
        : { status: { installed: false, ready: false, compatible: false } });
      await h.ready(); assert.equal(await send(h), true);
      assert.equal(h.spawns.length, 1);
      assert.equal(h.browserCalls.filter(call => call.method === "config").length, 0);
      assert.equal(h.browserCalls.length, missing === "disabled" ? 0 : 1);
      if (provider === "claude") assert.equal(h.spawns[0].request.flags.includes("--mcp-config"), false);
      else assert.equal(h.writes.find(write => write.method === "thread/start").params.config["mcp_servers.trex_browser.command"], undefined);
    });
  }
  for (const renderFirst of [false, true]) {
    test(`${provider}: idle browser permission class rebuild${renderFirst ? " after render" : " before React render"}`, async t => {
      const h = harness(t, provider); await h.ready();
      h.session.setMode("plan"); if (renderFirst) h.render();
      assert.equal(await send(h), true);
      h.render();
      assert.equal(h.spawns.length, 2, "permission class change starts a new native process");
      assertBrowser(h, provider, "observe");
      assert.equal(h.userWrites.at(-1).process, h.spawns.at(-1).id);
    });
  }
  test(`${provider}: startup discovery race cannot reuse an obsolete browser permission class`, async t => {
    const configWait = deferred(), h = harness(t, provider, { configWait });
    const oldStart = h.session.start(); await h.pump();
    assert.equal(h.browserCalls.filter(call => call.method === "config").length, 1);
    h.session.setMode("plan");
    const pending = send(h); await h.pump();
    configWait.resolve();
    await oldStart; assert.equal(await pending, true); h.render();
    assert.equal(h.spawns.length, 1, "obsolete startup does not spawn");
    assertBrowser(h, provider, "observe");
    assert.deepEqual(h.browserCalls.filter(call => call.method === "config").map(call => call.args[1]), ["qa", "observe"]);
  });
  test(`${provider}: obsolete pending native spawn cannot publish its browser class`, async t => {
    const h = harness(t, provider, { hold: ["spawn"] });
    const oldStart = h.session.start(); await h.pump();
    assert.equal(h.spawns.length, 1);
    h.session.setMode("plan");
    const pending = send(h); await h.pump();
    assert.equal(h.spawns.length, 2);
    h.spawns[0].resolve(); await oldStart; await h.pump();
    assert.equal(h.userWrites.length, 0, "old spawn cannot issue work");
    h.spawns[1].resolve(); assert.equal(await pending, true); h.render();
    assertBrowser(h, provider, "observe");
    assert.equal(h.userWrites[0].process, h.spawns[1].id);
  });
  for (const boundary of ["submission pending", "issued before React render", "issued after render"]) {
    test(`${provider}: active browser class change is rejected (${boundary})`, async t => {
      const h = harness(t, provider); await h.ready();
      const pending = send(h);
      if (boundary !== "submission pending") assert.equal(await pending, true);
      if (boundary === "issued after render") h.render();
      h.session.setMode("plan");
      assert.equal(await pending, true); h.render();
      assert.equal(h.state.modeChoice, "ask");
      assert.equal(h.spawns.length, 1);
      assert.equal(h.browserCalls.filter(call => call.method === "config").length, 1);
      assert.ok(h.state.items.some(item => item.kind === "notice" && /permisos del navegador/.test(item.text)));
    });
  }
  test(`${provider}: immutable planner keeps observe and native planning after options and mode changes`, async t => {
    const h = harness(t, provider, { planningOnly: true, mode: "full" }); await h.ready();
    h.options.planningOnly = false; h.options.mode = "full"; h.render();
    h.session.setMode("full"); h.render();
    assert.equal(h.state.modeChoice, "plan"); assertBrowser(h, provider, "observe");
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
  test(`codex: ${planningOnly ? "planner " : ""}native fork retains the external browser server and inbox`, async t => {
    const history = [{ id: "old-turn", status: "completed", items: [{ type: "userMessage", id: "old-user", content: [{ type: "text", text: "Original request" }] }] }];
    const h = harness(t, "codex", { conversationId: "original-thread", history, planningOnly }); await h.ready();
    const user = h.state.items.find(item => item.kind === "user"); assert.ok(user);
    await h.session.edit(user.id, "Edited browser request", [], []);
    assert.equal(h.writes.filter(write => write.method === "thread/fork").length, 1);
    assertBrowser(h, "codex", planningOnly ? "observe" : "qa");
    if (planningOnly) {
      const fork = h.writes.find(write => write.method === "thread/fork").params;
      assert.equal(fork.sandbox, "read-only"); assert.equal(fork.approvalPolicy, "on-request");
      assert.equal(h.userWrites.at(-1).params.collaborationMode.mode, "plan");
    }
    assert.equal(h.spawns.length, 1, "Codex forks within its existing app-server");
  });

  test(`claude: ${planningOnly ? "planner " : ""}native fork obtains external browser MCP for the replacement process`, async t => {
    const h = harness(t, "claude", { planningOnly, api: { claudeRewindPoint: async () => "rewind-point" } }); await h.ready();
    assert.equal(await send(h), true); h.render();
    const user = h.state.items.find(item => item.kind === "user");
    h.line({ type: "system", subtype: "init", session_id: "original-claude" });
    h.complete(user.id); h.render();
    await h.session.edit(user.id, "Edited browser request", [], []);
    assert.equal(h.spawns.length, 2); assertBrowser(h, "claude", planningOnly ? "observe" : "qa");
    assert.ok(h.spawns[1].request.flags.includes("--fork-session"));
    if (planningOnly) {
      const flags = h.spawns[1].request.flags;
      assert.equal(flags[flags.indexOf("--permission-mode") + 1], "plan");
      assert.equal(flags.includes("--dangerously-skip-permissions"), false);
    }
    assert.equal(h.browserCalls.filter(call => call.method === "config").length, 2);
  });
}

for (const planningOnly of [false, true]) {
  test(`trex: forwards browser context and ${planningOnly ? "immutable native plan" : "native mode"} through session/start`, async t => {
    const h = harness(t, "trex", { planningOnly, mode: "full" }); await h.ready();
    const start = h.writes.find(write => write.method === "session/start");
    assert.deepEqual(start.params.browser, browser);
    assert.equal(start.params.mode, planningOnly ? "plan" : "full");
    assert.deepEqual(h.browserCalls, [], "Trex delegates discovery to its native CLI");
    if (planningOnly) {
      h.options.planningOnly = false; h.options.mode = "full"; h.render();
      h.session.setMode("full"); h.render(); assert.equal(h.state.modeChoice, "plan");
    }
    assert.equal(await send(h), true);
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

for (const provider of ["claude", "codex", "trex"]) {
  test(`ChatView: ${provider} receives browser context pinned to the original session settings`, t => {
    const env = components.environment(), host = components.host(t);
    const module = components.panelModule(env);
    const props = { ...components.baseProps(), provider, settings: { browserEnabled: true, browserProfile: "BROWSER23" } };
    const first = host.render(() => module.default(props));
    assert.deepEqual(first.props.browser, { enabled: true, profile: "BROWSER23", clientId: props.sessionId,automatic:true,label:provider==="claude"?"Claude Code":provider==="codex"?"Codex":"Trex CLI" });
    const second = host.render(() => module.default({ ...props, settings: { browserEnabled: false, browserProfile: "BROWSER99" } }));
    assert.equal(second.props.browser, first.props.browser);
    assert.equal(second.props.browser.enabled, true);
    t.after(() => env.timers.clear());
  });
}

for (const [plannerProvider, executorProvider] of [["claude", "codex"], ["codex", "claude"]]) {
  test(`AgentRoom: ${plannerProvider} planner + ${executorProvider} executor pin independent contexts and enforce their browser classes`, async t => {
    const env = components.environment(), host = components.host(t);
    const { ChatPanel } = components.panelModule(env);
    const forbid = () => assert.fail("Runtime hooks must be mounted through the offline provider harness");
    const module = components.evaluate("room", env, { "../api": components.api, "./ChatView": { ChatPanel },
      "../hooks/useClaudeChat": { useClaudeChat: forbid }, "../hooks/useCodexChat": { useCodexChat: forbid },
      "../hooks/useAntigravityChat": { useAntigravityChat: forbid }, "../hooks/useTrexChat": { useTrexChat: forbid } });
    const participant = (provider, mode) => ({ agent: { provider, profileId: provider, profileName: provider, model: null,
      effort: null, launch: { command: null, args: null, shell: "powershell", env: null } }, conversationId: null, mode });
    const props = { ...components.baseProps(), settings: { browserEnabled: true, browserProfile: browser.profile },
      room: { id: "room-browser-client", active: "planner", phase: "idle", cycle: 1, order: [],
        planner: participant(plannerProvider, "plan"), executor: participant(executorProvider, executorProvider === "claude" ? "bypassPermissions" : "full") }, onRoomChange() {} };
    const render = input => host.render(() => module.default(input));
    const runtimes = tree => [...components.elements(tree)].filter(node => typeof node.type === "function" && node.props.options && node.props.role);
    const initial = runtimes(render(props));
    assert.equal(initial.length, 2);
    const planner = initial.find(node => node.props.role === "planner").props.options;
    const executor = initial.find(node => node.props.role === "executor").props.options;
    assert.notEqual(planner.browser, executor.browser);
    assert.equal(planner.browser.clientId,props.room.id+"-planner");
    assert.equal(executor.browser.clientId,props.room.id+"-executor");
    assert.equal(planner.browser.automatic,true);assert.equal(executor.browser.automatic,true);
    assert.equal(planner.mode, "plan"); assert.equal(planner.planningOnly, true);
    assert.equal(executor.mode, executorProvider === "claude" ? "bypassPermissions" : "full"); assert.equal(executor.planningOnly, false);
    assert.notEqual(planner.sessionId, executor.sessionId);
    const changed = runtimes(render({ ...props, settings: { browserEnabled: false, browserProfile: "BROWSER99" } }));
    for (const node of changed) assert.equal(node.props.options.browser, node.props.role==="planner"?planner.browser:executor.browser);
    for (const [provider, options, mode] of [[plannerProvider, planner, "observe"], [executorProvider, executor, "full"]]) {
      const h = harness(t, provider, options); await h.ready();
      assertBrowser(h, provider, mode,-1,{clientId:options.browser.clientId,profile:options.planningOnly?"BROWSER2":"BROWSER3"});
      assert.equal(await send(h), true);
    }
    t.after(() => env.timers.clear());
  });
}

for(const provider of ["claude","codex","trex"])test(`${provider}: automatic chat startup binds the allocated space without serializing frontend-only options`,async t=>{
  const requested={enabled:true,automatic:true,label:provider,profile:"BROWSER1",clientId:"ordinary-"+provider};
  const h=harness(t,provider,{browser:requested});await h.ready();
  if(provider==="trex")assert.deepEqual(h.writes.find(write=>write.method==="session/start").params.browser,{enabled:true,clientId:requested.clientId,profile:"BROWSER4"});
  else assertBrowser(h,provider,"qa",-1,{clientId:requested.clientId,profile:"BROWSER4"});
  assert.equal(await send(h),true);assert.ok(h.browserCalls.some(call=>call.method==="space"));
});

const imageBytes = "OFFLINE_SECRET_BASE64_IMAGE_BYTES";
const artifact = { id: "opaque_Broker_id-7", sha256: "a".repeat(64), mimeType: "image/png", sizeBytes: 42,
  kind: "screenshot", storage: "broker", provenance: { projectId: "project", profile: "BROWSER17" } };
const imageResult = { content: [{ type: "image", data: imageBytes, mimeType: "image/png" },
  { type: "text", text: JSON.stringify({ artifacts: [artifact] }) }], structuredContent: { artifacts: [artifact] } };

for (const provider of ["claude", "codex", "trex"]) {
  test(`${provider}: browser result becomes metadata with exact artifact id and no image bytes`, async t => {
    const h = harness(t, provider); await h.ready(); assert.equal(await send(h), true); h.render();
    if (provider === "claude") {
      h.line({ type: "assistant", uuid: "tool-message", message: { id: "tool-message", content: [
        { type: "tool_use", id: "browser-tool", name: "mcp__trex_browser__browser_take_screenshot", input: {} }] } });
      h.line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "browser-tool", content: imageResult.content }] } });
    } else if (provider === "codex") {
      h.line({ method: "item/completed", params: { threadId: h.conversation, turnId: h.turn,
        item: { type: "mcpToolCall", id: "browser-tool", server: "trex_browser", tool: "browser_take_screenshot", arguments: {}, status: "completed", result: imageResult } } });
    } else {
      const messageId = h.userWrites.at(-1).params.messageId;
      const params = { sessionId: h.conversation, messageId, id: "browser-tool" };
      h.line({ method: "tool/start", params: { ...params, toolName: "browser_take_screenshot", input: {} } });
      // Trex CLI deliberately sends its sanitized artifact envelope to React.
      h.line({ method: "tool/result", params: { ...params, artifacts: [artifact], output: { text: "Screenshot captured", artifacts: [artifact] } } });
    }
    const item = h.state.items.find(item => item.kind === "tool" && item.id === "browser-tool"); assert.ok(item);
    assert.equal(item.status, "done");
    assert.deepEqual(item.artifacts, [artifact]);
    assert.equal(browserModule.brokerArtifactId(item.artifacts[0]), artifact.id);
    assert.doesNotMatch(JSON.stringify(item), new RegExp(imageBytes));
  });
}

test("Claude planner read permissions match the observe catalog and deny modifying browser tools", async t => {
  const all = JSON.parse(await readFile(new URL("../trex-browser/docs/tools.json", import.meta.url), "utf8")).tools;
  const observe = new Set(JSON.parse(await readFile(new URL("../trex-browser/docs/observe-tools.json", import.meta.url), "utf8")).tools.map(tool => tool.name));
  assert.deepEqual([...browserModule.OBSERVE_BROWSER_TOOLS].sort(), [...observe].sort());
  const h = harness(t, "claude", { planningOnly: true }); await h.ready();
  for (const tool of all) {
    const id = `permission-${tool.name}`;
    h.line({ type: "control_request", request_id: id, request: { subtype: "can_use_tool", tool_name: `mcp__trex_browser__${tool.name}`, input: {} } });
    h.render();
    const item = h.state.items.find(item => item.kind === "permission" && item.id === id); assert.ok(item);
    if (observe.has(tool.name)) h.session.answer(item, true, false);
    await h.pump();
    const response = h.writes.find(write => write.type === "control_response" && write.response.request_id === id);
    assert.ok(response, `planner must resolve ${tool.name}`);
    assert.equal(response.response.response.behavior, observe.has(tool.name) ? "allow" : "deny", tool.name);
  }
});

for (const provider of ["claude", "codex"]) {
  test(`${provider}: same browser permission class keeps the existing process`, async t => {
    const h = harness(t, provider); await h.ready();
    h.session.setMode(provider === "claude" ? "acceptEdits" : "auto");
    assert.equal(await send(h), true); h.render();
    assert.equal(h.spawns.length, 1);
    assert.equal(h.browserCalls.filter(call => call.method === "config").length, 1);
    assertBrowser(h, provider, "qa");
  });
  test(`${provider}: leaving observe for full rebuilds the immutable browser server`, async t => {
    const h = harness(t, provider, { mode: "plan" }); await h.ready();
    assertBrowser(h, provider, "observe");
    h.session.setMode(provider === "claude" ? "bypassPermissions" : "full");
    assert.equal(await send(h), true); h.render();
    assert.equal(h.spawns.length, 2); assertBrowser(h, provider, "full");
  });
}

test("ChatPanel opens the exact broker provenance id with pinned context, without putting image bytes in the transcript", async t => {
  const nativeCalls = [], h = harness(t, "claude"); await h.ready();
  const env = components.environment(), host = components.host(t);
  const { ChatPanel } = components.panelModule(env, { "../api": { ...components.api,
    gitBranch: async () => null,
    trexBrowserOpenArtifact: async (...args) => { nativeCalls.push(args); return { content: [{ type: "image", data: imageBytes, mimeType: "image/png" }], isError: false }; },
  } });
  const local = { ...artifact, id: "local_hash", storage: "local", provenance: { brokerArtifactId: "broker:Capture.Mixed_CASE-01" } };
  const item = { kind: "tool", id: "browser-tool", name: "mcp__trex_browser__browser_take_screenshot", input: {},
    status: "done", output: "Screenshot captured", patch: null, artifacts: [local] };
  const session = { ...h.session, state: { ...h.state, items: [item] } };
  const tree = host.render(() => ChatPanel({ ...components.baseProps(), visible: true, provider: "claude", browser, session }));
  const row = [...components.elements(tree)].find(node => node.props.item === item && node.props.onOpenArtifact);
  assert.ok(row, "actual ChatPanel supplies the browser artifact action");
  await row.props.onOpenArtifact(local);
  assert.deepEqual(nativeCalls, [["broker:Capture.Mixed_CASE-01", cwd, "full", browser.clientId, browser.profile]]);
  assert.doesNotMatch(JSON.stringify(session.state.items), new RegExp(imageBytes));
  t.after(() => env.timers.clear());
});

test("rendered browser artifact button contains metadata only and returns its exact reference", async t => {
  const source = await readFile(new URL("../src/components/chat/ChatItems.tsx", import.meta.url), "utf8");
  const ast = ts.createSourceFile("ChatItems.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const declaration = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "BrowserArtifactButton");
  assert.ok(declaration);
  const code = ts.transpileModule(`export ${declaration.getText(ast)}`, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
  const exports = {}, jsx = (type, props) => ({ type, props });
  new Function("require", "exports", "useState", "brokerArtifactId", "ImageIcon", code)(
    name => { assert.equal(name, "react/jsx-runtime"); return { jsx, jsxs: jsx }; }, exports,
    initial => [initial, () => {}], browserModule.brokerArtifactId, "ImageIcon");
  const reference = browserModule.browserArtifacts([{ ...artifact, data: imageBytes, base64: imageBytes, url: `data:image/png;base64,${imageBytes}` }])[0];
  const opened = [], tree = exports.BrowserArtifactButton({ artifact: reference, onOpen: async value => opened.push(value) });
  assert.equal(tree.props.disabled, false);
  assert.doesNotMatch(JSON.stringify(tree), new RegExp(imageBytes));
  tree.props.onClick(); await flush();
  assert.equal(opened[0], reference);
});

for (const permissionArgs of ["--permission-mode bypassPermissions", "--permission-mode=bypassPermissions --dangerously-skip-permissions"]) {
  test(`Claude: idle setMode(plan) overrides browser-enabled profile permissions (${permissionArgs})`, async t => {
    const args = `--model offline-profile ${permissionArgs} --append-system-prompt "Keep this prompt"`;
    const h = harness(t, "claude", { args, mode: null }); await h.ready();
    assert.equal(h.spawns[0].request.flags[h.spawns[0].request.flags.indexOf("--permission-mode") + 1], "bypassPermissions", "the profile's native mode is carried into launch flags");
    assertBrowser(h, "claude", "full");
    h.session.setMode("plan");
    assert.equal(await send(h), true); h.render();
    assert.equal(h.spawns.length, 2);
    const launch = h.spawns[1].request;
    assert.doesNotMatch(launch.profileArgs ?? "", /--permission-mode|--dangerously-skip-permissions/);
    assert.match(launch.profileArgs, /--model offline-profile/);
    assert.match(launch.profileArgs, /--append-system-prompt "Keep this prompt"/);
    assert.equal(launch.flags[launch.flags.indexOf("--permission-mode") + 1], "plan", "native Claude and the immutable browser both enter plan");
    assertBrowser(h, "claude", "observe");
    assert.equal(h.writes.some(write => write.request?.subtype === "set_permission_mode"), false, "reconnect carries native permissions in launch flags");
  });
}

test("Claude: browser-disabled mode change preserves profile arguments and uses native control without rebuilding", async t => {
  const args = '--permission-mode bypassPermissions --append-system-prompt "Keep this prompt"';
  const h = harness(t, "claude", { args, mode: null, browser: { ...browser, enabled: false } }); await h.ready();
  h.session.setMode("plan");
  assert.equal(await send(h), true); h.render();
  assert.equal(h.spawns.length, 1);
  assert.equal(h.spawns[0].request.profileArgs, args);
  assert.ok(h.writes.some(write => write.request?.subtype === "set_permission_mode" && write.request.mode === "plan"));
  assert.deepEqual(h.browserCalls, []);
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
  assertBrowser(h, "claude", "observe");
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
    await h.session.edit(original.id, "Regenerate after browser permission change", [], []);
    h.render();
    assert.equal(h.spawns.length, 2, "edit reopens the native app-server despite stale process=ready");
    const fork = h.writes.find(write => write.method === "thread/fork"); assert.ok(fork);
    assert.equal(fork.params.beforeTurnId, original.providerTurnId);
    assert.equal(fork.process, h.spawns[1].id);
    assertBrowser(h, "codex", targetMode === "plan" ? "observe" : "qa");
    const turns = h.writes.filter(write => write.method === "turn/start");
    assert.equal(turns.length, 2);
    assert.equal(turns[1].process, h.spawns[1].id);
    assert.notEqual(turns[1].params.threadId, originalTurn.threadId);
    assert.equal(h.state.items.some(item => item.kind === "user" && item.text === "Regenerate after browser permission change"), true);
  });
}

test("Codex: completed user turn edit in the same browser class reuses the app-server", async t => {
  const h = harness(t, "codex", { mode: "full" }); await h.ready();
  assert.equal(await send(h), true); h.render();
  const original = h.state.items.find(item => item.kind === "user");
  h.complete(h.turn); h.render();
  h.session.setMode("bypassPermissions");
  await h.session.edit(original.id, "Regenerate in the same browser class", [], []); h.render();
  assert.equal(h.spawns.length, 1);
  assert.equal(h.browserCalls.filter(call => call.method === "config").length, 1);
  assert.equal(h.writes.filter(write => write.method === "thread/fork").length, 1);
  assertBrowser(h, "codex", "full");
});

for (const content of [
  JSON.stringify({ artifacts: [artifact] }),
  JSON.stringify({ structuredContent: { artifacts: [artifact] } }),
  [{ type: "text", text: JSON.stringify({ artifacts: [artifact] }) }],
]) {
  test(`Claude: tool_result ${typeof content === "string" ? content.includes("structuredContent") ? "structured JSON string" : "JSON string" : "text blocks"} retains browser artifacts`, async t => {
    const h = harness(t, "claude"); await h.ready();
    h.line({ type: "assistant", uuid: "artifact-call", message: { id: "artifact-call", content: [
      { type: "tool_use", id: "string-result", name: "mcp__trex_browser__browser_take_screenshot", input: {} }] } });
    h.line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "string-result", content }] } });
    const item = h.state.items.find(item => item.kind === "tool" && item.id === "string-result"); assert.ok(item);
    assert.equal(item.status, "done");
    assert.deepEqual(item.artifacts, [artifact]);
    assert.equal(browserModule.brokerArtifactId(item.artifacts[0]), artifact.id);
    assert.doesNotMatch(JSON.stringify(item.artifacts), new RegExp(imageBytes));
  });
}

test("Claude: ordinary, malformed, oversized and non-browser tool_result strings do not create artifact cards", async t => {
  const h = harness(t, "claude"); await h.ready();
  const inputs = [
    ["mcp__trex_browser__browser_snapshot", "Ordinary browser output"],
    ["mcp__trex_browser__browser_snapshot", '{"artifacts":'],
    ["mcp__trex_browser__browser_snapshot", JSON.stringify({ artifacts: [artifact], padding: "x".repeat(262144) })],
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
      assertBrowser(h, "claude", expected);
      const flags = h.spawns[1].request.flags;
      assert.equal(flags[flags.indexOf("--permission-mode") + 1], reportedMode);
      assert.equal(flags[flags.indexOf("--resume") + 1], "native-status-conversation");
      assert.equal(h.userWrites.length, 1);
      assert.equal(h.userWrites[0].process, h.spawns[1].id);
    });
  }
  test(`Claude: native init ${initialMode} -> ${reportedMode} replaces the immutable browser grant before render`, async t => {
    const h = harness(t, "claude", { mode: initialMode }); await h.ready();
    h.line({ type: "system", subtype: "init", session_id: "confirmed-native-session", permissionMode: reportedMode });
    assert.deepEqual(h.nativeKills, [h.spawns[0].id]);
    assert.equal(await send(h), true); h.render();
    assert.equal(h.spawns.length, 2);
    assertBrowser(h, "claude", expected);
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
  assertBrowser(h, "claude", "observe");
  assert.equal(h.userWrites.length, 2);
  assert.equal(h.userWrites[1].process, h.spawns[1].id);
  h.resolveIpc(); await h.pump();
  assert.equal(h.state.pendingMessageIds.includes(old.uuid), false, "late old IPC cannot revive the retired turn");
});

for (const scenario of ["same-class", "unknown-mode", "browser-disabled", "missing-component"]) {
  test(`Claude: native status control ${scenario} keeps the existing process`, async t => {
    const extra = scenario === "browser-disabled" ? { browser: { ...browser, enabled: false } }
      : scenario === "missing-component" ? { status: { installed: false, ready: false, compatible: false } } : {};
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
    assertBrowser(h, "claude", "observe");
    const launch = h.spawns[0].request;
    assert.equal(launch.flags[launch.flags.indexOf("--permission-mode") + 1], "plan");
    assert.equal(await send(h), true);
  });
}

test("Claude: explicit UI mode overrides the profile browser grant", async t => {
  const h = harness(t, "claude", { mode: "bypassPermissions", args: "--permission-mode plan" }); await h.ready();
  assertBrowser(h, "claude", "full");
  const flags = h.spawns[0].request.flags;
  assert.equal(flags[flags.indexOf("--permission-mode") + 1], "bypassPermissions");
  assert.equal(await send(h), true);
});

test("Claude: permission-looking quoted prompt text keeps the default browser class", async t => {
  const args = '--append-system-prompt "Literal --permission-mode plan"';
  const h = harness(t, "claude", { mode: null, args }); await h.ready();
  assertBrowser(h, "claude", "qa");
  assert.equal(h.spawns[0].request.profileArgs, args);
  assert.equal(await send(h), true);
});

test("Claude: quoted permission text cannot suppress an actual profile plan mode", async t => {
  const h = harness(t, "claude", { mode: null, args: '--append-system-prompt "Literal --permission-mode bypassPermissions" --permission-mode plan' });
  await h.ready();
  assertBrowser(h, "claude", "observe");
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
  test(`Codex: mode=null derives browser class from profile sandbox (${args})`, async t => {
    const h = harness(t, "codex", { mode: null, args }); await h.ready();
    assertBrowser(h, "codex", expected);
    assert.equal(h.writes.find(write => write.method === "thread/start").params.sandbox, sandbox);
    assert.equal(await send(h), true);
  });
}

test("Codex: quoted configuration text is not a sandbox option", async t => {
  const h = harness(t, "codex", { mode: null, args: '--config \'note="--sandbox read-only"\'' }); await h.ready();
  assertBrowser(h, "codex", "qa");
  assert.equal(h.writes.find(write => write.method === "thread/start").params.sandbox, undefined);
  const flags = h.spawns[0].request.flags;
  assert.equal(flags[0], "app-server");
  assert.equal(flags[flags.indexOf("-c") + 1], 'note="--sandbox read-only"');
  assert.equal(await send(h), true);
});

test("Codex: explicit UI full mode overrides the profile-derived browser class", async t => {
  const h = harness(t, "codex", { mode: "full", args: "--sandbox read-only" }); await h.ready();
  assertBrowser(h, "codex", "full");
  assert.equal(await send(h), true);
  assert.equal(h.userWrites[0].params.sandboxPolicy.type, "dangerFullAccess");
});

for (const browserAttached of [true, false]) {
  test(`Claude: ${browserAttached ? "attached browser waits for" : "missing browser does not wait for"} native initialize before the first user message`, async t => {
    const h = harness(t, "claude", { mode: "bypassPermissions", hold: ["initialize"],
      ...(browserAttached ? {} : { status: { installed: false, ready: false, compatible: false } }) });
    const pending = send(h); await h.pump();
    const initialize = h.writes.find(write => write.request?.subtype === "initialize"); assert.ok(initialize);
    if (browserAttached) {
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
  assertBrowser(h, "claude", "full");
  assert.equal(await send(h), true); h.render();
  assert.equal(h.spawns.length, 2);
  assertBrowser(h, "claude", "qa");
  const launch = h.spawns[1].request;
  assert.equal(launch.flags[launch.flags.indexOf("--permission-mode") + 1], "default");
  assert.equal(h.userWrites.length, 1);
  assert.equal(h.userWrites[0].process, h.spawns[1].id);
});

test("Claude: initialize rejection fails attached-browser startup without sending a user message", async t => {
  const h = harness(t, "claude", { mode: "bypassPermissions", hold: ["initialize"] });
  const pending = send(h); await h.pump();
  const initialize = h.writes.find(write => write.request?.subtype === "initialize"); assert.ok(initialize);
  h.controlResponse(initialize, "Offline native initialization rejection");
  assert.equal(await pending, false); h.render();
  assert.equal(h.userWrites.length, 0);
  assert.ok(h.state.items.some(item => item.kind === "notice" && /Offline native initialization rejection/.test(item.text)));
});

test("Claude: retired initialize response cannot replace the newer explicit browser permission intent", async t => {
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
  assertBrowser(h, "claude", "observe");
  const flags = h.spawns[1].request.flags;
  assert.equal(flags[flags.indexOf("--permission-mode") + 1], "plan");
  assert.equal(h.userWrites.length, 1);
  assert.equal(h.userWrites[0].process, h.spawns[1].id);
});

for (const initializeMode of [undefined, null, "unknown-native-mode"]) {
  test(`Claude: attached browser rejects ${initializeMode === undefined ? "missing" : String(initializeMode)} native permission confirmation`, async t => {
    const h = harness(t, "claude", { mode: "bypassPermissions", initializeMode });
    assert.equal(await send(h), false, "an attached immutable browser grant requires a recognized native permission acknowledgement");
    h.render();
    assert.equal(h.userWrites.length, 0);
    assert.ok(h.state.items.some(item => item.kind === "notice" && item.tone === "error"));
  });
}

for (const provider of ["claude", "codex"]) {
  for (const browserTool of [true, false]) {
    test(`${provider}: serialized MCP image output ${browserTool ? "scrubs browser bytes" : "preserves non-browser text"}`, async t => {
      const h = harness(t, provider); await h.ready();
      const envelope = JSON.stringify({ content: [{ type: "image", data: imageBytes, mimeType: "image/png" },
        { type: "text", text: "Human screenshot explanation" }], artifacts: [artifact] });
      if (provider === "claude") {
        h.line({ type: "assistant", uuid: "serialized-image", message: { id: "serialized-image", content: [
          { type: "tool_use", id: "serialized-image", name: browserTool ? "mcp__trex_browser__browser_take_screenshot" : "mcp__another_server__inspect", input: {} }] } });
        h.line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "serialized-image", content: envelope }] } });
      } else {
        h.line({ method: "item/completed", params: { threadId: h.conversation, item: { type: "mcpToolCall", id: "serialized-image",
          server: browserTool ? "trex_browser" : "another_server", tool: "browser_take_screenshot", arguments: {}, status: "completed",
          result: { content: [{ type: "text", text: envelope }] } } } });
      }
      const item = h.state.items.find(item => item.kind === "tool" && item.id === "serialized-image"); assert.ok(item);
      assert.match(item.output, /Human screenshot explanation/);
      if (browserTool) {
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
  test(`Claude: browser-disabled native ${initialMode} -> ${reportedMode} survives process restart`, async t => {
    const h = harness(t, "claude", { mode: initialMode, browser: { ...browser, enabled: false } }); await h.ready();
    h.line({ type: "system", subtype: "status", permissionMode: reportedMode }); h.render();
    assert.equal(h.state.modeChoice, reportedMode);
    h.exit(); h.render(); await h.ready();
    const flags = h.spawns[1].request.flags;
    assert.equal(flags[flags.indexOf("--permission-mode") + 1], reportedMode, "native status remains the launch choice when no browser is enabled");
    assert.deepEqual(h.browserCalls, []);
    assert.deepEqual(h.nativeKills, []);
    assert.equal(await send(h), true);
  });
}

for (const availability of ["not-installed", "not-ready", "disabled"]) {
  for (const renderFirst of [false, true]) {
    test(`Claude: ${availability} browser preserves active native mode changes ${renderFirst ? "after render" : "before render"}`, async t => {
      const extra = availability === "disabled" ? { browser: { ...browser, enabled: false } }
        : { status: { installed: availability !== "not-installed", ready: false, compatible: true } };
      const h = harness(t, "claude", { mode: "default", ...extra }); await h.ready();
      assert.equal(await send(h), true);
      if (renderFirst) h.render();
      const original = h.userWrites[0];
      h.session.setMode("bypassPermissions"); await h.pump();
      assert.equal(h.state.modeChoice, "bypassPermissions", "browser settings alone do not impose grant restrictions on native sessions");
      assert.ok(h.writes.some(write => write.request?.subtype === "set_permission_mode" && write.request.mode === "bypassPermissions"));
      assert.equal(h.state.pendingMessageIds.includes(original.uuid), true);
      assert.equal(h.spawns.length, 1);
      assert.deepEqual(h.nativeKills, []);
      assert.equal(h.browserCalls.filter(call => call.method === "config").length, 0);
      assert.equal(h.state.items.some(item => item.kind === "notice" && /Detén la respuesta.*permisos del navegador/.test(item.text)), false);
    });
  }
}

test("Claude: missing component retains native profile permission precedence and arguments", async t => {
  const args = '--permission-mode bypassPermissions --append-system-prompt "Keep native profile text"';
  const h = harness(t, "claude", { mode: "plan", args, status: { installed: false, ready: false, compatible: false } });
  await h.ready();
  const launch = h.spawns[0].request;
  assert.equal(launch.profileArgs, args, "an unavailable companion cannot rewrite native profile options");
  assert.equal(launch.flags.includes("--mcp-config"), false);
  assert.equal(launch.flags.includes("--permission-mode"), false, "the existing profile retains native permission precedence");
  assert.equal(await send(h), true);
});

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
  assertBrowser(h, "claude", "qa");
  assert.deepEqual(h.nativeKills, []);
});

test("Claude: current initialize acknowledgement still selects the effective native mode within QA", async t => {
  const h = harness(t, "claude", { mode: "default", initializeModes: ["acceptEdits", "acceptEdits"] }); await h.ready();
  await h.ready();
  const flags = h.spawns[1].request.flags;
  assert.equal(flags[flags.indexOf("--permission-mode") + 1], "acceptEdits");
  assertBrowser(h, "claude", "qa");
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
    assertBrowser(h, "claude", "observe");
  });
}

test("Claude: current mode rejection still restores the prior native and browser choice", async t => {
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
  assertBrowser(h, "claude", "qa");
});

for (const provider of ["claude", "codex"]) test(`${provider}: desktop MCP binds to permission mode and reconnects for planning`, async t => {
  const calls = [];
  const h = harness(t, provider, {
    browser: { ...browser, enabled: false }, desktopEnabled: true,
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
  const h = harness(t, "codex", { browser: { ...browser, enabled: false }, desktopEnabled: true, planningOnly: true,
    api: { trexDesktopMcpConfig: async () => ({ command: "trex-agent", args: ["desktop-mcp", "--mode", "plan"] }) },
    mcpStatus: { data: [{ name: "trex_desktop", runtimeStatus: "connected", tools: { desktop_screenshot: {}, desktop_click: {} } }] },
  });
  assert.equal(await send(h), false);
  assert.equal(h.userWrites.length, 0);
});

test("Claude planner refuses a desktop server that advertises input tools", async t => {
  const h=harness(t,"claude",{browser:{...browser,enabled:false},desktopEnabled:true,planningOnly:true,
    api:{trexDesktopMcpConfig:async()=>({command:"trex-agent",args:["desktop-mcp","--mode","plan"]})},
    desktopStatus:{mcpServers:[{name:"trex_desktop",status:"connected",serverInfo:{name:"trex-desktop"},config:{command:"trex-agent",args:["desktop-mcp","--mode","plan"]},tools:[{name:"desktop_screenshot"},{name:"desktop_click"}]}]},
  });
  assert.equal(await send(h),false);
  assert.equal(h.userWrites.length,0);
  assert.equal(h.nativeKills.length,1);
});

test("Claude refuses a desktop server from an unexpected executable", async t => {
  const names=["desktop_screenshot","desktop_click","desktop_drag","desktop_scroll","desktop_type","desktop_key"];
  const h=harness(t,"claude",{browser:{...browser,enabled:false},desktopEnabled:true,
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
  const h=harness(t,provider,{browser:{...browser,enabled:false},desktopEnabled:true,planningOnly:true,
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
    browser: { ...browser, enabled: false }, a11yEnabled: true,
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
    browser: { ...browser, enabled: false }, a11yEnabled: true,
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
