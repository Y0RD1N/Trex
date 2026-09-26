/**
 * Acceso a la ventana nativa (Tauri v2) con degradación segura.
 *
 * Todo pasa por aquí y todo está envuelto en try/catch: la misma interfaz se
 * ejecuta en el navegador (desarrollo y pruebas visuales), donde
 * `@tauri-apps/api/window` no puede invocar nada. Ahí los helpers simplemente
 * no hacen nada, pero nunca rompen el render ni dejan una promesa rechazada.
 *
 * Nota sobre el arrastre: el script interno de Tauri reacciona a los elementos
 * con `data-tauri-drag-region` (mousedown → start_dragging, doble clic →
 * toggle maxi­mize), así que la barra de título no necesita más lógica.
 */
import { getCurrentWindow, type Window } from "@tauri-apps/api/window";

/** Ejecuta una acción sobre la ventana actual sin romper fuera de Tauri. */
const withWindow = (action: (win: Window) => Promise<unknown>): void => {
  try {
    // `getCurrentWindow()` ya lanza si no hay runtime de Tauri: todo el bloque
    // va dentro del try y el rechazo de la promesa se silencia aparte.
    void Promise.resolve(action(getCurrentWindow())).catch(() => {
      /* sin runtime nativo: la acción se ignora */
    });
  } catch {
    /* sin runtime nativo: la acción se ignora */
  }
};

/** Minimiza la ventana (botón "—" de la barra superior). */
export const minimizeWindow = (): void => withWindow((win) => win.minimize());

/** Alterna maximizar / restaurar (botón "▢" y doble clic en la barra). */
export const toggleMaximizeWindow = (): void => withWindow((win) => win.toggleMaximize());

/** Cierra la ventana («Cerrar ventana» del menú "⋯" y «Salir de trex»). */
export const closeWindow = (): void => withWindow((win) => win.close());

/** ¿La ventana está maximizada ahora mismo? (false si no hay runtime). */
export const isWindowMaximized = async (): Promise<boolean> => {
  try {
    return await getCurrentWindow().isMaximized();
  } catch {
    return false;
  }
};

/**
 * Se suscribe a los cambios de tamaño de la ventana (para refrescar el icono
 * maximizar/restaurar). Devuelve la función para darse de baja.
 */
export const onWindowResized = (handler: () => void): (() => void) => {
  let unlisten: (() => void) | null = null;
  let cancelled = false;
  try {
    void getCurrentWindow()
      .onResized(() => handler())
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch(() => undefined);
  } catch {
    /* sin runtime nativo */
  }
  return () => {
    cancelled = true;
    unlisten?.();
  };
};
