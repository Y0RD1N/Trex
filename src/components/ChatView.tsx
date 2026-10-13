/**
 * ChatView: sesión de Claude Code o de Codex como conversación.
 *
 * El proveedor corre en el backend sin terminal (`claude -p` con stream-json o
 * `codex app-server`); su hook traduce el protocolo a un estado común y esta
 * vista pinta el hilo, la caja de texto y la bandeja de ajustes. Igual que
 * TerminalView, se monta una vez por pestaña y el padre la oculta con
 * display:none, así que el proceso y el hilo se conservan al cambiar de sesión.
 */
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { formatError, gitBranch, listProjectFiles, readClipboard } from "../api";
import { MAX_IMAGES, prepareImage, readClipboardImage, readImageFile, type ChatAttachment } from "../chatImages";
import { matchesPasteShortcut } from "../paste";
import {
  chatActivity, contextPercent, conversationTitle, currentModel, effortLabel, formatDuration, formatTokens, modelName, pendingPermissions,
  shownUsage, supportedEfforts, type PermissionItem, type QuestionChoice,
} from "../chatState";
import { applySuggestion, buildSuggestions, findTrigger, localCommand, parseCommand, type Suggestion } from "../chatCommands";
import type { AgentActivity, AgentNoticeKind, AgentProvider, Settings } from "../types";
import { MIN_WORK_MS } from "../agentNotices";
import type { ChatSession, ChatSessionOptions } from "../hooks/chatSession";
import { useClaudeChat } from "../hooks/useClaudeChat";
import { useCodexChat } from "../hooks/useCodexChat";
import AgentIcon from "./AgentIcon";
import Select, { type SelectOption } from "./Select";
import { AlertIcon, ArrowDownIcon, ArrowUpIcon, BranchIcon, CloseIcon, MapIcon, PaperclipIcon, PencilIcon, ShieldIcon, StopIcon } from "./Icons";
import { AssistantText, Notice, PermissionCard, QuestionCard, Thinking, ToolRow, UserMessage } from "./chat/ChatItems";
import { EffortMenu, ModelMenu } from "./chat/ModelMenu";
import ContextMeter from "./chat/ContextMeter";
import Suggestions from "./chat/Suggestions";
import "./ChatView.css";

export type ChatViewProps = ChatSessionOptions & {
  provider: AgentProvider;
  projectName: string;
  settings: Settings;
  visible: boolean;
  focused: boolean;
  onActivity: (tabId: string, activity: AgentActivity) => void;
  onNotice: (tabId: string, kind: AgentNoticeKind) => void;
  onConversation: (tabId: string, conversationId: string) => void;
  onTitle: (tabId: string, title: string) => void;
  /** Modo de permisos elegido: se guarda con la pestaña. */
  onMode: (tabId: string, provider: AgentProvider, mode: string) => void;
  /** Aviso pasajero (toast) para lo que no debe quedar en el hilo. */
  onMessage: (message: string) => void;
};

const PROVIDERS: Record<AgentProvider, { name: string; product: string; defaultMode: string; modes: SelectOption[]; otherModes: Record<string, string> }> = {
  claude: {
    name: "Claude", product: "Claude Code", defaultMode: "default",
    modes: [
      { value: "default", label: "Preguntar", description: "Pide permiso antes de editar o ejecutar", icon: <ShieldIcon size={13} /> },
      { value: "acceptEdits", label: "Aceptar ediciones", description: "Edita sin preguntar; pide permiso para comandos", icon: <PencilIcon size={13} /> },
      { value: "plan", label: "Planificar", description: "Investiga y propone un plan sin cambiar nada", icon: <MapIcon size={13} /> },
      { value: "bypassPermissions", label: "Permitir todo", description: "Edita y ejecuta sin preguntar nunca; úsalo con cuidado", icon: <AlertIcon size={13} /> },
    ],
    otherModes: { auto: "Automático", dontAsk: "No preguntar" },
  },
  codex: {
    name: "Codex", product: "Codex", defaultMode: "auto",
    modes: [
      { value: "read-only", label: "Solo lectura", description: "Lee el proyecto y pide permiso para editar o ejecutar", icon: <ShieldIcon size={13} /> },
      { value: "auto", label: "Automático", description: "Edita y ejecuta dentro del proyecto; pregunta antes de salir", icon: <PencilIcon size={13} /> },
      { value: "plan", label: "Planificar", description: "Investiga y propone un plan sin cambiar nada", icon: <MapIcon size={13} /> },
      { value: "full", label: "Permitir todo", description: "Acceso total, sin preguntar nunca; úsalo con cuidado", icon: <AlertIcon size={13} /> },
    ],
    otherModes: {},
  },
};

/** Atajos que ya pegan de forma nativa en una caja de texto. */
const NATIVE_PASTE = ["Ctrl+V", "Meta+V", "Shift+Insert"];
const hasFiles = (transfer: DataTransfer | null): boolean => !!transfer && Array.from(transfer.types).includes("Files");
/** Los archivos del proyecto se vuelven a leer si la lista tiene más de esto. */
const FILES_TTL_MS = 20_000;

function ChatPanel(props: ChatViewProps & { session: ChatSession }) {
  const { session, sessionId, cwd, projectName, conversationId, settings, visible, focused } = props;
  const { state, provider } = session;
  const agent = PROVIDERS[provider];
  const [draft, setDraft] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const [atBottom, setAtBottom] = useState(true);
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [preparing, setPreparing] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [branch, setBranch] = useState<string | null>(null);
  // Sugerencias de `@`, `/` y `$`: posición del cursor, opción resaltada y menú descartado con Esc.
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [files, setFiles] = useState<string[] | null>(null);
  const filesAtRef = useRef(0);
  /** Abre un menú de la bandeja desde un comando (`/model`, `/effort`, `/permissions`). */
  const [menuSignal, setMenuSignal] = useState({ model: 0, effort: 0, mode: 0 });

  const callbacks = useRef(props);
  callbacks.current = props;
  const titledRef = useRef(conversationId !== null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickRef = useRef(true);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLDivElement | null>(null);

  // Estado hacia la app: actividad, avisos, conversación y título.
  const activity = chatActivity(state);
  const permissions = pendingPermissions(state);
  const previous = useRef({ activity: "idle" as AgentActivity, permissions: 0 });
  useEffect(() => { callbacks.current.onActivity(sessionId, activity); }, [activity, sessionId]);
  useEffect(() => {
    const before = previous.current;
    if (permissions > before.permissions) callbacks.current.onNotice(sessionId, "attention");
    if (before.activity !== "idle" && activity === "idle" && state.process !== "exited") {
      const last = state.items[state.items.length - 1];
      if (last?.kind === "notice" && last.tone === "error") callbacks.current.onNotice(sessionId, "error");
      else if (last?.kind === "turn" && last.durationMs >= MIN_WORK_MS) callbacks.current.onNotice(sessionId, "ready");
    }
    previous.current = { activity, permissions };
  }, [activity, permissions, sessionId, state.items, state.process]);

  // La conversación se guarda en cuanto tiene un mensaje (Codex abre el hilo antes).
  const hasMessages = state.items.some(item => item.kind === "user");
  useEffect(() => {
    if (state.sessionId && hasMessages && state.sessionId !== callbacks.current.conversationId) callbacks.current.onConversation(sessionId, state.sessionId);
  }, [state.sessionId, hasMessages, sessionId]);

  // Reloj para el tiempo de trabajo del turno en curso.
  useEffect(() => {
    if (state.turnStartedAt === null) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [state.turnStartedAt]);

  // Desplazamiento: sigue el final mientras la persona no haya subido a leer.
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (element && stickRef.current && visible) element.scrollTop = element.scrollHeight;
  }, [state.items, state.pendingTurns, visible]);

  const onScroll = (): void => {
    const element = scrollRef.current;
    if (!element) return;
    const bottom = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
    stickRef.current = bottom;
    setAtBottom(bottom);
  };
  const scrollToBottom = (): void => {
    stickRef.current = true;
    setAtBottom(true);
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  };

  // Foco en la caja de texto al activar la sesión.
  useEffect(() => {
    if (visible && focused && !document.querySelector(".dialog-card, [role='dialog']")) {
      inputRef.current?.focus({ preventScroll: true });
    }
  }, [visible, focused]);

  // La caja flota sobre el hilo: el hilo deja debajo el hueco que ocupa la caja.
  useLayoutEffect(() => {
    const composer = composerRef.current, root = rootRef.current;
    if (!composer || !root) return;
    const observer = new ResizeObserver(() => {
      root.style.setProperty("--composer-space", `${composer.offsetHeight}px`);
      const scroller = scrollRef.current;
      if (scroller && stickRef.current) scroller.scrollTop = scroller.scrollHeight;
    });
    observer.observe(composer);
    return () => observer.disconnect();
  }, []);

  // La caja crece con el texto hasta un tope.
  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, Math.round(window.innerHeight * 0.4))}px`;
  }, [draft]);

  const running = state.pendingTurns > 0;

  // Rama de git: al mostrar la sesión y al terminar cada respuesta (el asistente puede cambiarla).
  useEffect(() => {
    if (!visible || running) return;
    let cancelled = false;
    void gitBranch(cwd).then(name => { if (!cancelled) setBranch(name); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [cwd, visible, running]);

  /** Prepara y añade imágenes a la caja (capturas, archivos o arrastradas). */
  const addImages = async (sources: (Blob | { mediaType: string; data: string; name: string })[]): Promise<void> => {
    const room = MAX_IMAGES - attachments.length;
    if (room <= 0) {
      callbacks.current.onMessage(`Puedes adjuntar hasta ${MAX_IMAGES} imágenes por mensaje.`);
      return;
    }
    setPreparing(count => count + Math.min(room, sources.length));
    for (const source of sources.slice(0, room)) {
      try {
        const image = await prepareImage(source);
        setAttachments(previous => previous.length < MAX_IMAGES ? [...previous, image] : previous);
      } catch (error) {
        callbacks.current.onMessage(formatError(error));
      } finally {
        setPreparing(count => Math.max(0, count - 1));
      }
    }
    inputRef.current?.focus({ preventScroll: true });
  };

  const pasteFromClipboard = async (): Promise<void> => {
    const image = await readClipboardImage().catch(() => null);
    if (image) return addImages([image]);
    const content = await readClipboard().catch(() => null);
    const input = inputRef.current;
    if (content?.kind !== "text" || !content.text || !input) return;
    const { selectionStart, selectionEnd } = input;
    setDraft(value => value.slice(0, selectionStart) + content.text + value.slice(selectionEnd));
    requestAnimationFrame(() => input.setSelectionRange(selectionStart + content.text.length, selectionStart + content.text.length));
  };

  const attachFiles = async (): Promise<void> => {
    const selected = await open({ multiple: true, title: "Adjuntar imágenes",
      filters: [{ name: "Imágenes", extensions: ["png", "jpg", "jpeg", "gif", "webp"] }] }).catch(() => null);
    const paths = Array.isArray(selected) ? selected : selected ? [selected] : [];
    const files = [];
    for (const path of paths) {
      try { files.push(await readImageFile(path)); }
      catch (error) { callbacks.current.onMessage(formatError(error)); }
    }
    if (files.length) await addImages(files);
  };

  const mode = state.permissionMode === "manual" ? "default" : state.permissionMode ?? agent.defaultMode;
  // El modo elegido se guarda con la pestaña: sigue igual al volver a abrir la app.
  useEffect(() => {
    if (state.modeChoice) callbacks.current.onMode(sessionId, provider, state.modeChoice);
  }, [state.modeChoice, sessionId, provider]);
  /** Modo de trabajo al que se vuelve al poner en marcha un plan. */
  const workModeRef = useRef(mode === "plan" ? agent.defaultMode : mode);
  useEffect(() => { if (mode !== "plan") workModeRef.current = mode; }, [mode]);
  const modeOptions = agent.modes.some(option => option.value === mode) ? agent.modes
    : [...agent.modes, { value: mode, label: agent.otherModes[mode] ?? mode, icon: <ShieldIcon size={13} /> }];
  const efforts = supportedEfforts(state.models, state.model, state.modelChoice);
  const usage = shownUsage(state);

  const statusText = (): string => {
    const model = currentModel(state.models, state.model, state.modelChoice);
    const percent = contextPercent(usage);
    return [
      `Estado de ${agent.product}`,
      `Modelo: ${model ? modelName(model) : state.model ?? "sin datos"}`,
      ...(state.effort ? [`Esfuerzo: ${effortLabel(state.effort)}`] : []),
      `Permisos: ${modeOptions.find(option => option.value === mode)?.label ?? mode}`,
      ...(usage ? [`Contexto: ${formatTokens(usage.used)} tokens${usage.window ? ` de ${formatTokens(usage.window)} (${Math.round(percent ?? 0)} %)` : ""}`] : []),
      ...(state.sessionId ? [`Conversación: ${state.sessionId}`] : []),
    ].join("\n");
  };

  /** Comandos que resuelve el chat; el resto se envía al asistente como mensaje. */
  const runLocal = (name: string, args: string): boolean => {
    const local = localCommand(provider, name);
    if (!local) return false;
    stickRef.current = true;
    const wanted = args.toLowerCase();
    switch (local) {
      case "clear": case "new":
        session.reset();
        titledRef.current = false;
        return true;
      case "model": {
        const match = wanted ? state.models.find(model => model.value.toLowerCase() === wanted || model.displayName.toLowerCase() === wanted) : null;
        if (match) session.setModel(match.value);
        else setMenuSignal(signal => ({ ...signal, model: signal.model + 1 }));
        return true;
      }
      case "effort":
        if (efforts.includes(wanted)) session.setEffort(wanted);
        else if (efforts.length) setMenuSignal(signal => ({ ...signal, effort: signal.effort + 1 }));
        else session.notice("info", "El modelo elegido no tiene niveles de esfuerzo.");
        return true;
      case "permissions":
        setMenuSignal(signal => ({ ...signal, mode: signal.mode + 1 }));
        return true;
      case "status":
        session.notice("info", statusText());
        return true;
      default:
        return session.runCommand(local, args);
    }
  };

  const send = (override?: string): void => {
    const text = (override ?? draft).trim();
    if ((!text && !attachments.length) || preparing > 0) return;
    const command = attachments.length ? null : parseCommand(text);
    setDismissed(null);
    if (command && runLocal(command.name, command.args)) {
      setDraft("");
      return;
    }
    const images = attachments;
    setDraft("");
    setAttachments([]);
    stickRef.current = true;
    // Un comando no da título a la conversación: lo dará el primer mensaje de verdad.
    if (!titledRef.current && !command) {
      titledRef.current = true;
      callbacks.current.onTitle(sessionId, conversationTitle(text || (images.length === 1 ? "Imagen" : "Imágenes")));
    }
    session.send(text, images.map(({ mediaType, data }) => ({ mediaType, data })), images.map(image => image.preview));
  };

  // --- Sugerencias ------------------------------------------------------------
  const trigger = findTrigger(draft, caret, provider === "codex" ? "@/$" : "@/");
  const triggerKey = trigger ? `${trigger.char}:${trigger.start}` : null;
  const suggesting = trigger !== null && triggerKey !== dismissed;
  const wantsFiles = suggesting && trigger?.char === "@";
  const suggestions = useMemo(() => suggesting && trigger
    ? buildSuggestions(trigger, { provider, files, agents: state.agents, commands: state.commands, skills: state.skills }) : [],
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [suggesting, trigger?.char, trigger?.query, provider, files, state.agents, state.commands, state.skills]);
  const showSuggestions = suggesting && (suggestions.length > 0 || (wantsFiles && files === null));

  useEffect(() => { setActive(0); }, [trigger?.char, trigger?.query]);

  // La lista de archivos se lee al escribir `@` y se refresca si es antigua.
  useEffect(() => {
    if (!wantsFiles || Date.now() - filesAtRef.current < FILES_TTL_MS) return;
    filesAtRef.current = Date.now();
    void listProjectFiles(cwd).then(setFiles).catch(() => setFiles(previous => previous ?? []));
  }, [wantsFiles, cwd]);

  /** Pone la sugerencia en el mensaje; una carpeta con Tab sigue abierta para entrar en ella. */
  const pick = (item: Suggestion, drill: boolean): void => {
    if (!trigger) return;
    if (item.kind === "command" && item.run) {
      send(item.insert.trim());
      return;
    }
    const next = applySuggestion(draft, trigger, item.kind === "folder" && !drill ? `${item.insert} ` : item.insert);
    setDraft(next.text);
    setCaret(next.caret);
    setActive(0);
    requestAnimationFrame(() => {
      const input = inputRef.current;
      if (!input) return;
      input.focus({ preventScroll: true });
      input.setSelectionRange(next.caret, next.caret);
    });
  };

  const answer = (item: PermissionItem, allowed: boolean, remember: boolean, choices?: QuestionChoice[]): void => {
    session.answer(item, allowed, remember, choices);
    inputRef.current?.focus({ preventScroll: true });
  };

  // Tras elegir en un selector, se sigue escribiendo en la caja.
  const backToInput = (): void => { requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true })); };

  // Las filas de herramientas con un permiso pendiente se sustituyen por la tarjeta.
  const askingFor = new Set(state.items.flatMap(item => item.kind === "permission" && item.state === "pending" && item.toolUseId ? [item.toolUseId] : []));
  const asked = (id: string): boolean => askingFor.has(id) || askingFor.has(id.split("#")[0]);
  const lastItem = state.items[state.items.length - 1];
  const thinking = !lastItem || lastItem.kind === "user" || lastItem.kind === "thinking";
  const empty = state.items.length === 0;
  // Solo la lista de tareas y el plan más recientes se muestran enteros; los anteriores quedan plegados.
  const latest = (name: string): string | undefined => [...state.items].reverse().find(item => item.kind === "tool" && item.name === name)?.id;
  const latestTodos = latest("TodoWrite");
  const latestPlan = provider === "codex" ? latest("ExitPlanMode") : undefined;
  // El plan se puede poner en marcha cuando es lo último que propuso Codex.
  const planReady = !running && mode === "plan" && latestPlan !== undefined
    && !state.items.slice(state.items.findIndex(item => item.id === latestPlan) + 1).some(item => item.kind === "user");
  const implementPlan = (): void => {
    session.setMode(workModeRef.current);
    stickRef.current = true;
    session.send("Implementa el plan.", [], []);
  };
  const stderrTail = state.stderr.slice(-6).join("\n");

  return <div ref={rootRef} className={`chat${empty ? " is-empty" : ""}${dragging ? " is-dragging" : ""}`}
    style={{ "--chat-font-size": `${settings.fontSize}px` } as CSSProperties}
    onDragOver={event => { if (hasFiles(event.dataTransfer)) { event.preventDefault(); setDragging(true); } }}
    onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }}
    onDrop={event => {
      if (!hasFiles(event.dataTransfer)) return;
      event.preventDefault();
      setDragging(false);
      const files = Array.from(event.dataTransfer.files);
      const images = files.filter(file => file.type.startsWith("image/"));
      if (images.length < files.length) callbacks.current.onMessage("Solo se pueden adjuntar imágenes.");
      if (images.length) void addImages(images);
    }}>
    <div className="chat-scroll" ref={scrollRef} onScroll={onScroll}>
      <div className="chat-thread">
        {empty && <div className="chat-empty">
          <AgentIcon kind={provider} size={30} activity={activity} />
          <h2>¿En qué trabajamos en {projectName}?</h2>
          <p>{cwd}</p>
        </div>}
        {state.items.map((item, index) => {
          const next = state.items[index + 1];
          switch (item.kind) {
            case "user": return <UserMessage key={item.id} text={item.text} images={item.images} previews={item.previews} />;
            case "text": return item.text.trim() ? <AssistantText key={item.id} text={item.text} streaming={!item.final}
              actions={item.final && (next ? next.kind === "turn" || next.kind === "user" : !running)} /> : null;
            case "thinking": return <Thinking key={item.id} text={item.text} />;
            case "tool": return asked(item.id) ? null : <ToolRow key={item.id} item={item} cwd={cwd}
              expanded={item.id === latestTodos || item.id === latestPlan}
              onImplement={item.id === latestPlan && planReady ? implementPlan : undefined} />;
            case "permission": return item.state !== "pending" ? null
              : item.toolName === "AskUserQuestion" ? <QuestionCard key={item.id} item={item} agent={agent.name} onAnswer={answer} />
              : <PermissionCard key={item.id} item={item} cwd={cwd} agent={agent.name} onAnswer={answer} />;
            case "notice": return <Notice key={item.id} tone={item.tone} text={item.text} />;
            case "turn": return <div key={item.id} className="chat-turn">Listo en {formatDuration(item.durationMs)}</div>;
          }
        })}
        {running && permissions === 0 && <div className="chat-working" role="status">
          <span className="chat-working-dot" aria-hidden="true" />
          <span className="chat-working-label">{thinking ? "Pensando…" : "Trabajando…"}</span>
          {state.turnStartedAt !== null && <span className="chat-working-time">{formatDuration(now - state.turnStartedAt)}</span>}
          <span className="chat-working-hint">Esc para detener</span>
        </div>}
        {(state.process === "exited" || state.process === "failed") && <div className="chat-ended">
          <div>
            <strong>{state.process === "failed" ? `${agent.product} no pudo arrancar` : `La sesión de ${agent.product} se cerró`}</strong>
            {state.exitCode !== null && state.exitCode !== 0 && <span> · código {state.exitCode}</span>}
          </div>
          {stderrTail && <pre>{stderrTail}</pre>}
          <button type="button" className="btn btn-small" onClick={() => void session.start()}>
            {state.process === "failed" ? "Reintentar" : "Reanudar conversación"}
          </button>
        </div>}
      </div>
    </div>

    {!atBottom && !empty && <button type="button" className="chat-to-bottom" onClick={scrollToBottom}>
      <ArrowDownIcon size={13} /> Ir al final
    </button>}

    <div className="chat-composer-wrap" ref={composerRef}>
     <div className="chat-dock">
      {showSuggestions && <Suggestions id={`${sessionId}-suggestions`} items={suggestions} active={active} loading={files === null}
        onPick={pick} onHover={setActive} />}
      <form className="chat-composer" onSubmit={event => { event.preventDefault(); send(); }}>
        {(attachments.length > 0 || preparing > 0) && <div className="chat-attachments">
          {attachments.map(image => <div key={image.id} className="chat-attachment">
            <img src={image.preview} alt={image.name} />
            <button type="button" className="chat-attachment-remove" aria-label={`Quitar ${image.name}`}
              onClick={() => setAttachments(previous => previous.filter(item => item.id !== image.id))}><CloseIcon size={11} strokeWidth={2.2} /></button>
          </div>)}
          {Array.from({ length: preparing }, (_, index) => <div key={`loading-${index}`} className="chat-attachment loading" aria-label="Preparando imagen">
            <span className="chat-spinner" />
          </div>)}
        </div>}
        <div className="chat-input-row">
        <textarea ref={inputRef} rows={1} value={draft} aria-label={`Mensaje para ${agent.name}`}
          aria-autocomplete="list" aria-expanded={showSuggestions} aria-controls={showSuggestions ? `${sessionId}-suggestions` : undefined}
          aria-activedescendant={showSuggestions && suggestions.length ? `${sessionId}-suggestions-${active}` : undefined}
          placeholder={running
            ? provider === "codex" ? "Añade algo más a la respuesta en curso…" : "Añade algo más; se enviará al terminar…"
            : `Pide cambios · @ archivos${provider === "claude" ? " y subagentes" : ""} · / comandos${provider === "codex" ? " · $ skills" : ""}`}
          onChange={event => { setDraft(event.target.value); setCaret(event.target.selectionStart); if (!event.target.value) setDismissed(null); }}
          onSelect={event => setCaret(event.currentTarget.selectionStart)}
          onPaste={event => {
            const files = Array.from(event.clipboardData.items)
              .filter(item => item.kind === "file" && item.type.startsWith("image/"))
              .map(item => item.getAsFile()).filter((file): file is File => !!file);
            if (files.length) {
              event.preventDefault();
              void addImages(files);
            } else if (!event.clipboardData.getData("text/plain")) {
              // WebKitGTK no siempre entrega las capturas al evento: se leen del portapapeles nativo.
              event.preventDefault();
              void pasteFromClipboard();
            }
          }}
          onKeyDown={event => {
            // Con sugerencias abiertas, las flechas, Enter, Tab y Esc son suyas.
            if (showSuggestions && !event.nativeEvent.isComposing) {
              const count = suggestions.length;
              if ((event.key === "ArrowDown" || event.key === "ArrowUp") && count) {
                event.preventDefault();
                setActive(index => (index + (event.key === "ArrowDown" ? 1 : -1) + count) % count);
                return;
              }
              if (((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") && suggestions[active]) {
                event.preventDefault();
                pick(suggestions[active], event.key === "Tab");
                return;
              }
              if (event.key === "Escape") {
                event.preventDefault();
                setDismissed(triggerKey);
                return;
              }
            }
            if (!NATIVE_PASTE.includes(settings.pasteShortcut) && matchesPasteShortcut(event.nativeEvent, settings.pasteShortcut)) {
              event.preventDefault();
              void pasteFromClipboard();
            } else if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              send();
            } else if (event.key === "Escape" && running) {
              event.preventDefault();
              session.interrupt();
            }
          }} />
        <div className="chat-input-actions">
          <button type="button" className="chat-icon-btn tip" data-tip="Adjuntar imágenes" aria-label="Adjuntar imágenes"
            onClick={() => void attachFiles()}><PaperclipIcon size={17} /></button>
          {running && !draft.trim() && !attachments.length
            ? <button type="button" className="chat-send stop tip" aria-label="Detener" data-tip="Detener (Esc)" onClick={session.interrupt}><StopIcon /></button>
            : <button type="submit" className="chat-send" aria-label="Enviar" disabled={(!draft.trim() && !attachments.length) || preparing > 0}><ArrowUpIcon /></button>}
        </div>
        </div>
      </form>
      <div className="chat-tray">
        <Select className="chat-tray-chip chat-tray-select" menuClassName="chat-glass-menu" value={mode} options={modeOptions} align="start"
          openSignal={menuSignal.mode}
          onChange={value => { session.setMode(value); backToInput(); }}
          aria-label={`Permisos: ${modeOptions.find(option => option.value === mode)?.label ?? mode}`} />
        <span className="chat-tray-sep" aria-hidden="true" />
        <ModelMenu provider={provider} models={state.models} model={state.model} choice={state.modelChoice}
          onModel={model => { session.setModel(model); backToInput(); }} openSignal={menuSignal.model} />
        {efforts.length > 0 && <>
          <span className="chat-tray-sep" aria-hidden="true" />
          <EffortMenu levels={efforts} effort={state.effort} onEffort={session.setEffort} openSignal={menuSignal.effort} />
        </>}
        <span className="chat-composer-spacer" />
        {usage && <ContextMeter usage={usage} product={agent.product} busy={running || state.process !== "ready"}
          onCompact={() => {
            stickRef.current = true;
            // Claude Code resume con su propio `/compact`; Codex, con su petición.
            if (!runLocal("compact", "")) session.send("/compact", [], []);
            backToInput();
          }} />}
        {branch && <span className="chat-tray-info" title={`Rama de git: ${branch}`}><BranchIcon /> <span>{branch}</span></span>}
      </div>
     </div>
    </div>
  </div>;
}

function ClaudeChat(props: ChatViewProps) {
  return <ChatPanel {...props} session={useClaudeChat(props)} />;
}

function CodexChat(props: ChatViewProps) {
  return <ChatPanel {...props} session={useCodexChat(props)} />;
}

function ChatView(props: ChatViewProps) {
  return props.provider === "codex" ? <CodexChat {...props} /> : <ClaudeChat {...props} />;
}

export default memo(ChatView);
