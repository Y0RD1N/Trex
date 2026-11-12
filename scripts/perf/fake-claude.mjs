#!/usr/bin/env node
/**
 * Claude Code falso para medir el rendimiento de Trex sin gastar tokens.
 *
 * Habla el mismo protocolo que `claude -p --input-format stream-json --output-format
 * stream-json --include-partial-messages`: responde a las peticiones de control y, por
 * cada mensaje del usuario, emite una respuesta larga fragmento a fragmento (texto con
 * Markdown, bloques de código y llamadas a herramientas) a un ritmo fijo y repetible.
 *
 * Variables:
 *   FAKE_CHUNK_MS  milisegundos entre fragmentos (por defecto 20; 0 = sin esperas)
 *   FAKE_CHUNK     caracteres por fragmento (por defecto 12)
 *   FAKE_REPEAT    veces que se repite el texto base en cada respuesta (por defecto 3)
 *   FAKE_TOOL_MS   lo que tarda cada herramienta (por defecto 1500)
 * Un mensaje que contenga "[wait N]" deja el turno abierto N segundos sin escribir
 * (escenario "trabajando sin texto").
 */
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";

// FAKE_ARGV_LOG: anota con qué opciones lo lanzó Trex (para comprobar lo que recibe cada sesión).
if (process.env.FAKE_ARGV_LOG) appendFileSync(process.env.FAKE_ARGV_LOG, JSON.stringify(process.argv.slice(2)) + "\n");

const CHUNK_MS = Number(process.env.FAKE_CHUNK_MS ?? 20);
const CHUNK = Number(process.env.FAKE_CHUNK ?? 12);
const REPEAT = Number(process.env.FAKE_REPEAT ?? 3);
const TOOL_MS = Number(process.env.FAKE_TOOL_MS ?? 1500);
const sessionId = randomUUID();
const out = (event) => process.stdout.write(JSON.stringify(event) + "\n");
const sleep = (ms) => ms > 0 ? new Promise(resolve => setTimeout(resolve, ms)) : Promise.resolve();

const PARAGRAPH = "El componente recibe los eventos del proceso, los agrupa por tandas y actualiza el estado " +
  "de la conversación. Cada fragmento añade texto al último bloque, y la vista solo vuelve a interpretar " +
  "el bloque que está cambiando, de modo que el coste no crece con el historial. ";
const BASE = [
  "## Resumen de los cambios\n\n", PARAGRAPH, PARAGRAPH, "\n\n",
  "- **Interfaz**: se memorizan los bloques ya terminados.\n- **Backend**: la cola de mensajes deja de sondear.\n",
  "- **Terminal**: la salida se entrega en lotes.\n\n",
  "```ts\nexport function applyDelta(state: ChatState, piece: string): ChatState {\n  const items = [...state.items];\n",
  "  const last = items[items.length - 1];\n  items[items.length - 1] = { ...last, text: last.text + piece };\n  return { ...state, items };\n}\n```\n\n",
  PARAGRAPH, "\n\n| Escenario | Antes | Después |\n|---|---|---|\n| Reposo | 15 % | 0 % |\n| Streaming | 40 % | 12 % |\n\n",
  "```rust\nfn emit(app: &AppHandle, id: &str, line: String) {\n    let _ = app.emit(&format!(\"agent-line-{id}\"), line);\n}\n```\n\n",
  "> [!NOTE]\n> Las medidas se toman siempre con la misma carga.\n\n", PARAGRAPH, "\n",
].join("");

let messageCounter = 0;
let fast = false;
async function streamText(text, messageId) {
  out({ type: "stream_event", session_id: sessionId, event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } });
  for (let at = 0; at < text.length; at += CHUNK) {
    out({ type: "stream_event", session_id: sessionId, event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: text.slice(at, at + CHUNK) } } });
    if (!fast) await sleep(CHUNK_MS);
  }
  out({ type: "stream_event", session_id: sessionId, event: { type: "content_block_stop", index: 0 } });
  out({ type: "assistant", session_id: sessionId, message: { id: messageId, role: "assistant", model: "claude-fake", content: [{ type: "text", text }] } });
}

async function tool(name, input, result) {
  const messageId = `msg_fake_${++messageCounter}`;
  const toolId = `toolu_fake_${messageCounter}`;
  out({ type: "stream_event", session_id: sessionId, event: { type: "message_start", message: { id: messageId, usage: { input_tokens: 1200, output_tokens: 40 } } } });
  out({ type: "stream_event", session_id: sessionId, event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: toolId, name, input: {} } } });
  out({ type: "assistant", session_id: sessionId, message: { id: messageId, role: "assistant", model: "claude-fake", content: [{ type: "tool_use", id: toolId, name, input }] } });
  if (!fast) await sleep(TOOL_MS);
  out({ type: "user", session_id: sessionId, message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolId, content: result }] } });
}

async function answer(uuid, prompt) {
  // "[fast]": respuesta completa sin esperas, para llenar el historial deprisa.
  fast = prompt.includes("[fast]");
  const wait = /\[wait (\d+)\]/.exec(prompt);
  if (wait) {
    await tool("Bash", { command: `sleep ${wait[1]}`, description: "Esperar" }, "");
    await sleep(Number(wait[1]) * 1000);
  } else {
    await tool("Read", { file_path: "/tmp/proyecto/src/chatState.ts" }, "export const initialChatState = () => ({ items: [] });\n".repeat(40));
    await tool("Bash", { command: "npm test", description: "Ejecutar los tests" }, "ok 1 - chat\nok 2 - markdown\n".repeat(30));
  }
  const messageId = `msg_fake_${++messageCounter}`;
  out({ type: "stream_event", session_id: sessionId, event: { type: "message_start", message: { id: messageId, usage: { input_tokens: 1500, output_tokens: 1 } } } });
  await streamText(wait ? "Listo." : BASE.repeat(REPEAT), messageId);
  out({ type: "result", subtype: "success", is_error: false, session_id: sessionId, uuid: randomUUID(), duration_ms: 1000,
    result: "ok", total_cost_usd: 0, user_message_uuids: uuid ? [uuid] : [], usage: { input_tokens: 1500, output_tokens: 900 } });
}

let queue = Promise.resolve();
let initialized = false;
const rl = createInterface({ input: process.stdin });
rl.on("line", line => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.type === "control_request") {
    // Trex comprueba en `initialize` el modo de permisos efectivo; sin él reinicia la sesión.
    const response = message.request?.subtype === "initialize"
      ? { commands: [], models: [], current_permission_mode: "default" }
      : message.request?.subtype === "set_permission_mode" ? { mode: message.request.mode } : {};
    out({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response } });
    if (!initialized) {
      initialized = true;
      out({ type: "system", subtype: "init", session_id: sessionId, model: "claude-fake", permissionMode: "default", tools: [], mcp_servers: [] });
    }
    return;
  }
  if (message.type === "user") {
    const content = message.message?.content;
    const prompt = typeof content === "string" ? content : Array.isArray(content) ? content.map(part => part.text ?? "").join(" ") : "";
    queue = queue.then(() => answer(message.uuid, prompt));
  }
});
rl.on("close", () => { void queue.then(() => process.exit(0)); });
