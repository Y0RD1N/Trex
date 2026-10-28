/** Trex CLI owns provider HTTP, credentials and tools; React only speaks its versioned protocol. */
import { useEffect, useReducer, useRef } from "react";
import { agentWrite, agentTeamMcpConfig, formatError } from "../api";
import { initialChatState, record, text, type Json, type OutgoingImage } from "../chatState";
import { InboxRequests, INBOX_INSTRUCTIONS, type QueueSnapshot } from "../messageQueue";
import { taskInstructions } from "../chatTasks";
import { integrationInstructions } from "../integrations";
import { parseTrexModels, trexReducer, trexRequest, trexResult } from "../trexChat";
import { localId, useAgentProcess, type ChatSession, type ChatSessionOptions } from "./chatSession";
import { useMessageQueue } from "./useMessageQueue";

type Pending = { process: string; resolve: (value: Json) => void; reject: (reason: Error) => void; timer: ReturnType<typeof setTimeout> };
type ActiveTurn = { id: string; process: string; session: string; settled: Promise<void>; settle: () => void };
async function cancellable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort: () => void = () => undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => {
    abort = () => reject(new Error("Envío cancelado.")); signal.addEventListener("abort", abort, { once: true });
  })]); } finally { signal.removeEventListener("abort", abort); }
}
export function useTrexChat(options: ChatSessionOptions): ChatSession {
  const planningOnly = useRef(!!options.planningOnly).current;
  const [state, dispatch] = useReducer(trexReducer, undefined, () => initialChatState(planningOnly ? "plan" : options.mode ?? "ask", options.model, options.effort));
  const stateRef = useRef(state); stateRef.current = state;
  const latest = useRef(options); latest.current = options;
  const queue = useMessageQueue(options.queueId ?? options.sessionId);
  const pending = useRef(new Map<string | number, Pending>());
  const ready = useRef<Promise<void> | null>(null), processId = useRef<string | null>(null);
  const startupGeneration = useRef(0);
  const choices = useRef({ mode: planningOnly ? "plan" : options.mode ?? "ask", model: options.model ?? null, effort: options.effort ?? null });
  const nativeConversation = useRef(options.conversationId);
  const recovery = useRef(false), mounted = useRef(true);
  const sending = useRef<{ id: string; controller: AbortController; issued: boolean; displayed: boolean } | null>(null);
  // El terminal del protocolo confirma que también terminó la cancelación de herramientas.
  const activeTurn = useRef<ActiveTurn | null>(null);
  const inboxRequests = useRef(new InboxRequests());
  const receipts = useRef(new Map<string, { process: string; messageId: string; snapshot: QueueSnapshot }>());
  const isCurrent = useRef<(id: string) => boolean>(() => false);
  const notice = (tone: "info" | "warn" | "error", message: string): void => dispatch({ type: "notice", id: localId(), tone, text: message });
  const rejectPending = (message: string): void => {
    for (const waiter of pending.current.values()) { clearTimeout(waiter.timer); waiter.reject(new Error(message)); }
    pending.current.clear();
  };
  const cancelDeferred = (): void => { sending.current?.controller.abort(); };
  const agent = useAgentProcess(options.sessionId, {
    onLine(line, procId) {
      let message: Json | null;
      try { message = record(JSON.parse(line)); } catch { return; }
      if (!message) return;
      const id = message.id;
      if ((typeof id === "string" || typeof id === "number") && typeof message.method !== "string") {
        const waiter = pending.current.get(id);
        if (!waiter || waiter.process !== procId) return;
        clearTimeout(waiter.timer); pending.current.delete(id);
        if (message.error) waiter.reject(new Error(text(record(message.error)?.message) || "Trex CLI rechazó la petición."));
        else waiter.resolve(record(message.result) ?? {});
        return;
      }
      const params = record(message.params) ?? {}, method = text(message.method);
      if (method === "inbox/read" && (typeof id === "string" || typeof id === "number")) {
        void (async () => {
          try {
            if (params.sessionId !== nativeConversation.current || !stateRef.current.pendingMessageIds.includes(text(params.messageId))) throw new Error("La petición pertenece a un turno que ya no está activo.");
            const snapshot = await inboxRequests.current.read(JSON.stringify([procId, typeof id, id]), queue.client.read);
            if (!isCurrent.current(procId)) return;
            if (snapshot.receipt) receipts.current.set(snapshot.receipt.id, { process: procId, messageId: text(params.messageId), snapshot });
            await agentWrite(procId, trexResult(id, { receiptId: snapshot.receipt?.id ?? null, messages: snapshot.receipt?.messages ?? [] }));
          } catch (error) {
            if (isCurrent.current(procId)) void agentWrite(procId, JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message: formatError(error) } })).catch(() => undefined);
          }
        })();
        return;
      }
      if (method === "inbox/consumed") {
        const receiptId = text(params.receiptId), delivered = receipts.current.get(receiptId);
        if (!delivered || delivered.process !== procId || params.sessionId !== nativeConversation.current || params.messageId !== delivered.messageId) return;
        void queue.client.ack(receiptId, () => isCurrent.current(procId)).then(() => {
          if (!isCurrent.current(procId)) return;
          receipts.current.delete(receiptId);
          if (delivered.snapshot.receipt) dispatch({ type: "queuedRead", messages: delivered.snapshot.receipt.messages });
        }).catch(error => notice("error", `La confirmación de la cola sigue pendiente: ${formatError(error)}`));
        return;
      }
      const turn = activeTurn.current;
      const terminal = turn !== null && method === "turn/completed" && turn.id === params.messageId
        && turn.process === procId && turn.session === params.sessionId;
      if (terminal && params.recoveryRequired === true) recovery.current = true;
      dispatch({ type: "trexEvent", method, params, now: Date.now() });
      if (terminal) { activeTurn.current = null; turn.settle(); }
    },
    onStderr(line) { dispatch({ type: "stderr", line }); },
    onExit(code) {
      cancelDeferred(); activeTurn.current = null;
      startupGeneration.current++;
      ready.current = null; processId.current = null;
      rejectPending("Trex CLI se cerró antes de responder.");
      dispatch({ type: "exit", code });
      latest.current.onExit(latest.current.sessionId, code);
    },
  }, "trex");
  isCurrent.current = agent.isCurrent;

  const rpc = (procId: string, method: string, params: unknown = {}): Promise<Json> => new Promise((resolve, reject) => {
    if (!mounted.current || processId.current !== procId || !agent.isCurrent(procId)) { reject(new Error("La sesión de Trex CLI ya no está activa.")); return; }
    const id = localId();
    const timer = setTimeout(() => { pending.current.delete(id); reject(new Error(`Trex CLI tardó demasiado en responder a ${method}.`)); }, 30_000);
    pending.current.set(id, { process: procId, resolve, reject, timer });
    void agentWrite(procId, trexRequest(id, method, params)).catch(error => {
      const waiter = pending.current.get(id);
      if (waiter) { clearTimeout(waiter.timer); pending.current.delete(id); waiter.reject(new Error(formatError(error))); }
    });
  });
  const start = (): Promise<void> => {
    if (!mounted.current) return Promise.reject(new Error("Se cerró la sesión."));
    if (ready.current) return ready.current;
    const token = ++startupGeneration.current;
    const assertStartup = (procId: string): void => {
      if (!mounted.current || startupGeneration.current !== token || !agent.isCurrent(procId)) throw new Error("La sesión se sustituyó durante el arranque.");
    };
    ready.current = (async () => {
      rejectPending("La sesión de Trex CLI se está reiniciando.");
      const current = latest.current;
      const procId = await agent.spawn({ cwd: current.cwd, command: current.command ?? "trex-agent", profileArgs: current.args,
        flags: ["app-server"], shell: current.shell, env: current.env });
      if (!procId || !mounted.current || startupGeneration.current !== token) throw new Error("Se canceló el arranque de Trex CLI.");
      processId.current = procId;
      const init = await rpc(procId, "initialize", { protocolVersion: 1, client: "trex", inbox: true });
      assertStartup(procId);
      if (init.protocolVersion !== 1) throw new Error("La versión de Trex CLI no es compatible con esta app.");
      let models = parseTrexModels(init.models);
      try { models = parseTrexModels((await rpc(procId, "models/list")).models); }
      catch (error) { assertStartup(procId); notice("warn", `No se pudo actualizar el catálogo: ${formatError(error)}`); }
      assertStartup(procId);
      const selected = choices.current;
      const team = current.team ? await agentTeamMcpConfig(current.team) : null;
      assertStartup(procId);
      const result = await rpc(procId, "session/start", { cwd: current.cwd, mode: planningOnly ? "plan" : selected.mode,
        model: selected.model, effort: selected.effort, conversationId: nativeConversation.current, instructions: `${INBOX_INSTRUCTIONS} ${taskInstructions("trex")} ${integrationInstructions("trex")}`,
        ...(current.planningInstruction ? { roleInstructions: current.planningInstruction } : {}),
        desktopEnabled: current.desktopEnabled === true, ...(current.browser ? { browser: current.browser } : {}), ...(team ? { team: { command: team.command, args: team.callArgs } } : {}) });
      if (!agent.isCurrent(procId) || !mounted.current || startupGeneration.current !== token) throw new Error("La sesión se sustituyó durante el arranque.");
      if (result.instructionsApplied !== true) throw new Error("Trex CLI no confirmó las instrucciones de las herramientas. Actualiza el CLI antes de iniciar esta conversación.");
      if (current.desktopEnabled && result.desktopEnabled !== true) throw new Error("Este Trex CLI no confirmó el control de computadora. Actualiza el CLI antes de activarlo.");
      if (planningOnly && result.mode !== "plan") throw new Error("Trex CLI no confirmó el modo de planificación de solo lectura.");
      if (team && result.teamEnabled !== true) throw new Error("Este Trex CLI no confirmó la delegación. Actualiza el CLI antes de usarlo como agente principal.");
      if (current.planningInstruction && result.rolePolicyApplied !== true) throw new Error("Este Trex CLI no confirmó las instrucciones de la función. Actualiza el CLI antes de iniciar el equipo.");
      nativeConversation.current = text(result.sessionId);
      if (!nativeConversation.current) throw new Error("Trex CLI no devolvió el identificador de conversación.");
      agent.bindTerminals?.(nativeConversation.current);
      recovery.current = result.recoveryRequired === true;
      if (!models.some(model => model.value === result.model) && typeof result.model === "string") models.unshift({ value: result.model, resolvedModel: result.model, displayName: result.model, description: "Modelo configurado en el perfil", featured: true, efforts: [] });
      dispatch({ type: "trexReady", result, models });
      if (recovery.current) notice("warn", "La sesión se interrumpió con operaciones pendientes. Revisa los archivos y usa /recover antes de continuar; las herramientas anteriores no se repetirán automáticamente.");
      latest.current.onRunning(latest.current.sessionId);
    })().catch(error => { if (startupGeneration.current === token) { ready.current = null; if (mounted.current) dispatch({ type: "spawnFailed", message: formatError(error) }); } throw error; });
    return ready.current;
  };
  const waitForSettled = async (turn: ActiveTurn, signal: AbortSignal): Promise<void> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await cancellable(Promise.race([turn.settled, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Trex CLI no confirmó el fin del turno anterior. Revisa la sesión antes de reintentar el envío.")), 30_000);
      })]), signal);
    } finally { clearTimeout(timer); }
  };
  const submit = async (value: string, images: OutgoingImage[], previews: string[], display: string | undefined, immediate: boolean, onInterrupt?: (messageId: string) => void): Promise<boolean> => {
    const inFlight = sending.current;
    if (!mounted.current || (inFlight && (!immediate || !inFlight.issued)) || (!immediate && activeTurn.current)) return false;
    // Un turn/start ya escrito puede seguir esperando su RPC. Cancelar esa espera
    // no prueba que no se emitió: conserva activeTurn hasta su terminal nativo.
    inFlight?.controller.abort();
    const previous = activeTurn.current;
    const attempt = { id: crypto.randomUUID(), controller: new AbortController(), issued: false, displayed: false };
    sending.current = attempt;
    const show = (): void => {
      attempt.displayed = true;
      dispatch({ type: "send", id: attempt.id, text: display ?? value, previews, now: Date.now() });
    };
    try {
      // El callback identifica exactamente el turno marcado, antes de cualquier await.
      if (previous) {
        try { onInterrupt?.(previous.id); }
        finally { dispatch({ type: "interruptSend", id: previous.id }); }
      } else show();
      // La espera puede cancelarse sin depender de la inicialización del proveedor.
      const starting = start(), generation = startupGeneration.current;
      await cancellable(starting, attempt.controller.signal);
      const procId = processId.current;
      const assertCurrent = (): void => {
        attempt.controller.signal.throwIfAborted();
        if (!mounted.current || startupGeneration.current !== generation || !procId || processId.current !== procId || !agent.isCurrent(procId)) throw new Error("La sesión de Trex CLI se sustituyó durante el envío.");
        if (recovery.current) throw new Error("Revisa los archivos y confirma /recover antes de continuar esta conversación.");
      };
      assertCurrent();
      if (!procId) throw new Error("Trex CLI no está activo.");
      if (previous) {
        if (previous.process !== procId || previous.session !== nativeConversation.current) throw new Error("El turno anterior pertenece a otra sesión de Trex CLI.");
        if (activeTurn.current === previous) await Promise.all([
          waitForSettled(previous, attempt.controller.signal),
          cancellable(rpc(procId, "turn/interrupt", { sessionId: previous.session, messageId: previous.id }), attempt.controller.signal),
        ]);
        assertCurrent();
        show();
      }
      attempt.issued = true;
      let settle!: () => void;
      activeTurn.current = { id: attempt.id, process: procId, session: nativeConversation.current!, settled: new Promise<void>(resolve => { settle = resolve; }), settle };
      const result = await cancellable(rpc(procId, "turn/start", { sessionId: nativeConversation.current, messageId: attempt.id, text: value, display: display ?? value,
        images, model: choices.current.model, effort: choices.current.effort }), attempt.controller.signal);
      assertCurrent();
      if (result.accepted !== true) throw new Error("Trex CLI no confirmó la aceptación del mensaje. Revisa la sesión antes de reintentar.");
      return true;
    } catch (error) {
      if (attempt.controller.signal.aborted && !attempt.issued && attempt.displayed && mounted.current) dispatch({ type: "cancelSend", id: attempt.id });
      else if (!attempt.controller.signal.aborted && mounted.current) {
        if (attempt.displayed) dispatch({ type: "trexFailed", id: attempt.id, message: formatError(error) });
        else notice("error", formatError(error));
      }
      return false;
    } finally { attempt.controller.abort(); if (sending.current === attempt) sending.current = null; }
  };
  const send = (value: string, images: OutgoingImage[], previews: string[], display?: string): Promise<boolean> => submit(value, images, previews, display, false);
  const sendNow = (value: string, images: OutgoingImage[], previews: string[], display?: string, onInterrupt?: (messageId: string) => void): Promise<boolean> => submit(value, images, previews, display, true, onInterrupt);
  const interrupt = (): void => {
    const attempt = sending.current;
    attempt?.controller.abort();
    if (attempt?.displayed && !attempt.issued) dispatch({ type: "cancelSend", id: attempt.id });
    if (attempt?.issued) dispatch({ type: "interruptSend", id: attempt.id });
    for (const id of stateRef.current.pendingMessageIds) dispatch({ type: "interruptSend", id });
    if (activeTurn.current) dispatch({ type: "interruptSend", id: activeTurn.current.id });
    if (mounted.current && processId.current && nativeConversation.current) void rpc(processId.current, "turn/interrupt", { sessionId: nativeConversation.current,
      ...(activeTurn.current ? { messageId: activeTurn.current.id } : {}) }).catch(error => { if (mounted.current) notice("error", formatError(error)); });
  };
  const recoverSession = async (): Promise<void> => {
    await start();
    if (!recovery.current) return;
    if (stateRef.current.pendingTurns) throw new Error("Espera a que termine la respuesta antes de confirmar la revisión.");
    if (!processId.current || !nativeConversation.current) throw new Error("Trex CLI no está listo para recuperar la sesión.");
    await rpc(processId.current, "session/recover", { sessionId: nativeConversation.current, action: "acknowledge" });
    recovery.current = false;
  };
  useEffect(() => {
    if (options.visible) void start().catch(() => undefined);
  }, [options.visible]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; startupGeneration.current++; cancelDeferred(); activeTurn.current = null; rejectPending("Se cerró la sesión."); }; }, []);

  return { provider: "trex", state, queue, terminals: agent.terminals, start: async () => {
    if (!mounted.current) return;
    cancelDeferred();
    if (activeTurn.current) dispatch({ type: "cancelSend", id: activeTurn.current.id });
    activeTurn.current = null; ready.current = null; processId.current = null; startupGeneration.current++;
    await start();
  }, send, sendNow, interrupt, notice, recover: recoverSession,
    reset() {
      if (activeTurn.current) { notice("info", "Detén el agente antes de empezar otra conversación."); return; }
      cancelDeferred();
      nativeConversation.current = null; ready.current = null; startupGeneration.current++; recovery.current = false; dispatch({ type: "reset" });
      void start().catch(() => undefined);
    },
    edit: async () => { throw new Error("Envía una corrección nueva para conservar el historial de Trex CLI."); },
    answer(item, allowed) {
      const procId = processId.current;
      if (!procId || item.state !== "pending") return;
      void rpc(procId, "permission/respond", { id: item.request?.id ?? item.id, allowed }).then(() => dispatch({ type: "answer", id: item.id, allowed }))
        .catch(error => notice("error", formatError(error)));
    },
    setMode(mode) {
      if (planningOnly && mode !== "plan") return;
      if (activeTurn.current) { notice("info", "Detén el agente antes de cambiar sus permisos."); return; }
      if (!["ask", "auto", "plan", "full"].includes(mode)) return;
      cancelDeferred();
      choices.current.mode = mode;
      dispatch({ type: "mode", mode }); ready.current = null; startupGeneration.current++;
    },
    setModel(model) {
      if (!stateRef.current.models.some(item => item.value === model)) return;
      choices.current.model = model;
      dispatch({ type: "model", model });
      const effort = stateRef.current.effortChoice;
      if (effort && !stateRef.current.models.find(item => item.value === model)?.efforts.includes(effort)) { choices.current.effort = null; dispatch({ type: "effort", effort: "" }); }
    },
    setEffort(effort) {
      if (!stateRef.current.models.find(item => item.value === (choices.current.model ?? stateRef.current.model))?.efforts.includes(effort)) return;
      choices.current.effort = effort;
      dispatch({ type: "effort", effort });
    },
    setFast: () => undefined,
    refreshSkills: async () => undefined,
    runCommand(name) {
      if (name !== "recover") return false;
      void recoverSession().then(() => notice("info", "Revisión confirmada. Puedes continuar con un mensaje nuevo.")).catch(error => notice("error", formatError(error)));
      return true;
    },
  };
}
