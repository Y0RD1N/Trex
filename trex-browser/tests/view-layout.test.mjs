import assert from 'node:assert/strict';
import { it } from 'node:test';
import { setBounds, setVisible, keepOnTop, usableArea } from '../shell/view-layout.mjs';

it('a minimized or empty client area is never used to lay views out', () => {
  assert.equal(usableArea({ width: 1361, height: 862 }, false), true);
  assert.equal(usableArea({ width: 1361, height: 862 }, true), false);
  assert.equal(usableArea({ width: 0, height: 0 }, false), false);
  assert.equal(usableArea({ width: 1361, height: 0 }, false), false);
});

it('repeated activity preserves native bounds and visibility until they actually change', () => {
  const calls = [], view = { bounds: { x: 7, y: 7, width: 1280, height: 800 }, visible: true,
    getBounds() { return this.bounds; }, getVisible() { return this.visible; },
    setBounds(value) { calls.push('bounds'); this.bounds = value; }, setVisible(value) { calls.push('visible'); this.visible = value; } };
  for (let i = 0; i < 100; i++) { setBounds(view, { ...view.bounds }); setVisible(view, true); }
  assert.deepEqual(calls, []);
  setBounds(view, { ...view.bounds, width: 640 }); setVisible(view, false);
  assert.deepEqual(calls, ['bounds', 'visible']);
});

it('a new background tab never detaches or raises the foreground and overlays', () => {
  const chrome = {}, active = {}, cursor = {}, island = {}, dock = {}, background = {}, calls = [];
  const parent = { children: [chrome, active, cursor, island, dock], addChildView(view) {
    calls.push(view); this.children = this.children.filter(child => child !== view); this.children.push(view);
  } };
  for (let i = 0; i < 100; i++) keepOnTop(parent, [active, cursor, island, dock]);
  parent.children.unshift(background); keepOnTop(parent, [active, cursor, island, dock]);
  assert.deepEqual(calls, []);
  keepOnTop(parent, [background, cursor, island, dock]);
  assert.deepEqual(parent.children.slice(-4), [background, cursor, island, dock]);
  assert.equal(calls.includes(active), false);
  const changes = calls.length;
  keepOnTop(parent, [background, cursor, island, dock]); assert.equal(calls.length, changes);
  keepOnTop(parent, [chrome]); assert.equal(parent.children.at(-1), chrome);
});
