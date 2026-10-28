/**
 * Capa que aparece al acercar el cursor a un borde de la ventana y se esconde
 * al alejarlo (barra lateral colapsada, barra superior en modo inmersivo).
 *
 * La detección es geométrica, no por elementos: se sigue el puntero a nivel de
 * ventana y se compara su coordenada con dos zonas. Así no depende de qué haya
 * justo debajo (el borde de 1 px de la ventana, una capa que se desliza, un menú)
 * ni de eventos `enter`/`leave` que llegan tarde o dos veces mientras algo se
 * mueve, que era lo que hacía parpadear la barra.
 *
 *  - Zona de apertura: franja de `edgeSize` px pegada al borde, incluido el píxel 0
 *    (al empujar el cursor contra el borde queda justo ahí).
 *  - Zona de permanencia: toda la capa abierta (`extent`) más un margen. Es mayor
 *    que la de apertura (histéresis): una vez abierta, el temblor del ratón en el
 *    borde no puede cerrarla.
 *
 * Otras reglas:
 *  - Abrir tiene un pequeño retardo: un barrido rápido del ratón no la dispara.
 *  - Con un botón pulsado (por ejemplo seleccionando texto en el terminal) no abre.
 *  - No se esconde mientras haya un menú o diálogo abierto, el cursor siga en la
 *    zona de permanencia o el foco de teclado esté dentro; lo vuelve a comprobar
 *    cada 400 ms.
 */
import { useCallback, useEffect, useRef, useState, type FocusEvent, type RefObject } from "react";

const HOLD_POLL_MS = 400;
/** Margen alrededor de la capa abierta donde el cursor aún cuenta como "dentro". */
const HOLD_SLACK = 10;

/** Hay un menú o diálogo abierto: la capa flotante no debe esconderse debajo. */
const overlayOpen = (): boolean =>
  document.querySelector('[role="menu"], [role="dialog"], [role="alertdialog"]') !== null;

type Options<T extends HTMLElement> = {
  /** Si es false la capa está siempre en su estado normal y el hook no hace nada. */
  enabled: boolean;
  /** Borde de la ventana al que está pegada la capa. */
  edge: "top" | "left";
  /** Grosor en px de la franja de apertura, contado desde el píxel 0. */
  edgeSize?: number;
  /** Tamaño en px de la capa abierta sobre el eje del borde (alto o ancho). */
  extent: number;
  /**
   * Coordenada mínima sobre el otro eje para poder abrir. Deja libre una esquina
   * para la otra capa: con la barra lateral oculta, la esquina superior izquierda
   * abre solo la lateral y no las dos a la vez.
   */
  openFrom?: number;
  openDelay?: number;
  closeDelay?: number;
  /** Mostrarla un instante al activar `enabled` (avisa de que ahora se esconde sola). */
  introMs?: number;
  /** Condición extra para mantenerla abierta (por ejemplo, un campo de texto enfocado). */
  holdOpen?: (element: T) => boolean;
};

type HoverReveal<T extends HTMLElement> = {
  ref: RefObject<T | null>;
  revealed: boolean;
  /** Esconde ya, sin esperar ni comprobar nada (por ejemplo tras elegir una sesión). */
  hide: () => void;
  handlers: {
    onFocusCapture: (event: FocusEvent<T>) => void;
    onBlurCapture: (event: FocusEvent<T>) => void;
  };
};

export function useHoverReveal<T extends HTMLElement>({
  enabled,
  edge,
  // Frameless native windows reserve the first pixels for resizing. Keep a
  // usable hover strip inside that border, including on scaled displays.
  edgeSize = 16,
  extent,
  openFrom = 0,
  openDelay = 80,
  closeDelay = 360,
  introMs = 0,
  holdOpen,
}: Options<T>): HoverReveal<T> {
  const ref = useRef<T>(null);
  const [revealed, setRevealed] = useState(false);
  const revealedRef = useRef(false);
  const timer = useRef<number | null>(null);
  const timerKind = useRef<"open" | "close" | null>(null);
  /** Última posición conocida del cursor: [eje del borde, eje transversal]. */
  const pointer = useRef<[number, number]>([Infinity, Infinity]);
  const wasEnabledRef = useRef<boolean | null>(null);

  // Los manejadores globales leen siempre los valores más recientes.
  const live = useRef({ enabled, edgeSize, extent, openFrom, openDelay, closeDelay, holdOpen });
  live.current = { enabled, edgeSize, extent, openFrom, openDelay, closeDelay, holdOpen };

  const clear = useCallback((): void => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    timerKind.current = null;
  }, []);

  const apply = useCallback((value: boolean): void => {
    revealedRef.current = value;
    setRevealed(value);
  }, []);

  /** ¿Está el cursor en la zona de permanencia de la capa abierta? */
  const inHoldZone = useCallback((): boolean => {
    const { edgeSize: size, extent: length } = live.current;
    return pointer.current[0] <= Math.max(size, length) + HOLD_SLACK;
  }, []);

  const schedule = useCallback((open: boolean, delay: number): void => {
    clear();
    timerKind.current = open ? "open" : "close";
    const run = (): void => {
      timer.current = null;
      timerKind.current = null;
      if (!open) {
        const element = ref.current;
        if (element && (inHoldZone() || overlayOpen() || live.current.holdOpen?.(element))) {
          timer.current = window.setTimeout(run, HOLD_POLL_MS);
          timerKind.current = "close";
          return;
        }
      }
      apply(open);
    };
    timer.current = window.setTimeout(run, delay);
  }, [apply, clear, inHoldZone]);

  // Seguimiento del puntero a nivel de ventana (fase de captura: ni xterm ni los
  // menús pueden taparlo).
  useEffect(() => {
    const onMove = (event: PointerEvent): void => {
      const along = edge === "top" ? event.clientY : event.clientX;
      const across = edge === "top" ? event.clientX : event.clientY;
      pointer.current = [along, across];
      const { enabled: on, edgeSize: size, openFrom: from, openDelay: delayOpen, closeDelay: delayClose } = live.current;
      if (!on) return;

      if (revealedRef.current) {
        // Abierta: sale de la zona de permanencia → cuenta atrás; vuelve → se cancela.
        if (inHoldZone()) {
          if (timerKind.current === "close") clear();
        } else if (timerKind.current !== "close") {
          schedule(false, delayClose);
        }
        return;
      }
      // Cerrada: solo la franja del borde (y sin botón pulsado) la abre.
      const inEdge = along <= size && across >= from && event.buttons === 0;
      if (inEdge) {
        if (timerKind.current !== "open") schedule(true, delayOpen);
      } else if (timerKind.current === "open") {
        clear();
      }
    };
    // El cursor sale de la ventana: no puede seguir "en la zona".
    const onLeaveWindow = (): void => {
      pointer.current = [Infinity, Infinity];
      if (!live.current.enabled) return;
      if (revealedRef.current) {
        if (timerKind.current !== "close") schedule(false, live.current.closeDelay);
      } else if (timerKind.current === "open") {
        clear();
      }
    };
    window.addEventListener("pointermove", onMove, { capture: true, passive: true });
    document.documentElement.addEventListener("pointerleave", onLeaveWindow);
    return () => {
      window.removeEventListener("pointermove", onMove, { capture: true });
      document.documentElement.removeEventListener("pointerleave", onLeaveWindow);
    };
  }, [edge, clear, schedule, inHoldZone]);

  // Al activarse o desactivarse el modo se parte siempre de "escondida".
  useEffect(() => {
    clear();
    if (!enabled) {
      apply(false);
    } else if (wasEnabledRef.current === false && introMs > 0) {
      // Solo al activarlo en caliente, no al arrancar la aplicación.
      apply(true);
      schedule(false, introMs);
    }
    wasEnabledRef.current = enabled;
    return clear;
  }, [enabled, introMs, apply, clear, schedule]);

  const hide = useCallback((): void => {
    clear();
    apply(false);
  }, [apply, clear]);

  const handlers: HoverReveal<T>["handlers"] = {
    // Navegar con el teclado hasta la capa la revela; al salir de ella se esconde.
    onFocusCapture: (event) => {
      if (!enabled || !event.target.matches(":focus-visible")) return;
      clear();
      apply(true);
    },
    onBlurCapture: (event) => {
      if (!enabled || !revealedRef.current) return;
      const next = event.relatedTarget;
      if (!(next instanceof Node) || !ref.current?.contains(next)) schedule(false, closeDelay);
    },
  };

  return { ref, revealed, hide, handlers };
}
