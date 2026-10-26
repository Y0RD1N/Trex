import assert from "node:assert/strict";
import test from "node:test";
import { load } from "./ts-loader.mjs";

const { enterAfterPaint, motionDuration, waitForMotion } = await load("motion");

function paintHarness() {
  const timers = timerHarness(), previous = [globalThis.requestAnimationFrame, globalThis.cancelAnimationFrame];
  const frames = new Map(); let id = 0;
  globalThis.requestAnimationFrame = callback => { frames.set(++id, callback); return id; };
  globalThis.cancelAnimationFrame = frame => frames.delete(frame);
  return { timers, frames, paint() { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback()); },
    restore() { timers.restore(); [globalThis.requestAnimationFrame, globalThis.cancelAnimationFrame] = previous; } };
}

test('dialog entrance becomes visible when WebKit never delivers a paint frame', () => {
  const h = paintHarness();
  try {
    let entered = 0; enterAfterPaint(() => entered++);
    assert.equal(entered, 0); assert.equal([...h.timers.pending.values()][0].delay, 100);
    h.timers.fire(); assert.equal(entered, 1); assert.equal(h.frames.size, 0);
  } finally { h.restore(); }
});

test('a stalled second paint cannot keep a mounted dialog invisible', () => {
  const h = paintHarness();
  try {
    let entered = 0; enterAfterPaint(() => entered++); h.paint();
    assert.equal(entered, 0); h.timers.fire(); assert.equal(entered, 1); assert.equal(h.frames.size, 0);
  } finally { h.restore(); }
});

test('normal dialog paint completes once and clears its fallback', () => {
  const h = paintHarness();
  try {
    let entered = 0; enterAfterPaint(() => entered++); h.paint(); h.paint(); h.timers.fire();
    assert.equal(entered, 1); assert.equal(h.timers.pending.size, 0); assert.equal(h.frames.size, 0);
  } finally { h.restore(); }
});

test('closing or replacing a dialog cancels both entry paths and ignores a late frame', () => {
  const h = paintHarness();
  try {
    let entered = 0; const cancel = enterAfterPaint(() => entered++); h.paint();
    const late = [...h.frames.values()][0]; cancel(); late(); h.timers.fire();
    assert.equal(entered, 0); assert.equal(h.frames.size, 0); assert.equal(h.timers.pending.size, 0);
  } finally { h.restore(); }
});

function timerHarness() {
  const previous = globalThis.window;
  const pending = new Map();
  let next = 0;
  globalThis.window = {
    setTimeout(callback, delay) { const id = ++next; pending.set(id, { callback, delay }); return id; },
    clearTimeout(id) { pending.delete(id); },
  };
  return {
    pending,
    fire() { const callbacks = [...pending.values()]; pending.clear(); callbacks.forEach(({ callback }) => callback()); },
    restore() { if (previous === undefined) delete globalThis.window; else globalThis.window = previous; },
  };
}

function animation(target, { duration = 160, currentTime = 0, playbackRate = 1, playState = "running" } = {}) {
  let resolve;
  let reject;
  const finished = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { effect: { target, getComputedTiming: () => ({ endTime: duration }) }, currentTime, playbackRate, playState, finished, resolve, reject };
}

const tick = () => new Promise(resolve => setImmediate(resolve));

test("motion duration handles mixed units, repeated delays and finite animation counts", () => {
  assert.equal(motionDuration({
    transitionDuration: "100ms, .2s, 50ms", transitionDelay: "-.02s, 40ms",
    animationDuration: ".3s, 10s", animationDelay: "50ms", animationIterationCount: "2, infinite",
  }), 650);
  assert.equal(motionDuration({
    transitionDuration: "0s", transitionDelay: "0s",
    animationDuration: "1s", animationDelay: "0s", animationIterationCount: "infinite",
  }), 0);
});

test("a layer stays mounted until both its veil and marked surface finish", async () => {
  const timers = timerHarness();
  try {
    const card = {};
    const root = { querySelectorAll: () => [card] };
    const veilMotion = animation(root);
    const cardMotion = animation(card, { duration: 220 });
    root.getAnimations = () => [veilMotion, cardMotion];
    let completed = 0;
    waitForMotion(root, () => completed++);
    veilMotion.resolve();
    await tick();
    assert.equal(completed, 0);
    cardMotion.resolve();
    await tick();
    assert.equal(completed, 1);
    assert.equal(timers.pending.size, 0);
  } finally { timers.restore(); }
});

test("animated controls and infinite animations cannot hold an exiting layer", async () => {
  const timers = timerHarness();
  try {
    const card = {};
    const root = { querySelectorAll: () => [card] };
    const exit = animation(root);
    root.getAnimations = () => [exit, animation({}, { duration: 12000 }), animation(card, { duration: Infinity })];
    let completed = false;
    waitForMotion(root, () => { completed = true; });
    exit.resolve();
    await tick();
    assert.equal(completed, true);
    assert.equal(timers.pending.size, 0);
  } finally { timers.restore(); }
});

test("reopening cancels an old removal without cancelling the visual transition", async () => {
  const timers = timerHarness();
  try {
    const root = { querySelectorAll: () => [] };
    const oldExit = animation(root);
    root.getAnimations = () => [oldExit];
    let removed = 0;
    const cancel = waitForMotion(root, () => removed++);
    cancel();
    assert.equal(timers.pending.size, 0);
    const nextExit = animation(root);
    root.getAnimations = () => [nextExit];
    waitForMotion(root, () => removed++);
    oldExit.reject(new Error("transition reversed"));
    await tick();
    assert.equal(removed, 0);
    nextExit.resolve();
    await tick();
    assert.equal(removed, 1);
  } finally { timers.restore(); }
});

test("stalled WebView promises have a bounded fallback based on remaining motion", () => {
  const timers = timerHarness();
  try {
    const root = { querySelectorAll: () => [] };
    root.getAnimations = () => [animation(root, { duration: 220, currentTime: 70 })];
    let completed = 0;
    waitForMotion(root, () => completed++);
    assert.equal([...timers.pending.values()][0].delay, 214);
    timers.fire();
    assert.equal(completed, 1);
  } finally { timers.restore(); }
});

test("a reversed animation waits only for its travel back to zero", () => {
  const timers = timerHarness();
  try {
    const root = { querySelectorAll: () => [] };
    root.getAnimations = () => [animation(root, { duration: 220, currentTime: 40, playbackRate: -2 })];
    const cancel = waitForMotion(root, () => {});
    assert.equal([...timers.pending.values()][0].delay, 84);
    cancel();
  } finally { timers.restore(); }
});

test("a layer without active motion closes immediately", () => {
  const timers = timerHarness();
  try {
    const root = { querySelectorAll: () => [], getAnimations: () => [] };
    let completed = false;
    waitForMotion(root, () => { completed = true; });
    assert.equal(completed, true);
    assert.equal(timers.pending.size, 0);
  } finally { timers.restore(); }
});

test("older WebViews read the actual CSS duration of the marked surface", () => {
  const timers = timerHarness();
  const previous = globalThis.getComputedStyle;
  try {
    const card = {};
    const root = { querySelectorAll: () => [card] };
    globalThis.getComputedStyle = element => ({
      transitionDuration: element === card ? "320ms" : "100ms", transitionDelay: "20ms",
      animationDuration: "0s", animationDelay: "0s", animationIterationCount: "1",
    });
    let completed = false;
    waitForMotion(root, () => { completed = true; });
    assert.equal([...timers.pending.values()][0].delay, 404);
    timers.fire();
    assert.equal(completed, true);
  } finally {
    timers.restore();
    if (previous === undefined) delete globalThis.getComputedStyle; else globalThis.getComputedStyle = previous;
  }
});
