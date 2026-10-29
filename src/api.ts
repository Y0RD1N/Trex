import type { BrowserStatus, BrowserConfig, BrowserCall, BrowserResult, BrowserMode, BrowserProfile, BrowserOptions, BrowserSpace } from "./browser";
import { validBrowserProfile, browserSpaceLabel } from "./browser";
/**
 * Capa de acceso al backend: envoltorios de `invoke`/`listen` y utilidades
 * compartidas (ids, valores por defecto, normalización y color de acento).
 */
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { initialProfiles, normalizeLaunch, normalizeProfiles } from "./profiles";
import { DEFAULT_PASTE_SHORTCUT, parseShortcut, type ClipboardContent } from "./paste";
import { DEFAULT_CURSOR_STYLE, DEFAULT_CURSOR_WIDTH, normalizeCursorStyle, normalizeCursorWidth } from "./cursor";
import { normalizeDesign } from "./visualDesign";
import { normalizeShortcuts, bindingError, keyError } from "./shortcuts";
import { normalizeSplitLayout, type SplitLayout } from "./splitLayout";
import { validConversationId, validAcpId } from "./conversations";
import { normalizeHandoffReference, type HandoffContext, type PreparedHandoff } from "./handoff";
import { normalizeEffortChoice, normalizeModelChoice } from "./chatState";
import { normalizeAgentWorkflow } from "./agentWorkflow";
import { normalizeAgentRoom } from "./agentRoom";
import { normalizeAgentTeam } from "./agentTeam";
import { normalizeProjectFilter } from "./projectFilter";
import type {
  AgentProvider,
  AppConfig,
  AppInfo,
  ClaudeInfo,
  PersistedTab,
  Project,
  PtyDataPayload,
  PtyExitPayload,
  SessionInfo,
  Settings,
  SpawnRequest,
  SpawnResponse,
  TabKind,
  UiStateExtended,
} from "./types";

// --- Utilidades básicas ----------------------------------------------------

/** Decodifica una cadena base64 (payload de `pty-data-*`) a bytes. */
export const b64ToBytes = (b64: string): Uint8Array => {
  // WebKit reciente decodifica directamente a bytes sin una cadena intermedia.
  // Conserva el camino compatible para WebViews que aún no tengan esta API.
  const fromBase64 = (Uint8Array as typeof Uint8Array & {
    fromBase64?: (value: string) => Uint8Array;
  }).fromBase64;
  if (fromBase64) return fromBase64(b64);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

/** Genera un id de sesión PTY válido: "t-<timestamp>-<aleatorio4>". */
export const newSessionId = (): string =>
  `t-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

/** Genera un id de proyecto único. */
export const newProjectId = (): string =>
  `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

/** Limita un número a un rango. */
export const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

/** Convierte un error desconocido en un mensaje legible. */
export const formatError = (error: unknown): string => {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
};

/** Extrae el último segmento de una ruta (admite separadores `\` y `/`). */
export const deriveProjectName = (path: string): string => {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : path;
};

/** Normaliza una ruta para comparar duplicados (sin separador final y sin distinguir mayúsculas). */
export const normalizePath = (path: string): string =>
  path.replace(/[\\/]+$/, "").replace(/\//g, "\\").toLowerCase();

/** Normaliza texto para buscar: sin acentos, sin mayúsculas y sin espacios de sobra. */
export const normalizeText = (value: string): string =>
  value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();

// --- Comandos del backend ---------------------------------------------------

export const loadConfig = (): Promise<AppConfig> => invoke<AppConfig>("load_config");

export type IntegrationDependencies = { blender: boolean; hyperframes: boolean; hyperframesLocal: boolean; githubCli: boolean; node: boolean; ffmpeg: boolean };
export const integrationDependencies = (cwd?: string): Promise<IntegrationDependencies> => invoke("integration_dependencies", { cwd: cwd ?? null });
export type GitHubConnectionStatus = "connected" | "unavailable" | "timeout" | "notFound";
export const githubConnectionStatus = (): Promise<GitHubConnectionStatus> => invoke("github_connection_status");
export type DesktopStatus = { available: boolean; backend: string; coordinateSpace: string; reason: string | null; monitors: { id: number; name: string; primary: boolean; x: number; y: number; width: number; height: number; scaleFactor: number }[] };
export const desktopStatus = (): Promise<DesktopStatus> => invoke("trex_desktop_status");

export const saveConfig = (config: AppConfig): Promise<AppConfig> =>
  invoke<AppConfig>("save_config", { config });

export const prepareHandoff = (context: HandoffContext): Promise<PreparedHandoff> =>
  invoke("prepare_handoff", { cwd: context.source.cwd, sourceSessionId: context.source.sessionId,
    sourceProvider: context.source.provider, sourceLabel: context.source.profileName, content: context.content });

export const loadHandoff = (id: string): Promise<PreparedHandoff> => invoke("load_handoff", { id });

export const getAppInfo = (): Promise<AppInfo> => invoke<AppInfo>("app_info");

export const detectClaude = (): Promise<ClaudeInfo> => invoke<ClaudeInfo>("detect_claude");
export const detectCodex = (): Promise<ClaudeInfo> => invoke<ClaudeInfo>("detect_codex");
export const readClipboard = (): Promise<ClipboardContent> => invoke<ClipboardContent>("read_clipboard");
export const writeClipboard = (text: string): Promise<void> => isTauri()
  ? invoke<void>("write_clipboard", { text }) : navigator.clipboard.writeText(text);
export const claudeRewindPoint = (configDir: string, id: string, messageId: string): Promise<string | null> =>
  invoke("claude_rewind_point", { configDir, id, messageId });

export const ptySpawn = (request: SpawnRequest): Promise<SpawnResponse> =>
  invoke<SpawnResponse>("pty_spawn", { request });

export const ptyWrite = (id: string, data: string): Promise<void> =>
  invoke<void>("pty_write", { id, data });

export const ptyAck = (id: string, bytes: number): Promise<void> =>
  invoke<void>("pty_ack", { id, bytes });

export const ptyResize = (id: string, cols: number, rows: number): Promise<void> =>
  invoke<void>("pty_resize", { id, cols, rows });

export const ptyKill = (id: string): Promise<number | null> =>
  invoke<number | null>("pty_kill", { id });

export const ptyList = (): Promise<SessionInfo[]> => invoke<SessionInfo[]>("pty_list");

/** Proceso de un asistente en modo chat: JSON por líneas, sin terminal. */
export type AgentSpawnRequest = {
  id: string;
  cwd: string;
  command: string;
  profileArgs: string | null;
  flags: string[];
  shell: string;
  env: Record<string, string> | null;
};

export const agentSpawn = (request: AgentSpawnRequest): Promise<{ id: string; program: string; viaShell: boolean }> =>
  invoke("agent_spawn", { request });

export const agentWrite = (id: string, line: string): Promise<void> =>
  invoke<void>("agent_write", { id, line });

export const agentKill = (id: string): Promise<void> => invoke<void>("agent_kill", { id });
export const agentTerminalOutput = (id: string, taskId: string): Promise<{ text: string; truncated: boolean }> =>
  invoke("agent_terminal_output", { id, taskId });

export const messageQueueMcpConfig = (queueId: string, tasksOnly = false): Promise<Record<string, unknown>> =>
  invoke("message_queue_mcp_config", { queueId, tasksOnly });

export type AntigravityRuntime = { installed: boolean; command: string | null; version: string | null; flags: string[]; env: Record<string, string> };
export const antigravityRuntime = (command = "antigravity-acp", configDir = ""): Promise<AntigravityRuntime> => invoke("antigravity_runtime", { command, configDir });
export const installAntigravity = (): Promise<AntigravityRuntime> => invoke("antigravity_install");

/** Archivos del proyecto (relativos a su carpeta) para las menciones con `@`. */
export const listProjectFiles = (cwd: string): Promise<string[]> => invoke<string[]>("list_project_files", { cwd });

/** Rama de git del proyecto (null si la carpeta no es un repositorio). */
export const gitBranch = (cwd: string): Promise<string | null> => invoke<string | null>("git_branch", { cwd });

export type GitBranchInfo = { name: string; reference: string; remote: boolean; current: boolean; upstream: string | null };
export type GitBranches = { current: string | null; detached: boolean; branches: GitBranchInfo[] };
export const listGitBranches = (cwd: string): Promise<GitBranches> => invoke("git_branches", { cwd });
export const switchGitBranch = (cwd: string, reference: string): Promise<GitBranches> => invoke("git_switch_branch", { cwd, reference });
export const createGitBranch = (cwd: string, name: string): Promise<GitBranches> => invoke("git_create_branch", { cwd, name });

/** Ventana de contexto de cada modelo de Codex (de su caché local); vacío si no se sabe. */
export const codexContextWindows = (configDir: string): Promise<Record<string, number>> =>
  invoke<Record<string, number>>("codex_context_windows", { configDir });

// --- Eventos ----------------------------------------------------------------

export const listenPtyData = (
  id: string,
  callback: (payload: PtyDataPayload) => void,
): Promise<UnlistenFn> =>
  listen<PtyDataPayload>(`pty-data-${id}`, (event) => callback(event.payload));

export const listenPtyExit = (
  id: string,
  callback: (payload: PtyExitPayload) => void,
): Promise<UnlistenFn> =>
  listen<PtyExitPayload>(`pty-exit-${id}`, (event) => callback(event.payload));

export const listenAgentLine = (id: string, callback: (line: string) => void): Promise<UnlistenFn> =>
  listen<{ line: string }>(`agent-line-${id}`, (event) => callback(event.payload.line));

export const listenAgentStderr = (id: string, callback: (line: string) => void): Promise<UnlistenFn> =>
  listen<{ line: string }>(`agent-stderr-${id}`, (event) => callback(event.payload.line));

export const listenAgentExit = (id: string, callback: (code: number | null) => void): Promise<UnlistenFn> =>
  listen<{ code: number | null }>(`agent-exit-${id}`, (event) => callback(event.payload.code));

// --- Valores por defecto ----------------------------------------------------

export const DEFAULT_FONT_FAMILY =
  '"JetBrains Mono Variable", "Hack Nerd Font Mono", "Noto Sans Symbols 2", "Noto Color Emoji", ui-monospace, "Cascadia Mono", monospace';

export const DEFAULT_SETTINGS: Settings = {
  desktopEnabled: false,
  browserEnabled: true,
  browserProfile: "BROWSER1",
  profiles: initialProfiles({ claudeCommand: "claude", claudeArgs: "", launchMode: "arg" }),
  defaultProfileId: "claude-default",
  shell: "default",
  claudeCommand: "claude",
  claudeArgs: "",
  autoRunClaude: true,
  fontSize: 14,
  fontFamily: "",
  scrollback: 10000,
  cursorBlink: true,
  cursorStyle: DEFAULT_CURSOR_STYLE,
  cursorWidth: DEFAULT_CURSOR_WIDTH,
  copyOnSelect: false,
  pasteShortcut: DEFAULT_PASTE_SHORTCUT,
  shortcuts: normalizeShortcuts({}, DEFAULT_PASTE_SHORTCUT),
  imagePastePreview: true,
  desktopNotifications: true,
  notifyWhenFocused: false,
  confirmCloseTab: true,
  restoreOnStart: true,
  launchMode: "arg",
  theme: "#e8834a",
  appearance: "dark",
  ...normalizeDesign({}),
};

const DEFAULT_UI: UiStateExtended = {
  projectFilter: { mode: "all", projectIds: [] },
  lastProjectId: null,
  sidebarWidth: 290,
  activeProjectId: null,
  sidebarCollapsed: false,
  notificationSound: true,
  autoHideTopBar: true,
  splitLayouts: {},
};

export const DEFAULT_CONFIG: AppConfig = {
  version: 1,
  projects: [],
  settings: DEFAULT_SETTINGS,
  ui: DEFAULT_UI,
};

/** Colores disponibles para los proyectos nuevos (se asignan en ciclo). */
export const PROJECT_COLORS: ReadonlyArray<string> = [
  "#e8834a",
  "#8b7ef8",
  "#4cc2b0",
  "#e0af68",
  "#f7768e",
  "#7aa2f7",
  "#9ece6a",
  "#bb9af7",
];

/** Presets de color de acento del panel de ajustes. */
export const ACCENT_PRESETS: ReadonlyArray<{ name: string; value: string }> = [
  { name: "Naranja", value: "#e8834a" },
  { name: "Violeta", value: "#8b7ef8" },
  { name: "Azul", value: "#7aa2f7" },
  { name: "Verde", value: "#4cc2b0" },
  { name: "Rosa", value: "#f7768e" },
  { name: "Ámbar", value: "#e0af68" },
];

/** Comandos de instalación de Claude Code por plataforma. */
export const CLAUDE_INSTALL_COMMANDS = {
  windows: "irm https://claude.ai/install.ps1 | iex",
  unix: "curl -fsSL https://claude.ai/install.sh | bash",
  npm: "npm install -g @anthropic-ai/claude-code",
} as const;

// --- Color de acento --------------------------------------------------------

type Rgb = [number, number, number];

const BLACK: Rgb = [0, 0, 0];
const WHITE: Rgb = [255, 255, 255];
/** Tinta oscura que usamos sobre el acento sólido cuando toca texto claro/oscuro. */
const INK: Rgb = [11, 14, 19];

/** Convierte "#rrggbb" (o "#rgb") en componentes RGB. */
const hexToRgb = (hex: string): Rgb => {
  const clean = hex.replace("#", "").trim();
  const full =
    clean.length === 3
      ? clean
          .split("")
          .map((c) => c + c)
          .join("")
      : clean;
  const value = Number.parseInt(full, 16);
  if (!Number.isFinite(value)) return hexToRgb(DEFAULT_SETTINGS.theme);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
};

/** Mezcla dos colores: `amount` 0 = a, 1 = b. */
const mixRgb = (a: Rgb, b: Rgb, amount: number): Rgb => {
  const t = clamp(amount, 0, 1);
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
};

/** Luminancia relativa (fórmula WCAG). */
const luminance = ([r, g, b]: Rgb): number => {
  const channel = (value: number): number => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
};

/** Relación de contraste WCAG entre dos colores (1 – 21). */
const contrast = (a: Rgb, b: Rgb): number => {
  const la = luminance(a);
  const lb = luminance(b);
  const high = Math.max(la, lb);
  const low = Math.min(la, lb);
  return (high + 0.05) / (low + 0.05);
};

const toCss = (rgb: Rgb): string => `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
const toRgba = (rgb: Rgb, alpha: number): string =>
  `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha})`;

/**
 * Oscurece el acento lo justo para que se lea sobre blanco (AA 4.5:1).
 * Así el acento sigue reconociéndose aunque el preset sea claro (ámbar).
 */
const readableOnLight = (rgb: Rgb): Rgb => {
  let amount = 0.26;
  let result = mixRgb(rgb, BLACK, amount);
  while (contrast(result, WHITE) < 4.5 && amount < 1) {
    amount = Math.min(1, amount + 0.04);
    result = mixRgb(rgb, BLACK, amount);
  }
  return result;
};

/** Texto que mejor contrasta sobre un fondo sólido. */
const inkOver = (background: Rgb): string =>
  toCss(contrast(INK, background) >= contrast(WHITE, background) ? INK : WHITE);

/**
 * Aplica el color de acento a las variables CSS globales.
 *
 * Genera las variantes que necesita la interfaz en cada modo:
 *   --accent          color base (fondos sólidos, indicadores)
 *   --accent-hover    variante para el hover de los botones sólidos
 *   --accent-strong   variante con contraste garantizado para texto e iconos
 *   --accent-contrast tinta legible sobre el acento sólido
 *   --accent-soft     tinte sutil (hover)
 *   --accent-soft-strong tinte algo más marcado (elementos activos)
 *   --accent-dim      bordes y separadores teñidos
 *   --accent-glow     halo decorativo (bienvenida)
 */
export const applyAccent = (color: string): void => {
  const rgb = hexToRgb(color || DEFAULT_SETTINGS.theme);
  const isLight = document.documentElement.dataset.theme === "light";
  const root = document.documentElement;

  const strong = isLight ? readableOnLight(rgb) : mixRgb(rgb, WHITE, 0.12);

  root.style.setProperty("--accent", toCss(rgb));
  root.style.setProperty("--accent-rgb", `${rgb[0]}, ${rgb[1]}, ${rgb[2]}`);
  root.style.setProperty(
    "--accent-hover",
    toCss(isLight ? mixRgb(rgb, BLACK, 0.08) : mixRgb(rgb, WHITE, 0.08)),
  );
  root.style.setProperty("--accent-strong", toCss(strong));
  root.style.setProperty("--accent-contrast", inkOver(rgb));
  root.style.setProperty("--accent-soft", toRgba(rgb, isLight ? 0.1 : 0.16));
  root.style.setProperty("--accent-soft-strong", toRgba(rgb, isLight ? 0.18 : 0.26));
  root.style.setProperty("--accent-dim", toRgba(rgb, isLight ? 0.42 : 0.5));
  root.style.setProperty("--accent-glow", toRgba(rgb, isLight ? 0.16 : 0.35));
};

// --- Normalización de la configuración --------------------------------------

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;

const asString = (value: unknown, fallback: string): string =>
  typeof value === "string" ? value : fallback;

const asBool = (value: unknown, fallback: boolean): boolean =>
  typeof value === "boolean" ? value : fallback;

const asNumber = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

const asNullableString = (value: unknown): string | null =>
  typeof value === "string" ? value : null;

/** Acento válido en hex; cualquier otra cosa cae al valor por defecto. */
const asAccent = (value: unknown): string =>
  typeof value === "string" && /^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(value.trim())
    ? value.trim()
    : DEFAULT_SETTINGS.theme;

/** Apariencia válida: "dark" | "light" | "system" (por defecto, oscuro). */
const asAppearance = (value: unknown): string =>
  value === "light" || value === "system" || value === "dark" ? value : DEFAULT_SETTINGS.appearance;

/**
 * Fusiona la configuración que llega del backend con los valores por defecto.
 * Es defensivo: si el archivo está incompleto o corrupto, la interfaz sigue viva.
 */
export const normalizeConfig = (raw: unknown): AppConfig => {
  const root = asRecord(raw) ?? {};
  const settingsRaw = asRecord(root.settings) ?? {};
  const uiRaw = asRecord(root.ui) ?? {};
  let pasteShortcut = typeof settingsRaw.pasteShortcut === "string" && !keyError(settingsRaw.pasteShortcut,true) ? parseShortcut(settingsRaw.pasteShortcut)! : DEFAULT_PASTE_SHORTCUT;
  let shortcuts = normalizeShortcuts(settingsRaw.shortcuts, pasteShortcut);
  if (bindingError(shortcuts,pasteShortcut)) { pasteShortcut = DEFAULT_PASTE_SHORTCUT; shortcuts = normalizeShortcuts(settingsRaw.shortcuts,pasteShortcut); }

  const settings: Settings = {
    desktopEnabled: asBool(settingsRaw.desktopEnabled, false),
    browserEnabled: asBool(settingsRaw.browserEnabled, DEFAULT_SETTINGS.browserEnabled),
    browserProfile: typeof settingsRaw.browserProfile === "string" && validBrowserProfile(settingsRaw.browserProfile) ? settingsRaw.browserProfile : "BROWSER1",
    profiles: [],
    defaultProfileId: asString(settingsRaw.defaultProfileId, DEFAULT_SETTINGS.defaultProfileId),
    shell: asString(settingsRaw.shell, DEFAULT_SETTINGS.shell),
    claudeCommand: asString(settingsRaw.claudeCommand, DEFAULT_SETTINGS.claudeCommand),
    claudeArgs: asString(settingsRaw.claudeArgs, DEFAULT_SETTINGS.claudeArgs),
    autoRunClaude: asBool(settingsRaw.autoRunClaude, DEFAULT_SETTINGS.autoRunClaude),
    fontSize: clamp(
      Math.round(asNumber(settingsRaw.fontSize, DEFAULT_SETTINGS.fontSize)),
      10,
      24,
    ),
    fontFamily: asString(settingsRaw.fontFamily, DEFAULT_SETTINGS.fontFamily),
    scrollback: clamp(
      Math.round(asNumber(settingsRaw.scrollback, DEFAULT_SETTINGS.scrollback)),
      200,
      200000,
    ),
    cursorBlink: asBool(settingsRaw.cursorBlink, DEFAULT_SETTINGS.cursorBlink),
    cursorStyle: normalizeCursorStyle(settingsRaw.cursorStyle),
    cursorWidth: normalizeCursorWidth(settingsRaw.cursorWidth),
    copyOnSelect: asBool(settingsRaw.copyOnSelect, DEFAULT_SETTINGS.copyOnSelect),
    pasteShortcut,
    shortcuts,
    imagePastePreview: asBool(settingsRaw.imagePastePreview, true),
    desktopNotifications: asBool(settingsRaw.desktopNotifications, true),
    notifyWhenFocused: asBool(settingsRaw.notifyWhenFocused, false),
    confirmCloseTab: asBool(settingsRaw.confirmCloseTab, DEFAULT_SETTINGS.confirmCloseTab),
    restoreOnStart: asBool(settingsRaw.restoreOnStart, DEFAULT_SETTINGS.restoreOnStart),
    launchMode: asString(settingsRaw.launchMode, DEFAULT_SETTINGS.launchMode),
    theme: asAccent(settingsRaw.theme),
    appearance: asAppearance(settingsRaw.appearance),
    ...normalizeDesign(settingsRaw),
  };
  settings.profiles = normalizeProfiles(settingsRaw.profiles, settings);
  if (!settings.profiles.some(profile => profile.id === settings.defaultProfileId)) settings.defaultProfileId = settings.profiles[0].id;

  const projects: Project[] = [];
  if (Array.isArray(root.projects)) {
    for (const entry of root.projects) {
      const rec = asRecord(entry);
      if (!rec) continue;
      const id = asString(rec.id, "");
      const path = asString(rec.path, "");
      if (!id || !path) continue;
      projects.push({
        id,
        path,
        name: asString(rec.name, deriveProjectName(path)),
        color: asNullableString(rec.color),
        favorite: asBool(rec.favorite, false),
        createdAt: asNumber(rec.createdAt, Date.now()),
        lastOpenedAt:
          typeof rec.lastOpenedAt === "number" ? rec.lastOpenedAt : null,
        defaultCommand: asNullableString(rec.defaultCommand),
        defaultArgs: asNullableString(rec.defaultArgs),
      });
    }
  }

  const lastTabs: PersistedTab[] = [];
  /** Modos de permisos que puede tener guardados un chat de cada asistente. */
  const CHAT_MODES: Record<AgentProvider, string[]> = {
    claude: ["default", "acceptEdits", "plan", "bypassPermissions", "auto", "dontAsk"],
    codex: ["read-only", "auto", "plan", "full"],
    trex: ["plan", "ask", "auto", "full"],
    antigravity: ["default", "ask", "accept-edits", "auto", "full"],
  };
  const chatMode = (kind: TabKind, value: unknown): string | null =>
    kind === "antigravity" ? typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value) && !/plan|architect|read.?only/i.test(value) ? value : null
      : kind !== "shell" && typeof value === "string" && CHAT_MODES[kind].includes(value) ? value : null;
  if (Array.isArray(uiRaw.lastTabs)) {
    for (const entry of uiRaw.lastTabs) {
      const rec = asRecord(entry);
      if (!rec) continue;
      const projectId = asString(rec.projectId, "");
      if (!projectId) continue;
      const kind: TabKind = rec.kind === "shell" || rec.kind === "codex" || rec.kind === "trex" || rec.kind === "antigravity" ? rec.kind : "claude";
      const subtitle = asString(rec.subtitle, "").trim() || kind;
      const launch = normalizeLaunch(rec.launch, kind);
      if (rec.launch != null && !launch) continue;
      lastTabs.push({ id: typeof rec.id === "string" && /^t-[a-z0-9-]+$/i.test(rec.id) ? rec.id : undefined, projectId, kind, subtitle, launch, conversationId: (kind === "antigravity" ? validAcpId(rec.conversationId) : validConversationId(rec.conversationId)) ? rec.conversationId as string : null,
        chatMode: chatMode(kind, rec.chatMode), chatModel: kind === "shell" ? null : normalizeModelChoice(rec.chatModel),
        chatEffort: kind === "shell" ? null : normalizeEffortChoice(rec.chatEffort),
        handoff: kind === "shell" ? null : normalizeHandoffReference(rec.handoff),
        workflow: kind === "shell" ? null : normalizeAgentWorkflow(rec.workflow),
        agentRoom: kind === "shell" ? null : normalizeAgentRoom(rec.agentRoom),
        agentTeam: kind === "shell" ? null : normalizeAgentTeam(rec.agentTeam) });
    }
  }

  const splitLayouts: Record<string,SplitLayout> = {};
  for (const [projectId,value] of Object.entries(asRecord(uiRaw.splitLayouts) ?? {})) {
    const layout = normalizeSplitLayout(value);
    if (layout) splitLayouts[projectId] = layout;
  }
  const ui: UiStateExtended = {
    projectFilter: normalizeProjectFilter(uiRaw.projectFilter, projects),
    lastProjectId: asNullableString(uiRaw.lastProjectId),
    activeProjectId: asNullableString(uiRaw.activeProjectId),
    // Lectura defensiva: cualquier valor que no sea booleano deja la barra expandida.
    sidebarCollapsed: asBool(uiRaw.sidebarCollapsed, false),
    notificationSound: asBool(uiRaw.notificationSound, true),
    autoHideTopBar: asBool(uiRaw.autoHideTopBar, true),
    sidebarWidth: clamp(
      Math.round(asNumber(uiRaw.sidebarWidth, DEFAULT_UI.sidebarWidth)),
      180,
      520,
    ),
    lastTabs,
    splitLayouts,
  };
  const chatModes = asRecord(uiRaw.chatModes);
  for (const provider of ["claude", "codex", "trex", "antigravity"] as const) {
    const mode = chatMode(provider, chatModes?.[provider]);
    if (mode) ui.chatModes = { ...ui.chatModes, [provider]: mode };
  }

  return {
    version: Math.round(asNumber(root.version, DEFAULT_CONFIG.version)),
    projects,
    settings,
    ui,
  };
};

export const trexBrowserStatus = (): Promise<BrowserStatus> => invoke("trex_browser_status");
export const trexDesktopMcpConfig = (mode: BrowserMode): Promise<BrowserConfig> => invoke("trex_desktop_mcp_config", { mode });
export const trexBrowserMcpConfig = (cwd: string, mode: BrowserMode, clientId: string, profile?: string): Promise<BrowserConfig> => invoke("trex_browser_mcp_config", { cwd, mode, clientId, profile });
export const trexBrowserCall = (request: BrowserCall): Promise<BrowserResult> => invoke("trex_browser_call", { request });
export const trexBrowserOpenArtifact = (id: string, cwd: string, mode: BrowserMode, clientId: string, profile?: string): Promise<BrowserResult> => invoke("trex_browser_open_artifact", { id, cwd, mode, clientId, profile });
export const trexBrowserProfiles = (cwd: string): Promise<{ profiles: BrowserProfile[] }> => invoke("trex_browser_profiles", { cwd });
export const trexBrowserSpaces = (cwd: string, members: {clientId:string;label:string}[]): Promise<{spaces: import("./browser").BrowserSpace[]}> => invoke("trex_browser_spaces", {cwd,members});
export const trexBrowserListSpaces = (cwd: string): Promise<{spaces: BrowserSpace[]}> => invoke("trex_browser_list_spaces", {cwd});
/** Resolve a host-owned identity before creating any model grant; never take over another profile. */
export async function trexBrowserResolveSpace(cwd: string, options: BrowserOptions, knownStatus?: BrowserStatus): Promise<BrowserOptions> {
  const base = {enabled: options.enabled, clientId: options.clientId, profile: options.profile};
  if (!options.enabled || !options.automatic) return base;
  const status = knownStatus ?? await trexBrowserStatus();
  if (!status.installed || !status.ready || !status.compatible) return {...base,enabled:false};
  if (!status.capabilities?.spaces) throw new Error("Actualiza Trex Browser para habilitar un espacio independiente por agente.");
  const result = await trexBrowserSpaces(cwd,[{clientId:options.clientId,label:browserSpaceLabel(options.label ?? "Agente")}]);
  const space = result?.spaces?.[0];
  if (result?.spaces?.length !== 1 || space?.clientId !== options.clientId || !validBrowserProfile(space.profile) || space.profile === "BROWSER1")
    throw new Error("No se pudo confirmar el espacio independiente de este agente. No se usará un perfil compartido.");
  return {...base,profile:space.profile};
}
export const trexBrowserCreateProfile = (cwd: string, profile: string): Promise<{ profiles: BrowserProfile[] }> => invoke("trex_browser_create_profile", { cwd, profile });

export const agentTeamOpen = (team: import("./agentTeam").AgentTeam, cwd: string, resume = false): Promise<import("./agentTeam").TeamSnapshot> => invoke("agent_team_open", {
  id: team.id, epoch: team.epoch, cwd, resume, members: team.workers.map(member => ({ id: member.id, name: member.name, role: member.role, canWrite: member.canWrite })),
});
export const agentTeamPoll = (binding: import("./agentTeam").TeamBinding): Promise<import("./agentTeam").TeamSnapshot> => invoke("agent_team_poll", binding);
export const agentTeamSnapshot = (id: string): Promise<import("./agentTeam").TeamSnapshot> => invoke("agent_team_snapshot", { id });
export const agentTeamClaim = (binding: import("./agentTeam").TeamBinding, taskId?:string): Promise<import("./agentTeam").TeamSnapshot> => invoke("agent_team_claim", {...binding,taskId});
export const agentTeamPause = (binding: import("./agentTeam").TeamBinding): Promise<import("./agentTeam").TeamSnapshot> => invoke("agent_team_pause", binding);
export const agentTeamFinish = (binding: import("./agentTeam").TeamBinding, taskId: string, status: string, report: string | null): Promise<import("./agentTeam").TeamSnapshot> => invoke("agent_team_finish", { ...binding, taskId, status, report });
export const agentTeamMcpConfig = (binding: import("./agentTeam").TeamBinding): Promise<{ command: string; args: string[]; callArgs: string[] }> => invoke("agent_team_mcp_config", binding);
export const readQueuedMessages = (queueId: string): Promise<import("./messageQueue").QueueSnapshot> => invoke("message_queue_list", { queueId });
