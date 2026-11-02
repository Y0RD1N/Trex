import { trexBrowserMcpConfig, trexBrowserMcpSession, trexBrowserStatus, trexBrowserResolveSpace } from "./api";
import { browserConfigForShell, browserMode, isBrowserHttp, type BrowserConfig, type BrowserOptions, type BrowserTransport } from "./browser";

const PREPARE_FAILED = "Trex Browser está instalado, pero no se pudo preparar su conexión con el agente. Comprueba o actualiza el componente y reinicia esta conversación; no se enviará trabajo sin conectar el navegador.";

/** Re-bind an HTTP connection to a new permission mode without restarting the agent. */
export async function rebindBrowser(connection: BrowserTransport | null, mode: string | null, planningOnly: boolean): Promise<boolean> {
  if (!isBrowserHttp(connection)) return false;
  try { await trexBrowserMcpSession(connection.cwd, browserMode(mode, planningOnly), connection.clientId, connection.profile); return true; }
  catch { return false; }
}

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
  } catch {
    if (preparing) throw new Error(PREPARE_FAILED);
    warn("Trex Browser no está disponible. Puedes revisar su instalación en Ajustes; el asistente continúa sin navegador.");
    return null;
  }
}
