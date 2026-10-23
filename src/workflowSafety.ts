/** Restricciones de las pestañas que entregan un plan a otro agente. Sin React ni llamadas al CLI. */
import type { Json } from "./chatState";

export const WORKFLOW_PLAN_INSTRUCTIONS = "This is the planning tab of an automated workflow. Only research and produce a plan; do not implement it. "
  + "The completed plan will be handed automatically to a separate executor. Return the complete final plan inside <trex_plan> and </trex_plan> in your final response; "
  + "use these markers only when the plan is ready for automatic execution, never for drafts or questions. Do not wait for approval to implement it.";

export function assertClaudePlanningMode(mode: unknown): void {
  if (mode !== "plan") throw new Error("Claude no confirmó el modo plan. No se enviarán mensajes desde esta pestaña de planificación.");
}

type Argument = { start: number; end: number; value: string };

/** Igual que split_args del backend, conservando los rangos originales para no volver a citar argumentos. */
function argumentsOf(input: string, windows: boolean): Argument[] {
  const result: Argument[] = [];
  for (let index = 0; index < input.length;) {
    if (/\s/.test(input[index])) { index++; continue; }
    const start = index;
    let value = "";
    while (index < input.length && !/\s/.test(input[index])) {
      const char = input[index++];
      if (char === "'" || char === '"') {
        let closed = false;
        while (index < input.length) {
          const inner = input[index++];
          if (inner === char) { closed = true; break; }
          if (char === '"' && inner === "\\" && !windows && (input[index] === '"' || input[index] === "\\")) value += input[index++];
          else value += inner;
        }
        if (!closed) throw new Error("Hay una comilla sin cerrar en los argumentos del perfil de planificación.");
      } else if (char === "\\" && !windows) {
        if (index < input.length) value += input[index++];
      } else value += char;
    }
    result.push({ start, end: index, value });
  }
  return result;
}

const CLAUDE_PERMISSION_FLAGS = new Set(["--permission-mode", "--dangerously-skip-permissions", "--allow-dangerously-skip-permissions"]);
const CLAUDE_CONVERSATION_VALUES = new Set(["--resume", "-r", "--session-id", "--resume-session-at", "--resume-drops-turn"]);
const CLAUDE_CONVERSATION_FLAGS = new Set(["--continue", "-c", "--fork-session"]);
// Un texto del sistema o un valor de otra opción puede contener literalmente el nombre de un permiso.
const CLAUDE_VALUE_FLAGS = new Set([
  "--append-system-prompt", "--append-system-prompt-file", "--system-prompt", "--system-prompt-file",
  "--model", "--effort", "--agent", "--agents", "--settings", "--setting-sources", "--json-schema",
  "--permission-prompt-tool", "--input-format", "--output-format", "--resume", "-r", "--session-id",
  "--resume-session-at", "--resume-drops-turn", "--max-turns", "--max-budget-usd", "--fallback-model",
]);

/** Quita todos los modos/permisos del perfil, manteniendo los demás argumentos y sus comillas originales. */
export function claudePlanningArgs(profileArgs: string | null, windows: boolean, newConversation = false): string | null {
  if (profileArgs === null) return null;
  const tokens = argumentsOf(profileArgs, windows);
  const removed: Argument[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    const equals = token.value.indexOf("=");
    const name = equals < 0 ? token.value : token.value.slice(0, equals);
    if (name === "--") throw new Error("El perfil de planificación no admite argumentos después de --.");
    if (CLAUDE_PERMISSION_FLAGS.has(name) || (newConversation && (CLAUDE_CONVERSATION_VALUES.has(name) || CLAUDE_CONVERSATION_FLAGS.has(name)))) {
      removed.push(token);
      if ((name === "--permission-mode" || CLAUDE_CONVERSATION_VALUES.has(name)) && equals < 0) {
        const value = tokens[++index];
        if (!value || value.value.startsWith("--")) throw new Error(`Falta el valor de ${name} en el perfil de planificación.`);
        removed.push(value);
      }
    } else if (equals < 0 && CLAUDE_VALUE_FLAGS.has(name) && index + 1 < tokens.length) index++;
  }
  let result = "", previous = 0;
  for (const token of removed) {
    result += profileArgs.slice(previous, token.start);
    previous = token.end;
  }
  result += profileArgs.slice(previous);
  return result.trim() || null;
}

/** También elimina el permiso de bypass que claudeChatFlags añade para las pestañas normales. */
export function claudePlanningFlags(flags: string[]): string[] {
  const result: string[] = [];
  for (let index = 0; index < flags.length; index++) {
    const name = flags[index].split("=", 1)[0];
    if (CLAUDE_PERMISSION_FLAGS.has(name)) {
      if (name === "--permission-mode" && !flags[index].includes("=")) index++;
    } else {
      result.push(flags[index]);
      if (CLAUDE_VALUE_FLAGS.has(name) && !flags[index].includes("=") && index + 1 < flags.length) result.push(flags[++index]);
    }
  }
  return [...result, "--permission-mode", "plan"];
}

/** Denegar ExitPlanMode mantiene el proceso en plan; el texto evita esperar una aprobación humana. */
export const claudePlanningExitResponse = (requestId: string): string => JSON.stringify({
  type: "control_response",
  response: { subtype: "success", request_id: requestId, response: { behavior: "deny", message: WORKFLOW_PLAN_INSTRUCTIONS } },
});

/** Se aplica al final de thread/start, resume y fork, por encima de las opciones del perfil. */
export function codexPlanningThread(overrides: Json): Json {
  const config = typeof overrides.config === "object" && overrides.config !== null && !Array.isArray(overrides.config) ? overrides.config : {};
  const instructions = typeof overrides.developerInstructions === "string" ? overrides.developerInstructions : "";
  return { ...overrides, sandbox: "read-only", approvalPolicy: "on-request",
    config: { ...config, sandbox_mode: "read-only", approval_policy: "on-request", include_collaboration_mode_instructions: true },
    developerInstructions: instructions.includes(WORKFLOW_PLAN_INSTRUCTIONS) ? instructions
      : [instructions, WORKFLOW_PLAN_INSTRUCTIONS].filter(Boolean).join("\n\n") };
}

/** Una reanudación ya activa puede ignorar overrides: no se le envía trabajo si no los confirmó. */
export function assertCodexPlanningThread(response: Json): void {
  const sandbox = response.sandboxPolicy ?? response.sandbox;
  const type = typeof sandbox === "string" ? sandbox
    : typeof sandbox === "object" && sandbox !== null && "type" in sandbox ? sandbox.type : null;
  if ((type !== "readOnly" && type !== "read-only") || response.approvalPolicy !== "on-request") {
    throw new Error("Codex no confirmó sandbox de solo lectura y aprobación on-request para el planificador.");
  }
}

/** Planificar exige tanto el sandbox de solo lectura como el modo real de colaboración y su modelo. */
export function codexPlanningTurn(overrides: Json, model: string | null, effort: string | null): Json {
  if (!model || !model.trim() || model.trim().length > 256 || /[\s\u0000-\u001f\u007f]/.test(model.trim())) {
    throw new Error("No se conoce el modelo de Codex para planificar. Selecciona un modelo antes de enviar el mensaje.");
  }
  return { ...overrides, model: model.trim(), approvalPolicy: "on-request", sandboxPolicy: { type: "readOnly", networkAccess: false },
    collaborationMode: { mode: "plan", settings: { model: model.trim(), reasoning_effort: effort, developer_instructions: null } } };
}
