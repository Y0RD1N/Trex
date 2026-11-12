import assert from "node:assert/strict";
import test from "node:test";
import { load } from "./ts-loader.mjs";

const { remoteStatus, remoteNeed, remoteItems, remotePending, remoteDetail, currentActivity, parseRemoteCommand, timeAgo, DETAIL_ITEMS, pendingItem } = await load("remoteProtocol");
const { initialChatState } = await load("chatState");

const permission = (id, toolName, input, extra = {}) => ({ kind: "permission", id, toolName, toolUseId: null, input, description: "", suggestions: [], state: "pending", ...extra });
const tool = (id, name, input, status = "done", extra = {}) => ({ kind: "tool", id, name, input, status, output: null, patch: null, ...extra });
const state = (items, patch = {}) => ({ ...initialChatState(), items, process: "ready", ...patch });

test("una sesión que espera un permiso o una respuesta va antes que una que trabaja", () => {
  assert.equal(remoteStatus(state([permission("p", "Bash", { command: "ls" })], { pendingTurns: 1 })), "needs");
  assert.equal(remoteStatus(state([], { pendingTurns: 1 })), "working");
  assert.equal(remoteStatus(state([])), "idle");
  assert.equal(remoteStatus(state([], { process: "exited" })), "exited");
  // Un permiso ya respondido no la deja esperando.
  assert.equal(remoteStatus(state([permission("p", "Bash", { command: "ls" }, { state: "allowed" })])), "idle");
});

test("la línea de lo que te espera distingue permisos, preguntas y planes", () => {
  const question = permission("q", "AskUserQuestion", { questions: [{ question: "¿Dónde guardo el carrito?", options: [{ label: "A" }] }, { question: "¿Correo?", options: [] }] });
  assert.deepEqual(remoteNeed(question, "/p"), { kind: "question", item: "q", label: "¿Dónde guardo el carrito? (+1)" });
  assert.equal(remoteNeed(permission("x", "ExitPlanMode", { plan: "..." }), "/p").kind, "plan");
  const bash = remoteNeed(permission("b", "Bash", { command: "cargo test" }), "/p");
  assert.equal(bash.kind, "permission");
  assert.match(bash.label, /cargo test/);
  assert.equal(remoteNeed(null, "/p"), null);
});

test("el móvil recibe el comando entero, su carpeta y el «permitir siempre» del propio asistente", () => {
  const command = "cargo test --lib remote::pairing && echo " + "x".repeat(300);
  const item = permission("b", "Bash", { command, description: "Pruebas" }, { suggestions: [{ label: "Permitir cargo test en este proyecto" }] });
  const pending = remotePending(item, "D:/trex");
  assert.equal(pending.command, command);
  assert.equal(pending.cwd, "D:/trex");
  assert.equal(pending.remember, "Permitir cargo test en este proyecto");
  assert.equal(pending.description, "Pruebas");
  assert.equal(remotePending(permission("b", "Bash", { command: "ls" }), "/p").remember, null);
  const question = remotePending(permission("q", "AskUserQuestion", { questions: [{ question: "¿Sí?", options: [{ label: "Sí (Recommended)", description: "d" }, { label: "No" }] }] }), "/p");
  assert.equal(question.questions[0].options[0].title, "Sí");
  assert.equal(question.questions[0].options[0].label, "Sí (Recommended)");
  assert.equal(question.questions[0].options[0].recommended, true);
});

test("el hilo omite el pensamiento y las listas de tareas, y cuenta los cambios de cada herramienta", () => {
  const items = remoteItems([
    { kind: "user", id: "u", text: "hola", images: 1, previews: [] },
    { kind: "thinking", id: "th", messageId: "m", text: "secreto", final: true },
    { kind: "text", id: "t", messageId: "m", text: "  ", final: true },
    tool("todo", "TodoWrite", { todos: [] }),
    tool("e", "Edit", { file_path: "/p/src/a.ts" }, "done", { changeStats: { added: 4, removed: 1 } }),
    { kind: "turn", id: "turn", durationMs: 1200 },
  ], "/p");
  assert.deepEqual(items.map(item => item.kind), ["user", "tool", "turn"]);
  assert.equal(items[1].added, 4);
  assert.equal(items[1].removed, 1);
});

test("el detalle manda solo el final del hilo y dice cuánto queda en el PC", () => {
  const many = Array.from({ length: DETAIL_ITEMS + 15 }, (_, index) => ({ kind: "user", id: `u${index}`, text: String(index), images: 0, previews: [] }));
  const detail = remoteDetail({ id: "s", state: state(many), cwd: "/p", tasks: [{ id: "a", title: "Leer", status: "completed", owner: "x" }, { id: "b", title: "Probar", status: "in_progress", owner: "x" }],
    queues: true, queued: 2, dormant: false, locked: null });
  assert.equal(detail.items.length, DETAIL_ITEMS);
  assert.equal(detail.hidden, 15);
  assert.equal(detail.items.at(-1).text, String(DETAIL_ITEMS + 14));
  assert.deepEqual(detail.tasks, { done: 1, total: 2, current: "Probar" });
  assert.equal(detail.queues, true);
});

test("la actividad es la herramienta en curso del turno actual", () => {
  assert.match(currentActivity([tool("r", "Read", { file_path: "/p/a.rs" }), tool("b", "Bash", { command: "npm test" }, "running")], "/p"), /npm test/);
  assert.equal(currentActivity([tool("b", "Bash", { command: "npm test" }, "running"), { kind: "user", id: "u", text: "x", images: 0, previews: [] }], "/p"), null);
  assert.equal(currentActivity([tool("t", "TodoWrite", { todos: [] }, "running")], "/p"), null);
});

test("solo se aceptan órdenes conocidas con la forma esperada", () => {
  assert.deepEqual(parseRemoteCommand({ command: 3, device: "d", session: "s", action: { kind: "send", text: "hola" } }).action, { kind: "send", text: "hola", files: [] });
  assert.equal(parseRemoteCommand({ command: 3, session: "s", action: { kind: "send", text: "  " } }), null);
  assert.equal(parseRemoteCommand({ command: "3", session: "s", action: { kind: "interrupt" } }), null);
  assert.equal(parseRemoteCommand({ command: 3, session: "s", action: { kind: "shell" } }), null);
  const answer = parseRemoteCommand({ command: 1, session: "s", action: { kind: "answer", item: "p", allowed: "yes", choices: [{ question: "q", selected: ["A", 2], other: 5 }] } });
  assert.equal(answer.action.allowed, false);
  assert.deepEqual(answer.action.choices, [{ question: "q", selected: ["A"], other: "" }]);
});

test("lo enviado desde el móvil puede ser solo adjuntos, y el hilo muestra los nombres de los archivos", () => {
  const files = [{ path: "C:/datos/attachments/1/foto.png", name: "foto.png", image: true }, { path: 7 }, { path: "C:/x/informe.pdf", image: "sí" }];
  const parsed = parseRemoteCommand({ command: 2, session: "s", action: { kind: "send", text: "", files } });
  assert.deepEqual(parsed.action.files, [{ path: "C:/datos/attachments/1/foto.png", name: "foto.png", image: true }, { path: "C:/x/informe.pdf", name: "informe.pdf", image: false }]);
  assert.equal(parseRemoteCommand({ command: 2, session: "s", action: { kind: "send", text: " ", files: [] } }), null);
  const [user] = remoteItems([{ kind: "user", id: "u", text: "Revisa esto\n\nArchivos adjuntos:\n[Archivo 1]: C:\\datos\\informe.pdf\n[Archivo 2]: /tmp/notas.md", images: 2, previews: [] }], "/p");
  assert.equal(user.text, "Revisa esto");
  assert.deepEqual(user.files, ["informe.pdf", "notas.md"]);
  assert.equal(user.images, 2);
});

test("las fechas relativas son cortas", () => {
  const now = 10 * 86_400_000;
  assert.equal(timeAgo(now - 10_000, now), "ahora");
  assert.equal(timeAgo(now - 5 * 60_000, now), "5 min");
  assert.equal(timeAgo(now - 3 * 3_600_000, now), "3 h");
  assert.equal(timeAgo(now - 26 * 3_600_000, now), "ayer");
  assert.equal(timeAgo(0, now), "");
  assert.equal(pendingItem([]), null);
});
