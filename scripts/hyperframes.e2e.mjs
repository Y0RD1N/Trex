// End-to-end check of the HyperFrames tools with the REAL CLI (not part of `npm test`).
//
//   node scripts/hyperframes.e2e.mjs        (TREX_AGENT overrides the trex-agent binary)
//
// It starts `trex-agent apps-mcp --apps hyperframes` like Claude, Codex and Antigravity do and drives every
// tool over MCP in a temporary workspace: init, project, docs, doctor, check (a clean one and a broken one),
// snapshot images, render with a poster, the background preview, and the read-only planning server.
// Skipped when HyperFrames or the agent binary is not installed.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const agent = process.env.TREX_AGENT ?? path.join(root, "trex-cli/target/debug/trex-agent");
const haveCli = spawnSync("hyperframes", ["--version"]).status === 0 || existsSync(path.join(homedir(), ".local/bin/hyperframes"));
if (!existsSync(agent) || !haveCli) {
  console.log(`skipped: needs a built trex-agent (${agent}) and the HyperFrames CLI`);
  process.exit(0);
}
const workspace = mkdtempSync(path.join(tmpdir(), "trex-hyperframes-e2e-"));

class Server {
  constructor(mode) {
    this.child = spawn(agent, ["apps-mcp", "--mode", mode, "--cwd", workspace, "--apps", "hyperframes"], { stdio: ["pipe", "pipe", "inherit"] });
    this.pending = new Map();
    this.n = 0;
    let buffer = "";
    this.child.stdout.on("data", chunk => {
      buffer += chunk;
      for (let i = buffer.indexOf("\n"); i >= 0; i = buffer.indexOf("\n")) {
        const message = JSON.parse(buffer.slice(0, i));
        buffer = buffer.slice(i + 1);
        this.pending.get(message.id)?.(message);
      }
    });
  }
  rpc(method, params = {}) {
    const id = ++this.n;
    return new Promise(resolve => { this.pending.set(id, resolve); this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); });
  }
  async tool(name, args = {}) {
    const response = await this.rpc("tools/call", { name, arguments: args });
    assert.ok(response.result, `${name}: ${JSON.stringify(response.error)}`);
    const { content = [], isError = false, structuredContent } = response.result;
    return { isError, structured: structuredContent, text: content.filter(c => c.type === "text").map(c => c.text).join("\n"), images: content.filter(c => c.type === "image") };
  }
  async init() { await this.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "0" } }); return this; }
  close() { this.child.stdin.end(); }
}
const size = image => {
  const bytes = Buffer.from(image.data, "base64");
  assert.deepEqual([...bytes.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], "a real PNG");
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
};
const step = async (label, run) => { const t = Date.now(); await run(); console.log(`ok  ${label} (${((Date.now() - t) / 1000).toFixed(1)}s)`); };

let full = null, plan = null, previewing = false;
try {
  full = await new Server("full").init();
  await step("the catalog has the eight HyperFrames tools and nothing from other apps", async () => {
    const names = (await full.rpc("tools/list")).result.tools.map(t => t.name).sort();
    assert.deepEqual(names, ["hyperframes_check", "hyperframes_docs", "hyperframes_doctor", "hyperframes_init", "hyperframes_preview", "hyperframes_project", "hyperframes_render", "hyperframes_snapshot"]);
  });
  await step("outside a project the error says how to create one", async () => {
    const reply = await full.tool("hyperframes_project");
    assert.equal(reply.isError, true);
    assert.match(reply.text, /hyperframes_init/);
  });
  await step("hyperframes_docs lists the topics and reads one", async () => {
    assert.match((await full.tool("hyperframes_docs")).text, /compositions/);
    assert.ok((await full.tool("hyperframes_docs", { topic: "data-attributes" })).text.length > 200);
    assert.equal((await full.tool("hyperframes_docs", { topic: "../etc" })).isError, true);
  });
  await step("hyperframes_doctor reports the machine", async () => {
    const reply = await full.tool("hyperframes_doctor");
    assert.equal(reply.isError, false, reply.text);
    assert.match(reply.text, /HyperFrames \d+\.\d+\.\d+/);
  });
  await step("hyperframes_init creates a project in a new folder and refuses to reuse it", async () => {
    const reply = await full.tool("hyperframes_init", { name: "videos/intro", resolution: "landscape" });
    assert.equal(reply.isError, false, reply.text);
    assert.ok(existsSync(path.join(workspace, "videos/intro/index.html")));
    assert.equal((await full.tool("hyperframes_init", { name: "videos/intro" })).isError, true);
  });
  await step("hyperframes_project describes it", async () => {
    const reply = await full.tool("hyperframes_project", { project: "videos/intro" });
    assert.equal(reply.isError, false, reply.text);
    assert.match(reply.text, /1920x1080/);
    assert.ok(reply.structured.compositions.length >= 1);
  });
  await step("hyperframes_check passes a fresh project, scope=lint too", async () => {
    const reply = await full.tool("hyperframes_check", { project: "videos/intro" });
    assert.equal(reply.isError, false, reply.text);
    assert.match(reply.text, /^check (PASSED|FAILED)/);
    assert.match((await full.tool("hyperframes_check", { project: "videos/intro", scope: "lint" })).text, /^lint PASSED/);
  });
  await step("a broken composition fails the gate with findings that say how to fix them", async () => {
    const file = path.join(workspace, "videos/intro/index.html");
    const original = readFileSync(file, "utf8");
    // A composition must be deterministic: Date.now() is an error the gate has to catch.
    writeFileSync(file, original.replace("</body>", "<script>var t = Date.now();</script></body>"));
    const reply = await full.tool("hyperframes_check", { project: "videos/intro", scope: "lint" });
    writeFileSync(file, original);
    assert.equal(reply.isError, false, "findings are an answer, not a tool failure");
    assert.match(reply.text, /^lint FAILED: 1 error\(s\)/, reply.text);
    assert.match(reply.text, /\[error\] lint\/non_deterministic_code/);
    assert.equal(reply.structured.findings[0].code, "non_deterministic_code");
    assert.ok(reply.structured.findings[0].fixHint.length > 10, "the finding says how to fix it");
  });
  await step("hyperframes_snapshot returns real images: one sheet for many frames, separate frames for few", async () => {
    const sheet = await full.tool("hyperframes_snapshot", { project: "videos/intro", frames: 5 });
    assert.equal(sheet.isError, false, sheet.text);
    assert.equal(sheet.images.length, 1);
    assert.ok(size(sheet.images[0])[0] <= 1568);
    const frames = await full.tool("hyperframes_snapshot", { project: "videos/intro", at: [1, 5], maxEdge: 640 });
    assert.ok(frames.images.length >= 2);
    for (const image of frames.images) assert.ok(Math.max(...size(image)) <= 640);
    assert.match(frames.structured.frames[0].path, /^videos\/intro\/\.hyperframes\/artifacts\/snapshots\//);
    // A region with no width or height used to come back as a blank picture; now the model is told.
    const empty = await full.tool("hyperframes_snapshot", { project: "videos/intro", at: [1], zoom: "120,880,0,0" });
    assert.equal(empty.isError, true);
    assert.match(empty.text, /positive width and height/);
  });
  await step("hyperframes_render writes a real file inside the project and reports it, with a poster", async () => {
    const reply = await full.tool("hyperframes_render", { project: "videos/intro", output: "renders/draft.mp4", quality: "draft", poster: true });
    assert.equal(reply.isError, false, reply.text);
    assert.match(reply.text, /Rendered videos\/intro\/renders\/draft\.mp4/);
    assert.ok(existsSync(path.join(workspace, "videos/intro/renders/draft.mp4")));
    assert.ok(reply.structured.file.bytes > 1000);
    assert.equal(reply.images.length, 1, "a poster frame from the middle");
    assert.equal(reply.structured.poster, "videos/intro/renders/draft.poster.png", "the poster is a file the model can name");
    assert.ok(existsSync(path.join(workspace, "videos/intro/renders/draft.poster.png")));
    assert.equal((await full.tool("hyperframes_render", { project: "videos/intro", output: "../escape.mp4" })).isError, true);
  });
  await step("hyperframes_preview starts a background Studio that answers, reports it and stops it", async () => {
    const port = 3100 + Math.floor(Math.random() * 500);
    const started = await full.tool("hyperframes_preview", { project: "videos/intro", port });
    assert.equal(started.isError, false, started.text);
    previewing = true;
    const url = started.structured.studioUrl;
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+/);
    assert.equal((await fetch(url)).status, 200);
    assert.match((await full.tool("hyperframes_preview", { project: "videos/intro", action: "status" })).text, /running/);
    assert.match((await full.tool("hyperframes_preview", { project: "videos/intro", action: "stop" })).text, /stopped/);
    previewing = false;
  });
  await step("a planning server offers only the read tools and refuses writes", async () => {
    plan = await new Server("plan").init();
    assert.deepEqual((await plan.rpc("tools/list")).result.tools.map(t => t.name).sort(), ["hyperframes_check", "hyperframes_docs", "hyperframes_doctor", "hyperframes_project"]);
    assert.equal((await plan.tool("hyperframes_render", { project: "videos/intro", output: "x.mp4" })).isError, true);
    assert.equal((await plan.tool("hyperframes_check", { project: "videos/intro", scope: "lint" })).isError, false);
  });
  console.log("\nAll HyperFrames checks passed.");
} finally {
  if (previewing) await full.tool("hyperframes_preview", { project: "videos/intro", action: "stop" }).catch(() => {});
  plan?.close();
  full?.close();
  rmSync(workspace, { recursive: true, force: true });
}
