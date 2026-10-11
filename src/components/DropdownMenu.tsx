import { useEffect, useLayoutEffect, useRef, type CSSProperties, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useFloatingPosition, type FloatingAnchor } from "../hooks/useFloatingPosition";
import { usePresence } from "../hooks/usePresence";

type Props = {
  anchor: FloatingAnchor | null;
  triggerRef: RefObject<HTMLButtonElement | null>;
  label: string;
  className?: string;
  id?: string;
  style?: CSSProperties;
  focusSelected?: boolean;
  /** Borde del botón con el que se alinea el menú (por defecto, el final). */
  align?: "start" | "end";
  onClose: () => void;
  children: ReactNode;
};

const MENU_OPEN_EVENT = "trex:menu-open";

/** Una sola política de posición, cierre y teclado para todos los menús. */
export default function DropdownMenu({ anchor, triggerRef, label, className = "", id, style, focusSelected = false, align = "end", onClose, children }: Props) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const searchRef = useRef({ text: "", time: 0 });
  const focusedRef = useRef(false);
  const presence = usePresence(anchor);
  const retainedAnchor = presence.value;
  const position = useFloatingPosition(retainedAnchor, surfaceRef, {
    align: retainedAnchor && "element" in retainedAnchor ? align : "start",
    gap: retainedAnchor && "element" in retainedAnchor ? 6 : 0,
    // Al cerrar, el botón puede cambiar de ancho (nuevo valor): el menú se queda quieto mientras se desvanece.
    frozen: presence.leaving,
  });

  useLayoutEffect(() => {
    if (!anchor) {
      focusedRef.current = false;
      searchRef.current = { text: "", time: 0 };
      return;
    }
    if (!position || focusedRef.current) return;
    const surface = surfaceRef.current;
    const selected = focusSelected ? surface?.querySelector<HTMLElement>('[role^="menuitem"][aria-checked="true"]:not(:disabled)') : null;
    const first = surface?.querySelector<HTMLElement>('[role^="menuitem"]:not(:disabled)');
    (selected ?? first)?.focus({ preventScroll: true });
    selected?.scrollIntoView({ block: "nearest" });
    focusedRef.current = true;
  }, [anchor, position, focusSelected]);

  useEffect(() => {
    if (!anchor) return;
    const close = (restoreFocus = false): void => {
      if (restoreFocus) triggerRef.current?.focus({ preventScroll: true });
      closeRef.current();
    };
    const onPointer = (event: PointerEvent): void => {
      const target = event.target as Node;
      if (!surfaceRef.current?.contains(target) && !triggerRef.current?.contains(target)) close();
    };
    const onFocus = (event: FocusEvent): void => {
      const target = event.target as Node;
      if (!surfaceRef.current?.contains(target) && !triggerRef.current?.contains(target)) close();
    };
    const onKey = (event: globalThis.KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close(true);
      } else if (event.key === "Tab") {
        // Deja que Tab continúe desde el botón, en el orden normal de la app.
        close(true);
      } else if ((event.ctrlKey || event.metaKey || event.altKey) && !["Control", "Meta", "Alt", "Shift"].includes(event.key)) {
        close();
      }
    };
    const onScroll = (event: Event): void => {
      if (event.target instanceof Node && event.target.contains(triggerRef.current)) close();
    };
    const onResize = (): void => close();
    const onOtherMenu = (event: Event): void => {
      if ((event as CustomEvent).detail !== surfaceRef.current) close();
    };
    window.addEventListener("pointerdown", onPointer, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    window.addEventListener("blur", onResize);
    document.addEventListener("focusin", onFocus);
    window.addEventListener(MENU_OPEN_EVENT, onOtherMenu);
    window.addEventListener("trex:dialog-open", onResize);
    window.dispatchEvent(new CustomEvent(MENU_OPEN_EVENT, { detail: surfaceRef.current }));
    return () => {
      window.removeEventListener("pointerdown", onPointer, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("blur", onResize);
      document.removeEventListener("focusin", onFocus);
      window.removeEventListener(MENU_OPEN_EVENT, onOtherMenu);
      window.removeEventListener("trex:dialog-open", onResize);
    };
  }, [anchor !== null, triggerRef]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const items = Array.from(surfaceRef.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]:not(:disabled)') ?? []);
    if (!items.length) return;
    const current = items.indexOf(document.activeElement as HTMLElement);
    let next: HTMLElement | undefined;
    if (event.key === "ArrowDown") next = items[(current + 1) % items.length];
    else if (event.key === "ArrowUp") next = items[(current - 1 + items.length) % items.length];
    else if (event.key === "Home") next = items[0];
    else if (event.key === "End") next = items[items.length - 1];
    else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey && event.key !== " ") {
      const time = Date.now();
      const previous = time - searchRef.current.time < 500 ? searchRef.current.text : "";
      const text = previous + event.key.toLocaleLowerCase();
      searchRef.current = { text, time };
      const ordered = [...items.slice(current + 1), ...items.slice(0, current + 1)];
      next = ordered.find(item => item.textContent?.trim().toLocaleLowerCase().replace(/^[^\p{L}]+/u, "").startsWith(text));
    }
    if (next) {
      event.preventDefault();
      event.stopPropagation();
      next.focus({ preventScroll: true });
      next.scrollIntoView({ block: "nearest" });
    }
  };

  if (!retainedAnchor) return null;
  return createPortal(
    <div
      ref={surfaceRef}
      id={id}
      role={presence.leaving ? undefined : "menu"}
      aria-hidden={presence.leaving || undefined}
      inert={presence.leaving}
      aria-label={label}
      className={`context-menu floating-surface motion-popover ${className}${presence.entering ? " entering" : ""}${presence.leaving ? " leaving" : ""}`}
      style={{ ...style, left: position?.left ?? 8, top: position?.top ?? 8,
        visibility: position ? "visible" : "hidden", transformOrigin: position?.origin,
        "--menu-shift": position?.side === "top" ? "4px" : "-4px" } as CSSProperties}
      onKeyDown={onKeyDown}
      onClick={event => event.stopPropagation()}
      onContextMenu={event => { event.preventDefault(); event.stopPropagation(); }}
    >
      {children}
    </div>,
    document.body,
  );
}
