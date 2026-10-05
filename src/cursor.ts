import type { IDisposable, ITerminalOptions, Terminal } from "@xterm/xterm";
import type { CursorStyle } from "./types";

export const DEFAULT_CURSOR_STYLE: CursorStyle = "auto";
export const DEFAULT_CURSOR_WIDTH = 1;
export const MIN_CURSOR_WIDTH = 1;
export const MAX_CURSOR_WIDTH = 6;

export type CursorAppearance = { cursorStyle: CursorStyle; cursorWidth: number; cursorBlink: boolean };
export const CURSOR_PRESETS: ReadonlyArray<{ name: string; description: string; cursorStyle: CursorStyle; cursorWidth: number }> = [
  { name: "Automático", description: "Según la aplicación", cursorStyle: "auto", cursorWidth: 1 },
  { name: "Fino", description: "Barra de 1 px", cursorStyle: "bar", cursorWidth: 1 },
  { name: "Medio", description: "Barra de 2 px", cursorStyle: "bar", cursorWidth: 2 },
  { name: "Grueso", description: "Barra de 4 px", cursorStyle: "bar", cursorWidth: 4 },
  { name: "Bloque", description: "Un carácter completo", cursorStyle: "block", cursorWidth: 1 },
  { name: "Subrayado", description: "Una línea inferior", cursorStyle: "underline", cursorWidth: 1 },
];

export function normalizeCursorStyle(value: unknown): CursorStyle {
  return value === "block" || value === "bar" || value === "underline" ? value : DEFAULT_CURSOR_STYLE;
}

export function normalizeCursorWidth(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(MIN_CURSOR_WIDTH, Math.min(MAX_CURSOR_WIDTH, Math.round(value)))
    : DEFAULT_CURSOR_WIDTH;
}

export function cursorOptions(settings: CursorAppearance): Pick<ITerminalOptions, "cursorStyle" | "cursorWidth" | "cursorBlink"> {
  return {
    cursorStyle: settings.cursorStyle === "auto" ? "block" : settings.cursorStyle,
    cursorWidth: normalizeCursorWidth(settings.cursorWidth),
    cursorBlink: settings.cursorBlink,
  };
}

/** La política usa el parser público: conserva el movimiento y la visibilidad del cursor. */
export function installCursorPolicy(term: Terminal, getSettings: () => CursorAppearance): IDisposable {
  const styleHandler = term.parser.registerCsiHandler({ intermediates: " ", final: "q" }, params => {
    // El reset a las opciones también se usa al cambiar el estilo desde Ajustes.
    return getSettings().cursorStyle !== "auto" && params[0] !== 0;
  });
  const parsed = term.onWriteParsed(() => {
    const settings = getSettings();
    // DECSET/DECRST 12 pueden cambiar solo el parpadeo y venir junto a otros modos.
    // Restaurarlo después del parseo evita descartar esos otros modos.
    if (settings.cursorStyle !== "auto" && term.options.cursorBlink !== settings.cursorBlink) {
      term.options.cursorBlink = settings.cursorBlink;
    }
  });
  return { dispose: () => { styleHandler.dispose(); parsed.dispose(); } };
}

export function applyCursorOptions(term: Terminal, settings: CursorAppearance): void {
  const options = cursorOptions(settings);
  term.options.cursorStyle = options.cursorStyle;
  term.options.cursorWidth = options.cursorWidth;
  term.options.cursorBlink = options.cursorBlink;
  // xterm 6 conserva por separado el estilo que pidió la aplicación. Limpiarlo
  // permite que el nuevo estilo se vea también en sesiones que ya estaban abiertas.
  if (settings.cursorStyle !== "auto") term.write("\x1b[0 q");
}
