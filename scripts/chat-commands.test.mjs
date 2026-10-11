import assert from "node:assert/strict";
import test from "node:test";
import { load } from "./ts-loader.mjs";

const commands = await load("chatCommands");
const shared = await load("chatState");
const codex = await load("codexChat");

const files = ["README.md", "package.json", "src/App.tsx", "src/components/ChatView.tsx", "src/components/chat/ModelMenu.tsx", "src/chatState.ts"];

test("triggers: / only opens at the start, @ and $ at the start of a word", () => {
  assert.deepEqual(commands.findTrigger("/com", 4, "@/"), { char: "/", query: "com", start: 0, end: 4 });
  assert.equal(commands.findTrigger("hola /com", 9, "@/"), null, "una barra en mitad del texto no es un comando");
  assert.deepEqual(commands.findTrigger("mira @src/co y dime", 12, "@/"), { char: "@", query: "src/co", start: 5, end: 12 });
  assert.deepEqual(commands.findTrigger("mira @src/coXX", 12, "@/"), { char: "@", query: "src/co", start: 5, end: 14 }, "sustituye la palabra entera");
  assert.equal(commands.findTrigger("correo a@b.com", 14, "@/"), null, "una arroba dentro de una palabra no abre nada");
  assert.equal(commands.findTrigger("usa $pdf", 8, "@/"), null, "Claude no tiene skills con $");
  assert.deepEqual(commands.findTrigger("usa $pd", 7, "@/$"), { char: "$", query: "pd", start: 4, end: 7 });
  assert.equal(commands.findTrigger("hola ", 5, "@/$"), null);
});

test("choosing a suggestion replaces the word and leaves the cursor after it", () => {
  const value = "revisa @src/co por favor";
  const trigger = commands.findTrigger(value, 14, "@/");
  assert.deepEqual(commands.applySuggestion(value, trigger, "@src/components/ChatView.tsx "),
    { text: "revisa @src/components/ChatView.tsx por favor", caret: 36 });
  const folder = commands.applySuggestion("@sr", commands.findTrigger("@sr", 3, "@/"), "@src/");
  assert.deepEqual(folder, { text: "@src/", caret: 5 }, "una carpeta con Tab sigue abierta");
});

test("paths rank by name, folders open with a trailing slash and letters can be skipped", () => {
  assert.deepEqual(commands.folderPaths(files), ["src/", "src/components/", "src/components/chat/"]);
  assert.deepEqual(commands.rankPaths(files, "").map((entry) => entry.path), ["src/", "README.md", "package.json"]);
  assert.equal(commands.rankPaths(files, "chatview")[0].path, "src/components/ChatView.tsx");
  assert.equal(commands.rankPaths(files, "model")[0].path, "src/components/chat/ModelMenu.tsx");
  assert.deepEqual(commands.rankPaths(files, "src/components/").map((entry) => entry.path),
    ["src/components/chat/", "src/components/ChatView.tsx"]);
  assert.equal(commands.rankPaths(files, "chtvw")[0].path, "src/components/ChatView.tsx", "coincidencia por letras sueltas");
  assert.deepEqual(commands.rankPaths(files, "zzz"), []);
  assert.ok(commands.pathScore("src/App.tsx", "app") > commands.pathScore("src/components/chat/ModelMenu.tsx", "app") ?? -Infinity);
});

test("@ lists Claude subagents before the files", () => {
  const agents = [{ name: "Explore", description: "Busca en el código" }, { name: "Plan", description: "Planifica" }];
  const all = commands.buildSuggestions({ char: "@", query: "", start: 0, end: 1 }, { provider: "claude", files, agents, commands: [], skills: [] });
  assert.deepEqual(all.slice(0, 3).map((item) => [item.kind, item.label]), [["agent", "Explore"], ["agent", "Plan"], ["folder", "src/"]]);
  assert.equal(all[0].insert, "@agent-Explore ");
  const typed = commands.buildSuggestions({ char: "@", query: "agent-pla", start: 0, end: 10 }, { provider: "claude", files, agents, commands: [], skills: [] });
  assert.deepEqual(typed.filter((item) => item.kind === "agent").map((item) => item.label), ["Plan"]);
  const file = commands.buildSuggestions({ char: "@", query: "appts", start: 0, end: 6 }, { provider: "codex", files, agents: [], commands: [], skills: [] })[0];
  assert.deepEqual([file.kind, file.label, file.detail, file.insert], ["file", "App.tsx", "src/", "@src/App.tsx "]);
});

test("/ shows the chat commands first and the CLI ones after, without duplicates", () => {
  const cli = commands.parseClaudeCommands([
    { name: "compact", description: "Free up context", argumentHint: "<instructions>" },
    { name: "clear", description: "Start a new session" },
    { name: "context", description: "Show current context usage", argumentHint: "" },
    { name: "color", description: "Set the prompt bar color" },
    { name: "__remote-workflow", description: "internal" },
    { name: "agents", description: "(removed) Ask Claude" },
    { name: "extra-usage", description: "Renamed to /usage-credits" },
  ]);
  assert.deepEqual(cli.map((command) => command.name), ["compact", "clear", "context"]);
  const list = commands.buildSuggestions({ char: "/", query: "", start: 0, end: 1 }, { provider: "claude", files: null, agents: [], commands: cli, skills: [] });
  assert.deepEqual(list.map((item) => item.label), ["/clear", "/model", "/effort", "/permissions", "/compact", "/context"]);
  assert.equal(list.find((item) => item.label === "/compact").run, false, "con argumentos se inserta para escribirlos");
  assert.equal(list.find((item) => item.label === "/context").run, true);
  const codexList = commands.buildSuggestions({ char: "/", query: "re", start: 0, end: 3 }, { provider: "codex", files: null, agents: [], commands: [],
    skills: [{ name: "review-agent", description: "Busca errores", path: "/s/review/SKILL.md" }] });
  assert.deepEqual(codexList.map((item) => [item.kind, item.label]), [["command", "/review"], ["skill", "$review-agent"]]);
});

test("commands parse at the start and synonyms map to each assistant's name", () => {
  assert.deepEqual(commands.parseCommand("/review  solo el backend "), { name: "review", args: "solo el backend" });
  assert.deepEqual(commands.parseCommand("/compact"), { name: "compact", args: "" });
  assert.equal(commands.parseCommand("hola /compact"), null);
  assert.equal(commands.parseCommand("/ruta/de/archivo"), null, "una ruta no es un comando");
  assert.equal(commands.localCommand("claude", "new"), "clear");
  assert.equal(commands.localCommand("codex", "clear"), "new");
  assert.equal(commands.localCommand("codex", "approvals"), "permissions");
  assert.equal(commands.localCommand("claude", "compact"), null, "Claude Code resuelve /compact por su cuenta");
  assert.equal(commands.localCommand("codex", "compact"), "compact");
});

test("Codex skills: listed once, disabled ones hidden, and $name attaches them", () => {
  const skills = commands.parseCodexSkills([
    { cwd: "/a", skills: [{ name: "pdf", description: "PDF largo", interface: { shortDescription: "Lee PDF" }, path: "/s/pdf/SKILL.md", enabled: true },
      { name: "off", description: "x", path: "/s/off", enabled: false }] },
    { cwd: "/b", skills: [{ name: "pdf", description: "otra", path: "/otra", enabled: true }, { name: "docx", description: "Word", path: "/s/docx", enabled: true }] },
  ]);
  assert.deepEqual(skills, [{ name: "docx", path: "/s/docx", description: "Word" }, { name: "pdf", path: "/s/pdf/SKILL.md", description: "Lee PDF" }]);
  assert.deepEqual(commands.mentionedSkills("usa $pdf, y no $pdfx ni a$docx", skills).map((skill) => skill.name), ["pdf"]);
  assert.deepEqual(codex.userInput("usa $pdf", [], [skills[1]]).at(-1), { type: "skill", name: "pdf", path: "/s/pdf/SKILL.md" });
});

test("Codex keeps context usage, skills and a fresh conversation keeps the choices", () => {
  let state = [
    { type: "models", data: [{ id: "m", model: "m", displayName: "M", supportedReasoningEfforts: [] }] },
    { type: "skills", data: [{ cwd: "/a", skills: [{ name: "pdf", description: "PDF", path: "/p", enabled: true }] }] },
    { type: "rpc", scope: "p", now: 0, message: { method: "thread/tokenUsage/updated", params: { tokenUsage: {
      last: { inputTokens: 18000, outputTokens: 334 }, modelContextWindow: 258400 } } } },
    { type: "mode", mode: "plan" },
    { type: "send", id: "u1", text: "hola", now: 0 },
  ].reduce(codex.codexReducer, shared.initialChatState());
  assert.deepEqual(state.usage, { used: 18334, window: 258400 });
  assert.equal(state.skills.length, 1);
  state = codex.codexReducer(state, { type: "reset" });
  assert.deepEqual([state.items.length, state.pendingTurns, state.models.length, state.skills.length, state.modeChoice, state.usage],
    [0, 0, 1, 1, "plan", null]);
  assert.match(codex.INIT_PROMPT, /AGENTS\.md/);
});
