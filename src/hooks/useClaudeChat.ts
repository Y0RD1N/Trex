/**
 * Sesión de Claude Code como chat: `claude -p` con stream-json.
 *
 * Envía los mensajes, las interrupciones y las respuestas a los permisos como
 * líneas JSON, y pide al CLI su catálogo de modelos y los ajustes en uso.
 */
import { useCallback, useEffect, useReducer, useRef } from "react";
import { claudeRewindPoint, formatError } from "../api";
import { withoutConversationArgs } from "../chatMessages";
import { claudeSkillText, parseClaudeCommands } from "../chatCommands";
import { readConversation } from "../conversations";
import {
  allowsAll, autoAllowed, initialChatState, needsAnswer, record, type OutgoingImage, type PermissionItem, type QuestionChoice,
} from "../chatState";
import { answeredInput, chatReducer, claudeChatFlags, controlErrorLine, controlLine, permissionLine, userMessageLine } from "../claudeChat";
import { localId, useAgentProcess, type ChatSession, type ChatSessionOptions } from "./chatSession";

/** El uso del plan se pide al servidor de Claude: como mucho una vez por minuto. */
const USAGE_INTERVAL_MS = 60_000;
const commandSignature = (commands: unknown): string => JSON.stringify(parseClaudeCommands(commands)
  .sort((a, b) => a.name.localeCompare(b.name) || a.description.localeCompare(b.description)));

/** Peticiones propias cuya respuesta hay que atender: datos que guardar o un cambio que deshacer. */
type Control =
  | { kind: "initialize"; ready?: (error?: string) => void }
  | { kind: "settings" | "context" | "usage" }
  | { kind: "skills"; done: (error?: string) => void }
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
  const conversationOverrideRef = useRef(false);
  const editingRef = useRef(false);
  const skillsRequestRef = useRef<Promise<void> | null>(null);
  const commandsSignatureRef = useRef("");

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
        commandsSignatureRef.current = commandSignature(data.commands);
        dispatch({ type: "catalog", models: data.models, permissionMode: data.current_permission_mode, commands: data.commands, agents: data.agents,
          fastState: data.fast_mode_state });
        pending.ready?.(reply.subtype === "success" ? undefined : reply.error ?? "Claude rechazó la reanudación.");
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
  }, [writeOrReport, refreshContext, refreshUsage, refreshSkills]);

  const agent = useAgentProcess(sessionId, {
    onLine: handleLine,
    onStderr: line => dispatch({ type: "stderr", line }),
    onExit: code => {
      for (const pending of pendingControlsRef.current.values()) {
        if (pending.kind === "initialize") pending.ready?.("Claude se cerró antes de reanudar la conversación.");
        else if (pending.kind === "skills") pending.done("La sesión de Claude se cerró.");
      }
      pendingControlsRef.current.clear();
      skillsRequestRef.current = null;
      dispatch({ type: "exit", code });
      callbacks.current.onExit(sessionId, code);
    },
  });
  writeRef.current = agent.write;

  const start = useCallback(async (fresh = false): Promise<void> => {
    const current = stateRef.current;
    const resumeId = fresh ? null : current.sessionId ?? (freshRef.current ? null : callbacks.current.conversationId);
    const profileArgs = conversationOverrideRef.current ? withoutConversationArgs(args) : args;
    for (const pending of pendingControlsRef.current.values()) if (pending.kind === "skills") pending.done("La sesión de Claude se está reiniciando.");
    pendingControlsRef.current.clear();
    skillsRequestRef.current = null;
    try {
      const procId = await agent.spawn({
        cwd, command: command?.trim() || "claude", profileArgs, shell, env,
        flags: claudeChatFlags(profileArgs, resumeId, { model: current.modelChoice, effort: current.effortChoice, mode: current.modeChoice }),
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
      void refreshSkills().catch(() => undefined);
    } catch (error) {
      dispatch({ type: "spawnFailed", message: `No se pudo iniciar Claude Code: ${formatError(error)}` });
    }
  }, [agent, sessionId, cwd, command, args, shell, env, control, refreshSettings, refreshContext, refreshUsage, refreshSkills]);

  // Arranque al mostrarse por primera vez: historial guardado (si se recupera una conversación) y proceso.
  const startedRef = useRef(false);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  useEffect(() => {
    if (startedRef.current || !options.visible) return;
    startedRef.current = true;
    // El historial llega aunque la pestaña se oculte mientras se lee.
    if (conversationId) {
      void readConversation(env?.CLAUDE_CONFIG_DIR ?? "", conversationId)
        .then(entries => { if (mountedRef.current) dispatch({ type: "history", entries }); })
        .catch(error => dispatch({ type: "notice", id: localId(), tone: "warn", text: `No se pudo mostrar el historial: ${formatError(error)}` }));
    }
    void start();
    // Solo la primera vez que se ve: el resto de cambios llegan por refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options.visible]);

  const alive = state.process === "ready" || state.process === "starting";

  const send = (text: string, images: OutgoingImage[], previews: string[], display?: string): void => {
    const id = crypto.randomUUID();
    dispatch({ type: "send", id, text: display ?? text, previews, now: Date.now() });
    const deliver = (): void => {
      void agent.write(userMessageLine(claudeSkillText(text, stateRef.current.skills), images, id))
        .catch(error => dispatch({ type: "sendFailed", id, message: `No se pudo enviar el mensaje: ${formatError(error)}` }));
    };
    if (alive) deliver();
    else void start().then(deliver);
  };

  const edit: ChatSession["edit"] = async (id, text, images, previews) => {
    const current = stateRef.current;
    if (current.pendingTurns > 0 || editingRef.current) throw new Error("Espera a que termine la respuesta para editar el mensaje.");
    if (!current.sessionId || !current.items.some(item => item.kind === "user" && item.id === id)) throw new Error("No se encontró el mensaje en esta conversación.");
    editingRef.current = true;
    try {
      const point = await claudeRewindPoint(env?.CLAUDE_CONFIG_DIR ?? "", current.sessionId, id);
      const newSessionId = crypto.randomUUID();
      const profileArgs = withoutConversationArgs(args);
      const flags = claudeChatFlags(profileArgs, point ? current.sessionId : null,
        { model: current.modelChoice, effort: current.effortChoice, mode: current.modeChoice });
      if (point) flags.push("--resume-session-at", point, "--fork-session");
      flags.push("--session-id", newSessionId);
      for (const pending of pendingControlsRef.current.values()) if (pending.kind === "skills") pending.done("La sesión de Claude se está reiniciando.");
      pendingControlsRef.current.clear();
      skillsRequestRef.current = null;
      const procId = await agent.spawn({ cwd, command: command?.trim() || "claude", profileArgs, flags, shell, env });
      if (!procId) throw new Error("La sesión se cerró mientras se preparaba la edición.");
      // El prefijo solo se sustituye cuando el CLI confirma que aceptó la reanudación.
      await new Promise<void>((resolve, reject) => {
        const requestId = localId();
        const timer = window.setTimeout(() => {
          pendingControlsRef.current.delete(requestId);
          reject(new Error("Claude no confirmó la reanudación. Puedes volver a intentarlo."));
        }, 15_000);
        const ready = (error?: string): void => {
          window.clearTimeout(timer);
          pendingControlsRef.current.delete(requestId);
          if (error) reject(new Error(error)); else resolve();
        };
        pendingControlsRef.current.set(requestId, { kind: "initialize", ready });
        void agent.write(controlLine(requestId, { subtype: "initialize" })).catch(error => ready(formatError(error)));
      });
      conversationOverrideRef.current = true;
      freshRef.current = true;
      dispatch({ type: "rewind", id, sessionId: newSessionId });
      dispatch({ type: "spawned" });
      callbacks.current.onRunning(sessionId);
      if (current.fastChoice !== null) control({ subtype: "apply_flag_settings", settings: { fastMode: current.fastChoice } });
      refreshSettings();
      refreshUsage(true);
      const messageId = crypto.randomUUID();
      dispatch({ type: "send", id: messageId, text, previews, now: Date.now() });
      try { await agent.write(userMessageLine(claudeSkillText(text, current.skills), images, messageId)); }
      catch (error) { dispatch({ type: "sendFailed", id: messageId, message: `No se pudo enviar la edición: ${formatError(error)}` }); throw error; }
    } finally { editingRef.current = false; }
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
