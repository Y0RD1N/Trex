import { connectBrowser } from "../browserConnection";
import { agentTeamMcpConfig, trexDesktopMcpConfig } from "../api";
import { A11Y_ACTION_TOOLS, A11Y_KEYBOARD_TOOLS, A11Y_READ_TOOLS, A11Y_SERVER, accessibilityServer } from "../accessibility";
import { browserConfigForShell, browserEnv, BROWSER_INSTRUCTIONS, BROWSER_TOKEN_ENV, isBrowserHttp } from "../browser";
import { browserMode, type BrowserMode } from "../browser";
/**
 * Sesión de Codex como chat: `codex app-server` por JSON-RPC.
 *
 * Al arrancar se presenta, pide el catálogo de modelos y abre un hilo nuevo o
 * reanuda la conversación de la pestaña (con su historial). Cada mensaje es un
 * turno; uno enviado mientras Codex trabaja se suma al turno en curso.
 */
import { useCallback, useEffect, useReducer, useRef } from "react";
import { agentWrite, codexContextWindows, formatError, messageQueueMcpConfig } from "../api";
import {
  allowsAll, autoAllowed, fastSpeed, initialChatState, record, text, type Json, type OutgoingImage, type PermissionItem, type QuestionChoice,
} from "../chatState";
import {
  INIT_PROMPT, OPT_OUT_NOTIFICATIONS, answerResult, autoApproval, codexLaunch, codexReducer, errorLine, inboxInput, notificationLine, requestLine,
  resultLine, turnOverrides, userInput,
} from "../codexChat";
import { mentionedSkills } from "../chatCommands";
import { FILE_SHARING_INSTRUCTIONS } from "../sharedFiles";
import { PEER_INSTRUCTIONS } from "../coordination";
import { questionInstructions } from "../chatQuestions";
import { localId, useAgentProcess, type ChatSession, type ChatSessionOptions } from "./chatSession";
import { useMessageQueue } from "./useMessageQueue";
import { codexInboxContent, deliverInbox, InboxRequests, INBOX_INSTRUCTIONS, INBOX_TOOL, INBOX_WAKE, inboxConfigForShell } from "../messageQueue";
import { codexInboxReceiptId } from "../inboxProtocol";
import { assertCodexPlanningThread, codexPlanningThread, codexPlanningTurn } from "../workflowSafety";
import { taskInstructions } from "../chatTasks";
import { detectedIntegrations, integrationContext, integrationInstructions, DESKTOP_READ_TOOLS, DESKTOP_INPUT_TOOLS, type IntegrationContext } from "../integrations";
import { withChatTimes } from "../chatTimes";
import { codexAutoCompact, codexAutoCompactFlags } from "../autoCompact";
const timedCodexReducer = withChatTimes(codexReducer);

/** Peticiones de Codex que el chat responde con una tarjeta. */
const ANSWERED_IN_CHAT = new Set([
  "item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/tool/requestUserInput", "item/permissions/requestApproval",
]);
/** Turnos de la conversación recuperada que se muestran al abrirla. */
const HISTORY_TURNS = 40;
const CHAT_INSTRUCTIONS = `${FILE_SHARING_INSTRUCTIONS} ${questionInstructions("codex")} ${INBOX_INSTRUCTIONS} ${taskInstructions("codex")} ${PEER_INSTRUCTIONS}`;

/** Approval must not weaken the planner's sandbox, even for a session grant. */
function planningApprovalAllowed(method: string | undefined, input: Json): boolean {
  if (method === "item/tool/requestUserInput") return true;
  // commandActions are best-effort display hints, not proof that unrestricted execution is read-only.
  if (method !== "item/permissions/requestApproval") return false;
  const permissions = record(input.permissions);
  const onlyKeys = (value: Json, keys: string[]): boolean => Object.keys(value).every(key => keys.includes(key));
  if (!permissions || !onlyKeys(permissions, ["fileSystem", "network"])) return false;
  if (permissions.network != null) {
    const network = record(permissions.network);
    if (!network || !onlyKeys(network, ["enabled"]) || (network.enabled != null && network.enabled !== false)) return false;
  }
  if (permissions.fileSystem != null) {
    const files = record(permissions.fileSystem);
    if (!files || !onlyKeys(files, ["read", "write", "entries", "globScanMaxDepth"])) return false;
    if (files.read != null && (!Array.isArray(files.read) || !files.read.every(path => typeof path === "string"))) return false;
    if (files.write != null && (!Array.isArray(files.write) || files.write.length > 0)) return false;
    if (files.entries != null && (!Array.isArray(files.entries) || !files.entries.every(value => {
      const entry = record(value);
      return entry && onlyKeys(entry, ["path", "access"]) && (entry.access === "read" || entry.access === "deny");
    }))) return false;
    if (files.globScanMaxDepth != null && (typeof files.globScanMaxDepth !== "number" || !Number.isSafeInteger(files.globScanMaxDepth) || files.globScanMaxDepth < 0)) return false;
  }
  return true;
}

async function untilCancelled<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  signal.throwIfAborted();
  let cancel!: () => void;
  const cancelled = new Promise<never>((_, reject) => { cancel = () => reject(new DOMException("Envío cancelado.", "AbortError")); });
  signal.addEventListener("abort", cancel, { once: true });
  try { return await Promise.race([work, cancelled]); }
  finally { signal.removeEventListener("abort", cancel); }
}

type Pending = { resolve: (result: unknown) => void; reject: (error: Error) => void };
class CodexRequestRejected extends Error {}
class CodexBrowserPermissionsError extends Error {}
class CodexBrowserConnectionError extends CodexBrowserPermissionsError {}
class CodexBrowserModeMismatch extends CodexBrowserPermissionsError {
  constructor(readonly mode: BrowserMode) { super("Los permisos confirmados de Codex requieren reconectar el navegador."); }
}

type NativePermissions = { sandbox: "read-only" | "workspace-write" | "danger-full-access"; approvalPolicy: string };
/** Read the native acknowledgement, never infer confirmation from requested overrides. */
function nativePermissions(response: Json): NativePermissions | null {
  const sandbox = response.sandboxPolicy ?? response.sandbox;
  const type = typeof sandbox === "string" ? sandbox : record(sandbox)?.type;
  const normalized = type === "readOnly" || type === "read-only" ? "read-only"
    : type === "workspaceWrite" || type === "workspace-write" ? "workspace-write"
      : type === "dangerFullAccess" || type === "danger-full-access" ? "danger-full-access" : null;
  const approvalPolicy = response.approvalPolicy;
  return normalized && typeof approvalPolicy === "string" && ["untrusted", "on-failure", "on-request", "never"].includes(approvalPolicy)
    ? { sandbox: normalized, approvalPolicy } : null;
}

function selectedPermissions(mode: string): NativePermissions {
  return { sandbox: mode === "read-only" ? "read-only" : mode === "full" ? "danger-full-access" : "workspace-write",
    approvalPolicy: mode === "full" ? "never" : "on-request" };
}

const sandboxBrowserMode = (sandbox: unknown): BrowserMode => sandbox === "read-only" ? "observe" : sandbox === "danger-full-access" ? "full" : "qa";
const browserChoice = (mode: BrowserMode): string => mode === "observe" ? "read-only" : mode === "full" ? "full" : "auto";

export function useCodexChat(options: ChatSessionOptions): ChatSession {
  const { sessionId, cwd, command, args, shell, env } = options;
  const planningOnly = useRef(options.planningOnly === true).current;
  const plannerReducer: typeof codexReducer = (before, action) => {
    const next = timedCodexReducer(before, action);
    return planningOnly ? { ...next, permissionMode: "plan", modeChoice: "plan" } : next;
  };
  const [state, dispatch] = useReducer(plannerReducer, null, () => initialChatState(planningOnly ? "plan" : options.mode, options.model, options.effort, options.fast));
  const stateRef = useRef(state);
  stateRef.current = state;
  const callbacks = useRef(options);
  callbacks.current = options;
  // Umbral de resumen automático con el que arrancó el proceso en curso.
  const autoCompactAt = useRef<number | null>(null);
  const queue = useMessageQueue(options.queueId ?? sessionId);
  const inboxRequests = useRef(new InboxRequests());
  const inboxConfigRef = useRef<Json>({});
  const availableRef = useRef<IntegrationContext["available"]>(null);
  /** Browser guidance only when this process really attached trex_browser (it also enters via integrations). */
  const browserAttached = (): boolean => inboxConfigRef.current["mcp_servers.trex_browser.enabled"] === true;
  const a11yAttached = (): boolean => inboxConfigRef.current[`mcp_servers.${A11Y_SERVER}.enabled`] === true;
  const chatInstructions = () => [CHAT_INSTRUCTIONS, integrationInstructions("codex",
    integrationContext(callbacks.current, { browser: browserAttached(), available: availableRef.current, a11y: a11yAttached() }))].filter(Boolean).join(" ");
  const isCurrentRef = useRef<(id: string) => boolean>(() => false);

  const nextIdRef = useRef(1);
  const pendingRef = useRef(new Map<number, Pending>());
  /** Hilo listo para recibir turnos (se resuelve tras abrirlo o reanudarlo). */
  const threadRef = useRef<Promise<string> | null>(null);
  const activeThreadRef = useRef<string | null>(null);
  /** Identidad confirmada para reinicios, independiente del siguiente render. */
  const resumeThreadRef = useRef<string | null>(null);
  /** El modelo confirmado por start/resume/fork, disponible incluso antes del siguiente render. */
  const threadModelRef = useRef<string | null>(null);
  const turnIdRef = useRef<string | null>(null);
  const completedTurnsRef = useRef(new Set<string>());
  const stopRequestedRef = useRef(false);
  const stoppedTurnRef = useRef<string | null>(null);
  const stoppedRequestsRef = useRef(new Set<string>());
  /** El hilo ya se abrió en esta pestaña: al reanudar no se vuelve a pintar su historial. */
  const historyLoadedRef = useRef(false);
  /** Tras empezar una conversación nueva, la de la pestaña ya no se reanuda. */
  const freshRef = useRef(false);
  const editingRef = useRef(false);
  const deliveryTailRef = useRef<Promise<unknown>>(Promise.resolve());
  const deliveryEpochRef = useRef(0);
  const mountedRef = useRef(true);
  const startupEpochRef = useRef(0);
  /** Reset puede abrir otro hilo sin cambiar el proceso: invalida sus respuestas anteriores. */
  const threadGenerationRef = useRef(0);
  const processReadyRef = useRef<Promise<void> | null>(null);
  const readyProcessRef = useRef<string | null>(null);
  /** The immutable grant actually attached to this process, including an unfinished preflight. */
  const browserBindingRef = useRef<{ mode: BrowserMode; pending: boolean } | null>(null);
  const browserThreadRef = useRef<{ id: string; process: string | null; generation: number } | null>(null);
  const submissionsRef = useRef(new Map<AbortController, { id: string; issued: boolean; generation: number | null }>());
  const cancelDeferred = (): void => { for (const [controller, entry] of submissionsRef.current) if (!entry.issued) controller.abort(); };
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      startupEpochRef.current++;
      threadGenerationRef.current++;
      deliveryEpochRef.current++;
      readyProcessRef.current = null;
      processReadyRef.current = null;
      activeThreadRef.current = null;
      browserBindingRef.current = null;
      browserThreadRef.current = null;
      cancelDeferred();
    };
  }, []);
  /** Modo, modelo, esfuerzo y velocidad elegidos: se leen al empezar cada turno, sin esperar al render. */
  const choicesRef = useRef<{ mode: string | null; model: string | null; effort: string | null; fast: boolean | null }>({
    mode: planningOnly ? "plan" : options.mode, model: state.modelChoice, effort: state.effortChoice, fast: state.fastChoice });
  const writeRef = useRef<(line: string) => Promise<void>>(() => Promise.resolve());

  const notice = useCallback((tone: "info" | "warn" | "error", text: string) => dispatch({ type: "notice", id: localId(), tone, text }), []);
  const writeOrReport = useCallback((line: string) => {
    void writeRef.current(line).catch(error => notice("error", formatError(error)));
  }, [notice]);

  const request = useCallback(<T = Json>(method: string, params: unknown, procId?: string): Promise<T> => new Promise<T>((resolve, reject) => {
    if (!mountedRef.current || (procId && (readyProcessRef.current !== procId || !isCurrentRef.current(procId)))) {
      reject(new DOMException("Envío cancelado.", "AbortError"));
      return;
    }
    const id = nextIdRef.current++;
    const pending: Pending = { resolve: result => resolve(result as T), reject };
    pendingRef.current.set(id, pending);
    const line = requestLine(id, method, params);
    (procId ? agentWrite(procId, line) : writeRef.current(line)).catch(error => {
      if (pendingRef.current.get(id) === pending) pendingRef.current.delete(id);
      reject(error instanceof Error ? error : new Error(formatError(error)));
    });
  }), []);
  const readSkills = useCallback(async (forceReload = false): Promise<void> => {
    const result = await request<{ data?: unknown }>("skills/list", { cwds: [cwd], forceReload });
    dispatch({ type: "skills", data: result?.data });
  }, [request, cwd]);
  const refreshSkills = useCallback(async (): Promise<void> => {
    if (threadRef.current) await threadRef.current;
    await readSkills(true);
  }, [readSkills]);

  const rejectPending = useCallback((reason: string) => {
    for (const pending of pendingRef.current.values()) pending.reject(new Error(reason));
    pendingRef.current.clear();
  }, []);

  /** Detiene el turno en cuanto se conoce su id. */
  const stopTurn = useCallback(async () => {
    const turnId = turnIdRef.current, threadId = activeThreadRef.current ?? stateRef.current.sessionId;
    if (!turnId || !threadId) { stopRequestedRef.current = true; return; }
    stopRequestedRef.current = true;
    stoppedTurnRef.current = turnId;
    await request("turn/interrupt", { threadId, turnId }, readyProcessRef.current ?? undefined).catch(error => notice("error", formatError(error)));
  }, [request, notice]);

  const turnKnown = useCallback((turnId: string) => {
    if (completedTurnsRef.current.has(turnId)) return;
    turnIdRef.current = turnId;
    dispatch({ type: "turnStarted", turnId });
    if (stopRequestedRef.current) void stopTurn();
  }, [stopTurn]);

  const handleLine = useCallback((line: string, procId: string) => {
    let message: Json;
    try { message = JSON.parse(line) as Json; } catch { return; /* ruido del shell antes del servidor */ }
    if (typeof message !== "object" || message === null) return;
    const id = message.id, method = typeof message.method === "string" ? message.method : null;
    const eventThread = record(message.params)?.threadId;
    if (method && typeof eventThread === "string" && eventThread !== activeThreadRef.current) return;
    // Respuesta a una petición propia.
    if (id !== undefined && id !== null && !method) {
      const pending = pendingRef.current.get(Number(id));
      if (!pending) return;
      pendingRef.current.delete(Number(id));
      const error = message.error as { message?: string } | undefined;
      if (error) pending.reject(new CodexRequestRejected(error.message || "Codex rechazó la petición."));
      else pending.resolve(message.result);
      return;
    }
    if (method === "item/tool/call" && id !== undefined && id !== null && record(message.params)?.tool === INBOX_TOOL) {
      dispatch({ type: "rpc", message, scope: procId, now: Date.now() });
      void (async () => {
        let snapshot;
        try {
          const params = record(message.params);
          if (!record(params?.arguments) || Object.keys(params!.arguments as object).length) throw new Error("La herramienta de cola no acepta argumentos.");
          snapshot = await inboxRequests.current.read(JSON.stringify([procId, id]), queue.client.read);
        } catch (error) {
          if (isCurrentRef.current(procId)) writeOrReport(resultLine(id as string | number,
            { contentItems: [{ type: "inputText", text: `No se pudo leer la cola: ${formatError(error)}` }], success: false }));
          return;
        }
        if (!isCurrentRef.current(procId)) return;
        try {
          await writeRef.current(resultLine(id as string | number, { contentItems: codexInboxContent(snapshot.receipt), success: true }));
          if (!isCurrentRef.current(procId)) return;
          if (snapshot.receipt) {
            dispatch({ type: "queuedRead", messages: snapshot.receipt.messages });
            await queue.client.ack(snapshot.receipt.id, () => isCurrentRef.current(procId));
          }
        } catch (error) { notice("error", `La entrega de la cola quedó pendiente: ${formatError(error)}`); }
      })();
      return;
    }
    if (planningOnly && id !== undefined && id !== null && method && ANSWERED_IN_CHAT.has(method)
      && !planningApprovalAllowed(method, record(message.params) ?? {})) {
      const input = record(message.params) ?? {};
      dispatch({ type: "rpc", message, scope: procId, now: Date.now() });
      dispatch({ type: "answer", id: `${procId}:${String(id)}`, allowed: false });
      writeOrReport(resultLine(id as string | number, answerResult({ input, request: { id, method } } as PermissionItem, false, false)));
      return;
    }
    // Con «Permitir todo», un permiso que llegue (por ejemplo, de un turno que empezó antes) se acepta sin tarjeta.
    if (!planningOnly && id !== undefined && id !== null && method && allowsAll(choicesRef.current.mode ?? stateRef.current.permissionMode)) {
      const result = autoApproval(method, (message.params ?? {}) as Json);
      if (result) { writeOrReport(resultLine(id as string | number, result)); return; }
    }
    // Petición de Codex que el chat no sabe atender: se responde para no bloquearlo.
    if (id !== undefined && id !== null && method && !ANSWERED_IN_CHAT.has(method)) {
      if (method === "mcpServer/elicitation/request") {
        writeOrReport(resultLine(id as string | number, { action: "decline", content: null, _meta: null }));
        notice("info", "Un servidor MCP pidió datos que el chat todavía no admite; se rechazó la petición.");
      } else writeOrReport(errorLine(id as string | number, "trex no admite esta petición."));
      return;
    }
    if (method === "turn/started") {
      const turnId = (message.params as { turn?: { id?: string } } | undefined)?.turn?.id;
      if (turnId) turnKnown(turnId);
    } else if (method === "turn/completed") {
      const turnId = text(record(record(message.params)?.turn)?.id);
      if (turnId) {
        completedTurnsRef.current.add(turnId);
        if (completedTurnsRef.current.size > 64) completedTurnsRef.current.delete(completedTurnsRef.current.values().next().value!);
      }
      if (!turnId || turnId === turnIdRef.current) {
        turnIdRef.current = null;
      }
      if (turnId && turnId === stoppedTurnRef.current) {
        stopRequestedRef.current = false;
        stoppedTurnRef.current = null;
        stoppedRequestsRef.current.clear();
      }
    }
    if (method === "item/completed") {
      const receiptId = codexInboxReceiptId(record(message.params)?.item);
      if (receiptId) {
        void queue.client.load().then(async snapshot => {
          if (!isCurrentRef.current(procId) || snapshot.receipt?.id !== receiptId) return;
          dispatch({ type: "queuedRead", messages: snapshot.receipt.messages });
          await queue.client.ack(receiptId, () => isCurrentRef.current(procId));
        }).catch(error => notice("error", `La confirmación de la cola quedó pendiente: ${formatError(error)}`));
      }
    }
    dispatch({ type: "rpc", message, scope: procId, now: Date.now() });
    if (method === "skills/changed") void readSkills().catch(() => undefined);
  }, [planningOnly, writeOrReport, notice, turnKnown, readSkills, queue.client]);

  const agent = useAgentProcess(sessionId, {
    onLine: handleLine,
    onStderr: line => dispatch({ type: "stderr", line }),
    onExit: code => {
      startupEpochRef.current++;
      threadGenerationRef.current++;
      deliveryEpochRef.current++;
      readyProcessRef.current = null;
      processReadyRef.current = null;
      browserBindingRef.current = null;
      browserThreadRef.current = null;
      cancelDeferred();
      rejectPending("Codex se cerró.");
      threadRef.current = null;
      activeThreadRef.current = null;
      turnIdRef.current = null;
      stopRequestedRef.current = false; stoppedTurnRef.current = null; stoppedRequestsRef.current.clear();
      dispatch({ type: "exit", code });
      callbacks.current.onExit(sessionId, code);
    },
  }, "codex");
  writeRef.current = agent.write;
  isCurrentRef.current = agent.isCurrent;

  /** Historial de la conversación recuperada, una sola vez por pestaña. */
  const loadHistory = useCallback(async (threadId: string, report: boolean, procId?: string): Promise<void> => {
    if (historyLoadedRef.current) return;
    const generation = threadGenerationRef.current;
    try {
      const page = await request<{ data?: unknown[] }>("thread/turns/list", { threadId, limit: HISTORY_TURNS, itemsView: "full" }, procId);
      if (!mountedRef.current || threadGenerationRef.current !== generation || (procId && readyProcessRef.current !== procId)) return;
      historyLoadedRef.current = true;
      dispatch({ type: "history", turns: [...(page?.data ?? [])].reverse() });
    } catch (error) {
      if (report && mountedRef.current && threadGenerationRef.current === generation && (!procId || readyProcessRef.current === procId)) notice("warn", `No se pudo mostrar el historial: ${formatError(error)}`);
    }
  }, [request, notice]);

  const threadOverrides = useCallback((overrides: Json): Json => {
    // A profile's own developer instructions still learn about an attached browser, once.
    if (browserBindingRef.current && browserAttached()) {
      const instructions = typeof overrides.developerInstructions === "string" ? overrides.developerInstructions : "";
      overrides = { ...overrides, developerInstructions: instructions.includes(BROWSER_INSTRUCTIONS) ? instructions : [instructions, BROWSER_INSTRUCTIONS].filter(Boolean).join("\n\n") };
    }
    if (planningOnly) return codexPlanningThread({ ...overrides,
      ...(choicesRef.current.model ? { model: choicesRef.current.model } : {}) }, callbacks.current.planningInstruction);
    const mode = choicesRef.current.mode;
    if (!browserBindingRef.current || !mode) return overrides;
    const permissions = selectedPermissions(mode);
    return { ...overrides, ...permissions, config: { ...record(overrides.config),
      sandbox_mode: permissions.sandbox, approval_policy: permissions.approvalPolicy } };
  }, [planningOnly]);

  // doctor only proves the component is installed. Verify this exact native
  // thread received navigation tools before any user/model turn can be sent.
  const confirmBrowserTools = useCallback(async (threadId: string, procId?: string): Promise<void> => {
    if (!browserBindingRef.current) return;
    const generation = threadGenerationRef.current, binding = browserThreadRef.current;
    const assertCurrent = (): void => {
      if (!mountedRef.current || generation !== threadGenerationRef.current || binding !== browserThreadRef.current
        || (procId && readyProcessRef.current !== procId)) throw new DOMException("Envío cancelado.", "AbortError");
    };
    const expected = [
      ...(inboxConfigRef.current["mcp_servers.trex_browser.enabled"] === true ? [{ server: "trex_browser", tools: ["browser_navigate", "browser_snapshot", "browser_status"] }] : []),
      ...(inboxConfigRef.current["mcp_servers.trex_desktop.enabled"] === true ? [{ server: "trex_desktop", tools: browserBindingRef.current?.mode === "observe" ? [...DESKTOP_READ_TOOLS] : [...DESKTOP_READ_TOOLS, ...DESKTOP_INPUT_TOOLS] }] : []),
      ...(a11yAttached() ? [{ server: A11Y_SERVER, tools: browserBindingRef.current?.mode === "observe" ? [...A11Y_READ_TOOLS] : [...A11Y_READ_TOOLS, ...A11Y_ACTION_TOOLS] }] : []),
    ];
    for (const integration of expected) {
      const label = integration.server === "trex_browser" ? "Trex Browser" : integration.server === A11Y_SERVER ? "el control por accesibilidad" : "el control de computadora";
      let response: Json;
      try { response = await request<Json>("mcpServerStatus/list", { threadId, serverName: integration.server, detail: "toolsAndAuthOnly", limit: 100 }, procId); }
      catch { assertCurrent(); throw new CodexBrowserConnectionError(`Codex no pudo confirmar la conexión con ${label}.`); }
      assertCurrent();
      const server = Array.isArray(response.data) ? response.data.map(record).find(server => server?.name === integration.server) : null;
      const tools = record(server?.tools);
      if (!server || server.toolsError != null || server.runtimeStatus !== undefined && server.runtimeStatus !== "connected"
        || !tools || !integration.tools.every(name => record(tools[name]))
        || integration.server === "trex_desktop" && browserBindingRef.current?.mode === "observe" && DESKTOP_INPUT_TOOLS.some(name => record(tools[name]))
        || integration.server === A11Y_SERVER && browserBindingRef.current?.mode === "observe" && [...A11Y_ACTION_TOOLS, ...A11Y_KEYBOARD_TOOLS].some(name => record(tools[name]))) {
        throw new CodexBrowserConnectionError(`Codex no recibió las herramientas de ${label}. Reinicia esta conversación.`);
      }
    }
  }, [request]);

  const confirmBrowserThread = useCallback((response: Json, threadId: string, procId?: string): void => {
    const binding = browserBindingRef.current;
    if (!binding) return;
    const actual = nativePermissions(response);
    if (binding.pending || !actual) throw new CodexBrowserPermissionsError("Codex no confirmó los permisos nativos del navegador. No se enviarán mensajes.");
    const mode = choicesRef.current.mode;
    const expected = planningOnly ? { sandbox: "read-only", approvalPolicy: "on-request" } : mode ? selectedPermissions(mode) : null;
    if (expected && (actual.sandbox !== expected.sandbox || actual.approvalPolicy !== expected.approvalPolicy)) {
      throw new CodexBrowserPermissionsError("Codex no confirmó los permisos elegidos para el navegador. No se enviarán mensajes.");
    }
    const effective = mode ? browserMode(mode, planningOnly) : sandboxBrowserMode(actual.sandbox);
    if (binding.mode !== effective) throw new CodexBrowserModeMismatch(effective);
    browserThreadRef.current = { id: threadId, process: procId ?? readyProcessRef.current, generation: threadGenerationRef.current };
  }, [planningOnly]);

  const newThread = useCallback(async (overrides: Json, procId?: string): Promise<string> => {
    const generation = threadGenerationRef.current;
    const response = await request<{ thread?: { id?: string }; model?: string }>("thread/start", threadOverrides({ cwd, ...overrides,
      config: { ...record(overrides.config), ...inboxConfigRef.current } }), procId);
    if (!mountedRef.current || threadGenerationRef.current !== generation || (procId && readyProcessRef.current !== procId)) throw new DOMException("Envío cancelado.", "AbortError");
    if (planningOnly) assertCodexPlanningThread(response);
    const threadId = response?.thread?.id;
    if (!threadId) throw new Error("Codex no devolvió la conversación.");
    resumeThreadRef.current = threadId;
    confirmBrowserThread(response, threadId, procId);
    await confirmBrowserTools(threadId, procId);
    activeThreadRef.current = threadId;
    agent.bindTerminals?.(threadId);
    threadModelRef.current = text(response.model) || null;
    dispatch({ type: "thread", response });
    return threadId;
  }, [request, cwd, threadOverrides, planningOnly, confirmBrowserThread, confirmBrowserTools]);

  /** Abre el hilo: reanuda la conversación de la pestaña o empieza una nueva. */
  const openThread = useCallback(async (launch: NonNullable<ReturnType<typeof codexLaunch>>, procId: string): Promise<string> => {
    const generation = threadGenerationRef.current;
    const assertCurrent = (): void => {
      if (!mountedRef.current || threadGenerationRef.current !== generation || readyProcessRef.current !== procId || !isCurrentRef.current(procId)) throw new DOMException("Envío cancelado.", "AbortError");
    };
    await request("initialize", {
      clientInfo: { name: "trex", title: "trex", version: "0.1.0" },
      capabilities: { experimentalApi: true, requestAttestation: false, optOutNotificationMethods: OPT_OUT_NOTIFICATIONS },
    }, procId);
    assertCurrent();
    await agentWrite(procId, notificationLine("initialized"));
    assertCurrent();
    // Con la ventana de cada modelo, el contexto se ve antes del primer mensaje.
    void Promise.all([request<{ data?: unknown }>("model/list", {}, procId), codexContextWindows(env?.CODEX_HOME ?? "").catch(() => ({}))])
      .then(([result, windows]) => dispatch({ type: "models", data: result?.data, windows })).catch(() => undefined);
    void readSkills(true).catch(() => undefined);
    // Uso del plan de la cuenta; después, Codex avisa de cada cambio con `account/rateLimits/updated`.
    void request("account/rateLimits/read", {}, procId).then(data => dispatch({ type: "plan", data })).catch(() => undefined);

    // Archivos y preguntas de la interfaz; las instrucciones de AGENTS.md siguen aparte.
    const overrides: Json = threadOverrides({ developerInstructions: chatInstructions(), ...launch.thread,
      config: { ...record(launch.thread.config), ...inboxConfigRef.current },
      ...(choicesRef.current.model ? { model: choicesRef.current.model } : {}) });
    const resumeId = freshRef.current ? resumeThreadRef.current
      : resumeThreadRef.current ?? stateRef.current.sessionId ?? callbacks.current.conversationId ?? launch.resumeId;
    if (resumeId) {
      try {
        const response = await request<Json>("thread/resume", { threadId: resumeId, excludeTurns: true, ...overrides }, procId);
        assertCurrent();
        if (planningOnly) assertCodexPlanningThread(response);
        resumeThreadRef.current = resumeId;
        confirmBrowserThread(response, resumeId, procId);
        await confirmBrowserTools(resumeId, procId);
        activeThreadRef.current = resumeId;
        agent.bindTerminals?.(resumeId);
        threadModelRef.current = text(response.model) || null;
        dispatch({ type: "thread", response });
        await loadHistory(resumeId, true, procId);
        assertCurrent();
        historyLoadedRef.current = true;
        return resumeId;
      } catch (error) {
        assertCurrent();
        if (error instanceof CodexBrowserPermissionsError) throw error;
        // Por ejemplo, si la conversación sigue abierta en otra ventana de Codex: al menos se ve lo que había.
        await loadHistory(resumeId, false, procId);
        assertCurrent();
        notice("warn", `No se pudo reanudar la conversación (${formatError(error)}). Lo que escribas empezará una nueva.`);
      }
    }
    const threadId = await newThread(overrides, procId);
    assertCurrent();
    historyLoadedRef.current = true;
    return threadId;
  }, [request, notice, loadHistory, newThread, cwd, env, readSkills, threadOverrides, planningOnly, confirmBrowserThread, confirmBrowserTools]);

  const start = useCallback((): Promise<void> => {
    if (!mountedRef.current) return Promise.resolve();
    const startup = ++startupEpochRef.current;
    const generation = ++threadGenerationRef.current;
    const isCurrent = () => mountedRef.current && startupEpochRef.current === startup && threadGenerationRef.current === generation;
    inboxRequests.current.clear();
    rejectPending("Codex se reinició.");
    nextIdRef.current = 1;
    turnIdRef.current = null;
    stopRequestedRef.current = false; stoppedTurnRef.current = null; stoppedRequestsRef.current.clear();
    threadModelRef.current = null;
    threadRef.current = null;
    activeThreadRef.current = null;
    readyProcessRef.current = null;
    browserBindingRef.current = null;
    browserThreadRef.current = null;
    // Un perfil que solo funciona en la terminal no llega aquí (App abre la terminal).
    const ready = (async () => {
      try {
        const parsed = codexLaunch(args);
        if (planningOnly && !parsed) throw new Error("El perfil de Codex no admite un chat de planificación. Revisa sus argumentos.");
        const launch = parsed ?? codexLaunch(null)!;
        // Unknown global/-c permissions get an observe grant until the native thread confirms them.
        let bindingMode = browserMode(choicesRef.current.mode ?? (launch.thread.sandbox ? browserChoice(sandboxBrowserMode(launch.thread.sandbox)) : "read-only"), planningOnly);
        if (callbacks.current.browser?.enabled || callbacks.current.desktopEnabled || callbacks.current.a11yEnabled) browserBindingRef.current = { mode: bindingMode, pending: true };
        // The same identity as the chat's coordination hook (useCoordination): queue id or session id.
        const config = await messageQueueMcpConfig(callbacks.current.queueId ?? sessionId, false, { session: callbacks.current.queueId ?? sessionId, project: cwd });
        if (!isCurrent()) return;
        const detection = detectedIntegrations(cwd);
        availableRef.current = detection instanceof Promise ? await detection : detection;
        if (!isCurrent()) return;
        // An unavailable accessibility engine is reported once, not on each attempt.
        let a11yUnavailable = false;
        for (let attempt = 0; attempt < 2; attempt++) {
        const browser = callbacks.current.browser?.enabled ? await connectBrowser(callbacks.current.browser, cwd, browserChoice(bindingMode), planningOnly, shell, message => notice("warn", message), true) : null;
        if (!isCurrent()) return;
        const desktop = callbacks.current.desktopEnabled ? browserConfigForShell(await trexDesktopMcpConfig(bindingMode), shell) : null;
        if (!isCurrent()) return;
        // Experimental: where the accessibility engine cannot run, the thread starts without it, with a notice.
        const a11yConfig = callbacks.current.a11yEnabled && !a11yUnavailable ? await accessibilityServer(bindingMode, message => notice("warn", message)) : null;
        if (!isCurrent()) return;
        if (callbacks.current.a11yEnabled && !a11yConfig) a11yUnavailable = true;
        const a11y = a11yConfig ? browserConfigForShell(a11yConfig, shell) : null;
        browserBindingRef.current = browser || desktop || a11y ? { mode: bindingMode, pending: false } : null;
        inboxConfigRef.current = { ...inboxConfigForShell(config, shell), ...(browser ? {
          // MCP over HTTP (token read from the environment) or the stdio adapter.
          ...(isBrowserHttp(browser) ? { "mcp_servers.trex_browser.url": browser.url, "mcp_servers.trex_browser.bearer_token_env_var": BROWSER_TOKEN_ENV }
            : { "mcp_servers.trex_browser.command": browser.command, "mcp_servers.trex_browser.args": browser.args }),
          "mcp_servers.trex_browser.enabled": true,
          "mcp_servers.trex_browser.required": true,
          "mcp_servers.trex_browser.startup_timeout_sec": 30,
          "mcp_servers.trex_browser.tool_timeout_sec": 120,
        } : {}) };
        if (desktop) Object.assign(inboxConfigRef.current, {
          "mcp_servers.trex_desktop.command": desktop.command, "mcp_servers.trex_desktop.args": desktop.args,
          "mcp_servers.trex_desktop.enabled": true, "mcp_servers.trex_desktop.required": true,
          "mcp_servers.trex_desktop.tool_timeout_sec": 120,
          "mcp_servers.trex_desktop.default_tools_approval_mode": bindingMode === "full" ? "approve" : "prompt",
        });
        if (a11y) Object.assign(inboxConfigRef.current, {
          [`mcp_servers.${A11Y_SERVER}.command`]: a11y.command, [`mcp_servers.${A11Y_SERVER}.args`]: a11y.args,
          [`mcp_servers.${A11Y_SERVER}.enabled`]: true, [`mcp_servers.${A11Y_SERVER}.required`]: true,
          [`mcp_servers.${A11Y_SERVER}.tool_timeout_sec`]: 120,
          [`mcp_servers.${A11Y_SERVER}.default_tools_approval_mode`]: bindingMode === "full" ? "approve" : "prompt",
        });
        if (callbacks.current.team) {
          const teamConfig = browserConfigForShell(await agentTeamMcpConfig(callbacks.current.team), shell);
          if (!isCurrent()) return;
          Object.assign(inboxConfigRef.current, {
            "mcp_servers.trex_team.command": teamConfig.command, "mcp_servers.trex_team.args": teamConfig.args,
            "mcp_servers.trex_team.enabled": true, "mcp_servers.trex_team.required": true,
            "mcp_servers.trex_team.tool_timeout_sec": 1900, "mcp_servers.trex_team.default_tools_approval_mode": "approve",
          });
        }
        autoCompactAt.current = codexAutoCompact(callbacks.current.autoCompact, launch.flags);
        const flags = [...launch.flags, ...codexAutoCompactFlags(autoCompactAt.current)];
        const procId = await agent.spawn({ cwd, command: command?.trim() || "codex", profileArgs: null, flags, shell, env: { ...env, ...browserEnv(browser) } });
        if (!procId || !isCurrent() || !agent.isCurrent(procId)) return;
        readyProcessRef.current = procId;
        dispatch({ type: "spawned" });
        callbacks.current.onRunning(sessionId);
        if (launch.ignored.length) notice("info", `El chat no usa estas opciones del perfil: ${launch.ignored.join(", ")}.`);
        const thread = openThread(launch, procId);
        threadRef.current = thread;
        try { await thread; }
        catch (error) {
          if (!isCurrent() || !agent.isCurrent(procId)) return;
          if (error instanceof CodexBrowserModeMismatch && attempt === 0) {
            // No model turn has run. Replace the process and resume this exact native thread.
            bindingMode = error.mode;
            browserBindingRef.current = { mode: bindingMode, pending: true };
            browserThreadRef.current = null;
            readyProcessRef.current = null;
            threadRef.current = null;
            rejectPending("Codex reconectó los permisos del navegador.");
            continue;
          }
          if (error instanceof CodexBrowserConnectionError) {
            readyProcessRef.current = null; browserThreadRef.current = null;
            dispatch({ type: "spawnFailed", message: formatError(error) });
          } else notice("error", `No se pudo abrir la conversación de Codex: ${formatError(error)}`);
        }
        break;
        }
      } catch (error) {
        if (isCurrent()) dispatch({ type: "spawnFailed", message: `No se pudo iniciar Codex: ${formatError(error)}` });
      }
    })().finally(() => { if (processReadyRef.current === ready) processReadyRef.current = null; });
    processReadyRef.current = ready;
    return ready;
  }, [agent, rejectPending, args, cwd, command, shell, env, sessionId, notice, openThread, planningOnly]);

  // Arranca la primera vez que se ve la pestaña.
  const startedRef = useRef(false);
  useEffect(() => {
    if (startedRef.current || !options.visible) return;
    startedRef.current = true;
    void start();
    // Solo la primera vez que se ve: el resto de cambios llegan por refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options.visible]);

  const alive = state.process === "ready" || state.process === "starting";

  const thread = (): Promise<string> => threadRef.current ?? Promise.reject(new Error("La conversación no está abierta."));

  const markIssued = (id: string, signal?: AbortSignal, turnId?: string): void => {
    signal?.throwIfAborted();
    if (stopRequestedRef.current) throw new Error("Espera a que termine el turno detenido antes de volver a enviar.");
    if (browserBindingRef.current && (browserBindingRef.current.pending || !browserThreadRef.current
      || browserThreadRef.current.process !== readyProcessRef.current || browserThreadRef.current.id !== activeThreadRef.current
      || browserThreadRef.current.generation !== threadGenerationRef.current)) {
      throw new CodexBrowserPermissionsError("Codex todavía no confirmó los permisos del navegador. No se enviarán mensajes.");
    }
    for (const entry of submissionsRef.current.values()) if (entry.id === id) {
      entry.issued = true;
      entry.generation = threadGenerationRef.current;
    }
    dispatch({ type: "sendIssued", id, turnId, now: Date.now() });
  };

  const deliver = (text: string, images: OutgoingImage[], userId?: string, signal?: AbortSignal, input?: Json[]): Promise<void> => {
    const epoch = deliveryEpochRef.current;
    const procId = readyProcessRef.current;
    const assertCurrent = (): void => {
      signal?.throwIfAborted();
      if (!mountedRef.current || epoch !== deliveryEpochRef.current || !procId || readyProcessRef.current !== procId || !agent.isCurrent(procId)) {
        throw new DOMException("Envío cancelado.", "AbortError");
      }
    };
    const delivery = deliveryTailRef.current.then(async () => {
    assertCurrent();
    const threadId = await untilCancelled(thread(), signal);
    assertCurrent();
    const current = stateRef.current;
    const activeTurnId = turnIdRef.current;
    const overrides = activeTurnId ? { expectedTurnId: activeTurnId } : turnOverrides(choicesRef.current, { model: current.model, effort: current.effort,
      fastTier: fastSpeed(current.models, current.model, choicesRef.current.model ?? current.modelChoice)?.tier });
    if (userId) markIssued(userId, signal, activeTurnId ?? undefined);
    let result: { turn?: { id?: string }; turnId?: string };
    try { result = await request<typeof result>(activeTurnId ? "turn/steer" : "turn/start", {
      threadId, input: input ?? userInput(text, images, mentionedSkills(text, current.skills)), clientUserMessageId: userId,
      ...(planningOnly && !activeTurnId ? codexPlanningTurn(overrides, choicesRef.current.model ?? threadModelRef.current,
        choicesRef.current.effort ?? current.effort, callbacks.current.planningInstruction ?? null) : overrides),
    }, procId!); }
    catch (error) {
      // Un rechazo RPC libera un start sin identidad o una entrega cuyo turno ya terminó.
      // Un error de transporte conserva la incertidumbre y la pausa de Stop.
      if (error instanceof CodexRequestRejected && userId && stoppedRequestsRef.current.has(userId)
        && mountedRef.current && readyProcessRef.current === procId && agent.isCurrent(procId!) && activeThreadRef.current === threadId) {
        const stoppedTurn = stoppedTurnRef.current ?? activeTurnId;
        if ((!activeTurnId && !stoppedTurnRef.current && !turnIdRef.current) || (stoppedTurn && completedTurnsRef.current.has(stoppedTurn))) {
          stopRequestedRef.current = false; stoppedTurnRef.current = null; stoppedRequestsRef.current.clear();
        }
        dispatch({ type: "sendFailed", id: userId, message: `No se pudo enviar el mensaje: ${formatError(error)}` });
      }
      throw error;
    }
    if (!mountedRef.current || readyProcessRef.current !== procId || !agent.isCurrent(procId!)) throw new DOMException("Envío cancelado.", "AbortError");
    // Stop aún necesita la identidad de A para interrumpirlo; reset/reinicio no
    // pueden restaurar su identidad sobre el hilo nuevo, aunque usen el mismo proceso.
    if (activeThreadRef.current !== threadId || (epoch !== deliveryEpochRef.current && (!userId || !stoppedRequestsRef.current.has(userId)))) {
      throw new DOMException("Envío cancelado.", "AbortError");
    }
    const accepted = result?.turn?.id ?? result?.turnId;
    if (accepted) {
      // Un terminal puede adelantarse al RPC del primer turno detenido.
      if (userId && stoppedRequestsRef.current.has(userId) && completedTurnsRef.current.has(accepted)) {
        stopRequestedRef.current = false; stoppedTurnRef.current = null; stoppedRequestsRef.current.clear();
      }
      turnKnown(accepted);
      if (userId) dispatch({ type: "bindTurn", id: userId, turnId: accepted });
    }
    assertCurrent();
    });
    deliveryTailRef.current = delivery.catch(() => undefined);
    return delivery;
  };

  /** Mensaje del usuario en el hilo y, cuando Codex esté listo, la petición que lo atiende. */
  const submit = async (display: string, previews: string[], work: (id: string, signal: AbortSignal) => Promise<void>, failure = "No se pudo enviar el mensaje"): Promise<boolean> => {
    if (!mountedRef.current) return false;
    if (stopRequestedRef.current) { notice("info", "Espera a que termine el turno detenido antes de volver a enviar."); return false; }
    const id = localId();
    const epoch = deliveryEpochRef.current;
    const controller = new AbortController(), entry = { id, issued: false, generation: null as number | null };
    submissionsRef.current.set(controller, entry);
    dispatch({ type: "send", id, text: display, previews, now: Date.now(), deferred: true });
    try {
      const ready = processReadyRef.current ?? (!readyProcessRef.current || !agent.isCurrent(readyProcessRef.current) ? start() : null);
      if (ready) await untilCancelled(ready, controller.signal);
      controller.signal.throwIfAborted();
      if (!mountedRef.current || epoch !== deliveryEpochRef.current) throw new DOMException("Envío cancelado.", "AbortError");
      await untilCancelled(work(id, controller.signal), controller.signal);
      controller.signal.throwIfAborted();
      if (!mountedRef.current || epoch !== deliveryEpochRef.current) throw new DOMException("Envío cancelado.", "AbortError");
      return true;
    } catch (error) {
      if (controller.signal.aborted || epoch !== deliveryEpochRef.current || (error instanceof DOMException && error.name === "AbortError")) { if (!entry.issued) dispatch({ type: "cancelSend", id }); }
      else dispatch({ type: "sendFailed", id, message: `${failure}: ${formatError(error)}` });
      return false;
    } finally { submissionsRef.current.delete(controller); }
  };

  /** Queued messages travel as the next user turn: one request, without a wake prompt or tool call. */
  const deliverQueued = async (): Promise<boolean> => {
    if (!mountedRef.current) return false;
    try {
      return await deliverInbox(queue.client, delivery => submit(delivery.display, delivery.previews,
        (id, signal) => deliver("", [], id, signal, inboxInput(delivery.parts))), () => mountedRef.current, message => notice("warn", message));
    } catch (error) { notice("error", `No se pudo leer la cola: ${formatError(error)}`); return false; }
  };
  const send = (text: string, images: OutgoingImage[], previews: string[], display?: string): Promise<boolean> => text === INBOX_WAKE ? deliverQueued()
    : submit(display ?? text, previews, (id, signal) => deliver(text, images, id, signal));

  const edit: ChatSession["edit"] = async (id, text, images, previews) => {
    const epoch = deliveryEpochRef.current;
    const current = stateRef.current;
    if (current.pendingTurns > 0 || editingRef.current) throw new Error("Espera a que termine la respuesta para editar el mensaje.");
    const original = current.items.find(item => item.kind === "user" && item.id === id);
    if (original?.kind !== "user" || !original.providerTurnId) throw new Error("No se encontró el turno original de este mensaje.");
    editingRef.current = true;
    try {
      if (!alive || !readyProcessRef.current || !agent.isCurrent(readyProcessRef.current)) await start();
      if (epoch !== deliveryEpochRef.current) return;
      const parsed = codexLaunch(args);
      if (planningOnly && !parsed) throw new Error("El perfil de Codex no admite un chat de planificación. Revisa sus argumentos.");
      const launch = parsed ?? codexLaunch(null)!;
      const response = await request<{ thread?: { id?: string }; model?: string }>("thread/fork", threadOverrides({
        threadId: await thread(), beforeTurnId: original.providerTurnId, cwd, excludeTurns: true,
        ...launch.thread,
        developerInstructions: chatInstructions(),
        config: { ...record(launch.thread.config), ...inboxConfigRef.current },
      }));
      if (epoch !== deliveryEpochRef.current) return;
      if (planningOnly) assertCodexPlanningThread(response);
      const newId = response.thread?.id;
      if (!newId) throw new Error("Codex no devolvió la conversación regenerada.");
      const priorBrowserThread = browserThreadRef.current;
      confirmBrowserThread(response, newId);
      const forkBrowserThread = browserThreadRef.current;
      const restoreBrowserThread = (): void => {
        if (browserThreadRef.current === forkBrowserThread) browserThreadRef.current = priorBrowserThread;
      };
      try { await confirmBrowserTools(newId); }
      catch (error) { restoreBrowserThread(); throw error; }
      if (epoch !== deliveryEpochRef.current) { restoreBrowserThread(); return; }
      threadRef.current = Promise.resolve(newId);
      activeThreadRef.current = newId;
      agent.bindTerminals?.(newId);
      resumeThreadRef.current = newId;
      threadModelRef.current = response.model || null;
      freshRef.current = true;
      historyLoadedRef.current = true;
      dispatch({ type: "rewind", id, sessionId: newId });
      dispatch({ type: "thread", response });
      const messageId = localId();
      dispatch({ type: "send", id: messageId, text, previews, now: Date.now(), deferred: true });
      await deliver(text, images, messageId);
    } finally { editingRef.current = false; }
  };

  /** Comandos de la terminal de Codex que el servidor ofrece como peticiones. */
  const runCommand = (name: string, args: string): boolean => {
    const label = `/${name}${args ? ` ${args}` : ""}`;
    switch (name) {
      case "compact":
        submit(label, [], async (id, signal) => {
          const threadId = await untilCancelled(thread(), signal);
          markIssued(id, signal, turnIdRef.current ?? undefined);
          await request("thread/compact/start", { threadId }, readyProcessRef.current ?? undefined);
        }, "No se pudo resumir la conversación");
        return true;
      case "review":
        if (planningOnly) {
          notice("info", "Esta pestaña está dedicada al plan del workflow. Pide la revisión en el mensaje del plan.");
          return true;
        }
        submit(label, [], async (id, signal) => {
          const threadId = await untilCancelled(thread(), signal);
          markIssued(id, signal);
          const result = await request<{ turn?: { id?: string } }>("review/start", { threadId, delivery: "inline",
            target: args ? { type: "custom", instructions: args } : { type: "uncommittedChanges" } }, readyProcessRef.current ?? undefined);
          if (result?.turn?.id) {
            turnKnown(result.turn.id);
            dispatch({ type: "bindTurn", id, turnId: result.turn.id });
          }
        }, "No se pudo empezar la revisión");
        return true;
      case "init":
        send(INIT_PROMPT, [], [], label);
        return true;
      case "mcp":
        void thread().then(threadId => request<{ data?: Json[] }>("mcpServerStatus/list", { detail: "toolsAndAuthOnly", threadId }))
          .then(result => {
            const servers = (result?.data ?? []).map(server => {
              const tools = Object.keys((server.tools ?? {}) as Json).length;
              const status = server.runtimeStatus === "connected" ? "conectado" : server.runtimeStatus === "disabled" ? "desactivado"
                : typeof server.runtimeStatus === "string" ? server.runtimeStatus : "sin conexión";
              return `• ${String(server.name)} — ${status}${tools ? ` · ${tools} herramienta${tools === 1 ? "" : "s"}` : ""}`;
            });
            notice("info", servers.length ? `Servidores MCP\n${servers.join("\n")}` : "No hay servidores MCP configurados.");
          })
          .catch(error => notice("error", `No se pudieron leer los servidores MCP: ${formatError(error)}`));
        return true;
      default:
        return false;
    }
  };

  /** Conversación nueva: otro hilo en el mismo servidor (o un servidor nuevo si se cerró). */
  const reset = (): void => {
    threadGenerationRef.current++;
    deliveryEpochRef.current++;
    cancelDeferred();
    freshRef.current = true;
    resumeThreadRef.current = null;
    activeThreadRef.current = null;
    browserThreadRef.current = null;
    turnIdRef.current = null;
    stopRequestedRef.current = false; stoppedTurnRef.current = null; stoppedRequestsRef.current.clear();
    dispatch({ type: "reset" });
    if (processReadyRef.current || !alive || !threadRef.current) { void start(); return; }
    const parsed = codexLaunch(args);
    if (planningOnly && !parsed) { notice("error", "El perfil de Codex no admite un chat de planificación. Revisa sus argumentos."); return; }
    const opened = newThread({ developerInstructions: chatInstructions(), ...(parsed ?? codexLaunch(null)!).thread }, readyProcessRef.current ?? undefined);
    threadRef.current = opened;
    opened.catch(error => {
      if (mountedRef.current && threadRef.current === opened) notice("error", `No se pudo abrir la conversación de Codex: ${formatError(error)}`);
    });
  };

  const answer = (item: PermissionItem, allowed: boolean, remember: boolean, choices?: QuestionChoice[]): void => {
    if (planningOnly) {
      allowed = allowed && planningApprovalAllowed(item.request?.method, item.input);
      remember = false;
    }
    // Las preguntas quedan en el hilo con lo respondido (o sin respuesta, si se omitieron).
    if (item.toolName === "AskUserQuestion") dispatch({ type: "answered", id: item.id, choices: allowed ? choices ?? [] : [] });
    else dispatch({ type: "answer", id: item.id, allowed });
    if (item.request) writeOrReport(resultLine(item.request.id, answerResult(item, allowed, remember, choices)));
  };

  return {
    provider: "codex",
    autoCompactAt: autoCompactAt.current,
    terminals: agent.terminals,
    state,
    queue,
    start: async () => { deliveryEpochRef.current++; cancelDeferred(); await start(); },
    send,
    sendNow: send,
    edit,
    reset,
    runCommand,
    refreshSkills,
    notice,
    interrupt: () => {
      deliveryEpochRef.current++;
      cancelDeferred();
      const issued = [...submissionsRef.current.values()].filter(entry => entry.issued && entry.generation === threadGenerationRef.current);
      const procId = readyProcessRef.current;
      if (mountedRef.current && (issued.length || turnIdRef.current) && procId && agent.isCurrent(procId)) {
        dispatch({ type: "interruptIssued" });
        stopRequestedRef.current = true;
        stoppedTurnRef.current = turnIdRef.current;
        for (const entry of issued) stoppedRequestsRef.current.add(entry.id);
        void stopTurn();
      }
    },
    answer,
    // Codex aplica el modo, el modelo, el esfuerzo y la velocidad a partir del siguiente turno.
    setMode: mode => {
      if (planningOnly) return;
      const reconnect = browserBindingRef.current && browserBindingRef.current.mode !== browserMode(mode);
      if (reconnect && (stateRef.current.pendingTurns > 0 || submissionsRef.current.size > 0 || !!turnIdRef.current || editingRef.current)) {
        notice("info", "Detén la respuesta antes de cambiar los permisos del navegador."); return;
      }
      choicesRef.current = { ...choicesRef.current, mode };
      if (reconnect) {
        startupEpochRef.current++; threadGenerationRef.current++;
        readyProcessRef.current = null; processReadyRef.current = null; threadRef.current = null;
      }
      dispatch({ type: "mode", mode });
      // El turno en curso sigue con el modo anterior: lo que pida desde ahora se acepta aquí.
      if (allowsAll(mode)) for (const item of autoAllowed(stateRef.current.items)) answer(item, true, false);
    },
    setModel: model => {
      choicesRef.current = { ...choicesRef.current, model };
      dispatch({ type: "model", model });
      // Si el modelo nuevo no admite el esfuerzo actual, pasa al suyo por defecto.
      const info = stateRef.current.models.find(entry => entry.value === model);
      const effort = choicesRef.current.effort ?? stateRef.current.effort;
      if (info?.defaultEffort && effort && !info.efforts.includes(effort)) {
        choicesRef.current = { ...choicesRef.current, effort: info.defaultEffort };
        dispatch({ type: "effort", effort: info.defaultEffort });
      }
    },
    setEffort: effort => {
      choicesRef.current = { ...choicesRef.current, effort };
      dispatch({ type: "effort", effort });
    },
    setFast: fast => {
      choicesRef.current = { ...choicesRef.current, fast };
      dispatch({ type: "fast", fast });
    },
  };
}
