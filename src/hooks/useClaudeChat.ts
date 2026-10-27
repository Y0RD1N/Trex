import { connectBrowser } from "../browserConnection";
import { browserMode, OBSERVE_BROWSER_TOOLS } from "../browser";
/**
 * Sesión de Claude Code como chat: `claude -p` con stream-json.
 *
 * Envía los mensajes, las interrupciones y las respuestas a los permisos como
 * líneas JSON, y pide al CLI su catálogo de modelos y los ajustes en uso.
 */
import { useCallback, useEffect, useReducer, useRef } from "react";
import { agentKill, agentWrite, agentTeamMcpConfig, claudeRewindPoint, formatError } from "../api";
import { TEAM_TOOLS, TEAM_SERVER } from "../agentTeam";
import { browserConfigForShell } from "../browser";
import { withoutConversationArgs } from "../chatMessages";
import { claudeSkillText, parseClaudeCommands } from "../chatCommands";
import { readConversation } from "../conversations";
import {
  allowsAll, autoAllowed, initialChatState, needsAnswer, record, type OutgoingImage, type PermissionItem, type QuestionChoice,
} from "../chatState";
import { answeredInput, chatReducer, claudeChatFlags, controlErrorLine, controlLine, permissionLine, userMessageLine } from "../claudeChat";
import { localId, useAgentProcess, type ChatSession, type ChatSessionOptions } from "./chatSession";
import { useMessageQueue } from "./useMessageQueue";
import { InboxRequests, INBOX_SERVER } from "../messageQueue";
import { CLAUDE_INBOX_TOOL, claudeInboxInitialize, claudeInboxReply } from "../inboxProtocol";
import { IS_WINDOWS } from "../platform";
import { assertClaudePlanningMode, claudePlanningArgs, claudeProfilePermissionMode, claudePlanningExitResponse, claudePlanningFlags } from "../workflowSafety";

/** El uso del plan se pide al servidor de Claude: como mucho una vez por minuto. */
const USAGE_INTERVAL_MS = 60_000;
// A shell or unknown tool approval can escape plan mode; only known readers may be approved.
const PLANNING_READ_TOOLS = new Set(["Read", "Glob", "Grep", "LS", "NotebookRead", "WebFetch", "WebSearch", "AskUserQuestion", CLAUDE_INBOX_TOOL, ...[...OBSERVE_BROWSER_TOOLS].map(name => `mcp__trex_browser__${name}`)]);
const planningDeniedLine = (requestId: string): string => JSON.stringify({
  type: "control_response", response: { subtype: "success", request_id: requestId,
    response: { behavior: "deny", message: "Esta pestaña de planificación solo permite herramientas de lectura y preguntas; no puede conceder permisos de escritura o ejecución." } },
});
const commandSignature = (commands: unknown): string => JSON.stringify(parseClaudeCommands(commands)
  .sort((a, b) => a.name.localeCompare(b.name) || a.description.localeCompare(b.description)));

/** La pestaña planificadora espera la confirmación real del CLI antes de enviar trabajo. */
function initializationWait() {
  let ready!: (error?: string) => void;
  const promise = new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => ready("Claude no confirmó la inicialización de la conversación."), 15_000);
    ready = error => { window.clearTimeout(timer); if (error) reject(new Error(error)); else resolve(); };
  });
  void promise.catch(() => undefined);
  return { promise, ready };
}

/** La cancelación también termina la espera, aunque el arranque o el IPC sigan pendientes. */
async function whileCurrent<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let cancel!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    cancel = () => reject(signal.reason);
    signal.addEventListener("abort", cancel, { once: true });
  });
  try {
    const value = await Promise.race([work, cancelled]);
    signal.throwIfAborted();
    return value;
  } finally { signal.removeEventListener("abort", cancel); }
}

/** Peticiones propias cuya respuesta hay que atender: datos que guardar o un cambio que deshacer. */
type Control =
  | { kind: "initialize"; ready?: (error?: string) => void; modeRevision?: number }
  | { kind: "settings" | "context" | "usage" }
  | { kind: "skills"; done: (error?: string) => void }
  | { kind: "mode"; permissionMode: string | null; modeChoice: string | null; modeRevision?: number };

export function useClaudeChat(options: ChatSessionOptions): ChatSession {
  const { sessionId, cwd, command, args, shell, env, conversationId } = options;
  const planningOnly = useRef(options.planningOnly === true).current;
  const browserModeIntent = useRef(options.mode ?? (options.browser?.enabled ? claudeProfilePermissionMode(args, IS_WINDOWS && shell !== "wsl") : null));
  const browserBoundMode = useRef<ReturnType<typeof browserMode> | null>(null);
  const browserConnecting = useRef(false);
  const modeRevision = useRef(0);
  const plannerReducer: typeof chatReducer = (before, action) => {
    const next = chatReducer(before, action);
    return planningOnly ? { ...next, permissionMode: "plan", modeChoice: "plan" } : next;
  };
  const [state, dispatch] = useReducer(plannerReducer, null, () => initialChatState(planningOnly ? "plan" : options.mode, options.model, options.effort));
  const stateRef = useRef(state);
  stateRef.current = state;
  const callbacks = useRef(options);
  callbacks.current = options;
  const queue = useMessageQueue(options.queueId ?? sessionId);
  const inboxRequests = useRef(new InboxRequests());
  const isCurrentRef = useRef<(id: string) => boolean>(() => false);
  const pendingControlsRef = useRef(new Map<string, Control>());
  const plannerReadyRef = useRef<Promise<void> | null>(null);
  const plannerModeRef = useRef<unknown>(null);
  const processReadyRef = useRef<Promise<string | null> | null>(null);
  const readyProcessRef = useRef<string | null>(null);
  const startupRef = useRef<AbortController | null>(null);
  const localRequestsRef = useRef(new Map<AbortController, { id: string | null; onCancel?: () => void }>());
  const issuedMessagesRef = useRef(new Set<string>());
  const issuedCancellationRef = useRef<{ ids: Set<string>; promise: Promise<void>; release: () => void } | null>(null);
  const mountedRef = useRef(true);
  const interruptIssued = useCallback((id: string) => {
    if (!issuedCancellationRef.current) {
      let release!: () => void;
      const promise = new Promise<void>(resolve => { release = resolve; });
      issuedCancellationRef.current = { ids: new Set(), promise, release };
    }
    issuedCancellationRef.current.ids.add(id);
    dispatch({ type: "interruptSend", id });
  }, []);
  /** Cancelar es síncrono: no depende del render ni de una respuesta posterior del CLI. */
  const cancelLocalRequests = useCallback((except?: AbortController) => {
    for (const [request, { id, onCancel }] of localRequestsRef.current) {
      if (request === except) continue;
      if (id) {
        if (issuedMessagesRef.current.has(id)) interruptIssued(id);
        else dispatch({ type: "cancelSend", id });
      }
      onCancel?.();
      request.abort();
      localRequestsRef.current.delete(request);
    }
  }, [interruptIssued]);
  /** Al sustituir el proceso, sus terminales ya no pueden llegar a esta conversación. */
  const invalidateIssued = useCallback(() => {
    for (const id of issuedMessagesRef.current) dispatch({ type: "cancelSend", id });
    issuedMessagesRef.current.clear();
    issuedCancellationRef.current?.release();
    issuedCancellationRef.current = null;
  }, []);
  useEffect(() => {
    const pending = new Set(state.pendingMessageIds);
    for (const id of issuedMessagesRef.current) if (!pending.has(id)) issuedMessagesRef.current.delete(id);
    const cancellation = issuedCancellationRef.current;
    if (!cancellation) return;
    for (const id of cancellation.ids) if (!pending.has(id)) cancellation.ids.delete(id);
    if (!cancellation.ids.size) {
      cancellation.release();
      issuedCancellationRef.current = null;
    }
  }, [state.pendingMessageIds]);
  /** Tras empezar una conversación nueva, la de la pestaña ya no se reanuda. */
  const freshRef = useRef(false);
  const conversationOverrideRef = useRef(false);
  const editingRef = useRef(false);
  const skillsRequestRef = useRef<Promise<void> | null>(null);
  const commandsSignatureRef = useRef("");

  const writeRef = useRef<(line: string) => Promise<void>>(() => Promise.resolve());
  const writeOrReport = useCallback((line: string, procId?: string) => {
    const startup = startupRef.current;
    void (procId ? agentWrite(procId, line) : writeRef.current(line)).catch(error => {
      if (mountedRef.current && startupRef.current === startup && !startup?.signal.aborted) {
        dispatch({ type: "notice", id: localId(), tone: "error", text: formatError(error) });
      }
    });
  }, []);

  /** Petición de control al CLI; `pending` marca las que traen una respuesta que atender. */
  const control = useCallback((request: Record<string, unknown>, pending?: Control) => {
    const id = localId();
    if (pending) pendingControlsRef.current.set(id, pending.kind === "initialize" || pending.kind === "mode"
      ? { ...pending, modeRevision: modeRevision.current } : pending);
    writeOrReport(controlLine(id, request));
  }, [writeOrReport]);
  const refreshSettings = useCallback(() => control({ subtype: "get_settings" }, { kind: "settings" }), [control]);
  /** Lo mismo que mide `/context`; el CLI lo calcula al momento, sin llamar al modelo. */
  const refreshContext = useCallback(() => control({ subtype: "get_context_usage" }, { kind: "context" }), [control]);
  const refreshSkills = useCallback((): Promise<void> => {
    if (skillsRequestRef.current) return skillsRequestRef.current;
    const request = new Promise<void>((resolve, reject) => {
      const id = localId();
      const timer = window.setTimeout(() => done("Claude no respondió al cargar las skills."), 10_000);
      const done = (error?: string): void => {
        window.clearTimeout(timer);
        pendingControlsRef.current.delete(id);
        if (error) reject(new Error(error)); else resolve();
      };
      pendingControlsRef.current.set(id, { kind: "skills", done });
      void writeRef.current(controlLine(id, { subtype: "reload_skills" })).catch(error => done(formatError(error)));
    }).finally(() => { if (skillsRequestRef.current === request) skillsRequestRef.current = null; });
    skillsRequestRef.current = request;
    return request;
  }, []);
  /** Lo mismo que `/usage`: sesión de 5 horas, semana y uso extra de la cuenta. */
  const usageAtRef = useRef(0);
  const refreshUsage = useCallback((force = false) => {
    if (!force && Date.now() - usageAtRef.current < USAGE_INTERVAL_MS) return;
    usageAtRef.current = Date.now();
    control({ subtype: "get_usage" }, { kind: "usage" });
  }, [control]);

  const syncBrowserMode = useCallback((mode: unknown, procId: string): boolean => {
    if (planningOnly || readyProcessRef.current !== procId || !callbacks.current.browser?.enabled || typeof mode !== "string"
      || !["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk", "auto"].includes(mode)) return false;
    if (browserModeIntent.current !== mode) modeRevision.current++;
    browserModeIntent.current = mode;
    const next = browserMode(mode), bound = browserBoundMode.current;
    if (!bound || next === bound) return false;
    // An immutable grant must never outlive a change in native permissions.
    dispatch({ type: "mode", mode });
    startupRef.current?.abort(); processReadyRef.current = null; readyProcessRef.current = null;
    browserBoundMode.current = null;
    cancelLocalRequests(); invalidateIssued();
    void agentKill(procId).catch(() => undefined);
    dispatch({ type: "notice", id: localId(), tone: "info", text: "Claude cambió sus permisos. El siguiente envío reabrirá la sesión con el acceso de navegador correspondiente." });
    return true;
  }, [planningOnly, cancelLocalRequests, invalidateIssued]);

  const handleLine = useCallback((line: string, procId: string) => {
    let event: unknown;
    try { event = JSON.parse(line); } catch { return; /* ruido del shell antes del CLI */ }
    const message = event as { type?: string; subtype?: string; parent_tool_use_id?: unknown; request_id?: string;
      request?: { subtype?: string; tool_name?: unknown; input?: unknown };
      response?: { subtype?: string; request_id?: string; response?: Record<string, unknown>; error?: string } };
    const reply = message?.type === "control_response" ? message.response : undefined;
    const pending = reply?.request_id ? pendingControlsRef.current.get(reply.request_id) : undefined;
    if (reply?.request_id && pending) {
      pendingControlsRef.current.delete(reply.request_id);
      const data = reply.subtype === "success" ? reply.response ?? {} : {};
      const staleMode = callbacks.current.browser?.enabled && (pending.kind === "initialize" || pending.kind === "mode")
        && pending.modeRevision !== undefined && pending.modeRevision !== modeRevision.current;
      if (pending.kind === "mode" && staleMode) return;
      if (pending.kind === "initialize") {
        if (!planningOnly && browserBoundMode.current && reply.subtype === "success"
          && (typeof data.current_permission_mode !== "string" || !["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk", "auto"].includes(data.current_permission_mode))) {
          const reason = "Claude no confirmó los permisos del navegador. Actualiza Claude Code o desactiva el navegador para esta sesión.";
          pending.ready?.(reason);
          startupRef.current?.abort(); processReadyRef.current = null; readyProcessRef.current = null; browserBoundMode.current = null;
          cancelLocalRequests(); invalidateIssued();
          void agentKill(procId).catch(() => undefined);
          dispatch({ type: "notice", id: localId(), tone: "error", text: reason });
          return;
        }
        if (!staleMode && reply.subtype === "success" && syncBrowserMode(data.current_permission_mode, procId)) {
          pending.ready?.("Los permisos efectivos cambiaron. Vuelve a enviar para abrir la sesión con el acceso correcto.");
          return;
        }
        commandsSignatureRef.current = commandSignature(data.commands);
        dispatch({ type: "catalog", models: data.models, permissionMode: staleMode ? undefined : data.current_permission_mode, commands: data.commands, agents: data.agents,
          fastState: data.fast_mode_state });
        let error = reply.subtype === "success" ? undefined : reply.error ?? "Claude rechazó la reanudación.";
        if (planningOnly && !error) {
          plannerModeRef.current = data.current_permission_mode;
          try { assertClaudePlanningMode(data.current_permission_mode); } catch (reason) { error = formatError(reason); }
        }
        pending.ready?.(error);
      } else if (pending.kind === "settings") {
        const applied = (data.applied ?? {}) as Record<string, unknown>;
        dispatch({ type: "applied", model: applied.model, effort: applied.effort });
      } else if (pending.kind === "skills") {
        if (reply.subtype === "success") dispatch({ type: "skills", data: data.skills });
        pending.done(reply.subtype === "success" ? undefined : reply.error ?? "No se pudieron cargar las skills de Claude.");
      } else if (pending.kind === "context") {
        dispatch({ type: "context", data });
      } else if (pending.kind === "usage") {
        if (reply.subtype === "success") dispatch({ type: "plan", data });
      } else if (pending.kind === "mode" && reply.subtype !== "success") {
        browserModeIntent.current = pending.modeChoice ?? pending.permissionMode;
        const reason = reply.error ?? "";
        dispatch({ type: "modeRejected", permissionMode: pending.permissionMode, modeChoice: pending.modeChoice,
          message: /bypassPermissions|skip-permissions/.test(reason)
            ? "Esta sesión de Claude Code no admite «Permitir todo» (su perfil lo impide, por ejemplo con --restricted)."
            : `No se pudo cambiar el modo de permisos: ${reason || "Claude Code lo rechazó."}` });
      }
      return;
    }
    const reportedMode = record(event)?.permissionMode;
    if (!planningOnly && message.type === "system" && (message.subtype === "init" || message.subtype === "status")
      && syncBrowserMode(reportedMode, procId)) return;
    if (planningOnly && message.type === "system" && (message.subtype === "init" || message.subtype === "status") && typeof reportedMode === "string") {
      plannerModeRef.current = reportedMode;
      if (reportedMode !== "plan") {
        if (stateRef.current.pendingTurns > 0) writeOrReport(controlLine(localId(), { subtype: "interrupt" }));
        dispatch({ type: "notice", id: localId(), tone: "error", text: "Claude abandonó el modo plan; se ha bloqueado el envío de trabajo en esta pestaña." });
      }
    }
    const request = record(record(event)?.request);
    if (planningOnly && message.type === "control_request" && message.request_id
      && request?.subtype === "can_use_tool" && request.tool_name === "ExitPlanMode") {
      dispatch({ type: "line", event, now: Date.now() });
      dispatch({ type: "answer", id: message.request_id, allowed: false });
      writeOrReport(claudePlanningExitResponse(message.request_id, callbacks.current.planningInstruction));
      return;
    }
    if (planningOnly && message.type === "control_request" && message.request_id && request?.subtype === "can_use_tool"
      && (typeof request.tool_name !== "string" || !PLANNING_READ_TOOLS.has(request.tool_name)
        && !(callbacks.current.team && TEAM_TOOLS.some(name => request.tool_name === `mcp__${TEAM_SERVER}__${name}`)))) {
      dispatch({ type: "line", event, now: Date.now() });
      dispatch({ type: "answer", id: message.request_id, allowed: false });
      writeOrReport(planningDeniedLine(message.request_id));
      return;
    }
    if (message.type === "control_request" && message.request_id && request?.subtype === "mcp_message" && request.server_name === INBOX_SERVER) {
      void (async () => {
        const reply = await claudeInboxReply(message.request_id!, request,
          () => inboxRequests.current.read(`${procId}:${message.request_id}`, queue.client.read));
        if (!reply || !isCurrentRef.current(procId)) return;
        await writeRef.current(reply.line);
        if (!isCurrentRef.current(procId)) return;
        if (reply.receipt) {
          dispatch({ type: "queuedRead", messages: reply.receipt.messages });
          await queue.client.ack(reply.receipt.id, () => isCurrentRef.current(procId));
        }
      })().catch(error => dispatch({ type: "notice", id: localId(), tone: "error", text: `La entrega de la cola quedó pendiente: ${formatError(error)}` }));
      return;
    }
    // Reading trex's own inbox needs no permission to execute external tools.
    if (message.type === "control_request" && message.request?.subtype === "can_use_tool" && message.request_id && message.request.tool_name === CLAUDE_INBOX_TOOL) {
      writeOrReport(permissionLine(message.request_id, true, record(message.request.input) ?? {}));
      return;
    }
    // Con «Permitir todo», lo que el CLI aún consulte se acepta sin mostrar la tarjeta.
    if (message?.type === "control_request" && message.request?.subtype === "can_use_tool" && message.request_id
      && !planningOnly && allowsAll(stateRef.current.permissionMode) && !needsAnswer(String(message.request.tool_name ?? ""))) {
      writeOrReport(permissionLine(message.request_id, true, record(message.request.input) ?? {}));
      return;
    }
    // Peticiones del CLI que el chat aún no atiende: se rechazan para no bloquearlo.
    if (message?.type === "control_request" && message.request?.subtype !== "can_use_tool" && message.request_id) {
      writeOrReport(controlErrorLine(message.request_id, "trex no admite esta petición."));
      return;
    }
    dispatch({ type: "line", event, now: Date.now() });
    if (message?.type === "system" && message.subtype === "commands_changed") {
      const signature = commandSignature(record(event)?.commands);
      if (signature !== commandsSignatureRef.current) {
        commandsSignatureRef.current = signature;
        void refreshSkills().catch(() => undefined);
      }
    }
    // Al terminar cada respuesta se vuelve a medir el contexto, con el desglose por partes, y el uso del plan.
    if (message?.type === "result" && typeof message.parent_tool_use_id !== "string") {
      refreshContext();
      refreshUsage();
    }
  }, [planningOnly, writeOrReport, refreshContext, refreshUsage, refreshSkills, queue.client, syncBrowserMode]);

  const agent = useAgentProcess(sessionId, {
    onLine: handleLine,
    onStderr: line => dispatch({ type: "stderr", line }),
    onExit: code => {
      startupRef.current?.abort();
      for (const pending of pendingControlsRef.current.values()) {
        if (pending.kind === "initialize") pending.ready?.("Claude se cerró antes de reanudar la conversación.");
        else if (pending.kind === "skills") pending.done("La sesión de Claude se cerró.");
      }
      pendingControlsRef.current.clear();
      skillsRequestRef.current = null;
      dispatch({ type: "exit", code });
      cancelLocalRequests();
      invalidateIssued();
      processReadyRef.current = null;
      readyProcessRef.current = null;
      callbacks.current.onExit(sessionId, code);
    },
  }, "claude");
  writeRef.current = agent.write;
  isCurrentRef.current = agent.isCurrent;

  const start = useCallback(async (fresh = false, caller?: AbortController): Promise<void> => {
    if (!mountedRef.current) return;
    cancelLocalRequests(caller);
    invalidateIssued();
    startupRef.current?.abort();
    const startup = new AbortController();
    startupRef.current = startup;
    readyProcessRef.current = null;
    let initialization = planningOnly ? initializationWait() : null;
    if (planningOnly) { plannerModeRef.current = null; plannerReadyRef.current = initialization!.promise; }
    inboxRequests.current.clear();
    const current = stateRef.current;
    const resumeId = fresh ? null : current.sessionId ?? (freshRef.current ? null : callbacks.current.conversationId);
    for (const pending of pendingControlsRef.current.values()) {
      if (pending.kind === "skills") pending.done("La sesión de Claude se está reiniciando.");
      else if (pending.kind === "initialize") pending.ready?.("La sesión de Claude se está reiniciando.");
    }
    pendingControlsRef.current.clear();
    skillsRequestRef.current = null;
    const ready = (async (): Promise<string | null> => {
      try {
        startup.signal.throwIfAborted();
        let browser = null;
        browserConnecting.current = callbacks.current.browser?.enabled === true;
        try {
          browser = callbacks.current.browser?.enabled ? await whileCurrent(connectBrowser(callbacks.current.browser, cwd, browserModeIntent.current ?? current.modeChoice, planningOnly, shell,
            message => dispatch({ type: "notice", id: localId(), tone: "warn", text: message })), startup.signal) : null;
        } finally { if (startupRef.current === startup) browserConnecting.current = false; }
        startup.signal.throwIfAborted();
        const chosenMode = planningOnly ? "plan" : browser ? browserModeIntent.current ?? current.modeChoice : current.modeChoice;
        const profileArgs = planningOnly || (browser && chosenMode) ? claudePlanningArgs(args, IS_WINDOWS && shell !== "wsl", conversationOverrideRef.current)
          : conversationOverrideRef.current ? withoutConversationArgs(args) : args;
        const flags = claudeChatFlags(profileArgs, resumeId, { model: current.modelChoice, effort: current.effortChoice, mode: chosenMode });
        if (browser && chosenMode && ["default", "acceptEdits", "plan", "dontAsk", "auto", "bypassPermissions"].includes(chosenMode)
          && !flags.includes("--permission-mode") && !(chosenMode === "bypassPermissions" && /(^|\s)--restricted(\s|=|$)/.test(profileArgs ?? ""))) flags.push("--permission-mode", chosenMode);
        const teamConfig = callbacks.current.team ? browserConfigForShell(await agentTeamMcpConfig(callbacks.current.team), shell) : null;
        startup.signal.throwIfAborted();
        if (browser || teamConfig) flags.push("--mcp-config", JSON.stringify({ mcpServers: {
          ...(browser ? { trex_browser: browser } : {}), ...(teamConfig ? { trex_team: { command: teamConfig.command, args: teamConfig.args, timeout: 1900000 } } : {}),
        } }));
        if (teamConfig) flags.push("--allowedTools", TEAM_TOOLS.map(name => `mcp__${TEAM_SERVER}__${name}`).join(","));
        browserBoundMode.current = browser ? browserMode(chosenMode, planningOnly) : null;
        if (browser) initialization ??= initializationWait();
        const procId = await whileCurrent(agent.spawn({
          cwd, command: command?.trim() || "claude", profileArgs, shell, env: teamConfig ? { ...env, CLAUDE_AUTO_BACKGROUND_TASKS: "0" } : env,
          flags: planningOnly ? claudePlanningFlags(flags) : flags,
        }), startup.signal);
        if (!procId) { initialization?.ready("El arranque de Claude fue sustituido."); return null; }
        startup.signal.throwIfAborted();
        readyProcessRef.current = procId;
        dispatch({ type: "spawned" });
        callbacks.current.onRunning(sessionId);
        // Modelos disponibles, modelo/esfuerzo en uso y contexto (el de la conversación reanudada), antes del primer mensaje.
        control(claudeInboxInitialize, { kind: "initialize", ready: initialization?.ready });
        // La velocidad elegida no tiene opción de lanzamiento propia: se aplica igual que al cambiarla.
        if (current.fastChoice !== null) control({ subtype: "apply_flag_settings", settings: { fastMode: current.fastChoice } });
        refreshSettings();
        refreshContext();
        refreshUsage(true);
        void refreshSkills().catch(() => undefined);
        if (initialization) await whileCurrent(initialization.promise, startup.signal);
        startup.signal.throwIfAborted();
        return procId;
      } catch (error) {
        initialization?.ready(formatError(error));
        if (!startup.signal.aborted) dispatch({ type: "spawnFailed", message: `No se pudo iniciar Claude Code: ${formatError(error)}` });
        return null;
      }
    })();
    processReadyRef.current = ready;
    const procId = await ready;
    if (!procId && processReadyRef.current === ready) processReadyRef.current = null;
  }, [agent, sessionId, cwd, command, args, shell, env, planningOnly, control, refreshSettings, refreshContext, refreshUsage, refreshSkills, cancelLocalRequests, invalidateIssued]);

  // Arranque al mostrarse por primera vez: historial guardado (si se recupera una conversación) y proceso.
  const startedRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      cancelLocalRequests();
      invalidateIssued();
      startupRef.current?.abort();
      readyProcessRef.current = null;
    };
  }, [cancelLocalRequests, invalidateIssued]);
  useEffect(() => {
    if (startedRef.current || !options.visible) return;
    startedRef.current = true;
    void start();
    const startup = startupRef.current;
    const isCurrent = () => mountedRef.current && startupRef.current === startup && !startup?.signal.aborted;
    // El historial llega aunque la pestaña se oculte mientras se lee.
    if (conversationId) {
      void readConversation(env?.CLAUDE_CONFIG_DIR ?? "", conversationId)
        .then(entries => { if (isCurrent()) dispatch({ type: "history", entries }); })
        .catch(error => { if (isCurrent()) dispatch({ type: "notice", id: localId(), tone: "warn", text: `No se pudo mostrar el historial: ${formatError(error)}` }); });
    }
    // Solo la primera vez que se ve: el resto de cambios llegan por refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options.visible]);

  const send = async (text: string, images: OutgoingImage[], previews: string[], display?: string): Promise<boolean> => {
    if (!mountedRef.current) return false;
    const id = crypto.randomUUID();
    const request = new AbortController();
    localRequestsRef.current.set(request, { id });
    try {
      const cancellation = issuedCancellationRef.current;
      if (cancellation) await whileCurrent(cancellation.promise, request.signal);
      request.signal.throwIfAborted();
      dispatch({ type: "send", id, text: display ?? text, previews, now: Date.now() });
      if (!processReadyRef.current) void start(false, request);
      const ready = processReadyRef.current!;
      const plannerReady = plannerReadyRef.current;
      const procId = await whileCurrent(ready, request.signal);
      if (planningOnly && plannerReady) {
        await whileCurrent(plannerReady, request.signal);
        assertClaudePlanningMode(plannerModeRef.current);
      }
      request.signal.throwIfAborted();
      if (!mountedRef.current || !procId || !agent.isCurrent(procId)) throw new Error("La sesión de Claude no está activa.");
      // El id queda fijado antes del IPC; agent.write esperaría de nuevo un arranque mutable.
      issuedMessagesRef.current.add(id);
      await whileCurrent(agentWrite(procId, userMessageLine(claudeSkillText(text, stateRef.current.skills), images, id)), request.signal);
      request.signal.throwIfAborted();
      return true;
    } catch (error) {
      if (request.signal.aborted) dispatch({ type: issuedMessagesRef.current.has(id) ? "interruptSend" : "cancelSend", id });
      else dispatch({ type: "sendFailed", id, message: `No se pudo enviar el mensaje: ${formatError(error)}` });
      return false;
    } finally { localRequestsRef.current.delete(request); }
  };

  const edit: ChatSession["edit"] = async (id, text, images, previews) => {
    const current = stateRef.current;
    if (current.pendingTurns > 0 || editingRef.current) throw new Error("Espera a que termine la respuesta para editar el mensaje.");
    if (!current.sessionId || !current.items.some(item => item.kind === "user" && item.id === id)) throw new Error("No se encontró el mensaje en esta conversación.");
    if (!mountedRef.current) return;
    cancelLocalRequests();
    const request = new AbortController();
    editingRef.current = true;
    const previousReady = processReadyRef.current;
    let resolveReady!: (procId: string | null) => void;
    const editedReady = new Promise<string | null>(resolve => { resolveReady = resolve; });
    processReadyRef.current = editedReady;
    let replacingProcess = false;
    let messageId: string | null = null;
    localRequestsRef.current.set(request, { id: null, onCancel: () => {
      if (processReadyRef.current === editedReady) processReadyRef.current = replacingProcess ? null : previousReady;
      resolveReady(null);
    } });
    let initialization: ReturnType<typeof initializationWait> | null = null;
    try {
      const point = await whileCurrent(claudeRewindPoint(env?.CLAUDE_CONFIG_DIR ?? "", current.sessionId, id), request.signal);
      request.signal.throwIfAborted();
      const newSessionId = crypto.randomUUID();
      const browser = callbacks.current.browser?.enabled ? await whileCurrent(connectBrowser(callbacks.current.browser, cwd, browserModeIntent.current ?? current.modeChoice, planningOnly, shell,
        message => dispatch({ type: "notice", id: localId(), tone: "warn", text: message })), request.signal) : null;
      request.signal.throwIfAborted();
      const chosenMode = planningOnly ? "plan" : browser ? browserModeIntent.current ?? current.modeChoice : current.modeChoice;
      const profileArgs = planningOnly || (browser && chosenMode) ? claudePlanningArgs(args, IS_WINDOWS && shell !== "wsl", true) : withoutConversationArgs(args);
      const chatFlags = claudeChatFlags(profileArgs, point ? current.sessionId : null,
        { model: current.modelChoice, effort: current.effortChoice, mode: chosenMode });
      const flags = planningOnly ? claudePlanningFlags(chatFlags) : chatFlags;
      if (browser && chosenMode && ["default", "acceptEdits", "plan", "dontAsk", "auto", "bypassPermissions"].includes(chosenMode)
        && !flags.includes("--permission-mode") && !(chosenMode === "bypassPermissions" && /(^|\s)--restricted(\s|=|$)/.test(profileArgs ?? ""))) flags.push("--permission-mode", chosenMode);
      if (browser) flags.push("--mcp-config", JSON.stringify({ mcpServers: { trex_browser: browser } }));
      browserBoundMode.current = browser ? browserMode(chosenMode, planningOnly) : null;
      if (point) flags.push("--resume-session-at", point, "--fork-session");
      flags.push("--session-id", newSessionId);
      for (const pending of pendingControlsRef.current.values()) {
        if (pending.kind === "skills") pending.done("La sesión de Claude se está reiniciando.");
        else if (pending.kind === "initialize") pending.ready?.("La sesión de Claude se está reiniciando.");
      }
      pendingControlsRef.current.clear();
      skillsRequestRef.current = null;
      if (planningOnly) {
        initialization = initializationWait();
        plannerModeRef.current = null;
        plannerReadyRef.current = initialization.promise;
      }
      replacingProcess = true;
      invalidateIssued();
      startupRef.current?.abort();
      startupRef.current = request;
      readyProcessRef.current = null;
      const procId = await whileCurrent(agent.spawn({ cwd, command: command?.trim() || "claude", profileArgs, flags, shell, env }), request.signal);
      if (!procId) throw new Error("La sesión se cerró mientras se preparaba la edición.");
      request.signal.throwIfAborted();
      readyProcessRef.current = procId;
      // El prefijo solo se sustituye cuando el CLI confirma que aceptó la reanudación.
      initialization ??= initializationWait();
      const waiting = initialization;
      const requestId = localId();
      pendingControlsRef.current.set(requestId, { kind: "initialize", ready: waiting.ready, modeRevision: modeRevision.current });
      try {
        request.signal.throwIfAborted();
        if (!agent.isCurrent(procId)) throw new Error("La sesión de Claude no está activa.");
        void agentWrite(procId, controlLine(requestId, claudeInboxInitialize)).catch(error => waiting.ready(formatError(error)));
        await whileCurrent(waiting.promise, request.signal);
      } finally { pendingControlsRef.current.delete(requestId); }
      request.signal.throwIfAborted();
      if (planningOnly) assertClaudePlanningMode(plannerModeRef.current);
      resolveReady(procId);
      conversationOverrideRef.current = true;
      freshRef.current = true;
      dispatch({ type: "rewind", id, sessionId: newSessionId });
      dispatch({ type: "spawned" });
      callbacks.current.onRunning(sessionId);
      if (current.fastChoice !== null) control({ subtype: "apply_flag_settings", settings: { fastMode: current.fastChoice } });
      refreshSettings();
      refreshUsage(true);
      messageId = crypto.randomUUID();
      localRequestsRef.current.get(request)!.id = messageId;
      dispatch({ type: "send", id: messageId, text, previews, now: Date.now() });
      request.signal.throwIfAborted();
      if (!agent.isCurrent(procId)) throw new Error("La sesión de Claude no está activa.");
      issuedMessagesRef.current.add(messageId);
      await whileCurrent(agentWrite(procId, userMessageLine(claudeSkillText(text, current.skills), images, messageId)), request.signal);
      request.signal.throwIfAborted();
    } catch (error) {
      initialization?.ready(formatError(error));
      if (processReadyRef.current === editedReady) processReadyRef.current = replacingProcess ? null : previousReady;
      if (request.signal.aborted) {
        if (messageId) dispatch({ type: issuedMessagesRef.current.has(messageId) ? "interruptSend" : "cancelSend", id: messageId });
        return;
      }
      if (messageId) dispatch({ type: "sendFailed", id: messageId, message: `No se pudo enviar la edición: ${formatError(error)}` });
      throw error;
    } finally {
      resolveReady(null);
      localRequestsRef.current.delete(request);
      editingRef.current = false;
    }
  };

  const interrupt = (): void => {
    const hadLocalRequests = localRequestsRef.current.size > 0;
    for (const id of issuedMessagesRef.current) interruptIssued(id);
    cancelLocalRequests();
    const current = stateRef.current;
    const procId = readyProcessRef.current;
    if ((current.pendingTurns > 0 || hadLocalRequests || issuedMessagesRef.current.size > 0) && procId && agent.isCurrent(procId)) {
      writeOrReport(controlLine(localId(), { subtype: "interrupt" }), procId);
    }
  };

  const answer = (item: PermissionItem, allowed: boolean, remember: boolean, choices?: QuestionChoice[]): void => {
    if (planningOnly && item.toolName === "ExitPlanMode") {
      dispatch({ type: "answer", id: item.id, allowed: false });
      writeOrReport(claudePlanningExitResponse(item.id, callbacks.current.planningInstruction));
      return;
    }
    if (planningOnly && !PLANNING_READ_TOOLS.has(item.toolName)
      && !(callbacks.current.team && TEAM_TOOLS.some(name => item.toolName === "mcp__" + TEAM_SERVER + "__" + name))) {
      dispatch({ type: "answer", id: item.id, allowed: false });
      writeOrReport(planningDeniedLine(item.id));
      return;
    }
    // Omitir unas preguntas no es denegar un permiso: Claude sigue a su criterio sin respuestas.
    if (item.toolName === "AskUserQuestion") {
      dispatch({ type: "answer", id: item.id, allowed: true });
      writeOrReport(permissionLine(item.id, true, answeredInput(item.input, allowed ? choices ?? [] : [])));
      return;
    }
    dispatch({ type: "answer", id: item.id, allowed });
    writeOrReport(permissionLine(item.id, allowed, item.input, remember && !planningOnly ? item.suggestions : []));
  };

  const notice = (tone: "info" | "warn" | "error", text: string): void => dispatch({ type: "notice", id: localId(), tone, text });

  return {
    provider: "claude",
    terminals: agent.terminals,
    state,
    queue,
    start: () => start(),
    send,
    sendNow: send,
    edit,
    // El CLI no cambia de sesión en mitad del proceso: se lanza otro sin reanudar nada.
    reset: () => {
      freshRef.current = true;
      conversationOverrideRef.current = true;
      dispatch({ type: "reset" });
      void start(true);
    },
    // Los comandos de Claude Code los resuelve el propio CLI al recibirlos como mensaje.
    runCommand: () => false,
    refreshSkills,
    notice,
    interrupt,
    answer,
    setMode: mode => {
      if (planningOnly) return;
      const before = stateRef.current;
      const reconnect = (browserBoundMode.current !== null || browserConnecting.current)
        && (browserBoundMode.current ?? browserMode(browserModeIntent.current ?? before.modeChoice)) !== browserMode(mode);
      if (reconnect && (before.pendingTurns > 0 || localRequestsRef.current.size > 0 || issuedMessagesRef.current.size > 0)) {
        notice("info", "Detén la respuesta antes de cambiar los permisos del navegador."); return;
      }
      modeRevision.current++;
      browserModeIntent.current = mode;
      if (reconnect) {
        startupRef.current?.abort(); processReadyRef.current = null; readyProcessRef.current = null;
        dispatch({ type: "mode", mode });
        return;
      }
      dispatch({ type: "mode", mode });
      control({ subtype: "set_permission_mode", mode }, { kind: "mode", permissionMode: before.permissionMode, modeChoice: before.modeChoice });
      // Lo que estaba esperando permiso se acepta al pasar a «Permitir todo».
      if (allowsAll(mode)) for (const item of autoAllowed(before.items)) answer(item, true, false);
    },
    // Cambiar de modelo puede cambiar también el esfuerzo: después se leen los valores reales.
    setModel: model => {
      dispatch({ type: "model", model });
      control({ subtype: "set_model", model });
      refreshSettings();
    },
    setEffort: effort => {
      dispatch({ type: "effort", effort });
      control({ subtype: "apply_flag_settings", settings: { effortLevel: effort } });
      refreshSettings();
    },
    // En modo SDK, Claude Code solo usa la velocidad rápida si se pide en los ajustes de la sesión.
    // Si no está disponible para la cuenta, el resultado de la siguiente respuesta lo dice.
    setFast: fast => {
      dispatch({ type: "fast", fast });
      control({ subtype: "apply_flag_settings", settings: { fastMode: fast } });
    },
  };
}
