/**
 * Atajos de teclado globales de la aplicación.
 *
 * Se registran en la fase de captura para interceptar las combinaciones antes
 * de que xterm.js reenvíe la tecla al PTY. Se ignoran cuando el foco está en un
 * campo de formulario (el terminal queda excluido: sus atajos también valen).
 * Ctrl+K (⌘K en macOS) y Ctrl+B (⌘B, con Mayús la barra superior) son las
 * excepciones: el buscador de proyectos y las barras responden desde cualquier sitio.
 */
import { useEffect, useRef } from "react";

export type ShortcutHandlers = {
  newClaudeTab: () => void;
  newShellTab: () => void;
  closeTab: () => void;
  nextTab: () => void;
  prevTab: () => void;
  selectTab: (index: number) => void;
  toggleSettings: () => void;
  toggleTheme: () => void;
  openInExplorer: () => void;
  /** Enfoca el campo de búsqueda de proyectos (Ctrl+K). */
  focusSearch: () => void;
  /** Muestra u oculta la barra lateral (Ctrl+B). */
  toggleSidebar: () => void;
  /** Alterna el ocultado automático de la barra superior (Ctrl+Shift+B). */
  toggleTopBar: () => void;
  increaseFont: () => void;
  decreaseFont: () => void;
  resetFont: () => void;
};

export type ShortcutOptions = {
  /** Desactiva todos los atajos (por ejemplo mientras carga la configuración). */
  enabled: boolean;
  /** Con el panel de ajustes abierto solo funciona Ctrl+, y Ctrl+K. */
  settingsOpen: boolean;
};

/** ¿El foco está en un campo de formulario? (el textarea interno de xterm no cuenta) */
const isEditableTarget = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) return false;
  if (target.closest(".xterm")) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
};

export function useShortcuts(handlers: ShortcutHandlers, options: ShortcutOptions): void {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const { enabled, settingsOpen } = options;

  useEffect(() => {
    if (!enabled) return;

    const onKeyDown = (event: KeyboardEvent): void => {
      const mod = event.ctrlKey || event.metaKey;
      if (!mod) return;
      const key = event.key;
      const h = handlersRef.current;

      // Una confirmación conserva el foco y bloquea los cambios de contexto.
      if (document.querySelector('[role="alertdialog"], .dialog-overlay.leaving')) {
        if ([",", "k", "b", "t", "e", "l", "w", "tab", "=", "+", "-", "_", "0"].includes(key.toLowerCase()) || /^[1-9]$/.test(key)) {
          event.preventDefault();
          event.stopPropagation();
        }
        return;
      }

      // Ctrl+, es global: abre el panel y también lo cierra cuando ya está abierto.
      if (key === ",") {
        event.preventDefault();
        event.stopPropagation();
        h.toggleSettings();
        return;
      }

      // El modal conserva el foco; sus categorías se navegan dentro del panel.
      if (settingsOpen) {
        if (["k", "b"].includes(key.toLowerCase())) event.preventDefault();
        return;
      }

      // Ctrl+K (⌘K): buscador de proyectos, esté donde esté el foco.
      if (key.toLowerCase() === "k") {
        event.preventDefault();
        event.stopPropagation();
        h.focusSearch();
        return;
      }

      // Ctrl+B (⌘B): barra lateral; con Mayús, barra superior. Globales igual que Ctrl+K.
      if (key.toLowerCase() === "b") {
        event.preventDefault();
        event.stopPropagation();
        if (event.shiftKey) h.toggleTopBar();
        else h.toggleSidebar();
        return;
      }

      if (isEditableTarget(event.target)) return;

      const consume = (): void => {
        event.preventDefault();
        event.stopPropagation();
      };

      if (event.shiftKey) {
        const lower = key.toLowerCase();
        if (lower === "t") {
          consume();
          h.newShellTab();
          return;
        }
        if (lower === "e") {
          consume();
          h.openInExplorer();
          return;
        }
        if (lower === "l") {
          consume();
          h.toggleTheme();
          return;
        }
        if (key === "Tab") {
          consume();
          h.prevTab();
          return;
        }
      }

      if (key === "Tab") {
        consume();
        h.nextTab();
        return;
      }
      if (key.toLowerCase() === "t") {
        consume();
        h.newClaudeTab();
        return;
      }
      if (key.toLowerCase() === "w") {
        consume();
        h.closeTab();
        return;
      }
      if (key === "=" || key === "+") {
        consume();
        h.increaseFont();
        return;
      }
      if (key === "-" || key === "_") {
        consume();
        h.decreaseFont();
        return;
      }
      if (key === "0") {
        consume();
        h.resetFont();
        return;
      }
      if (/^[1-9]$/.test(key)) {
        consume();
        h.selectTab(Number(key) - 1);
      }
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [enabled, settingsOpen]);
}
