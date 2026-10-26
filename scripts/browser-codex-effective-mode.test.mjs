import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import nodeTest from "node:test";
import ts from "typescript";
import { load } from "./ts-loader.mjs";

const test = (name, fn) => nodeTest(name, { timeout: 10000 }, fn);

// Reuse the existing offline process/React boundary without registering its tests.
const url = new URL("./queue-send-now.test.mjs", import.meta.url);
const source = await readFile(url, "utf8");
const ast = ts.createSourceFile(url.pathname, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
let body = ast.statements.filter(node => ts.isVariableStatement(node) || ts.isFunctionDeclaration(node)
  || (ts.isExpressionStatement(node) && ts.isBinaryExpression(node.expression)
    && node.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken))
  .map(node => node.getText(ast)).join("\n").replaceAll("import.meta.url", JSON.stringify(url.href));
for (const [before, after] of [
  ['"../browserConnection": { connectBrowser: () => assert.fail("Unexpected browser discovery in a browser-disabled session") },',
    '"../browserConnection": extra.browserConnection,'],
  ['writes, spawns, actions, queueCalls, queue, clock, line, respond, controlResponse, render, unmount,',
    'options, writes, spawns, actions, queueCalls, queue, clock, line, respond, controlResponse, render, unmount,'],
  ['case "thread/start": case "thread/resume":', 'case "thread/start": case "thread/resume": case "thread/fork":'],
  ['{ thread: { id: conversation }, model: "offline-model" }',
    '{ thread: { id: conversation }, model: "offline-model", ...extra.nativeThread(message, spawns.find(spawn => spawn.id === message.process)?.request) }'],
]) {
  assert.ok(body.includes(before), `offline harness boundary changed: ${before}`);
  body = body.replaceAll(before, after);
}
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const base = await new AsyncFunction("assert", "readFile", "ts", "load", `${body}\nreturn { harness, deferred, flush, dependencies };`)(assert, readFile, ts, load);
const connectionCode = ts.transpileModule(await readFile(new URL("../src/browserConnection.ts", import.meta.url), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const browser = { enabled: true, profile: "BROWSER17", clientId: "effective-mode-client" };
const history = [{ id: "old-turn", status: "completed", items: [{ type: "userMessage", id: "old-user", content: [{ type: "text", text: "Original request" }] }] }];
const types = { "read-only": "readOnly", "workspace-write": "workspaceWrite", "danger-full-access": "dangerFullAccess" };

function harness(t, extra = {}) {
  const calls = [];
  const connection = {};
  new Function("require", "exports", connectionCode)(name => {
    if (name === "./browser") return base.dependencies["../browser"];
    assert.equal(name, "./api");
    return {
      async trexBrowserStatus() { return extra.status ?? { installed: true, ready: true, compatible: true }; },
      async trexBrowserMcpConfig(cwd, mode, clientId, profile) {
        calls.push({ cwd, mode, clientId, profile });
        if (extra.configWait) await extra.configWait.promise;
        return { command: "offline-browser", args: ["mcp", "--mode", mode, "--cwd", cwd, "--client-id", clientId, "--profile", profile] };
      },
    };
  }, connection);
  const nativeThread = (message, launch) => {
    let sandbox = extra.globalSandbox ?? "workspace-write", approvalPolicy = extra.globalApproval ?? "on-request";
    for (let index = 0; index < launch.flags.length; index++) if (launch.flags[index] === "-c") {
      const config = launch.flags[++index];
      const entry = /^(sandbox_mode|approval_policy)\s*=\s*"([^"]+)"$/.exec(config);
      if (entry?.[1] === "sandbox_mode") sandbox = entry[2];
      if (entry?.[1] === "approval_policy") approvalPolicy = entry[2];
    }
    sandbox = message.params.sandbox ?? message.params.config?.sandbox_mode ?? sandbox;
    approvalPolicy = message.params.approvalPolicy ?? message.params.config?.approval_policy ?? approvalPolicy;
    const response = { sandboxPolicy: { type: types[sandbox] }, approvalPolicy };
    return extra.response ? extra.response(message, response) : response;
  };
  const h = base.harness(t, "codex", { browser, resumeRequestedThread: true, ...extra, nativeThread, browserConnection: connection });
  return Object.assign(h, { browserCalls: calls });
}
const send = h => h.session.sendNow("Explicit user request", [], []);
const threadWrites = h => h.writes.filter(write => ["thread/start", "thread/resume", "thread/fork"].includes(write.method));
const binding = (h, index = -1) => {
  const config = threadWrites(h).at(index).params.config;
  const args = config["mcp_servers.trex_browser.args"];
  return args?.[args.indexOf("--mode") + 1];
};

for (const [args, initial] of [["--yolo", "full"], ["--sandbox read-only", "observe"]]) {
  test(`Codex effective browser grant: ${args} followed by auto rebuilds before render`, async t => {
    const h = harness(t, { mode: null, args }); await h.ready();
    assert.equal(binding(h), initial);
    const nativeId = h.state.sessionId;
    h.session.setMode("auto");
    assert.equal(await send(h), true);
    assert.equal(h.spawns.length, 2);
    assert.equal(binding(h), "qa");
    const resumed = threadWrites(h).at(-1);
    assert.equal(resumed.method, "thread/resume");
    assert.equal(resumed.params.threadId, nativeId);
    assert.equal(resumed.params.sandbox, "workspace-write");
    assert.equal(resumed.params.config.sandbox_mode, "workspace-write");
    assert.equal(resumed.params.approvalPolicy, "on-request");
    assert.equal(h.userWrites.length, 1, "only the explicitly requested turn is sent");
    assert.equal(h.userWrites[0].process, h.spawns[1].id);
    assert.equal(h.userWrites[0].params.sandboxPolicy.type, "workspaceWrite");
  });

  test(`Codex effective browser grant: active ${args} cannot change to auto`, async t => {
    const h = harness(t, { mode: null, args }); await h.ready();
    assert.equal(await send(h), true);
    h.session.setMode("auto");
    assert.equal(h.state.modeChoice, null);
    assert.equal(h.spawns.length, 1);
    assert.equal(binding(h), initial);
    assert.ok(h.state.items.some(item => item.kind === "notice" && /permisos del navegador/.test(item.text)));
  });
}

for (const extra of [
  { args: '--config \'sandbox_mode="read-only"\'' },
  { args: '-c \'sandbox_mode="read-only"\'' },
  { globalSandbox: "read-only" },
]) {
  test(`Codex native confirmation preserves null-mode readonly (${JSON.stringify(extra)})`, async t => {
    const h = harness(t, { mode: null, ...extra }); await h.ready();
    assert.equal(binding(h), "observe");
    assert.equal(h.spawns.length, 1);
    assert.equal(threadWrites(h)[0].params.sandbox, undefined, "inherit profile/global native permissions");
    assert.equal(h.state.permissionMode, "read-only");
    assert.equal(h.userWrites.length, 0);
    assert.equal(await send(h), true);
    assert.equal(h.userWrites[0].params.sandboxPolicy, undefined, "null UI choice preserves the confirmed native sandbox");
  });
}

for (const [sandbox, final] of [["workspace-write", "qa"], ["danger-full-access", "full"]]) {
  test(`Codex unknown initial ${sandbox} reconciles a conservative grant before user work`, async t => {
    const h = harness(t, { mode: null, globalSandbox: sandbox });
    assert.equal(await send(h), true);
    assert.deepEqual(h.browserCalls.map(call => call.mode), ["observe", final]);
    assert.equal(h.spawns.length, 2);
    const opened = threadWrites(h);
    assert.equal(opened[0].method, "thread/start");
    assert.equal(opened[1].method, "thread/resume");
    assert.equal(opened[1].params.threadId, "thread-1");
    assert.equal(opened[1].params.sandbox, undefined);
    assert.equal(h.userWrites.length, 1);
    assert.equal(h.userWrites[0].process, h.spawns[1].id);
    assert.equal(h.queueCalls.some(call => ["read", "ack", "claimDirect"].includes(call.name)), false);
  });
}

for (const response of [{}, { sandboxPolicy: { type: "readOnly" } }, { approvalPolicy: "on-request" },
  { sandboxPolicy: { type: "externalSandbox" }, approvalPolicy: "never" },
  { sandboxPolicy: { type: "readOnly" }, approvalPolicy: "unknown" }]) {
  test(`Codex attached browser fails closed on unknown native acknowledgement (${JSON.stringify(response)})`, async t => {
    const h = harness(t, { mode: null, response: () => response }); await h.ready();
    assert.equal(await send(h), false);
    assert.equal(h.userWrites.length, 0);
    assert.equal(h.spawns.length, 1);
    assert.ok(h.state.items.some(item => item.kind === "notice" && /no confirmó/.test(item.text)));
  });
}

test("Codex attached resume fails closed on unknown native acknowledgement without starting a replacement conversation", async t => {
  const h = harness(t, { conversationId: "saved-thread", response: () => ({}) }); await h.ready();
  assert.equal(await send(h), false);
  assert.deepEqual(threadWrites(h).map(write => write.method), ["thread/resume"]);
  assert.equal(h.userWrites.length, 0);
});

test("Codex attached fork requires a new native acknowledgement before the edited turn", async t => {
  const h = harness(t, { conversationId: "saved-thread", history,
    response: (message, response) => message.method === "thread/fork" ? {} : response }); await h.ready();
  const user = h.state.items.find(item => item.kind === "user");
  await assert.rejects(h.session.edit(user.id, "Edited request", [], []), /no confirmó/);
  assert.equal(h.userWrites.length, 0);
});

test("Codex attached browser rejects native permission overrides that were not confirmed", async t => {
  const h = harness(t, { mode: "full", args: "--sandbox read-only",
    response: () => ({ sandboxPolicy: { type: "readOnly" }, approvalPolicy: "on-request" }) }); await h.ready();
  assert.equal(threadWrites(h)[0].params.sandbox, "danger-full-access");
  assert.equal(await send(h), false);
  assert.equal(h.userWrites.length, 0);
  assert.equal(h.spawns.length, 1);
});

test("Codex reconciliation is bounded if native permissions keep changing", async t => {
  let responses = 0;
  const h = harness(t, { mode: null, response: () => ({
    sandboxPolicy: { type: ++responses === 1 ? "workspaceWrite" : "readOnly" }, approvalPolicy: "on-request",
  }) });
  assert.equal(await send(h), false);
  assert.equal(h.spawns.length, 2);
  assert.equal(h.userWrites.length, 0);
});

for (const extra of [
  { status: { installed: false, ready: false, compatible: false } },
  { status: { installed: true, ready: false, compatible: false } },
  { browser: { ...browser, enabled: false } },
]) {
  test(`Codex without attached browser preserves active native mode changes (${JSON.stringify(extra)})`, async t => {
    const h = harness(t, { ...extra, response: () => ({}) }); await h.ready();
    assert.equal(await send(h), true);
    h.session.setMode("full");
    assert.equal(h.state.modeChoice, "full");
    assert.equal(h.spawns.length, 1);
    assert.equal(binding(h), undefined);
    h.complete(); h.render();
    assert.equal(await send(h), true);
    assert.equal(h.userWrites.at(-1).params.sandboxPolicy.type, "dangerFullAccess");
    assert.equal(h.userWrites.at(-1).params.approvalPolicy, "never");
  });
}

for (const [mode, sandbox, approval, browserMode] of [
  ["full", "danger-full-access", "never", "full"], ["auto", "workspace-write", "on-request", "qa"],
  ["plan", "workspace-write", "on-request", "observe"], ["read-only", "read-only", "on-request", "observe"],
]) {
  test(`Codex explicit ${mode} applies consistent native/browser permissions on resume and fork`, async t => {
    const h = harness(t, { mode, args: "--sandbox read-only", conversationId: "saved-thread", history }); await h.ready();
    const user = h.state.items.find(item => item.kind === "user");
    await h.session.edit(user.id, "Edited request", [], []);
    for (const write of threadWrites(h)) {
      assert.equal(write.params.sandbox, sandbox);
      assert.equal(write.params.approvalPolicy, approval);
      assert.equal(write.params.config.sandbox_mode, sandbox);
      assert.equal(write.params.config.approval_policy, approval);
    }
    assert.equal(binding(h), browserMode);
    assert.equal(h.userWrites.length, 1);
    assert.equal(h.userWrites[0].params.sandboxPolicy.type, types[sandbox]);
    assert.equal(h.userWrites[0].params.approvalPolicy, approval);
    assert.equal(h.spawns.length, 1);
    if (mode === "plan") assert.equal(h.userWrites[0].params.collaborationMode.mode, "plan");
  });
}

test("Codex UI override before React render applies to replacement process, resume, fork and turn", async t => {
  const h = harness(t, { mode: null, globalSandbox: "read-only", conversationId: "saved-thread", history }); await h.ready();
  const user = h.state.items.find(item => item.kind === "user");
  h.session.setMode("full");
  await h.session.edit(user.id, "Edited request", [], []);
  assert.equal(h.spawns.length, 2);
  assert.deepEqual(h.browserCalls.map(call => call.mode), ["observe", "full"]);
  for (const write of threadWrites(h).slice(1)) {
    assert.equal(write.params.sandbox, "danger-full-access");
    assert.equal(write.params.approvalPolicy, "never");
  }
  assert.equal(h.userWrites[0].params.sandboxPolicy.type, "dangerFullAccess");
});

test("Codex obsolete browser preflight cannot publish its previous grant", async t => {
  const configWait = base.deferred(), h = harness(t, { mode: null, configWait });
  const old = h.session.start(); await h.pump();
  h.session.setMode("full");
  const pending = send(h); await h.pump();
  configWait.resolve();
  await old; assert.equal(await pending, true);
  assert.equal(h.spawns.length, 1);
  assert.equal(binding(h), "full");
  assert.deepEqual(h.browserCalls.map(call => call.mode), ["observe", "full"]);
});

test("Codex reset rechecks native permissions without weakening the browser binding", async t => {
  const h = harness(t, { mode: "full", args: "--sandbox read-only" }); await h.ready();
  h.session.reset(); await h.pump();
  assert.equal(await send(h), true);
  assert.equal(h.spawns.length, 1);
  assert.equal(threadWrites(h).at(-1).params.sandbox, "danger-full-access");
  assert.equal(binding(h), "full");
});

test("Codex planning-only permissions remain immutable and independent of an executor", async t => {
  const planner = harness(t, { planningOnly: true, mode: "full", args: "--yolo", globalSandbox: "danger-full-access" });
  const executor = harness(t, { mode: "full", globalSandbox: "read-only" });
  await Promise.all([planner.ready(), executor.ready()]);
  planner.options.planningOnly = false; planner.render();
  planner.session.setMode("full");
  assert.equal(await send(planner), true);
  assert.equal(await send(executor), true);
  assert.equal(binding(planner), "observe");
  assert.equal(binding(executor), "full");
  const params = planner.userWrites[0].params;
  assert.equal(params.sandboxPolicy.type, "readOnly");
  assert.equal(params.approvalPolicy, "on-request");
  assert.equal(params.collaborationMode.mode, "plan");
  assert.equal(executor.userWrites[0].params.sandboxPolicy.type, "dangerFullAccess");
  assert.equal(planner.state.modeChoice, "plan");
});
