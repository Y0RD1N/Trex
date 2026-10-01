import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useFloatingPosition } from "../hooks/useFloatingPosition";
import { usePresence } from "../hooks/usePresence";

type Tip = { element: HTMLElement; text: string };

/** Tooltips compartidos fuera de los contenedores que recortan su contenido. */
export default function TooltipProvider() {
  const [tip, setTip] = useState<Tip | null>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const id = useId();
  const presence = usePresence(tip, 100);
  const retainedTip = presence.value;
  const anchor = useMemo(() => retainedTip ? { element: retainedTip.element } : null, [retainedTip]);
  const position = useFloatingPosition(anchor, surfaceRef, {
    side: retainedTip?.element.classList.contains("tip-below") ? "bottom" : "top", align: "center", gap: 8,
  });

  useEffect(() => {
    let timer: number | undefined;
    let hovered: HTMLElement | null = null;
    let focused: HTMLElement | null = null;
    let dismissed: HTMLElement | null = null;
    const targetOf = (target: EventTarget | null): HTMLElement | null =>
      target instanceof Element ? target.closest<HTMLElement>("[data-tip]") : null;
    const hide = (): void => { window.clearTimeout(timer); setTip(null); };
    const show = (element: HTMLElement, delay: number): void => {
      hide();
      if (element === dismissed || element.matches(":disabled") || (element.getAttribute("aria-haspopup") === "menu" && element.getAttribute("aria-expanded") === "true")) return;
      timer = window.setTimeout(() => {
        const text = element.dataset.tip;
        if (element.isConnected && text) setTip({ element, text });
      }, delay);
    };
    const onOver = (event: PointerEvent): void => {
      const element = targetOf(event.target);
      if (!element || element === hovered || event.pointerType === "touch") return;
      hovered = element;
      if (element === dismissed) dismissed = null;
      show(element, 350);
    };
    const onOut = (event: PointerEvent): void => {
      if (hovered?.contains(event.relatedTarget as Node | null)) return;
      hovered = null;
      if (focused !== dismissed) dismissed = null;
      if (focused?.matches(":focus-visible")) show(focused, 0);
      else hide();
    };
    const onFocus = (event: FocusEvent): void => {
      focused = targetOf(event.target);
      if (focused?.matches(":focus-visible")) show(focused, 0);
    };
    const onBlur = (): void => {
      focused = null;
      if (hovered !== dismissed) dismissed = null;
      hide();
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") { dismissed = focused ?? hovered; hide(); }
    };
    document.addEventListener("pointerover", onOver);
    document.addEventListener("pointerout", onOut);
    document.addEventListener("focusin", onFocus);
    document.addEventListener("focusout", onBlur);
    document.addEventListener("pointerdown", hide, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", hide);
    window.addEventListener("blur", hide);
    window.addEventListener("scroll", hide, true);
    window.addEventListener("trex:menu-open", hide);
    window.addEventListener("trex:dialog-open", hide);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("pointerover", onOver);
      document.removeEventListener("pointerout", onOut);
      document.removeEventListener("focusin", onFocus);
      document.removeEventListener("focusout", onBlur);
      document.removeEventListener("pointerdown", hide, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", hide);
      window.removeEventListener("blur", hide);
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("trex:menu-open", hide);
      window.removeEventListener("trex:dialog-open", hide);
    };
  }, []);

  useEffect(() => {
    if (!tip) return;
    const element = tip.element;
    const previous = element.getAttribute("aria-describedby");
    element.setAttribute("aria-describedby", [previous, id].filter(Boolean).join(" "));
    return () => {
      if (previous) element.setAttribute("aria-describedby", previous);
      else element.removeAttribute("aria-describedby");
    };
  }, [tip, id]);

  return retainedTip && createPortal(
    <div ref={surfaceRef} id={id} role={presence.leaving ? undefined : "tooltip"}
      aria-hidden={presence.leaving || undefined}
      className={`tooltip floating-surface${presence.entering ? " entering" : ""}${presence.leaving ? " leaving" : ""}`}
      style={{ left: position?.left ?? 8, top: position?.top ?? 8,
        visibility: position ? "visible" : "hidden", transformOrigin: position?.origin }}>
      {retainedTip.text}
    </div>,
    document.body,
  );
}
