import assert from "node:assert/strict";
import test from "node:test";
import { load } from "./ts-loader.mjs";

const { configFailure, recoverConfig } = await load("configRecovery");
const saved = { version: 1, projects: [{ id: "p" }], settings: {}, ui: {} };

/** Answers the dialogs in order and records what was asked and which backend calls ran. */
function io(answers, { load = async () => saved, restore = async () => saved } = {}) {
  const asked = [], calls = [];
  return { asked, calls,
    confirm: async question => { asked.push(question); assert.ok(answers.length, `unexpected question: ${question.title}`); return answers.shift(); },
    load: async () => { calls.push("load"); return load(); },
    restore: async () => { calls.push("restore"); return restore(); } };
}
const corrupt = (extra = {}) => ({ kind: "corrupt", message: "no es válida", backup: "C:/cfg/config.json.corrupto-1", previous: false, ...extra });
const unreadable = { kind: "unreadable", message: "acceso denegado", backup: null, previous: false };

test("the backend's rejection is read field by field, and anything unknown counts as unreadable", () => {
  assert.deepEqual(configFailure({ kind: "corrupt", message: "m", backup: "b", previous: true }), { kind: "corrupt", message: "m", backup: "b", previous: true });
  // A failure nobody recognises must be the kind that never overwrites the file.
  for (const error of ["texto", new Error("boom"), null, undefined, 42, { kind: "otro" }, { kind: "corrupt", previous: "yes" }]) {
    const failure = configFailure(error);
    assert.equal(failure.kind, error?.kind === "corrupt" ? "corrupt" : "unreadable");
    assert.equal(failure.previous, false);
    assert.equal(failure.backup, null);
    assert.ok(failure.message.length > 0);
  }
  assert.equal(configFailure("texto").message, "texto");
  assert.equal(configFailure(new Error("boom")).message, "boom");
});

test("a file that cannot be read is retried, and declining never writes over it", async () => {
  const declined = io([false]);
  assert.deepEqual(await recoverConfig(unreadable, declined), { config: null, save: false });
  assert.deepEqual(declined.calls, []);
  assert.equal(declined.asked[0].confirmLabel, "Reintentar");
  assert.equal(declined.asked[0].tone, undefined, "nothing destructive is offered for a file that may be intact");
  assert.ok(!declined.asked.some(question => /cero/i.test(question.confirmLabel)), "starting from scratch is not offered while the file may be intact");

  const retried = io([true]);
  assert.deepEqual(await recoverConfig(unreadable, retried), { config: saved, save: true });
  assert.deepEqual(retried.calls, ["load"]);

  // Still locked on the second try, readable on the third.
  let attempts = 0;
  const stubborn = io([true, true], { load: async () => { if (++attempts < 2) throw { kind: "unreadable", message: "sigue bloqueado", backup: null, previous: false }; return saved; } });
  assert.deepEqual(await recoverConfig(unreadable, stubborn), { config: saved, save: true });
  assert.equal(stubborn.asked[1].message, "sigue bloqueado");
});

test("a retry that finds the file damaged moves on to the damaged-file choices", async () => {
  const turned = io([true, false], { load: async () => { throw corrupt(); } });
  assert.deepEqual(await recoverConfig(unreadable, turned), { config: null, save: false });
  assert.equal(turned.asked[1].confirmLabel, "Empezar de cero");
});

test("a damaged file without an earlier copy: start over only when asked, otherwise nothing is written", async () => {
  const fresh = io([true]);
  assert.deepEqual(await recoverConfig(corrupt(), fresh), { config: null, save: true });
  assert.equal(fresh.asked[0].tone, "danger");
  assert.match(fresh.asked[0].detail, /config\.json\.corrupto-1/, "the person is told where the damaged file was kept");

  const kept = io([false]);
  assert.deepEqual(await recoverConfig(corrupt(), kept), { config: null, save: false });
  assert.equal(kept.asked[0].cancelLabel, "Seguir sin guardar");
});

test("a damaged file with an earlier copy offers the copy first", async () => {
  const restored = io([true]);
  assert.deepEqual(await recoverConfig(corrupt({ previous: true }), restored), { config: saved, save: true });
  assert.deepEqual(restored.calls, ["restore"]);
  assert.equal(restored.asked[0].confirmLabel, "Restaurar la copia anterior");

  // Declining the copy (or pressing Esc) never starts over by itself: that needs its own confirmation.
  const other = io([false, false]);
  assert.deepEqual(await recoverConfig(corrupt({ previous: true }), other), { config: null, save: false });
  assert.deepEqual(other.calls, []);
  const scratch = io([false, true]);
  assert.deepEqual(await recoverConfig(corrupt({ previous: true }), scratch), { config: null, save: true });
});

test("a copy that turns out to be unusable falls back to the choices without a copy", async () => {
  const broken = io([true, false], { restore: async () => { throw new Error("la copia no sirve"); } });
  assert.deepEqual(await recoverConfig(corrupt({ previous: true }), broken), { config: null, save: false });
  assert.deepEqual(broken.calls, ["restore"]);
  assert.equal(broken.asked[1].confirmLabel, "Empezar de cero");
});

test("every way out of a dialog that is not an explicit choice leaves the disk alone", async () => {
  // Esc and closing resolve false: across every failure shape, all-false answers end without saving.
  for (const failure of [unreadable, corrupt(), corrupt({ previous: true }), corrupt({ backup: null })]) {
    const closed = io([false, false, false]);
    assert.deepEqual(await recoverConfig(failure, closed), { config: null, save: false });
    assert.deepEqual(closed.calls, []);
  }
});
