import { useEffect, useRef } from "react";
import {
  DEFAULT_SHORTCUTS,
  matchesShortcut,
  SHORTCUT_ACTIONS,
  type ShortcutAction,
  type ShortcutBindings,
} from "../shortcuts";
export type ShortcutHandlers = Record<
  Exclude<ShortcutAction, "terminalSearch" | "copySelection">,
  () => void
> & { selectTab: (index: number) => void };
export type ShortcutOptions = {
  enabled: boolean;
  settingsOpen: boolean;
  modalOpen?: boolean;
  bindings?: ShortcutBindings;
};
const editable = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement &&
  !target.closest(".xterm") &&
  (target.isContentEditable ||
    ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
export function useShortcuts(
  handlers: ShortcutHandlers,
  options: ShortcutOptions,
): void {
  const current = useRef({ handlers, options });
  current.current = { handlers, options };
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const { handlers: h, options: o } = current.current;
      if (
        !o.enabled ||
        event.isComposing ||
        event.getModifierState("AltGraph") ||
        (event.target instanceof HTMLElement &&
          event.target.closest("[data-shortcut-recorder]"))
      )
        return;
      const bindings = o.bindings ?? DEFAULT_SHORTCUTS;
      const action = SHORTCUT_ACTIONS.find((item) =>
        matchesShortcut(event, bindings[item.id]),
      )?.id;
      const indexed =
        (event.ctrlKey || event.metaKey) &&
        !event.altKey &&
        !event.shiftKey &&
        /^[1-9]$/.test(event.key);
      if (!action && !indexed) return;
      if (
        document.querySelector(
          '[role="alertdialog"], .dialog-overlay.leaving',
        ) ||
        o.modalOpen ||
        (o.settingsOpen && action !== "toggleSettings")
      ) {
        if (!editable(event.target)) {
          event.preventDefault();
          event.stopPropagation();
        }
        return;
      }
      if (!action && indexed) {
        if (!editable(event.target)) {
          event.preventDefault();
          event.stopPropagation();
          h.selectTab(Number(event.key) - 1);
        }
        return;
      }
      if (action === "terminalSearch" || action === "copySelection") return;
      if (
        !action ||
        (editable(event.target) &&
          ![
            "commandPalette",
            "focusSearch",
            "toggleSidebar",
            "toggleTopBar",
            "toggleSettings",
          ].includes(action))
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) h[action]();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);
}
