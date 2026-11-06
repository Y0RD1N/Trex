/**
 * Control por accesibilidad (experimental): los agentes manejan las apps a
 * través del árbol de accesibilidad del sistema, con el motor propio de Trex,
 * sin mover el ratón ni escribir con el teclado de la persona. Es independiente
 * del control de computadora (`trex_desktop`, capturas y entrada real): la
 * persona elige cuál activar.
 *
 * Cada chat arranca su propio servidor `trex-agent a11y-mcp` (MCP `trex_a11y`)
 * con el modo fijado: observar al planificar y actuar en el resto, con los
 * permisos del agente. Los nombres deben coincidir con los del motor
 * (`trex-cli/src/a11y/mod.rs`); una prueba lo comprueba.
 */
import { formatError, trexA11yMcpConfig } from "./api";
import type { BrowserConfig, BrowserMode } from "./browser";

export const A11Y_SERVER = "trex_a11y";
export const A11Y_READ_TOOLS = ["a11y_snapshot", "a11y_find", "a11y_get", "a11y_list_windows", "a11y_wait", "a11y_status"] as const;
export const A11Y_ACTION_TOOLS = ["a11y_click", "a11y_set_value", "a11y_toggle", "a11y_expand", "a11y_select", "a11y_scroll",
  "a11y_scroll_to", "a11y_launch", "a11y_window", "a11y_batch"] as const;
/** Atajos de teclado reales: solo con el permiso de Ajustes. */
export const A11Y_KEYBOARD_TOOLS = ["a11y_press"] as const;

/** Si la pasarela lleva el permiso de atajos de teclado (`--keyboard`). */
export function accessibilityKeyboard(config: BrowserConfig): boolean {
  return Array.isArray(config.args) && config.args.includes("--keyboard");
}

/**
 * Configuración del servidor para este chat, o null con un aviso si no se puede
 * usar (otro sistema que Windows, Trex CLI antiguo): el chat sigue sin esta
 * integración en vez de fallar al arrancar.
 */
export async function accessibilityServer(mode: BrowserMode, warn: (text: string) => void): Promise<BrowserConfig | null> {
  try { return await trexA11yMcpConfig(mode); }
  catch (error) {
    warn(`El control por accesibilidad (experimental) no se activó en este chat: ${formatError(error)}`);
    return null;
  }
}
