/**
 * Sesión de Claude Code como chat: `claude -p` con stream-json.
 *
 * Envía los mensajes, las interrupciones y las respuestas a los permisos como
 * líneas JSON, y pide al CLI su catálogo de modelos y los ajustes en uso.
 */
import { useCallback, useEffect, useReducer, useRef } from "react";
import { formatError } from "../api";
import { readConversation } from "../conversations";
import {
  allowsAll, autoAllowed, initialChatState, needsAnswer, record, type OutgoingImage, type PermissionItem, type QuestionChoice,
} from "../chatState";
import { answeredInput, chatReducer, claudeChatFlags, controlErrorLine, controlLine, permissionLine, userMessageLine } from "../claudeChat";
import { localId, useAgentProcess, type ChatSession, type ChatSessionOptions } from "./chatSession";

/** El uso del plan se pide al servidor de Claude: como mucho una vez por minuto. */
const USAGE_INTERVAL_MS = 60_000;

/** Peticiones propias cuya respuesta hay que atender: datos que guardar o un cambio que deshacer. */
type Control =
  | { kind: "initialize" | "settings" | "context" | "usage" }
  | { kind: "mode"; permissionMode: string | null; modeChoice: string | null };

export function useClaudeChat(options: ChatSessionOptions): ChatSession {
  const { sessionId, cwd, command, args, shell, env, conversationId } = options;
  const [state, dispatch] = useReducer(chatReducer, options.mode, initialChatState);
  const stateRef = useRef(state);
  stateRef.current = state;
  const callbacks = useRef(options);
  callbacks.current = options;
  const pendingControlsRef = useRef(new Map<string, Control>());
  /** Tras empezar una conversación nueva, la de la pestaña ya no se reanuda. */
  const freshRef = useRef(false);

  const writeRef = useRef<(line: string) => Promise<void>>(() => Promise.resolve());
  const writeOrReport = useCallback((line: string) => {
    void writeRef.current(line).catch(error => dispatch({ type: "notice", id: localId(), tone: "error", text: formatError(error) }));
  }, []);

  /** Petición de control al CLI; `pending` marca las que traen una respuesta que atender. */
  const control = useCallback((request: Record<string, unknown>, pending?: Control) => {
    const id = localId();
    if (pending) pendingControlsRef.current.set(id, pending);
    writeOrReport(controlLine(id, request));
  }, [writeOrReport]);
  const refreshSettings = useCallback(() => control({ subtype: "get_settings" }, { kind: "settings" }), [control]);
  /** Lo mismo que mide `/context`; el CLI lo calcula al momento, sin llamar al modelo. */
  const refreshContext = useCallback(() => control({ subtype: "get_context_usage" }, { kind: "context" }), [control]);
  /** Lo mismo que `/usage`: sesión de 5 horas, semana y uso extra de la cuenta. */
  const usageAtRef = useRef(0);
  const refreshUsage = useCallback((force = false) => {
    if (!force && Date.now() - usageAtRef.current < USAGE_INTERVAL_MS) return;
    usageAtRef.current = Date.now();
    control({ subtype: "get_usage" }, { kind: "usage" });
  }, [control]);

  const handleLine = useCallback((line: string) => {
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
      if (pending.kind === "initialize") {
        dispatch({ type: "catalog", models: data.models, permissionMode: data.current_permission_mode, commands: data.commands, agents: data.agents,
          fastState: data.fast_mode_state });
      } else if (pending.kind === "settings") {
        const applied = (data.applied ?? {}) as Record<string, unknown>;
        dispatch({ type: "applied", model: applied.model, effort: applied.effort });
      } else if (pending.kind === "context") {
        dispatch({ type: "context", data });
      } else if (pending.kind === "usage") {
        if (reply.subtype === "success") dispatch({ type: "plan", data });
      } else if (pending.kind === "mode" && reply.subtype !== "success") {
        const reason = reply.error ?? "";
        dispatch({ type: "modeRejected", permissionMode: pending.permissionMode, modeChoice: pending.modeChoice,
          message: /bypassPermissions|skip-permissions/.test(reason)
            ? "Esta sesión de Claude Code no admite «Permitir todo» (su perfil lo impide, por ejemplo con --restricted)."
            : `No se pudo cambiar el modo de permisos: ${reason || "Claude Code lo rechazó."}` });
      }
      return;
    }
    // Con «Permitir todo», lo que el CLI aún consulte se acepta sin mostrar la tarjeta.
    if (message?.type === "control_request" && message.request?.subtype === "can_use_tool" && message.request_id
      && allowsAll(stateRef.current.permissionMode) && !needsAnswer(String(message.request.tool_name ?? ""))) {
      writeOrReport(permissionLine(message.request_id, true, record(message.request.input) ?? {}));
      return;
    }
    // Peticiones del CLI que el chat aún no atiende: se rechazan para no bloquearlo.
    if (message?.type === "control_request" && message.request?.subtype !== "can_use_tool" && message.request_id) {
      writeOrReport(controlErrorLine(message.request_id, "trex no admite esta petición."));
      return;
    }
    dispatch({ type: "line", event, now: Date.now() });
    // Al terminar cada respuesta se vuelve a medir el contexto, con el desglose por partes, y el uso del plan.
    if (message?.type === "result" && typeof message.parent_tool_use_id !== "string") {
      refreshContext();
      refreshUsage();
    }
  }, [writeOrReport, refreshContext, refreshUsage]);

  const agent = useAgentProcess(sessionId, {
    onLine: handleLine,
    onStderr: line => dispatch({ type: "stderr", line }),
    onExit: code => {
      dispatch({ type: "exit", code });
      callbacks.current.onExit(sessionId, code);
    },
  });
  writeRef.current = agent.write;

  const start = useCallback(async (fresh = false): Promise<void> => {
    const current = stateRef.current;
    const resumeId = fresh ? null : current.sessionId ?? (freshRef.current ? null : callbacks.current.conversationId);
    pendingControlsRef.current.clear();
    try {
      const procId = await agent.spawn({
        cwd, command: command?.trim() || "claude", profileArgs: args, shell, env,
        flags: claudeChatFlags(args, resumeId, { model: current.modelChoice, effort: current.effortChoice, mode: current.modeChoice }),
      });
      if (!procId) return;
      dispatch({ type: "spawned" });
      callbacks.current.onRunning(sessionId);
      // Modelos disponibles, modelo/esfuerzo en uso y contexto (el de la conversación reanudada), antes del primer mensaje.
      control({ subtype: "initialize" }, { kind: "initialize" });
      // La velocidad elegida no tiene opción de lanzamiento propia: se aplica igual que al cambiarla.
      if (current.fastChoice !== null) control({ subtype: "apply_flag_settings", settings: { fastMode: current.fastChoice } });
      refreshSettings();
      refreshContext();
      refreshUsage(true);
    } catch (error) {
      dispatch({ type: "spawnFailed", message: `No se pudo iniciar Claude Code: ${formatError(error)}` });
    }
  }, [agent, sessionId, cwd, command, args, shell, env, control, refreshSettings, refreshContext, refreshUsage]);

  // Arranque: historial guardado (si se recupera una conversación) y proceso.
  useEffect(() => {
    let disposed = false;
    if (conversationId) {
      void readConversation(env?.CLAUDE_CONFIG_DIR ?? "", conversationId)
        .then(entries => { if (!disposed) dispatch({ type: "history", entries }); })
        .catch(error => dispatch({ type: "notice", id: localId(), tone: "warn", text: `No se pudo mostrar el historial: ${formatError(error)}` }));
    }
    void start();
    return () => { disposed = true; };
    // Solo al montar: el resto de cambios llegan por refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const alive = state.process === "ready" || state.process === "starting";

  const send = (text: string, images: OutgoingImage[], previews: string[], display?: string): void => {
    dispatch({ type: "send", id: localId(), text: display ?? text, previews, now: Date.now() });
    const deliver = (): void => writeOrReport(userMessageLine(text, images));
    if (alive) deliver();
    else void start().then(deliver);
  };

  const interrupt = (): void => {
    if (state.pendingTurns > 0 && alive) writeOrReport(controlLine(localId(), { subtype: "interrupt" }));
  };

  const answer = (item: PermissionItem, allowed: boolean, remember: boolean, choices?: QuestionChoice[]): void => {
    // Omitir unas preguntas no es denegar un permiso: Claude sigue a su criterio sin respuestas.
    if (item.toolName === "AskUserQuestion") {
      dispatch({ type: "answer", id: item.id, allowed: true });
      writeOrReport(permissionLine(item.id, true, answeredInput(item.input, allowed ? choices ?? [] : [])));
      return;
    }
    dispatch({ type: "answer", id: item.id, allowed });
    writeOrReport(permissionLine(item.id, allowed, item.input, remember ? item.suggestions : []));
  };

  const notice = (tone: "info" | "warn" | "error", text: string): void => dispatch({ type: "notice", id: localId(), tone, text });

  return {
    provider: "claude",
    state,
    start: () => start(),
    send,
    // El CLI no cambia de sesión en mitad del proceso: se lanza otro sin reanudar nada.
    reset: () => {
      freshRef.current = true;
      dispatch({ type: "reset" });
      void start(true);
    },
    // Los comandos de Claude Code los resuelve el propio CLI al recibirlos como mensaje.
    runCommand: () => false,
    notice,
    interrupt,
    answer,
    setMode: mode => {
      const before = stateRef.current;
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
