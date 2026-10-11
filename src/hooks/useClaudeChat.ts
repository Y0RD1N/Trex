/**
 * Sesión de Claude Code como chat: `claude -p` con stream-json.
 *
 * Envía los mensajes, las interrupciones y las respuestas a los permisos como
 * líneas JSON, y pide al CLI su catálogo de modelos y los ajustes en uso.
 */
import { useCallback, useEffect, useReducer, useRef } from "react";
import { formatError } from "../api";
import { readConversation } from "../conversations";
import { initialChatState, type OutgoingImage, type PermissionItem, type QuestionChoice } from "../chatState";
import { answeredInput, chatReducer, claudeChatFlags, controlErrorLine, controlLine, permissionLine, userMessageLine } from "../claudeChat";
import { localId, useAgentProcess, type ChatSession, type ChatSessionOptions } from "./chatSession";

export function useClaudeChat(options: ChatSessionOptions): ChatSession {
  const { sessionId, cwd, command, args, shell, env, conversationId } = options;
  const [state, dispatch] = useReducer(chatReducer, undefined, initialChatState);
  const stateRef = useRef(state);
  stateRef.current = state;
  const callbacks = useRef(options);
  callbacks.current = options;
  /** Peticiones propias cuya respuesta trae datos: catálogo de modelos y ajustes en uso. */
  const pendingControlsRef = useRef(new Map<string, "initialize" | "settings">());
  /** Tras empezar una conversación nueva, la de la pestaña ya no se reanuda. */
  const freshRef = useRef(false);

  const writeRef = useRef<(line: string) => Promise<void>>(() => Promise.resolve());
  const writeOrReport = useCallback((line: string) => {
    void writeRef.current(line).catch(error => dispatch({ type: "notice", id: localId(), tone: "error", text: formatError(error) }));
  }, []);

  /** Petición de control al CLI; `kind` marca las que devuelven datos que hay que guardar. */
  const control = useCallback((request: Record<string, unknown>, kind?: "initialize" | "settings") => {
    const id = localId();
    if (kind) pendingControlsRef.current.set(id, kind);
    writeOrReport(controlLine(id, request));
  }, [writeOrReport]);
  const refreshSettings = useCallback(() => control({ subtype: "get_settings" }, "settings"), [control]);

  const handleLine = useCallback((line: string) => {
    let event: unknown;
    try { event = JSON.parse(line); } catch { return; /* ruido del shell antes del CLI */ }
    const message = event as { type?: string; request_id?: string; request?: { subtype?: string };
      response?: { subtype?: string; request_id?: string; response?: Record<string, unknown> } };
    const reply = message?.type === "control_response" ? message.response : undefined;
    const kind = reply?.request_id ? pendingControlsRef.current.get(reply.request_id) : undefined;
    if (reply?.request_id && kind) {
      pendingControlsRef.current.delete(reply.request_id);
      const data = reply.subtype === "success" ? reply.response ?? {} : {};
      if (kind === "initialize") {
        dispatch({ type: "catalog", models: data.models, permissionMode: data.current_permission_mode, commands: data.commands, agents: data.agents });
      }
      else {
        const applied = (data.applied ?? {}) as Record<string, unknown>;
        dispatch({ type: "applied", model: applied.model, effort: applied.effort });
      }
      return;
    }
    // Peticiones del CLI que el chat aún no atiende: se rechazan para no bloquearlo.
    if (message?.type === "control_request" && message.request?.subtype !== "can_use_tool" && message.request_id) {
      writeOrReport(controlErrorLine(message.request_id, "trex no admite esta petición."));
      return;
    }
    dispatch({ type: "line", event, now: Date.now() });
  }, [writeOrReport]);

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
      // Modelos disponibles y modelo/esfuerzo en uso, antes del primer mensaje.
      control({ subtype: "initialize" }, "initialize");
      refreshSettings();
    } catch (error) {
      dispatch({ type: "spawnFailed", message: `No se pudo iniciar Claude Code: ${formatError(error)}` });
    }
  }, [agent, sessionId, cwd, command, args, shell, env, control, refreshSettings]);

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
    dispatch({ type: "answer", id: item.id, allowed });
    const input = allowed && choices ? answeredInput(item.input, choices) : item.input;
    writeOrReport(permissionLine(item.id, allowed, input, remember ? item.suggestions : []));
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
      dispatch({ type: "mode", mode });
      control({ subtype: "set_permission_mode", mode });
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
  };
}
