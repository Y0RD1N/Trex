/**
 * Tamaño del marco de la app móvil en iOS.
 *
 * Safari en iPhone no encoge la página al abrir el teclado y, como app de la pantalla de
 * inicio, mide mal la ventana: con la barra de estado translúcida deja abajo una franja
 * de ~59 pt que ningún elemento puede pintar, y al abrir el teclado encoge `innerHeight`
 * (a veces sin devolverlo al cerrarlo). Por eso aquí:
 *
 * - el marco mide lo que se ve de verdad (`visualViewport`), y la altura sin teclado se
 *   recuerda por orientación para no quedarse encogida;
 * - el teclado se detecta por «hay un campo con el foco y el área visible encogió», no
 *   comparando con `innerHeight`, que en la app de inicio encoge con él;
 * - si existe la franja muerta, el margen del indicador de inicio sobra (la franja ya lo
 *   cubre) y la franja toma el color de la barra que tiene encima (ver `.dead-band`).
 *
 * Fuera de iOS no se toca nada: el CSS (`inset: 0`) basta.
 */
const root = document.documentElement;

export const isStandalone = (): boolean =>
  (navigator as Navigator & { standalone?: boolean }).standalone === true || matchMedia("(display-mode: standalone)").matches;

const state = { height: 0, top: 0, full: 0, keyboard: false, band: 0 };

/** Medidas actuales, para la línea de diagnóstico de «Este móvil». */
export function viewportReport(): string {
  const probe = document.createElement("div");
  probe.style.cssText = "position:fixed;visibility:hidden;padding:env(safe-area-inset-top) 0 env(safe-area-inset-bottom)";
  document.body.appendChild(probe);
  const style = getComputedStyle(probe);
  const insets = `${parseFloat(style.paddingTop)}/${parseFloat(style.paddingBottom)}`;
  probe.remove();
  const frame = Math.round(document.querySelector(".r-app")?.getBoundingClientRect().height ?? 0);
  return `${screen.width}×${screen.height} · ventana ${window.innerHeight} · visible ${Math.round(state.height)} · marco ${frame}`
    + ` · márgenes ${insets}${state.band ? ` · franja ${state.band}` : ""} · ${isStandalone() ? "app de inicio" : "navegador"}`;
}

const editing = (): boolean => {
  const element = document.activeElement as HTMLElement | null;
  if (!element) return false;
  if (element.isContentEditable || element.tagName === "TEXTAREA") return true;
  return element.tagName === "INPUT" && !["button", "checkbox", "radio", "file", "submit", "range", "color"].includes((element as HTMLInputElement).type);
};

export function watchViewport(ios: boolean): void {
  const visual = window.visualViewport;
  if (!ios || !visual) return;
  const standalone = isStandalone();
  const tallest = { portrait: 0, landscape: 0 };
  let frame = 0;

  const sync = (): void => {
    frame = 0;
    const orientation = window.innerWidth > window.innerHeight && visual.width > visual.height ? "landscape" : "portrait";
    const height = visual.height;
    const typing = editing();
    // Sin teclado, lo visible es la altura buena. En la app de inicio se recuerda la mayor
    // (iOS puede dejarla encogida tras cerrar el teclado); en Safari manda la actual.
    if (!typing) tallest[orientation] = standalone ? Math.max(tallest[orientation], height) : height;
    const full = tallest[orientation] || height;
    const keyboard = typing && full - height > 120;
    state.height = height;
    state.full = full;
    state.keyboard = keyboard;
    state.top = keyboard ? visual.offsetTop : 0;
    root.classList.toggle("kb-open", keyboard);
    root.style.setProperty("--app-top", `${Math.round(state.top)}px`);
    root.style.setProperty("--app-h", `${Math.round(keyboard ? height : full)}px`);
    if (!keyboard) {
      const screenHeight = orientation === "portrait" ? Math.max(screen.width, screen.height) : Math.min(screen.width, screen.height);
      const missing = Math.round(screenHeight - full);
      state.band = standalone && orientation === "portrait" && missing > 4 && missing < 140 ? missing : 0;
      root.classList.toggle("dead-band", state.band > 0);
      if (window.scrollY || root.scrollTop || document.body.scrollTop) window.scrollTo(0, 0);
    }
  };
  const schedule = (): void => { if (!frame) frame = requestAnimationFrame(sync); };
  visual.addEventListener("resize", schedule);
  visual.addEventListener("scroll", schedule);
  window.addEventListener("resize", schedule);
  window.addEventListener("orientationchange", () => setTimeout(schedule, 300));
  document.addEventListener("focusin", schedule);
  // Al cerrar el teclado iOS tarda en devolver el tamaño: se vuelve a medir después y se
  // fuerza un reflujo del marco, que es lo que le hace recalcular la ventana.
  document.addEventListener("focusout", () => {
    schedule();
    setTimeout(() => {
      const app = document.querySelector<HTMLElement>(".r-app");
      if (app && !editing()) { app.style.display = "none"; void app.offsetHeight; app.style.display = ""; }
      schedule();
    }, 160);
  });
  sync();
}
