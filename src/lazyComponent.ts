/**
 * Componentes pesados que casi nunca se abren (ajustes, paleta de comandos,
 * diálogos): van en su propio fragmento para no retrasar el arranque.
 *
 * Se piden solos cuando la app queda libre tras arrancar. Si ya llegaron al
 * abrirlos se pintan directamente, sin pasar por Suspense, y conservan su
 * animación de entrada; si no, el `<Suspense>` que los rodea espera a que lleguen.
 */
import { createElement, lazy, type ComponentType } from "react";

/** Tras el arranque, la primera vez que el navegador queda libre. */
const PRELOAD_DELAY_MS = 2500;

export function lazyComponent<P extends object>(load: () => Promise<{ default: ComponentType<P> }>) {
  let loaded: ComponentType<P> | null = null;
  let pending: Promise<ComponentType<P>> | null = null;
  const preload = (): Promise<ComponentType<P>> => pending ??= load().then(module => (loaded = module.default), error => {
    pending = null;
    throw error;
  });
  const Deferred = lazy(() => preload().then(component => ({ default: component })));
  function LazyComponent(props: P) {
    return createElement((loaded ?? Deferred) as ComponentType<P>, props);
  }
  if (typeof window !== "undefined") {
    const idle = (window as Window & { requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number }).requestIdleCallback;
    window.setTimeout(() => {
      const run = (): void => { void preload().catch(() => undefined); };
      if (idle) idle(run, { timeout: 5000 }); else run();
    }, PRELOAD_DELAY_MS);
  }
  return Object.assign(LazyComponent, { preload });
}
