import { parseShortcut, shortcutFromEvent } from "./paste";

export const SHORTCUT_ACTIONS = [
  { id: "commandPalette", label: "Paleta de comandos", key: "Ctrl+K" },
  { id: "focusSearch", label: "Buscar proyectos", key: "Ctrl+Shift+K" },
  {
    id: "openProject",
    label: "Abrir un proyecto con un agente",
    key: "Ctrl+Space",
  },
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
/** Alternativas para una acción nueva cuyo atajo de fábrica ya usa la persona en otra. */
const FALLBACK_KEYS: Partial<Record<ShortcutAction, string[]>> = {
  openProject: ["Ctrl+Shift+Space", "Ctrl+Alt+Space", "Ctrl+Alt+P"],
};
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
  const saved = (id: string): string | null =>
    typeof record[id] === "string" ? parseShortcut(record[id] as string) : null;
  // Una acción nueva no puede quitarle su combinación a un atajo que la persona
  // ya eligió: si choca, toma la primera alternativa libre en vez de que el
  // conflicto devuelva todos los atajos a sus valores de fábrica.
  const taken = new Set(
    SHORTCUT_ACTIONS.map((action) => saved(action.id)?.replace(/^Meta\+/, "Ctrl+"))
      .filter(Boolean),
  );
  taken.add(paste.replace(/^Meta\+/, "Ctrl+"));
  const fallback = (action: (typeof SHORTCUT_ACTIONS)[number]): string =>
    !taken.has(action.key) ? action.key
      : (FALLBACK_KEYS[action.id] ?? []).find((key) => !taken.has(key)) ?? action.key;
  const result = {} as ShortcutBindings;
  for (const action of SHORTCUT_ACTIONS) {
    const key = saved(action.id) ?? fallback(action);
    result[action.id] = key;
    taken.add(key.replace(/^Meta\+/, "Ctrl+"));
  }
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
