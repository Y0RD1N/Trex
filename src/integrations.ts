import type { AgentProvider, ApplicationIntegrations } from "./types";

export const DESKTOP_READ_TOOLS = ["desktop_screenshot", "desktop_status", "desktop_monitors", "desktop_wait"] as const;
export const DESKTOP_INPUT_TOOLS = ["desktop_click", "desktop_move", "desktop_drag", "desktop_scroll", "desktop_type", "desktop_key"] as const;

export const DEFAULT_INTEGRATIONS: Readonly<ApplicationIntegrations> = Object.freeze({ github: true, blender: true, hyperframes: true });
export function normalizeIntegrations(raw: unknown): ApplicationIntegrations {
  const value = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  return { github: typeof value.github === "boolean" ? value.github : true,
    blender: typeof value.blender === "boolean" ? value.blender : true,
    hyperframes: typeof value.hyperframes === "boolean" ? value.hyperframes : true };
}
export type IntegrationContext = { applications?: ApplicationIntegrations; desktop?: boolean; browser?: boolean };
export function integrationContext(options: { integrations?: ApplicationIntegrations; desktopEnabled?: boolean; browser?: { enabled: boolean } }): IntegrationContext {
  return { applications: normalizeIntegrations(options.integrations), desktop: options.desktopEnabled === true, browser: options.browser?.enabled === true };
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
/** Announce only the capabilities selected for this session. */
export function integrationInstructions(provider: AgentProvider, context: IntegrationContext = {}): string {
  const flags = normalizeIntegrations(context.applications), parts: string[] = [];
  const native = provider === "trex";
  if (flags.github) parts.push(`For GitHub use ${native ? "advertised github_* tools" : "the installed GitHub CLI through your permitted workspace tools"}. Use the existing authentication without revealing credentials; use explicit repository and PR identities, respect repository rules and verify the intended merge head.`);
  if (flags.blender) parts.push(`For Blender use ${native ? "the advertised blender_run tool" : "the installed Blender CLI through your permitted workspace tools"}. Run workspace Python scripts with bpy in a new background process; this is not a connection to an existing window.`);
  if (flags.hyperframes) parts.push(`For HyperFrames use ${native ? "the advertised hyperframes_run tool" : "the installed project-local or global HyperFrames CLI"} to lint, snapshot or render compositions.`);
  if (parts.length) parts.push("Check installed dependencies and actual results. Explain missing dependencies instead of silently installing them. Respect the permission mode and workspace instructions; never execute a mutation in read-only planning mode. Inspect uncertain operations before retrying.");
  if (context.desktop) parts.push(`For computer control prefer ${native ? "advertised native desktop_* tools" : "connected trex_desktop MCP tools"}. Check desktop_status and desktop_monitors, then inspect a desktop_screenshot before input and verify focus. One screenshot serves up to 3 inputs while the screen is unchanged (click a field, type, press Enter); capture again after anything moves. Prefer region screenshots to read details; follow tool schemas for input. Never claim access when these tools are unavailable.`);
  if (context.browser) parts.push("For websites prefer connected Trex Browser tools, starting with browser_navigate and the app's http(s) URL. A failure in another computer-use tool does not establish that this browser failed.");
  return parts.join(" ");
}
