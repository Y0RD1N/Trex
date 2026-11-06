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
import { IS_WINDOWS } from "./platform";

// Windows 11 redondea la ventana sin bordes y le pone su borde y su sombra: el
// CSS no repite el marco (ver `--window-radius` en tokens.css). Antes del primer
// pintado, para que tampoco la pantalla de carga muestre esquinas de más.
if (IS_WINDOWS) document.documentElement.dataset.platform = "windows";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<App />);
