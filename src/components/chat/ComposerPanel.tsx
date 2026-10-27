import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useFloatingPosition } from "../../hooks/useFloatingPosition";
import { ChevronIcon, CloseIcon } from "../Icons";
import "./ComposerPanel.css";

type Props = {
  label: string;
  title: string;
  icon: ReactNode;
  count?: string | number;
  detail?: string;
  attention?: boolean;
  live?: boolean;
  visible?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  actions?: ReactNode;
  children: ReactNode;
};

const PANEL_OPEN = "trex:composer-panel-open";

/** Attached tabs keep auxiliary work outside the writing area. Children stay
 * mounted when folded so queue drafts and their conflict checks survive. */
export default function ComposerPanel({ label, title, icon, count, detail, attention = false, live = false,
  visible = true, open: controlledOpen, onOpenChange, actions, children }: Props) {
  const id = useId(), trigger = useRef<HTMLButtonElement>(null), surface = useRef<HTMLDivElement>(null);
  const [localOpen, setLocalOpen] = useState(false);
  const open = visible && (controlledOpen ?? localOpen);
  const change = useRef<(value: boolean) => void>(() => {});
  change.current = value => { setLocalOpen(value); onOpenChange?.(value); };
  const dismiss = useRef<(restoreFocus?: boolean) => void>(() => {});
  dismiss.current = (restoreFocus = false) => {
    const writer = trigger.current?.closest(".chat-composer-wrap")?.querySelector<HTMLTextAreaElement>(".chat-composer:not([hidden]) textarea:not(:disabled)");
    change.current(false);
    if (restoreFocus) requestAnimationFrame(() => {
      // The last terminal/queue tab may disappear as its panel folds.
      const target = trigger.current?.getClientRects().length ? trigger.current : writer;
      target?.focus({ preventScroll: true });
    });
  };
  const anchor = useMemo(() => open && trigger.current ? { element: trigger.current } : null, [open]);
  const position = useFloatingPosition(anchor, surface, { side: "top", align: "start", flip: false, gap: 8 });
  useEffect(() => { if (!visible) change.current(false); }, [visible]);
  const focused = useRef(false);
  useLayoutEffect(() => {
    if (!open) { focused.current = false; return; }
    if (position && !focused.current) { focused.current = true; surface.current?.focus({ preventScroll: true }); }
  }, [open, position]);

  useEffect(() => {
    if (!open) return;
    const close = (focus = false): void => dismiss.current(focus);
    const inside = (target: EventTarget | null): boolean => target instanceof Node
      && (!!surface.current?.contains(target) || !!trigger.current?.contains(target)
        // Selects in a panel render their menus in a separate portal.
        || target instanceof Element && !!target.closest(".context-menu"));
    const onPointer = (event: PointerEvent): void => { if (!inside(event.target)) close(); };
    const onFocus = (event: FocusEvent): void => { if (!inside(event.target)) close(); };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault(); event.stopPropagation(); close(true);
    };
    const onPanel = (event: Event): void => { if ((event as CustomEvent).detail !== id) close(); };
    const onDialog = (): void => close();
    window.addEventListener("pointerdown", onPointer, true);
    document.addEventListener("focusin", onFocus);
    // Bubble phase lets nested menus consume Escape before the panel does.
    window.addEventListener("keydown", onKey);
    window.addEventListener(PANEL_OPEN, onPanel);
    window.addEventListener("trex:dialog-open", onDialog);
    window.dispatchEvent(new CustomEvent(PANEL_OPEN, { detail: id }));
    return () => {
      window.removeEventListener("pointerdown", onPointer, true);
      document.removeEventListener("focusin", onFocus);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(PANEL_OPEN, onPanel);
      window.removeEventListener("trex:dialog-open", onDialog);
    };
  }, [open, id]);

  // A session can remain mounted in a hidden tab. Close its portal with it.
  useEffect(() => {
    if (!open || !trigger.current) return;
    const observer = new ResizeObserver(() => { if (!trigger.current?.getClientRects().length) change.current(false); });
    observer.observe(trigger.current);
    return () => observer.disconnect();
  }, [open]);

  return <>
    {visible && <button ref={trigger} type="button" className={`composer-tab${attention ? " needs-attention" : ""}`}
      aria-expanded={open} aria-controls={id} aria-label={`${label}${count !== undefined ? `: ${count}` : ""}${attention ? ", requiere atención" : ""}`}
      onClick={() => change.current(!open)}>
      {icon}{live && <span className="composer-tab-live" aria-hidden="true" />}
      <span>{label}</span>{count !== undefined && <span className="composer-tab-count">{count}</span>}
      <ChevronIcon size={12} />
    </button>}
    {createPortal(<div ref={surface} id={id} role="region" tabIndex={-1} aria-label={title} hidden={!open} inert={!open}
      className="composer-panel" style={{ left: position?.left ?? 8, top: position?.top ?? 8, visibility: open && position ? "visible" : "hidden" }}>
      <header className="composer-panel-heading"><div><h2>{title}</h2>{detail && <p>{detail}</p>}</div>{actions}
        <button type="button" className="icon-btn" aria-label={`Contraer ${label.toLocaleLowerCase()}`}
          onClick={() => dismiss.current(true)}><CloseIcon size={14} /></button>
      </header>
      <div className="composer-panel-body">{children}</div>
    </div>, document.body)}
  </>;
}
