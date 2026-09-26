/**
 * Tipos del contrato entre el frontend (React) y el backend (Rust/Tauri).
 * Los nombres de campo viajan tal cual en camelCase a través de `invoke`.
 */

/** Forma en la que el backend lanza el comando de Claude dentro del PTY. */
export type LaunchMode = "arg" | "inject";

/** Tipo de pestaña de terminal: con Claude o shell limpio. */
export type TabKind = "claude" | "shell";

export type Project = {
  id: string;
  name: string;
  path: string;
  color?: string | null;
  createdAt: number;
  lastOpenedAt?: number | null;
  defaultCommand?: string | null;
  defaultArgs?: string | null;
};

export type Settings = {
  shell: string;
  claudeCommand: string;
  claudeArgs: string;
  autoRunClaude: boolean;
  fontSize: number;
  fontFamily: string;
  scrollback: number;
  cursorBlink: boolean;
  copyOnSelect: boolean;
  confirmCloseTab: boolean;
  restoreOnStart: boolean;
  launchMode: string;
  /** Color de acento en hex (por ejemplo "#e8834a"). */
  theme: string;
  /** Apariencia de la interfaz: "dark" | "light" | "system". */
  appearance: string;
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
  lastTabs?: PersistedTab[];
  /** La barra lateral está oculta (Ctrl+B) y el área principal ocupa todo. */
  sidebarCollapsed: boolean;
};

export type PersistedTab = {
  projectId: string;
  kind: TabKind;
  subtitle: string;
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
};

/** Pestaña viva en la interfaz (estado de React, no persistido tal cual). */
export type TabState = {
  /** Id único de la sesión PTY (también identifica la pestaña). */
  id: string;
  projectId: string;
  kind: TabKind;
  /** Subtítulo editable que se muestra junto al nombre del proyecto. */
  subtitle: string;
  command: string | null;
  args: string | null;
  /** Proceso ya terminado (se muestra un badge y no se cierra sola). */
  exited: boolean;
  exitCode: number | null;
  /** Último título recibido por OSC (solo informativo). */
  oscTitle: string | null;
  createdAt: number;
};

/** Payload del evento `pty-data-<id>` (datos en base64). */
export type PtyDataPayload = { data: string };

/** Payload del evento `pty-exit-<id>`. */
export type PtyExitPayload = { code: number | null };
