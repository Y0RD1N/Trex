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
export type IntegrationContext = { applications?: ApplicationIntegrations; available?: Partial<ApplicationIntegrations> | null; desktop?: boolean; browser?: boolean };
export function integrationContext(options: { integrations?: ApplicationIntegrations; desktopEnabled?: boolean },
  session: { browser?: boolean; available?: Partial<ApplicationIntegrations> | null } = {}): IntegrationContext {
  return { applications: normalizeIntegrations(options.integrations), available: session.available ?? null,
    desktop: options.desktopEnabled === true, browser: session.browser === true };
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
export function integrationInstructions(provider: AgentProvider, context: IntegrationContext = {}): string {
  const flags = normalizeIntegrations(context.applications), available = context.available ?? {}, parts: string[] = [];
  const on = (key: keyof ApplicationIntegrations): boolean => flags[key] && available[key] !== false;
  const native = provider === "trex";
  if (on("github")) parts.push(`GitHub: use ${native ? "the advertised github_* tools" : "the installed gh CLI"} with its existing auth, never revealing credentials; name repositories and PRs explicitly, follow repository rules and verify the merge head.`);
  if (on("blender")) parts.push(`Blender: ${native ? "use the advertised blender_run tool to run" : "run"} workspace bpy scripts in a new background process${native ? "" : " with the installed Blender CLI"}, not an open window.`);
  if (on("hyperframes")) parts.push(`HyperFrames: use ${native ? "the advertised hyperframes_run tool" : "the project-local or global CLI"} to lint, snapshot or render compositions.`);
  if (parts.length) parts.push("Check real results; explain missing dependencies instead of installing them silently; never execute a mutation in read-only planning mode; inspect uncertain operations before retrying.");
  if (context.desktop) parts.push(`Computer control: prefer ${native ? "advertised desktop_* tools" : "connected trex_desktop MCP tools"}. Check desktop_status and desktop_monitors, inspect a desktop_screenshot before input and verify focus; one screenshot covers up to 3 inputs while the screen is unchanged, capture again after changes, prefer region screenshots for details. Never claim access when these tools are unavailable.`);
  if (context.browser) parts.push(provider === "codex" || provider === "antigravity" ? BROWSER_INSTRUCTIONS
    : "Websites: prefer the connected Trex Browser tools, starting with browser_navigate and the app's http(s) URL; failures of other computer-use tools say nothing about this browser.");
  return parts.join(" ");
}
