import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../src/hooks/useFloatingPosition.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;

function harness({ track = false, cssMax = 784, nested = false } = {}) {
  const previous = Object.fromEntries(['window', 'Node', 'ResizeObserver', 'requestAnimationFrame', 'cancelAnimationFrame', 'getComputedStyle'].map(key => [key, globalThis[key]]));
  const listeners = new Map(), frames = new Map(), observers = new Set(), slots = [], effects = [];
  let cursor = 0, dirty = false, nextFrame = 0, writes = 0;
  class Node {
    children = [];
    contains(target) { return target === this || this.children.some(child => child.contains(target)); }
    querySelectorAll() { return this.children; }
  }
  const window = {
    innerWidth: 1280, innerHeight: 800, visualViewport: null,
    addEventListener(name, callback) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(callback); },
    removeEventListener(name, callback) { listeners.get(name)?.delete(callback); },
  };
  const properties = new Map();
  const surface = new Node();
  let top = 0, left = 0;
  Object.defineProperties(surface, {
    limit: { get: () => Math.min(cssMax, Number.parseFloat(properties.get('--floating-max-height') ?? 'Infinity')) },
    offsetWidth: { get: () => 232 }, offsetHeight: { get: () => Math.min(848, surface.limit) },
    clientHeight: { get: () => surface.offsetHeight - 2 }, scrollHeight: { get: () => Math.max(846, surface.clientHeight) },
    scrollTop: { get: () => top, set: value => { top = Math.max(0, Math.min(value, surface.scrollHeight - surface.clientHeight)); } },
    scrollLeft: { get: () => left, set: value => { left = value; } },
  });
  let bodyTop = 0;
  const body = new Node();
  Object.defineProperties(body, {
    clientHeight: { get: () => surface.clientHeight - 70 }, scrollHeight: { get: () => 750 },
    scrollTop: { get: () => bodyTop, set: value => { bodyTop = Math.max(0, Math.min(value, body.scrollHeight - body.clientHeight)); } },
    scrollLeft: { get: () => 0 },
  });
  if (nested) surface.children.push(body);
  // Browsers clamp scroll offsets as soon as a height constraint is relaxed.
  const reflow = () => { surface.scrollTop = surface.scrollTop; if (nested) body.scrollTop = body.scrollTop; };
  surface.style = {
    setProperty(name, value) { writes++; properties.set(name, value); reflow(); },
    removeProperty(name) { writes++; properties.delete(name); reflow(); },
  };
  const element = new Node();
  element.rect = { left: 24, right: 134, top: 230, bottom: 264 };
  element.getBoundingClientRect = () => ({ ...element.rect });
  const anchor = { element }, ref = { current: surface };
  globalThis.window = window;
  globalThis.Node = Node;
  globalThis.ResizeObserver = class {
    constructor(callback) { this.callback = callback; observers.add(this); }
    observe() {}
    disconnect() { observers.delete(this); }
  };
  globalThis.requestAnimationFrame = callback => { frames.set(++nextFrame, callback); return nextFrame; };
  globalThis.cancelAnimationFrame = frame => frames.delete(frame);
  globalThis.getComputedStyle = () => ({ maxHeight: `${surface.limit}px` });
  const react = {
    useState(initial) {
      const slot = slots[cursor++] ??= { value: initial };
      return [slot.value, next => { const value = typeof next === 'function' ? next(slot.value) : next; if (!Object.is(value, slot.value)) { slot.value = value; dirty = true; } }];
    },
    useRef(initial) { return slots[cursor++] ??= { current: initial }; },
    useLayoutEffect(effect, deps) {
      const index = cursor++;
      if (!slots[index] || !deps || !deps.every((value, at) => Object.is(value, slots[index].deps?.[at]))) {
        effects.push(() => { slots[index]?.cleanup?.(); slots[index] = { deps, cleanup: effect() }; });
      }
    },
  };
  const exports = {};
  new Function('require', 'exports', compiled)(specifier => { assert.equal(specifier, 'react'); return react; }, exports);
  let position;
  const render = () => {
    for (let iteration = 0; iteration < 15; iteration++) {
      cursor = 0; dirty = false;
      position = exports.useFloatingPosition(anchor, ref, { track });
      for (const effect of effects.splice(0)) effect();
      if (!dirty) return position;
    }
    throw new Error('Floating layer did not settle');
  };
  render();
  return {
    surface, body, element, window, properties, get writes() { return writes; }, get position() { return position; }, render,
    scroll(target) { for (const callback of listeners.get('scroll') ?? []) callback({ target }); if (dirty) render(); },
    frame() { const current = [...frames.values()]; frames.clear(); current.forEach(callback => callback()); if (dirty) render(); },
    resize() { for (const observer of observers) observer.callback(); if (dirty) render(); },
    restore() {
      for (const slot of slots) slot?.cleanup?.();
      assert.equal(frames.size, 0); assert.equal(observers.size, 0);
      for (const callbacks of listeners.values()) assert.equal(callbacks.size, 0);
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
      }
    },
  };
}

test('scrolling a constrained menu reaches later items without remeasuring or snapping back', () => {
  const h = harness();
  try {
    h.surface.scrollTop = 280;
    const writes = h.writes;
    h.scroll(h.surface);
    assert.equal(h.surface.scrollTop, 280);
    assert.equal(h.writes, writes);
    assert.ok(h.position.top + h.surface.offsetHeight <= 792);
  } finally { h.restore(); }
});

test('a React render and a resize measurement preserve the menu scroll and horizontal offset', () => {
  const h = harness();
  try {
    h.surface.scrollTop = 280; h.surface.scrollLeft = 12;
    h.render(); h.resize();
    assert.equal(h.surface.scrollTop, 280);
    assert.equal(h.surface.scrollLeft, 12);
  } finally { h.restore(); }
});

test('nested confirmation bodies retain their scroll while the anchor moves', () => {
  const h = harness({ track: true, nested: true });
  try {
    h.body.scrollTop = 250;
    const writes = h.writes;
    h.scroll(h.body);
    assert.equal(h.writes, writes);
    h.element.rect.top += 10; h.element.rect.bottom += 10;
    h.frame();
    assert.equal(h.position.top, 280);
    assert.equal(h.body.scrollTop, 250);
    h.render();
    assert.equal(h.body.scrollTop, 250);
  } finally { h.restore(); }
});

test('tracking a stationary anchor does not resize or invalidate the floating layer every frame', () => {
  const h = harness({ track: true });
  try {
    const writes = h.writes;
    for (let index = 0; index < 10; index++) h.frame();
    assert.equal(h.writes, writes);
    h.element.rect.top += 12; h.element.rect.bottom += 12;
    h.frame();
    assert.equal(h.position.top, 282);
    assert.ok(h.writes > writes);
  } finally { h.restore(); }
});

test('selectors honor their CSS height cap and still reposition for external scrolling', () => {
  const h = harness({ cssMax: 380 });
  try {
    assert.equal(h.surface.offsetHeight, 380);
    assert.equal(h.position.side, 'bottom');
    h.element.rect.top = 650; h.element.rect.bottom = 684;
    h.scroll(h.element);
    assert.equal(h.position.side, 'top');
    assert.equal(h.position.top, 264);
    assert.equal(h.surface.offsetHeight, 380);
  } finally { h.restore(); }
});
