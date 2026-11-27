import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { load } from "./ts-loader.mjs";

const browser = await load("browser");

test("the person's browser only observes while planning or read-only", () => {
  for (const mode of ["plan", "read-only"]) assert.equal(browser.chromeMode(mode), "observe", mode);
  assert.equal(browser.chromeMode("bypassPermissions", true), "observe", "a planning-only chat never acts");
  // Any other mode acts, behind the agent's own approval prompts.
  for (const mode of ["default", "acceptEdits", "auto", "full", "bypassPermissions", null, undefined]) assert.equal(browser.chromeMode(mode), "full", String(mode));
});

test("the chat token travels in the environment, never on the command line", () => {
  const session = { url: "http://127.0.0.1:7341/mcp", token: "a".repeat(64) };
  const server = browser.claudeChromeServer(session);
  assert.deepEqual(server, { type: "http", url: session.url, headers: { Authorization: "Bearer ${TREX_CHROME_TOKEN}" } });
  assert.ok(!JSON.stringify(server).includes(session.token));
  assert.deepEqual(browser.chromeEnv(session), { TREX_CHROME_TOKEN: session.token });
  assert.deepEqual(browser.chromeEnv(null), {});
});

test("what the agent saw in the browser shows in the chat without its bytes entering the chat state", async () => {
  const previews = await load("capturePreviews");
  const image = { type: "image", mimeType: "image/jpeg", data: "/9j/4AAQSkZJRgABAQ" + "A".repeat(200) };
  const content = [{ type: "text", text: "Captura 1280×720 de «Tienda»" }, image, { type: "image", mimeType: "text/html", data: "PGI+" }];
  const artifacts = previews.capturePreviewArtifacts(content);
  assert.equal(artifacts.length, 1, "only real images");
  assert.match(artifacts[0].id, /^capture:[0-9a-f]{8}-[0-9a-z]+$/);
  assert.equal(artifacts[0].kind, "capture");
  assert.ok(!JSON.stringify(artifacts).includes(image.data), "no image bytes in the transcript");
  assert.deepEqual(previews.capturePreviewArtifacts([image]), artifacts, "the same capture keeps its id");
  assert.deepEqual(previews.chromeCaptures([{ type: "text", text: "Clic hecho." }]), {}, "a result without images adds nothing");
  // Without image APIs (here, and while it is being made) there is no preview yet: the chat shows the label.
  assert.equal(previews.capturePreview(artifacts[0].id), null);

  // The chat parsers attach them to the browser tool results of Claude Code and Codex.
  const claude = await load("claudeChat"), { initialChatState } = await load("chatState");
  const state = claude.chatReducer(initialChatState(), { type: "history", entries: [
    { type: "assistant", message: { id: "m1", content: [{ type: "tool_use", id: "t1", name: "mcp__trex_chrome__screenshot", input: { tabId: 4 } }] } },
    { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content }] } },
  ] });
  const tool = state.items.find(item => item.kind === "tool" && item.id === "t1");
  assert.deepEqual(tool?.artifacts, artifacts);
  assert.ok(!JSON.stringify(state).includes(image.data));
});

test("the read tools Claude may use while planning match the app's observe list", async () => {
  const rust = await readFile(new URL("../src-tauri/src/browser_bridge.rs", import.meta.url), "utf8");
  const start = rust.indexOf("pub const OBSERVE_TOOLS:"), open = rust.indexOf("= [", start), close = rust.indexOf("];", open);
  assert.deepEqual([...browser.CHROME_READ_TOOLS], [...rust.slice(open, close).matchAll(/"(\w+)"/g)].map(match => match[1]));
  assert.equal(browser.CHROME_SERVER, "trex_chrome");
});
