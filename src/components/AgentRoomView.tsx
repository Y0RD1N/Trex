import { browserOptions } from "../browser";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { formatError, loadHandoff, prepareHandoff } from "../api";
import { mergeRoomItems, roomConversationContext, roomQueueAddress, roomQueueSnapshot, routeRoomMessage, type AgentRoom, type RoomRole } from "../agentRoom";
import { completedWorkflowPlan, IMPLEMENTATION_INSTRUCTION, PLANNING_INSTRUCTION, workflowClarifications, workflowPlanContext } from "../agentWorkflow";
import { chatActivity, conversationTitle, effortLabel, initialChatState, supportedEfforts, type ChatState, type OutgoingImage } from "../chatState";
import { buildHandoffPrompt, handoffAlreadySent, sanitizeHandoffText, type HandoffSource, type PreparedHandoff } from "../handoff";
import { type ChatSession, type ChatSessionOptions } from "../hooks/chatSession";
import { useClaudeChat } from "../hooks/useClaudeChat";
import { useCodexChat } from "../hooks/useCodexChat";
import { useTrexChat } from "../hooks/useTrexChat";
import { INBOX_WAKE, messageQueueId, type QueuedMessage } from "../messageQueue";
import { localCommand } from "../chatCommands";
import { ChatPanel, type ChatViewProps } from "./ChatView";
import AgentIcon from "./AgentIcon";
import { MapIcon, StopIcon } from "./Icons";
import Select from "./Select";
import "./AgentRoomView.css";

export type AgentRoomViewProps = Omit<ChatViewProps, "workflow" | "planningOnly" | "handoff" | "handoffRestored"> & {
  room: AgentRoom;
  onRoomChange: (room: AgentRoom) => void;
};

const ROLES: RoomRole[] = ["planner", "executor"];
const ROLE_NAMES = { planner: "Planificador", executor: "Ejecutor" };
const PHASE_NAMES: Record<AgentRoom["phase"], string> = {
  idle: "Listo", planning: "Planificando", waiting: "Espera tu respuesta", transferring: "Preparando contexto",
  executing: "Ejecutando", completed: "Completado", paused: "Pausado", failed: "Revisar error",
};
type Sessions = Partial<Record<RoomRole, ChatSession>>;
type SendKind = "plan" | "execute" | "message";
type Issued = { cycle: number; kind: SendKind; previous: string | null; users: Set<string>; accepted: boolean };
type RuntimeProps = { role: RoomRole; options: ChatSessionOptions; publish: (role: RoomRole, session: ChatSession) => void };

function ReportSession({ role, session, publish }: Omit<RuntimeProps, "options"> & { session: ChatSession }) {
  useLayoutEffect(() => { publish(role, session); });
  return null;
}
function ClaudeRuntime({ role, options, publish }: RuntimeProps) {
  return <ReportSession role={role} session={useClaudeChat(options)} publish={publish} />;
}
function CodexRuntime({ role, options, publish }: RuntimeProps) {
  return <ReportSession role={role} session={useCodexChat(options)} publish={publish} />;
}
function TrexRuntime({ role, options, publish }: RuntimeProps) {
  return <ReportSession role={role} session={useTrexChat(options)} publish={publish} />;
}

const queued = (session?: ChatSession): boolean => !!session && (session.queue.snapshot.messages.length > 0 || !!session.queue.snapshot.receipt || !!session.queue.snapshot.outbox?.length);
const noop = (): void => undefined;

/** Two independent provider sessions, one composer and a durable serial handoff. */
export default function AgentRoomView(props: AgentRoomViewProps) {
  const { room } = props;
  const browser = useRef(browserOptions(props.settings, room.id)).current;
  const latest = useRef(props);
  latest.current = props;
  const roomRef = useRef(room);
  roomRef.current = room;
  const sessionsRef = useRef<Sessions>({});
  const [sessions, setSessions] = useState<Sessions>({});
  const [working, setWorking] = useState(false);
  const [planIntent, setPlanIntent] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [revision, setRevision] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const mounted = useRef(true);
  const generation = useRef(0);
  const operation = useRef<number | null>(null);
  const attempted = useRef(new Set<string>());
  const consumed = useRef(new Set<string>());
  const issued = useRef<Partial<Record<RoomRole, Issued>>>({});
  const queueWrites = useRef(0);
  const pendingKinds = useRef(new Map<string, SendKind>());
  const attachments = useRef(new Map<string, { images: OutgoingImage[]; previews: string[]; display: string }>());
  const original = useRef<{ cycle: number; prepared: PreparedHandoff; start: number } | null>(null);

  const change = useCallback((update: (current: AgentRoom) => AgentRoom): void => {
    if (!mounted.current) return;
    const current = roomRef.current, next = update(current);
    if (next === current) return;
    roomRef.current = next;
    latest.current.onRoomChange(next);
  }, []);

  const publish = useCallback((role: RoomRole, session: ChatSession): void => {
    const previous = sessionsRef.current[role];
    sessionsRef.current = { ...sessionsRef.current, [role]: session };
    if (!previous || previous.state !== session.state || previous.terminals !== session.terminals || previous.queue.snapshot !== session.queue.snapshot
      || previous.queue.ready !== session.queue.ready || previous.queue.error !== session.queue.error) {
      setSessions(current => ({ ...current, [role]: session }));
    }
    change(current => {
      const participant = current[role], state = session.state;
      const conversationId = state.sessionId && state.items.some(item => item.kind === "user") ? state.sessionId : participant.conversationId;
      const mode = role === "planner" ? "plan" : state.modeChoice ?? participant.mode;
      if (conversationId === participant.conversationId && mode === participant.mode
        && state.modelChoice === participant.agent.model && state.effortChoice === (participant.agent.effort ?? null)) return current;
      return { ...current, [role]: { ...participant, conversationId, mode,
        agent: { ...participant.agent, model: state.modelChoice, effort: state.effortChoice } } };
    });
  }, [change]);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; generation.current++; operation.current = null; };
  }, []);

  const states = useMemo(() => Object.fromEntries(ROLES.flatMap(role => sessions[role] ? [[role, sessions[role]!.state]] : [])) as Partial<Record<RoomRole, ChatState>>, [sessions]);
  const merged = useMemo(() => mergeRoomItems(states, room.order), [states, room.order]);
  useEffect(() => {
    change(current => current.order.length === merged.order.length && current.order.every((id, index) => id === merged.order[index])
      ? current : { ...current, order: merged.order });
  }, [merged.order, change]);

  const source = (role: RoomRole): HandoffSource => {
    const current = roomRef.current, participant = current[role];
    return { sessionId: `${current.id}-${role}`, provider: participant.agent.provider, profileId: participant.agent.profileId,
      profileName: participant.agent.profileName, title: latest.current.sessionTitle ?? "Sala de agentes",
      projectId: latest.current.projectId ?? "", projectName: latest.current.projectName, cwd: latest.current.cwd };
  };
  const allReady = (): boolean => ROLES.every(role => sessionsRef.current[role]?.queue.ready && sessionsRef.current[role]?.state.process === "ready");
  const anyBusy = (): boolean => ROLES.some(role => (sessionsRef.current[role]?.state.pendingTurns ?? 0) > 0);
  const anyQueued = (): boolean => queueWrites.current > 0 || ROLES.some(role => queued(sessionsRef.current[role]));
  const snapshot = () => mergeRoomItems(Object.fromEntries(ROLES.flatMap(role => sessionsRef.current[role] ? [[role, sessionsRef.current[role]!.state]] : [])), roomRef.current.order);
  const focusComposer = (): void => { requestAnimationFrame(() => root.current?.querySelector<HTMLTextAreaElement>("textarea")?.focus()); };
  const block = (message: string): "blocked" => { latest.current.onMessage(message); return "blocked"; };
  const currentOperation = (token: number, cycle: number): boolean => mounted.current && generation.current === token
    && roomRef.current.cycle === cycle && !["paused", "failed", "completed"].includes(roomRef.current.phase);

  const stop = (): void => {
    generation.current++;
    operation.current = null;
    issued.current = {};
    setWorking(false);
    setReviewing(false);
    change(current => ({ ...current, phase: "paused", error: "Sala detenida. Revisa el historial antes de reanudar." }));
    for (const role of ROLES) sessionsRef.current[role]?.interrupt();
  };

  // An external pause also invalidates work between the local file write and send.
  useEffect(() => {
    if (room.phase !== "paused" && room.phase !== "failed") return;
    generation.current++;
    operation.current = null;
    issued.current = {};
    setWorking(false);
    for (const role of ROLES) if ((sessionsRef.current[role]?.state.pendingTurns ?? 0) > 0) sessionsRef.current[role]?.interrupt();
  }, [room.phase]);

  const prepareMessage = async (role: RoomRole, text: string, kind: SendKind, newCycle: boolean,
    images: OutgoingImage[] = [], previews: string[] = [], resume = false): Promise<boolean> => {
    if (operation.current !== null || anyBusy() || anyQueued() || !allReady()) return false;
    const before = roomRef.current, cycle = before.cycle + (newCycle ? 1 : 0), token = ++generation.current;
    operation.current = token;
    setWorking(true);
    setReviewing(false);
    change(current => ({ ...current, active: role, cycle, phase: "transferring", ...(newCycle ? { plan: null } : {}), error: null }));
    try {
      const context = roomConversationContext(snapshot().items, source(before.active));
      const recovered = resume && before.pending ? await loadHandoff(before.pending.reference.id) : null;
      const inherited = before.setupContext ? await loadHandoff(before.setupContext.id) : null;
      if (!currentOperation(token, cycle)) return false;
      const task = sanitizeHandoffText(text).trim();
      context.content = `# Solicitud actual del usuario\n\n${task}\n\n${recovered ? `## Contexto de la entrega pendiente que se revisa\n\n${recovered.content}\n\n` : ""}${inherited ? `## Contexto anterior del chat\n\n${inherited.content}` : context.content}`;
      const prepared = await prepareHandoff(context);
      if (!currentOperation(token, cycle)) return false;
      if (role === "planner" && (newCycle || resume || original.current?.cycle !== cycle)) {
        original.current = { cycle, prepared, start: sessionsRef.current.planner?.state.items.length ?? 0 };
      }
      const instruction = `Atiende la solicitud actual del usuario indicada al principio del contexto transferido. ${kind === "plan" ? PLANNING_INSTRUCTION
        : kind === "execute" ? IMPLEMENTATION_INSTRUCTION : role === "planner" ? "Responde sin modificar archivos ni implementar." : "Comprueba el estado actual del proyecto antes de actuar."}`;
      const reference = { id: prepared.id, sourceLabel: prepared.sourceLabel, pending: true, instruction };
      pendingKinds.current.set(prepared.id, kind);
      attachments.current.set(prepared.id, { images, previews, display: task });
      if (!snapshot().items.some(item => item.kind === "user")) latest.current.onTitle(latest.current.sessionId, conversationTitle(task));
      change(current => ({ ...current, active: role, phase: role === "planner" ? "planning" : "executing",
        pending: { id: prepared.id, role, reference }, ...(before.setupContext?{setupContext:null}:{}), error: null }));
      setPlanIntent(false);
      return true;
    } catch (error) {
      if (currentOperation(token, cycle)) change(current => ({ ...current, phase: "failed", error: formatError(error) }));
      return false;
    } finally {
      if (operation.current === token) { operation.current = null; if (mounted.current) setWorking(false); }
    }
  };

  // Pending references are committed to App before this effect can issue a turn.
  useEffect(() => {
    const pending = room.pending;
    if (!pending || !["planning", "executing"].includes(room.phase) || operation.current !== null
      || attempted.current.has(pending.id) || !allReady() || anyBusy() || anyQueued()) return;
    const token = ++generation.current, cycle = room.cycle, role = pending.role;
    operation.current = token;
    attempted.current.add(pending.id);
    setWorking(true);
    void (async () => {
      try {
        const prepared = await loadHandoff(pending.reference.id);
        if (!currentOperation(token, cycle) || roomRef.current.pending?.id !== pending.id) return;
        const session = sessionsRef.current[role]!;
        if (!allReady() || anyBusy() || anyQueued()) throw new Error("La sala cambió mientras se preparaba la entrega. Revisa y reanuda.");
        if (handoffAlreadySent(session.state.items, pending.reference.id)) {
          change(current => ({ ...current, phase: "paused", pending: null,
            error: "La entrega ya aparece en el historial. Revisa el resultado antes de continuar." }));
          return;
        }
        const kind = pendingKinds.current.get(pending.reference.id) ?? (role === "planner" ? "plan" : "execute");
        if (role === "planner" && original.current?.cycle !== cycle) original.current = { cycle, prepared, start: session.state.items.length };
        const attempt: Issued = { cycle, kind, previous: session.state.lastCompletion?.id ?? null,
          users: new Set([...session.state.pendingMessageIds, ...session.state.items.filter(item => item.kind === "user").map(item => item.id)]), accepted: false };
        issued.current[role] = attempt;
        const outgoing = attachments.current.get(pending.reference.id);
        const initialTask = /^# Solicitud (?:actual del usuario|del usuario)\s*\n+([\s\S]*?)(?=\n\n(?:---\n|##)|$)/.exec(prepared.content)?.[1]?.trim();
        const display = outgoing?.display ?? (kind === "execute" ? `Implementa el plan definitivo de ${roomRef.current.planner.agent.profileName}.`
          : initialTask || "Continúa la planificación con el contexto de esta conversación.");
        const accepted = await session.send(buildHandoffPrompt(prepared, pending.reference.instruction ?? (role === "planner" ? PLANNING_INSTRUCTION : IMPLEMENTATION_INSTRUCTION)),
          outgoing?.images ?? [], outgoing?.previews ?? [], display);
        if (!currentOperation(token, cycle) || roomRef.current.pending?.id !== pending.id) return;
        if (accepted === false) throw new Error("El agente no confirmó la recepción. Revisa el historial antes de reanudar.");
        attempt.accepted = true;
        attachments.current.delete(pending.reference.id);
        change(current => ({ ...current, pending: null,
          plan: current.plan?.id === pending.reference.id ? { ...current.plan, pending: false } : current.plan, error: null }));
        setRevision(value => value + 1);
      } catch (error) {
        if (currentOperation(token, cycle)) change(current => ({ ...current, phase: "paused", error: formatError(error) }));
      } finally {
        if (operation.current === token) { operation.current = null; if (mounted.current) setWorking(false); }
      }
    })();
  }, [room.pending, room.phase, room.cycle, sessions, working, change]);

  // Only a terminal belonging to this mount's accepted send can advance a cycle.
  useEffect(() => {
    if (operation.current !== null || room.pending || !["planning", "waiting", "executing"].includes(room.phase)) return;
    for (const role of ROLES) {
      const session = sessionsRef.current[role], attempt = issued.current[role], completion = session?.state.lastCompletion;
      if (!session || !attempt?.accepted || attempt.cycle !== room.cycle || !completion || completion.id === attempt.previous
        || consumed.current.has(`${role}:${completion.id}`) || !completion.messageIds.some(id => !attempt.users.has(id))) continue;
      if (completion.status !== "completed") {
        consumed.current.add(`${role}:${completion.id}`);
        change(current => ({ ...current, phase: completion.status === "interrupted" ? "paused" : "failed",
          error: completion.status === "interrupted" ? "El turno fue detenido. Revisa el historial antes de reanudar." : "El agente no terminó correctamente. Revisa el error antes de continuar." }));
        return;
      }
      if (anyBusy() || anyQueued() || !allReady()) return;
      consumed.current.add(`${role}:${completion.id}`);
      if (role === "executor" || attempt.kind === "message") { change(current => ({ ...current, phase: "completed", error: null })); return; }
      const plan = completedWorkflowPlan(session.state.items, completion);
      if (!plan) {
        change(current => ({ ...current, phase: "waiting", active: "planner", error: "El planificador espera tu respuesta o todavía no ha entregado un plan definitivo." }));
        return;
      }
      const token = ++generation.current, cycle = room.cycle;
      operation.current = token;
      setWorking(true);
      change(current => ({ ...current, phase: "transferring", error: null }));
      void (async () => {
        try {
          const request = original.current;
          if (!request || request.cycle !== cycle) throw new Error("Falta la solicitud de este ciclo. Revisa el contexto antes de reanudar.");
          const clarifications = workflowClarifications(session.state.items.slice(request.start));
          const requestText = request.prepared.content.split("\n\n---\n## Estado del proyecto capturado por TREX\n")[0];
          const context = workflowPlanContext(plan, `${requestText}\n\n## Aclaraciones del usuario\n${clarifications || "Sin aclaraciones adicionales."}`, source("planner"));
          const prepared = await prepareHandoff(context);
          if (!currentOperation(token, cycle) || roomRef.current.phase !== "transferring") return;
          if (anyQueued()) {
            change(current => ({ ...current, phase: "waiting", active: "planner", error: "El planificador debe leer las aclaraciones en cola antes de entregar el plan." }));
            return;
          }
          const reference = { id: prepared.id, sourceLabel: prepared.sourceLabel, pending: true, instruction: IMPLEMENTATION_INSTRUCTION };
          pendingKinds.current.set(prepared.id, "execute");
          change(current => ({ ...current, phase: "executing", active: "executor", plan: reference,
            pending: { id: prepared.id, role: "executor", reference }, error: null }));
        } catch (error) {
          if (currentOperation(token, cycle)) change(current => ({ ...current, phase: "failed", error: formatError(error) }));
        } finally {
          if (operation.current === token) { operation.current = null; if (mounted.current) setWorking(false); }
        }
      })();
      return;
    }
  }, [sessions, room.phase, room.pending, room.cycle, revision, working, change]);

  const beforeSend = (text: string, images: OutgoingImage[], previews: string[]): boolean | "blocked" | Promise<true | "blocked"> => {
    const current = roomRef.current;
    if (/^\s*(?:\/plan(?:ificar)?|@(?:planner|executor|planificador|ejecutor|claude|codex|trex))\s*$/i.test(text)) return block("Añade la tarea al mensaje. Tu borrador se conserva.");
    const route = planIntent ? { kind: "plan" as const, role: "planner" as const, text } : routeRoomMessage(text, current);
    if (operation.current !== null || current.pending || current.phase === "transferring") return block("Espera a que termine la entrega o detén la sala antes de enviar otra tarea.");
    if (!allReady()) return block("Espera a que ambas sesiones y sus colas estén disponibles.");
    if ((route.kind === "plan" || route.role !== current.active) && (anyBusy() || anyQueued())) return block("Termina o detén el turno y resuelve la cola antes de cambiar de agente o de planificación.");
    if ((sessionsRef.current[route.role === "planner" ? "executor" : "planner"]?.state.pendingTurns ?? 0) > 0) return block("El otro agente sigue trabajando. Espera o detén la sala.");
    if (anyBusy() || anyQueued()) {
      if (route.text !== text) return block("Durante el turno, envía las aclaraciones sin prefijo al agente activo.");
      return false;
    }
    const firstPlan=current.phase==="idle" && route.role==="planner";
    const kind = route.kind === "plan" || firstPlan || (route.role === "planner" && ["planning", "waiting"].includes(current.phase)) ? "plan" : route.role === "executor" ? "execute" : "message";
    return prepareMessage(route.role, route.text, kind, route.kind === "plan"||firstPlan, images, previews).then(accepted => accepted ? true : "blocked");
  };

  const selectRole = (role: RoomRole): void => {
    if (role === roomRef.current.active) return;
    if (operation.current !== null || roomRef.current.pending || anyBusy() || anyQueued()) { block("Termina el turno y resuelve la cola antes de cambiar de agente."); return; }
    setPlanIntent(false);
    change(current => ({ ...current, active: role }));
    focusComposer();
  };
  const newPlanning = (): void => {
    if (operation.current !== null || roomRef.current.pending || anyBusy() || anyQueued()) { block("Termina o detén el turno y resuelve la cola antes de empezar otra planificación."); return; }
    change(current => ({ ...current, active: "planner" }));
    setPlanIntent(true);
    focusComposer();
  };
  const resume = (): void => {
    const current = roomRef.current, role = current.pending?.role ?? current.active;
    if (anyBusy() || anyQueued() || !allReady() || operation.current !== null) { block("Resuelve los turnos o mensajes pendientes y espera a que ambas sesiones estén listas."); return; }
    const token = ++generation.current, cycle = current.cycle;
    operation.current = token; setWorking(true);
    void (async () => {
      try {
        await sessionsRef.current[role]?.recover?.();
        if (!mounted.current || generation.current !== token || roomRef.current.cycle !== cycle) return;
        operation.current = null; setWorking(false);
        await prepareMessage(role, role === "planner" ? "Retoma la planificación de la tarea actual, teniendo en cuenta las aclaraciones y el estado actual. Entrega el plan definitivo cuando esté listo."
          : "Retoma la implementación de la tarea y el plan actuales. Comprueba primero qué cambios y pasos ya están hechos; continúa desde el estado actual sin repetirlos.", role === "planner" ? "plan" : "execute", false, [], [], true);
      } catch (error) {
        if (mounted.current && generation.current === token) { operation.current = null; setWorking(false); block(formatError(error)); }
      }
    })();
  };

  // A stopped/restored queue needs its own explicit user action. ChatPanel's
  // automatic wake path is deliberately refused while the room is paused.
  const continueQueue = async (role: RoomRole): Promise<void> => {
    const session = sessionsRef.current[role];
    if (!session || operation.current !== null || anyBusy() || !allReady()) return;
    if (session.queue.snapshot.outbox?.length) { block("Revisa el envío directo pendiente antes de continuar con esta cola."); return; }
    issued.current = {};
    const token = ++generation.current;
    operation.current = token; setWorking(true);
    change(current => ({ ...current, error: "Leyendo la cola por indicación tuya. Revisa el resultado antes de reanudar el ciclo." }));
    try {
      await session.recover?.();
      if (!mounted.current || generation.current !== token) return;
      operation.current = null; setWorking(false);
      await session.send(INBOX_WAKE, [], [], "Continuar con los mensajes pendientes");
    } catch (error) {
      if (mounted.current && generation.current === token) { operation.current = null; setWorking(false); block(formatError(error)); }
    }
  };

  const queuedSendReason = (message: QueuedMessage): string | null => {
    const current = roomRef.current, { role } = roomQueueAddress(message.id);
    if (operation.current !== null || current.pending || ["paused", "failed", "transferring"].includes(current.phase)) return "Revisa y reanuda la sala antes de enviar un mensaje directamente.";
    if (role !== current.active) return "Este mensaje pertenece al otro agente. Resuelve su cola desde la revisión de la sala.";
    if (!allReady()) return "Espera a que las dos conversaciones estén listas.";
    if ((sessionsRef.current[role === "planner" ? "executor" : "planner"]?.state.pendingTurns ?? 0) > 0) return "Espera a que termine el otro agente antes de enviar este mensaje.";
    return null;
  };
  const localCommandReason = (name: string): string | null => {
    const current = roomRef.current, command = localCommand(current[current.active].agent.provider, name);
    if (!command || ["model", "effort", "fast", "permissions", "status", "help"].includes(command)) return null;
    if (["clear", "new", "reset"].includes(command)) return "Usa Nueva planificación para conservar las dos conversaciones.";
    return operation.current !== null || current.pending || anyBusy() || anyQueued() || ["paused", "failed", "transferring"].includes(current.phase)
      ? "Revisa y resuelve los turnos y mensajes pendientes antes de ejecutar este comando en la sala." : null;
  };
  const sendRoomMessage = async (role: RoomRole, text: string, images: OutgoingImage[], previews: string[], display?: string, immediate = false): Promise<boolean> => {
    const current = roomRef.current;
    if (operation.current !== null || current.pending || ["paused", "failed", "transferring"].includes(current.phase)) return false;
    const peer = role === "planner" ? "executor" : "planner", session = sessionsRef.current[role];
    if (!session || (sessionsRef.current[peer]?.state.pendingTurns ?? 0) > 0) return false;
    const attempt: Issued = { cycle: current.cycle, kind: role === "planner" && ["planning", "waiting"].includes(current.phase) ? "plan" : role === "executor" ? "execute" : "message",
      previous: session.state.lastCompletion?.id ?? null, users: new Set(session.state.items.filter(item => item.kind === "user").map(item => item.id)), accepted: false };
    issued.current[role] = attempt;
    change(value => ({ ...value, active: role, phase: role === "planner" ? "planning" : "executing", error: null }));
    const token = generation.current;
    try {
      const accepted = await (immediate && session.sendNow ? session.sendNow : session.send)(text, images, previews, display);
      if (!mounted.current || token !== generation.current) return false;
      if (accepted === false) {
        issued.current = {};
        change(value => ({ ...value, phase: "paused", error: "La aclaración no se entregó. Revisa la conversación antes de reanudar." }));
        return false;
      }
      attempt.accepted = true;
      setRevision(value => value + 1);
      return true;
    } catch (error) {
      if (mounted.current && token === generation.current) {
        issued.current = {};
        change(value => ({ ...value, phase: "paused", error: formatError(error) }));
      }
      return false;
    }
  };

  const chosen = sessions[room.active];
  const fallbackState = useMemo(() => initialChatState(), []);
  const rawState = chosen?.state ?? fallbackState;
  const lock = working || !!room.pending || room.phase === "transferring";
  const busy = ROLES.some(role => (sessions[role]?.state.pendingTurns ?? 0) > 0);
  const hasQueue = queueWrites.current > 0 || ROLES.some(role => queued(sessions[role]));
  const disableSelection = lock || busy || hasQueue;
  const itemLabels = Object.fromEntries(Object.entries(merged.owners).map(([id, owner]) => [id, {
    provider: room[owner.role].agent.provider, label: `${ROLE_NAMES[owner.role]} · ${room[owner.role].agent.profileName}`,
  }]));

  const toolbar = <div className="agent-room-toolbar">
    <div className="agent-room-participants" aria-label="Participantes de la conversación">
      {ROLES.map(role => {
        const participant = room[role], session = sessions[role], state = session?.state;
        const models = state?.models ?? [], model = state?.modelChoice ?? state?.model ?? participant.agent.model ?? "";
        const efforts = state ? supportedEfforts(models, state.model, state.modelChoice) : [];
        const effort = state?.effortChoice ?? state?.effort ?? participant.agent.effort ?? "";
        return <div key={role} className={`agent-room-participant${room.active === role ? " is-selected" : ""}`}>
          <button type="button" className="agent-room-person" aria-pressed={room.active === role} disabled={disableSelection && room.active !== role}
            onClick={() => selectRole(role)} title={`Escribir al ${ROLE_NAMES[role].toLowerCase()}`}>
            <AgentIcon kind={participant.agent.provider} size={17} activity={state ? chatActivity(state) : "idle"} />
            <span><strong>{ROLE_NAMES[role]}</strong><small>{participant.agent.profileName}</small></span>
            {role === "planner" && <span className="agent-room-readonly">Solo lectura</span>}
          </button>
          <div className="agent-room-settings">
            {models.length ? <Select aria-label={`Modelo del ${ROLE_NAMES[role].toLowerCase()}`} value={model} disabled={disableSelection}
              options={models.map(item => ({ value: item.value, label: item.displayName }))} onChange={value => sessionsRef.current[role]?.setModel(value)} />
              : <span title={model || "Modelo del perfil"}>{model || "Modelo del perfil"}</span>}
            {efforts.length ? <Select aria-label={`Esfuerzo del ${ROLE_NAMES[role].toLowerCase()}`} value={effort} disabled={disableSelection}
              placeholder="Esfuerzo del perfil" options={efforts.map(value => ({ value, label: effortLabel(value) }))}
              onChange={value => sessionsRef.current[role]?.setEffort(value)} /> : <span>{effort ? effortLabel(effort) : "Esfuerzo del perfil"}</span>}
          </div>
          {state && ["failed", "exited"].includes(state.process) && <div className="agent-room-runtime-error">
            <span>{ROLE_NAMES[role]} sin conexión</span>
            <button type="button" className="agent-room-action" disabled={busy || working}
              onClick={() => { void sessionsRef.current[role]?.start().catch(error => latest.current.onMessage(formatError(error))); }}
              aria-label={`Reintentar ${ROLE_NAMES[role].toLowerCase()}`}>Reintentar</button>
          </div>}
        </div>;
      })}
    </div>
    <div className="agent-room-status" role="status"><span className={`agent-room-phase phase-${room.phase}`}>{PHASE_NAMES[room.phase]}</span>
      <span className="agent-room-cycle">Ciclo {room.cycle}</span>
      {(busy || lock) && <button type="button" className="agent-room-action" onClick={stop}><StopIcon size={12} />Detener</button>}
      {["paused", "failed"].includes(room.phase) && <button type="button" className="agent-room-action" onClick={() => setReviewing(value => !value)}>Revisar y reanudar</button>}
      <button type="button" className="agent-room-action" disabled={disableSelection} onClick={newPlanning}><MapIcon size={13} />Nueva planificación</button>
    </div>
    {(room.error || reviewing) && <div className="agent-room-note"><span>{room.error}</span>{reviewing && <>
      <p>Revisa las dos conversaciones. Al continuar, el agente comprobará el estado actual y los pasos ya realizados.</p>
      <button type="button" className="agent-room-action" disabled={busy || working || hasQueue} onClick={resume}>Continuar {room.pending?.role === "planner" || (!room.pending && room.active === "planner") ? "planificación" : "ejecución"}</button>
      {ROLES.map(role => {
        const queue = sessions[role]?.queue;
        if (!queue || (!queue.snapshot.messages.length && !queue.snapshot.receipt)) return null;
        return <div key={role} className="agent-room-queue-review">
          <strong>{ROLE_NAMES[role]} · Mensajes pendientes</strong>
          {queue.snapshot.messages.map(message => <div key={message.id}><span>{message.text || "Imágenes adjuntas"}</span>
            <button type="button" className="agent-room-action" disabled={busy || working} onClick={() => {
              void sessionsRef.current[role]?.queue.client.remove(message.id).catch(error => latest.current.onMessage(formatError(error)));
            }}>Cancelar mensaje</button></div>)}
          <button type="button" className="agent-room-action" disabled={busy || working} onClick={() => { void continueQueue(role); }}>Continuar cola del {ROLE_NAMES[role].toLowerCase()}</button>
        </div>;
      })}
    </>}</div>}
  </div>;
  const composerLead = <div className="agent-room-composer-lead"><div className="agent-room-target"><span>Enviar a</span>
    <Select aria-label="Agente destinatario" value={room.active} disabled={disableSelection} onChange={value => selectRole(value as RoomRole)}
      options={ROLES.map(role => ({ value: role, label: `${ROLE_NAMES[role]} · ${room[role].agent.profileName}`, icon: <AgentIcon kind={room[role].agent.provider} size={13} /> }))} />
    </div>
    <button type="button" className={`agent-room-plan-action${planIntent ? " is-active" : ""}`} aria-pressed={planIntent} disabled={disableSelection}
      onClick={() => planIntent ? setPlanIntent(false) : newPlanning()} title="La siguiente tarea inicia un ciclo. También puedes escribir /plan tarea.">
      <MapIcon size={13} />Planear y ejecutar</button>
    {planIntent && <small>Escribe la nueva tarea · /plan</small>}
  </div>;

  let aggregate: ChatSession | null = null;
  if (chosen) {
    const messages = ROLES.flatMap(role => sessions[role] ? roomQueueSnapshot(role, sessions[role]!.queue.snapshot).messages : []);
    const receipts = ROLES.flatMap(role => (sessions[role]?.queue.snapshot.receipt?.messages ?? []).map(message => ({ ...message, id: `${role}::${message.id}` })));
    const outbox = ROLES.flatMap(role => sessions[role] ? roomQueueSnapshot(role, sessions[role]!.queue.snapshot).outbox ?? [] : []);
    const client = Object.create(chosen.queue.client) as typeof chosen.queue.client;
    const mutate = async (id: string, work: (session: ChatSession, nativeId: string) => ReturnType<typeof client.load>) => {
      const address = roomQueueAddress(id), target = sessionsRef.current[address.role];
      if (!target) throw new Error("No se encontró la cola del agente.");
      queueWrites.current++;
      try { return roomQueueSnapshot(address.role, await work(target, address.id)); }
      finally { queueWrites.current--; if (mounted.current) setRevision(value => value + 1); }
    };
    client.remove = id => mutate(id, (target, nativeId) => target.queue.client.remove(nativeId));
    client.update = (id, text, expectedText) => mutate(id, (target, nativeId) => target.queue.client.update(nativeId, text, expectedText));
    client.claimDirect = (id, expected) => mutate(id, (target, nativeId) => target.queue.client.claimDirect(nativeId, { ...expected, id: nativeId }));
    client.ackDirect = id => mutate(id, (target, nativeId) => target.queue.client.ackDirect(nativeId));
    client.restoreDirect = id => mutate(id, (target, nativeId) => target.queue.client.restoreDirect(nativeId));
    aggregate = { ...chosen, state: { ...rawState, items: merged.items, lastCompletion: null,
      commands: [...rawState.commands.filter(command => command.name !== "plan" && command.name !== "planificar"),
        { name: "plan", description: "Planear y ejecutar con los dos agentes", hint: "[tarea]" },
        { name: "planificar", description: "Inicia una nueva planificación compartida", hint: "[tarea]" }],
      agents: [...rawState.agents.filter(agent => !["planner", "executor"].includes(agent.name)),
        { name: "planner", description: `Planificador · ${room.planner.agent.profileName}` },
        { name: "executor", description: `Ejecutor · ${room.executor.agent.profileName}` }],
      pendingTurns: ROLES.reduce((total, role) => total + (sessions[role]?.state.pendingTurns ?? 0), 0),
      historyCount: ROLES.reduce((total, role) => total + (sessions[role]?.state.historyCount ?? 0), 0),
      turnStartedAt: ROLES.map(role => sessions[role]?.state.turnStartedAt).filter((value): value is number => value != null).sort((a, b) => a - b)[0] ?? null,
    }, queue: { ...chosen.queue, client, ready: ROLES.every(role => sessions[role]?.queue.ready),
      error: ROLES.map(role => sessions[role]?.queue.error).find(Boolean) ?? null,
      snapshot: { messages, receipt: receipts.length ? { id: "room-receipt", messages: receipts } : null, outbox },
      reload: async () => { await Promise.all(ROLES.map(role => sessionsRef.current[role]?.queue.reload())); return sessionsRef.current[roomRef.current.active]!.queue.snapshot; },
      enqueue: async (text, images, previews) => {
        queueWrites.current++;
        try { return await sessionsRef.current[roomRef.current.active]!.queue.enqueue(text, images, previews); }
        finally { queueWrites.current--; if (mounted.current) setRevision(value => value + 1); }
      },
    },
      send: async (text, images, previews, display) => {
        const current = roomRef.current;
        const role = text === INBOX_WAKE ? ROLES.find(candidate => queued(sessionsRef.current[candidate])) ?? current.active : current.active;
        return sendRoomMessage(role, text, images, previews, display);
      },
      sendNow: (text, images, previews, display) => sendRoomMessage(roomRef.current.active, text, images, previews, display, true),
      edit: async () => { throw new Error("El historial compartido se conserva completo. Envía una corrección como mensaje nuevo."); },
      reset: () => { block("El historial compartido se conserva. Usa Nueva planificación para iniciar otro ciclo."); },
      runCommand: (name, args) => {
        const reason = localCommandReason(name);
        if (reason) { block(reason); return true; }
        return sessionsRef.current[roomRef.current.active]!.runCommand(name, args);
      },
      interrupt: stop,
      answer: (item, allowed, remember, choices) => {
        const owner = merged.owners[item.id], session = owner ? sessionsRef.current[owner.role] : null;
        const originalItem = session?.state.items.find(value => value.id === owner?.originalId);
        if (originalItem?.kind !== "permission" || originalItem.state !== "pending") { block("Esta solicitud ya no está pendiente."); return; }
        session!.answer(originalItem, allowed, remember, choices);
      },
      setMode: value => { if (roomRef.current.active === "executor") sessionsRef.current.executor?.setMode(value); },
      setModel: value => sessionsRef.current[roomRef.current.active]?.setModel(value),
      setEffort: value => sessionsRef.current[roomRef.current.active]?.setEffort(value),
      setFast: value => sessionsRef.current[roomRef.current.active]?.setFast(value),
    };
  }

  return <div className="agent-room" ref={root}>
    {ROLES.map(role => {
      const participant = room[role], launch = participant.agent.launch;
      const options: ChatSessionOptions = {
      browser, sessionId: `${room.id}-${role}`, queueId: messageQueueId(`${room.id}-${role}`), cwd: props.cwd, ...launch,
        conversationId: participant.conversationId, model: participant.agent.model, effort: participant.agent.effort,
        mode: role === "planner" ? "plan" : participant.mode ?? (participant.agent.provider === "claude" ? "default" : "auto"),
        planningOnly: role === "planner", visible: props.visible,
        onRunning: () => latest.current.onRunning(latest.current.sessionId),
        onExit: (_id, code) => { if (ROLES.every(candidate => candidate === role || ["failed", "exited"].includes(sessionsRef.current[candidate]?.state.process ?? "starting"))) latest.current.onExit(latest.current.sessionId, code); },
      };
      const Runtime = participant.agent.provider === "trex" ? TrexRuntime : participant.agent.provider === "claude" ? ClaudeRuntime : CodexRuntime;
      return <Runtime key={`${room.id}-${role}-${participant.agent.profileId}`} role={role} options={options} publish={publish} />;
    })}
    {aggregate ? <ChatPanel {...props} browser={browser} provider={room[room.active].agent.provider} profileId={room[room.active].agent.profileId}
      profileName={room[room.active].agent.profileName} conversationId={room[room.active].conversationId}
      terminalOwners={ROLES.flatMap(role=>{const session=sessions[role]?.terminals;return session?[{id:role,label:room[role].agent.profileName+" · "+(role==="planner"?"Planificación":"Implementación"),provider:room[role].agent.provider,session}]:[];})} session={aggregate} toolbar={toolbar} composerLead={composerLead} itemLabels={itemLabels} inputLocked={lock}
      emptyState={{title:"Tu flujo está listo",description:"Escribe tu idea en este chat. Primero se preparará el plan y después el ejecutor lo implementará; aquí podrás conversar con ambos.",
        participants:ROLES.map(role=>({id:role,name:room[role].agent.profileName,role:role==="planner"?"Planificación · solo lectura":"Implementación",provider:room[role].agent.provider,model:room[role].agent.model,effort:room[role].agent.effort}))}}
      composerPlaceholder={room.active==="planner"?"Escribe tu idea para preparar el plan…":"Escribe una indicación para el ejecutor…"}
      historyReadOnly planningOnly={room.active === "planner"} onBeforeSend={beforeSend}
      queuedSendReason={queuedSendReason} onQueuedSend={message => sendRoomMessage(roomQueueAddress(message.id).role, message.text, message.images, message.previews, undefined, true)}
      localCommandReason={localCommandReason}
      onConversation={noop} onMode={noop} onModel={noop} onEffort={noop} onHandoffRequest={undefined} onPlanHere={undefined} />
      : <div className="agent-room-starting">{toolbar}<p>Preparando las dos conversaciones…</p></div>}
  </div>;
}
