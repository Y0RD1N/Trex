import type { TabKind } from "./types";

export const DEFAULT_PASTE_SHORTCUT = "Ctrl+V";
export type ClipboardContent = { kind: "text"; text: string } | { kind: "image" };
type KeyEvent = Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey" | "isComposing">;
const MODIFIERS = ["Ctrl", "Alt", "Shift", "Meta"] as const;
const SPECIAL_KEYS = ["Insert", "Delete", "Home", "End", "PageUp", "PageDown", "Space"];

function parseShortcut(value: string): string | null {
  const parts = value.split("+").map(part => part.trim());
  const rawKey = parts.pop() ?? "";
  const key = /^[a-z0-9]$/i.test(rawKey) ? rawKey.toUpperCase()
    : [...SPECIAL_KEYS, ...Array.from({ length: 12 }, (_, i) => `F${i + 1}`)].find(item => item.toLowerCase() === rawKey.toLowerCase());
  if (!key || !parts.length) return null;
  const modifiers = parts.map(part => MODIFIERS.find(modifier => modifier.toLowerCase() === part.toLowerCase()));
  if (modifiers.some(part => !part) || new Set(modifiers).size !== modifiers.length) return null;
  if (!modifiers.some(part => part === "Ctrl" || part === "Alt" || part === "Meta") && !(modifiers.includes("Shift") && key === "Insert")) return null;
  return [...MODIFIERS.filter(modifier => modifiers.includes(modifier)), key].join("+");
}

/** Evita que el pegado sustituya atajos globales de trex o de la terminal. */
export function pasteShortcutError(value: string): string | null {
  const shortcut = parseShortcut(value);
  if (!shortcut) return "Usa una combinación con Ctrl, Alt o Meta, o Mayús+Insert.";
  const parts = shortcut.split("+");
  const key = parts.pop();
  if (parts.includes("Ctrl") || parts.includes("Meta")) {
    if (["B", "K", "T", "W", "C", "D"].includes(key!)) return "Ese atajo ya se usa para otra acción.";
    if (parts.includes("Shift") && ["E", "L"].includes(key!)) return "Ese atajo ya se usa para otra acción.";
    if (!parts.includes("Shift") && /^[0-9]$/.test(key!)) return "Ese atajo ya se usa para otra acción.";
    if (!parts.includes("Shift") && key === "F") return "Ese atajo abre la búsqueda del terminal.";
  }
  // Alt+F4 cierra la ventana antes de que la app pueda manejarlo.
  if (shortcut === "Alt+F4") return "Ese atajo cierra la ventana.";
  return null;
}

export function normalizePasteShortcut(value: unknown): string {
  return typeof value === "string" && !pasteShortcutError(value) ? parseShortcut(value)! : DEFAULT_PASTE_SHORTCUT;
}

export function shortcutFromEvent(event: KeyEvent): string | null {
  if (event.isComposing) return null;
  const key = /^Key[A-Z]$/.test(event.code) ? event.code.slice(3)
    : /^Digit[0-9]$/.test(event.code) ? event.code.slice(5)
    : event.key === " " ? "Space" : event.key;
  const modifiers = MODIFIERS.filter(modifier => ({ Ctrl: event.ctrlKey, Alt: event.altKey, Shift: event.shiftKey, Meta: event.metaKey })[modifier]);
  return parseShortcut([...modifiers, key].join("+"));
}

export function matchesPasteShortcut(event: KeyEvent, shortcut: string): boolean {
  return shortcutFromEvent(event) === normalizePasteShortcut(shortcut);
}

export type PasteAction = { kind: "text"; text: string } | { kind: "key"; data: string } | { kind: "unsupported" };

/** Las imágenes las adjunta el CLI desde el portapapeles nativo, sin convertirlas en texto. */
export function clipboardPasteAction(content: ClipboardContent, kind: TabKind, windows: boolean): PasteAction {
  if (content.kind === "text") return content;
  if (kind === "shell") return { kind: "unsupported" };
  return { kind: "key", data: kind === "claude" && windows ? "\x1bv" : "\x16" };
}
