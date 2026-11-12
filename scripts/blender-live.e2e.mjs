// End-to-end check of the live Blender integration with a REAL Blender (not part of `npm test`).
//
//   xvfb-run -a -s "-screen 0 1600x900x24 +extension GLX +render" node scripts/blender-live.e2e.mjs
//   (add LIBGL_ALWAYS_SOFTWARE=1 and BLENDER_PATH=<wrapper adding --gpu-backend opengl> on a machine without a GPU)
//
// It starts `trex-agent apps-mcp` like Claude, Codex and Antigravity do, lets it open Blender with the Trex
// bridge, and drives every tool over MCP. Config, bridge files and data live in a temporary folder, so the
// user's Blender preferences and add-ons are never touched. TREX_AGENT overrides the binary to use.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const agent = process.env.TREX_AGENT ?? path.join(root, "trex-cli/target/debug/trex-agent");
const haveBlender = process.env.BLENDER_PATH ? existsSync(process.env.BLENDER_PATH) : spawnSync("blender", ["--version"]).status === 0;
if (!existsSync(agent) || !haveBlender) {
  console.log(`skipped: needs a built trex-agent (${agent}) and Blender`);
  process.exit(0);
}

const scratch = mkdtempSync(path.join(tmpdir(), "trex-blender-e2e-"));
for (const dir of ["config", "scripts", "data", "bridge", "project"]) mkdirSync(path.join(scratch, dir));
const env = { ...process.env, BLENDER_USER_CONFIG: path.join(scratch, "config"), BLENDER_USER_SCRIPTS: path.join(scratch, "scripts"),
  XDG_DATA_HOME: path.join(scratch, "data"), TREX_BRIDGE_DIR: path.join(scratch, "bridge") };

class Server {
  constructor(mode) {
    this.child = spawn(agent, ["apps-mcp", "--mode", mode, "--cwd", path.join(scratch, "project")], { env, stdio: ["pipe", "pipe", "inherit"] });
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
const png = image => {
  const bytes = Buffer.from(image.data, "base64");
  assert.deepEqual([...bytes.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], "a real PNG");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), bytes: bytes.length };
};
const step = async (label, run) => { const t = Date.now(); await run(); console.log(`ok  ${label} (${((Date.now() - t) / 1000).toFixed(1)}s)`); };

let session = null, full = null, plan = null;
try {
  full = await new Server("full").init();
  await step("the catalog has the live tools and the headless runner", async () => {
    const names = (await full.rpc("tools/list")).result.tools.map(t => t.name);
    for (const name of ["blender_open", "blender_scene", "blender_view", "blender_render", "blender_exec", "blender_undo"]) assert.ok(names.includes(name), name);
  });
  await step("with no Blender running the error says what to do", async () => {
    const reply = await full.tool("blender_scene");
    assert.equal(reply.isError, true);
    assert.match(reply.text, /blender_open/);
  });
  await step("blender_open starts Blender with the bridge, once", async () => {
    const opened = await full.tool("blender_open");
    assert.equal(opened.isError, false, opened.text);
    session = opened.structured.session;
    assert.equal((await full.tool("blender_open")).structured.alreadyRunning, true);
  });
  await step("blender_scene overview and datablocks", async () => {
    const overview = (await full.tool("blender_scene")).structured.scene;
    assert.equal(overview.mode, "OBJECT");
    assert.ok(overview.counts.MESH >= 1);
    assert.ok((await full.tool("blender_scene", { level: "datablocks" })).structured.scene.materials.count >= 1);
  });
  await step("blender_exec reports what changed and attaches a four-angle MATERIAL verification sheet", async () => {
    const reply = await full.tool("blender_exec", { code: `
import bpy
bpy.ops.mesh.primitive_uv_sphere_add(location=(2, 0, 1))
mat = bpy.data.materials.new('Rojo'); mat.use_nodes = True
mat.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = (0.9, 0.1, 0.1, 1)
bpy.context.object.data.materials.append(mat)
result = {'meshes': len([o for o in bpy.data.objects if o.type == 'MESH'])}` });
    assert.equal(reply.isError, false, reply.text);
    assert.deepEqual(reply.structured.changes.added, ["Sphere"]);
    assert.equal(reply.images.length, 1);
    assert.equal(reply.structured.verification.shading, "MATERIAL");
    assert.equal(reply.structured.verification.view, "sheet", "four angles, not only iso");
    assert.deepEqual([png(reply.images[0]).width, png(reply.images[0]).height], [1024, 576]);
    assert.match(reply.text, /only claim the views you can see/);
  });
  await step("variables persist and a Python error is a tool error with the traceback", async () => {
    await full.tool("blender_exec", { code: "kept = 41", verify: "none" });
    assert.match((await full.tool("blender_exec", { code: "result = kept + 1", verify: "none" })).text, /Result: 42/);
    const failed = await full.tool("blender_exec", { code: "raise RuntimeError('prueba')" });
    assert.equal(failed.isError, true);
    assert.match(failed.text, /RuntimeError: prueba/);
  });
  await step("blender_view: preset, 2x2 sheet and the real window without the unrendered margin", async () => {
    const iso = png((await full.tool("blender_view", { view: "iso", width: 640, height: 360 })).images[0]);
    assert.deepEqual([iso.width, iso.height], [640, 360]);
    const sheet = await full.tool("blender_view", { view: "sheet", shading: "MATERIAL" });
    assert.deepEqual([png(sheet.images[0]).width, png(sheet.images[0]).height], [1280, 720]);
    const window = png((await full.tool("blender_view", { view: "window" })).images[0]);
    assert.ok(window.width >= 800 && window.height >= 500);
  });
  await step("blender_render returns the image and restores the scene settings", async () => {
    const before = (await full.tool("blender_scene")).structured.scene.render;
    assert.deepEqual(png((await full.tool("blender_render", { width: 320, height: 180, engine: "BLENDER_WORKBENCH" })).images[0]).width, 320);
    assert.deepEqual((await full.tool("blender_scene")).structured.scene.render, before);
  });
  await step("blender_undo steps back", async () => {
    await full.tool("blender_exec", { code: "import bpy; bpy.ops.mesh.primitive_cube_add()", verify: "none" });
    assert.equal((await full.tool("blender_undo")).isError, false);
  });
  await step("the user's pause blocks every tool until they resume", async () => {
    // Simulates the status-bar click, and the click that resumes 2.5 s later.
    await full.tool("blender_exec", { verify: "none", code: "import bpy\nbpy.ops.trex.toggle_pause()\nbpy.app.timers.register(lambda: bpy.ops.trex.toggle_pause() and None, first_interval=2.5)" });
    const refused = await full.tool("blender_scene");
    assert.equal(refused.isError, true);
    assert.match(refused.text, /paused/);
    await new Promise(resolve => setTimeout(resolve, 3200));
    assert.equal((await full.tool("blender_scene")).isError, false);
  });
  await step("a planning server offers only reads and refuses writes", async () => {
    plan = await new Server("plan").init();
    assert.deepEqual((await plan.rpc("tools/list")).result.tools.map(t => t.name).sort(), ["blender_render", "blender_scene", "blender_view"]);
    assert.equal((await plan.tool("blender_exec", { code: "x=1" })).isError, true);
    assert.equal((await plan.tool("blender_view", { view: "top" })).images.length, 1);
  });
  console.log("\nAll live Blender checks passed.");
} finally {
  plan?.close();
  full?.close();
  if (session) { try { process.kill(session, "SIGTERM"); } catch { /* already gone */ } }
  rmSync(scratch, { recursive: true, force: true });
}
