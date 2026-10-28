import { useEffect, useRef } from "react";
import { formatError } from "../api";
import { completedWorkflowPlan, workflowClarifications, PLANNING_INSTRUCTION, workflowPlanContext, type AgentWorkflow } from "../agentWorkflow";
import type { HandoffContext, HandoffSource, PreparedHandoff } from "../handoff";
import type { ChatSession } from "./chatSession";
import { useStableCallback } from "./useStableCallback";
import { chatTasks } from "../chatTasks";

/** Consume únicamente resultados de envíos vivos. Recuperar historial no pone en marcha el ejecutor. */
export function useAgentWorkflow({ workflow, session, source, original, handoffPending, busy, onPlan, onStatus }: {
  workflow?: AgentWorkflow | null;
  session: ChatSession;
  source: HandoffSource;
  original: PreparedHandoff | null;
  handoffPending: boolean;
  busy: boolean;
  onPlan?: (tabId: string, runId: string, context?: HandoffContext) => void;
  onStatus?: (tabId: string, runId: string, status: AgentWorkflow["status"], error?: string | null) => void;
}) {
  const consumed = useRef<string | null>(null);
  const resuming = useRef(false);
  const previouslyActive = useRef(false);
  const superseded = useRef<{ run: string | undefined; messages: Set<string> }>({ run: workflow?.id, messages: new Set() });
  if (superseded.current.run !== workflow?.id) superseded.current = { run: workflow?.id, messages: new Set() };
  const active = workflow?.status === "planning" || workflow?.status === "waiting" || workflow?.status === "executing";
  const readyContext = (): HandoffContext | null => {
    const completion = session.state.lastCompletion;
    if (!completion || !original) return null;
    const plan = completedWorkflowPlan(session.state.items, completion);
    if (!plan) return null;
    const request = original.content.split("\n\n---\n## Estado del proyecto capturado por TREX\n")[0];
    const ids = new Set(completion.itemIds);
    const tasks = chatTasks(session.state.items.filter(item => ids.has(item.id)), source.profileName);
    return workflowPlanContext(plan, `${request}\n\n## Aclaraciones del usuario\n${workflowClarifications(session.state.items) || "Sin aclaraciones adicionales."}`, source, tasks);
  };

  useEffect(() => {
    // Pausar desde cualquiera de las dos pestañas también interrumpe la otra si está trabajando.
    if (workflow?.status === "paused" && previouslyActive.current && session.state.pendingTurns > 0) session.interrupt();
    previouslyActive.current = active;
  }, [workflow?.status, active, session.state.pendingTurns]);

  useEffect(() => {
    const completion = session.state.lastCompletion;
    if (!workflow || !completion || consumed.current === completion.id) return;
    // Trex may interrupt its previous turn to deliver an explicit correction.
    // That terminal must not pause the replacement or authorize the old plan.
    if (completion.messageIds.length && completion.messageIds.every(id => superseded.current.messages.has(id))) {
      consumed.current = completion.id;
      return;
    }
    if (!active || (workflow.role === "planner" && workflow.status === "executing")) { consumed.current = completion.id; return; }
    if (completion.status !== "completed") {
      consumed.current = completion.id;
      onStatus?.(source.sessionId, workflow.id, completion.status === "interrupted" ? "paused" : "failed",
        completion.status === "interrupted" ? "Flujo detenido. Puedes revisar la conversación y reanudarlo."
          : "El agente no terminó correctamente. Revisa el error antes de reanudar.");
      return;
    }
    if (handoffPending || busy || session.state.pendingTurns > 0) return;
    consumed.current = completion.id;
    if (workflow.role === "executor") { onStatus?.(source.sessionId, workflow.id, "completed"); return; }
    const plan = completedWorkflowPlan(session.state.items, completion);
    if (!plan) {
      onStatus?.(source.sessionId, workflow.id, "waiting", "El planificador todavía no entregó un plan definitivo. Responde en esta conversación o pídele que termine el plan.");
      return;
    }
    try {
      if (!original) throw new Error("No está disponible la solicitud original. Recupera el contexto antes de continuar.");
      const context = readyContext();
      if (context) onPlan?.(source.sessionId, workflow.id, context);
    } catch (error) { onStatus?.(source.sessionId, workflow.id, "waiting", formatError(error)); }
  }, [workflow, active, session.state.lastCompletion, session.state.items, session.state.pendingTurns, handoffPending, busy, original, source, onPlan, onStatus]);

  const stop = useStableCallback((): void => {
    if (workflow) onStatus?.(source.sessionId, workflow.id, "paused", "Flujo detenido por ti.");
    session.interrupt();
  });
  const supersedeActiveTurn = useStableCallback((messageId: string): void => {
    superseded.current.messages.add(messageId);
  });
  const resume = useStableCallback(async (): Promise<void> => {
    if (!workflow || resuming.current || session.state.pendingTurns > 0 || busy || handoffPending) return;
    if (workflow.role === "planner" && workflow.plan && !workflow.peerTabId) { onPlan?.(source.sessionId, workflow.id); return; }
    consumed.current = session.state.lastCompletion?.id ?? null;
    onStatus?.(source.sessionId, workflow.id, workflow.role === "planner" ? "planning" : "executing");
    resuming.current = true;
    try {
      if (workflow.role === "planner" && !workflow.peerTabId) {
        const context = readyContext();
        if (context) { onPlan?.(source.sessionId, workflow.id, context); return; }
      }
      const accepted = await session.send(workflow.role === "planner"
        ? `Retoma la planificación de la tarea original. ${PLANNING_INSTRUCTION}`
        : "Retoma la implementación del plan transferido. Comprueba qué pasos y cambios ya están hechos para continuar desde el estado actual sin repetirlos.", [], []);
      if (accepted === false) throw new Error("El agente no recibió la continuación.");
    } catch (error) { onStatus?.(source.sessionId, workflow.id, "failed", formatError(error)); }
    finally { resuming.current = false; }
  });
  return { stop, resume, supersedeActiveTurn };
}
