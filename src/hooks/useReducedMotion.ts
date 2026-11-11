import { useSyncExternalStore } from "react";
import { reducedMotion } from "../visualDesign";

/**
 * Una sola consulta para toda la app. React lee el valor en cada render de cada componente que lo
 * usa (menús, paneles, el compositor del chat...), y crear la consulta con `matchMedia` en cada
 * lectura era de lo que más gastaba mientras llegaba texto; leer `.matches` de la misma es inmediato.
 */
let media: MediaQueryList | null = null;
const query = (): MediaQueryList => media ??= window.matchMedia("(prefers-reduced-motion: reduce)");

const snapshot = (): boolean => reducedMotion(document.documentElement.dataset.motion, query().matches);
const subscribe = (callback: () => void): (() => void) => {
  const list = query();
  window.addEventListener("trex:motion-change", callback);
  list.addEventListener("change", callback);
  return () => { window.removeEventListener("trex:motion-change", callback); list.removeEventListener("change", callback); };
};
export const useReducedMotion = (): boolean => useSyncExternalStore(subscribe, snapshot, () => false);
