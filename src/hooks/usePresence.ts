import { useLayoutEffect, useState } from "react";
import { useReducedMotion } from "./useReducedMotion";

/** Conserva una capa durante su salida; reabrirla revierte la transición actual. */
export function usePresence<T>(value: T | null, exitMs = 160) {
  const [retained, setRetained] = useState(value);
  const [entered, setEntered] = useState(false);
  const open = value !== null;
  const reduce = useReducedMotion();

  // Ajustar antes de pintar evita un fotograma con el ancla o texto anteriores.
  if (open && value !== retained) setRetained(value);

  useLayoutEffect(() => {
    if (open) {
      if (reduce) {
        setEntered(true);
        return;
      }
      let frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(() => setEntered(true));
      });
      return () => cancelAnimationFrame(frame);
    }
    if (retained === null) return;
    const finish = (): void => { setRetained(null); setEntered(false); };
    if (reduce) { finish(); return; }
    const timer = window.setTimeout(finish, exitMs);
    return () => {
      window.clearTimeout(timer);
    };
  }, [open, retained !== null, exitMs, reduce]);

  return { value: value ?? retained, entering: open && !entered, leaving: !open };
}
