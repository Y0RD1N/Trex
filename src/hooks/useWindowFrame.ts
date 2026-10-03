/**
 * Refleja el estado de la ventana nativa en `<html data-window-state>`.
 *
 * La ventana es transparente y sin bordes del sistema: la app dibuja su propio
 * marco con esquinas redondeadas (`--window-radius`). Maximizada o a pantalla
 * completa la ventana llena toda la pantalla, y las esquinas redondeadas
 * dejarían huecos, así que el CSS las quita según este atributo.
 *
 * Vive a nivel de App (no en WindowControls) porque la barra superior puede
 * estar auto-oculta y sus controles desmontados mientras la ventana cambia.
 */
import { useEffect } from "react";
import { getWindowFrameState, onWindowResized } from "../window";

export function useWindowFrame(): void {
  useEffect(() => {
    let alive = true;
    const root = document.documentElement;
    const refresh = (): void => {
      void getWindowFrameState().then((state) => {
        if (alive) root.dataset.windowState = state;
      });
    };
    refresh();
    const unsubscribe = onWindowResized(refresh);
    return () => {
      alive = false;
      unsubscribe();
    };
  }, []);
}
