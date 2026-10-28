/** Trusted browser context lives outside model-supplied tool arguments. */
export type BrowserMode = "observe" | "qa" | "full";
export type BrowserOptions = { enabled: boolean; profile: string; clientId: string };
export type BrowserStatus = {
  installed: boolean; ready: boolean; compatible: boolean; version?: string; protocolVersion?: string;
  browsers?: { id: string; name: string; available: boolean }[];
  capabilities?: Record<string, boolean>;
  error?: { code: string; message: string };
};
export type BrowserConfig = { command: string; args: string[] };
export const BROWSER_INSTRUCTIONS = "Trex Browser is connected as the trex_browser MCP server. For browser work use its browser_navigate tool with the app's http(s) URL; this automatically opens the visible project browser, without the user opening it first. Start the application's dev server with normal workspace tools when necessary. Use browser_batch for ordered typed steps under the same permission; never replay a partial batch. Snapshot refs are page-scoped: retain tabId and revision. Inspect the page with browser_snapshot, screenshots, console, network and other permitted browser tools. Desktop/computer-use integrations control a different browser; their failures do not mean Trex Browser is unavailable. Report Trex Browser errors accurately and respect its bound permissions and manual-review requirements.";
export type BrowserResult = {
  content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[];
  structuredContent?: Record<string, unknown>; isError: boolean;
};
export type BrowserCall = {
  name: string; arguments: Record<string, unknown>; cwd: string; mode: BrowserMode; clientId: string;
  profile?: string; operationId?: string; timeoutMs?: number;
};
export type BrowserSpace = { clientId: string; profile: string; label: string; active?: boolean };
export type BrowserProfile = { id: string; name: string; projectId: string; createdAt: string };
export type BrowserArtifact = {
  id: string; sha256: string; mimeType: string; sizeBytes: number; width?: number; height?: number;
  kind: string; storage: "local" | "broker"; provenance: unknown;
};
export const OBSERVE_BROWSER_TOOLS = new Set([
  "browser_batch", "browser_navigate", "browser_navigate_back", "browser_reload", "browser_tabs", "browser_frames",
  "browser_snapshot", "browser_console_messages", "browser_network_requests", "browser_network_body",
  "browser_take_screenshot", "browser_wait_for", "browser_artifact", "browser_status", "browser_cancel",
]);
export function browserMode(mode: string | null | undefined, planningOnly = false): BrowserMode {
  if (planningOnly || mode === "plan" || mode === "read-only") return "observe";
  return mode === "full" || mode === "bypassPermissions" ? "full" : "qa";
}
export const validBrowserProfile = (value: string): boolean => /^BROWSER[1-9][0-9]?$/.test(value) && value.trim() === value;
export function browserOptions(settings: { browserEnabled: boolean; browserProfile: string }, clientId: string): BrowserOptions {
  return { enabled: settings.browserEnabled, profile: validBrowserProfile(settings.browserProfile) ? settings.browserProfile : "BROWSER1", clientId };
}
export function browserConfigForShell(config: BrowserConfig, shell: string): BrowserConfig {
  const match = /^(?:\\\\\?\\)?([a-z]):[\\/](.*)$/i.exec(config.command);
  return shell === "wsl" && match ? { ...config, command: `/mnt/${match[1].toLowerCase()}/${match[2].replace(/\\/g, "/")}` } : config;
}
export function browserArtifacts(value: unknown): BrowserArtifact[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 32).flatMap(raw => {
    if (!raw || typeof raw !== "object") return [];
    const item = raw as Record<string, unknown>, id = item.id ?? item.artifactId, size = item.sizeBytes ?? item.bytes;
    if (typeof id !== "string" || !/^[a-zA-Z0-9_:.\-]{1,256}$/.test(id) || id.includes("..")
      || typeof item.sha256 !== "string" || (item.sha256 !== "" && !/^[a-f0-9]{64}$/i.test(item.sha256))
      || typeof item.mimeType !== "string" || item.mimeType.length > 128
      || !/^[A-Za-z0-9!#$&^_.+\-]+\/[A-Za-z0-9!#$&^_.+\-]+$/.test(item.mimeType) || item.mimeType.trim() !== item.mimeType
      || typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) return [];
    return [{ id, sha256: item.sha256, mimeType: item.mimeType, sizeBytes: size,
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

export function brokerArtifactId(artifact: BrowserArtifact): string | null {
  const provenance = artifact.provenance && typeof artifact.provenance === "object" ? artifact.provenance as Record<string, unknown> : null;
  const id = provenance?.brokerArtifactId ?? (artifact.storage === "broker" ? artifact.id : null);
  return typeof id === "string" && /^[a-zA-Z0-9_:.\-]{1,256}$/.test(id) && !id.includes("..") ? id : null;
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
