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
import { paletteFor, paletteTokens } from "./palettes";
import { normalizeDesign, type ColorScheme } from "./visualDesign";

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
let currentScheme: ColorScheme = "trex";
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
export const applyTheme = (appearance: string, accent?: string, colorScheme?: ColorScheme): ThemeMode => {
  currentAppearance = normalizeAppearance(appearance);
  if (accent) currentAccent = accent;
  if (colorScheme) currentScheme = normalizeDesign({ colorScheme }).colorScheme;
  bindSystemListener();

  const mode = resolveThemeMode(currentAppearance);
  const root = document.documentElement;
  const previousMode = root.dataset.theme;
  const previousScheme = root.dataset.colorScheme;
  // `data-theme` va primero: applyAccent genera las variantes según claro/oscuro.
  root.dataset.theme = mode;
  // Solo cuando el modo cambia de verdad (ajustar el acento no dispara fundido).
  if (previousMode && (previousMode !== mode || previousScheme !== currentScheme)) beginThemeTransition();
  root.dataset.appearance = currentAppearance;
  root.dataset.colorScheme = currentScheme;
  for (const [token, value] of Object.entries(paletteTokens(paletteFor(currentScheme)[mode]))) root.style.setProperty(token, value);
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
 * Tema de xterm para un modo concreto. El color del cursor sigue al acento
 * configurado (oscurecido en modo claro para que se vea sobre blanco).
 */
export const getTerminalTheme = (mode: ThemeMode): ITheme => {
  const palette = paletteFor(currentScheme)[mode].terminal;
  const cursor =
    mode === "light"
      ? cssVar("--accent-strong", "#b3541f")
      : cssVar("--accent", "#e8834a");
  const background = cssVar("--term-bg", palette.background ?? "#202022");
  return { ...palette, background, cursorAccent: background, cursor };
};

/** Decoraciones de la búsqueda (coherentes con el modo activo). */
export const getSearchDecorations = (mode: ThemeMode) => {
  const accent = mode === "light" ? cssVar("--accent-strong", "#b3541f") : cssVar("--accent", "#e8834a");
  const palette = paletteFor(currentScheme)[mode].terminal;
  return {
    matchBackground: palette.selectionBackground!,
    matchBorder: `${palette.blue}73`,
    matchOverviewRuler: palette.blue!,
    activeMatchBackground: accent,
    activeMatchBorder: accent,
    activeMatchColorOverviewRuler: accent,
  };
};
