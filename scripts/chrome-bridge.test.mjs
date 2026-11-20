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

test("the read tools Claude may use while planning match the app's observe list", async () => {
  const rust = await readFile(new URL("../src-tauri/src/browser_bridge.rs", import.meta.url), "utf8");
  const start = rust.indexOf("pub const OBSERVE_TOOLS:"), open = rust.indexOf("= [", start), close = rust.indexOf("];", open);
  assert.deepEqual([...browser.CHROME_READ_TOOLS], [...rust.slice(open, close).matchAll(/"(\w+)"/g)].map(match => match[1]));
  assert.equal(browser.CHROME_SERVER, "trex_chrome");
});
