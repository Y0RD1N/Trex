import { invoke } from "@tauri-apps/api/core";
import type { AgentProvider, ApplicationIntegrations } from "./types";
import { BROWSER_INSTRUCTIONS } from "./browser";

export const DESKTOP_READ_TOOLS = ["desktop_screenshot", "desktop_status", "desktop_monitors", "desktop_wait"] as const;
export const DESKTOP_INPUT_TOOLS = ["desktop_click", "desktop_move", "desktop_drag", "desktop_scroll", "desktop_type", "desktop_key"] as const;

export const DEFAULT_INTEGRATIONS: Readonly<ApplicationIntegrations> = Object.freeze({ github: true, blender: true, hyperframes: true });
export function normalizeIntegrations(raw: unknown): ApplicationIntegrations {
  const value = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  return { github: typeof value.github === "boolean" ? value.github : true,
    blender: typeof value.blender === "boolean" ? value.blender : true,
    hyperframes: typeof value.hyperframes === "boolean" ? value.hyperframes : true };
}
/**
 * `available` holds the detected installations (absent or null when unknown).
 * `browser` means a browser really attached to this session, not the preference.
 */
export type IntegrationContext = { applications?: ApplicationIntegrations; available?: Partial<ApplicationIntegrations> | null; desktop?: boolean; browser?: boolean; a11y?: boolean };
/** `session.a11y`: la pasarela de accesibilidad realmente conectada a esta sesión, no la preferencia. */
export function integrationContext(options: { integrations?: ApplicationIntegrations; desktopEnabled?: boolean },
  session: { browser?: boolean; available?: Partial<ApplicationIntegrations> | null; a11y?: boolean } = {}): IntegrationContext {
  return { applications: normalizeIntegrations(options.integrations), available: session.available ?? null,
    desktop: options.desktopEnabled === true, browser: session.browser === true, ...(session.a11y ? { a11y: true } : {}) };
}

type Detected = Partial<ApplicationIntegrations> | null;
type Dependencies = { blender?: unknown; hyperframes?: unknown; githubCli?: unknown };
const DETECTION_TTL_MS = 10 * 60_000;
const detections = new Map<string, { at: number; settled: boolean; value: Detected; result: Promise<Detected> }>();
/**
 * Installed applications, from the same read-only file checks as Settings.
 * Cached per project folder so a session's instructions stay stable. A known
 * answer is returned synchronously (no extra startup step); otherwise a promise.
 * Failure or a slow answer yields null: the enabled applications are announced.
 */
export function detectedIntegrations(cwd: string, timeoutMs = 2_500): Detected | Promise<Detected> {
  const cached = detections.get(cwd);
  if (cached && Date.now() - cached.at < DETECTION_TTL_MS) return cached.settled ? cached.value : cached.result;
  let request: Promise<Dependencies>;
  try { request = invoke<Dependencies>("integration_dependencies", { cwd: cwd || null }); }
  catch {
    detections.set(cwd, { at: Date.now(), settled: true, value: null, result: Promise.resolve(null) });
    return null;
  }
  const entry = { at: Date.now(), settled: false, value: null as Detected, result: null as unknown as Promise<Detected> };
  entry.result = (async (): Promise<Detected> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const status = await Promise.race([request, new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), timeoutMs); })]);
      if (!status || typeof status !== "object") return null;
      return { github: status.githubCli === true, blender: status.blender === true, hyperframes: status.hyperframes === true };
    } catch { return null; } finally { if (timer !== undefined) clearTimeout(timer); }
  })().then(value => {
    entry.settled = true; entry.value = value;
    // A failed check is retried by the next session instead of being remembered.
    if (!value && detections.get(cwd) === entry) detections.delete(cwd);
    return value;
  });
  detections.set(cwd, entry);
  return entry.result;
}
/** Only restrictions are sent: an app preference never elevates a disabled CLI profile. */
export function integrationRestrictions(raw?: ApplicationIntegrations): { tools: Partial<ApplicationIntegrations> } {
  return { tools: Object.fromEntries(Object.entries(normalizeIntegrations(raw)).filter(([, enabled]) => !enabled)) };
}
export function assertIntegrationRestrictions(result: unknown, raw?: ApplicationIntegrations): void {
  const flags = normalizeIntegrations(raw), actual = (result as { applicationIntegrations?: Partial<ApplicationIntegrations> } | null)?.applicationIntegrations;
  if (Object.entries(flags).some(([key, enabled]) => !enabled && actual?.[key as keyof ApplicationIntegrations] !== false))
    throw new Error("Trex CLI no confirmó las integraciones desactivadas. Actualiza el CLI y vuelve a iniciar la sesión.");
}
/**
 * Announce only what this session can use: enabled applications that were not
 * detected as missing, the desktop when enabled, and an attached browser.
 */
/** Claude Code difiere las herramientas MCP: cargarlas de una vez ahorra una vuelta por herramienta. */
const A11Y_DEFERRED_QUERY = `select:${["list_windows", "snapshot", "find", "get", "click", "set_value", "toggle", "batch", "scroll", "scroll_to", "wait", "launch", "expand", "select"]
  .map(tool => `mcp__trex_a11y__a11y_${tool}`).join(",")}`;

export function integrationInstructions(provider: AgentProvider, context: IntegrationContext = {}): string {
  const flags = normalizeIntegrations(context.applications), available = context.available ?? {}, parts: string[] = [];
  const on = (key: keyof ApplicationIntegrations): boolean => flags[key] && available[key] !== false;
  const native = provider === "trex";
  if (on("github")) parts.push(`GitHub: use ${native ? "the advertised github_* tools" : "the installed gh CLI"} with its existing auth, never revealing credentials; name repositories and PRs explicitly, follow repository rules and verify the merge head.`);
  if (on("blender")) parts.push(`Blender: ${native ? "use the advertised blender_run tool to run" : "run"} workspace bpy scripts in a new background process${native ? "" : " with the installed Blender CLI"}, not an open window.`);
  if (on("hyperframes")) parts.push(`HyperFrames: use ${native ? "the advertised hyperframes_run tool" : "the project-local or global CLI"} to lint, snapshot or render compositions.`);
  if (parts.length) parts.push("Check real results; explain missing dependencies instead of installing them silently; never execute a mutation in read-only planning mode; inspect uncertain operations before retrying.");
  // Claude Code y Trex CLI reciben la guía de cada servidor MCP (sus instructions):
  // aquí basta con anunciarlos. Codex y Antigravity reciben la guía completa.
  // Computer use y accesibilidad son independientes: la persona elige; ninguno se
  // presenta como preferido frente al otro.
  const serverGuides = provider === "claude" || native;
  if (context.desktop) parts.push(serverGuides
    ? `Computer control: ${native ? "the advertised desktop_* tools" : "the trex_desktop MCP tools (desktop_*)"} take screenshots and send real mouse and keyboard input; start with desktop_screenshot and follow the server's guidance.`
    : "Computer control: the connected trex_desktop MCP tools take screenshots and send real mouse and keyboard input. Start with desktop_screenshot (it says how many screens there are) and verify focus before input; one screenshot covers up to 3 inputs while the screen is unchanged, capture again after changes; use region or maxEdge for cheaper captures. Never claim access when these tools are unavailable.");
  if (context.a11y) parts.push(serverGuides
    ? `Accessibility control (experimental): ${native ? "the advertised mcp_trex_a11y_* tools" : "the trex_a11y MCP tools (a11y_*)"} operate apps through the accessibility tree without the user's mouse or keyboard; follow the server's guidance.${provider === "claude" ? ` If these tools are deferred, load the ones you need in a single ToolSearch call (${A11Y_DEFERRED_QUERY}) instead of one at a time.` : ""}`
    : "Accessibility control (experimental): the connected trex_a11y MCP tools (a11y_*) operate apps through the accessibility tree without moving the user's mouse or keyboard: list windows, snapshot one app, act on a fresh @ref; each action reports what changed (new elements with refs, changed values), and a11y_scroll reaches content beyond the window. Line breaks show as ⏎. Never use the clipboard, shell commands or files as a workaround to put text into an app, and do not repeat secrets read from the screen.");
  if (context.desktop && context.a11y) parts.push("Computer control and accessibility control are separate integrations: use the one the user asks for; if they do not say, pick the one that fits the task and say which you used.");
  if (context.browser) parts.push(provider === "codex" || provider === "antigravity" ? BROWSER_INSTRUCTIONS
    : "Websites: prefer the connected Trex Browser tools, starting with browser_navigate and the app's http(s) URL; failures of other computer-use tools say nothing about this browser.");
  return parts.join(" ");
}
