import { browserBridgeMcpSession, browserBridgeMcpStdio, browserBridgeSetMode, trexBrowserMcpConfig, trexBrowserMcpSession, trexBrowserStatus, trexBrowserResolveSpace } from "./api";
import { browserConfigForShell, browserMode, chromeEnv, chromeMode, isBrowserHttp, type BrowserConfig, type BrowserOptions, type BrowserTransport, type ChromeHttp, type ChromeStdio } from "./browser";

const PREPARE_FAILED = "Trex Browser está instalado, pero no se pudo preparar su conexión con el agente. Comprueba o actualiza el componente y reinicia esta conversación; no se enviará trabajo sin conectar el navegador.";

/** Re-bind an HTTP connection to a new permission mode without restarting the agent. */
export async function rebindBrowser(connection: BrowserTransport | null, mode: string | null, planningOnly: boolean): Promise<boolean> {
  if (!isBrowserHttp(connection)) return false;
  try { await trexBrowserMcpSession(connection.cwd, browserMode(mode, planningOnly), connection.clientId, connection.profile); return true; }
  catch { return false; }
}

/** La función «Tu navegador» está activa y escuchando. Lo mantiene al día la app (ver `useChromeBridge`). */
let chromeReady = false;
/**
 * Consulta inmediata, sin esperas: con la función apagada (lo normal), abrir un chat no hace
 * ninguna llamada de más ni cambia el orden de su arranque.
 */
export const chromeAvailable = (): boolean => chromeReady;
export const setChromeAvailable = (value: boolean): void => { chromeReady = value; };

/**
 * Acceso de un chat al navegador de la persona, a través de la extensión de trex.
 * `null` si la función está apagada o no se puede preparar: el chat sigue sin ella y sin avisos,
 * porque es un extra opcional y nunca debe impedir que arranque una conversación.
 */
export async function connectChrome(sessionId: string, mode: string | null, planningOnly: boolean, shell: string): Promise<ChromeHttp | null> {
  // Un agente dentro de WSL no alcanza el puerto local de Windows.
  if (shell === "wsl") return null;
  try {
    const session = await browserBridgeMcpSession(sessionId, chromeMode(mode, planningOnly));
    return session ? { url: session.url, token: session.token } : null;
  } catch { return null; }
}

/** Igual que `connectChrome`, para los agentes que solo hablan MCP por stdio (Antigravity, Trex CLI). */
export async function connectChromeStdio(sessionId: string, mode: string | null, planningOnly: boolean, shell: string): Promise<ChromeStdio | null> {
  if (shell === "wsl") return null;
  try {
    const session = await browserBridgeMcpStdio(sessionId, chromeMode(mode, planningOnly));
    return session ? { command: session.command, args: session.args, token: session.token, env: chromeEnv({ url: "", token: session.token }) } : null;
  } catch { return null; }
}

/** El modo del chat cambió: sus herramientas del navegador pasan a mirar o a manejar, sin reiniciar nada. */
export const syncChromeMode = (sessionId: string, mode: string | null, planningOnly: boolean): void => {
  void browserBridgeSetMode(sessionId, chromeMode(mode, planningOnly)).catch(() => undefined);
};

/** Connect an agent to Trex Browser. With `allowHttp`, agents that support
 * MCP over HTTP get one broker endpoint (no process per agent); otherwise, and
 * as a fallback, the stdio adapter. */
export async function connectBrowser(options: BrowserOptions | undefined, cwd: string, mode: string | null, planningOnly: boolean, shell: string,
  warn: (message: string) => void): Promise<BrowserConfig | null>;
export async function connectBrowser(options: BrowserOptions | undefined, cwd: string, mode: string | null, planningOnly: boolean, shell: string,
  warn: (message: string) => void, allowHttp: boolean): Promise<BrowserTransport | null>;
export async function connectBrowser(options: BrowserOptions | undefined, cwd: string, mode: string | null, planningOnly: boolean, shell: string,
  warn: (message: string) => void, allowHttp = false): Promise<BrowserTransport | null> {
  if (!options?.enabled) return null;
  let preparing = false;
  try {
    const status = await trexBrowserStatus();
    if (!status.installed) return null;
    if (!status.ready || !status.compatible) throw new Error(status.error?.message ?? "Revisa la instalación de Trex Browser en Ajustes.");
    preparing = true;
    const binding = options.automatic ? await trexBrowserResolveSpace(cwd,options,status) : options;
    const bound = browserMode(mode, planningOnly);
    // WSL agents cannot reach the Windows loopback broker, so they keep stdio.
    if (allowHttp && shell !== "wsl" && status.capabilities?.mcpHttp) {
      try {
        const session = await trexBrowserMcpSession(cwd, bound, binding.clientId, binding.profile);
        return { kind: "http", url: session.url, token: session.token, cwd, clientId: binding.clientId, profile: binding.profile };
      } catch { /* fall back to the stdio adapter below */ }
    }
    return browserConfigForShell(await trexBrowserMcpConfig(cwd, bound, binding.clientId, binding.profile), shell);
  } catch (error) {
    // Only the native bridge's own sentence (a string, never a JS error) names the cause, e.g. no free spaces left.
    if (preparing) throw new Error(typeof error === "string" && error.trim() ? `${PREPARE_FAILED} Motivo: ${error.trim()}` : PREPARE_FAILED);
    warn("Trex Browser no está disponible. Puedes revisar su instalación en Ajustes; el asistente continúa sin navegador.");
    return null;
  }
}
