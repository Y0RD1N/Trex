import assert from "node:assert/strict";
import test from "node:test";
import { load } from "./ts-loader.mjs";

const { trayActivity } = await load("tray");
const { normalizeConfig, DEFAULT_SETTINGS } = await load("api");

test("seguir en la bandeja viene encendido y la elección de apagarlo se conserva al guardar", () => {
  assert.equal(DEFAULT_SETTINGS.closeToTray, true);
  assert.equal(normalizeConfig({}).settings.closeToTray, true, "una configuración anterior también se queda en la bandeja");
  assert.equal(normalizeConfig({ settings: { closeToTray: false } }).settings.closeToTray, false);
  assert.equal(normalizeConfig({ settings: { closeToTray: "no" } }).settings.closeToTray, true, "solo un booleano cambia el valor por defecto");
});

test("el menú de la bandeja cuenta los agentes que trabajan y los que esperan respuesta", () => {
  const tab = (kind, activity, exited = false) => ({ kind, activity, exited });
  assert.deepEqual(trayActivity([]), { working: 0, waiting: 0 });
  assert.deepEqual(trayActivity([
    tab("claude", "working"), tab("codex", "working"), tab("claude", "waiting"), tab("trex", "idle"),
    tab("shell", "working"), tab("claude", "working", true),
  ]), { working: 2, waiting: 1 }, "las terminales y los procesos terminados no cuentan");
});
