import {
  useId,
  useLayoutEffect,
  useRef,
  type ReactNode,
  type KeyboardEvent,
  type RefObject,
} from "react";
import { CloseIcon } from "./Icons";

export type FeatureDialogMotionProps = {
  entering?: boolean;
  leaving?: boolean;
  surfaceRef?: RefObject<HTMLDivElement | null>;
};

/** Mantiene el foco dentro de las acciones rápidas y vuelve a la terminal al salir. */
export default function FeatureDialog({
  title,
  onClose,
  children,
  footer,
  className = "",
  entering = false,
  leaving = false,
  surfaceRef,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
} & FeatureDialogMotionProps) {
  const id = useId(),
    ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const previous =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const background = Array.from(
      document.querySelectorAll<HTMLElement>(".app > .sidebar, .app > .main"),
    );
    const inert = background.map((element) => element.inert);
    background.forEach((element) => {
      element.inert = true;
    });
    (
      ref.current?.querySelector<HTMLElement>("[data-autofocus]") ??
      ref.current?.querySelector<HTMLElement>("input,button") ??
      ref.current
    )?.focus({ preventScroll: true });
    return () => {
      background.forEach((element, index) => {
        element.inert = inert[index];
      });
      const anotherDialog = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"], [role="alertdialog"]'))
        .some(element => element !== ref.current && !element.closest('[inert], [aria-hidden="true"]'));
      if (!anotherDialog) {
        const target = previous?.isConnected && !previous.closest("[inert]") ? previous
          : ['.session-create > button[aria-label="Nueva sesión"]:not(:disabled)', '.sidebar-collapse', '.sidebar-reopen:not([hidden])']
            .map(selector => document.querySelector<HTMLElement>(selector))
            .find(element => element && element.getClientRects().length && !element.closest("[inert]"));
        target?.focus({ preventScroll: true });
      }
    };
  }, []);
  const keys = (event: KeyboardEvent): void => {
    if (leaving) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }
    if (event.key !== "Tab") return;
    const items = Array.from(
      ref.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex="0"]',
      ) ?? [],
    ).filter((element) => element.tabIndex >= 0 && element.getClientRects().length);
    if (event.shiftKey && document.activeElement === items[0]) {
      event.preventDefault();
      items[items.length - 1]?.focus();
    }
    if (!event.shiftKey && document.activeElement === items[items.length - 1]) {
      event.preventDefault();
      items[0]?.focus();
    }
  };
  return (
    <div
      ref={surfaceRef}
      className={`modal-backdrop feature-backdrop${entering ? " entering" : ""}${leaving ? " leaving" : ""}`}
      inert={leaving}
      aria-hidden={leaving || undefined}
      onMouseDown={(event) => {
        if (!leaving && event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        data-motion-surface
        className={`modal feature-dialog ${className}`}
        role={leaving ? undefined : "dialog"}
        aria-modal="true"
        aria-labelledby={id}
        onKeyDown={keys}
      >
        <header className="modal-header">
          <h2 id={id} className="modal-title">
            {title}
          </h2>
          <button
            className="icon-btn"
            aria-label={`Cerrar ${title.toLowerCase()}`}
            onClick={onClose}
          >
            <CloseIcon size={16} />
          </button>
        </header>
        <div className="feature-content">{children}</div>
        {footer && <footer className="modal-footer">{footer}</footer>}
      </div>
    </div>
  );
}
