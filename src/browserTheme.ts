/**
 * Colores que la app comparte con la ventana de Trex Browser, para que se sientan como un solo producto.
 *
 * La app es la única que calcula la paleta (tono, acento y modo claro/oscuro; ver `theme.ts`): aquí solo
 * se leen los valores ya resueltos de las variables CSS del documento. El navegador no repite ninguna
 * cuenta, de modo que no puede desviarse. Las claves coinciden con `THEME_COLORS` de
 * trex-browser/worker/browser-theme.mjs, de trex-browser/shell/theme.mjs y de trex_browser.rs.
 */
export const BROWSER_THEME_TOKENS = {
  app: "--bg-app", sidebar: "--bg-sidebar", surface: "--bg-surface", elevated: "--bg-elevated", inset: "--bg-inset",
  selected: "--session-selected", border: "--border", borderStrong: "--border-strong",
  text: "--text", muted: "--text-muted", dim: "--text-dim",
  accent: "--accent", accentText: "--accent-strong", accentInk: "--accent-contrast",
} as const;

export type BrowserThemeColor = keyof typeof BROWSER_THEME_TOKENS;
export type BrowserTheme = { mode: "dark" | "light"; colors: Record<BrowserThemeColor, string> };

/** `#rgb`, `#rrggbb` o `rgb(r, g, b)` como `#rrggbb` en minúsculas; null si no es un color opaco de esas formas. */
export const cssColorToHex = (value: string): string | null => {
  const text = value.trim().toLowerCase();
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(text);
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`;
  if (/^#[0-9a-f]{6}$/.test(text)) return text;
  const rgb = /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/.exec(text);
  if (!rgb) return null;
  const channels = rgb.slice(1, 4).map(Number);
  return channels.some(channel => channel > 255) ? null : `#${channels.map(channel => channel.toString(16).padStart(2, "0")).join("")}`;
};

/** El tema listo para enviar, o null si falta alguna variable (la interfaz aún no aplicó su tema). */
export const buildBrowserTheme = (mode: string, read: (token: string) => string): BrowserTheme | null => {
  if (mode !== "dark" && mode !== "light") return null;
  const colors = {} as Record<BrowserThemeColor, string>;
  for (const [name, token] of Object.entries(BROWSER_THEME_TOKENS) as Array<[BrowserThemeColor, string]>) {
    const hex = cssColorToHex(read(token));
    if (!hex) return null;
    colors[name] = hex;
  }
  return { mode, colors };
};
