/**
 * Tarjeta de diálogo con estética macOS (Sonoma / Sequoia).
 *
 * Es un componente de presentación: la cola, las promesas y el ciclo de vida
 * viven en `DialogProvider`. Aquí solo se resuelven el foco inicial, el trap de
 * teclado, el cierre con Escape y el pintado de la tarjeta.
 */
import { useEffect, useId, useRef, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { AlertIcon, InfoIcon } from "./Icons";

export type DialogTone = "default" | "danger";

export type DialogProps = {
  title: string;
  message?: string;
  detail?: string;
  confirmLabel: string;
  /** `null` cuando el diálogo tiene un solo botón (estilo alert). */
  cancelLabel: string | null;
  tone: DialogTone;
  /** El diálogo se está cerrando: dispara la animación de salida. */
  leaving: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

/** Elementos que participan en el trap de Tab. */
const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export default function Dialog({
  title,
  message,
  detail,
  confirmLabel,
  cancelLabel,
  tone,
  leaving,
  onConfirm,
  onCancel,
}: DialogProps) {
  const cardRef = useRef<HTMLDivElement | null>(null);
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const baseId = useId();

  // El foco entra en la tarjeta al abrir y vuelve al elemento anterior al cerrar.
  // En un diálogo destructivo empieza en Cancelar; si no es destructivo, en la acción.
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const target = tone === "danger" && cancelLabel ? cancelRef.current : confirmRef.current;
    target?.focus();
    return () => {
      if (previous && document.contains(previous)) {
        try {
          previous.focus();
        } catch {
          /* el elemento ya no está en el documento */
        }
      }
    };
  }, [tone, cancelLabel]);

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

  return (
    <div
      className={`dialog-overlay${leaving ? " leaving" : ""}`}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <div
        ref={cardRef}
        className={`dialog-card${tone === "danger" ? " danger" : ""}`}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={`${baseId}-title`}
        aria-describedby={message ? `${baseId}-desc` : undefined}
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
            {detail && <p className="dialog-detail">{detail}</p>}
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
    </div>
  );
}
