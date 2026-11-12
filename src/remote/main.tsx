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

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<RemoteApp />);
