import { trexBrowserMcpConfig, trexBrowserStatus, trexBrowserResolveSpace } from "./api";
import { browserConfigForShell, browserMode, type BrowserConfig, type BrowserOptions } from "./browser";

export async function connectBrowser(options: BrowserOptions | undefined, cwd: string, mode: string | null, planningOnly: boolean, shell: string,
  warn: (message: string) => void): Promise<BrowserConfig | null> {
  if (!options?.enabled) return null;
  let preparing = false;
  try {
    const status = await trexBrowserStatus();
    if (!status.installed) return null;
    if (!status.ready || !status.compatible) throw new Error(status.error?.message ?? "Revisa la instalación de Trex Browser en Ajustes.");
    preparing = true;
    const binding = options.automatic ? await trexBrowserResolveSpace(cwd,options,status) : options;
    return browserConfigForShell(await trexBrowserMcpConfig(cwd, browserMode(mode, planningOnly), binding.clientId, binding.profile), shell);
  } catch {
    if (preparing) throw new Error("Trex Browser está instalado, pero no se pudo preparar su conexión con el agente. Comprueba o actualiza el componente y reinicia esta conversación; no se enviará trabajo sin conectar el navegador.");
    warn("Trex Browser no está disponible. Puedes revisar su instalación en Ajustes; el asistente continúa sin navegador.");
    return null;
  }
}
