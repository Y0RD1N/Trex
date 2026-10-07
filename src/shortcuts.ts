import { parseShortcut, shortcutFromEvent } from "./paste";

export const SHORTCUT_ACTIONS = [
  { id: "commandPalette", label: "Paleta de comandos", key: "Ctrl+K" },
  { id: "focusSearch", label: "Buscar proyectos", key: "Ctrl+Shift+K" },
  {
    id: "newClaudeTab",
    label: "Nueva sesión del perfil predeterminado",
    key: "Ctrl+T",
  },
  { id: "newShellTab", label: "Nueva terminal", key: "Ctrl+Shift+T" },
  { id: "closeTab", label: "Cerrar sesión", key: "Ctrl+W" },
  { id: "nextTab", label: "Siguiente sesión", key: "Ctrl+Tab" },
  { id: "prevTab", label: "Sesión anterior", key: "Ctrl+Shift+Tab" },
  {
    id: "toggleSplit",
    label: "Dividir o unir terminales",
    key: "Ctrl+Shift+S",
  },
  { id: "focusOtherPane", label: "Enfocar el otro panel", key: "Ctrl+Alt+O" },
  {
    id: "recoverSessions",
    label: "Recuperar una conversación",
    key: "Ctrl+Shift+R",
  },
  { id: "toggleSettings", label: "Abrir ajustes", key: "Ctrl+," },
  {
    id: "toggleSidebar",
    label: "Mostrar u ocultar barra lateral",
    key: "Ctrl+B",
  },
  {
    id: "toggleTopBar",
    label: "Ocultado automático de la cabecera",
    key: "Ctrl+Shift+B",
  },
  {
    id: "toggleTheme",
    label: "Cambiar tema claro / oscuro",
    key: "Ctrl+Shift+L",
  },
  {
    id: "openInExplorer",
    label: "Abrir carpeta del proyecto",
    key: "Ctrl+Shift+E",
  },
  { id: "increaseFont", label: "Aumentar tamaño de texto", key: "Ctrl+Equal" },
  { id: "decreaseFont", label: "Reducir tamaño de texto", key: "Ctrl+Minus" },
  { id: "resetFont", label: "Restablecer tamaño de texto", key: "Ctrl+0" },
  { id: "terminalSearch", label: "Buscar en el terminal", key: "Ctrl+F" },
  {
    id: "copySelection",
    label: "Copiar selección del terminal",
    key: "Ctrl+Shift+C",
  },
] as const;
export type ShortcutAction = (typeof SHORTCUT_ACTIONS)[number]["id"];
export type ShortcutBindings = Record<ShortcutAction, string>;
export const DEFAULT_SHORTCUTS = Object.fromEntries(
  SHORTCUT_ACTIONS.map((action) => [action.id, action.key]),
) as ShortcutBindings;

export function keyError(value: string, paste = false): string | null {
  const key = parseShortcut(value);
  if (!key) return "Usa una combinación con Ctrl, Alt o Meta.";
  const effectiveKey = key.replace(/^Meta\+/, "Ctrl+");
  if (
    ["Ctrl+C", "Ctrl+D", "Ctrl+Z", "Alt+F4"].includes(effectiveKey) ||
    key === "Meta+Q" ||
    (!paste && effectiveKey === "Ctrl+Shift+V")
  )
    return "Ese atajo se reserva para el sistema o la terminal.";
  if (/^(Ctrl|Meta)\+[1-9]$/.test(key))
    return "Ctrl+1…9 se reserva para seleccionar sesiones.";
  return null;
}
export function bindingError(
  bindings: ShortcutBindings,
  paste: string,
): string | null {
  const used = new Map<string, string>();
  for (const [label, value] of [
    ["Pegar", paste],
    ...SHORTCUT_ACTIONS.map((action) => [action.label, bindings[action.id]]),
  ]) {
    const error = keyError(value, label === "Pegar");
    if (error) return `${label}: ${error}`;
    const key = parseShortcut(value)!.replace(/^Meta\+/, "Ctrl+");
    if (used.has(key))
      return `${label} y ${used.get(key)} usan ${key}. Elige atajos distintos.`;
    used.set(key, label);
  }
  return null;
}
export function normalizeShortcuts(
  raw: unknown,
  paste: string,
): ShortcutBindings {
  const record =
    raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const result = Object.fromEntries(
    SHORTCUT_ACTIONS.map((action) => [
      action.id,
      typeof record[action.id] === "string"
        ? (parseShortcut(record[action.id] as string) ?? action.key)
        : action.key,
    ]),
  ) as ShortcutBindings;
  return bindingError(result, paste) ? { ...DEFAULT_SHORTCUTS } : result;
}
export function matchesShortcut(
  event: Parameters<typeof shortcutFromEvent>[0],
  key: string,
): boolean {
  const candidate = shortcutFromEvent(event);
  return (
    candidate === key ||
    (event.metaKey &&
      !event.ctrlKey &&
      candidate?.replace(/^Meta\+/, "Ctrl+") === key)
  );
}
export function shortcutLabel(key: string): string {
  return key.replace("Equal", "+").replace("Minus", "−").replace("Slash", "/");
}
