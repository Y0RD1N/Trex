import { useCallback, useRef, useState } from "react";

/** Una entrada se consume al terminar o al ocultarse la pestaña, sin repetirla. */
export function useMessageEntry(animate: boolean) {
  const [entering, setEntering] = useState(animate);
  const activeRef = useRef(animate);
  const cleanupRef = useRef<(() => void) | null>(null);

  // La ref también cambia si el resumen sustituye su raíz por otra superficie.
  const ref = useCallback((element: HTMLElement | null): void => {
    cleanupRef.current?.();
    cleanupRef.current = null;
    if (!activeRef.current || !element) return;
    const complete = (): void => {
      activeRef.current = false;
      cleanupRef.current?.();
      cleanupRef.current = null;
      setEntering(false);
    };
    const finish = (event: AnimationEvent): void => {
      if (event.target === element && event.animationName === "chat-rise") complete();
    };
    element.addEventListener("animationend", finish);
    element.addEventListener("animationcancel", finish);
    cleanupRef.current = () => {
      element.removeEventListener("animationend", finish);
      element.removeEventListener("animationcancel", finish);
    };
    if (getComputedStyle(element).animationName === "none") complete();
  }, []);

  return { entering, ref };
}
