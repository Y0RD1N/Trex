/**
 * Punto de entrada del frontend de trex.
 *
 * Las tipografías (Inter para la interfaz, JetBrains Mono para el terminal y
 * los textos monoespaciados) se importan antes que el CSS para que los tokens
 * de `styles.css` encuentren las familias cargadas.
 *
 * Sin StrictMode a propósito: en desarrollo React monta los efectos dos veces
 * y eso volvería a crear los terminales xterm y a lanzar procesos PTY
 * duplicados.
 */
import ReactDOM from "react-dom/client";
import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";
import App from "./App";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<App />);
