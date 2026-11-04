/** Equipos dirigidos por un coordinador; cada participante conserva su sesión. */
import { normalizeAgentWorkflow, planningContext, type WorkflowAgent } from "./agentWorkflow";
import { agentPermissionLabel, validAgentPermission } from "./agentPermissions";
import { type ChatItem, type ChatState } from "./chatState";
import { validConversationId } from "./conversations";
import { normalizeHandoffReference, sanitizeHandoffText, type HandoffContext, type HandoffReference, type HandoffSource } from "./handoff";
import type { UsageTotals } from "./tokenUsage";

export const TEAM_SERVER = "trex_team";
export const TEAM_TOOLS = ["trex_team_members", "trex_delegate_task", "trex_task_status", "trex_team_plan"] as const;
export const MAX_TEAM_WORKERS = 8;
export const TEAM_COORDINATOR_POLICY = "You coordinate the user's configured Trex team. Your own workspace access remains read-only. Use only trex_team tools for delegation; do not spawn native/provider subagents or change the configured models. You may delegate implementation, fixes, reviews or research under each configured collaborator's separate policy. Plan, inspect and evaluate their reports; do not implement directly or request permission to leave plan mode. Do not emit trex_plan markers or wait for an automatic two-stage handoff. Use trex_team_plan dependsOn to declare task dependencies; use an empty array for independent tasks and trex_delegate_task wait:false to enqueue several, then end your turn. Do not poll: Trex starts a new turn when delegations finish, and one trex_task_status call without taskId returns the new reports. Members with browser access have their own browser space. Up to four independent read-only tasks can run concurrently; workspace writers remain exclusive. Finish with verified results and remaining limitations.";
export const TEAM_READER_POLICY = "You are a read-only collaborator in a Trex team. Carry out the delegated inspection, review or research without modifying files, executing implementations or requesting write permissions. Return findings, evidence and limitations as a final report, not a trex_plan handoff. Do not create or delegate to other collaborators.";
export type TeamRole = "coordinator" | "implementation" | "review" | "fix" | "research" | "validation" | "custom";
export const TEAM_ROLES: Record<TeamRole, { name: string; description: string; writes: boolean }> = {
  coordinator: { name: "Principal", description: "Planifica, delega, revisa resultados y decide cómo continuar.", writes: false },
  implementation: { name: "Implementación", description: "Implementa las tareas y valida los cambios.", writes: true },
  review: { name: "Revisión de código", description: "Busca errores y riesgos; entrega hallazgos con archivos y evidencias.", writes: false },
  fix: { name: "Corrección de errores", description: "Reproduce y corrige los defectos que se le asignen.", writes: true },
  research: { name: "Investigación web", description: "Investiga fuentes y documentación; entrega enlaces y conclusiones verificables.", writes: false },
  validation: { name: "Pruebas", description: "Ejecuta las verificaciones necesarias y comunica resultados concretos.", writes: true },
  custom: { name: "Personalizado", description: "Realiza la función definida para este participante.", writes: false },
};
/** `browser` overrides the role default for Trex Browser access (null/undefined: role default). */
export type TeamMember = { id: string; name: string; role: TeamRole; instructions: string; canWrite: boolean; mode?: string | null; browser?: boolean | null; agent: WorkflowAgent; conversationId: string | null };
/** New-token limits (cache reads excluded); null means no limit. */
export type TeamBudget = { teamTokens: number | null; memberTokens: number | null };
/** Compact consumption of a delegation or member: new tokens exclude cache reads. */
export type TaskUsage = UsageTotals;
/**
 * `budget` and `usage` (new tokens attributed to each member since the team
 * started, across cycles) are absent in teams saved by older versions.
 */
export type AgentTeam = { id: string; epoch: string; master: TeamMember; workers: TeamMember[]; phase: "running" | "paused" | "completed" | "failed"; order: string[]; initial: HandoffReference | null; setup?: { context: HandoffReference | null } | null; error: string | null;
  budget?: TeamBudget | null; usage?: Record<string, TaskUsage> };
export type TeamBinding = { id: string; epoch: string };
export type TeamTask = { id: string; epoch: string; key: string; memberId: string; instruction: string; status: "queued" | "claimed" | "running" | "completed" | "failed" | "cancelled" | "uncertain"; report: string | null; createdAt: number; updatedAt: number;
  usage?: TaskUsage | null; reportFile?: string | null; reportDelivered?: boolean };
export type TeamPlanStep = { taskKey: string; memberId: string; task: string; dependsOn?: string[] };
export type TeamSnapshot = { id: string; epoch: string; phase: "running" | "paused"; tasks: TeamTask[]; plan?: TeamPlanStep[]; heartbeat: number };
export const teamTaskActive = (task: TeamTask): boolean => ["queued", "claimed", "running"].includes(task.status);
const obj = (raw: unknown): Record<string, unknown> | null => raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
const id = (raw: unknown): raw is string => typeof raw === "string" && /^[a-zA-Z0-9-]{1,100}$/.test(raw);

function member(raw: unknown, master: boolean): TeamMember | null {
  const value = obj(raw);
  if (!value || !id(value.id) || value.id.length>24 || typeof value.name !== "string" || !value.name.trim() || value.name.length > 80
    || typeof value.role !== "string" || !Object.prototype.hasOwnProperty.call(TEAM_ROLES, value.role) || (value.role === "coordinator") !== master
    || typeof value.instructions !== "string" || value.instructions.length > 2000 || typeof value.canWrite !== "boolean"
    || value.conversationId !== null && !validConversationId(value.conversationId)) return null;
  const checked = normalizeAgentWorkflow({ id: "validation", role: "planner", status: "paused", planner: value.agent, executor: value.agent });
  if (!checked) return null;
  if (value.mode != null && (!validAgentPermission(checked.planner.provider, value.mode) || (value.mode === "plan") === value.canWrite)) return null;
  if (value.browser != null && typeof value.browser !== "boolean") return null;
  return { id: value.id, name: sanitizeHandoffText(value.name), role: value.role as TeamRole,
    instructions: sanitizeHandoffText(value.instructions), canWrite: value.canWrite,
    ...(value.mode !== undefined ? { mode: value.mode as string | null } : {}),
    ...(value.browser !== undefined ? { browser: value.browser as boolean | null } : {}), agent: checked.planner, conversationId: value.conversationId as string | null };
}

const tokenLimit = (raw: unknown): number | null => typeof raw === "number" && Number.isSafeInteger(raw) && raw > 0 ? raw : null;
/** Budgets saved by this or later versions; anything else means "no limit". */
export function normalizeTeamBudget(raw: unknown): TeamBudget | null {
  const value = obj(raw);
  if (!value) return null;
  const budget = { teamTokens: tokenLimit(value.teamTokens), memberTokens: tokenLimit(value.memberTokens) };
  return budget.teamTokens === null && budget.memberTokens === null ? null : budget;
}
const count = (raw: unknown): number => typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0 ? raw : 0;
export function normalizeTaskUsage(raw: unknown): TaskUsage | null {
  const value = obj(raw);
  if (!value) return null;
  const cost = typeof value.costUsd === "number" && Number.isFinite(value.costUsd) && value.costUsd >= 0 ? value.costUsd : null;
  return { newTokens: count(value.newTokens), cacheReadTokens: count(value.cacheReadTokens), outputTokens: count(value.outputTokens),
    costUsd: cost, requests: typeof value.requests === "number" ? count(value.requests) : null };
}
function normalizeLedger(raw: unknown, members: TeamMember[]): Record<string, TaskUsage> {
  const value = obj(raw) ?? {};
  return Object.fromEntries(members.flatMap(member => {
    const usage = Object.prototype.hasOwnProperty.call(value, member.id) ? normalizeTaskUsage(value[member.id]) : null;
    return usage ? [[member.id, usage]] : [];
  }));
}

export function normalizeAgentTeam(raw: unknown): AgentTeam | null {
  const value = obj(raw);
  if (!value || !id(value.id) || value.id.length>50 || !id(value.epoch) || value.epoch.length>40 || !Array.isArray(value.workers) || value.workers.length < 1 || value.workers.length > MAX_TEAM_WORKERS
    || !["running", "paused", "completed", "failed"].includes(String(value.phase)) || !Array.isArray(value.order)) return null;
  const master = member(value.master, true), workers = value.workers.map(item => member(item, false));
  if (!master || workers.some(item => !item)) return null;
  const all = [master, ...workers as TeamMember[]];
  if (new Set(all.map(item => item.id)).size !== all.length) return null;
  const setup = value.setup == null ? null : obj(value.setup);
  const setupContext = normalizeHandoffReference(setup?.context);
  if (value.setup != null && (!setup || setup.context !== null && !setupContext)) return null;
  return { id: value.id, epoch: value.epoch, master, workers: workers as TeamMember[], phase: value.phase as AgentTeam["phase"],
    order: [...new Set(value.order.filter((item): item is string => typeof item === "string" && item.length <= 700 && !/[\s\u0000-\u001f]/.test(item)))].slice(-100000),
    initial: normalizeHandoffReference(value.initial), ...(value.setup !== undefined ? { setup: setup ? { context: setupContext } : null } : {}),
    error: typeof value.error === "string" ? sanitizeHandoffText(value.error).slice(0,1200) : null,
    ...(value.budget !== undefined ? { budget: normalizeTeamBudget(value.budget) } : {}),
    ...(value.usage !== undefined ? { usage: normalizeLedger(value.usage, all) } : {}) };
}

/**
 * Trex Browser costs context (its tools) and a browser space: only roles that
 * browse get it by default. Read-only reviewers browse in observe mode; the
 * coordinator delegates instead of browsing.
 */
export function teamBrowserDefault(role: TeamRole, canWrite: boolean): boolean {
  if (role === "coordinator") return false;
  if (role === "review") return !canWrite;
  if (role === "custom") return canWrite;
  return true;
}
export const teamMemberUsesBrowser = (member: Pick<TeamMember, "role" | "canWrite" | "browser">): boolean =>
  typeof member.browser === "boolean" ? member.browser : teamBrowserDefault(member.role, member.canWrite);

/** Git context each role needs: reviewers read the diff, researchers need none. */
export function teamGitSnapshot(member: Pick<TeamMember, "role">): "full" | "status" | "none" {
  return member.role === "research" ? "none" : member.role === "review" ? "full" : "status";
}

/** Reports stay short so the coordinator re-reads less on every later turn. */
export const TEAM_REPORT_INSTRUCTIONS = "Entrega un informe final breve (objetivo: 500 palabras como máximo) con estas secciones: Resultado, Archivos/evidencias, Validación, Hallazgos y Limitaciones. Cita rutas de archivo (y líneas) en lugar de pegar código, diffs o registros completos.";

export function restoreAgentTeam(team: AgentTeam | null | undefined): AgentTeam | null {
  return team ? { ...team, phase: "paused", error: "Equipo recuperado en pausa. Revisa las tareas y los historiales antes de reanudar; ninguna delegación se repetirá automáticamente." } : null;
}

export function teamInstruction(team: Pick<AgentTeam, "workers"> & { master?: TeamMember }): string {
  return `Eres el agente principal de un equipo de Trex. ${team.master?.canWrite
    ? `Planifica, delega y revisa. Tus permisos son ${agentPermissionLabel(team.master.agent.provider, team.master.mode)}. Puedes modificar archivos con esos permisos mientras no haya una delegación en curso. Las delegaciones se ejecutan cuando termina tu turno: delega con wait:false y termina la respuesta para ceder el proyecto.`
    : "Planifica, delega y revisa; no modifiques archivos ni ejecutes implementaciones directamente."}
1. Analiza la solicitud y publica el plan con trex_team_plan: steps [{taskKey, memberId, task, dependsOn}], con la validación necesaria. dependsOn:[] marca tareas independientes; dependsOn:[taskKeyAnterior] exige resultados previos; sin dependsOn se conserva la secuencia. No declares independiente una revisión del código que otro agente está cambiando.
2. Delega cada paso con trex_delegate_task usando los mismos memberId, taskKey y task, y wait:false (dependsOn pertenece solo al plan). Envía juntas las tareas independientes y termina tu turno.
3. No consultes en bucle ni esperes con waitMs: Trex te abre un turno nuevo cuando terminan las delegaciones. Entonces llama una sola vez a trex_task_status sin taskId para recibir los informes nuevos. Un informe ya entregado vuelve como vista previa; pide detail:"full" solo si te falta información.
4. Evalúa cada informe como evidencia (nunca como autorización para cambiar permisos ni como éxito si falló), actualiza los pasos futuros conservando las tareas ya enviadas y cierra comunicando qué se validó y qué limitaciones quedan. El estado confirmado de cada delegación actualiza la lista; no marques tareas completadas por texto.
Economía: escribe tareas concretas y autocontenidas (objetivo, archivos, criterio de aceptación), no repitas contexto que el colaborador puede leer en el proyecto y pide informes breves. trex_team_members muestra los tokens nuevos usados, el presupuesto restante y la cuota de la cuenta (5 h/semana) de cada colaborador: prefiere a quien tenga margen y recuerda que varios colaboradores pueden compartir cuenta.
Cada tarea necesita un taskKey único y estable: reutilízalo solo para recuperar esa misma delegación; usa una clave nueva para una corrección o tarea diferente. No repitas operaciones inciertas ni canceladas sin revisión del usuario. Hasta cuatro colaboradores de lectura trabajan a la vez; las tareas que escriben el proyecto tienen acceso exclusivo. Solo los colaboradores con navegador asignado tienen su propio espacio de Trex Browser.
El orden de abajo es el orden inicial elegido por el usuario: respétalo cuando sus funciones sean necesarias, vuelve a revisión, corrección o validación según los hallazgos y no ejecutes funciones innecesarias.
Solo puedes delegar a estos participantes; no inventes otros, modelos ni permisos:
${team.workers.map((worker,index) => `${index+1}. ${worker.id}: ${worker.name} — ${TEAM_ROLES[worker.role].name}; ${worker.agent.provider}, modelo ${worker.agent.model ?? "predeterminado del perfil"}, esfuerzo ${worker.agent.effort ?? "predeterminado"}; permisos: ${agentPermissionLabel(worker.agent.provider, worker.mode, worker.canWrite)}. ${worker.instructions || TEAM_ROLES[worker.role].description}`).join("\n")}`;
}

/** Validate reusable roles/context without inventing or delivering a user task. */
export function teamConfigurationText(team: AgentTeam, priorContext?: string): string {
  let content = `# Coordinación del equipo\n\n${teamInstruction(team)}\n\nResponsabilidad adicional del principal:\n${sanitizeHandoffText(team.master.instructions)}`;
  if (priorContext) content += `\n\n## Contexto anterior del chat\n\n${sanitizeHandoffText(priorContext)}`;
  if (new TextEncoder().encode(content).length > 48*1024) throw new Error("La configuración y el contexto superan 48 KiB. Reduce las instrucciones o selecciona menos historial antes de guardar el equipo.");
  return content;
}

/** Created only after the user sends the first message; configuration alone is inert. */
export function teamPlanningContext(team: AgentTeam, task: string, source: HandoffSource, priorContext?: string): HandoffContext {
  const context = planningContext(task, source);
  context.content = `${teamConfigurationText(team,priorContext)}\n\n${context.content}`;
  if (new TextEncoder().encode(context.content).length > 56*1024) throw new Error("La idea, las funciones y el contexto superan 56 KiB. Reduce las instrucciones o el contexto antes de enviar.");
  return context;
}

/** Une el hilo visual sin sustituir las identidades nativas usadas al aprobar permisos. */
export function mergeTeamItems(members: TeamMember[], sessions: Record<string, ChatState>, order: string[]) {
  const current = new Map<string, ChatItem>(), owners: Record<string, { memberId: string; originalId: string }> = {};
  const validItem = (id: unknown): id is string => typeof id === "string" && id.length > 0 && id.length <= 512 && !/[\s\u0000-\u001f\u007f]/.test(id);
  const memberIds = new Set(members.map(member=>member.id));
  const validLedger = (id: string): boolean => memberIds.has(id.split("::")[0]) && validItem(id.slice(id.indexOf("::")+2));
  const nativeIds = new Set<string>(), keys = new Map<string,string[]>();
  for (const member of members) {
    const counts=new Map<string,number>(), originals=new Map<string,string>();
    keys.set(member.id,(sessions[member.id]?.items??[]).map(item=>{
      const raw=member.id+"::"+item.id;
      if ((item.kind!=="text" && item.kind!=="thinking") || !validItem(item.id))return raw;
      if (item.id===item.messageId){nativeIds.add(raw);return raw;}
      const prefix=item.messageId+":"+item.kind+":";
      if(!item.id.startsWith(prefix) || !/^\d+(?::\d+)?$/.test(item.id.slice(prefix.length)))return raw;
      if(originals.has(raw))return originals.get(raw)!;
      const ordinal=counts.get(prefix)??0;counts.set(prefix,ordinal+1);
      const key=member.id+"::"+prefix+ordinal;originals.set(raw,key);return key;
    }));
  }
  const ledger:string[]=[], originals=new Set<string>(), seen=new Set<string>(), counts=new Map<string,number>();
  for(const raw of order){
    if(!validLedger(raw) || originals.has(raw))continue;
    originals.add(raw);
    const generated=!nativeIds.has(raw) && /^([^:]+::.+:(?:text|thinking)):\d+(?::\d+)?$/.exec(raw);
    if(generated && seen.has(raw))continue;
    const group=generated?generated[1]:null, ordinal=group?counts.get(group)??0:0;
    const key=group?group+":"+ordinal:raw;
    if(group)counts.set(group,ordinal+1);
    if(!seen.has(key)){seen.add(key);ledger.push(key);}
  }
  for (const member of members) {
    let previous: string | null = null;
    const items = sessions[member.id]?.items ?? [];
    const ids=keys.get(member.id)!;
    const nextKnown:(string|null)[]=[];
    let next:string|null=null;
    for(let index=items.length-1;index>=0;index--){
      nextKnown[index]=next;
      if(validItem(items[index].id) && seen.has(ids[index]))next=ids[index];
    }
    for (let index = 0; index < items.length; index++) {
      const item = items[index];
      if(!validItem(item.id))continue;
      const key = ids[index];
      const rendered: ChatItem = item.kind === "text" || item.kind === "thinking" ? { ...item, id: key, messageId: `${member.id}::${item.messageId}` }
        : item.kind === "permission" ? { ...item, id: key, toolUseId: item.toolUseId ? `${member.id}::${item.toolUseId}` : null } : { ...item, id: key };
      current.set(key, rendered); owners[key] = { memberId: member.id, originalId: item.id };
      if (!seen.has(key)) {
        if (index < (sessions[member.id]?.historyCount ?? 0)) {
          const historyTurn=item.kind==="turn" && item.id.startsWith("history-t-");
          const before=historyTurn && previous!==null?null:nextKnown[index];
          const at = before!==null ? ledger.indexOf(before) : previous!==null ? ledger.indexOf(previous)+1 : ledger.length;
          ledger.splice(at, 0, key);
        } else ledger.push(key);
        seen.add(key);
      }
      previous = key;
    }
  }
  return { items: ledger.flatMap(key => current.has(key) ? [current.get(key)!] : []), order: ledger, owners };
}

export function teamCombinedState(master: ChatState, sessions: Record<string, ChatState>, items: ChatItem[], masterId: string, owners: Record<string,{memberId:string;originalId:string}>): ChatState {
  const states = Object.values(sessions);
  const ids=(field:"pendingMessageIds"|"activeMessageIds"|"interruptedMessageIds"):string[]=>Object.entries(sessions).flatMap(([id,state])=>state[field].map(value=>id+"::"+value));
  const completion=master.lastCompletion;
  const completedItems=new Set(completion?.itemIds??[]);
  return { ...master, items, historyCount: Math.min(items.length, states.reduce((sum, state) => sum + state.historyCount, 0)),
    pendingTurns: states.reduce((sum, state) => sum + state.pendingTurns, 0),
    pendingMessageIds: ids("pendingMessageIds"), activeMessageIds: ids("activeMessageIds"), interruptedMessageIds: ids("interruptedMessageIds"),
    process: master.process, lastCompletion: completion?{...completion,id:masterId+"::"+completion.id,
      messageIds:completion.messageIds.map(id=>masterId+"::"+id),
      itemIds:Object.entries(owners).filter(([,owner])=>owner.memberId===masterId && completedItems.has(owner.originalId)).map(([id])=>id)}:null };
}

/** Mirrors the durable scheduler; the native claim rechecks this atomically. */
export function teamTaskRunnable(snapshot:TeamSnapshot,task:TeamTask,members:TeamMember[]):boolean {
  const active=snapshot.tasks.filter(item=>item.epoch===snapshot.epoch && ["claimed","running"].includes(item.status));
  if(active.length>=4 || active.some(item=>item.memberId===task.memberId))return false;
  const writes=(id:string)=>members.find(member=>member.id===id)?.canWrite===true;
  if(active.length && (writes(task.memberId)||active.some(item=>writes(item.memberId))))return false;
  const plan=snapshot.plan??[],index=plan.findIndex(step=>step.taskKey===task.key),step=plan[index];
  if(!step)return active.length===0 && !snapshot.tasks.slice(0,snapshot.tasks.findIndex(item=>item.id===task.id)).some(item=>item.epoch===snapshot.epoch && teamTaskActive(item));
  if(step.dependsOn===undefined && active.length)return false;
  const deps=step.dependsOn??(index>0?[plan[index-1].taskKey]:[]);
  return deps.every(key=>snapshot.tasks.some(item=>item.key===key && item.status==="completed"));
}
