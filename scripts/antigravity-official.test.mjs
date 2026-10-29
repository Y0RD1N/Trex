/** Opt-in smoke test: official runtime negotiation and unauthenticated setup, no authentication or model prompts. */
import assert from "node:assert/strict";
import test from "node:test";
import { readFile, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import ts from "typescript";
import { load } from "./ts-loader.mjs";
const runtimeDir = process.env.TREX_TEST_ANTIGRAVITY_RUNTIME;
test("Official Antigravity ACP negotiates two isolated native connections without authentication or inference", { skip: !runtimeDir, timeout: 90_000 }, async () => {
  const temporary = await realpath(os.tmpdir()), root = await mkdtemp(path.join(temporary, "trex-acp-smoke-"));
  const processes = new Map(), listeners = new Map(), writes = [];
  const windows = process.platform === "win32", executable = path.join(runtimeDir, windows ? "agy_acp_server.exe" : "agy_acp_server.par");
  const helper = path.join(runtimeDir, windows ? "localharness_external.exe" : "localharness_external");
  const emit = (kind, id, value) => listeners.get(`${kind}:${id}`)?.(value);
  const kill = async id => {
    const child = processes.get(id); if (!child) return;
    processes.delete(id);
    if (windows) await promisify(execFile)("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }).catch(() => {});
    else { try { process.kill(-child.pid, "SIGTERM"); } catch {} }
  };
  const subscribe = kind => async (id, callback) => { listeners.set(`${kind}:${id}`, callback); return () => listeners.delete(`${kind}:${id}`); };
  const api = {
    antigravityRuntime: async (_command, account) => ({ installed: true, command: executable, flags: windows ? [] : process.platform === "linux" ? ["--uid="] : [],
      env: { GEMINI_HOME: account, ANTIGRAVITY_HARNESS_PATH: helper, AGY_ACP_FORCE_FILE_STORAGE: "1" } }),
    listenAgentLine: subscribe("line"), listenAgentStderr: subscribe("stderr"), listenAgentExit: subscribe("exit"), agentKill: kill,
    agentSpawn: async request => {
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !["GOOGLE_", "GEMINI_", "GCLOUD_", "AGY_", "ANTIGRAVITY_"].some(prefix => key.startsWith(prefix))));
      const child = spawn(request.command, request.flags, { cwd: request.cwd, env: { ...env, ...request.env }, stdio: "pipe", windowsHide: true, detached: !windows });
      processes.set(request.id, child);
      createInterface({ input: child.stdout }).on("line", line => emit("line", request.id, line));
      createInterface({ input: child.stderr }).on("line", line => emit("stderr", request.id, line));
      child.on("exit", code => emit("exit", request.id, code));
      await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    },
    agentWrite: async (id, line) => {
      const message = JSON.parse(line); writes.push(message);
      assert.ok(["initialize", "session/new"].includes(message.method), "This smoke test must never authenticate or send a model prompt.");
      const child = processes.get(id); if (!child) throw Error("Native test process ended");
      await new Promise((resolve, reject) => child.stdin.write(line + "\n", error => error ? reject(error) : resolve()));
    },
  };
  const deps = { "./api": api, "./acpProtocol": await load("acpProtocol"), "./chatState": await load("chatState") };
  const code = ts.transpileModule(await readFile(new URL("../src/antigravityConnection.ts", import.meta.url), "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const exports = {}; new Function("require", "exports", code)(name => deps[name], exports);
  const connections = [];
  try {
    const results = await Promise.allSettled(["one", "two"].map(async suffix => {
      const connection = await exports.openAntigravity(executable, path.join(root, suffix), root); connections.push(connection); return connection;
    }));
    for (const result of results) { assert.equal(result.status, "fulfilled", result.reason?.message); assert.equal(result.value.init.protocolVersion, 1); assert.equal(result.value.init.agentInfo.name, "antigravity-acp"); assert.equal(result.value.init.agentCapabilities.promptCapabilities.image, true); }
    assert.equal(writes.length, 2); assert.equal(processes.size, 2);
    // Some runtimes defer authentication until the first prompt. Check session
    // setup with an empty isolated account, without ever sending that prompt.
    const setup = await Promise.allSettled(connections.map(connection => connection.rpc.call("session/new", { cwd: root, mcpServers: [] })));
    for (const result of setup) {
      if (result.status === "rejected") assert.equal(result.reason.code, -32000, result.reason.message);
      else assert.equal(typeof result.value.sessionId, "string");
    }
    console.info("Official ACP setup auth:", setup.map(result => result.status === "rejected" ? "required-at-session-setup" : "deferred-until-prompt").join(", "));
  } finally {
    await Promise.all(connections.map(connection => connection.close()));
    await Promise.all([...processes.keys()].map(kill));
    const checked = await realpath(root);
    assert.equal(path.dirname(checked), temporary); assert.ok(path.basename(checked).startsWith("trex-acp-smoke-"));
    await rm(checked, { recursive: true, force: true });
  }
});
