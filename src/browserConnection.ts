import { browserBridgeEndSession, browserBridgeMcpSession, browserBridgeMcpStdio, browserBridgeSetMode } from "./api";
import { chromeChatLabel, chromeEnv, chromeMode, type ChromeHttp, type ChromeStdio } from "./browser";

/** La función «Tu navegador» está activa y escuchando. Lo mantiene al día la app (ver `useChromeBridge`). */
let chromeReady = false;
/**
 * Consulta inmediata, sin esperas: con la función apagada (lo normal), abrir un chat no hace
 * ninguna llamada de más ni cambia el orden de su arranque.
 */
export const chromeAvailable = (): boolean => chromeReady;
export const setChromeAvailable = (value: boolean): void => { chromeReady = value; };

/**
 * Lo que la extensión sabe del chat: su nombre, para el grupo de pestañas que le abre, y la carpeta
 * del proyecto, la única desde la que el agente puede subir archivos a una página.
 */
export type ChromeChat = { label?: string | null; cwd?: string | null };
const chatArgs = (chat: ChromeChat | undefined): [string | undefined, string | undefined] =>
  [chromeChatLabel(chat?.label), chat?.cwd?.trim() || undefined];

/**
 * Acceso de un chat al navegador de la persona, a través de la extensión de trex.
 * `null` si la función está apagada o no se puede preparar: el chat sigue sin ella y sin avisos,
 * porque es un extra opcional y nunca debe impedir que arranque una conversación.
 */
export async function connectChrome(sessionId: string, mode: string | null, planningOnly: boolean, shell: string, chat?: ChromeChat): Promise<ChromeHttp | null> {
  // Un agente dentro de WSL no alcanza el puerto local de Windows.
  if (shell === "wsl") return null;
  try {
    const session = await browserBridgeMcpSession(sessionId, chromeMode(mode, planningOnly), ...chatArgs(chat));
    return session ? { url: session.url, token: session.token } : null;
  } catch { return null; }
}

/** Igual que `connectChrome`, para los agentes que solo hablan MCP por stdio (Antigravity). */
export async function connectChromeStdio(sessionId: string, mode: string | null, planningOnly: boolean, shell: string, chat?: ChromeChat): Promise<ChromeStdio | null> {
  if (shell === "wsl") return null;
  try {
    const session = await browserBridgeMcpStdio(sessionId, chromeMode(mode, planningOnly), ...chatArgs(chat));
    return session ? { command: session.command, args: session.args, token: session.token, env: chromeEnv({ url: "", token: session.token }) } : null;
  } catch { return null; }
}

/**
 * La pestaña del chat se cerró: termina su acceso al navegador. Sus pestañas no se cierran (son de la
 * persona); la extensión deja su grupo en gris y sin dueño. Con la función apagada, no hace nada.
 */
export const endChromeSession = (sessionId: string): void => {
  if (chromeReady) void browserBridgeEndSession(sessionId).catch(() => undefined);
};

/** El modo del chat cambió: sus herramientas del navegador pasan a mirar o a manejar, sin reiniciar nada. */
export const syncChromeMode = (sessionId: string, mode: string | null, planningOnly: boolean): void => {
  void browserBridgeSetMode(sessionId, chromeMode(mode, planningOnly)).catch(() => undefined);
};
