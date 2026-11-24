/**
 * Colores que la app comparte con el control remoto (la página del móvil y la app de iPhone), para que
 * se vean como la app de escritorio.
 *
 * La app es la única que calcula la paleta (tono, acento y modo claro/oscuro; ver `theme.ts`): aquí solo
 * se leen los valores ya resueltos de las variables CSS del documento, de modo que el móvil no repite
 * ninguna cuenta. Las claves coinciden con las de `applyTheme` en remote/RemoteApp.tsx y con las de
 * ios/Sources/TrexRemote/Theme.swift.
 */
export const REMOTE_THEME_TOKENS = {
  app: "--bg-app", sidebar: "--bg-sidebar", surface: "--bg-surface", elevated: "--bg-elevated", inset: "--bg-inset",
  selected: "--session-selected", border: "--border", borderStrong: "--border-strong",
  text: "--text", muted: "--text-muted", dim: "--text-dim",
  accent: "--accent", accentText: "--accent-strong", accentInk: "--accent-contrast",
} as const;

export type RemoteThemeColor = keyof typeof REMOTE_THEME_TOKENS;
export type RemoteTheme = { mode: "dark" | "light"; colors: Record<RemoteThemeColor, string> };

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
export const buildRemoteTheme = (mode: string, read: (token: string) => string): RemoteTheme | null => {
  if (mode !== "dark" && mode !== "light") return null;
  const colors = {} as Record<RemoteThemeColor, string>;
  for (const [name, token] of Object.entries(REMOTE_THEME_TOKENS) as Array<[RemoteThemeColor, string]>) {
    const hex = cssColorToHex(read(token));
    if (!hex) return null;
    colors[name] = hex;
  }
  return { mode, colors };
};
