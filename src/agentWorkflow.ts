/** Flujos de dos etapas: cada rol conserva su propia cuenta, modelo y lanzador. */
import { answersOf, normalizeEffortChoice, normalizeModelChoice, questionsOf, type ChatCompletion, type ChatItem, type ModelInfo } from "./chatState";
import { normalizeHandoffReference, sanitizeHandoffText, type HandoffContext, type HandoffReference, type HandoffSource } from "./handoff";
import { normalizeLaunch } from "./profiles";
import type { AgentProvider, SessionLaunch } from "./types";
import type { ChatTask } from "./chatTasks";

export type WorkflowAgent = { profileId: string; profileName: string; provider: AgentProvider; model: string | null; effort?: string | null; launch: SessionLaunch };

/** El predeterminado del perfil puede venir de sus argumentos; no se adivina a partir del catálogo. */
export function workflowEffortLevels(models: ModelInfo[], model: string | null): string[] {
  if (!model) return [];
  return [...new Set((models.find(item => item.value === model)?.efforts ?? []).filter(level => normalizeEffortChoice(level) === level))];
}
export type WorkflowStatus = "planning" | "waiting" | "transferring" | "executing" | "completed" | "paused" | "failed";
export type AgentWorkflow = {
  id: string;
  role: "planner" | "executor";
  status: WorkflowStatus;
  planner: WorkflowAgent;
  executor: WorkflowAgent;
  peerTabId?: string | null;
  plan?: HandoffReference | null;
  error?: string | null;
};

export const PLANNING_INSTRUCTION = "Tu única etapa es planificar. Investiga el proyecto sin modificar archivos ni implementar. Si necesitas aclaraciones, pregunta y espera. Antes de entregar el plan, usa tus herramientas de tareas disponibles para publicar una lista breve de pasos concretos para el ejecutor, incluidos cambios y validación; mantenlos pendientes porque todavía no se han implementado. Si no están disponibles, incluye esos pasos en el plan e indica la limitación; no afirmes que publicaste tareas. Cuando tengas el plan definitivo, tu respuesta final debe contener solamente TODO el plan dentro de <trex_plan> y </trex_plan>, incluyendo objetivo, archivos, pasos y validación. Esas etiquetas significan que el plan está listo para implementarse automáticamente; no las uses en borradores o preguntas. Otro agente ejecutará el plan; no cambies a modo de implementación ni solicites aprobar ExitPlanMode.";
export const IMPLEMENTATION_INSTRUCTION = "Implementa el plan definitivo transferido en este proyecto. Revisa el plan y las tareas transferidas; son de otra sesión y sus identificadores o estados no se comparten automáticamente. Antes de implementar, publica en tus herramientas de tareas disponibles una lista propia basada en ellas o, si faltan, en los pasos del plan. Comprueba primero los archivos y cambios actuales, respeta las instrucciones del usuario y del proyecto, marca cada tarea en curso al iniciarla y completada solo tras verificarla, manteniendo pendientes las demás. Actualiza la lista conforme avance el trabajo. Si no dispones de herramientas de tareas, indica la limitación y no afirmes haberlas publicado. Al finalizar explica lo implementado y los resultados de la validación. Si hay un bloqueo que cambia el alcance del plan, pregunta antes de improvisar.";

const object = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const id = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(value);
function agent(raw: unknown): WorkflowAgent | null {
  const value = object(raw);
  if (!value || typeof value.profileId !== "string" || !value.profileId.trim() || value.profileId.length > 200
    || typeof value.profileName !== "string" || !value.profileName.trim() || value.profileName.length > 200
    || (value.provider !== "claude" && value.provider !== "codex" && value.provider !== "trex")) return null;
  const launch = normalizeLaunch(value.launch, value.provider);
  if (!launch || launch.profileId !== value.profileId) return null;
  const model = normalizeModelChoice(value.model);
  if (value.model != null && !model) return null;
  const effort = normalizeEffortChoice(value.effort);
  if (value.effort != null && !effort) return null;
  return { profileId: value.profileId, profileName: value.profileName, provider: value.provider, model,
    ...(value.effort !== undefined ? { effort } : {}), launch };
}

/** Solo metadatos y referencias locales; los planes se guardan fuera de config.json. */
export function normalizeAgentWorkflow(raw: unknown): AgentWorkflow | null {
  const value = object(raw);
  if (!value || !id(value.id) || (value.role !== "planner" && value.role !== "executor")
    || typeof value.status !== "string" || !["planning", "waiting", "transferring", "executing", "completed", "paused", "failed"].includes(value.status)) return null;
  const planner = agent(value.planner), executor = agent(value.executor);
  if (!planner || !executor) return null;
  return { id: value.id, role: value.role, status: value.status as WorkflowStatus, planner, executor,
    peerTabId: id(value.peerTabId) ? value.peerTabId : null,
    plan: normalizeHandoffReference(value.plan),
    error: typeof value.error === "string" ? [...sanitizeHandoffText(value.error)].slice(0, 1200).join("") : null };
}

/** Un reinicio nunca vuelve a iniciar una implementación que quizá ya se envió. */
export function restoreAgentWorkflow(value: AgentWorkflow | null | undefined): AgentWorkflow | null {
  if (!value) return null;
  return value.status === "completed" || value.status === "failed" ? value : { ...value, status: "paused",
    error: "Flujo pausado al recuperar la sesión. Revisa las conversaciones antes de reanudar." };
}

/** Solo acepta planes definitivos del turno más reciente, nunca pensamientos o borradores. */
export function extractWorkflowPlan(items: ChatItem[]): string | null {
  let start = 0;
  for (let at = items.length - 1; at >= 0; at--) {
    const item = items[at];
    if (item.kind === "user" || item.kind === "tool" && item.name === "AskUserQuestion" && item.status === "done") { start = at + 1; break; }
  }
  const recent = items.slice(start);
  for (const item of [...recent].reverse()) {
    if (item.kind === "tool" && item.name === "ExitPlanMode" && item.status === "done" && typeof item.input.plan === "string" && item.input.plan.trim())
      return sanitizeHandoffText(item.input.plan) || null;
    if (item.kind !== "text" || !item.final) continue;
    const match = /^\s*<trex_plan>\s*([\s\S]+?)\s*<\/trex_plan>\s*$/.exec(item.text);
    if (match && !/<\/?trex_plan>/.test(match[1])) return sanitizeHandoffText(match[1]) || null;
    // Una pregunta o revisión posterior invalida la candidatura anterior del mismo turno.
    if (item.text.trim()) return null;
  }
  return null;
}

/** Conserva los límites de instrucciones aunque el resultado solo atribuya elementos del asistente. */
export function completedWorkflowPlan(items: ChatItem[], completion: ChatCompletion): string | null {
  if (completion.status !== "completed") return null;
  const ids = new Set(completion.itemIds);
  return extractWorkflowPlan(items.filter(item => item.kind === "user" || ids.has(item.id)));
}

/** Las respuestas estructuradas son instrucciones del usuario; las respuestas secretas se omiten. */
export function workflowClarifications(items: ChatItem[]): string {
  return items.flatMap(item => {
    if (item.kind === "user") return item.text.includes("<!-- trex-handoff:") ? [] : [sanitizeHandoffText(item.text)];
    if (item.kind !== "tool" || item.name !== "AskUserQuestion" || item.status !== "done") return [];
    const questions = questionsOf(item.input);
    const answers = answersOf(item.input);
    const result = Object.entries(answers).flatMap(([question, answer]) => {
      const match = questions.find(entry => entry.question === question || entry.id === question);
      if (match?.secret || /^[•*]+$/.test(answer.trim())) return [];
      return [sanitizeHandoffText(`${match?.question ?? question}\nRespuesta del usuario: ${answer}`)];
    });
    if (!Object.keys(answers).length && typeof item.input.response === "string" && !questions.some(question => question.secret))
      result.push(sanitizeHandoffText(`Respuesta del usuario: ${item.input.response}`));
    return result;
  }).filter(Boolean).join("\n\n");
}

export function planningContext(task: string, source: HandoffSource): HandoffContext {
  const text = sanitizeHandoffText(task);
  if (!text || new TextEncoder().encode(text).length > 24 * 1024) throw new Error("La tarea debe ocupar entre 1 y 24 KiB.");
  return { source, content: `# Solicitud del usuario\n\n${text}`, createdAt: Date.now(), messageCount: 1, truncated: false, imagesOmitted: 0 };
}

/** El plan pasa completo: si no cabe, se pide reducirlo en vez de implementar un extracto. */
export function workflowPlanContext(plan: string, original: string, source: HandoffSource, tasks: ChatTask[] = []): HandoffContext {
  const text = sanitizeHandoffText(plan), request = sanitizeHandoffText(original.split("\n\n---\n## Estado del proyecto capturado por TREX\n")[0]);
  const list = tasks.map(task => `- [${task.status}] ${sanitizeHandoffText(task.title)}`).join("\n");
  const transferred = list ? `\n\n## Tareas publicadas por el planificador\n\n${list}\n\nSon registros de la sesión de planificación; verifica el trabajo antes de darlo por completado y publica tu propia lista.` : "";
  const content = `# Plan definitivo para implementar\n\n${text}${transferred}\n\n## Solicitud original y estado del proyecto\n\n${request}`;
  if (!text || new TextEncoder().encode(content).length > 64 * 1024)
    throw new Error("El plan y su contexto superan 64 KiB. Pide al planificador una versión más breve antes de implementar.");
  return { source, content, createdAt: Date.now(), messageCount: 2, truncated: false, imagesOmitted: 0 };
}
