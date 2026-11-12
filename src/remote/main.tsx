/**
 * Entrada de la app móvil de trex (control remoto). Se sirve desde el propio
 * trex (ver `src-tauri/src/remote.rs`) y no depende de Tauri.
 */
import ReactDOM from "react-dom/client";
import "@fontsource-variable/ibm-plex-sans";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "./remote.css";
import RemoteApp from "./RemoteApp";

const root = document.documentElement;
const ios = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

if (ios) {
  // Safari amplía la página al tocar un campo y no la devuelve a su tamaño. Con
  // `maximum-scale=1` deja de hacerlo, y en iOS el pellizco para ampliar sigue funcionando.
  const viewport = document.querySelector('meta[name="viewport"]');
  const content = viewport?.getAttribute("content") ?? "";
  if (viewport && !content.includes("maximum-scale")) viewport.setAttribute("content", `${content}, maximum-scale=1`);
  root.classList.add("is-ios");
}

// Abierta desde la pantalla de inicio (sin barras de Safari).
const standalone = (navigator as Navigator & { standalone?: boolean }).standalone === true || matchMedia("(display-mode: standalone)").matches;

// Teclado en pantalla. iOS no encoge la página al abrirlo: la desplaza por debajo y deja
// la cabecera fuera de la vista. La app se ajusta al área visible (visualViewport) para
// que el cuadro de texto quede justo encima del teclado y nada se pueda arrastrar.
//
// Pantalla completa en iOS: como app de inicio con la barra de estado translúcida, WebKit
// mide la ventana como «pantalla menos barra de estado» pero pinta desde arriba del todo,
// así que un marco fijo acaba ~59 pt antes del borde y deja una franja muerta debajo (y el
// teclado puede dejarla encogida después). En ese caso el marco toma la altura real de la
// pantalla; en Safari y en Android no cambia nada.
const visual = window.visualViewport;
let frame = 0;
const sync = (): void => {
  frame = 0;
  const height = visual?.height ?? window.innerHeight;
  const keyboard = !!visual && window.innerHeight - height > 120;
  root.classList.toggle("kb-open", keyboard);
  if (visual) {
    root.style.setProperty("--vv-h", `${Math.round(height)}px`);
    root.style.setProperty("--vv-top", `${Math.round(visual.offsetTop)}px`);
  }
  const portrait = window.innerHeight >= window.innerWidth;
  const screenHeight = portrait ? Math.max(screen.width, screen.height) : Math.min(screen.width, screen.height);
  const missing = screenHeight - window.innerHeight;
  const tall = ios && standalone && !keyboard && missing > 4 && missing < 140;
  root.classList.toggle("full-h", tall);
  if (tall) root.style.setProperty("--app-h", `${screenHeight}px`);
  if (!keyboard && (window.scrollY || root.scrollTop)) window.scrollTo(0, 0);
};
const schedule = (): void => { if (!frame) frame = requestAnimationFrame(sync); };
visual?.addEventListener("resize", schedule);
visual?.addEventListener("scroll", schedule);
window.addEventListener("resize", schedule);
window.addEventListener("orientationchange", () => setTimeout(schedule, 250));
sync();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<RemoteApp />);
