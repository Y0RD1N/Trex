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

// Teclado en pantalla. iOS no encoge la página al abrirlo: la desplaza por debajo y deja
// la cabecera fuera de la vista. La app se ajusta al área visible (visualViewport) para
// que el cuadro de texto quede justo encima del teclado y nada se pueda arrastrar.
const visual = window.visualViewport;
if (visual) {
  let frame = 0;
  const sync = (): void => {
    frame = 0;
    const keyboard = window.innerHeight - visual.height > 120;
    root.classList.toggle("kb-open", keyboard);
    root.style.setProperty("--vv-h", `${Math.round(visual.height)}px`);
    root.style.setProperty("--vv-top", `${Math.round(visual.offsetTop)}px`);
    if (!keyboard && (window.scrollY || root.scrollTop)) window.scrollTo(0, 0);
  };
  const schedule = (): void => { if (!frame) frame = requestAnimationFrame(sync); };
  visual.addEventListener("resize", schedule);
  visual.addEventListener("scroll", schedule);
  sync();
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<RemoteApp />);
