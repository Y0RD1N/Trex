import assert from "node:assert/strict";
import test from "node:test";
import { load } from "./ts-loader.mjs";
const { describeBridge, describeSession } = await load("blenderBridge");

const found = { found: true, version: "5.2.2 LTS", kind: "binary" };
const addon = (over = {}) => ({ installed: true, enabled: true, upToDate: true, path: "/x/trex_bridge.py", ...over });

test("while the state is unknown nothing can be pressed", () => {
  const summary = describeBridge(null);
  assert.equal(summary.tone, "loading");
  assert.deepEqual([summary.canOpen, summary.canUninstall, summary.installLabel], [false, false, null]);
});
test("without Blender there is nothing to open or install, and the card says what to do", () => {
  const summary = describeBridge({ blender: { found: false }, addon: null, sessions: [] });
  assert.equal(summary.tone, "missing");
  assert.match(summary.lines.join(" "), /Instala Blender/);
  assert.deepEqual([summary.canOpen, summary.canUninstall, summary.installLabel], [false, false, null]);
});
test("a running bridge is shown per Blender, with file, unsaved changes and pause", () => {
  const sessions = [
    { pid: 1, version: "5.2.2 LTS", file: "/home/ana/proyectos/cafe.blend", dirty: true, paused: false },
    { pid: 2, version: "5.2.2 LTS", file: null, dirty: false, paused: true },
  ];
  const summary = describeBridge({ blender: found, addon: addon(), sessions });
  assert.equal(summary.tone, "ready");
  assert.deepEqual(summary.lines, ["Blender 5.2.2 LTS · cafe.blend · con cambios sin guardar", "Blender 5.2.2 LTS · sin guardar · en pausa"]);
  assert.equal(describeSession({ pid: 3, version: "4.2", file: "C:\\obras\\sala.blend", dirty: false, paused: false }), "Blender 4.2 · sala.blend");
});
test("the install button says what it will do for each add-on state", () => {
  const label = over => describeBridge({ blender: found, addon: over === null ? null : addon(over), sessions: [] });
  assert.equal(label(null).installLabel, "Instalar el puente en mi Blender");
  assert.equal(label({ installed: false, enabled: false, upToDate: false }).installLabel, "Instalar el puente en mi Blender");
  assert.equal(label({}).installLabel, "Reinstalar el puente");
  assert.equal(label({ upToDate: false }).installLabel, "Actualizar el puente");
  assert.equal(label({ enabled: false }).installLabel, "Actualizar el puente");
  assert.equal(label({}).canUninstall, true);
  assert.equal(label(null).canUninstall, false);
  assert.equal(label(null).canOpen, true, "Trex can always open Blender with the bridge");
});
test("each idle state explains the add-on without promising what is not true", () => {
  const text = over => describeBridge({ blender: found, addon: over === null ? null : addon(over), sessions: [] }).lines.join(" ");
  assert.match(text(null), /Trex abre Blender con él/);
  assert.match(text({ enabled: false }), /desactivado en Blender/);
  assert.match(text({ upToDate: false }), /versión anterior/);
  assert.match(text({}), /se activa solo/);
});
