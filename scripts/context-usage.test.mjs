import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import { load } from "./ts-loader.mjs";

const chat = await load("chatState"), trex = await load("trexChat");
const catalog = trex.parseTrexModels([
  { id: "MiniMax-M3.1-Flash", contextWindow: 1_000_000, contextWindowSource: "documented" },
  { id: "small", contextWindow: 32_000, contextWindowSource: "remote" }, { id: "unknown" },
]);
const ready = (result = {}, models = catalog) => trex.trexReducer(chat.initialChatState("ask"), {
  type: "trexReady", models, result: { sessionId: "session", model: "MiniMax-M3.1-Flash", items: [], ...result },
});
const send = (state = ready(), id = "user") => trex.trexReducer(state, { type: "send", id, text: "Hello", now: 1 });
const complete = (state, usage, id = "user") => trex.trexReducer(state, { type: "trexEvent", method: "turn/completed", now: 2,
  params: { sessionId: "session", messageId: id, status: "completed", usage } });
const history = [{ kind: "text", id: "old", messageId: "old", text: "Historical answer", final: true }];

test("a real-shaped Trex terminal retains the catalog window when usage omits it", () => {
  const state = complete(send(), { inputTokens: 1_300, outputTokens: 200, contextTokens: 1_500, contextModel: "MiniMax-M3.1-Flash" });
  assert.equal(chat.shownUsage(state).window, 1_000_000);
  assert.equal(chat.shownUsage(state).used, 1_500);
  assert.equal(chat.contextPercent(chat.shownUsage(state)), .15);
  assert.equal(chat.contextTokensLabel(chat.shownUsage(state)), "1,5 k de 1 M tokens");
});

test("shownUsage fills a missing limit without overriding a measured deployment window", () => {
  const state = ready();
  const usage = { used: 1_300, window: null, parts: [], reserve: null, total: 5_000 };
  assert.deepEqual(chat.shownUsage({ ...state, usage }), { ...usage, window: 1_000_000 });
  assert.equal(chat.shownUsage({ ...state, usage: { ...usage, window: 500_000 } }).window, 500_000);
  assert.equal(chat.shownUsage({ ...state, model: "unknown", usage }).window, null);
});

test("a subsequent terminal retains a previously measured deployment limit", () => {
  const first = complete(send(), { contextTokens: 1_500, contextWindow: 500_000, contextModel: "MiniMax-M3.1-Flash" });
  const second = complete(send(first, "next"), { contextTokens: 2_000, contextModel: "MiniMax-M3.1-Flash" }, "next");
  assert.equal(second.usage.window, 500_000);
});

test("context is available before the first turn from the selected model", () => {
  assert.equal(chat.shownUsage(ready()).window, 1_000_000);
  assert.equal(chat.shownUsage(ready({ model: "small" })).window, 32_000);
  assert.equal(chat.shownUsage(ready({ model: "unknown" })), null);
});

test("session metadata supplies an offline limit and takes precedence over an older catalog", () => {
  const state = ready({ contextWindow: 500_000, contextWindowSource: "remote" });
  assert.equal(chat.shownUsage(state).window, 500_000);
  assert.equal(state.models[0].contextWindowSource, "remote");
  const offline = ready({ contextWindow: 1_000_000, contextWindowSource: "documented" }, []);
  assert.equal(chat.shownUsage(offline).window, 1_000_000);
});

test("a delayed startup response for A cannot replace B's selected window", () => {
  for (const model of ["small", "unknown"]) {
    let state = trex.trexReducer(send(), { type: "model", model });
    state = trex.trexReducer(state, { type: "trexReady", models: catalog, result: {
      sessionId: "session", model: "MiniMax-M3.1-Flash", items: [], contextWindow: 1_000_000,
    } });
    assert.equal(chat.shownUsage(state)?.window ?? null, model === "small" ? 32_000 : null);
    state = complete(send(state, "B"), { contextModel: model, contextTokens: 1_000, inputTokens: 800, outputTokens: 200 }, "B");
    assert.equal(state.usage.window, model === "small" ? 32_000 : null);
  }
});

test("a refreshed catalog that omits B cannot make pending A's capacity stand in for B", () => {
  const selected = trex.trexReducer(send(), { type: "model", model: "small" });
  const result = { sessionId: "session", model: "MiniMax-M3.1-Flash", items: [], contextWindow: 1_000_000 };
  const state = trex.trexReducer(selected, { type: "trexReady", models: [catalog[0]], result });
  assert.equal(chat.shownUsage(state).window, 32_000);
  const missing = trex.trexReducer({ ...selected, models: [] }, { type: "trexReady", models: [catalog[0]], result });
  assert.equal(chat.shownUsage(missing), null);
});

test("switching back to A after a delayed startup does not retain B's measured context", () => {
  for (const refreshed of [catalog, [catalog[0]]]) {
    let state = trex.trexReducer(send(), { type: "model", model: "small" });
    state = trex.trexReducer(state, { type: "trexReady", models: refreshed,
      result: { sessionId: "session", model: "MiniMax-M3.1-Flash", items: [], contextWindow: 1_000_000 } });
    state = complete(send(state, "B"), { contextModel: "small", contextTokens: 1_000, inputTokens: 800, outputTokens: 200 }, "B");
    assert.equal(state.usage.window, 32_000);
    state = trex.trexReducer(state, { type: "model", model: "MiniMax-M3.1-Flash" });
    assert.equal(state.usage.window, 1_000_000);
    assert.equal(chat.contextPercent(state.usage), null);
    state = complete(send(state, "A"), { contextModel: "MiniMax-M3.1-Flash", contextTokens: 2_000, inputTokens: 1_800, outputTokens: 200 }, "A");
    assert.equal(state.usage.window, 1_000_000);
    assert.equal(chat.contextPercent(state.usage), .2);
  }
});

test("restored usage is an absolute snapshot and never a new live completion", () => {
  const state = ready({ items: history, contextWindow: 1_000_000,
    usage: { contextTokens: 1_500, contextWindow: 1_000_000, contextModel: "MiniMax-M3.1-Flash", totalTokens: 42_000 } });
  assert.equal(state.usage.used, 1_500);
  assert.equal(state.usage.total, 42_000);
  assert.equal(state.lastCompletion, null);
  const next = complete(send(state), { inputTokens: 3_000, outputTokens: 500, contextTokens: 3_500, contextModel: "MiniMax-M3.1-Flash" });
  assert.equal(next.usage.total, 45_500);
});

test("an optional missing usage summary preserves same-session processed totals without reviving its measurement", () => {
  const measured = complete(send(), { contextTokens: 1_000, contextModel: "MiniMax-M3.1-Flash", inputTokens: 800, outputTokens: 200 });
  for (const usage of [undefined, { contextModel: "MiniMax-M3.1-Flash" }]) {
    const restored = trex.trexReducer(measured, { type: "trexReady", models: catalog,
      result: { sessionId: "session", model: "MiniMax-M3.1-Flash", items: history, usage } });
    assert.equal(restored.usage.total, 1_000);
    assert.equal(chat.contextPercent(restored.usage), null);
    const next = complete(send(restored, "next"), { contextTokens: 2_000, contextModel: "MiniMax-M3.1-Flash", inputTokens: 1_800, outputTokens: 200 }, "next");
    assert.equal(next.usage.total, 3_000);
  }
  const other = trex.trexReducer(measured, { type: "trexReady", models: catalog,
    result: { sessionId: "other", model: "MiniMax-M3.1-Flash", items: history } });
  assert.equal(other.usage.total, null);
  const authoritative = trex.trexReducer(measured, { type: "trexReady", models: catalog,
    result: { sessionId: "session", model: "MiniMax-M3.1-Flash", items: history, usage: { totalTokens: 500 } } });
  assert.equal(authoritative.usage.total, 500);
});

test("history with no measurement shows capacity without inventing zero usage or a percentage", () => {
  for (const result of [{ items: history }, { items: history, usage: { contextModel: "MiniMax-M3.1-Flash", totalTokens: 42_000 } }]) {
    const usage = chat.shownUsage(ready(result));
    assert.equal(usage.measured, false);
    assert.equal(chat.contextPercent(usage), null);
    assert.equal(chat.contextTokensLabel(usage), "Límite: 1 M tokens");
  }
});

test("changing a Trex model invalidates its old measurement while retaining cumulative tokens", () => {
  const measured = complete(send(), { contextTokens: 1_500, contextWindow: 1_000_000, inputTokens: 1_300, outputTokens: 200 });
  const changed = trex.trexReducer(measured, { type: "model", model: "small" });
  assert.equal(changed.usage.window, 32_000);
  assert.equal(changed.usage.total, 1_500);
  assert.equal(chat.contextPercent(changed.usage), null);
  const next = complete(send(changed, "next"), { contextTokens: 2_000, contextModel: "small", inputTokens: 1_800, outputTokens: 200 }, "next");
  assert.equal(next.usage.window, 32_000);
  assert.equal(chat.contextPercent(next.usage), 6.25);
});

test("a completion from A after selecting B cannot restore A's capacity or percentage", () => {
  const changed = trex.trexReducer(send(), { type: "model", model: "small" });
  const next = complete(changed, { contextTokens: 1_500, contextWindow: 1_000_000, contextModel: "MiniMax-M3.1-Flash", inputTokens: 1_300, outputTokens: 200 });
  assert.equal(next.usage.window, 32_000);
  assert.equal(next.usage.total, 1_500);
  assert.equal(chat.contextPercent(next.usage), null);
});

test("switching to an unknown model never inherits another model's limit", () => {
  const measured = complete(send(), { contextTokens: 1_500, contextWindow: 1_000_000 });
  const changed = trex.trexReducer(measured, { type: "model", model: "unknown" });
  assert.equal(chat.shownUsage(changed).window, null);
  assert.equal(chat.contextPercent(chat.shownUsage(changed)), null);
});

test("a missing current measurement is unknown even when the turn has accumulated usage", () => {
  const state = complete(send(), { inputTokens: 20_000, outputTokens: 1_000, contextModel: "MiniMax-M3.1-Flash" });
  assert.equal(state.usage.total, 21_000);
  assert.equal(state.usage.measured, false);
  assert.equal(chat.contextPercent(state.usage), null);
});

test("invalid API token counts cannot become a window, total, or a measured percentage", () => {
  for (const value of [-1, 1.5, Infinity, NaN, "1000000", Number.MAX_SAFE_INTEGER + 1]) {
    const state = complete(send(), { contextModel: "MiniMax-M3.1-Flash", contextTokens: value, contextWindow: value, totalTokens: value });
    assert.equal(state.usage.window, 1_000_000);
    assert.equal(state.usage.measured, false);
    assert.equal(chat.contextPercent(state.usage), null);
    assert.equal(trex.parseTrexModels([{ id: "m", contextWindow: value }])[0].contextWindow, undefined);
  }
});

const require = createRequire(import.meta.url);
const react = require("react"), { renderToStaticMarkup } = require("react-dom/server");
const source = await readFile(new URL("../src/components/chat/ContextMeter.tsx", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const exports = {};
new Function("require", "exports", compiled)(name => name === "../../chatState" ? chat
  : name === "../DropdownMenu" ? { default: () => null } : require(name), exports);
const details = usage => renderToStaticMarkup(react.createElement(exports.ContextDetails, { usage, product: "Trex CLI", busy: false, inline: true, onCompact() {} }));

test("the real context details show used of 1M, free space, and separate accumulated processing", () => {
  const html = details({ used: 1_300, window: 1_000_000, parts: [], reserve: null, total: 1_500 });
  assert.match(html, /1,3 k de 1 M tokens/);
  assert.match(html, /&lt;1 %/);
  assert.match(html, /Libre/);
  assert.match(html, /1,5 k tokens procesados/);
  assert.match(html, /última solicitud/);
});

test("unknown measured usage never renders 0 percent or fully free capacity", () => {
  const html = details({ used: 0, window: 1_000_000, measured: false, parts: [], reserve: null, total: 42_000 });
  assert.match(html, /Sin medición/);
  assert.match(html, /Límite: 1 M tokens/);
  assert.doesNotMatch(html, /Libre|chat-context-bar|0 %/);
});

test("an unknown capacity is stated explicitly instead of implying the used count is the limit", () => {
  const html = details({ used: 1_300, window: null, parts: [], reserve: null, total: null });
  assert.match(html, /no informó el límite de contexto/);
  assert.doesNotMatch(html, /Libre|chat-context-bar/);
});
