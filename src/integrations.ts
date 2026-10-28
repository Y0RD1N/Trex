import type { AgentProvider } from "./types";

export const DESKTOP_READ_TOOLS = ["desktop_screenshot", "desktop_status", "desktop_monitors", "desktop_wait"] as const;
export const DESKTOP_INPUT_TOOLS = ["desktop_click", "desktop_move", "desktop_drag", "desktop_scroll", "desktop_type", "desktop_key"] as const;

/** Availability must be checked in the session environment; never assume a CLI is installed. */
export function integrationInstructions(provider: AgentProvider): string {
  const tools = provider === "trex"
    ? "For GitHub, Blender and HyperFrames prefer the github_*, blender_run and hyperframes_run tools when available."
    : "For GitHub, Blender and HyperFrames use the installed CLIs and their native capabilities through your permitted workspace tools.";
  const desktop = provider === "trex" ? "the advertised native desktop_* tools" : "the connected trex_desktop MCP tools";
  return `${tools} When the user requests one of these applications, check that it is installed before using it. Blender can run workspace Python scripts with its bpy API in a new background process; this is not a connection to an existing Blender window. HyperFrames can lint, snapshot and render compositions using the installed project-local or global CLI. GitHub CLI uses the user's existing authentication; never reveal credentials, and use explicit repository, PR and branch identities. For merges respect repository rules and verify the intended head. Inspect the result of an uncertain external operation before retrying. If a dependency is absent, explain how to install it rather than silently downloading it. Respect the current permission mode and workspace instructions; never execute a mutation in read-only planning mode. For requests to control Windows or the computer, prefer ${desktop}. Check desktop_status, use desktop_monitors to select a screen, then desktop_screenshot before each input and inspect the screen and focus. Desktop input requires the one-use observation from that screenshot. Use the tool schemas for move, double click, drag, scroll, typing and shortcuts. If desktop tools are absent, explain that computer control must be enabled in Trex Settings > Integrations for a new chat; do not claim it is connected. For a request to open or inspect a website with Trex Browser, prefer connected trex_browser browser_navigate with the app's http(s) URL. Desktop control, Trex Browser and application CLIs are separate capabilities; a failure in another computer-use tool does not establish that Trex Browser failed.`;
}
