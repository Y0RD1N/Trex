import assert from "node:assert/strict";
import test from "node:test";
import { load } from "./ts-loader.mjs";

const { pendingTextQuestion, questionInstructions, textQuestionAnswer, textQuestions } = await load("chatQuestions");
const { initialChatState, questionsOf } = await load("chatState");
const { chatReducer, claudeChatFlags } = await load("claudeChat");
const { codexReducer, answerResult } = await load("codexChat");
const screenshot = "¿Qué estilo prefieres para el Short? Mientras reviso las imágenes, puedo avanzar con un edit cinematográfico de unos 35–45 segundos.\n\n- Edit con música, zooms y frases breves\n- Resumen con narración en español";
const message = (id = "m1", text = screenshot, final = true) => ({ kind: "text", id, messageId: id, text, final });
const user = { kind: "user", id: "u1", text: "Haz un Short", images: 0, previews: [] };

test("la pregunta de la captura ofrece opciones y una respuesta propia en ambos proveedores", () => {
  const codex = codexReducer(initialChatState(), { type: "rpc", scope: "p", now: 1, message: { method: "item/completed",
    params: { item: { id: "m1", type: "agentMessage", text: screenshot } } } });
  const claude = chatReducer(initialChatState(), { type: "line", now: 1, event: { type: "assistant",
    message: { id: "m1", content: [{ type: "text", text: screenshot }] } } });
  for (const state of [codex, claude]) {
    const card = pendingTextQuestion(state.items);
    const [question] = questionsOf(card.input);
    assert.equal(question.question, screenshot.split("\n")[0]);
    assert.deepEqual(question.options.map(option => option.title), ["Edit con música, zooms y frases breves", "Resumen con narración en español"]);
    assert.equal(question.other, true);
    assert.equal(card.request, undefined, "es un mensaje, no una petición RPC del proveedor");
    assert.equal(textQuestionAnswer([{ question: question.question, selected: [question.options[1].label], other: "" }]),
      `${question.question}\n→ Resumen con narración en español`);
  }
});

test("admite varias preguntas, listas numeradas, recomendaciones y descripciones", () => {
  const questions = questionsOf({ questions: textQuestions("¿Qué formato prefieres?\n\n1. **Vertical (Recommended)** — Para el Short\n2. **Horizontal** — Para YouTube\n\nWhich color should I use?\n\nA) Blue\nB) Green") });
  assert.equal(questions.length, 2);
  assert.deepEqual(questions[0].options.map(option => [option.title, option.description, option.recommended]),
    [["Vertical", "Para el Short", true], ["Horizontal", "Para YouTube", false]]);
  assert.deepEqual(questions[1].options.map(option => option.label), ["Blue", "Green"]);
  const indented = textQuestions("¿Quieres continuar?\n\n**Opciones:**\n  - Sí\n  - No");
  assert.deepEqual(indented[0].options.map(option => option.label), ["Sí", "No"]);
});

test("no convierte código, citas, tareas, resúmenes o listas normales en preguntas", () => {
  const unrelated = [
    "Cambios realizados:\n- Color azul\n- Color verde",
    "¿Qué cambié?\n- Color azul\n- Color verde",
    "¿Qué formato prefieres?\n- [x] Leer\n- [ ] Editar",
    "```md\n¿Qué formato prefieres?\n- Azul\n- Verde\n```",
    "~~~md\n¿Qué formato prefieres?\n- Azul\n- Verde\n~~~",
    "> ¿Qué formato prefieres?\n> - Azul\n> - Verde",
    "    ¿Qué formato prefieres?\n    - Azul\n    - Verde",
    "¿Qué formato prefieres?\n- Una sola opción",
    "¿Qué formato prefieres?\n- Azul\n- Azul",
    "¿Qué formato prefieres?\n- Azul\n  - Detalle\n- Verde",
  ];
  for (const value of unrelated) assert.deepEqual(textQuestions(value), [], value);
});

test("espera el mensaje completo y mantiene la pregunta mientras el agente sigue trabajando", () => {
  assert.equal(pendingTextQuestion([user, message("m1", screenshot, false)]), null);
  const working = [user, message(), { kind: "tool", id: "t1", name: "Bash", input: { command: "ls" }, status: "running", output: null, patch: null }, message("m2", "Voy revisando las imágenes.")];
  assert.equal(pendingTextQuestion(working).id, "text-question:m1");
  assert.equal(pendingTextQuestion([...working, { ...user, id: "u2", text: "El segundo" }]), null);
  assert.equal(pendingTextQuestion([...working, message("m3", "¿Qué color prefieres?\n- Azul\n- Verde")]).id, "text-question:m3");
});

test("la pregunta nativa tiene prioridad y no se duplica tras responder u omitir", () => {
  for (const state of ["pending", "allowed", "denied"]) {
    assert.equal(pendingTextQuestion([user, message(), { kind: "permission", id: "p", toolName: "AskUserQuestion", state }]), null);
    assert.equal(pendingTextQuestion([user, { kind: "permission", id: "p", toolName: "AskUserQuestion", state }, message()]), null);
  }
  assert.equal(pendingTextQuestion([user, message(), { kind: "tool", id: "t", name: "AskUserQuestion", status: "done" }]), null);
});

test("las respuestas libres y múltiples conservan su pregunta y omitir no envía nada", () => {
  assert.equal(textQuestionAnswer([{ question: "¿Formato?", selected: [], other: "  Cuadrado  " },
    { question: "¿Colores?", selected: ["Azul", "Verde"], other: "Rojo" }, { question: "¿Música?", selected: [], other: " " }]),
  "¿Formato?\n→ Cuadrado\n\n¿Colores?\n→ Azul, Verde, Rojo");
  assert.equal(textQuestionAnswer([]), "");
});

test("las instrucciones piden la herramienta interactiva adecuada y respetan el perfil de Claude", () => {
  assert.match(questionInstructions("codex"), /use request_user_input/);
  assert.match(questionInstructions("claude"), /use AskUserQuestion/);
  const flags = claudeChatFlags(null, null);
  assert.ok(flags[flags.indexOf("--append-system-prompt") + 1].includes(questionInstructions("claude")));
  assert.ok(!claudeChatFlags("--append-system-prompt 'Personalizado'", null).includes("--append-system-prompt"));
});

test("Codex sigue contestando las preguntas nativas con los IDs originales", () => {
  const state = codexReducer(initialChatState(), { type: "rpc", scope: "p", now: 1, message: { id: 7, method: "item/tool/requestUserInput",
    params: { questions: [{ id: "style", question: "¿Qué estilo prefieres?", options: [{ label: "Edit" }, { label: "Resumen" }] }] } } });
  const card = state.items[0];
  assert.deepEqual(answerResult(card, true, false, [{ question: "¿Qué estilo prefieres?", selected: ["Resumen"], other: "" }]),
    { answers: { style: { answers: ["Resumen"] } } });
});
