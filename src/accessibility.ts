/**
 * Control por accesibilidad (experimental): los agentes manejan las apps a
 * través del árbol de accesibilidad del sistema, con agent-desktop, sin mover
 * el ratón ni escribir con el teclado de la persona. No sustituye al control de
 * computadora (`trex_desktop`, capturas y entrada real): es una integración aparte.
 *
 * Cada chat arranca su propia pasarela `trex-agent a11y-mcp` (servidor MCP
 * `trex_a11y`) con el modo fijado: observar al planificar y actuar en el resto,
 * con los permisos del agente. Los nombres deben coincidir con los de la
 * pasarela (`trex-cli/src/a11y_mcp.rs`); una prueba lo comprueba.
 */
import { formatError, trexA11yMcpConfig } from "./api";
import type { BrowserConfig, BrowserMode } from "./browser";

export const A11Y_SERVER = "trex_a11y";
export const A11Y_READ_TOOLS = ["a11y_snapshot", "a11y_find", "a11y_get", "a11y_is", "a11y_list_windows", "a11y_list_apps",
  "a11y_list_displays", "a11y_list_surfaces", "a11y_wait", "a11y_status", "a11y_skills_get"] as const;
export const A11Y_ACTION_TOOLS = ["a11y_click", "a11y_right_click", "a11y_type", "a11y_set_value", "a11y_clear", "a11y_focus",
  "a11y_select", "a11y_toggle", "a11y_check", "a11y_uncheck", "a11y_expand", "a11y_collapse", "a11y_scroll", "a11y_scroll_to",
  "a11y_press", "a11y_launch", "a11y_close_app", "a11y_focus_window", "a11y_minimize", "a11y_maximize", "a11y_restore"] as const;
/**
 * Lo que publican los dos motores (el propio de Trex, `trex-cli/src/a11y/mod.rs`,
 * es un subconjunto: nunca enfoca ventanas ni pulsa teclas). Es lo que se exige
 * al confirmar la conexión; las listas de arriba sirven para reconocer cualquier acción.
 */
export const A11Y_CORE_READ_TOOLS = ["a11y_snapshot", "a11y_find", "a11y_get", "a11y_list_windows", "a11y_wait", "a11y_status"] as const;
export const A11Y_CORE_ACTION_TOOLS = ["a11y_click", "a11y_right_click", "a11y_set_value", "a11y_type", "a11y_clear", "a11y_toggle",
  "a11y_check", "a11y_uncheck", "a11y_expand", "a11y_collapse", "a11y_select", "a11y_scroll", "a11y_scroll_to", "a11y_launch",
  "a11y_close_app", "a11y_minimize", "a11y_maximize", "a11y_restore"] as const;

/** El motor que eligió la app para esta pasarela (`--engine`), si lo indica. */
export function accessibilityEngine(config: BrowserConfig): "trex" | "agent-desktop" | null {
  const args = Array.isArray(config.args) ? config.args : [];
  const value = args[args.indexOf("--engine") + 1];
  return args.includes("--engine") && (value === "trex" || value === "agent-desktop") ? value : null;
}

/**
 * Configuración de la pasarela para este chat, o null con un aviso si no se
 * puede usar (agent-desktop ausente o antiguo, Trex CLI sin la pasarela): el
 * chat sigue sin esta integración en vez de fallar al arrancar.
 */
export async function accessibilityServer(mode: BrowserMode, warn: (text: string) => void): Promise<BrowserConfig | null> {
  try { return await trexA11yMcpConfig(mode); }
  catch (error) {
    warn(`El control por accesibilidad (experimental) no se activó en este chat: ${formatError(error)}`);
    return null;
  }
}
