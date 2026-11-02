import { useEffect, useReducer, useRef, useState } from "react";
import { formatError, installAntigravity, messageQueueMcpConfig, trexDesktopMcpConfig } from "../api";
import { openAntigravity, type AntigravityConnection } from "../antigravityConnection";
import { AntigravityUsageReader, antigravityTier } from "../antigravityUsage";
import { AcpError, acpMcpServer, acpPrompt, validAcpSessionId } from "../acpProtocol";
import { acpConfigs, acpEffortConfig, acpModelConfig, acpModes, antigravityReducer, type AcpConfig } from "../antigravityChat";
import { initialChatState, list, record, text, type Json, type OutgoingImage, type PermissionItem } from "../chatState";
import { connectBrowser } from "../browserConnection";
import { BROWSER_INSTRUCTIONS } from "../browser";
import { integrationContext, integrationInstructions } from "../integrations";
import { FILE_SHARING_INSTRUCTIONS } from "../sharedFiles";
import { INBOX_WAKE, messageQueueId, type QueueReceipt } from "../messageQueue";
import { useMessageQueue } from "./useMessageQueue";
import { localId, type ChatSession, type ChatSessionOptions } from "./chatSession";
import { withChatTimes } from "../chatTimes";
const timedAntigravityReducer = withChatTimes(antigravityReducer);

const INSTRUCTIONS = `${FILE_SHARING_INSTRUCTIONS} ${BROWSER_INSTRUCTIONS} For meaningful multi-step work, use trex_update_tasks on the trex_inbox MCP server to publish and update the chat task list, including in ordinary chats. Use plan:[{step,status}], at most one in_progress. Mark work completed only after verifying it. User messages typed while you work are queued by Trex and delivered as complete subsequent user turns, with their attachments. Do not poll an inbox or claim you received an attachment unless it was delivered.`;
type Approval = { id: string | number; params: Json; turn: string };
type Active = { id: string; done: Promise<void>; cancelled: boolean };
export function useAntigravityChat(options: ChatSessionOptions): ChatSession {
  const [state, dispatch] = useReducer(timedAntigravityReducer, undefined, () => initialChatState(options.mode, options.model, options.effort));
  const [setup, setSetup] = useState<"none" | "runtime" | "auth">("none"), [setupBusy, setSetupBusy] = useState(false);
  const [modes, setModes] = useState<ReturnType<typeof acpModes>>([]);
  const latest = useRef(options); latest.current = options;
  const currentState = useRef(state); currentState.current = state;
  const queue = useMessageQueue(messageQueueId(options.queueId ?? options.sessionId));
  const connection = useRef<AntigravityConnection | null>(null), startup = useRef<Promise<void> | null>(null);
  const alive = useRef(true), generation = useRef(0), conversation = useRef(options.conversationId);
  const session = useRef<string | null>(null), replay = useRef(false), active = useRef<Active | null>(null), sending = useRef(false);
  const configs = useRef<AcpConfig[]>([]), approvals = useRef(new Map<string, Approval>());
  const usageReader = useRef(new AntigravityUsageReader());
  const earlyUpdates = useRef<{ sessionId: string; update: Json }[]>([]);
  const usageRequest = useRef<Promise<void> | null>(null), tier = useRef<string | null>(null);
  const [usageLoading, setUsageLoading] = useState(false), [usageError, setUsageError] = useState<string | null>(null);
  const authMethods = useRef<{ id: string; name: string }[]>([]);
  const controller = useRef<AbortController | null>(null);
  const choices = useRef({ model: options.model, effort: options.effort, mode: options.mode });
  const notice = (tone: "info" | "warn" | "error", value: string): void => { if (alive.current) dispatch({ type: "notice", id: localId(), tone, text: value }); };
  const isCurrent = (token: number): boolean => alive.current && generation.current === token;
  const cancelApprovals = async (): Promise<void> => {
    const rpc = connection.current?.rpc;
    const old = [...approvals.current.values()]; approvals.current.clear();
    if (rpc) await Promise.all(old.map(a => rpc.reply(a.id, { outcome: { outcome: "cancelled" } }).catch(() => undefined)));
  };
  const handleRequest = (id: string | number, method: string, params: Json): void => {
    const rpc = connection.current?.rpc, turn = active.current;
    if (!rpc) return;
    if (method !== "session/request_permission") { void rpc.reject(id).catch(() => undefined); return; }
    if (!turn || turn.cancelled || params.sessionId !== session.current) { void rpc.reply(id, { outcome: { outcome: "cancelled" } }).catch(() => undefined); return; }
    const tool = record(params.toolCall) ?? {}, permissionId = `acp-permission:${typeof id}:${id}`;
    const options = list(params.options).map(record).filter((o): o is Json => !!o && typeof o.optionId === "string" && typeof o.name === "string");
    if (!options.length) { void rpc.reply(id, { outcome: { outcome: "cancelled" } }).catch(() => undefined); return; }
    const question = text(tool.toolCallId).startsWith("interaction_");
    approvals.current.set(permissionId, { id, params, turn: turn.id });
    dispatch({ type: "acpPermission", item: { kind: "permission", id: permissionId, toolName: question ? "AskUserQuestion" : text(tool.title) || "Acción de Antigravity",
      toolUseId: text(tool.toolCallId) || null, input: question ? { questions: [{ id: permissionId, question: text(tool.title) || "Elige una respuesta", options: options.map(o => ({ label: o.name, description: "" })), multiSelect: false, isOther: false }] } : record(tool.rawInput) ?? {},
      description: text(tool.title), suggestions: [], state: "pending", request: { id, method } } });
  };
  const update = (method: string, params: Json): void => {
    if (method !== "session/update" || !validAcpSessionId(params.sessionId)) return;
    const u = record(params.update); if (!u) return;
    if (!session.current && earlyUpdates.current.length < 64 && ["usage_update", "available_commands_update", "current_mode_update", "config_option_update"].includes(text(u.sessionUpdate))) {
      earlyUpdates.current.push({ sessionId: params.sessionId, update: u }); return;
    }
    if (params.sessionId !== session.current || usageReader.current.observe(params.sessionId, u)) return;
    if (u.sessionUpdate === "config_option_update") configs.current = acpConfigs(u.configOptions);
    dispatch({ type: "acpUpdate", sessionId: params.sessionId, update: u, turn: active.current?.id ?? null, replay: replay.current });
  };
  const refreshUsage = async (): Promise<void> => {
    if (usageRequest.current) return usageRequest.current;
    if (active.current || sending.current) throw new Error("Espera a que termine la respuesta para actualizar el uso.");
    const native = connection.current, nativeSession = session.current, token = generation.current;
    if (!native || !nativeSession) throw new Error("Antigravity todavía no está conectado.");
    if (!usageReader.current.supported) return;
    setUsageLoading(true); setUsageError(null);
    const request: Promise<void> = (async () => {
      try {
        const result = await usageReader.current.read(native.rpc, nativeSession, tier.current);
        if (isCurrent(token)) dispatch({ type: "acpUsageSnapshot", sessionId: nativeSession, ...result });
      } catch (error) {
        if (isCurrent(token)) {
          setUsageError(formatError(error));
          if (/no respondió a session\/prompt/.test(formatError(error))) {
            generation.current++; startup.current = null; session.current = null; connection.current = null;
            await native.close(); dispatch({ type: "spawnFailed", message: "La consulta de uso no terminó. Reconecta Antigravity para continuar." });
          }
        }
      }
    })();
    usageRequest.current = request;
    void request.finally(() => { if (usageRequest.current === request) { usageRequest.current = null; if (alive.current) setUsageLoading(false); } }).catch(() => undefined);
    return request;
  };
  const applyChoice = async (kind: "model" | "effort", value: string): Promise<void> => {
    const token = generation.current, native = connection.current, nativeSession = session.current;
    const config = kind === "model" ? acpModelConfig(configs.current) : acpEffortConfig(configs.current);
    if (!session.current || !connection.current || !config?.options.some(o => o.value === value)) throw new Error("Esta elección no está disponible en Antigravity.");
    const result = await connection.current.rpc.call("session/set_config_option", { sessionId: session.current, configId: config.id, value });
    if (!isCurrent(token) || connection.current !== native || session.current !== nativeSession) throw new Error("La sesión cambió antes de confirmar la configuración.");
    configs.current = acpConfigs(result.configOptions);
    if (!configs.current.length) throw new Error("Antigravity no confirmó la configuración elegida.");
    if (configs.current.find(c => c.id === config.id)?.currentValue !== value) throw new Error("Antigravity no confirmó el valor solicitado; se conserva la configuración real del servidor.");
    dispatch({ type: "acpUpdate", sessionId: session.current, turn: null, replay: true, update: { sessionUpdate: "config_option_update", configOptions: result.configOptions } });
    dispatch(kind === "model" ? { type: "model", model: value } : { type: "effort", effort: value });
  };
  const start = (): Promise<void> => {
    if (startup.current) return startup.current;
    const token = generation.current, current = latest.current;
    startup.current = (async () => {
      if (current.planningOnly || current.team) throw new Error("Antigravity todavía no está habilitado como planificador ni coordinador de equipos: sus restricciones de solo lectura requieren validación.");
      if (current.args?.trim()) throw new Error("Los argumentos de agy no se aplican al servidor ACP. Usa un perfil Antigravity sin argumentos y elige el modelo dentro del chat.");
      if (!connection.current) {
        usageReader.current = new AntigravityUsageReader(); earlyUpdates.current = []; tier.current = null;
        controller.current = new AbortController();
        const native = await openAntigravity(current.command ?? "antigravity-acp", current.env?.GEMINI_HOME ?? "", current.cwd, {
          notification: (m, p) => { if (isCurrent(token)) update(m, p); }, request: (id, m, p) => { if (isCurrent(token)) handleRequest(id, m, p); },
          stderr: line => { if (isCurrent(token)) dispatch({ type: "stderr", line }); },
          exit: code => { if (isCurrent(token)) { generation.current++; connection.current = null; startup.current = null; session.current = null; active.current = null; approvals.current.clear(); dispatch({ type: "exit", code }); latest.current.onExit(latest.current.sessionId, code); } },
        }, controller.current.signal);
        if (!isCurrent(token)) { await native.close(); throw new Error("La conexión se sustituyó."); }
        connection.current = native;
        authMethods.current = list(native.init.authMethods).map(record).filter((v): v is Json => !!v && typeof v.id === "string" && /^oauth-(personal|business)$/.test(v.id))
          .map(v => ({ id: text(v.id), name: text(v.name) }));
      }
      const native = connection.current;
      const browser = await connectBrowser(current.browser, current.cwd, null, false, "", message => notice("warn", message));
      const tasks = await messageQueueMcpConfig(messageQueueId(current.queueId ?? current.sessionId), true);
      const servers = [acpMcpServer("trex_inbox", { command: text(tasks["mcp_servers.trex_inbox.command"]), args: tasks["mcp_servers.trex_inbox.args"] as string[] }),
        ...(browser ? [acpMcpServer("trex_browser", browser)] : []), ...(current.desktopEnabled ? [acpMcpServer("trex_desktop", await trexDesktopMcpConfig("full"))] : [])];
      if (!isCurrent(token)) throw new Error("Se canceló la conexión.");
      const capabilities = record(native.init.agentCapabilities);
      const saved = conversation.current;
      if (saved && capabilities?.loadSession !== true) throw new Error("Este componente no permite recuperar el historial. La conversación se conserva.");
      session.current = saved;
      replay.current = !!saved;
      if (saved) dispatch({ type: "acpHistoryStart", sessionId: saved });
      let result: Json;
      try { result = await native.rpc.call(saved ? "session/load" : "session/new", { cwd: current.cwd, mcpServers: servers, ...(saved ? { sessionId: saved } : {}) }); }
      finally { replay.current = false; }
      if (!isCurrent(token)) throw new Error("La sesión se sustituyó.");
      const nativeId = saved ?? result.sessionId;
      if (!validAcpSessionId(nativeId)) throw new Error("Antigravity no devolvió un identificador de conversación válido.");
      session.current = nativeId; conversation.current = nativeId;
      tier.current = antigravityTier(result);
      configs.current = acpConfigs(result.configOptions); const availableModes = acpModes(result.modes); setModes(availableModes);
      dispatch({ type: "acpReady", sessionId: nativeId, result, history: !!saved });
      for (const pending of earlyUpdates.current.splice(0)) if (pending.sessionId === nativeId) update("session/update", pending);
      setSetup("none");
      if (choices.current.model && acpModelConfig(configs.current)?.currentValue !== choices.current.model) await applyChoice("model", choices.current.model);
      if (choices.current.effort && acpEffortConfig(configs.current)?.currentValue !== choices.current.effort) await applyChoice("effort", choices.current.effort);
      if (choices.current.mode && availableModes.some(m => m.value === choices.current.mode) && record(result.modes)?.currentModeId !== choices.current.mode) {
        await native.rpc.call("session/set_mode", { sessionId: nativeId, modeId: choices.current.mode });
        dispatch({ type: "mode", mode: choices.current.mode });
      }
      latest.current.onRunning(latest.current.sessionId);
    })().catch(error => {
      if (isCurrent(token)) {
        startup.current = null;
        const message = formatError(error);
        if (/componente ACP oficial/.test(message)) setSetup("runtime");
        else if (error instanceof AcpError && (error.code === -32000 || /auth|login|sign.?in|autentic/i.test(message))) setSetup("auth");
        dispatch({ type: "spawnFailed", message });
      }
      throw error;
    });
    return startup.current;
  };
  const send = async (value: string, images: OutgoingImage[], previews: string[], display?: string): Promise<boolean> => {
    if (sending.current || active.current || !alive.current) return false;
    sending.current = true;
    const token = generation.current;
    let receipt: QueueReceipt | null = null;
    try {
      await start(); await usageRequest.current; if (!isCurrent(token) || !connection.current || !session.current) return false;
      if (value === INBOX_WAKE) {
        receipt = (await queue.client.read()).receipt;
        if (!receipt?.messages.length) return true;
        value = `Mensajes del usuario en cola. Recibo: ${receipt.id}. Procesa este recibo una sola vez.\n\n${receipt.messages.map((m, i) => `Mensaje ${i + 1} (${m.id}):\n${m.text}`).join("\n\n")}`;
        images = receipt.messages.flatMap(m => m.images); previews = receipt.messages.flatMap(m => m.previews); display = "Mensajes en cola";
      }
      const imageSupported = record(record(connection.current.init.agentCapabilities)?.promptCapabilities)?.image === true;
      const prompt = receipt ? [{ type: "text", text: `Mensajes del usuario en cola. Recibo: ${receipt.id}. Procesa este recibo una sola vez.` },
        ...receipt.messages.flatMap((m, i) => acpPrompt(`Mensaje ${i + 1} (${m.id}):\n${m.text}`, m.images, imageSupported))]
        : acpPrompt(value, images, imageSupported);
      // Explicit context travels as text, including on resume; no private or undocumented injection channel.
      prompt.unshift({ type: "text", text: `<trex_context>\n${INSTRUCTIONS} ${integrationInstructions("antigravity", integrationContext(latest.current))}${latest.current.planningInstruction ? `\n${latest.current.planningInstruction}` : ""}\n</trex_context>` });
      const id = localId(), native = connection.current, nativeSession = session.current;
      dispatch({ type: "send", id, text: display ?? value, previews, now: Date.now() });
      let settle!: () => void;
      active.current = { id, cancelled: false, done: new Promise<void>(resolve => { settle = resolve; }) };
      const request = native.rpc.issue("session/prompt", { sessionId: nativeSession, prompt }, 0);
      void request.result.then(async result => {
        if (!isCurrent(token) || active.current?.id !== id) return;
        if (!["end_turn", "max_tokens", "max_turn_requests", "refusal", "cancelled"].includes(text(result.stopReason))) throw new Error("Antigravity no confirmó el final del turno. Revisa la conversación antes de reenviar.");
        if (receipt && result.stopReason !== "cancelled" && !active.current.cancelled) {
          try { await queue.client.ack(receipt.id, () => isCurrent(token)); if (isCurrent(token)) dispatch({ type: "acpReceipt", id, messages: receipt.messages }); }
          catch (error) { notice("warn", `La respuesta llegó, pero la confirmación de la cola sigue pendiente: ${formatError(error)}`); }
        }
        void cancelApprovals(); active.current = null;
        dispatch({ type: "acpFinished", id, result, now: Date.now() });
      }).catch(error => { if (isCurrent(token)) {
        if (active.current?.id === id) { void cancelApprovals(); active.current = null; }
        if (error instanceof AcpError && error.code === -32000) { setSetup("auth"); startup.current = null; }
        dispatch({ type: "acpFinished", id, error: formatError(error), now: Date.now() });
      } })
        .finally(() => { settle(); if (active.current?.id === id) { active.current = null; void cancelApprovals(); } });
      await request.written;
      return true;
    } catch (error) { notice("error", formatError(error)); return false; }
    finally { sending.current = false; }
  };
  const interrupt = (): void => {
    const turn = active.current;
    if (!turn || !session.current || !connection.current) {
      if (sending.current) { generation.current++; controller.current?.abort(); void connection.current?.close(); connection.current = null; startup.current = null; session.current = null; }
      return;
    }
    turn.cancelled = true; dispatch({ type: "interruptSend", id: turn.id });
    void cancelApprovals();
    void connection.current.rpc.notify("session/cancel", { sessionId: session.current }).catch(error => notice("error", formatError(error)));
  };
  const restart = async (): Promise<void> => {
    if (active.current) { notice("info", "Detén la respuesta antes de reconectar Antigravity."); return; }
    generation.current++; controller.current?.abort();
    await connection.current?.close(); connection.current = null; startup.current = null; session.current = null;
    dispatch({ type: "spawned" }); setUsageError(null);
    await start();
  };
  const hasUsageCommand = state.commands.some(command => command.name === "usage");
  useEffect(() => {
    if (state.process === "ready" && !state.pendingTurns && !sending.current && !active.current && usageReader.current.supported)
      void refreshUsage().catch(() => undefined);
  }, [state.process, state.sessionId, state.lastCompletion, hasUsageCommand]);
  useEffect(() => { if (options.visible) void start().catch(() => undefined); }, [options.visible]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; generation.current++; controller.current?.abort(); void cancelApprovals(); void connection.current?.close(); }; }, []);
  const setupActions = setup === "runtime" ? [{ label: "Instalar componente oficial", run: async () => { setSetupBusy(true); try { await installAntigravity(); await restart(); } catch (error) { notice("error", formatError(error)); } finally { if (alive.current) setSetupBusy(false); } } }]
    : setup === "auth" ? authMethods.current.map(method => ({ label: method.id === "oauth-business" ? "Conectar Gemini Enterprise" : "Iniciar sesión con Google", run: async () => {
      if (!connection.current || setupBusy) return;
      setSetupBusy(true); try { await connection.current.rpc.call("authenticate", { methodId: method.id }, 600_000); startup.current = null; await start(); }
      catch (error) { notice("error", formatError(error)); } finally { if (alive.current) setSetupBusy(false); }
    } })) : [];
  return { provider: "antigravity", state, queue, start: restart, send, interrupt, notice,
    usageControls: { loading: usageLoading, error: usageError, refresh: refreshUsage },
    async sendNow(value, images, previews, display) {
      const previous = active.current, token = generation.current;
      if (previous) {
        interrupt(); let timer: ReturnType<typeof setTimeout> | undefined;
        try { await Promise.race([previous.done, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Antigravity no confirmó la interrupción. Revisa la conversación antes de reenviar.")), 30_000); })]); }
        finally { clearTimeout(timer); }
      }
      return isCurrent(token) ? send(value, images, previews, display) : false;
    },
    modes, setup: setupActions.length ? { busy: setupBusy, description: setup === "runtime" ? "Descarga verificada de Google. Tu instalación de agy se conserva." : "Conecta la cuenta de Google que quieres usar en Trex.", actions: setupActions } : undefined,
    reset() { if (active.current) { notice("info", "Detén el agente antes de crear una conversación."); return; } conversation.current = null; dispatch({ type: "reset" }); void restart().catch(error => notice("error", formatError(error))); },
    edit: async () => { throw new Error("Antigravity no anuncia edición o bifurcación del historial. Envía una corrección nueva."); },
    runCommand(name) { if (name === "new" || name === "clear") { if (active.current) interrupt(); else { conversation.current = null; dispatch({ type: "reset" }); void restart().catch(error => notice("error", formatError(error))); } return true; } return false; },
    refreshSkills: async () => undefined,
    answer(item: PermissionItem, allowed, remember, choices) {
      const entry = approvals.current.get(item.id), native = connection.current;
      if (!entry || !native || active.current?.id !== entry.turn || active.current.cancelled || item.state !== "pending") return;
      const options = list(entry.params.options).map(record).filter((o): o is Json => !!o);
      const question = item.toolName === "AskUserQuestion";
      const chosen = question ? options.find(o => o.name === choices?.[0]?.selected[0])
        : options.find(o => o.kind === (allowed ? remember ? "allow_always" : "allow_once" : remember ? "reject_always" : "reject_once"))
          ?? options.find(o => o.kind === (allowed ? "allow_once" : "reject_once"));
      if (!chosen || typeof chosen.optionId !== "string") { notice("error", "Antigravity no ofreció una opción compatible; no se concedió permiso."); return; }
      approvals.current.delete(item.id);
      void native.rpc.reply(entry.id, { outcome: { outcome: "selected", optionId: chosen.optionId } }).then(() => dispatch({ type: "answer", id: item.id, allowed }))
        .catch(error => notice("error", formatError(error)));
    },
    setMode(mode) {
      if (active.current || !session.current || !connection.current || !modes.some(m => m.value === mode)) { notice("info", "Espera a que termine la respuesta para cambiar permisos."); return; }
      const token = generation.current;
      void connection.current.rpc.call("session/set_mode", { sessionId: session.current, modeId: mode }).then(() => { if (isCurrent(token)) { choices.current.mode = mode; dispatch({ type: "mode", mode }); } }).catch(error => notice("error", formatError(error)));
    },
    setModel(model) { if (active.current) { notice("info", "Espera a que termine la respuesta para cambiar el modelo."); return; } void applyChoice("model", model).then(() => { choices.current.model = model; }).catch(error => notice("error", formatError(error))); },
    setEffort(effort) { if (active.current) { notice("info", "Espera a que termine la respuesta para cambiar el esfuerzo."); return; } void applyChoice("effort", effort).then(() => { choices.current.effort = effort; }).catch(error => notice("error", formatError(error))); },
    setFast: () => undefined,
  };
}
