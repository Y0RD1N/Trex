/**
 * Herramientas de los agentes que actúan fuera del chat: los modos de permiso de las pasarelas
 * (escritorio, accesibilidad, aplicaciones), la conexión con «Tu navegador» y los archivos
 * (capturas, vídeos…) que devuelven sus herramientas.
 */
/** Lo que puede hacer una pasarela según el modo del chat: mirar, actuar con permiso o actuar sin preguntar. */
export type BrowserMode = "observe" | "qa" | "full";
/** Una pasarela por stdio: el ejecutable de trex y sus argumentos. */
export type BrowserConfig = { command: string; args: string[] };
/** Metadatos de un archivo que devolvió una herramienta. `sha256` y `sizeBytes` faltan en los ligeros que reciben los agentes. */
export type BrowserArtifact = {
  id: string; sha256?: string; mimeType: string; sizeBytes?: number; width?: number; height?: number;
  kind: string; storage: "local" | "broker"; provenance: unknown;
};
// --- «Tu navegador»: la extensión de trex en el navegador de la persona -------------
/** Nombre del servidor MCP que ve el agente (sus herramientas son `mcp__trex_chrome__…`). */
export const CHROME_SERVER = "trex_chrome";
/** Su token viaja en el entorno del agente, nunca en la línea de comandos. */
export const CHROME_TOKEN_ENV = "TREX_CHROME_TOKEN";
/** Trex CLI recibe también la dirección del puente en su entorno (ver `trexCliChromeEnv`). */
export const CHROME_URL_ENV = "TREX_CHROME_URL";
export type ChromeMode = "observe" | "full";
export type ChromeHttp = { url: string; token: string };
/** Las herramientas que solo miran. Debe coincidir con OBSERVE_TOOLS de src-tauri/src/browser_bridge.rs. */
export const CHROME_READ_TOOLS = ["tabs_list", "read_page", "screenshot", "wait_for"] as const;
/** Planificar o solo lectura: mirar. En cualquier otro modo, las acciones pasan por los permisos del propio agente. */
export const chromeMode = (mode: string | null | undefined, planningOnly = false): ChromeMode =>
  browserMode(mode, planningOnly) === "observe" ? "observe" : "full";
/** Para los agentes sin MCP por HTTP: el adaptador stdio de trex y el token que debe ir en su entorno. */
export type ChromeStdio = { command: string; args: string[]; token: string; env: Record<string, string> };
export const chromeEnv = (value: ChromeHttp | null | undefined): Record<string, string> => value ? { [CHROME_TOKEN_ENV]: value.token } : {};
/** Trex CLI habla MCP por HTTP él mismo: recibe la dirección y el token en su entorno, nunca en un mensaje. */
export const trexCliChromeEnv = (value: ChromeHttp | null | undefined): Record<string, string> =>
  value ? { [CHROME_URL_ENV]: value.url, [CHROME_TOKEN_ENV]: value.token } : {};
export const claudeChromeServer = (value: ChromeHttp): Record<string, unknown> =>
  ({ type: "http", url: value.url, headers: { Authorization: `Bearer \${${CHROME_TOKEN_ENV}}` } });
/**
 * Nombre del chat para el grupo de pestañas que la extensión le abre: sin caracteres de control
 * y como mucho 100 bytes en UTF-8 (sin partir un carácter). `undefined` si no queda nada.
 */
export function chromeChatLabel(value: string | null | undefined): string | undefined {
  let result = "", bytes = 0;
  const encoder = new TextEncoder();
  for (const char of (value ?? "").replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim()) {
    const size = encoder.encode(char).length;
    if (bytes + size > 100) break;
    result += char; bytes += size;
  }
  return result.trim() || undefined;
}
export function browserMode(mode: string | null | undefined, planningOnly = false): BrowserMode {
  if (planningOnly || mode === "plan" || mode === "read-only") return "observe";
  return mode === "full" || mode === "bypassPermissions" ? "full" : "qa";
}
/** Un agente dentro de WSL lanza el ejecutable de Windows por su ruta de /mnt. */
export function browserConfigForShell(config: BrowserConfig, shell: string): BrowserConfig {
  const match = /^(?:\\\\\?\\)?([a-z]):[\\/](.*)$/i.exec(config.command);
  return shell === "wsl" && match ? { ...config, command: `/mnt/${match[1].toLowerCase()}/${match[2].replace(/\\/g, "/")}` } : config;
}
export function browserArtifacts(value: unknown): BrowserArtifact[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 32).flatMap(raw => {
    if (!raw || typeof raw !== "object") return [];
    const item = raw as Record<string, unknown>, id = item.id ?? item.artifactId, size = item.sizeBytes ?? item.bytes;
    // Lean artifacts carry neither checksum nor size: absent is fine, present-but-malformed drops the entry.
    if (typeof id !== "string" || !/^[a-zA-Z0-9_:.\-]{1,256}$/.test(id) || id.includes("..")
      || (item.sha256 !== undefined && (typeof item.sha256 !== "string" || (item.sha256 !== "" && !/^[a-f0-9]{64}$/i.test(item.sha256))))
      || typeof item.mimeType !== "string" || item.mimeType.length > 128
      || !/^[A-Za-z0-9!#$&^_.+\-]+\/[A-Za-z0-9!#$&^_.+\-]+$/.test(item.mimeType) || item.mimeType.trim() !== item.mimeType
      || (size !== undefined && (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0))) return [];
    return [{ id, ...(typeof item.sha256 === "string" ? { sha256: item.sha256 } : {}), mimeType: item.mimeType,
      ...(typeof size === "number" ? { sizeBytes: size } : {}),
      ...(typeof item.width === "number" && Number.isSafeInteger(item.width) && item.width > 0 ? { width: item.width } : {}),
      ...(typeof item.height === "number" && Number.isSafeInteger(item.height) && item.height > 0 ? { height: item.height } : {}),
      kind: typeof item.kind === "string" ? item.kind : "artifact",
      storage: item.storage === "local" ? "local" : "broker", provenance: item.provenance ?? { projectId: item.projectId, profile: item.profile } }];
  });
}

/** Read metadata only; MCP image bytes never enter the rendered transcript. */
export function browserResultArtifacts(raw: unknown): BrowserArtifact[] {
  if (typeof raw === "string") {
    if (raw.length > 262144) return [];
    try { return browserResultArtifacts(JSON.parse(raw)); } catch { return []; }
  }
  if (!raw || typeof raw !== "object") return [];
  const result = raw as Record<string, unknown>;
  const direct = browserArtifacts(result.artifacts);
  if (direct.length) return direct;
  const structured = result.structuredContent as Record<string, unknown> | undefined;
  if (structured) { const refs = browserArtifacts(structured.artifacts); if (refs.length) return refs; }
  if (typeof result.content === "string") return browserResultArtifacts(result.content);
  const content = Array.isArray(result.content) ? result.content : [];
  for (const block of content.slice(0, 32)) {
    if (block?.type !== "text" || typeof block.text !== "string" || block.text.length > 262144) continue;
    try { const parsed = JSON.parse(block.text); const refs = browserArtifacts(parsed?.artifacts ?? parsed?.structuredContent?.artifacts); if (refs.length) return refs; } catch { /* Ordinary browser text. */ }
  }
  return [];
}

/** Serialized MCP image envelopes are projected to metadata and text only. */
export function browserToolResultText(raw: unknown): string {
  let value = raw;
  if (typeof value === "string" && value.length > 8 * 1024 * 1024) return "[Resultado del navegador omitido por tamaño]";
  if (typeof value === "string" && value.length <= 8 * 1024 * 1024) {
    const original = value;
    try { value = JSON.parse(value); } catch { return original; }
  }
  const scrub = (item: unknown, depth: number): unknown => {
    if (depth > 16 || (typeof item === "string" && item.length > 8 * 1024 * 1024)) return "[Contenido omitido]";
    if (typeof item === "string" && /^[\s]*[\[{]/.test(item) && item.length <= 8 * 1024 * 1024) {
      try { return scrub(JSON.parse(item), depth + 1); } catch { return item; }
    }
    if (!item || typeof item !== "object") return item;
    if (Array.isArray(item)) return item.slice(0, 128).map(entry => scrub(entry, depth + 1));
    const obj = item as Record<string, unknown>;
    if (obj.type === "image" || (obj.type === "base64" && typeof obj.data === "string") || (typeof obj.mimeType === "string" && obj.mimeType.startsWith("image/") && typeof obj.data === "string")) {
      return { type: "image", mimeType: obj.mimeType ?? "image/*", text: "[Imagen de herramienta]" };
    }
    return Object.fromEntries(Object.entries(obj).map(([key, entry]) => [key, scrub(entry, depth + 1)]));
  };
  if (typeof value === "string") return value;
  return JSON.stringify(scrub(value, 0)) ?? "";
}
