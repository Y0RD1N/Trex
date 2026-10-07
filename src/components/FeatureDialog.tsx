import {
  useId,
  useLayoutEffect,
  useRef,
  type ReactNode,
  type KeyboardEvent,
} from "react";
import { CloseIcon } from "./Icons";
/** Mantiene el foco dentro de las acciones rápidas y vuelve a la terminal al salir. */
export default function FeatureDialog({
  title,
  onClose,
  children,
  footer,
  className = "",
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
}) {
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
      if (previous?.isConnected && !previous.closest("[inert]"))
        previous.focus({ preventScroll: true });
    };
  }, []);
  const keys = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }
    if (event.key !== "Tab") return;
    const items = Array.from(
      ref.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]',
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
      className="modal-backdrop feature-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        className={`modal feature-dialog ${className}`}
        role="dialog"
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
