/**
 * Tipos del contrato entre el frontend (React) y el backend (Rust/Tauri).
 * Los nombres de campo viajan tal cual en camelCase a través de `invoke`.
 */
import type { ColorScheme, MotionPreference } from "./visualDesign";
import type { ShortcutBindings } from "./shortcuts";
import type { SplitLayout } from "./splitLayout";
import type { HandoffReference } from "./handoff";
import type { AgentWorkflow } from "./agentWorkflow";
import type { AgentRoom } from "./agentRoom";
import type { AgentTeam } from "./agentTeam";
import type { ProjectFilter } from "./projectFilter";

/** Forma en la que el backend lanza un asistente dentro del PTY. */
export type LaunchMode = "arg" | "inject";

/** Asistente de la sesión o shell limpio. */
export type AgentProvider = "claude" | "codex" | "trex";
export type TabKind = AgentProvider | "shell";
export type CursorStyle = "auto" | "block" | "bar" | "underline";
export type AgentActivity = "idle" | "working" | "waiting";
export type AgentNoticeKind = "ready" | "attention" | "error";
export type AgentNotice = {
  id: number;
  tabId: string;
  projectId: string;
  sessionName: string;
  projectName: string;
  provider: AgentProvider;
  kind: AgentNoticeKind;
  createdAt: number;
  read: boolean;
};

export type LauncherProfile = {
  id: string;
  name: string;
  provider: AgentProvider;
  command: string;
  args: string;
  /** Vacío: hereda el shell de la app para las sesiones nuevas. */
  shell: string;
  launchMode: LaunchMode;
  /** Opcional: CLAUDE_CONFIG_DIR o CODEX_HOME, según el proveedor. */
  configDir: string;
};

/** Copia de los ajustes con los que nació una sesión: no cambia al editar un perfil. */
export type SessionLaunch = {
  profileId: string | null;
  profileName: string | null;
  command: string | null;
  args: string | null;
  shell: string;
  launchMode: LaunchMode;
  env: Record<string, string> | null;
};

export type Project = {
  id: string;
  name: string;
  path: string;
  color?: string | null;
  favorite?: boolean;
  createdAt: number;
  lastOpenedAt?: number | null;
  defaultCommand?: string | null;
  defaultArgs?: string | null;
};

export type Settings = {
  desktopEnabled: boolean;
  browserEnabled: boolean;
  browserProfile: string;
  profiles: LauncherProfile[];
  defaultProfileId: string;
  shell: string;
  claudeCommand: string;
  claudeArgs: string;
  autoRunClaude: boolean;
  fontSize: number;
  fontFamily: string;
  scrollback: number;
  cursorBlink: boolean;
  cursorStyle: CursorStyle;
  cursorWidth: number;
  copyOnSelect: boolean;
  /** Atajo común para pegar texto e imágenes en las terminales. */
  pasteShortcut: string;
  shortcuts: ShortcutBindings;
  imagePastePreview: boolean;
  desktopNotifications: boolean;
  notifyWhenFocused: boolean;
  confirmCloseTab: boolean;
  restoreOnStart: boolean;
  launchMode: string;
  /** Color de acento en hex (por ejemplo "#e8834a"). */
  theme: string;
  /** Apariencia de la interfaz: "dark" | "light" | "system". */
  appearance: string;
  colorScheme: ColorScheme;
  terminalRadius: number;
  terminalMargin: number;
  terminalBorder: boolean;
  motion: MotionPreference;
};

export type UiState = {
  lastProjectId: string | null;
  sidebarWidth: number;
  activeProjectId: string | null;
};

/**
 * Campos extra que guardamos dentro de `ui`: las pestañas abiertas la última
 * vez y si la barra lateral estaba colapsada. El backend preserva el JSON
 * completo, así que no se pierde nada al guardar.
 */
export type UiStateExtended = UiState & {
  projectFilter: ProjectFilter;
  lastTabs?: PersistedTab[];
  /** La barra lateral está oculta (Ctrl+B) y el área principal ocupa todo. */
  sidebarCollapsed: boolean;
  /** Sonido de los avisos de agentes; el historial de avisos es transitorio. */
  notificationSound: boolean;
  /** La barra superior se esconde sola y reaparece al acercar el cursor al borde. */
  autoHideTopBar: boolean;
  splitLayouts: Record<string,SplitLayout>;
  /** Último modo de permisos elegido en un chat de cada asistente: lo heredan los chats nuevos. */
  chatModes?: Partial<Record<AgentProvider, string>>;
};

export type PersistedTab = {
  id?: string;
  projectId: string;
  kind: TabKind;
  subtitle: string;
  launch?: SessionLaunch;
  conversationId?: string | null;
  /** Modo de permisos elegido en el chat de la pestaña. */
  chatMode?: string | null;
  chatModel?: string | null;
  chatEffort?: string | null;
  handoff?: HandoffReference | null;
  workflow?: AgentWorkflow | null;
  agentRoom?: AgentRoom | null;
  agentTeam?: AgentTeam | null;
};

export type AppConfig = {
  version: number;
  projects: Project[];
  settings: Settings;
  ui: UiStateExtended;
};

export type ClaudeCandidate = {
  path: string;
  exists: boolean;
};

export type ClaudeInfo = {
  found: boolean;
  path: string | null;
  version: string | null;
  source: string | null;
  hint: string | null;
  candidates: ClaudeCandidate[];
};

export type ShellOption = {
  id: string;
  label: string;
  available: boolean;
  program: string;
};

export type AppInfo = {
  platform: string;
  homeDir: string;
  configPath: string;
  defaultShellName: string;
  shellOptions: ShellOption[];
  version: string;
};

export type SessionInfo = {
  id: string;
  cwd: string;
  program: string;
  argsPreview: string;
  alive: boolean;
  cols: number;
  rows: number;
  createdAt: number;
};

export type SpawnResponse = {
  id: string;
  program: string;
  argsPreview: string;
  cwd: string;
  shellName: string;
};

/** Petición que espera el comando `pty_spawn`. */
export type SpawnRequest = {
  id: string;
  cwd: string;
  command: string | null;
  args: string | null;
  shell: string;
  env: Record<string, string> | null;
  cols: number;
  rows: number;
  launchMode: string;
  flowControl?: boolean;
};

/** Pestaña viva en la interfaz (estado de React, no persistido tal cual). */
export type TabState = SessionLaunch & {
  agentTeam?: AgentTeam | null;
  workflow?: AgentWorkflow | null;
  agentRoom?: AgentRoom | null;
  /** Continuidad local: nunca reutiliza el id de conversación de otra cuenta. */
  handoff?: HandoffReference | null;
  /** Solo runtime: cualquier envío recuperado requiere revisión, incluso sin id de conversación. */
  handoffRestored?: boolean;
  conversationId: string | null;
  /** Modo de permisos elegido en el chat (se guarda con la pestaña). */
  chatMode: string | null;
  /** Modelo elegido para esta pestaña, incluido el primer turno de una continuación. */
  chatModel?: string | null;
  chatEffort?: string | null;
  /** Id único de la sesión PTY (también identifica la pestaña). */
  id: string;
  projectId: string;
  kind: TabKind;
  /** Subtítulo editable que se muestra junto al nombre del proyecto. */
  subtitle: string;
  /** Proceso ya terminado (se muestra un badge y no se cierra sola). */
  exited: boolean;
  exitCode: number | null;
  /** Último título recibido por OSC (solo informativo). */
  oscTitle: string | null;
  /** Actividad transitoria del asistente; nunca se guarda en la configuración. */
  activity: AgentActivity;
  createdAt: number;
};

/** Payload del evento `pty-data-<id>` (datos en base64). */
export type PtyDataPayload = { data: string };

/** Payload del evento `pty-exit-<id>`. */
export type PtyExitPayload = { code: number | null };

export type Conversation = { id: string; provider: AgentProvider; title: string; cwd: string; updatedAt: number };
