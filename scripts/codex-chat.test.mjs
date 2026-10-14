import assert from "node:assert/strict";
import test from "node:test";
import { load } from "./ts-loader.mjs";

// Mensajes con la forma real de `codex app-server` (0.162).
const shared = await load("chatState");
const codex = await load("codexChat");
const { codexReducer } = codex;
const { initialChatState, chatActivity } = shared;
const run = (actions, state = initialChatState()) => actions.reduce(codexReducer, state);
const rpc = (method, params, id) => ({ type: "rpc", message: id === undefined ? { method, params } : { id, method, params }, scope: "p1", now: 5000 });
const started = (item) => rpc("item/started", { item, threadId: "th", turnId: "tu" });
const completed = (item) => rpc("item/completed", { item, threadId: "th", turnId: "tu" });
const turnDone = (status, extra = {}) => rpc("turn/completed", { threadId: "th", turn: { id: "tu", items: [], status, error: null, durationMs: 5316, ...extra } });
const kinds = (state) => state.items.map((item) => item.kind);

test("profile arguments become server options or keep the terminal when the chat cannot honour them", () => {
  const questions = ["--enable", "default_mode_request_user_input"];
  assert.deepEqual(codex.codexLaunch(null), { flags: ["app-server", ...questions], resumeId: null, thread: {}, ignored: [] });
  const launch = codex.codexLaunch('-m gpt-6-luna -s read-only -c model_reasoning_summary="detailed" --enable foo --search');
  assert.deepEqual(launch.thread, { model: "gpt-6-luna", sandbox: "read-only" });
  assert.deepEqual(launch.flags, ["app-server", "-c", 'model_reasoning_summary=detailed', "--enable", "foo", "-c", 'web_search="live"', ...questions]);
  // Un perfil que apaga las preguntas en modo normal manda.
  assert.deepEqual(codex.codexLaunch("--disable default_mode_request_user_input").flags, ["app-server", "--disable", "default_mode_request_user_input"]);
  assert.deepEqual(codex.codexLaunch("--enable=default_mode_request_user_input").flags, ["app-server", ...questions]);
  assert.deepEqual(codex.codexLaunch("--yolo").thread, { sandbox: "danger-full-access", approvalPolicy: "never" });
  assert.deepEqual(codex.codexLaunch("--full-auto -a untrusted").thread, { sandbox: "workspace-write", approvalPolicy: "untrusted" });
  assert.equal(codex.codexLaunch("resume 01a12b9e-9814-76c3-a700-94397efd7727").resumeId, "01a12b9e-9814-76c3-a700-94397efd7727");
  assert.deepEqual(codex.codexLaunch("-i captura.png --no-alt-screen").ignored, ["-i captura.png"]);
  for (const args of ["exec", "--profile trabajo", "--remote ws://x", "--sandbox raro", "\"arregla el test\""]) {
    assert.equal(codex.codexLaunch(args), null, args);
  }
  assert.ok(codex.codexChatSupported("--model gpt-6-sol"));
  assert.deepEqual(codex.splitProfileArgs(`-c 'a=1 2' --config="b \\"c\\"" C:\\work\\app`), ["-c", "a=1 2", '--config=b "c"', "C:\\work\\app"]);
  assert.equal(codex.splitProfileArgs(`-c "abierta`), null);
  assert.equal(codex.codexLaunch(`-m 'sin cerrar`), null);
});

test("outgoing messages are JSON-RPC lines with images as data URLs", () => {
  assert.deepEqual(JSON.parse(codex.requestLine(3, "turn/start", { threadId: "th" })), { id: 3, method: "turn/start", params: { threadId: "th" } });
  assert.deepEqual(JSON.parse(codex.notificationLine("initialized")), { method: "initialized" });
  assert.deepEqual(JSON.parse(codex.resultLine(0, { decision: "accept" })), { id: 0, result: { decision: "accept" } });
  assert.equal(JSON.parse(codex.errorLine(7, "no")).error.message, "no");
  assert.deepEqual(codex.userInput("¿de qué color es?", [{ mediaType: "image/png", data: "AAAA" }]), [
    { type: "image", url: "data:image/png;base64,AAAA" },
    { type: "text", text: "¿de qué color es?", text_elements: [] },
  ]);
  assert.deepEqual(codex.userInput("", [{ mediaType: "image/jpeg", data: "BB" }]), [{ type: "image", url: "data:image/jpeg;base64,BB" }]);
});

test("streamed agent messages grow in place and the turn closes with its duration", () => {
  const message = { type: "agentMessage", id: "msg_1", text: "", phase: "final_answer" };
  let state = run([
    { type: "send", id: "u1", text: "hola", now: 1000 },
    rpc("turn/started", { threadId: "th", turn: { id: "tu", status: "inProgress" } }),
    started({ type: "userMessage", id: "um", content: [{ type: "text", text: "hola" }] }),
    started(message),
    rpc("item/agentMessage/delta", { itemId: "msg_1", delta: "Ho" }),
    rpc("item/agentMessage/delta", { itemId: "msg_1", delta: "la" }),
  ]);
  assert.deepEqual(kinds(state), ["user", "text"], "el mensaje del usuario en directo no se repite");
  assert.equal(state.items[1].text, "Hola");
  assert.equal(state.items[1].final, false);
  assert.equal(state.turnId, "tu");
  assert.equal(chatActivity(state), "working");
  state = run([completed({ ...message, text: "Hola." }), turnDone("completed")], state);
  assert.deepEqual(kinds(state), ["user", "text", "turn"]);
  assert.equal(state.items[1].text, "Hola.");
  assert.equal(state.items[1].final, true);
  assert.equal(state.items[2].durationMs, 5316);
  assert.equal(chatActivity(state), "idle");
  assert.equal(state.turnId, null);
});

test("commands read as tools: reads, searches and plain shell commands", () => {
  const command = (id, actions, extra = {}) => ({ type: "commandExecution", id, command: "/bin/zsh -lc 'x'", cwd: "/w", status: "inProgress",
    commandActions: actions, aggregatedOutput: null, exitCode: null, ...extra });
  const state = run([
    { type: "send", id: "u1", text: "mira", now: 0 },
    started(command("c1", [{ type: "read", command: "cat notas.txt", name: "notas.txt", path: "/w/notas.txt" }])),
    completed(command("c1", [{ type: "read", command: "cat notas.txt", name: "notas.txt", path: "/w/notas.txt" }], { status: "completed", aggregatedOutput: "uno\n", exitCode: 0 })),
    started(command("c2", [{ type: "unknown", command: "npm test" }])),
    rpc("item/commandExecution/outputDelta", { itemId: "c2", delta: "ok 1\n" }),
    rpc("item/commandExecution/outputDelta", { itemId: "c2", delta: "ok 2\n" }),
    started(command("c3", [{ type: "search", command: "rg foo src", query: "foo", path: "src" }])),
    completed(command("c3", [{ type: "search", command: "rg foo src", query: "foo", path: "src" }], { status: "completed", aggregatedOutput: "", exitCode: 1 })),
  ]);
  const [read, bash, grep] = state.items.filter((item) => item.kind === "tool");
  assert.deepEqual([read.name, read.input.file_path, read.status, read.output], ["Read", "/w/notas.txt", "done", "uno\n"]);
  assert.deepEqual([bash.name, bash.input.command, bash.status, bash.output], ["Bash", "npm test", "running", "ok 1\nok 2\n"]);
  assert.deepEqual([grep.name, grep.input.pattern, grep.status], ["Grep", "foo", "error"], "un código de salida distinto de 0 es un error");
  assert.equal(codex.shellCommand(`/bin/zsh -lc "printf 'hola' > a.txt && ls"`), "printf 'hola' > a.txt && ls");
  assert.equal(codex.shellCommand("/bin/bash -lc 'echo '\\''hola'\\'''"), "echo 'hola'");
  assert.equal(codex.shellCommand("ls -la"), "ls -la");
});

test("file changes show one row per file with its diff", () => {
  const state = run([
    completed({ type: "fileChange", id: "f1", status: "completed", changes: [
      { path: "/w/notas.txt", kind: { type: "update", move_path: null }, diff: "@@ -1,3 +1,3 @@\n linea uno\n-linea dos\n+línea dos editada\n linea tres\n" },
    ] }),
    completed({ type: "fileChange", id: "f2", status: "completed", changes: [
      { path: "/w/nuevo.txt", kind: { type: "add" }, diff: "hola\nadiós\n" },
      { path: "/w/viejo.txt", kind: { type: "delete" }, diff: "adiós\n" },
    ] }),
  ]);
  const [edit, write, remove] = state.items;
  assert.equal(edit.name, "Edit");
  assert.deepEqual(edit.patch, [{ kind: "ctx", text: "linea uno" }, { kind: "del", text: "linea dos" }, { kind: "add", text: "línea dos editada" }, { kind: "ctx", text: "linea tres" }]);
  assert.deepEqual([write.id, write.name, shared.diffStats(write.patch)], ["f2#0", "Write", { added: 2, removed: 0 }]);
  assert.deepEqual([remove.id, remove.name, shared.diffStats(remove.patch)], ["f2#1", "Delete", { added: 0, removed: 1 }]);
  assert.deepEqual(shared.describeTool("Delete", remove.input, "/w", false), { icon: "edit", verb: "Eliminó", target: "viejo.txt" });
});

test("approvals become cards and their answers use the decisions Codex offers", () => {
  const params = { kind: "command", threadId: "th", turnId: "tu", itemId: "c1", command: "/bin/zsh -lc 'rm -rf build'",
    commandActions: [{ type: "unknown", command: "rm -rf build" }],
    availableDecisions: ["accept", { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["rm", "-rf", "build"] } }, "cancel"] };
  let state = run([
    { type: "send", id: "u1", text: "limpia", now: 0 },
    started({ type: "commandExecution", id: "c1", command: params.command, status: "inProgress", commandActions: params.commandActions }),
    rpc("item/commandExecution/requestApproval", params, 0),
    rpc("item/commandExecution/requestApproval", params, 0),
  ]);
  const card = state.items.find((item) => item.kind === "permission");
  assert.equal(state.items.filter((item) => item.kind === "permission").length, 1);
  assert.deepEqual([card.id, card.toolName, card.input.command, card.toolUseId], ["p1:0", "Bash", "rm -rf build", "c1"]);
  assert.equal(chatActivity(state), "waiting");
  assert.deepEqual(card.suggestions, [{ type: "rule", label: "Permitir siempre este comando" }]);
  assert.deepEqual(codex.answerResult(card, true, false), { decision: "accept" });
  assert.deepEqual(codex.answerResult(card, false, false), { decision: "cancel" }, "sin «decline» se cancela");
  assert.deepEqual(codex.answerResult(card, true, true), { decision: params.availableDecisions[1] });

  state = run([
    completed({ type: "fileChange", id: "f1", status: "inProgress", changes: [{ path: "/w/a.txt", kind: { type: "add" }, diff: "hola\n" }] }),
    rpc("item/fileChange/requestApproval", { threadId: "th", turnId: "tu", itemId: "f1", reason: "Fuera del proyecto" }, 1),
  ], state);
  const edit = state.items.at(-1);
  assert.deepEqual([edit.toolName, edit.input.file_path, edit.description], ["Write", "/w/a.txt", "Fuera del proyecto"]);
  assert.deepEqual(edit.patch, [{ kind: "add", text: "hola" }]);
  assert.deepEqual(codex.answerResult(edit, true, true), { decision: "acceptForSession" });
  assert.deepEqual(codex.answerResult(edit, false, false), { decision: "decline" });

  // Codex retira la petición (por ejemplo, al detener el turno).
  state = run([rpc("serverRequest/resolved", { threadId: "th", requestId: 1 })], state);
  assert.equal(state.items.at(-1).state, "denied");
});

test("questions with options are answered by question id", () => {
  const state = run([rpc("item/tool/requestUserInput", { threadId: "th", turnId: "tu", itemId: "call_1", isBlocking: true, questions: [
    { id: "readme_language", header: "Idioma", question: "¿En qué idioma quieres el README?", isOther: true, isSecret: false,
      options: [{ label: "Español (Recommended)", description: "En español." }, { label: "Inglés", description: "En inglés." }] },
  ] }, 4)]);
  const card = state.items[0];
  assert.equal(card.toolName, "AskUserQuestion");
  const questions = shared.questionsOf(card.input);
  assert.deepEqual([questions[0].id, questions[0].header, questions[0].options.length], ["readme_language", "Idioma", 2]);
  assert.deepEqual([questions[0].options[0].title, questions[0].options[0].recommended, questions[0].other], ["Español", true, true]);
  assert.deepEqual(codex.answerResult(card, true, false, [{ question: questions[0].question, selected: ["Inglés"], other: " y algo de español " }]),
    { answers: { readme_language: { answers: ["Inglés", "y algo de español"] } } });
  assert.deepEqual(codex.answerResult(card, false, false, []), { answers: {} });
  const answered = codexReducer(state, { type: "answered", id: card.id, choices: [{ question: questions[0].question, selected: ["Inglés"], other: "" }] });
  assert.deepEqual(answered.items.map((item) => [item.kind, item.kind === "permission" ? item.state : item.name]), [["permission", "allowed"], ["tool", "AskUserQuestion"]]);
  assert.equal(answered.items[1].output, "¿En qué idioma quieres el README?\n→ Inglés");
  assert.deepEqual(answered.items[1].input.answers, { "¿En qué idioma quieres el README?": "Inglés" });
  assert.equal(chatActivity(answered), "idle");
});

test("open, closed and secret questions keep what Codex asked for", () => {
  const state = run([rpc("item/tool/requestUserInput", { threadId: "th", turnId: "tu", itemId: "call_2", isBlocking: false, autoResolutionMs: null, questions: [
    { id: "token", header: "Token", question: "¿Cuál es tu token?", isOther: false, isSecret: true, options: null },
    { id: "env", header: "Entorno", question: "¿Dónde despliego?", isOther: false, isSecret: false,
      options: [{ label: "Staging", description: "" }, { label: "Producción", description: "" }] },
  ] }, 9)]);
  const card = state.items[0];
  const [token, env] = shared.questionsOf(card.input);
  assert.deepEqual([token.kind, token.secret, token.other, token.options.length], ["text", true, true, 0], "sin opciones se responde escribiendo");
  assert.deepEqual([env.kind, env.other, env.secret], ["choice", false, false], "sin isOther solo valen las opciones");
  const choices = [{ question: token.question, selected: [], other: "s3cr3t" }, { question: env.question, selected: [], other: "" }];
  assert.deepEqual(codex.answerResult(card, true, false, choices), { answers: { token: { answers: ["s3cr3t"] } } });
  const answered = codexReducer(state, { type: "answered", id: card.id, choices });
  assert.deepEqual(answered.items[1].input.answers, { "¿Cuál es tu token?": "••••••" }, "la respuesta secreta no queda en el hilo");
  assert.ok(!answered.items[1].output.includes("s3cr3t"));
  // Omitida: queda en el hilo sin respuestas.
  const skipped = codexReducer(state, { type: "answered", id: card.id, choices: [] });
  assert.deepEqual(skipped.items[1].input.answers, {});
});

test("the warning about the questions feature is hidden but other features still warn", () => {
  const warning = (message) => run([rpc("warning", { threadId: "th", message })]).items.map((item) => item.text);
  assert.deepEqual(warning("Under-development features enabled: default_mode_request_user_input. Under-development features are incomplete and may behave unpredictably."), []);
  assert.deepEqual(warning("Under-development features enabled: default_mode_request_user_input, code_mode. They may break."),
    ["Under-development features enabled: code_mode. They may break."]);
  assert.deepEqual(warning("Otra advertencia."), ["Otra advertencia."]);
});

test("the plan usage comes from the account rate limits and their updates", () => {
  const read = { rateLimits: { limitId: "codex", primary: { usedPercent: 21, windowDurationMins: 10080, resetsAt: 1792472308 }, secondary: null,
    credits: { hasCredits: false, unlimited: false, balance: "0" }, planType: "prolite", rateLimitReachedType: null },
    rateLimitsByLimitId: { codex: { limitId: "codex", primary: { usedPercent: 21, windowDurationMins: 10080, resetsAt: 1792472308 }, secondary: null, planType: "prolite" } },
    rateLimitResetCredits: { availableCount: 2, credits: [] } };
  let state = codexReducer(initialChatState(), { type: "plan", data: read });
  assert.equal(state.plan.plan, "Pro Lite");
  assert.equal(state.plan.resetCredits, 2);
  assert.deepEqual(state.plan.windows.map((window) => [window.label, window.percent, window.resetsAt, window.headline]), [["Semana", 21, 1792472308000, true]]);
  // Las actualizaciones solo traen lo que cambió: lo demás se conserva.
  state = run([rpc("account/rateLimits/updated", { rateLimits: { limitId: "codex", primary: { usedPercent: 24, windowDurationMins: 10080, resetsAt: 1792472308 },
    secondary: { usedPercent: 80, windowDurationMins: 300, resetsAt: 1792000000 }, planType: null } })], state);
  assert.deepEqual(state.plan.windows.map((window) => [window.label, window.percent, window.severity]), [["Semana", 24, "normal"], ["Sesión (5 h)", 80, "warning"]]);
  assert.equal(state.plan.windows.find((window) => window.headline).label, "Sesión (5 h)");
  assert.equal(state.plan.plan, "Pro Lite");
  assert.equal(state.plan.resetCredits, 2);
  assert.equal(state.items.length, 0, "sin llegar al límite no hay aviso");
});

test("an interruption closes running tools and failures are reported once", () => {
  let state = run([
    { type: "send", id: "u1", text: "espera", now: 0 },
    started({ type: "commandExecution", id: "c1", command: "sleep 20", status: "inProgress", commandActions: [] }),
    turnDone("interrupted"),
  ]);
  assert.equal(state.items[1].status, "error");
  assert.deepEqual([state.items.at(-1).kind, state.items.at(-1).tone], ["notice", "info"]);
  assert.equal(state.pendingTurns, 0);

  state = run([
    { type: "send", id: "u2", text: "hola", now: 0 },
    rpc("error", { error: { message: "Reconectando" }, willRetry: true, threadId: "th", turnId: "tu" }),
    rpc("error", { error: { message: "Límite de contexto" }, willRetry: false, threadId: "th", turnId: "tu" }),
    turnDone("failed", { error: { message: "Límite de contexto" } }),
  ], state);
  const errors = state.items.filter((item) => item.kind === "notice" && item.tone === "error");
  assert.deepEqual(errors.map((item) => item.text), ["Límite de contexto"]);
});

test("history shows saved turns with their images and is not duplicated", () => {
  const turns = [{ id: "t1", status: "completed", durationMs: 7720, items: [
    { type: "userMessage", id: "u1", content: [{ type: "image", url: "data:image/png;base64,AAAA" }, { type: "text", text: "¿De qué color es?" }] },
    { type: "reasoning", id: "r1", summary: ["Miro la imagen"], content: [] },
    { type: "agentMessage", id: "m1", text: "Es roja.", phase: "final_answer" },
    { type: "commandExecution", id: "c1", command: "ls", status: "inProgress", commandActions: [] },
  ] }, { id: "t2", status: "interrupted", items: [{ type: "userMessage", id: "u2", content: [{ type: "text", text: "sigue" }] }] }];
  const live = run([{ type: "send", id: "new", text: "otra", now: 0 }]);
  const state = codexReducer(live, { type: "history", turns });
  assert.deepEqual(kinds(state), ["user", "thinking", "text", "tool", "user", "notice", "user"]);
  assert.deepEqual(state.items[0], { kind: "user", id: "u1", text: "¿De qué color es?", images: 1, previews: ["data:image/png;base64,AAAA"] });
  assert.equal(state.items[1].text, "Miro la imagen");
  assert.equal(state.items[3].status, "done", "una herramienta cortada en el historial no queda girando");
  assert.equal(state.items.at(-1).id, "new");
  const again = codexReducer(state, { type: "history", turns: turns.slice(0, 1) });
  assert.deepEqual(again.items.map((item) => item.id), ["u1", "r1", "m1", "c1", "new"]);
});

test("models, effort and mode come from Codex and the next turn carries the choices", () => {
  const data = [
    { id: "gpt-6.1-sol", model: "gpt-6.1-sol", displayName: "GPT-6.1-Sol", description: "Latest workhorse", hidden: false, isDefault: true,
      supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "ultra" }], defaultReasoningEffort: "low" },
    { id: "gpt-reserve", model: "gpt-reserve", displayName: "GPT-Reserve", hidden: true, supportedReasoningEfforts: [] },
  ];
  let state = run([
    { type: "models", data },
    { type: "thread", response: { thread: { id: "01a12b9e-9814-76c3-a700-94397efd7727" }, model: "gpt-6.1-sol", reasoningEffort: "xhigh",
      approvalPolicy: "on-request", sandbox: { type: "workspaceWrite" } } },
  ]);
  assert.deepEqual(state.models.map((model) => [model.value, model.featured, model.efforts, model.defaultEffort]), [["gpt-6.1-sol", true, ["low", "ultra"], "low"]]);
  assert.deepEqual([state.sessionId, state.model, state.effort, state.permissionMode], ["01a12b9e-9814-76c3-a700-94397efd7727", "gpt-6.1-sol", "xhigh", "auto"]);
  assert.deepEqual(shared.supportedEfforts(state.models, state.model, null), ["low", "ultra"]);
  assert.equal(shared.effortLabel("ultra"), "Ultra");

  state = run([rpc("thread/settings/updated", { threadId: "th", threadSettings: { model: "gpt-6-luna", effort: "low",
    sandboxPolicy: { type: "readOnly" }, collaborationMode: { mode: "plan" } } })], state);
  assert.deepEqual([state.model, state.effort, state.permissionMode], ["gpt-6-luna", "low", "plan"]);

  assert.deepEqual(codex.turnOverrides({ mode: null, model: null, effort: null }, { model: "m", effort: "low" }), {});
  const plan = codex.turnOverrides({ mode: "plan", model: null, effort: "high" }, { model: "gpt-6-luna", effort: "low" });
  assert.deepEqual(plan.collaborationMode, { mode: "plan", settings: { model: "gpt-6-luna", reasoning_effort: "high", developer_instructions: null } });
  assert.equal(plan.effort, "high");
  const full = codex.turnOverrides({ mode: "full", model: "gpt-6-sol", effort: null }, { model: null, effort: null });
  assert.deepEqual([full.approvalPolicy, full.sandboxPolicy, full.model, full.collaborationMode.mode], ["never", { type: "dangerFullAccess" }, "gpt-6-sol", "default"]);
  assert.equal(codex.turnOverrides({ mode: "read-only", model: null, effort: null }, { model: null, effort: null }).sandboxPolicy.type, "readOnly");
});

test("plans and task lists keep growing in a single row", () => {
  const state = run([
    { type: "send", id: "u1", text: "planifica", now: 0 },
    rpc("turn/plan/updated", { threadId: "th", turnId: "tu", plan: [{ step: "Leer", status: "completed" }, { step: "Editar", status: "inProgress" }] }),
    rpc("turn/plan/updated", { threadId: "th", turnId: "tu", plan: [{ step: "Leer", status: "completed" }, { step: "Editar", status: "completed" }] }),
    started({ type: "plan", id: "tu-plan", text: "" }),
    rpc("item/plan/delta", { itemId: "tu-plan", delta: "# Plan\n" }),
    rpc("item/plan/delta", { itemId: "tu-plan", delta: "- Paso" }),
  ]);
  const tools = state.items.filter((item) => item.kind === "tool");
  assert.equal(tools.length, 2);
  assert.deepEqual(shared.todoItems(tools[0].input).map((todo) => todo.status), ["completed", "completed"]);
  assert.deepEqual([tools[1].name, tools[1].input.plan], ["ExitPlanMode", "# Plan\n- Paso"]);
  const done = run([completed({ type: "plan", id: "tu-plan", text: "# Plan\n- Paso\n" })], state);
  assert.equal(done.items.at(-1).input.plan, "# Plan\n- Paso\n");
});

test("notices from Codex are shown once and the process lifecycle is shared with Claude", () => {
  const state = run([
    { type: "spawned" },
    rpc("warning", { threadId: null, message: "Config antigua" }),
    rpc("warning", { threadId: null, message: "Config antigua" }),
    rpc("model/rerouted", { threadId: "th", turnId: "tu", fromModel: "gpt-6.1-sol", toModel: "gpt-6-sol", reason: "x" }),
    rpc("account/rateLimits/updated", { rateLimits: { primary: { usedPercent: 7 }, rateLimitReachedType: null } }),
    rpc("account/rateLimits/updated", { rateLimits: { primary: { usedPercent: 100, resetsAt: 1792295892 }, rateLimitReachedType: "primary" } }),
    { type: "send", id: "u1", text: "hola", now: 0 },
    rpc("item/commandExecution/requestApproval", { itemId: "c1", command: "ls", availableDecisions: ["accept", "decline"] }, 2),
    { type: "exit", code: 1 },
  ]);
  const notices = state.items.filter((item) => item.kind === "notice");
  assert.deepEqual(notices.map((item) => item.tone), ["warn", "info", "warn"]);
  assert.equal(state.model, "gpt-6-sol");
  assert.equal(state.process, "exited");
  assert.equal(state.items.at(-1).state, "denied");
  assert.equal(chatActivity(state), "idle");
});

test("a review result is shown once even when Codex sends it twice", () => {
  const review = "[P2] Quita la resta de más en average.";
  // Así llega en Codex 0.162: primero el fin de la revisión y después el mensaje.
  const state = run([
    completed({ type: "enteredReviewMode", id: "r0", review: "cambios sin confirmar" }),
    completed({ type: "exitedReviewMode", id: "r1", review }),
    started({ type: "agentMessage", id: "m1", text: "", phase: "final_answer" }),
    completed({ type: "agentMessage", id: "m1", text: review, phase: "final_answer" }),
  ]);
  assert.deepEqual(state.items.map((item) => item.kind), ["notice", "text"]);
  const reversed = run([
    completed({ type: "agentMessage", id: "m1", text: review, phase: "final_answer" }),
    completed({ type: "exitedReviewMode", id: "r1", review }),
  ]);
  assert.deepEqual(reversed.items.map((item) => item.id), ["m1"]);
  const alone = run([completed({ type: "exitedReviewMode", id: "r1", review })]);
  assert.equal(alone.items[0].text, review);
});

test("a new thread keeps the model and effort chosen in the chat", () => {
  const state = run([
    { type: "effort", effort: "low" },
    { type: "thread", response: { thread: { id: "th-2" }, model: "gpt-6.1-sol", reasoningEffort: "xhigh", sandbox: { type: "readOnly" } } },
  ]);
  assert.deepEqual([state.sessionId, state.model, state.effort, state.permissionMode], ["th-2", "gpt-6.1-sol", "low", "read-only"]);
});

test("«Permitir todo» accepts Codex permissions on its own, but never its questions", () => {
  assert.deepEqual(codex.autoApproval("item/commandExecution/requestApproval", { availableDecisions: ["accept", "acceptForSession", "cancel"] }), { decision: "accept" });
  assert.deepEqual(codex.autoApproval("item/fileChange/requestApproval", {}), { decision: "accept" });
  assert.deepEqual(codex.autoApproval("item/permissions/requestApproval", { permissions: { network: { enabled: true } } }),
    { permissions: { network: { enabled: true } }, scope: "turn" });
  assert.equal(codex.autoApproval("item/tool/requestUserInput", { questions: [] }), null);
  assert.equal(codex.autoApproval("mcpServer/elicitation/request", {}), null);
});

test("the mode shown is the one that will apply: chosen in the chat, or what really stops to ask", () => {
  const thread = (settings) => run([{ type: "thread", response: { thread: { id: "th" }, model: "m", ...settings } }]);
  assert.equal(thread({ sandbox: { type: "dangerFullAccess" }, approvalPolicy: "never" }).permissionMode, "full");
  assert.equal(thread({ sandbox: { type: "dangerFullAccess" }, approvalPolicy: "on-request" }).permissionMode, "auto", "sin sandbox pero preguntando no es «Permitir todo»");
  assert.equal(thread({ sandbox: { type: "workspaceWrite" }, approvalPolicy: "on-request" }).permissionMode, "auto");
  // Hasta el siguiente turno el hilo conserva el modo anterior; la bandeja enseña el elegido.
  const settings = rpc("thread/settings/updated", { threadId: "th", threadSettings: { model: "m", effort: "low", approvalPolicy: "on-request",
    sandboxPolicy: { type: "workspaceWrite" }, collaborationMode: { mode: "default" } } });
  assert.equal(run([{ type: "mode", mode: "full" }, settings]).permissionMode, "full");
  assert.equal(run([settings]).permissionMode, "auto");
  assert.equal(run([], initialChatState("full")).modeChoice, "full", "la pestaña recuerda el modo elegido");
});

test("context usage counts the last request and keeps the conversation total", () => {
  const usage = (last, total, modelContextWindow = 475000) => rpc("thread/tokenUsage/updated", { threadId: "th", turnId: "tu",
    tokenUsage: { last, total, modelContextWindow } });
  let state = run([usage({ totalTokens: 20876, inputTokens: 20871, outputTokens: 5 }, { totalTokens: 64000, inputTokens: 63000, outputTokens: 1000 })]);
  assert.deepEqual(state.usage, { used: 20876, window: 475000, parts: [], reserve: null, total: 64000 });
  state = run([usage({ inputTokens: 30000, outputTokens: 200 }, null, null)], state);
  assert.deepEqual([state.usage.used, state.usage.window, state.usage.total], [30200, 475000, null], "sin ventana nueva se conserva la anterior");
});

test("the context shows from the start with the window of the chosen model", () => {
  const list = [{ id: "a", model: "gpt-6.1-sol", displayName: "Sol", supportedReasoningEfforts: [] },
    { id: "b", model: "gpt-6-luna", displayName: "Luna", supportedReasoningEfforts: [] }];
  let state = run([{ type: "models", data: list, windows: { "gpt-6.1-sol": 475000, "gpt-6-luna": 258400 } },
    { type: "thread", response: { thread: { id: "th" }, model: "gpt-6.1-sol" } }]);
  assert.deepEqual(shared.shownUsage(state), { used: 0, window: 475000, parts: [], reserve: null, total: null });
  state = run([{ type: "model", model: "gpt-6-luna" }], state);
  assert.equal(shared.shownUsage(state).window, 258400, "al cambiar de modelo cambia la ventana");
  const measured = run([rpc("thread/tokenUsage/updated", { tokenUsage: { last: { totalTokens: 9000 }, total: { totalTokens: 9000 }, modelContextWindow: 475000 } })], state);
  assert.equal(shared.shownUsage(measured).used, 9000, "lo medido manda");
  assert.equal(shared.shownUsage(run([{ type: "models", data: list }])), null, "sin ventana conocida no se inventa nada");
});
