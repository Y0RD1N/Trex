/**
 * Tema visual de trex: modo claro / oscuro / sistema.
 *
 * Este módulo es el único que escribe los atributos de `document.documentElement`:
 *   - `data-theme`      → modo resuelto ("dark" | "light"); lo leen los tokens CSS.
 *   - `data-appearance` → preferencia del usuario ("dark" | "light" | "system").
 *   - `data-accent`     → hex del acento (informativo, por si ayuda al CSS).
 *
 * También guarda las paletas de xterm.js (que van en JavaScript, no en CSS) y un
 * pequeño bus de eventos para que los terminales ya abiertos se repinten en vivo
 * cuando cambia el modo o el color de acento.
 */
import type { ITheme } from "@xterm/xterm";
import { applyAccent } from "./api";

export type ThemeMode = "dark" | "light";
export type Appearance = "dark" | "light" | "system";

/** Opciones del control segmentado de los ajustes (en este orden). */
export const APPEARANCE_OPTIONS: ReadonlyArray<{ id: Appearance; label: string }> = [
  { id: "system", label: "Sistema" },
  { id: "light", label: "Claro" },
  { id: "dark", label: "Oscuro" },
];

/** Normaliza cualquier valor que llegue de la configuración. */
export const normalizeAppearance = (value: unknown): Appearance =>
  value === "light" || value === "dark" || value === "system" ? value : "dark";

/** ¿El sistema operativo pide modo oscuro? (por defecto sí, como la app). */
const systemPrefersDark = (): boolean => {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return true;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
};

/** Resuelve la preferencia ("system" incluido) al modo real de la interfaz. */
export const resolveThemeMode = (appearance: string): ThemeMode => {
  const clean = normalizeAppearance(appearance);
  if (clean === "system") return systemPrefersDark() ? "dark" : "light";
  return clean;
};

/** Modo que está aplicado ahora mismo en el documento. */
export const getThemeMode = (): ThemeMode =>
  document.documentElement.dataset.theme === "light" ? "light" : "dark";

// --- Bus de cambios ---------------------------------------------------------

type ThemeListener = (mode: ThemeMode) => void;

const listeners = new Set<ThemeListener>();
let currentAppearance: Appearance = "dark";
let currentAccent = "";
let systemBound = false;

/** Se suscribe a los cambios de modo. Devuelve la función para darse de baja. */
export const onThemeChange = (listener: ThemeListener): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** Reacciona a los cambios del tema del sistema cuando appearance === "system". */
const bindSystemListener = (): void => {
  if (systemBound || typeof window === "undefined") return;
  if (typeof window.matchMedia !== "function") return;
  systemBound = true;
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const onChange = (): void => {
    if (currentAppearance === "system") applyTheme("system", currentAccent);
  };
  if (typeof media.addEventListener === "function") media.addEventListener("change", onChange);
  else if (typeof media.addListener === "function") media.addListener(onChange);
};

/** Duración del fundido al cambiar de modo (coincide con el CSS). */
const THEME_TRANSITION_MS = 220;
let themeTransitionTimer: number | null = null;

/**
 * Funde los contenedores principales al alternar claro/oscuro: activa
 * `.theme-transition` en <html> durante un instante y la retira después, para
 * no dejar transiciones globales permanentes (costarían rendimiento).
 */
const beginThemeTransition = (): void => {
  const root = document.documentElement;
  root.classList.add("theme-transition");
  if (themeTransitionTimer !== null) window.clearTimeout(themeTransitionTimer);
  themeTransitionTimer = window.setTimeout(() => {
    themeTransitionTimer = null;
    root.classList.remove("theme-transition");
  }, THEME_TRANSITION_MS);
};

/**
 * Aplica la apariencia (y, si se indica, el acento) al documento.
 * Devuelve el modo resuelto para poder sincronizar el estado de React.
 */
export const applyTheme = (appearance: string, accent?: string): ThemeMode => {
  currentAppearance = normalizeAppearance(appearance);
  if (accent) currentAccent = accent;
  bindSystemListener();

  const mode = resolveThemeMode(currentAppearance);
  const root = document.documentElement;
  const previousMode = root.dataset.theme;
  // `data-theme` va primero: applyAccent genera las variantes según claro/oscuro.
  root.dataset.theme = mode;
  // Solo cuando el modo cambia de verdad (ajustar el acento no dispara fundido).
  if (previousMode && previousMode !== mode) beginThemeTransition();
  root.dataset.appearance = currentAppearance;
  if (currentAccent) {
    root.dataset.accent = currentAccent;
    applyAccent(currentAccent);
  }

  for (const listener of listeners) {
    try {
      listener(mode);
    } catch {
      /* un suscriptor roto no debe impedir el repintado del resto */
    }
  }
  return mode;
};

// --- Paletas del terminal (xterm.js) ----------------------------------------

/** Lee una variable CSS del documento (con valor de reserva). */
const cssVar = (name: string, fallback: string): string => {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
};

/**
 * Paleta oscura: fondo negro intenso (coincide con --term-bg) y colores ANSI
 * con contraste alto.
 */
const DARK_TERMINAL: ITheme = {
  background: "#000000",
  foreground: "#e4e7ec",
  cursor: "#e8834a",
  cursorAccent: "#000000",
  selectionBackground: "rgba(118, 143, 184, 0.32)",
  selectionInactiveBackground: "rgba(118, 143, 184, 0.18)",
  black: "#2b3340",
  red: "#f2687f",
  green: "#7fd962",
  yellow: "#e6b455",
  blue: "#6cb6ff",
  magenta: "#c58af9",
  cyan: "#56d4dd",
  white: "#c8ccd4",
  brightBlack: "#6f7a8c",
  brightRed: "#ff8095",
  brightGreen: "#9ae86e",
  brightYellow: "#f5cd7c",
  brightBlue: "#8ec7ff",
  brightMagenta: "#d8a6ff",
  brightCyan: "#7ee2ea",
  brightWhite: "#f2f4f8",
};

/**
 * Paleta clara: fondo blanco roto y colores ANSI oscurecidos para que sigan
 * siendo legibles sobre blanco (contraste AA).
 */
const LIGHT_TERMINAL: ITheme = {
  background: "#fbfbfd",
  foreground: "#1b1f27",
  cursor: "#b3541f",
  cursorAccent: "#fbfbfd",
  selectionBackground: "rgba(37, 99, 235, 0.16)",
  selectionInactiveBackground: "rgba(37, 99, 235, 0.08)",
  black: "#24292f",
  red: "#cf222e",
  green: "#1a7f37",
  yellow: "#9a6700",
  blue: "#0969da",
  magenta: "#8250df",
  cyan: "#1b7c83",
  white: "#6b7280",
  brightBlack: "#57606a",
  brightRed: "#a40e26",
  brightGreen: "#116329",
  brightYellow: "#7d4e00",
  brightBlue: "#0550ae",
  brightMagenta: "#6639ba",
  brightCyan: "#0f6672",
  brightWhite: "#12161c",
};

/**
 * Tema de xterm para un modo concreto. El color del cursor sigue al acento
 * configurado (oscurecido en modo claro para que se vea sobre blanco).
 */
export const getTerminalTheme = (mode: ThemeMode): ITheme => {
  const base = mode === "light" ? LIGHT_TERMINAL : DARK_TERMINAL;
  const cursor =
    mode === "light"
      ? cssVar("--accent-strong", "#b3541f")
      : cssVar("--accent", "#e8834a");
  return { ...base, cursor };
};

/** Decoraciones de la búsqueda (coherentes con el modo activo). */
export const getSearchDecorations = (mode: ThemeMode) => {
  const accent = mode === "light" ? cssVar("--accent-strong", "#b3541f") : cssVar("--accent", "#e8834a");
  return mode === "light"
    ? {
        matchBackground: "rgba(37, 99, 235, 0.18)",
        matchBorder: "rgba(37, 99, 235, 0.45)",
        matchOverviewRuler: "#0969da",
        activeMatchBackground: accent,
        activeMatchBorder: accent,
        activeMatchColorOverviewRuler: accent,
      }
    : {
        matchBackground: "rgba(118, 143, 184, 0.28)",
        matchBorder: "rgba(118, 143, 184, 0.6)",
        matchOverviewRuler: "#6cb6ff",
        activeMatchBackground: accent,
        activeMatchBorder: accent,
        activeMatchColorOverviewRuler: accent,
      };
};
