import { useLayoutEffect, useState, type RefObject } from "react";

export type AnchorRect = Pick<DOMRectReadOnly, "left" | "right" | "top" | "bottom">;
export type FloatingAnchor = { element: HTMLElement } | { rect: AnchorRect } | { x: number; y: number };
export type FloatingSide = "top" | "bottom";
/** `frozen` conserva la última posición: una capa que se desvanece no debe moverse. */
type Options = { side?: FloatingSide; align?: "start" | "center" | "end"; gap?: number; track?: boolean; frozen?: boolean };
type Position = { left: number; top: number; origin: string; side: FloatingSide };
type Measurement = { anchor: FloatingAnchor; surface: HTMLElement; position: Position };

/** Posiciona una capa en coordenadas de la ventana, midiendo su tamaño real. */
export function useFloatingPosition(
  anchor: FloatingAnchor | null,
  surfaceRef: RefObject<HTMLElement | null>,
  { side = "bottom", align = "end", gap = 6, track = false, frozen = false }: Options = {},
): Position | null {
  const [measurement, setMeasurement] = useState<Measurement | null>(null);

  useLayoutEffect(() => {
    if (!anchor) { setMeasurement(null); return; }
    if (!surfaceRef.current || frozen) return;
    const surface = surfaceRef.current;
    const update = (): void => {
      const margin = 8;
      const viewport = window.visualViewport;
      const leftEdge = (viewport?.offsetLeft ?? 0) + margin;
      const topEdge = (viewport?.offsetTop ?? 0) + margin;
      const rightEdge = leftEdge + (viewport?.width ?? window.innerWidth) - margin * 2;
      const bottomEdge = topEdge + (viewport?.height ?? window.innerHeight) - margin * 2;
      surface.style.setProperty("--floating-max-width", `${Math.max(1, rightEdge - leftEdge)}px`);
      const rect = "element" in anchor
        ? anchor.element.getBoundingClientRect()
        : "rect" in anchor ? anchor.rect
        : { left: anchor.x, right: anchor.x, top: anchor.y, bottom: anchor.y };
      // offsetWidth no incluye la escala de la animación de entrada. La altura es
      // la del contenido completo (sin el recorte de una altura máxima anterior).
      const width = surface.offsetWidth;
      const natural = surface.scrollHeight + surface.offsetHeight - surface.clientHeight;
      const roomAbove = rect.top - topEdge - gap;
      const roomBelow = bottomEdge - rect.bottom - gap;
      const resolvedSide = side === "bottom"
        ? roomBelow < natural && roomAbove > roomBelow ? "top" : "bottom"
        : roomAbove < natural && roomBelow > roomAbove ? "bottom" : "top";
      // Junto a un botón, la capa crece hasta el espacio de su lado: solo se
      // desplaza por dentro si de verdad no cabe. Junto a un punto (menú
      // contextual) puede ocupar toda la ventana y montarse sobre él.
      const room = "x" in anchor ? bottomEdge - topEdge : resolvedSide === "top" ? roomAbove : roomBelow;
      const maxHeight = Math.max(1, Math.floor(room));
      surface.style.setProperty("--floating-max-height", `${maxHeight}px`);
      const height = Math.min(natural, maxHeight);
      const preferredLeft = align === "start" ? rect.left
        : align === "end" ? rect.right - width : (rect.left + rect.right - width) / 2;
      const preferredTop = resolvedSide === "top" ? rect.top - height - gap : rect.bottom + gap;
      // Píxeles enteros: con medio píxel, WebKit recoloca la capa al empezar o acabar
      // una transición y el menú da un salto de 1 px.
      const left = Math.round(Math.max(leftEdge, Math.min(preferredLeft, rightEdge - width)));
      const top = Math.round(Math.max(topEdge, Math.min(preferredTop, bottomEdge - height)));
      const horizontalOrigin = Math.max(0, Math.min(width, (rect.left + rect.right) / 2 - left));
      const next: Position = {
        left, top, side: resolvedSide,
        origin: `${horizontalOrigin}px ${resolvedSide === "top" ? "bottom" : "top"}`,
      };
      setMeasurement(previous => previous?.anchor === anchor && previous.surface === surface
        && previous.position.left === next.left && previous.position.top === next.top
        && previous.position.origin === next.origin && previous.position.side === next.side
        ? previous : { anchor, surface, position: next });
    };
    update();
    // Las confirmaciones siguen a su botón incluso durante una transición de layout.
    let frame = 0;
    if (track && "element" in anchor) {
      const follow = (): void => { update(); frame = requestAnimationFrame(follow); };
      frame = requestAnimationFrame(follow);
    }
    const observer = new ResizeObserver(update);
    observer.observe(surface);
    if ("element" in anchor) observer.observe(anchor.element);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    window.visualViewport?.addEventListener("resize", update);
    window.visualViewport?.addEventListener("scroll", update);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
      window.visualViewport?.removeEventListener("resize", update);
      window.visualViewport?.removeEventListener("scroll", update);
    };
  }, [anchor, surfaceRef, side, align, gap, track, frozen]);

  // Una reapertura no debe pintar ni enfocar con las coordenadas de otra capa.
  return measurement?.anchor === anchor && measurement.surface === surfaceRef.current
    ? measurement.position : null;
}
