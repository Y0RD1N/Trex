import assert from "node:assert/strict";
import test from "node:test";
import { load } from "./ts-loader.mjs";

// Los ayudantes comunes viven en chatState; el protocolo, en claudeChat.
const chat = { ...(await load("chatState")), ...(await load("claudeChat")) };
const images = await load("chatImages");
const { chatReducer, initialChatState, chatActivity } = chat;
const run = (actions, state = initialChatState()) => actions.reduce(chatReducer, state);
const line = (event, now = 1000) => ({ type: "line", event, now });
const stream = (event) => line({ type: "stream_event", event, parent_tool_use_id: null });
const kinds = (state) => state.items.map((item) => item.kind);

test("the chat flags keep the CLI on stdin/stdout and resume without duplicating options", () => {
  const flags = chat.claudeChatFlags("--model opus", "550e8400-e29b-41d4-a716-446655440000");
  assert.deepEqual(flags.slice(0, 6), ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"]);
  assert.ok(flags.join(" ").includes("--permission-prompt-tool stdio"));
  assert.deepEqual(flags.slice(-2), ["--resume", "550e8400-e29b-41d4-a716-446655440000"]);
  assert.ok(!chat.claudeChatFlags("--resume abc", "550e8400-e29b-41d4-a716-446655440000").includes("--resume"));
  assert.ok(!chat.claudeChatFlags("--continue", "550e8400-e29b-41d4-a716-446655440000").includes("--resume"));
  assert.ok(!chat.claudeChatFlags(null, null).includes("--resume"));
  assert.ok(!chat.claudeChatFlags(null, null).includes("AskUserQuestion"), "las preguntas con opciones tienen interfaz propia");
  const prompt = chat.claudeChatFlags(null, null);
  assert.match(prompt[prompt.indexOf("--append-system-prompt") + 1], /attach it/, "sabe adjuntar archivos al chat");
  assert.ok(!chat.claudeChatFlags("--append-system-prompt 'mío'", null).includes("--append-system-prompt"), "no pisa las instrucciones del perfil");
  assert.ok(!chat.claudeChatFlags("--system-prompt-file p.md", null).includes("--append-system-prompt"));
});

test("outgoing messages are single JSON lines in the shape the CLI accepts", () => {
  assert.deepEqual(JSON.parse(chat.userMessageLine("hola\nmundo")), { type: "user", message: { role: "user", content: "hola\nmundo" } });
  assert.ok(!chat.userMessageLine("a\nb").includes("\n"));
  assert.deepEqual(JSON.parse(chat.userMessageLine("¿qué ves?", [{ mediaType: "image/png", data: "AAAA" }])).message.content, [
    { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
    { type: "text", text: "¿qué ves?" },
  ]);
  assert.deepEqual(JSON.parse(chat.userMessageLine("", [{ mediaType: "image/jpeg", data: "BBBB" }])).message.content,
    [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: "BBBB" } }]);
  assert.deepEqual(JSON.parse(chat.controlLine("r1", { subtype: "interrupt" })), { type: "control_request", request_id: "r1", request: { subtype: "interrupt" } });
  const allow = JSON.parse(chat.permissionLine("p1", true, { file_path: "/a" }, [{ type: "setMode", mode: "acceptEdits" }]));
  assert.deepEqual(allow.response, { subtype: "success", request_id: "p1",
    response: { behavior: "allow", updatedInput: { file_path: "/a" }, updatedPermissions: [{ type: "setMode", mode: "acceptEdits" }] } });
  assert.equal(JSON.parse(chat.permissionLine("p1", false, {})).response.response.behavior, "deny");
});

test("streamed text grows in place and the final message does not duplicate it", () => {
  const state = run([
    { type: "send", id: "u1", text: "hola", now: 0 },
    line({ type: "system", subtype: "init", session_id: "s-1", model: "claude-opus-5-5", permissionMode: "default" }),
    stream({ type: "message_start", message: { id: "m1" } }),
    stream({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
    stream({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Ho" } }),
    stream({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "la" } }),
  ]);
  assert.deepEqual(kinds(state), ["user", "text"]);
  assert.equal(state.items[1].text, "Hola");
  assert.equal(state.items[1].final, false);
  assert.equal(chatActivity(state), "working");
  assert.equal(state.sessionId, "s-1");

  const done = run([
    line({ type: "assistant", message: { id: "m1", content: [{ type: "text", text: "Hola." }] }, parent_tool_use_id: null }),
    stream({ type: "message_stop" }),
    line({ type: "result", subtype: "success", is_error: false, duration_ms: 1652, total_cost_usd: 0.002, session_id: "s-1" }, 2000),
  ], state);
  assert.deepEqual(kinds(done), ["user", "text", "turn"]);
  assert.equal(done.items[1].text, "Hola.");
  assert.equal(done.items[2].durationMs, 1652);
  assert.equal(chatActivity(done), "idle");
});

test("tools show their result and edits keep the structured diff", () => {
  const state = run([
    { type: "send", id: "u1", text: "edita", now: 0 },
    line({ type: "assistant", message: { id: "m1", content: [{ type: "tool_use", id: "t1", name: "Edit", input: { file_path: "/app/notes.txt", old_string: "dos", new_string: "2" } }] } }),
    line({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "updated" }] },
      tool_use_result: { filePath: "/app/notes.txt", originalFile: "x", structuredPatch: [{ lines: [" uno", "-dos", "+2"] }] } }),
  ]);
  const tool = state.items.find((item) => item.kind === "tool");
  assert.equal(tool.status, "done");
  assert.equal(tool.output, "updated");
  assert.deepEqual(tool.patch, [{ kind: "ctx", text: "uno" }, { kind: "del", text: "dos" }, { kind: "add", text: "2" }]);
  assert.deepEqual(chat.diffStats(tool.patch), { added: 1, removed: 1 });
  assert.deepEqual(chat.describeTool("Edit", tool.input, "/app", false), { icon: "edit", verb: "Editó", target: "notes.txt" });
  assert.equal(chat.describeTool("Bash", { command: "npm test\nmore" }, "/app", true).target, "npm test");
  assert.equal(chat.describeTool("mcp__playwright__browser_click", {}, "/app", false).target, "playwright · browser_click");
});

test("permission requests wait for an answer and mark the session as waiting", () => {
  const ask = line({ type: "control_request", request_id: "p1", request: { subtype: "can_use_tool", tool_name: "Write",
    input: { file_path: "/app/a.txt", content: "hola" }, description: "a.txt", permission_suggestions: [{ type: "setMode", mode: "acceptEdits" }], tool_use_id: "t1" } });
  const state = run([{ type: "send", id: "u1", text: "crea", now: 0 }, ask, ask]);
  assert.equal(state.items.filter((item) => item.kind === "permission").length, 1);
  assert.equal(chatActivity(state), "waiting");
  const answered = chatReducer(state, { type: "answer", id: "p1", allowed: false });
  assert.equal(answered.items.at(-1).state, "denied");
  assert.equal(chatActivity(answered), "working");
  assert.deepEqual(chat.inputDiff("Write", { content: "a\nb\n" }), [{ kind: "add", text: "a" }, { kind: "add", text: "b" }]);
});

test("an interruption stops the turn without reporting an error", () => {
  const state = run([
    { type: "send", id: "u1", text: "poema", now: 0 },
    line({ type: "assistant", message: { id: "m1", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "sleep 10" } }] } }),
    line({ type: "control_response", response: { subtype: "success", request_id: "r-int", response: { still_queued: [] } } }),
    line({ type: "user", message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] } }),
    line({ type: "result", subtype: "error_during_execution", is_error: true }),
  ]);
  assert.equal(state.pendingTurns, 0);
  assert.equal(state.items.find((item) => item.kind === "tool").status, "error");
  assert.deepEqual(kinds(state), ["user", "tool", "notice"]);
  assert.equal(state.items.at(-1).tone, "info");
});

test("API errors and usage limits become visible notices", () => {
  const state = run([
    { type: "send", id: "u1", text: "hola", now: 0 },
    line({ type: "result", subtype: "success", is_error: true, result: "Invalid API key · Please run /login" }),
    line({ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: 1791701400 } }),
    line({ type: "rate_limit_event", rate_limit_info: { status: "allowed" } }),
  ]);
  const notices = state.items.filter((item) => item.kind === "notice");
  assert.equal(notices.length, 2);
  assert.equal(notices[0].tone, "error");
  assert.match(notices[0].text, /Invalid API key/);
  assert.equal(notices[1].tone, "warn");
});

test("subagent events stay inside their task and the mode follows the CLI", () => {
  const state = run([
    line({ type: "assistant", parent_tool_use_id: "task-1", message: { id: "sub", content: [{ type: "text", text: "interno" }] } }),
    line({ type: "system", subtype: "status", status: null, permissionMode: "acceptEdits" }),
    line({ type: "control_response", response: { subtype: "success", request_id: "m", response: { mode: "plan" } } }),
  ]);
  assert.equal(state.items.length, 0);
  assert.equal(state.permissionMode, "plan");
});

test("history replays saved conversations before new messages and hides internal prompts", () => {
  const live = run([{ type: "send", id: "new", text: "sigue", now: 0 }]);
  const state = chatReducer(live, { type: "history", entries: [
    { type: "user", uuid: "u1", message: { role: "user", content: "arregla el sidebar" } },
    { type: "user", uuid: "u2", message: { role: "user", content: "<task-notification>x</task-notification>" } },
    { type: "assistant", message: { id: "m1", content: [{ type: "thinking", thinking: "" }] } },
    { type: "assistant", message: { id: "m1", content: [{ type: "text", text: "Hecho." }] } },
    { type: "assistant", message: { id: "m2", content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "/a" } }] } },
    { type: "user", uuid: "u3", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "1\tuno" }] }] } },
    { type: "assistant", message: { id: "m3", content: [{ type: "tool_use", id: "t2", name: "Bash", input: { command: "ls" } }] } },
  ] });
  assert.deepEqual(kinds(state), ["user", "text", "tool", "tool", "user"]);
  assert.equal(state.items[0].text, "arregla el sidebar");
  assert.equal(state.items[2].output, "1\tuno");
  assert.equal(state.items[3].status, "done");
  assert.equal(state.items.at(-1).id, "new");
  assert.equal(state.pendingTurns, 1);
  const again = chatReducer(state, { type: "history", entries: [{ type: "user", uuid: "u1", message: { role: "user", content: "arregla el sidebar" } }] });
  assert.deepEqual(again.items.map((item) => item.id), ["u1", "new"]);
});

test("the process lifecycle closes pending requests when the CLI exits", () => {
  const state = run([
    { type: "spawned" },
    { type: "send", id: "u1", text: "hola", now: 0 },
    line({ type: "control_request", request_id: "p1", request: { subtype: "can_use_tool", tool_name: "Bash", input: {} } }),
    { type: "stderr", line: "Error: not logged in" },
    { type: "exit", code: 1 },
  ]);
  assert.equal(state.process, "exited");
  assert.equal(state.exitCode, 1);
  assert.deepEqual(state.stderr, ["Error: not logged in"]);
  assert.equal(state.items.at(-1).state, "denied");
  assert.equal(chatActivity(state), "idle");
});

test("labels stay short and readable", () => {
  assert.equal(chat.modelLabel("claude-opus-5-5[1m]"), "Opus");
  assert.equal(chat.modelLabel(null), "Modelo");
  assert.equal(chat.conversationTitle("  arregla   el\nsidebar  "), "arregla el sidebar");
  assert.equal(chat.conversationTitle("x".repeat(80), 10), "xxxxxxxxx…");
  assert.equal(chat.relativePath("C:\\work\\app\\src\\a.ts", "C:\\work\\app"), "src/a.ts");
  assert.equal(chat.relativePath("/etc/hosts", "/home/app"), "/etc/hosts");
  assert.deepEqual(chat.todoItems({ todos: [{ content: "a", status: "in_progress" }, { content: "b", status: "raro" }, { nope: 1 }] }),
    [{ content: "a", status: "in_progress", activeForm: undefined }, { content: "b", status: "pending", activeForm: undefined }]);
});

test("sent images keep their previews in the thread", () => {
  const state = run([{ type: "send", id: "u1", text: "", previews: ["data:image/png;base64,AAAA"], now: 0 }]);
  assert.deepEqual(state.items[0], { kind: "user", id: "u1", text: "", images: 1, previews: ["data:image/png;base64,AAAA"] });
  const history = chatReducer(initialChatState(), { type: "history", entries: [
    { type: "user", uuid: "h1", message: { role: "user", content: [{ type: "image" }, { type: "text", text: "mira" }] } },
  ] });
  assert.deepEqual(history.items[0], { kind: "user", id: "h1", text: "mira", images: 1, previews: [] });
});

test("questions with options are answered in the format the CLI expects", () => {
  const input = { questions: [
    { question: "¿Qué color prefieres?", header: "Color", multiSelect: false, options: [{ label: "Rojo", description: "Cálido" }, { label: "Azul" }] },
    { question: "¿Qué tests?", header: "Tests", multiSelect: true, options: [{ label: "Unitarios" }, { label: "E2E" }] },
    { nope: true },
  ] };
  const questions = chat.questionsOf(input);
  assert.equal(questions.length, 2);
  assert.deepEqual(questions[0].options, [
    { label: "Rojo", title: "Rojo", description: "Cálido", preview: "", recommended: false },
    { label: "Azul", title: "Azul", description: "", preview: "", recommended: false },
  ]);
  assert.deepEqual([questions[0].kind, questions[0].other, questions[0].secret], ["choice", true, false], "Claude siempre admite otra respuesta");
  assert.equal(questions[1].multiSelect, true);
  const answered = chat.answeredInput(input, [
    { question: "¿Qué color prefieres?", selected: ["Azul"], other: "" },
    { question: "¿Qué tests?", selected: ["Unitarios", "E2E"], other: "  y de tipos " },
  ]);
  assert.deepEqual(answered.answers, { "¿Qué color prefieres?": "Azul", "¿Qué tests?": "Unitarios, E2E, y de tipos" });
  assert.equal(answered.questions, input.questions);
  assert.deepEqual(chat.describeTool("AskUserQuestion", input, "/app", false), { icon: "question", verb: "Preguntó", target: "¿Qué color prefieres?" });

  const state = run([
    { type: "send", id: "u1", text: "pregúntame", now: 0 },
    line({ type: "assistant", message: { id: "m1", content: [{ type: "tool_use", id: "q1", name: "AskUserQuestion", input }] } }),
    line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "q1", content: "Your questions have been answered" }] },
      tool_use_result: { questions: input.questions, answers: { "¿Qué color prefieres?": "Azul" } } }),
  ]);
  assert.equal(state.items[1].output, "¿Qué color prefieres?\n→ Azul");
  assert.deepEqual(chat.answersOf(state.items[1].input), { "¿Qué color prefieres?": "Azul" }, "las respuestas quedan junto a las preguntas");
  // Omitir: sin respuestas, Claude sigue a su criterio.
  assert.deepEqual(chat.answeredInput(input, []).answers, {});
});

test("extended questions bring their kind, limits, previews and the recommended option", () => {
  const input = { title: "Antes de la presentación", questions: [
    { question: "¿Cuántas diapositivas?", header: "Tamaño", kind: "number", min: 5, max: 30, step: 5, defaultValue: 10, unit: "diapositivas" },
    { question: "¿Algo más?", kind: "text", placeholder: "Opcional", description: "Cuéntame lo que quieras" },
    { question: "¿Qué diseño?", header: "Diseño", options: [
      { label: "Oscuro (Recommended)", description: "Fondo negro", preview: "+-----+\n| ### |\n+-----+" },
      { label: "Claro", preview: "```\nclaro\n```" },
    ] },
  ] };
  const [count, extra, layout] = chat.questionsOf(input);
  assert.equal(chat.questionsTitle(input), "Antes de la presentación");
  assert.deepEqual(count.number, { min: 5, max: 30, step: 5, initial: 10, unit: "diapositivas" });
  assert.deepEqual([count.kind, count.options.length], ["number", 0]);
  assert.deepEqual([extra.kind, extra.placeholder, extra.description], ["text", "Opcional", "Cuéntame lo que quieras"]);
  assert.deepEqual(layout.options.map((option) => [option.label, option.title, option.recommended, !!option.preview]),
    [["Oscuro (Recommended)", "Oscuro", true, true], ["Claro", "Claro", false, true]]);
  // Se responde con la etiqueta original, que es la que reconoce Claude.
  assert.deepEqual(chat.answeredInput(input, [
    { question: count.question, selected: [], other: "15" },
    { question: extra.question, selected: [], other: "" },
    { question: layout.question, selected: ["Oscuro (Recommended)"], other: "" },
  ]).answers, { "¿Cuántas diapositivas?": "15", "¿Qué diseño?": "Oscuro (Recommended)" });
});

test("the plan usage comes from get_usage and each request's rate limit event", () => {
  const usage = { subscription_type: "pro", rate_limits_available: true, rate_limits: {
    five_hour: { utilization: 33, resets_at: "2026-10-14T05:29:59.868379+00:00" },
    limits: [
      { kind: "session", group: "session", percent: 33, resets_at: "2026-10-14T05:29:59.868379+00:00", severity: "normal", is_active: false, scope: null },
      { kind: "weekly_all", group: "weekly", percent: 71, resets_at: "2026-10-16T22:59:59.868396+00:00", severity: "normal", is_active: true, scope: null },
      { kind: "weekly_scoped", group: "weekly", percent: 92, resets_at: null, severity: "critical", is_active: false, scope: { label: "Opus" } },
    ],
    extra_usage: { is_enabled: true, monthly_limit: 2000, used_credits: 150, currency: "USD", decimal_places: 2 } } };
  let state = run([{ type: "plan", data: usage }]);
  assert.equal(state.plan.plan, "Pro");
  assert.deepEqual(state.plan.windows.map((window) => [window.label, window.percent, window.severity, window.headline]),
    [["Sesión (5 h)", 33, "normal", false], ["Semana", 71, "normal", true], ["Semana · Opus", 92, "critical", false]]);
  assert.equal(state.plan.windows[0].resetsAt, Date.parse("2026-10-14T05:29:59.868Z"));
  assert.deepEqual(state.plan.extra, { used: 1.5, limit: 20, currency: "USD" });
  // Cada petición al modelo trae las ventanas al día.
  state = run([line({ type: "rate_limit_event", rate_limit_info: { status: "allowed", unifiedWindows: {
    five_hour: { utilization: 0.38, resetsAt: 1791955800 }, seven_day: { utilization: 0.715, resetsAt: 1792191600 } } } })], state);
  assert.deepEqual(state.plan.windows.slice(0, 2).map((window) => [window.percent, window.resetsAt]), [[38, 1791955800000], [72, 1792191600000]]);
  assert.equal(state.items.length, 0);
  // Sin datos antes, el evento basta para mostrar algo.
  const fresh = run([line({ type: "rate_limit_event", rate_limit_info: { status: "allowed", unifiedWindows: { five_hour: { utilization: 0.1, resetsAt: 1 } } } })]);
  assert.deepEqual(fresh.plan.windows.map((window) => [window.label, window.percent, window.headline]), [["Sesión (5 h)", 10, true]]);
  // Una cuenta con clave de API no tiene límites de plan.
  assert.equal(run([{ type: "plan", data: { subscription_type: null, rate_limits_available: false, rate_limits: null } }]).plan, null);
});

test("images shrink to the sending size without being enlarged", () => {
  assert.deepEqual(images.fitWithin(3840, 2160), { width: 1920, height: 1080 });
  assert.deepEqual(images.fitWithin(1080, 3000), { width: 691, height: 1920 });
  assert.deepEqual(images.fitWithin(640, 480), { width: 640, height: 480 });
  assert.deepEqual(images.fitWithin(1000, 10, 100), { width: 100, height: 1 });
  assert.ok(images.MAX_IMAGE_BYTES * 4 / 3 < 5 * 1024 * 1024, "en base64 cabe en el límite de la API");
});

test("the model catalog comes from the CLI with versions, descriptions and effort levels", () => {
  const raw = [
    { value: "default", resolvedModel: "claude-opus-5-5", displayName: "Default (recommended)", description: "Opus 5.5 · Best for everyday, complex tasks", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"] },
    { value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus 5.5", description: "For complex work", supportsEffort: true, supportedEffortLevels: ["low", "high"] },
    { value: "sonnet", resolvedModel: "claude-sonnet-5-5", displayName: "Sonnet 5.5", description: "Efficient", supportsEffort: true, supportedEffortLevels: ["low", "medium"] },
    { value: "claude-haiku-4-5-20251001", resolvedModel: "claude-haiku-4-5-20251001", displayName: "Haiku 4.5", description: "Fastest for quick answers" },
    { nope: true },
  ];
  const models = chat.parseModels(raw);
  assert.equal(models.length, 4);
  assert.deepEqual(models[3].efforts, []);
  const { main, others } = chat.splitModels(models);
  assert.deepEqual(main.map((model) => model.value), ["default", "opus", "sonnet"]);
  assert.deepEqual(others.map((model) => model.displayName), ["Haiku 4.5"]);
  assert.equal(chat.currentModel(models, "claude-opus-5-5", null).value, "opus", "el alias concreto gana al predeterminado");
  assert.equal(chat.currentModel(models, "claude-opus-5-5", "default").value, "default", "lo elegido en el chat se respeta");
  assert.equal(chat.modelName(models[0]), "Predeterminado");
  assert.equal(chat.modelDescription(models[0], models), "Recomendado · Opus 5.5");
  assert.equal(chat.modelDescription(models[2]), "El más eficiente para tareas sencillas");
  assert.equal(chat.modelDescription(models[3]), "El más rápido para respuestas breves");
  assert.equal(chat.effortLabel("xhigh"), "Muy alto");
});

test("model and effort follow the CLI and survive a restart of the process", () => {
  const models = [{ value: "fable", resolvedModel: "claude-fable-5-1", displayName: "Fable 5.1", supportedEffortLevels: ["low", "max"] }];
  let state = run([
    { type: "catalog", models, permissionMode: "acceptEdits" },
    { type: "applied", model: "claude-sonnet-5-5", effort: "xhigh" },
  ]);
  assert.equal(state.models.length, 1);
  assert.equal(state.permissionMode, "acceptEdits");
  assert.deepEqual([state.model, state.effort, state.modelChoice, state.effortChoice], ["claude-sonnet-5-5", "xhigh", null, null]);
  state = run([{ type: "model", model: "fable" }, { type: "effort", effort: "max" }, { type: "applied", model: "", effort: null }], state);
  assert.deepEqual([state.model, state.effort, state.modelChoice, state.effortChoice], ["claude-fable-5-1", "max", "fable", "max"]);
  assert.deepEqual(chat.claudeChatFlags(null, null, { model: state.modelChoice, effort: state.effortChoice }).slice(-4), ["--model", "fable", "--effort", "max"]);
  assert.ok(!chat.claudeChatFlags(null, null, {}).includes("--model"));
  assert.deepEqual(chat.claudeChatFlags(null, null, { mode: "acceptEdits" }).slice(-2), ["--permission-mode", "acceptEdits"]);
  assert.ok(!chat.claudeChatFlags("--dangerously-skip-permissions", null, { mode: "plan" }).includes("--permission-mode"));
  assert.ok(!chat.claudeChatFlags(null, null, { mode: "manual" }).includes("--permission-mode"));
});

test("«Permitir todo» can be chosen at any time and a rejected mode goes back to the previous one", () => {
  assert.ok(chat.claudeChatFlags(null, null).includes("--allow-dangerously-skip-permissions"));
  assert.ok(!chat.claudeChatFlags("--restricted", null).includes("--allow-dangerously-skip-permissions"), "el modo restringido no lo admite");
  assert.ok(!chat.claudeChatFlags("--restricted", null, { mode: "bypassPermissions" }).includes("--permission-mode"));
  assert.equal(chat.claudeChatFlags("--dangerously-skip-permissions", null).filter((flag) => flag.includes("skip-permissions")).length, 0);
  assert.deepEqual(chat.claudeChatFlags(null, null, { mode: "bypassPermissions" }).slice(-2), ["--permission-mode", "bypassPermissions"]);
  let state = run([{ type: "mode", mode: "bypassPermissions" }], initialChatState("acceptEdits"));
  assert.deepEqual([state.permissionMode, state.modeChoice], ["bypassPermissions", "bypassPermissions"]);
  state = run([{ type: "modeRejected", permissionMode: "acceptEdits", modeChoice: "acceptEdits", message: "No se pudo cambiar el modo de permisos: no" }], state);
  assert.deepEqual([state.permissionMode, state.modeChoice, state.items.at(-1).tone], ["acceptEdits", "acceptEdits", "warn"]);
  // Al aprobar un plan el CLI cambia de modo: eso pasa a ser lo elegido para reanudar.
  state = run([line({ type: "system", subtype: "status", status: null, permissionMode: "default" })], run([{ type: "mode", mode: "plan" }]));
  assert.deepEqual([state.permissionMode, state.modeChoice], ["default", "default"]);
  assert.equal(run([line({ type: "system", subtype: "status", status: null, permissionMode: "default" })]).modeChoice, null);
});

test("only real permissions are accepted on their own; questions and plans still wait for the person", () => {
  const permission = (id, toolName) => ({ kind: "permission", id, toolName, toolUseId: null, input: {}, description: "", suggestions: [], state: "pending" });
  const items = [permission("a", "Bash"), permission("b", "AskUserQuestion"), permission("c", "ExitPlanMode"), { ...permission("d", "Edit"), state: "allowed" }];
  assert.deepEqual(chat.autoAllowed(items).map((item) => item.id), ["a"]);
  assert.ok(chat.allowsAll("bypassPermissions") && chat.allowsAll("full"));
  assert.ok(!chat.allowsAll("acceptEdits") && !chat.allowsAll("auto") && !chat.allowsAll(null));
});

test("context usage: the /context measure, live updates while answering and the share of the window", () => {
  const measure = {
    categories: [
      { name: "System prompt", tokens: 3234, kind: "used" }, { name: "System tools", tokens: 8259, kind: "used" },
      { name: "MCP tools (deferred)", tokens: 13586, isDeferred: true, kind: "deferred" }, { name: "Skills", tokens: 5289, kind: "used" },
      { name: "Messages", tokens: 4553, kind: "used" }, { name: "Autocompact buffer", tokens: 33000, kind: "buffer" },
      { name: "Free space", tokens: 945034, kind: "free" },
    ],
    totalTokens: 21335, maxTokens: 1000000, percentage: 2,
  };
  let state = run([{ type: "context", data: measure }]);
  assert.deepEqual(state.usage, { used: 21335, window: 1000000, reserve: 33000, total: null,
    parts: [{ name: "Instrucciones del sistema", tokens: 3234 }, { name: "Herramientas", tokens: 8259 }, { name: "Skills", tokens: 5289 }] });
  assert.equal(Math.round(chat.contextPercent(state.usage) * 10) / 10, 2.1);
  // Cada petición al modelo trae lo que entra en la ventana, venga o no de la caché.
  state = run([stream({ type: "message_start", message: { id: "m1", usage: { input_tokens: 2, cache_creation_input_tokens: 11891, cache_read_input_tokens: 10073, output_tokens: 1 } } })], state);
  assert.deepEqual([state.usage.used, state.usage.window, state.usage.parts.length], [21966, 1000000, 3]);
  assert.equal(run([{ type: "context", data: { error: "x" } }], state).usage.used, 21966, "una respuesta sin datos no borra la medida");
  assert.equal(run([stream({ type: "message_start", message: { id: "m2" } })]).usage, null);
  assert.equal(run([{ type: "reset" }], state).usage, null);
  assert.deepEqual([chat.formatTokens(950), chat.formatTokens(21966), chat.formatTokens(258400), chat.formatTokens(1000000)], ["950", "22 k", "258 k", "1 M"]);
});

test("fast mode is offered on the models that support it and follows what the CLI reports", () => {
  const models = [
    { value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus 5.5", supportsFastMode: true },
    { value: "sonnet", resolvedModel: "claude-sonnet-5-5", displayName: "Sonnet 5.5" },
  ];
  // Antes de elegir nada, el SDK informa «off» (pide activarlo en la sesión) y no se avisa de nada.
  let state = run([{ type: "catalog", models, fastState: "off" }]);
  assert.equal(chat.fastSpeed(state.models, "claude-opus-5-5", null).tier, "fast");
  assert.equal(chat.fastSpeed(state.models, "claude-sonnet-5-5", null), null);
  assert.equal(state.fast, false);

  state = run([{ type: "fast", fast: true }], state);
  assert.deepEqual([state.fast, state.fastChoice], [true, true]);
  // Con un modelo sin velocidad rápida el CLI la apaga sin motivo: vuelve sola al cambiar de modelo.
  state = run([line({ type: "result", subtype: "success", fast_mode_state: "off" })], state);
  assert.deepEqual([state.fast, kinds(state).includes("notice")], [true, false]);
  state = run([line({ type: "result", subtype: "success", fast_mode_state: "cooldown" })], state);
  assert.match(state.items.at(-1).text, /en pausa/);
  // Si la cuenta no puede usarla, se explica y se vuelve a la estándar.
  state = run([line({ type: "result", subtype: "success", fast_mode_state: "off", fast_mode_disabled_reason: "extra_usage_disabled" })], state);
  assert.deepEqual([state.fast, state.fastChoice, state.items.at(-1).tone], [false, false, "warn"]);
  assert.match(state.items.at(-1).text, /uso extra/);
  // Lo elegido sobrevive a una conversación nueva.
  assert.equal(run([{ type: "fast", fast: true }, { type: "reset" }], state).fastChoice, true);
});
