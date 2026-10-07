import { useSyncExternalStore } from "react";
import { reducedMotion } from "../visualDesign";

const snapshot = (): boolean => reducedMotion(document.documentElement.dataset.motion, window.matchMedia("(prefers-reduced-motion: reduce)").matches);
const subscribe = (callback: () => void): (() => void) => {
  const media = window.matchMedia("(prefers-reduced-motion: reduce)");
  window.addEventListener("trex:motion-change", callback);
  media.addEventListener("change", callback);
  return () => { window.removeEventListener("trex:motion-change", callback); media.removeEventListener("change", callback); };
};
export const useReducedMotion = (): boolean => useSyncExternalStore(subscribe, snapshot);
