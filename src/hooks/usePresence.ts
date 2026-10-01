import { useLayoutEffect, useState } from "react";

/** Conserva una capa durante su salida; reabrirla revierte la transición actual. */
export function usePresence<T>(value: T | null, exitMs = 160) {
  const [retained, setRetained] = useState(value);
  const [entered, setEntered] = useState(false);
  const open = value !== null;

  // Ajustar antes de pintar evita un fotograma con el ancla o texto anteriores.
  if (open && value !== retained) setRetained(value);

  useLayoutEffect(() => {
    if (open) {
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
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
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (preference.matches) { finish(); return; }
    const timer = window.setTimeout(finish, exitMs);
    const onPreference = (): void => { if (preference.matches) finish(); };
    preference.addEventListener("change", onPreference);
    return () => {
      window.clearTimeout(timer);
      preference.removeEventListener("change", onPreference);
    };
  }, [open, retained !== null, exitMs]);

  return { value: value ?? retained, entering: open && !entered, leaving: !open };
}
