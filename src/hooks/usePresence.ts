import { useLayoutEffect, useState, type RefObject } from "react";
import { useReducedMotion } from "./useReducedMotion";
import { enterAfterPaint, waitForMotion } from "../motion";

/** Conserva una capa durante su salida; reabrirla revierte la transición actual. */
export function usePresence<T>(value: T | null, exitMs = 160, surfaceRef?: RefObject<HTMLElement | null>) {
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
      return enterAfterPaint(() => setEntered(true));
    }
    if (retained === null) return;
    const finish = (): void => { setRetained(null); setEntered(false); };
    if (reduce) { finish(); return; }
    return waitForMotion(surfaceRef?.current ?? null, finish, exitMs);
  }, [open, retained !== null, exitMs, reduce, surfaceRef]);

  return { value: value ?? retained, entering: open && !entered, leaving: !open };
}
