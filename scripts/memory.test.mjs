import assert from "node:assert/strict";
import test from "node:test";
import { load } from "./ts-loader.mjs";

const memory = await load("memory");
const { claudeChatFlags } = await load("claudeChat");
const { claudeInboxReply } = await load("inboxProtocol");

const session = {
  projectDir: "/datos/memory/projects/home-ana-proyecto-1a2b3c4d",
  brief: "Global (la persona, todos los proyectos):\n- idioma (user, 2026-11-11): Responde en español\nEste proyecto:\n- usa-pnpm (project, 2026-11-11): El repo usa pnpm\n",
  globalBrief: "Global (la persona, todos los proyectos):\n- idioma (user, 2026-11-11): Responde en español\n",
  guidance: "Trex memory is shared by every agent.",
};

test("Codex, Antigravity and Trex CLI get the guidance and the brief; off or missing memory adds nothing", () => {
  const block = memory.memoryInstructions(session);
  assert.ok(block.startsWith("<trex_memory>\nTrex memory is shared by every agent."));
  assert.ok(block.includes("usa-pnpm") && block.includes("idioma"));
  assert.equal(memory.memoryInstructions(null), "");
  assert.equal(memory.memoryInstructions(memory.MEMORY_OFF), "");
  assert.ok(memory.memoryInstructions({ ...session, brief: "" }).includes("No entries yet."), "the tools are announced even with no entries");
});

test("Claude keeps its native auto memory, pointed at the Trex project folder, and receives only the global entries", () => {
  assert.equal(memory.claudeMemorySettings(session), JSON.stringify({ autoMemoryDirectory: session.projectDir }));
  assert.equal(memory.claudeMemorySettings(memory.MEMORY_OFF), null);
  const block = memory.claudeMemoryInstructions(session);
  assert.ok(block.includes("Your auto memory folder is Trex memory"));
  assert.ok(block.includes("idioma") && !block.includes("usa-pnpm"), "the project entries come from its own MEMORY.md");
  assert.equal(memory.claudeMemoryInstructions(memory.MEMORY_OFF), "");
});

test("claude flags carry the memory settings and prompt, but a profile's own --settings wins", () => {
  const flags = claudeChatFlags(null, null, { memory: session });
  const at = flags.indexOf("--settings");
  assert.ok(at > 0);
  assert.deepEqual(JSON.parse(flags[at + 1]), { autoMemoryDirectory: session.projectDir });
  assert.ok(flags[flags.indexOf("--append-system-prompt") + 1].includes("<trex_memory>"));
  const own = claudeChatFlags("--settings ./mis-ajustes.json", null, { memory: session });
  assert.equal(own.indexOf("--settings"), -1, "the profile keeps its own settings file");
  const off = claudeChatFlags(null, null, { memory: memory.MEMORY_OFF });
  assert.equal(off.indexOf("--settings"), -1);
  assert.ok(!off[off.indexOf("--append-system-prompt") + 1].includes("<trex_memory>"));
  assert.deepEqual(claudeChatFlags(null, null), claudeChatFlags(null, null, { memory: null }), "without memory nothing changes");
});

test("Claude's in-process bridge routes the memory tools to the project registry like coordination", async () => {
  const calls = [];
  const coordination = { tools: async () => [{ name: "trex_memory_search" }], call: async (name, args) => { calls.push([name, args]); return { content: [{ type: "text", text: "ok" }], isError: false }; } };
  const reply = await claudeInboxReply("memory-call", { subtype: "mcp_message", server_name: "trex_inbox",
    message: { id: 3, method: "tools/call", params: { name: "trex_memory_search", arguments: { query: "pnpm" } } } }, () => assert.fail("never reads the queue"), undefined, { coordination });
  assert.deepEqual(calls, [["trex_memory_search", { query: "pnpm" }]]);
  assert.equal(JSON.parse(reply.line).response.response.mcp_response.result.isError, false);
  const failing = { ...coordination, call: async () => { throw new Error("ocupado"); } };
  const failed = await claudeInboxReply("memory-fail", { subtype: "mcp_message", server_name: "trex_inbox",
    message: { id: 4, method: "tools/call", params: { name: "trex_memory_save", arguments: {} } } }, () => assert.fail("never reads the queue"), undefined, { coordination: failing });
  const result = JSON.parse(failed.line).response.response.mcp_response.result;
  assert.equal(result.isError, true);
  assert.ok(result.content[0].text.startsWith("No se pudo usar la memoria de Trex"));
});

test("memory tool names are recognised", () => {
  assert.ok(memory.isMemoryTool("trex_memory_save"));
  assert.ok(!memory.isMemoryTool("trex_peers"));
});
