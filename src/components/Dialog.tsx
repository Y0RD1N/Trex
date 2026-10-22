/**
 * Confirmación contextual, anclada al control que la abre.
 *
 * Es un componente de presentación: la cola, las promesas y el ciclo de vida
 * viven en `DialogProvider`. Aquí solo se resuelven el foco inicial, el trap de
 * teclado, el cierre con Escape y el pintado de la tarjeta.
 */
import { useEffect, useId, useLayoutEffect, useRef, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { useFloatingPosition, type FloatingAnchor } from "../hooks/useFloatingPosition";
import { usePresence } from "../hooks/usePresence";
import { AlertIcon, InfoIcon } from "./Icons";

export type DialogTone = "default" | "danger";

export type DialogProps = {
  anchor: FloatingAnchor | null;
  returnFocus: HTMLElement | null;
  title: string;
  message?: string;
  detail?: string;
  confirmLabel: string;
  /** `null` cuando el diálogo tiene un solo botón (estilo alert). */
  cancelLabel: string | null;
  tone: DialogTone;
  /** El diálogo se está cerrando: dispara la animación de salida. */
  leaving: boolean;
  onExited: () => void;
  onConfirm: () => void;
  onCancel: () => void;
};

/** Elementos que participan en el trap de Tab. */
const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export default function Dialog({
  anchor,
  returnFocus,
  title,
  message,
  detail,
  confirmLabel,
  cancelLabel,
  tone,
  leaving,
  onExited,
  onConfirm,
  onCancel,
}: DialogProps) {
  const cardRef = useRef<HTMLDivElement | null>(null);
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const baseId = useId();
  const overlayRef = useRef<HTMLDivElement>(null);
  const presence = usePresence(leaving ? null : true, 160, overlayRef);
  const position = useFloatingPosition(anchor, cardRef, { gap: 9, track: !leaving, frozen: leaving });
  const cancelCallback = useRef(onCancel);
  const focusedRef = useRef(false);
  cancelCallback.current = onCancel;

  useLayoutEffect(() => {
    if (leaving && presence.value === null) onExited();
  }, [leaving, presence.value, onExited]);

  // El foco entra en la tarjeta al abrir y vuelve al elemento anterior al cerrar.
  // En un diálogo destructivo empieza en Cancelar; si no es destructivo, en la acción.
  useLayoutEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // El portal queda fuera de la app: el fondo conserva su aspecto, pero no su foco.
    const siblings = Array.from(document.body.children).filter((element): element is HTMLElement =>
      element instanceof HTMLElement && element !== overlayRef.current && !element.inert);
    siblings.forEach(element => { element.inert = true; });
    const trigger = anchor && "element" in anchor ? anchor.element : null;
    trigger?.setAttribute("data-dialog-anchor", "");
    window.dispatchEvent(new Event("trex:dialog-open"));
    return () => {
      siblings.forEach(element => { element.inert = false; });
      trigger?.removeAttribute("data-dialog-anchor");
      const candidates = [returnFocus, previous, ...document.querySelectorAll<HTMLElement>(".modal-header .icon-btn, .sidebar:not(.collapsed) .sidebar-collapse, .sidebar.peek .sidebar-collapse, .sidebar-reopen:not([hidden])")];
      const restore = candidates.find(element => element?.isConnected && !element.closest("[inert]") && element.getClientRects().length);
      restore?.focus({ preventScroll: true });
    };
  }, [anchor, returnFocus, tone, cancelLabel]);

  useLayoutEffect(() => {
    // El primer render se mide oculto; el foco entra cuando la posición ya existe.
    if ((anchor && !position) || focusedRef.current) return;
    const target = tone === "danger" && cancelLabel ? cancelRef.current : confirmRef.current;
    target?.focus({ preventScroll: true });
    focusedRef.current = true;
  }, [anchor, position, tone, cancelLabel]);

  useEffect(() => {
    if (!anchor || !("element" in anchor) || leaving) return;
    let frame = 0;
    const check = (): void => {
      const rect = anchor.element.getBoundingClientRect();
      if (!anchor.element.isConnected || !rect.width || !rect.height || rect.bottom <= 0 || rect.top >= window.innerHeight
        || rect.right <= 0 || rect.left >= window.innerWidth) {
        cancelCallback.current();
        return;
      }
      frame = requestAnimationFrame(check);
    };
    frame = requestAnimationFrame(check);
    return () => cancelAnimationFrame(frame);
  }, [anchor, leaving]);

  // Escape cancela. Se escucha en la fase de captura para que funcione aunque el
  // foco esté dentro del terminal (xterm también mira el teclado).
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onCancel]);

  // Trap simple: Tab cicla entre los controles de la tarjeta.
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== "Tab") return;
    const card = cardRef.current;
    if (!card) return;
    const items = Array.from(card.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !card.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !card.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  };

  return createPortal(
    <div
      ref={overlayRef}
      className={`dialog-overlay${anchor ? " anchored" : ""}${presence.entering ? " entering" : ""}${leaving ? " leaving" : ""}`}
      inert={leaving}
      aria-hidden={leaving || undefined}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <div
        ref={cardRef}
        data-motion-surface
        className={`dialog-card${anchor ? " floating-surface" : ""}${tone === "danger" ? " danger" : ""}`}
        style={anchor ? { left: position?.left ?? 8, top: position?.top ?? 8,
          visibility: position ? "visible" : "hidden", transformOrigin: position?.origin,
          "--dialog-travel": position?.side === "top" ? "4px" : "-4px" } as CSSProperties : undefined}
        data-side={anchor ? position?.side : undefined}
        role={leaving ? undefined : "alertdialog"}
        aria-modal="true"
        aria-labelledby={`${baseId}-title`}
        aria-describedby={[message && `${baseId}-desc`, detail && `${baseId}-detail`].filter(Boolean).join(" ") || undefined}
        onKeyDown={onKeyDown}
      >
        <div className="dialog-body">
          <span className="dialog-icon" aria-hidden="true">
            {tone === "danger" ? <AlertIcon size={18} /> : <InfoIcon size={18} />}
          </span>
          <div className="dialog-text">
            <h2 className="dialog-title" id={`${baseId}-title`}>
              {title}
            </h2>
            {message && (
              <p className="dialog-message" id={`${baseId}-desc`}>
                {message}
              </p>
            )}
            {detail && <p className="dialog-detail" id={`${baseId}-detail`}>{detail}</p>}
          </div>
        </div>

        <div className="dialog-footer">
          {cancelLabel && (
            <button ref={cancelRef} type="button" className="dialog-btn" onClick={onCancel}>
              {cancelLabel}
            </button>
          )}
          <button
            ref={confirmRef}
            type="button"
            className={`dialog-btn primary${tone === "danger" ? " danger" : ""}`}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
