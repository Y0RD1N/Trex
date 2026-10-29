import BrowserMenu from "./chat/BrowserMenu";
import { browserOptions, brokerArtifactId, validBrowserProfile } from "../browser";
/**
 * ChatView: sesión de Claude Code o de Codex como conversación.
 *
 * El proveedor corre en el backend sin terminal (`claude -p` con stream-json o
 * `codex app-server`); su hook traduce el protocolo a un estado común y esta
 * vista pinta el hilo, la caja de texto y la bandeja de ajustes. Igual que
 * TerminalView, se monta una vez por pestaña y el padre la oculta con
 * display:none, así que el proceso y el hilo se conservan al cambiar de sesión.
 */
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { formatError, gitBranch, listProjectFiles, readClipboard, trexBrowserOpenArtifact } from "../api";
import { MAX_IMAGES, prepareImage, readClipboardImage, readImageFile, type ChatAttachment } from "../chatImages";
import { MAX_FILES, isImagePath, pathName, saveAttachment, type ChatFile } from "../chatFiles";
import { KIND_LABELS, fileInfo, fileKind, formatBytes, openFile } from "../sharedFiles";
import { matchesPasteShortcut } from "../paste";
import {
  chatActivity, contextPercent, contextTokensLabel, conversationTitle, currentModel, effortLabel, fastSpeed, formatDuration, modelName, pendingPermissions,
  shownUsage, supportedEfforts, type ChatItem, type OutgoingImage, type PermissionItem, type QuestionChoice,
} from "../chatState";
import { messageAttachments } from "../chatMessages";
import { pendingTextQuestion, textQuestionAnswer } from "../chatQuestions";
import {
  fileReference, imageReference, insertImageReferences, moveSelection, referenceParts, removeImageReference, splitAttachedFiles,
  withAttachedFiles, type TextSelection,
} from "../imageReferences";
import { completedWork, type SummaryCache } from "../workSummary";
import { resetLabel } from "../planUsage";
import { applySuggestion, buildSuggestions, findTrigger, localCommand, parseCommand, type Suggestion } from "../chatCommands";
import type { AgentActivity, AgentNoticeKind, AgentProvider, Settings } from "../types";
import { MIN_WORK_MS } from "../agentNotices";
import { reducedMotion } from "../visualDesign";
import { enterAfterPaint } from "../motion";
import type { ChatSession, ChatSessionOptions } from "../hooks/chatSession";
import { useClaudeChat } from "../hooks/useClaudeChat";
import { useCodexChat } from "../hooks/useCodexChat";
import { useTrexChat } from "../hooks/useTrexChat";
import { useAntigravityChat } from "../hooks/useAntigravityChat";
import { useHandoffDelivery } from "../hooks/useHandoffDelivery";
import { useAgentWorkflow } from "../hooks/useAgentWorkflow";
import type { AgentWorkflow } from "../agentWorkflow";
import { dispatchQueuedMessage, INBOX_WAKE, type QueuedMessage } from "../messageQueue";
import { createHandoffContext, type HandoffContext, type HandoffReference } from "../handoff";
import AgentIcon from "./AgentIcon";
import Select, { type SelectOption } from "./Select";
import { AlertIcon, ArrowDownIcon, ArrowUpIcon, CloseIcon, ListIcon, MapIcon, PaperclipIcon, PencilIcon, RotateIcon, ShieldIcon, StopIcon } from "./Icons";
import { AssistantText, Notice, PermissionCard, Thinking, ToolRow, UserMessage } from "./chat/ChatItems";
import { ModelMenu } from "./chat/ModelMenu";
import ComposerSettings from "./chat/ComposerSettings";
import UsageMenu from "./chat/UsageMenu";
import { FileBadge, SharedFilesContext } from "./chat/SharedFiles";
import { useImageViewer } from "./ImageViewer";
import { useStableCallback } from "../hooks/useStableCallback";
import QuestionPanel from "./chat/QuestionPanel";
import Suggestions from "./chat/Suggestions";
import WorkSummary from "./chat/WorkSummary";
import BranchMenu, { GIT_BRANCH_CHANGED } from "./chat/BranchMenu";
import QueuedMessages from "./chat/QueuedMessages";
import TaskPanel from "./chat/TaskPanel";
import SubagentActivity from "./chat/AgentActivity";
import ChatWelcome, { type ChatWelcomeContent } from "./chat/ChatWelcome";
import { activityGroups, chatTasks, type ChatAttribution, type ChatTask } from "../chatTasks";
import "./ChatView.css";
import "./chat/MessageActions.css";
import BackgroundTerminals from "./chat/BackgroundTerminals";
import ComposerPanel from "./chat/ComposerPanel";
import type { TerminalOwner } from "../agentTerminals";

export type ChatViewProps = ChatSessionOptions & {
  toolbar?: ReactNode;
  composerLead?: ReactNode;
  terminalOwners?: TerminalOwner[];
  browserSpaces?: import("../browser").BrowserSpace[];
  onStopBrowserAgent?: (clientId:string)=>void;
  itemLabels?: Record<string, ChatAttribution>;
  taskPlan?: ChatTask[];
  taskAuthor?: string;
  tasksPaused?: boolean;
  emptyState?: ChatWelcomeContent;
  composerPlaceholder?: string;
  inputLocked?: boolean;
  historyReadOnly?: boolean;
  onBeforeSend?: (text: string, images: OutgoingImage[], previews: string[]) => boolean | "blocked" | Promise<true | "blocked">;
  onQueuedSend?: (message: QueuedMessage) => Promise<boolean>;
  queuedSendReason?: (message: QueuedMessage) => string | null;
  localCommandReason?: (name: string, args: string) => string | null;
  onPlanHere?: (context: HandoffContext, itemIds: string[]) => void;
  projectId?: string;
  profileId?: string | null;
  profileName?: string | null;
  sessionTitle?: string;
  handoff?: HandoffReference | null;
  handoffRestored?: boolean;
  workflow?: AgentWorkflow | null;
  onWorkflowPlan?: (tabId: string, runId: string, context?: HandoffContext) => void;
  onWorkflowStatus?: (tabId: string, runId: string, status: AgentWorkflow["status"], error?: string | null) => void;
  onWorkflowPeer?: (tabId: string) => void;
  onHandoffRequest?: (context: HandoffContext) => void;
  onHandoffConsumed?: (tabId: string, id: string) => void;
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
  onModel?: (tabId: string, model: string | null) => void;
  onEffort?: (tabId: string, effort: string | null) => void;
  /** Aviso pasajero (toast) para lo que no debe quedar en el hilo. */
  onMessage: (message: string) => void;
  /** Abre el uso del plan de todas las cuentas. */
  onOpenUsage: () => void;
};

const PROVIDERS: Record<AgentProvider, { name: string; product: string; defaultMode: string; modes: SelectOption[]; otherModes: Record<string, string> }> = {
  antigravity: { name: "Antigravity", product: "Antigravity", defaultMode: "ask", modes: [], otherModes: {} },
  trex: {
    name: "Trex", product: "Trex CLI", defaultMode: "ask",
    modes: [
      { value: "ask", label: "Preguntar", description: "Pide permiso para editar y ejecutar comandos", icon: <ShieldIcon size={13} /> },
      { value: "plan", label: "Planificar", description: "Lee e investiga el proyecto sin modificar archivos", icon: <MapIcon size={13} /> },
      { value: "full", label: "Permitir todo", description: "Edita y ejecuta sin pedir permiso", icon: <AlertIcon size={13} /> },
    ], otherModes: { auto: "Preguntar" },
  },
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
/** Imágenes que se ven en el chat; cualquier otro archivo se adjunta por su ruta. */
const SENDABLE_IMAGES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
const hasFiles = (transfer: DataTransfer | null): boolean => !!transfer && Array.from(transfer.types).includes("Files");
/** Los archivos del proyecto se vuelven a leer si la lista tiene más de esto. */
const FILES_TTL_MS = 20_000;
const SKILLS_TTL_MS = 20_000;
/** Filas del hilo que se pintan al abrir una conversación; las anteriores se cargan al subir. */
const THREAD_WINDOW = 60;
const THREAD_STEP = 80;
const NO_ITEMS: ChatItem[] = [];

/** Tiempo del turno en curso: solo este texto se repinta cada segundo. */
function WorkingTime({ since, live }: { since: number; live: boolean }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [since, live]);
  return <span className="chat-working-time">{formatDuration(now - since)}</span>;
}

export function ChatPanel(props: ChatViewProps & { session: ChatSession }) {
  const { session, sessionId, cwd, projectName, conversationId, settings, visible, focused } = props;
  const { state, provider } = session;
  const agent = PROVIDERS[provider];
  // Reserva el texto y los adjuntos al momento: dos pegados en el mismo render
  // no deben reutilizar un número ni sobrescribir las imágenes del otro.
  const [draft, updateDraft] = useState("");
  const draftRef = useRef(draft);
  const setDraft = (value: string | ((previous: string) => string)): void => {
    draftRef.current = typeof value === "function" ? value(draftRef.current) : value;
    updateDraft(draftRef.current);
  };
  const [atBottom, setAtBottom] = useState(true);
  const [tasksOpen, setTasksOpen] = useState(props.taskPlan !== undefined && !props.emptyState);
  const hadTasks = useRef(false);
  const taskToggle = useRef<HTMLButtonElement>(null);
  const revealingTask = useRef(false);
  const cancelTaskReveal = useRef<(() => void) | null>(null);
  useEffect(() => () => cancelTaskReveal.current?.(), []);
  const [attachments, updateAttachments] = useState<ChatAttachment[]>([]);
  const attachmentsRef = useRef(attachments);
  const setAttachments = (value: ChatAttachment[] | ((previous: ChatAttachment[]) => ChatAttachment[])): void => {
    attachmentsRef.current = typeof value === "function" ? value(attachmentsRef.current) : value;
    updateAttachments(attachmentsRef.current);
  };
  const [docs, updateDocs] = useState<ChatFile[]>([]);
  const docsRef = useRef(docs);
  const setDocs = (value: ChatFile[] | ((previous: ChatFile[]) => ChatFile[])): void => {
    docsRef.current = typeof value === "function" ? value(docsRef.current) : value;
    updateDocs(docsRef.current);
  };
  const preparing = attachments.filter(image => image.preparing).length + docs.filter(file => file.preparing).length;
  const nextSelectionRef = useRef<TextSelection | null>(null);
  const [dragging, setDragging] = useState(false);
  const [branch, setBranch] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; draft: string; attachments: ChatAttachment[]; docs: ChatFile[] } | null>(null);
  const [submittingEdit, setSubmittingEdit] = useState(false);
  const editSendingRef = useRef(false);
  const [queueSaving, setQueueSaving] = useState(false);
  const queueSavingRef = useRef(false);
  const queueActionRef = useRef({ mounted: true, generation: 0 });
  useEffect(() => {
    queueActionRef.current.mounted = true;
    return () => { queueActionRef.current.mounted = false; queueActionRef.current.generation++; };
  }, []);
  const [deliveryChoice, setSendDuringWork] = useState("queue");
  const sendDuringWork = provider === "trex" || provider === "antigravity" ? "queue" : deliveryChoice;
  const queueWakeRef = useRef({ armed: false, attempted: "", sending: false });
  const summaryCacheRef = useRef<SummaryCache>(new Map());
  // Sugerencias de `@`, `/` y `$`: posición del cursor, opción resaltada y menú descartado con Esc.
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [dismissedQuestion, setDismissedQuestion] = useState<string | null>(null);
  const [files, setFiles] = useState<string[] | null>(null);
  const filesAtRef = useRef(0);
  const filesRequestRef = useRef(0);
  const skillsAtRef = useRef(0);
  const [skillsLoading, setSkillsLoading] = useState(false);
  const [skillsError, setSkillsError] = useState<string | null>(null);
  /** Abre un menú de la bandeja desde un comando (`/model`, `/effort`, `/permissions`). */
  const [menuSignal, setMenuSignal] = useState({ model: 0, effort: 0, mode: 0 });

  const callbacks = useRef(props);
  callbacks.current = props;
  const titledRef = useRef(conversationId !== null || !!props.handoff);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const threadRef = useRef<HTMLDivElement | null>(null);
  const stickRef = useRef(true);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const mirrorRef = useRef<HTMLDivElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLDivElement | null>(null);
  const toolbarRef = useRef<HTMLDivElement | null>(null);

  // Una pestaña oculta no repinta su hilo: conserva lo último que se vio y se
  // pone al día al mostrarse. Las que nunca se abrieron no pintan su historial.
  const shownItemsRef = useRef<ChatItem[] | null>(null);
  if (visible) shownItemsRef.current = state.items;
  const threadItems = shownItemsRef.current ?? NO_ITEMS;
  // Solo entran con movimiento las filas que acaban de llegar a la vista.
  // Cargar historial, volver a la pestaña o subir a leer no vuelve a animarlas.
  const previousThreadRef = useRef({ items: threadItems, visible });
  const enterFrom = visible && previousThreadRef.current.visible && atBottom
    ? Math.max(previousThreadRef.current.items.length, state.historyCount) : Infinity;
  useLayoutEffect(() => { previousThreadRef.current = { items: threadItems, visible }; });
  // Solo se pintan las filas recientes; `anchorId` fija la primera mientras se lee más arriba.
  const [anchorId, setAnchorId] = useState<string | null>(null);
  const anchorIndex = anchorId === null ? -1 : threadItems.findIndex(item => item.id === anchorId);
  const threadStart = anchorIndex >= 0 ? anchorIndex : Math.max(0, threadItems.length - THREAD_WINDOW);
  const earlierRef = useRef<{ height: number; top: number } | null>(null);
  const showEarlier = (): void => {
    const element = scrollRef.current;
    if (!element || threadStart === 0 || earlierRef.current) return;
    earlierRef.current = { height: element.scrollHeight, top: element.scrollTop };
    setAnchorId(threadItems[Math.max(0, threadStart - THREAD_STEP)].id);
  };
  // Las filas nuevas entran por arriba sin mover lo que se estaba leyendo.
  useLayoutEffect(() => {
    const element = scrollRef.current, before = earlierRef.current;
    earlierRef.current = null;
    if (!element || !before) return;
    const top = before.top + element.scrollHeight - before.height;
    if (Math.abs(element.scrollTop - top) > 1) element.scrollTop = top;
  }, [threadStart]);

  useLayoutEffect(() => {
    const selection = nextSelectionRef.current;
    if (!selection) return;
    nextSelectionRef.current = null;
    inputRef.current?.setSelectionRange(selection.start, selection.end);
    setCaret(selection.start);
  }, [draft, attachments, docs]);

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

  // Desplazamiento: sigue el final mientras la persona no haya subido a leer.
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (element && stickRef.current && visible) element.scrollTop = element.scrollHeight;
  }, [state.items, state.pendingTurns, visible]);

  const onScroll = (): void => {
    const element = scrollRef.current;
    if (!element || revealingTask.current) return;
    const bottom = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
    stickRef.current = bottom;
    setAtBottom(bottom);
    // Mientras se lee más arriba, las filas pintadas no cambian; al volver al final
    // se vuelve a pintar solo lo reciente.
    if (bottom) setAnchorId(null);
    else if (anchorId === null && threadItems[threadStart]) setAnchorId(threadItems[threadStart].id);
    if (!bottom && element.scrollTop < 400 && threadStart > 0) showEarlier();
  };
  const scrollToBottom = (): void => {
    stickRef.current = true;
    setAtBottom(true);
    const reduce = reducedMotion(settings.motion, window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: reduce ? "instant" : "smooth" });
  };

  // Foco en la caja de texto al activar la sesión.
  useEffect(() => {
    if (visible && focused && !document.querySelector(".dialog-card, [role='dialog']")) {
      inputRef.current?.focus({ preventScroll: true });
    }
  }, [visible, focused]);

  // El texto en curso se pinta a ritmo propio (ver AssistantText): el hilo sigue el final al crecer.
  useLayoutEffect(() => {
    const thread = threadRef.current, scroller = scrollRef.current;
    if (!thread || !scroller) return;
    const observer = new ResizeObserver(() => { if (stickRef.current) scroller.scrollTop = scroller.scrollHeight; });
    observer.observe(thread);
    return () => observer.disconnect();
  }, []);

  // Los controles flotan sobre el hilo. Sus medidas solo reservan los extremos
  // del contenido; no recortan la superficie por la que se desplazan los mensajes.
  useLayoutEffect(() => {
    const composer = composerRef.current, toolbar = toolbarRef.current, root = rootRef.current;
    if (!composer || !toolbar || !root) return;
    const measure = (): void => {
      root.style.setProperty("--composer-space", `${composer.offsetHeight}px`);
      root.style.setProperty("--chat-toolbar-height", `${toolbar.offsetHeight}px`);
      const scroller = scrollRef.current;
      if (scroller && stickRef.current) scroller.scrollTop = scroller.scrollHeight;
    };
    const observer = new ResizeObserver(measure);
    observer.observe(composer);
    observer.observe(toolbar);
    measure();
    return () => observer.disconnect();
  }, []);

  // Deja un píxel para el redondeo de fuentes y del escalado de Windows.
  const resizeInput = useStableCallback((): void => {
    const input = inputRef.current;
    if (!input || !input.clientWidth) return;
    input.style.overflowY = "hidden";
    input.style.height = "auto";
    const naturalHeight = Math.ceil(input.scrollHeight) + 1;
    const maxHeight = Math.max(38, Math.min(160, Math.floor((rootRef.current?.clientHeight || window.innerHeight) * 0.22)));
    input.style.height = `${Math.min(naturalHeight, maxHeight)}px`;
    input.style.overflowY = naturalHeight > maxHeight ? "auto" : "hidden";
    // El texto visible (con las citas resaltadas) va detrás y debe partir las líneas igual.
    const mirror = mirrorRef.current;
    if (mirror) { mirror.style.overflowY = input.style.overflowY; mirror.scrollTop = input.scrollTop; }
  });
  useLayoutEffect(() => { if (visible) resizeInput(); }, [draft, visible, settings.fontSize, resizeInput]);
  // Las pestañas se montan ocultas; se mide al mostrarlas, al cambiar el ancho
  // del panel y cuando terminan de cargar las fuentes.
  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input || !visible) return;
    let disposed = false;
    let frame = 0;
    let observedWidth = input.clientWidth;
    let observedHeight = rootRef.current?.clientHeight;
    const resize = (): void => { if (!disposed) resizeInput(); };
    // El alto lo ajusta resizeInput; observarlo otra vez crea un ciclo al estrechar el panel.
    const observer = new ResizeObserver(() => {
      const width = input.clientWidth;
      const height = rootRef.current?.clientHeight;
      if (width === observedWidth && height === observedHeight) return;
      observedWidth = width;
      observedHeight = height;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(resize);
    });
    observer.observe(input);
    if (rootRef.current) observer.observe(rootRef.current);
    window.addEventListener("resize", resize);
    void document.fonts.ready.then(resize);
    return () => { disposed = true; cancelAnimationFrame(frame); observer.disconnect(); window.removeEventListener("resize", resize); };
  }, [visible, resizeInput]);

  const running = state.pendingTurns > 0;
  const workflowLocked = !!props.inputLocked || props.workflow?.role === "planner" && props.workflow.status === "transferring";
  const hasDirectQueue = !!session.queue.snapshot.outbox?.length;
  const hasQueued = session.queue.snapshot.messages.length > 0 || !!session.queue.snapshot.receipt || hasDirectQueue;
  const wakeQueue = useStableCallback((): void => {
    if (queueWakeRef.current.sending || queueSavingRef.current || hasDirectQueue || running || handoffPending || workflowLocked || !session.queue.ready) return;
    queueWakeRef.current.sending = true;
    void Promise.resolve(session.send(INBOX_WAKE, [], [], "Leer los mensajes en cola")).finally(() => { queueWakeRef.current.sending = false; });
  });
  // One follow-up per batch after a successful turn. A stop, failure or restored
  // tab leaves its messages pending until the user explicitly continues.
  useEffect(() => {
    const pending = session.queue.snapshot.messages.map(message => message.id).join(",");
    const wake = queueWakeRef.current;
    if (running && pending) wake.armed = true;
    if (running || queueSaving || hasDirectQueue || !wake.armed || !pending || wake.attempted === pending || state.process !== "ready") return;
    wake.armed = false;
    if (state.items[state.items.length - 1]?.kind !== "turn") return;
    wake.attempted = pending;
    wakeQueue();
  }, [running, queueSaving, hasDirectQueue, session.queue.snapshot.messages, state.items, state.process, wakeQueue]);
  const consumeHandoff = useStableCallback((id: string) => callbacks.current.onHandoffConsumed?.(sessionId, id));
  const handoffDelivery = useHandoffDelivery({ reference: props.handoff, session, visible, conversationId,
    requireReview: props.handoffRestored, loadWhenConsumed: props.workflow?.role === "planner",
    autoSend: !props.workflow || props.workflow.status === "planning" || props.workflow.status === "executing", onConsumed: consumeHandoff });
  const handoffPending = !!props.handoff?.pending;
  const workflowSource = useMemo(() => ({ sessionId, provider, profileId: props.profileId ?? null,
    profileName: props.profileName ?? agent.product, title: props.sessionTitle ?? "Planificación",
    projectId: props.projectId ?? "", projectName, cwd }), [sessionId, provider, props.profileId, props.profileName, props.sessionTitle, props.projectId, projectName, cwd, agent.product]);
  const workflowControl = useAgentWorkflow({ workflow: props.workflow, session, source: workflowSource, original: handoffDelivery.prepared,
    handoffPending, busy: queueSaving || hasQueued || !session.queue.ready || handoffDelivery.loading || handoffDelivery.sending || submittingEdit,
    onPlan: props.onWorkflowPlan, onStatus: props.onWorkflowStatus });
  const canHandoff = state.items.some(item => item.kind === "user" || item.kind === "text");
  const handoffDisabled = workflowLocked || running || submittingEdit || queueSaving || hasQueued || !session.queue.ready || !canHandoff || handoffDelivery.sending;
  const handoffHint = running ? "Disponible al terminar la respuesta. También puedes detenerla con Esc."
    : submittingEdit ? "Espera a que termine de enviarse la edición."
    : queueSaving ? "Espera a que se guarde el mensaje en cola."
    : !session.queue.ready ? "Cargando los mensajes pendientes de esta conversación."
    : hasQueued ? "Lee o cancela los mensajes en cola antes de cambiar de asistente."
    : !canHandoff ? "Envía un mensaje para poder continuar este trabajo con otro asistente."
    : handoffDelivery.sending ? "Espera a que termine de entregarse el contexto."
    : "Continúa este trabajo con otro perfil y conserva el contexto.";
  const requestHandoff = (): void => {
    if (running || submittingEdit || queueSavingRef.current || hasQueued || !session.queue.ready || !canHandoff || !props.projectId) return;
    callbacks.current.onHandoffRequest?.(createHandoffContext(state, {
      sessionId, provider, profileId: props.profileId ?? null, profileName: props.profileName || agent.product,
      title: props.sessionTitle || projectName, projectId: props.projectId, projectName, cwd,
    }));
  };
  const planHere = (): void => {
    if (handoffDisabled || !props.projectId) return;
    props.onPlanHere?.(createHandoffContext(state, { sessionId, provider, profileId: props.profileId ?? null,
      profileName: props.profileName || agent.product, title: props.sessionTitle || projectName,
      projectId: props.projectId, projectName, cwd }), state.items.map(item => item.id));
  };
  const summaries = useMemo(() => completedWork(threadItems, cwd, state.historyCount, summaryCacheRef.current), [threadItems, cwd, state.historyCount]);
  const responseOrigins = useMemo(() => {
    const origins = new Map<string, Extract<ChatItem, { kind: "user" }>>();
    let user: Extract<ChatItem, { kind: "user" }> | null = null;
    for (const item of threadItems) {
      if (item.kind === "user") user = item;
      else if (item.kind === "text" && user) origins.set(item.id, user);
    }
    return origins;
  }, [threadItems]);
  const cancelEdit = (): void => {
    if (!editing || editSendingRef.current) return;
    setDraft(editing.draft);
    setAttachments(editing.attachments);
    setDocs(editing.docs);
    setEditing(null);
    backToInput();
  };
  const beginEdit = useStableCallback((id: string): void => {
    if (handoffPending || running || hasQueued || !session.queue.ready || editSendingRef.current || preparing) return;
    const item = state.items.find(item => item.kind === "user" && item.id === id);
    if (item?.kind !== "user") return;
    try {
      const images = messageAttachments(item);
      const message = splitAttachedFiles(item.text);
      setEditing(previous => ({ id, draft: previous?.draft ?? draft, attachments: previous?.attachments ?? attachments,
        docs: previous?.docs ?? docsRef.current }));
      setDraft(message.text);
      setAttachments(images);
      setDocs(message.files.map((path, index) => ({ id: `${id}-file-${index}`, name: pathName(path), path, size: -1 })));
      setDismissed(null);
      requestAnimationFrame(() => {
        inputRef.current?.focus({ preventScroll: true });
        inputRef.current?.setSelectionRange(message.text.length, message.text.length);
      });
    } catch (error) { callbacks.current.onMessage(formatError(error)); }
  });
  const stopResponse = useStableCallback((): void => {
    queueActionRef.current.generation++;
    workflowControl.stop();
  });
  const queueAction = async (work: () => Promise<unknown>): Promise<void> => {
    if (queueSavingRef.current || !session.queue.ready || workflowLocked || handoffPending || submittingEdit) throw new Error("Espera a que termine la operación pendiente de la conversación.");
    queueSavingRef.current = true; setQueueSaving(true);
    try { await work(); }
    finally {
      queueSavingRef.current = false;
      if (queueActionRef.current.mounted) {
        setQueueSaving(false);
        void session.queue.reload().catch(() => undefined);
      }
    }
  };
  const sendQueuedNow = (message: QueuedMessage): Promise<void> => queueAction(async () => {
    if (session.queue.snapshot.outbox?.length) throw new Error("Revisa el envío directo pendiente antes de enviar otro mensaje de la cola.");
    const reason = callbacks.current.queuedSendReason?.(message);
    if (reason) throw new Error(reason);
    const generation = ++queueActionRef.current.generation;
    queueWakeRef.current.armed = false;
    await dispatchQueuedMessage(session.queue.client, message, value => {
      if (callbacks.current.onQueuedSend) return callbacks.current.onQueuedSend(value);
      return session.sendNow
        ? session.sendNow(value.text, value.images, value.previews, undefined,
          session.provider === "trex" ? workflowControl.supersedeActiveTurn : undefined)
        : session.send(value.text, value.images, value.previews);
    },
    () => queueActionRef.current.mounted && queueActionRef.current.generation === generation);
  });
  const resendMessage = useStableCallback((id: string): void => {
    if (handoffPending || running || hasQueued || !session.queue.ready || editSendingRef.current || preparing) return;
    const item = state.items.find(item => item.kind === "user" && item.id === id);
    if (item?.kind !== "user") return;
    try {
      const images = messageAttachments(item);
      if (editing) cancelEdit();
      stickRef.current = true;
      session.send(item.text, images, images.map(image => image.preview));
      backToInput();
    } catch (error) { callbacks.current.onMessage(formatError(error)); }
  });
  const regenerateMessage = useStableCallback((id: string): void => {
    if (handoffPending || running || hasQueued || !session.queue.ready || editSendingRef.current || preparing) return;
    const item = state.items.find(item => item.kind === "user" && item.id === id);
    if (item?.kind !== "user") return;
    editSendingRef.current = true;
    setSubmittingEdit(true);
    try {
      const images = messageAttachments(item);
      stickRef.current = true;
      void session.edit(id, item.text, images, images.map(image => image.preview))
        .catch(error => callbacks.current.onMessage(formatError(error)))
        .finally(() => { editSendingRef.current = false; setSubmittingEdit(false); });
    } catch (error) {
      editSendingRef.current = false;
      setSubmittingEdit(false);
      callbacks.current.onMessage(formatError(error));
    }
  });

  // Rama de git: al mostrar la sesión y al terminar cada respuesta (el asistente puede cambiarla).
  useEffect(() => {
    let cancelled = false;
    let request = 0;
    const refresh = (): void => {
      if (!visible || running) return;
      const next = ++request;
      void gitBranch(cwd).then(name => { if (!cancelled && next === request) setBranch(name); }).catch(() => undefined);
    };
    const changed = (event: Event): void => {
      if ((event as CustomEvent<{ cwd: string }>).detail?.cwd !== cwd) return;
      setFiles(null);
      filesAtRef.current = 0;
      filesRequestRef.current++;
      refresh();
    };
    refresh();
    window.addEventListener("focus", refresh);
    window.addEventListener(GIT_BRANCH_CHANGED, changed);
    return () => { cancelled = true; window.removeEventListener("focus", refresh); window.removeEventListener(GIT_BRANCH_CHANGED, changed); };
  }, [cwd, visible, running]);

  // Si aún no se ha pintado la selección de una inserción anterior, se sigue desde ella.
  const insertionPoint = () => ({ text: draftRef.current,
    start: nextSelectionRef.current?.start ?? inputRef.current?.selectionStart ?? draftRef.current.length,
    end: nextSelectionRef.current?.end ?? inputRef.current?.selectionEnd ?? draftRef.current.length });
  const removeImage = (id: string): void => {
    const current = attachmentsRef.current;
    const index = current.findIndex(image => image.id === id);
    if (index < 0) return;
    const next = removeImageReference(draftRef.current, insertionPoint(), index, current.length);
    nextSelectionRef.current = next.selection;
    setDraft(next.text);
    setAttachments(current.filter(image => image.id !== id));
  };

  /** Reserva las citas antes de comprimir: los pegados rápidos conservan su lugar y su orden. */
  const addImages = async (sources: (Blob | { mediaType: string; data: string; name: string })[], point = insertionPoint()): Promise<void> => {
    if (editSendingRef.current || !sources.length) return;
    const current = attachmentsRef.current;
    const room = MAX_IMAGES - current.length;
    if (room <= 0) {
      callbacks.current.onMessage(`Puedes adjuntar hasta ${MAX_IMAGES} imágenes por mensaje.`);
      return;
    }
    const accepted = sources.slice(0, room);
    const placeholders = accepted.map(source => ({ id: crypto.randomUUID(), preparing: true, data: "", mediaType: "", preview: "",
      name: source instanceof Blob ? source instanceof File && source.name || "Imagen pegada" : source.name }));
    const selection = moveSelection(point.text, draftRef.current, point);
    const next = insertImageReferences(draftRef.current, selection, current.length, placeholders.length);
    nextSelectionRef.current = next.selection;
    setDraft(next.text);
    setAttachments([...current, ...placeholders]);
    inputRef.current?.focus({ preventScroll: true });
    for (const [index, source] of accepted.entries()) {
      const id = placeholders[index].id;
      if (!attachmentsRef.current.some(image => image.id === id)) continue;
      try {
        const image = await prepareImage(source);
        setAttachments(previous => previous.map(item => item.id === id ? { ...image, id } : item));
      } catch (error) {
        if (attachmentsRef.current.some(image => image.id === id)) {
          removeImage(id);
          callbacks.current.onMessage(formatError(error));
        }
      }
    }
  };

  const removeDoc = (id: string): void => {
    const current = docsRef.current;
    const index = current.findIndex(file => file.id === id);
    if (index < 0) return;
    const next = removeImageReference(draftRef.current, insertionPoint(), index, current.length, "Archivo");
    nextSelectionRef.current = next.selection;
    setDraft(next.text);
    setDocs(current.filter(file => file.id !== id));
  };

  /** Archivos de cualquier tipo: rutas elegidas en el diálogo o archivos sin ruta (arrastrados o pegados). */
  const addDocs = async (sources: (File | string)[], point = insertionPoint()): Promise<void> => {
    if (editSendingRef.current || !sources.length) return;
    const current = docsRef.current;
    const fresh = sources.filter(source => typeof source !== "string" || !current.some(file => file.path === source));
    const room = MAX_FILES - current.length;
    if (fresh.length > room) callbacks.current.onMessage(`Puedes adjuntar hasta ${MAX_FILES} archivos por mensaje.`);
    const accepted = fresh.slice(0, Math.max(0, room));
    if (!accepted.length) return;
    const placeholders: ChatFile[] = accepted.map(source => typeof source === "string"
      ? { id: crypto.randomUUID(), name: pathName(source), path: source, size: -1 }
      : { id: crypto.randomUUID(), name: source.name || "archivo", path: "", size: source.size, preparing: true });
    const selection = moveSelection(point.text, draftRef.current, point);
    const next = insertImageReferences(draftRef.current, selection, current.length, placeholders.length, "Archivo");
    nextSelectionRef.current = next.selection;
    setDraft(next.text);
    setDocs([...current, ...placeholders]);
    inputRef.current?.focus({ preventScroll: true });
    await Promise.all(accepted.map(async (source, index) => {
      const id = placeholders[index].id;
      try {
        if (typeof source === "string") {
          const info = await fileInfo(source);
          if (!info?.exists || info.isDir) throw new Error(`«${pathName(source)}» no es un archivo que se pueda adjuntar.`);
          setDocs(previous => previous.map(file => file.id === id ? { ...file, size: info.size } : file));
        } else {
          const path = await saveAttachment(source);
          setDocs(previous => previous.map(file => file.id === id ? { ...file, path, preparing: false } : file));
        }
      } catch (error) {
        if (docsRef.current.some(file => file.id === id)) {
          removeDoc(id);
          callbacks.current.onMessage(formatError(error));
        }
      }
    }));
  };

  /** Lo que llega arrastrado o pegado: las imágenes se ven en el chat; el resto va como archivo. */
  const addDropped = (files: File[]): void => {
    const images = files.filter(file => SENDABLE_IMAGES.includes(file.type));
    const others = files.filter(file => !images.includes(file));
    if (images.length) void addImages(images);
    if (others.length) void addDocs(others);
  };

  const pasteFromClipboard = async (): Promise<void> => {
    const point = insertionPoint();
    const image = await readClipboardImage().catch(() => null);
    if (image) return addImages([image], point);
    const content = await readClipboard().catch(() => null);
    const input = inputRef.current;
    if (content?.kind !== "text" || !content.text || !input) return;
    const { selectionStart, selectionEnd } = input;
    setDraft(value => value.slice(0, selectionStart) + content.text + value.slice(selectionEnd));
    requestAnimationFrame(() => input.setSelectionRange(selectionStart + content.text.length, selectionStart + content.text.length));
  };

  const attachFiles = async (): Promise<void> => {
    const point = insertionPoint();
    const selected = await open({ multiple: true, title: "Adjuntar imágenes o archivos" }).catch(() => null);
    const paths = Array.isArray(selected) ? selected : selected ? [selected] : [];
    const images = [], others: string[] = [];
    for (const path of paths) {
      // Una imagen que no se puede mostrar (muy grande o dañada) se adjunta como archivo.
      if (isImagePath(path)) {
        try { images.push(await readImageFile(path)); continue; } catch { /* va como archivo */ }
      }
      others.push(path);
    }
    if (images.length) void addImages(images, point);
    if (others.length) await addDocs(others, images.length ? insertionPoint() : point);
  };

  const mode = state.permissionMode === "manual" ? "default" : state.permissionMode ?? agent.defaultMode;
  // El modo elegido se guarda con la pestaña: sigue igual al volver a abrir la app.
  useEffect(() => {
    if (state.modeChoice) callbacks.current.onMode(sessionId, provider, state.modeChoice);
  }, [state.modeChoice, sessionId, provider]);
  useEffect(() => {
    callbacks.current.onModel?.(sessionId, state.modelChoice);
  }, [state.modelChoice, sessionId]);
  useEffect(() => {
    callbacks.current.onEffort?.(sessionId, state.effortChoice);
  }, [state.effortChoice, sessionId]);
  /** Modo de trabajo al que se vuelve al poner en marcha un plan. */
  const workModeRef = useRef(mode === "plan" ? agent.defaultMode : mode);
  useEffect(() => { if (mode !== "plan") workModeRef.current = mode; }, [mode]);
  const nativeModes = session.modes ?? agent.modes;
  const availableModes = props.planningOnly ? nativeModes.filter(option => option.value === "plan") : nativeModes;
  const modeOptions = availableModes.some(option => option.value === mode) ? availableModes
    : [...availableModes, { value: mode, label: agent.otherModes[mode] ?? mode, icon: <ShieldIcon size={13} /> }];
  const efforts = supportedEfforts(state.models, state.model, state.modelChoice);
  const filesContext = useMemo(() => ({ cwd, streaming: false }), [cwd]);
  const viewer = useImageViewer();
  const speed = fastSpeed(state.models, state.model, state.modelChoice);
  const usage = shownUsage(state);

  const statusText = (): string => {
    const model = currentModel(state.models, state.model, state.modelChoice);
    const percent = contextPercent(usage);
    return [
      `Estado de ${agent.product}`,
      `Modelo: ${model ? modelName(model) : state.model ?? "sin datos"}`,
      ...(state.effort ? [`Esfuerzo: ${effortLabel(state.effort)}`] : []),
      ...(speed ? [`Velocidad: ${state.fast ? "rápida" : "estándar"}`] : []),
      `Permisos: ${modeOptions.find(option => option.value === mode)?.label ?? mode}`,
      ...(usage ? [`Contexto: ${contextTokensLabel(usage)}${percent !== null ? ` (${Math.round(percent)} %)` : ""}`] : []),
      ...(state.plan?.windows ?? []).map(window => `${window.label}: ${window.percent} %${window.resetsAt !== null ? ` (${resetLabel(window.resetsAt, Date.now())})` : ""}`),
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
        if (!session.queue.ready) { session.notice("info", "Espera a que termine de cargar la cola antes de empezar otra conversación."); return true; }
        if (hasQueued) { session.notice("info", "Lee o cancela los mensajes en cola antes de empezar otra conversación."); return true; }
        if (props.workflow) props.onWorkflowStatus?.(sessionId, props.workflow.id, "paused", "Flujo pausado al empezar otra conversación.");
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
        else if (efforts.length || speed) setMenuSignal(signal => ({ ...signal, effort: signal.effort + 1 }));
        else session.notice("info", "El modelo elegido no tiene niveles de esfuerzo.");
        return true;
      case "fast": {
        if (!speed) { session.notice("info", "El modelo elegido no tiene velocidad rápida."); return true; }
        const fast = ["on", "si", "sí"].includes(wanted) ? true : wanted === "off" || wanted === "no" ? false : !state.fast;
        if (fast !== state.fast) session.setFast(fast);
        session.notice("info", fast ? `Velocidad rápida activada: ${speed.hint}` : "Velocidad estándar.");
        return true;
      }
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
    if (workflowLocked || handoffPending || queueSavingRef.current) return;
    const text = (override ?? draftRef.current).trim();
    const images = attachmentsRef.current;
    const attached = docsRef.current;
    if ((!text && !images.length && !attached.length) || images.some(image => image.preparing)
      || attached.some(file => file.preparing) || editSendingRef.current) return;
    const message = withAttachedFiles(text, attached.map(file => file.path));
    if (editing) {
      if (running) return;
      editSendingRef.current = true;
      setSubmittingEdit(true);
      stickRef.current = true;
      void session.edit(editing.id, message, images, images.map(image => image.preview)).then(() => {
        setDraft(editing.draft);
        setAttachments(editing.attachments);
        setDocs(editing.docs);
        setEditing(null);
      }).catch(error => {
        callbacks.current.onMessage(formatError(error));
        if (!callbacks.current.session.state.items.some(item => item.kind === "user" && item.id === editing.id)) setEditing(null);
      }).finally(() => { editSendingRef.current = false; setSubmittingEdit(false); });
      return;
    }
    const command = images.length || attached.length ? null : parseCommand(text);
    setDismissed(null);
    const localReason = command ? props.localCommandReason?.(command.name, command.args) : null;
    if (localReason) { callbacks.current.onMessage(localReason); return; }
    if (command && runLocal(command.name, command.args)) {
      setDraft("");
      return;
    }
    const intercepted = props.onBeforeSend?.(message, images.map(({ mediaType, data }) => ({ mediaType, data })), images.map(image => image.preview));
    if (intercepted) {
      const originalDraft = draftRef.current;
      const accept = (result: true | "blocked"): void => {
        if (result === true && draftRef.current === originalDraft && attachmentsRef.current === images && docsRef.current === attached) {
          setDraft(""); setAttachments([]); setDocs([]); stickRef.current = true;
        }
      };
      if (typeof intercepted === "object") void intercepted.then(accept).catch(error => callbacks.current.onMessage(formatError(error)));
      else accept(intercepted);
      return;
    }
    if (!session.queue.ready) {
      callbacks.current.onMessage("Espera a que termine de cargar la cola antes de enviar el mensaje.");
      return;
    }
    if ((running || hasQueued) && sendDuringWork === "queue") {
      if (running) queueWakeRef.current.armed = true;
      queueSavingRef.current = true;
      editSendingRef.current = true;
      setQueueSaving(true);
      void session.queue.enqueue(message, images.map(({ mediaType, data }) => ({ mediaType, data })), images.map(image => image.preview)).then(() => {
        setDraft(""); setAttachments([]); setDocs([]); setDismissed(null);
      }).catch(error => callbacks.current.onMessage(`No se pudo guardar el mensaje en cola: ${formatError(error)}`))
        .finally(() => { queueSavingRef.current = false; editSendingRef.current = false; setQueueSaving(false); });
      return;
    }
    const unsent = { draft: draftRef.current, images, attached };
    setDraft("");
    setAttachments([]);
    setDocs([]);
    stickRef.current = true;
    // Un comando no da título a la conversación: lo dará el primer mensaje de verdad.
    if (!titledRef.current && !command) {
      titledRef.current = true;
      callbacks.current.onTitle(sessionId, conversationTitle(text || (attached.length === 1 && !images.length ? attached[0].name
        : attached.length ? "Archivos adjuntos" : images.length === 1 ? "Imagen" : "Imágenes")));
    }
    const restoreUnsent = (): void => {
      if (!draftRef.current && !attachmentsRef.current.length && !docsRef.current.length) {
        setDraft(unsent.draft); setAttachments(unsent.images); setDocs(unsent.attached);
      }
    };
    void (async () => {
      const accepted = await session.send(message, images.map(({ mediaType, data }) => ({ mediaType, data })), images.map(image => image.preview));
      if (accepted === false) restoreUnsent();
    })().catch(error => { restoreUnsent(); callbacks.current.onMessage(formatError(error)); });
  };

  // --- Sugerencias ------------------------------------------------------------
  const trigger = findTrigger(draft, caret, "@/$");
  const triggerKey = trigger ? `${trigger.char}:${trigger.start}` : null;
  const suggesting = trigger !== null && triggerKey !== dismissed;
  const wantsFiles = suggesting && trigger?.char === "@";
  const wantsSkills = suggesting && trigger?.char === "$";
  const suggestions = useMemo(() => suggesting && trigger
    ? buildSuggestions(trigger, { provider, files, agents: state.agents, commands: state.commands, skills: state.skills }) : [],
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [suggesting, trigger?.char, trigger?.query, provider, files, state.agents, state.commands, state.skills]);
  const showSuggestions = suggesting && (suggestions.length > 0 || (wantsFiles && files === null) || wantsSkills);
  const selectedSuggestion = suggestions[active] ? active : 0;
  const loadingSuggestions = wantsSkills ? skillsLoading || state.process === "starting" : wantsFiles && files === null;

  useEffect(() => { setActive(0); }, [trigger?.char, trigger?.query]);

  // La lista de archivos se lee al escribir `@` y se refresca si es antigua.
  useEffect(() => {
    if (!wantsFiles || Date.now() - filesAtRef.current < FILES_TTL_MS) return;
    filesAtRef.current = Date.now();
    const request = ++filesRequestRef.current;
    void listProjectFiles(cwd).then(next => { if (request === filesRequestRef.current) setFiles(next); })
      .catch(() => { if (request === filesRequestRef.current) setFiles(previous => previous ?? []); });
  }, [wantsFiles, cwd, files]);

  // Catálogo de la propia sesión: respeta el proyecto, la cuenta y los plugins del perfil.
  useEffect(() => {
    if (!wantsSkills || !visible || state.process !== "ready" || Date.now() - skillsAtRef.current < SKILLS_TTL_MS) return;
    skillsAtRef.current = Date.now();
    setSkillsLoading(true);
    setSkillsError(null);
    let cancelled = false;
    void session.refreshSkills().catch(error => {
      skillsAtRef.current = 0;
      if (!cancelled) setSkillsError(`No se pudieron cargar las skills: ${formatError(error)}`);
    }).finally(() => { if (rootRef.current) setSkillsLoading(false); });
    return () => { cancelled = true; };
  }, [wantsSkills, triggerKey, visible, state.process, session.refreshSkills]);

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

  // Tras elegir en un selector, se sigue escribiendo en la caja.
  const backToInput = (): void => { requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true })); };

  // Una pregunta con viñetas también se puede contestar si el agente no usó su herramienta.
  const textQuestion = useMemo(() => pendingTextQuestion(state.items), [state.items]);

  // Identidad fija: las filas del hilo están memorizadas y no deben repintarse por ella.
  const answer = useStableCallback((item: PermissionItem, allowed: boolean, remember: boolean, choices?: QuestionChoice[]): void => {
    if (workflowLocked) return;
    if (item.id === textQuestion?.id) {
      setDismissedQuestion(item.id);
      const response = allowed ? textQuestionAnswer(choices ?? []) : "";
      if (response) session.send(response, [], []);
    } else session.answer(item, allowed, remember, choices);
    stickRef.current = true;
    // La caja vuelve a la vista en el siguiente render (si era una pregunta, ocupaba su sitio).
    backToInput();
  });

  /** Pregunta del asistente que espera respuesta: ocupa el sitio de la caja de mensaje. */
  const question = state.items.find((item): item is PermissionItem =>
    item.kind === "permission" && item.state === "pending" && item.toolName === "AskUserQuestion")
    ?? (!editing && textQuestion?.id !== dismissedQuestion ? textQuestion : null);

  const lastItem = state.items[state.items.length - 1];
  const thinking = !lastItem || lastItem.kind === "user" || lastItem.kind === "thinking";
  const empty = state.items.length === 0;
  // Solo la lista de tareas y el plan más recientes se muestran enteros; los anteriores quedan plegados.
  const { latestTodos, latestPlan, planIndex } = useMemo(() => {
    let todos: string | undefined, plan: string | undefined, index = -1;
    for (let at = threadItems.length - 1; at >= 0 && (!todos || !plan); at--) {
      const item = threadItems[at];
      if (item.kind !== "tool") continue;
      if (!todos && item.name === "TodoWrite") todos = item.id;
      if (!plan && item.name === "ExitPlanMode") { plan = item.id; index = at; }
    }
    return { latestTodos: todos, latestPlan: provider === "codex" ? plan : undefined, planIndex: index };
  }, [threadItems, provider]);
  // El plan se puede poner en marcha cuando es lo último que propuso Codex.
  const planReady = !props.planningOnly && !handoffPending && !running && mode === "plan" && latestPlan !== undefined
    && !threadItems.slice(planIndex + 1).some(item => item.kind === "user");
  const implementPlan = useStableCallback((): void => {
    if (handoffPending) return;
    session.setMode(workModeRef.current);
    stickRef.current = true;
    session.send("Implementa el plan.", [], []);
  });

  // Filas del hilo: se rehacen solo cuando cambia algo que muestran, no con cada tecla en la caja.
  const editingId = editing?.id ?? null;
  const busy = workflowLocked || preparing > 0 || handoffPending || hasQueued || !session.queue.ready;
  const tasks = useMemo(() => props.taskPlan ?? chatTasks(state.items, props.profileName ?? agent.name), [props.taskPlan, state.items, props.profileName, agent.name]);
  useEffect(() => {
    if (tasks.length && !hadTasks.current) setTasksOpen(true);
    hadTasks.current = tasks.length > 0;
  }, [tasks.length]);
  const revealTask = (task: ChatTask): void => {
    const matches = threadItems.filter(item => task.memberId ? props.itemLabels?.[item.id]?.memberId === task.memberId : item.id === task.sourceId);
    const target = matches[matches.length - 1];
    if (!target) { props.onMessage("La actividad aparecerá cuando se inicie esta tarea."); return; }
    cancelTaskReveal.current?.();
    revealingTask.current = true;
    const index = threadItems.indexOf(target);
    if (index < threadStart) setAnchorId(target.id);
    if ((rootRef.current?.clientWidth ?? Infinity) <= 760) {
      setTasksOpen(false);
      taskToggle.current?.focus({ preventScroll: true });
    }
    stickRef.current = false;
    setAtBottom(false);
    // Prepending older rows can emit a scroll event at the former bottom.
    // Retain the requested window until its activity is mounted and positioned.
    cancelTaskReveal.current = enterAfterPaint(() => {
      cancelTaskReveal.current = null;
      const elements = rootRef.current?.querySelectorAll<HTMLElement>(task.memberId ? ".chat-agent-activity" : "[data-plan-source]");
      const matching = elements ? [...elements].filter(element => task.memberId ? element.dataset.memberId === task.memberId : element.dataset.planSource === task.sourceId) : [];
      const node = matching[matching.length - 1];
      if (node instanceof HTMLDetailsElement) node.open = true;
      node?.scrollIntoView({ block: "nearest", behavior: "auto" });
      revealingTask.current = false;
    });
  };
  const rows = useMemo(() => {
    // Las filas de herramientas con un permiso pendiente se sustituyen por la tarjeta.
    const askingFor = new Set(threadItems.flatMap(item => item.kind === "permission" && item.state === "pending" && item.toolUseId ? [item.toolUseId] : []));
    const asked = (id: string): boolean => askingFor.has(id) || askingFor.has(id.split("#")[0]);
    const canEdit = (item: Extract<ChatItem, { kind: "user" }>): boolean =>
      !props.historyReadOnly && !item.fromQueue && (provider === "codex" ? !!item.providerTurnId : /^[\da-f-]{36}$/i.test(item.id));
    const visibleItems = threadItems.slice(threadStart);
    const rendered = visibleItems.map((item, offset) => {
      const animate = threadStart + offset >= enterFrom;
      const next = threadItems[threadStart + offset + 1];
      switch (item.kind) {
        case "user": return <UserMessage key={item.id} id={item.id} text={item.text} images={item.images} previews={item.previews}
          onEdit={beginEdit} onResend={resendMessage} editing={editingId === item.id} editable={canEdit(item)} fromQueue={item.fromQueue}
          disabled={props.historyReadOnly || running || submittingEdit || busy} animate={animate} />;
        case "text": {
          if (!item.text.trim()) return null;
          const user = responseOrigins.get(item.id);
          const label = props.itemLabels?.[item.id];
          const displayedText = label && /^\s*<trex_plan>[\s\S]*<\/trex_plan>\s*$/.test(item.text)
            ? item.text.replace(/^\s*<trex_plan>\s*/, "").replace(/\s*<\/trex_plan>\s*$/, "") : item.text;
          const response = <AssistantText key={item.id} text={displayedText} streaming={!item.final} animate={animate}
            regenerateId={user && canEdit(user) && user.images === user.previews.length ? user.id : undefined}
            onRegenerate={regenerateMessage} disabled={running || submittingEdit || busy || editingId !== null}
            actions={item.final && (next ? next.kind === "turn" || next.kind === "user" : !running)} />;
          return label ? <div key={item.id} className="chat-attributed-message">
            <div className="chat-message-author"><AgentIcon kind={label.provider} size={13} /><span>{label.label}</span></div>{response}</div> : response;
        }
        case "thinking": return <Thinking key={item.id} text={item.text} />;
        case "tool": return asked(item.id) ? null : <div key={item.id} data-plan-source={["TodoWrite", "TaskCreate", "TaskUpdate"].includes(item.name) ? item.id : undefined}><ToolRow item={item} cwd={cwd}
          onOpenArtifact={props.browser?.enabled ? async artifact => {
            const id = brokerArtifactId(artifact); if (!id || !props.browser) return;
            const profile=(artifact.provenance as {profile?:string}|null)?.profile;
            const binding=props.browserSpaces?.find(space=>space.profile===profile)??{...props.browser,profile:profile&&validBrowserProfile(profile)?profile:props.browser.profile};
            try { const result = await trexBrowserOpenArtifact(id, cwd, "full", binding?.clientId??props.browser.clientId, binding?.profile??props.browser.profile);
              if (result.isError) session.notice("warn", "No se pudo abrir el archivo. Revisa el estado del navegador.");
            } catch { session.notice("warn", "No se pudo abrir el archivo del navegador."); }
          } : undefined}
          expanded={!tasks.length && item.id === latestTodos || item.id === latestPlan}
          onImplement={item.id === latestPlan && planReady ? implementPlan : undefined} /></div>;
        // Las preguntas se responden en el panel que sustituye a la caja de mensaje.
        case "permission": return item.state !== "pending" || item.toolName === "AskUserQuestion" ? null
          : <PermissionCard key={item.id} item={item} cwd={cwd} agent={agent.name} onAnswer={answer} />;
        case "notice": return <Notice key={item.id} tone={item.tone} text={item.text} />;
        case "turn": return <WorkSummary key={item.id} summary={summaries.get(item.id)!} durationMs={item.durationMs} animate={animate} />;
      }
    });
    return activityGroups(visibleItems, props.itemLabels).map(group => {
      if (!group.author) return rendered[group.start];
      const items = visibleItems.slice(group.start, group.end);
      const live = !!group.author.busy && !visibleItems.slice(group.end).some(item => props.itemLabels?.[item.id]?.memberId === group.author!.memberId);
      return <SubagentActivity key={items[0].id} author={group.author} items={items} live={live}>{rendered.slice(group.start, group.end).filter((_row, at) => items[at].kind !== "user")}</SubagentActivity>;
    });
  }, [threadItems, threadStart, enterFrom, provider, editingId, running, submittingEdit, busy, responseOrigins, summaries, latestTodos, latestPlan,
    planReady, cwd, agent.name, beginEdit, resendMessage, regenerateMessage, implementPlan, answer, props.historyReadOnly, props.itemLabels, props.browser, props.planningOnly, mode, session, tasks.length]);
  const stderrTail = state.stderr.slice(-6).join("\n");

  return <div ref={rootRef} className={`chat${empty ? " is-empty" : ""}${dragging ? " is-dragging" : ""}`}
    style={{ "--chat-font-size": `${settings.fontSize}px` } as CSSProperties}
    onDragOver={event => { if (hasFiles(event.dataTransfer)) { event.preventDefault(); setDragging(true); } }}
    onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }}
    onDrop={event => {
      if (!hasFiles(event.dataTransfer)) return;
      event.preventDefault();
      setDragging(false);
      addDropped(Array.from(event.dataTransfer.files));
    }}>
    <div className="chat-floating-toolbar" ref={toolbarRef}>{props.toolbar}</div>
    <div className="chat-task-toolbar"><button ref={taskToggle} type="button" className="chat-task-toggle" aria-expanded={tasksOpen} aria-controls={tasksOpen?`tasks-${sessionId}`:undefined}
      onClick={() => setTasksOpen(value => !value)}><ListIcon size={14} />Tareas{tasks.length>0&&<small>{tasks.filter(task => task.status === "completed").length}/{tasks.length}</small>}</button></div>
    <div className="chat-workspace"><div className="chat-main">
    <div className="chat-scroll" ref={scrollRef} onScroll={onScroll}>
      <SharedFilesContext.Provider value={filesContext}>
      <div className="chat-thread" ref={threadRef}>
        {props.workflow && <div className={`chat-workflow is-${props.workflow.status}`} aria-label="Control entre agentes">
          <div className="chat-workflow-route">
            <span className={props.workflow.role === "planner" ? "current" : ""}><MapIcon size={13} />
              <span><small>Planificación</small><strong>{props.workflow.planner.profileName}</strong><em>{props.workflow.planner.model ?? "Modelo del perfil"}{props.workflow.planner.effort ? ` · ${effortLabel(props.workflow.planner.effort)}` : ""}</em></span></span>
            <i className="chat-workflow-arrow" aria-hidden="true"><ArrowDownIcon size={13} /></i>
            <span className={props.workflow.role === "executor" ? "current" : ""}><AgentIcon kind={props.workflow.executor.provider} size={14} />
              <span><small>Implementación</small><strong>{props.workflow.executor.profileName}</strong><em>{props.workflow.executor.model ?? "Modelo del perfil"}{props.workflow.executor.effort ? ` · ${effortLabel(props.workflow.executor.effort)}` : ""}</em></span></span>
          </div>
          <div className="chat-workflow-state" role="status">
            <span>{props.workflow.error ?? ({ planning: "Preparando el plan · implementación automática al terminar", waiting: "Esperando el plan definitivo",
              transferring: "Guardando el plan y preparando al ejecutor…", executing: props.workflow.role === "planner" ? "Plan entregado al ejecutor" : "Implementando el plan",
              completed: "Respuesta del ejecutor lista", paused: "Flujo pausado", failed: "Flujo detenido por un error" })[props.workflow.status]}</span>
            <div className="chat-workflow-actions">
              {props.workflow.peerTabId && <button type="button" onClick={() => props.onWorkflowPeer?.(props.workflow!.peerTabId!)}>
                {props.workflow.role === "planner" ? "Ver implementación" : "Ver planificación"}</button>}
              {["planning", "waiting", "transferring", "executing"].includes(props.workflow.status)
                ? <button type="button" onClick={stopResponse}>Detener flujo</button>
                : props.workflow.status !== "completed" && !(props.workflow.role === "planner" && props.workflow.peerTabId)
                  && !handoffPending && <button type="button" disabled={running || queueSaving || hasQueued || !session.queue.ready || handoffDelivery.loading}
                    onClick={() => void workflowControl.resume()}>{props.workflow.role === "planner" && props.workflow.plan ? "Reintentar implementación" : "Reanudar flujo"}</button>}
            </div>
          </div>
        </div>}
        {empty && !handoffPending && (props.emptyState ? <ChatWelcome content={props.emptyState} provider={provider} /> : <div className="chat-empty">
          <AgentIcon kind={provider} size={30} activity={activity} />
          <h2>¿En qué trabajamos en {projectName}?</h2>
          <p>{cwd}</p>
        </div>)}
        {threadStart > 0 && <button type="button" className="chat-earlier" onClick={showEarlier}>
          Mostrar mensajes anteriores
        </button>}
        {rows}
        {running && permissions === 0 && <div className="chat-working" role="status">
          <span className="chat-working-dot" aria-hidden="true" />
          <span className="chat-working-label">{thinking ? "Pensando…" : "Trabajando…"}</span>
          {state.turnStartedAt !== null && <WorkingTime since={state.turnStartedAt} live={visible} />}
          <span className="chat-working-hint">Esc para detener</span>
        </div>}
        {handoffPending && <div className="chat-handoff-status" role={handoffDelivery.error ? "alert" : "status"}>
          <div className="chat-handoff-heading"><RotateIcon size={16} /><strong>Continuación de {props.handoff?.sourceLabel}</strong></div>
          <p>{handoffDelivery.error ?? (handoffDelivery.sending ? "Entregando el contexto al asistente…"
            : handoffDelivery.loading ? "Recuperando el contexto guardado…"
            : props.workflow?.status === "paused" ? "Flujo pausado. El contexto se enviará al reanudar."
            : handoffDelivery.requiresReview ? "El contexto sigue disponible. Revisa el historial antes de volver a enviarlo."
            : "Preparando al asistente para continuar el trabajo…")}</p>
          {(handoffDelivery.error || handoffDelivery.requiresReview || props.workflow?.status === "paused" || props.workflow?.status === "failed" || state.process === "failed" || state.process === "exited") &&
            <button type="button" className="btn btn-small" disabled={handoffDelivery.loading || handoffDelivery.sending || running}
              onClick={() => {
                if (props.workflow) props.onWorkflowStatus?.(sessionId, props.workflow.id, props.workflow.role === "planner" ? "planning" : "executing");
                handoffDelivery.retry();
              }}>{props.workflow?.status === "paused" ? "Reanudar flujo" : handoffDelivery.requiresReview && !handoffDelivery.error ? "Enviar contexto" : "Reintentar continuación"}</button>}
        </div>}
        {!handoffPending && session.setup && state.process !== "exited" && state.process !== "failed" && <div className="chat-ended">
          <p>{session.setup.description}</p>{session.setup.actions.map(action => <button key={action.label} type="button" className="btn btn-small" disabled={session.setup!.busy}
            onClick={() => void action.run()}>{session.setup!.busy ? "Conectando…" : action.label}</button>)}
        </div>}
        {!handoffPending && (state.process === "exited" || state.process === "failed") && <div className="chat-ended">
          <div>
            <strong>{state.process === "failed" ? `${agent.product} no pudo arrancar` : `La sesión de ${agent.product} se cerró`}</strong>
            {state.exitCode !== null && state.exitCode !== 0 && <span> · código {state.exitCode}</span>}
          </div>
          {stderrTail && <pre>{stderrTail}</pre>}
          {session.setup && <><p>{session.setup.description}</p>{session.setup.actions.map(action => <button key={action.label} type="button" className="btn btn-small" disabled={session.setup!.busy}
            onClick={() => void action.run()}>{session.setup!.busy ? "Conectando…" : action.label}</button>)}</>}
          <button type="button" className="btn btn-small" disabled={session.setup?.busy} onClick={() => void session.start().catch(error => session.notice("error", formatError(error)))}>
            {state.process === "failed" ? "Reintentar" : "Reanudar conversación"}
          </button>
        </div>}
      </div>
      </SharedFilesContext.Provider>
    </div>

    {!atBottom && !empty && <button type="button" className="chat-to-bottom" onClick={scrollToBottom}>
      <ArrowDownIcon size={13} /> Ir al final
    </button>}

    <div className="chat-composer-wrap" ref={composerRef}>
     <div className="chat-composer-accessories">
      {props.composerLead && <ComposerPanel label="Planificación" title="Planificación y ejecución" icon={<MapIcon size={13} />}>{props.composerLead}</ComposerPanel>}
      <BackgroundTerminals owners={props.terminalOwners ?? (session.terminals ? [{ id: sessionId, label: props.profileName ?? agent.name, provider, session: session.terminals }] : [])} />
      <QueuedMessages compact onFocusComposer={() => inputRef.current?.focus({ preventScroll: true })} queue={session.queue} running={running} busy={queueSaving || submittingEdit || handoffPending || workflowLocked}
        onContinue={wakeQueue} onRemove={id => { void queueAction(() => session.queue.client.remove(id)).catch(error => callbacks.current.onMessage(formatError(error))); }}
        onEdit={(id, text, expectedText) => queueAction(() => session.queue.client.update(id, text, expectedText))}
        onSendNow={sendQueuedNow} onRestoreDirect={id => queueAction(() => session.queue.client.restoreDirect(id))}
        directDisabledReason={message => hasDirectQueue ? "Revisa el envío directo pendiente antes de enviar otro mensaje." : props.queuedSendReason?.(message) ?? null} />
     </div>
     <div className="chat-dock">
      {showSuggestions && !question && <Suggestions id={`${sessionId}-suggestions`} items={suggestions} active={selectedSuggestion} loading={loadingSuggestions}
        loadingLabel={wantsSkills ? "Cargando skills…" : "Buscando archivos…"}
        emptyLabel={wantsSkills ? skillsError ?? (state.skills.length ? "No hay skills que coincidan con tu búsqueda." : "No hay skills disponibles en esta sesión.") : undefined}
        onPick={pick} onHover={setActive} />}
      {question && <QuestionPanel key={question.id} item={question} agent={agent.name} active={visible && focused} onAnswer={answer} />}
      {/* Mientras hay una pregunta, la caja se oculta sin desmontarse: lo escrito sigue ahí al volver. */}
      <form className="chat-composer" hidden={!!question} onSubmit={event => { event.preventDefault(); send(); }}>
        {editing && <div className="chat-edit-banner" role="status">
          <PencilIcon size={14} /><span><strong>Editar mensaje</strong><small>Regenera las respuestas desde este punto</small></span>
          <button type="button" className="chat-copy tip" aria-label="Cancelar edición" data-tip="Cancelar edición (Esc)"
            disabled={submittingEdit} onClick={cancelEdit}><CloseIcon size={14} /></button>
        </div>}
        {(attachments.length > 0 || docs.length > 0) && <div className="chat-attachments">
          {attachments.map((image, index) => <div key={image.id} className={`chat-attachment${image.preparing ? " loading" : ""}`}>
            <button type="button" className="chat-attachment-view" aria-label={`Ver imagen ${index + 1}: ${image.name}`}
              title={`${imageReference(index)} · ${image.name}`} disabled={image.preparing}
              onClick={() => {
                const ready = attachments.filter(item => !item.preparing);
                viewer.open(ready.map(item => ({ src: item.preview, name: `${imageReference(attachments.indexOf(item))} · ${item.name}` })), ready.indexOf(image));
              }}>
              {image.preparing ? <span className="chat-spinner" aria-label="Preparando imagen" /> : <img src={image.preview} alt={image.name} />}
              <span className="chat-image-number" aria-hidden="true">{index + 1}</span>
            </button>
            <button type="button" className="chat-attachment-remove" aria-label={`Quitar imagen ${index + 1}: ${image.name}`}
              disabled={submittingEdit} onClick={() => removeImage(image.id)}><CloseIcon size={11} strokeWidth={2.2} /></button>
          </div>)}
          {docs.map((file, index) => <div key={file.id} className={`chat-attachment chat-attachment-file${file.preparing ? " loading" : ""}`}>
            <button type="button" className="chat-attachment-view" aria-label={`Abrir archivo ${index + 1}: ${file.name}`}
              title={`${fileReference(index)} · ${file.path || file.name}`} disabled={file.preparing}
              onClick={() => void openFile(file.path).catch(error => callbacks.current.onMessage(formatError(error)))}>
              <span className="chat-attachment-icon">
                {file.preparing ? <span className="chat-spinner" aria-label="Preparando archivo" /> : <FileBadge name={file.name} dir={false} />}
                <span className="chat-image-number" aria-hidden="true">{index + 1}</span>
              </span>
              <span className="chat-attachment-text">
                <span className="chat-attachment-name">{file.name}</span>
                <span className="chat-attachment-detail">{file.preparing ? "Preparando…"
                  : [KIND_LABELS[fileKind(file.name)], file.size >= 0 ? formatBytes(file.size) : ""].filter(Boolean).join(" · ")}</span>
              </span>
            </button>
            <button type="button" className="chat-attachment-remove" aria-label={`Quitar archivo ${index + 1}: ${file.name}`}
              disabled={submittingEdit} onClick={() => removeDoc(file.id)}><CloseIcon size={11} strokeWidth={2.2} /></button>
          </div>)}
        </div>}
        <div className="chat-input-row">
        <div className="chat-input-field">
        {/* Detrás de la caja, el mismo texto con las citas de imágenes y archivos resaltadas. */}
        <div ref={mirrorRef} className="chat-input-mirror" aria-hidden="true">
          {referenceParts(draft, { Imagen: attachments.length, Archivo: docs.length }).map((part, index) => "kind" in part
            ? <mark key={index} className="chat-ref" data-kind={part.kind}><span>[</span>{part.text.slice(1, -1)}<span>]</span></mark>
            : part.text)}
          {draft.endsWith("\n") ? "​" : ""}
        </div>
        <textarea ref={inputRef} rows={1} value={draft} readOnly={workflowLocked || submittingEdit || queueSaving || handoffPending} aria-label={`Mensaje para ${agent.name}`}
          aria-autocomplete="list" aria-expanded={showSuggestions} aria-controls={showSuggestions ? `${sessionId}-suggestions` : undefined}
          aria-activedescendant={showSuggestions && suggestions.length ? `${sessionId}-suggestions-${selectedSuggestion}` : undefined}
          placeholder={running
            ? sendDuringWork === "queue" ? "Añade un mensaje a la cola…" : "Envía una indicación…"
            : props.composerPlaceholder??"Escribe un mensaje…"}
          onChange={event => { setDraft(event.target.value); setCaret(event.target.selectionStart); if (!event.target.value) setDismissed(null); }}
          onSelect={event => setCaret(event.currentTarget.selectionStart)}
          onScroll={event => { if (mirrorRef.current) mirrorRef.current.scrollTop = event.currentTarget.scrollTop; }}
          onPaste={event => {
            const files = Array.from(event.clipboardData.items)
              .filter(item => item.kind === "file")
              .map(item => item.getAsFile()).filter((file): file is File => !!file);
            if (files.length) {
              event.preventDefault();
              addDropped(files);
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
              if (((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") && suggestions[selectedSuggestion]) {
                event.preventDefault();
                pick(suggestions[selectedSuggestion], event.key === "Tab");
                return;
              }
              if (event.key === "Enter" && !event.shiftKey && wantsSkills) { event.preventDefault(); return; }
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
            } else if (event.key === "Escape" && editing) {
              event.preventDefault();
              cancelEdit();
            } else if (event.key === "Escape" && running) {
              event.preventDefault();
              stopResponse();
            }
          }} />
        </div>
        <div className="chat-input-actions">
          <button type="button" className="chat-icon-btn tip" data-tip="Adjuntar imágenes o archivos" aria-label="Adjuntar imágenes o archivos"
            disabled={submittingEdit || queueSaving || handoffPending}
            onClick={() => void attachFiles()}><PaperclipIcon size={17} /></button>
          {(running || hasQueued) && !editing && (provider === "trex" || provider === "antigravity" ? <span className="chat-tray-chip chat-message-delivery" title={provider === "antigravity" ? "Los mensajes en cola se entregan con sus adjuntos al terminar la respuesta" : "El agente consulta tus mensajes en cola cuando llega a un punto adecuado"}>En cola</span> : <Select className="chat-tray-chip chat-tray-select chat-message-delivery" menuClassName="chat-glass-menu" value={sendDuringWork}
            options={[{ value: "queue", label: "En cola", description: "El agente decide cuándo leer el mensaje" },
              { value: "now", label: "Enviar ahora", description: "Entrega el mensaje durante el trabajo en curso" }]}
            align="end" onChange={setSendDuringWork} aria-label="Entrega de mensajes durante el trabajo" />)}
          {running && !draft.trim() && !attachments.length && !docs.length
            ? <button type="button" className="chat-send stop tip" aria-label="Detener" data-tip="Detener (Esc)" onClick={stopResponse}><StopIcon /></button>
            : <button type="submit" className="chat-send tip" aria-label={editing ? "Guardar y regenerar" : (running || hasQueued) && sendDuringWork === "queue" ? "Añadir a la cola" : "Enviar"}
              data-tip={editing ? "Guardar y regenerar" : (running || hasQueued) && sendDuringWork === "queue" ? "Añadir a la cola" : "Enviar"}
              disabled={workflowLocked || handoffPending || !session.queue.ready || queueSaving || (!draft.trim() && !attachments.length && !docs.length) || preparing > 0 || submittingEdit || (!!editing && running)}>
                {submittingEdit || queueSaving ? <span className="chat-spinner" /> : <ArrowUpIcon />}</button>}
        </div>
        </div>
      </form>
      <div className="chat-controls">
      <div className="chat-tray">
        <ModelMenu provider={provider} models={state.models} model={state.model} choice={state.modelChoice}
          onModel={model => { session.setModel(model); backToInput(); }} openSignal={menuSignal.model} triggerClassName="chat-composer-model" />
        <ComposerSettings mode={mode} modes={modeOptions} onMode={session.setMode}
          levels={efforts} effort={state.effort} onEffort={session.setEffort} speed={speed} fast={state.fast} onFast={session.setFast}
          openSignal={menuSignal} />
        {props.browser?.enabled && <BrowserMenu cwd={cwd} browser={props.browser} spaces={props.browserSpaces} onStopAgent={props.onStopBrowserAgent} />}
        <span className="chat-composer-spacer" />
        {props.onPlanHere && provider !== "antigravity" && <button type="button" className="chat-tray-chip chat-plan-here" disabled={handoffDisabled}
          onClick={event => { event.currentTarget.focus({ preventScroll: true }); planHere(); }}><MapIcon size={13} /><span>Planear aquí</span></button>}
        {props.onHandoffRequest && <button type="button" className="chat-tray-chip chat-handoff-button tip"
          aria-label="Continuar con otro agente" data-tip={handoffHint} disabled={handoffDisabled}
          onClick={event => { event.currentTarget.focus({ preventScroll: true }); requestHandoff(); }}><span>Continuar con otro agente</span><span className="chat-handoff-arrow" aria-hidden="true">↗</span></button>}
      </div>
      <div className="chat-composer-meta">
        {(usage || state.plan || state.costUsd !== null || provider === "trex" || provider === "antigravity") && <UsageMenu usage={usage} plan={state.plan} apiUsage={state.apiUsage} costUsd={state.costUsd} product={agent.product} busy={handoffPending || running || state.process !== "ready"}
          controls={session.usageControls} canCompact={session.supportsCompact} showUnavailable={provider === "trex" || provider === "antigravity"}
          onOpenAll={() => callbacks.current.onOpenUsage()}
          onCompact={() => {
            stickRef.current = true;
            // Claude Code resume con su propio `/compact`; Codex, con su petición.
            if (!runLocal("compact", "")) session.send("/compact", [], []);
            backToInput();
          }} />}
        {branch && <BranchMenu cwd={cwd} branch={branch} busy={running || submittingEdit} visible={visible}
          onChange={setBranch} onMessage={message => callbacks.current.onMessage(message)} />}
      </div>
      </div>
     </div>
    </div>
    </div>
    {tasksOpen && <TaskPanel panelId={`tasks-${sessionId}`} tasks={tasks} author={props.taskAuthor ?? props.profileName ?? agent.name} paused={props.tasksPaused}
      onClose={() => { setTasksOpen(false); taskToggle.current?.focus({ preventScroll: true }); }} onReveal={revealTask} />}
    </div>
  </div>;
}

function ClaudeChat(props: ChatViewProps) {
  return <ChatPanel {...props} session={useClaudeChat(props)} />;
}

function CodexChat(props: ChatViewProps) {
  return <ChatPanel {...props} session={useCodexChat(props)} />;
}

function ChatView(input: ChatViewProps) {
  const browser = useRef(browserOptions(input.settings, input.sessionId,
    [input.profileName ?? (input.provider === "claude" ? "Claude Code" : input.provider === "codex" ? "Codex" : input.provider === "antigravity" ? "Antigravity" : "Trex CLI"),input.sessionTitle].filter(Boolean).join(" · "))).current;
  const desktopEnabled = useRef(input.settings.desktopEnabled).current;
  const props = { ...input, browser, desktopEnabled };
  return props.provider === "antigravity" ? <AntigravityChat {...props} /> : props.provider === "trex" ? <TrexChat {...props} /> : props.provider === "codex" ? <CodexChat {...props} /> : <ClaudeChat {...props} />;
}

function TrexChat(props: ChatViewProps) {
  return <ChatPanel {...props} historyReadOnly session={useTrexChat(props)} />;
}
function AntigravityChat(props: ChatViewProps) {
  return <ChatPanel {...props} historyReadOnly session={useAntigravityChat(props)} />;
}

export default memo(ChatView);
