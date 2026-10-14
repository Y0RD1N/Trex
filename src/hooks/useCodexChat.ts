/**
 * Sesión de Codex como chat: `codex app-server` por JSON-RPC.
 *
 * Al arrancar se presenta, pide el catálogo de modelos y abre un hilo nuevo o
 * reanuda la conversación de la pestaña (con su historial). Cada mensaje es un
 * turno; uno enviado mientras Codex trabaja se suma al turno en curso.
 */
import { useCallback, useEffect, useReducer, useRef } from "react";
import { codexContextWindows, formatError } from "../api";
import {
  allowsAll, autoAllowed, fastSpeed, initialChatState, record, text, type Json, type OutgoingImage, type PermissionItem, type QuestionChoice,
} from "../chatState";
import {
  INIT_PROMPT, OPT_OUT_NOTIFICATIONS, answerResult, autoApproval, codexLaunch, codexReducer, errorLine, notificationLine, requestLine,
  resultLine, turnOverrides, userInput,
} from "../codexChat";
import { mentionedSkills } from "../chatCommands";
import { FILE_SHARING_INSTRUCTIONS } from "../sharedFiles";
import { localId, useAgentProcess, type ChatSession, type ChatSessionOptions } from "./chatSession";

/** Peticiones de Codex que el chat responde con una tarjeta. */
const ANSWERED_IN_CHAT = new Set([
  "item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/tool/requestUserInput", "item/permissions/requestApproval",
]);
/** Turnos de la conversación recuperada que se muestran al abrirla. */
const HISTORY_TURNS = 40;

type Pending = { resolve: (result: unknown) => void; reject: (error: Error) => void };

export function useCodexChat(options: ChatSessionOptions): ChatSession {
  const { sessionId, cwd, command, args, shell, env } = options;
  const [state, dispatch] = useReducer(codexReducer, options.mode, initialChatState);
  const stateRef = useRef(state);
  stateRef.current = state;
  const callbacks = useRef(options);
  callbacks.current = options;

  const nextIdRef = useRef(1);
  const pendingRef = useRef(new Map<number, Pending>());
  /** Hilo listo para recibir turnos (se resuelve tras abrirlo o reanudarlo). */
  const threadRef = useRef<Promise<string> | null>(null);
  const activeThreadRef = useRef<string | null>(null);
  const turnIdRef = useRef<string | null>(null);
  const completedTurnsRef = useRef(new Set<string>());
  const stopRequestedRef = useRef(false);
  /** El hilo ya se abrió en esta pestaña: al reanudar no se vuelve a pintar su historial. */
  const historyLoadedRef = useRef(false);
  /** Tras empezar una conversación nueva, la de la pestaña ya no se reanuda. */
  const freshRef = useRef(false);
  const editingRef = useRef(false);
  /** Modo, modelo, esfuerzo y velocidad elegidos: se leen al empezar cada turno, sin esperar al render. */
  const choicesRef = useRef<{ mode: string | null; model: string | null; effort: string | null; fast: boolean | null }>({
    mode: options.mode, model: null, effort: null, fast: null });
  const writeRef = useRef<(line: string) => Promise<void>>(() => Promise.resolve());

  const notice = useCallback((tone: "info" | "warn" | "error", text: string) => dispatch({ type: "notice", id: localId(), tone, text }), []);
  const writeOrReport = useCallback((line: string) => {
    void writeRef.current(line).catch(error => notice("error", formatError(error)));
  }, [notice]);

  const request = useCallback(<T = Json>(method: string, params: unknown): Promise<T> => new Promise<T>((resolve, reject) => {
    const id = nextIdRef.current++;
    pendingRef.current.set(id, { resolve: result => resolve(result as T), reject });
    writeRef.current(requestLine(id, method, params)).catch(error => {
      pendingRef.current.delete(id);
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
    const turnId = turnIdRef.current, threadId = stateRef.current.sessionId;
    if (!turnId || !threadId) { stopRequestedRef.current = true; return; }
    stopRequestedRef.current = false;
    await request("turn/interrupt", { threadId, turnId }).catch(error => notice("error", formatError(error)));
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
    if (method && typeof eventThread === "string" && activeThreadRef.current && eventThread !== activeThreadRef.current) return;
    // Respuesta a una petición propia.
    if (id !== undefined && id !== null && !method) {
      const pending = pendingRef.current.get(Number(id));
      if (!pending) return;
      pendingRef.current.delete(Number(id));
      const error = message.error as { message?: string } | undefined;
      if (error) pending.reject(new Error(error.message || "Codex rechazó la petición."));
      else pending.resolve(message.result);
      return;
    }
    // Con «Permitir todo», un permiso que llegue (por ejemplo, de un turno que empezó antes) se acepta sin tarjeta.
    if (id !== undefined && id !== null && method && allowsAll(choicesRef.current.mode ?? stateRef.current.permissionMode)) {
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
        stopRequestedRef.current = false;
      }
    }
    dispatch({ type: "rpc", message, scope: procId, now: Date.now() });
    if (method === "skills/changed") void readSkills().catch(() => undefined);
  }, [writeOrReport, notice, turnKnown, readSkills]);

  const agent = useAgentProcess(sessionId, {
    onLine: handleLine,
    onStderr: line => dispatch({ type: "stderr", line }),
    onExit: code => {
      rejectPending("Codex se cerró.");
      threadRef.current = null;
      turnIdRef.current = null;
      dispatch({ type: "exit", code });
      callbacks.current.onExit(sessionId, code);
    },
  });
  writeRef.current = agent.write;

  /** Historial de la conversación recuperada, una sola vez por pestaña. */
  const loadHistory = useCallback(async (threadId: string, report: boolean): Promise<void> => {
    if (historyLoadedRef.current) return;
    try {
      const page = await request<{ data?: unknown[] }>("thread/turns/list", { threadId, limit: HISTORY_TURNS, itemsView: "full" });
      historyLoadedRef.current = true;
      dispatch({ type: "history", turns: [...(page?.data ?? [])].reverse() });
    } catch (error) {
      if (report) notice("warn", `No se pudo mostrar el historial: ${formatError(error)}`);
    }
  }, [request, notice]);

  const newThread = useCallback(async (overrides: Json): Promise<string> => {
    const response = await request<{ thread?: { id?: string } }>("thread/start", { cwd, ...overrides });
    dispatch({ type: "thread", response });
    const threadId = response?.thread?.id;
    if (!threadId) throw new Error("Codex no devolvió la conversación.");
    activeThreadRef.current = threadId;
    return threadId;
  }, [request, cwd]);

  /** Abre el hilo: reanuda la conversación de la pestaña o empieza una nueva. */
  const openThread = useCallback(async (launch: NonNullable<ReturnType<typeof codexLaunch>>): Promise<string> => {
    await request("initialize", {
      clientInfo: { name: "trex", title: "trex", version: "0.1.0" },
      capabilities: { experimentalApi: true, requestAttestation: false, optOutNotificationMethods: OPT_OUT_NOTIFICATIONS },
    });
    await writeRef.current(notificationLine("initialized"));
    // Con la ventana de cada modelo, el contexto se ve antes del primer mensaje.
    void Promise.all([request<{ data?: unknown }>("model/list", {}), codexContextWindows(env?.CODEX_HOME ?? "").catch(() => ({}))])
      .then(([result, windows]) => dispatch({ type: "models", data: result?.data, windows })).catch(() => undefined);
    void readSkills(true).catch(() => undefined);
    // Uso del plan de la cuenta; después, Codex avisa de cada cambio con `account/rateLimits/updated`.
    void request("account/rateLimits/read", {}).then(data => dispatch({ type: "plan", data })).catch(() => undefined);

    // Cómo adjuntar archivos al chat; las instrucciones de AGENTS.md siguen aparte.
    const overrides: Json = { developerInstructions: FILE_SHARING_INSTRUCTIONS, ...launch.thread };
    const resumeId = stateRef.current.sessionId ?? (freshRef.current ? null : callbacks.current.conversationId ?? launch.resumeId);
    if (resumeId) {
      try {
        const response = await request<Json>("thread/resume", { threadId: resumeId, excludeTurns: true, ...overrides });
        activeThreadRef.current = resumeId;
        dispatch({ type: "thread", response });
        await loadHistory(resumeId, true);
        historyLoadedRef.current = true;
        return resumeId;
      } catch (error) {
        // Por ejemplo, si la conversación sigue abierta en otra ventana de Codex: al menos se ve lo que había.
        await loadHistory(resumeId, false);
        notice("warn", `No se pudo reanudar la conversación (${formatError(error)}). Lo que escribas empezará una nueva.`);
      }
    }
    const threadId = await newThread(overrides);
    historyLoadedRef.current = true;
    return threadId;
  }, [request, notice, loadHistory, newThread, cwd, env, readSkills]);

  const start = useCallback(async (): Promise<void> => {
    rejectPending("Codex se reinició.");
    nextIdRef.current = 1;
    turnIdRef.current = null;
    // Un perfil que solo funciona en la terminal no llega aquí (App abre la terminal).
    const launch = codexLaunch(args) ?? codexLaunch(null)!;
    try {
      const procId = await agent.spawn({ cwd, command: command?.trim() || "codex", profileArgs: null, flags: launch.flags, shell, env });
      if (!procId) return;
      dispatch({ type: "spawned" });
      callbacks.current.onRunning(sessionId);
      if (launch.ignored.length) notice("info", `El chat no usa estas opciones del perfil: ${launch.ignored.join(", ")}.`);
      const thread = openThread(launch);
      threadRef.current = thread;
      await thread.catch(error => {
        if (agent.isCurrent(procId)) notice("error", `No se pudo abrir la conversación de Codex: ${formatError(error)}`);
      });
    } catch (error) {
      dispatch({ type: "spawnFailed", message: `No se pudo iniciar Codex: ${formatError(error)}` });
    }
  }, [agent, rejectPending, args, cwd, command, shell, env, sessionId, notice, openThread]);

  useEffect(() => {
    void start();
    // Solo al montar: el resto de cambios llegan por refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const alive = state.process === "ready" || state.process === "starting";

  const thread = (): Promise<string> => threadRef.current ?? Promise.reject(new Error("La conversación no está abierta."));

  const deliver = async (text: string, images: OutgoingImage[], userId?: string): Promise<void> => {
    const threadId = await thread();
    const current = stateRef.current;
    const result = await request<{ turn?: { id?: string } }>("turn/start", {
      threadId, input: userInput(text, images, mentionedSkills(text, current.skills)),
      ...turnOverrides(choicesRef.current, { model: current.model, effort: current.effort,
        fastTier: fastSpeed(current.models, current.model, choicesRef.current.model ?? current.modelChoice)?.tier }),
    });
    if (result?.turn?.id) {
      turnKnown(result.turn.id);
      if (userId) dispatch({ type: "bindTurn", id: userId, turnId: result.turn.id });
    }
  };

  /** Mensaje del usuario en el hilo y, cuando Codex esté listo, la petición que lo atiende. */
  const submit = (display: string, previews: string[], work: (id: string) => Promise<void>, failure = "No se pudo enviar el mensaje"): void => {
    const id = localId();
    dispatch({ type: "send", id, text: display, previews, now: Date.now() });
    const failed = (error: unknown): void => dispatch({ type: "turnFailed", message: `${failure}: ${formatError(error)}` });
    if (alive) void work(id).catch(failed);
    else void start().then(() => work(id)).catch(failed);
  };

  const send = (text: string, images: OutgoingImage[], previews: string[], display?: string): void =>
    submit(display ?? text, previews, id => deliver(text, images, id));

  const edit: ChatSession["edit"] = async (id, text, images, previews) => {
    const current = stateRef.current;
    if (current.pendingTurns > 0 || editingRef.current) throw new Error("Espera a que termine la respuesta para editar el mensaje.");
    const original = current.items.find(item => item.kind === "user" && item.id === id);
    if (original?.kind !== "user" || !original.providerTurnId) throw new Error("No se encontró el turno original de este mensaje.");
    editingRef.current = true;
    try {
      if (!alive) await start();
      const response = await request<{ thread?: { id?: string } }>("thread/fork", {
        threadId: await thread(), beforeTurnId: original.providerTurnId, cwd, excludeTurns: true,
        ...(codexLaunch(args) ?? codexLaunch(null)!).thread,
      });
      const newId = response.thread?.id;
      if (!newId) throw new Error("Codex no devolvió la conversación regenerada.");
      threadRef.current = Promise.resolve(newId);
      activeThreadRef.current = newId;
      freshRef.current = true;
      historyLoadedRef.current = true;
      dispatch({ type: "rewind", id, sessionId: newId });
      dispatch({ type: "thread", response });
      const messageId = localId();
      dispatch({ type: "send", id: messageId, text, previews, now: Date.now() });
      await deliver(text, images, messageId);
    } finally { editingRef.current = false; }
  };

  /** Comandos de la terminal de Codex que el servidor ofrece como peticiones. */
  const runCommand = (name: string, args: string): boolean => {
    const label = `/${name}${args ? ` ${args}` : ""}`;
    switch (name) {
      case "compact":
        submit(label, [], async () => { await request("thread/compact/start", { threadId: await thread() }); }, "No se pudo resumir la conversación");
        return true;
      case "review":
        submit(label, [], async id => {
          const result = await request<{ turn?: { id?: string } }>("review/start", { threadId: await thread(), delivery: "inline",
            target: args ? { type: "custom", instructions: args } : { type: "uncommittedChanges" } });
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
    freshRef.current = true;
    turnIdRef.current = null;
    stopRequestedRef.current = false;
    dispatch({ type: "reset" });
    if (!alive || !threadRef.current) { void start(); return; }
    const opened = newThread({ developerInstructions: FILE_SHARING_INSTRUCTIONS, ...(codexLaunch(args) ?? codexLaunch(null)!).thread });
    threadRef.current = opened;
    opened.catch(error => notice("error", `No se pudo abrir la conversación de Codex: ${formatError(error)}`));
  };

  const answer = (item: PermissionItem, allowed: boolean, remember: boolean, choices?: QuestionChoice[]): void => {
    // Las preguntas quedan en el hilo con lo respondido (o sin respuesta, si se omitieron).
    if (item.toolName === "AskUserQuestion") dispatch({ type: "answered", id: item.id, choices: allowed ? choices ?? [] : [] });
    else dispatch({ type: "answer", id: item.id, allowed });
    if (item.request) writeOrReport(resultLine(item.request.id, answerResult(item, allowed, remember, choices)));
  };

  return {
    provider: "codex",
    state,
    start,
    send,
    edit,
    reset,
    runCommand,
    refreshSkills,
    notice,
    interrupt: () => { if (state.pendingTurns > 0 && alive) void stopTurn(); },
    answer,
    // Codex aplica el modo, el modelo, el esfuerzo y la velocidad a partir del siguiente turno.
    setMode: mode => {
      choicesRef.current = { ...choicesRef.current, mode };
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
