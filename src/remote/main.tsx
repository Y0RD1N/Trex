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
import { watchViewport } from "./viewport";

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

watchViewport(ios);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<RemoteApp />);
