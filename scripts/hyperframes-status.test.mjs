import assert from "node:assert/strict";
import test from "node:test";
import { load } from "./ts-loader.mjs";
const { describeHyperframes } = await load("hyperframesStatus");

const skills = (over = {}) => ({ location: "/home/ana/.claude/skills", agent: "claude-code", updateAvailable: false, current: 4, outdated: 0, missing: 5, coreMissing: 0, ...over });
const found = (over = {}) => ({ found: true, version: "0.9.10", latestVersion: "0.9.32", updateAvailable: true, problems: [], optional: [], doctorRan: true, skills: skills(), ...over });

test("without a project or before the answer nothing can be pressed", () => {
  for (const summary of [describeHyperframes(null, false), describeHyperframes(null)]) assert.equal(summary.skillsLabel, null);
  assert.equal(describeHyperframes(null, false).tone, "idle");
  assert.equal(describeHyperframes(null).tone, "loading");
});
test("a missing CLI says how to get it and that Trex will not install it", () => {
  const summary = describeHyperframes({ found: false });
  assert.equal(summary.tone, "missing");
  assert.match(summary.lines.join(" "), /npm install -g hyperframes.*Trex no lo instala/);
  assert.equal(summary.skillsLabel, null);
});
test("the version line mentions a newer release but leaves updating to the user", () => {
  const summary = describeHyperframes(found());
  assert.equal(summary.tone, "ready", "a version nag is not a problem");
  assert.match(summary.lines[0], /HyperFrames 0\.9\.10 · hay una versión nueva \(0\.9\.32\); la actualizas tú/);
  assert.doesNotMatch(describeHyperframes(found({ updateAvailable: false })).lines[0], /nueva/);
});
test("problems that block rendering are named, and optional extras are only counted", () => {
  const summary = describeHyperframes(found({ problems: ["FFmpeg: Not found (apt install ffmpeg)", "Chrome: missing"], optional: ["TTS (Kokoro): x", "BGM: y"] }));
  assert.equal(summary.tone, "attention");
  assert.equal(summary.label, "Revisar entorno");
  assert.match(summary.lines.join("\n"), /Falta o falla: FFmpeg, Chrome\./);
  assert.match(summary.lines.join("\n"), /2 extras opcionales sin instalar/);
  assert.equal(describeHyperframes(found({ problems: ["A: 1", "B: 2", "C: 3", "D: 4", "E: 5"] })).lines.join(" ").includes("A, B, C, D…"), true);
  assert.match(describeHyperframes(found({ doctorRan: false })).lines.join(" "), /No se pudo ejecutar la comprobación del entorno/);
});
test("the skills button says what it will do for each state of the skills", () => {
  const label = over => describeHyperframes(found({ skills: over === null ? null : skills(over) })).skillsLabel;
  assert.equal(label({}), "Reinstalar las skills");
  assert.equal(label({ outdated: 2 }), "Actualizar las skills");
  assert.equal(label({ coreMissing: 1, current: 3 }), "Instalar las skills");
  assert.equal(label({ current: 0, missing: 9 }), "Instalar las skills");
  assert.equal(label(null), "Instalar las skills");
  const text = over => describeHyperframes(found({ skills: skills(over) })).lines.join(" ");
  assert.match(text({}), /4 skills al día \(5 más disponibles bajo demanda\)/);
  assert.match(text({ current: 1, missing: 0 }), /1 skill al día\./);
  assert.match(text({ outdated: 1 }), /1 skill desactualizada/);
  assert.match(text({ coreMissing: 2 }), /Faltan skills principales/);
  assert.match(describeHyperframes(found({ skills: null })).lines.join(" "), /No se pudo comprobar el estado de las skills/);
  assert.equal(describeHyperframes(found()).skillsLocation, "/home/ana/.claude/skills");
});
