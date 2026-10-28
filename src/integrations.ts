import type { AgentProvider } from "./types";

export const DESKTOP_READ_TOOLS = ["desktop_screenshot", "desktop_status", "desktop_monitors", "desktop_wait"] as const;
export const DESKTOP_INPUT_TOOLS = ["desktop_click", "desktop_move", "desktop_drag", "desktop_scroll", "desktop_type", "desktop_key"] as const;

/** Availability must be checked in the session environment; never assume a CLI is installed. */
export function integrationInstructions(provider: AgentProvider): string {
  const tools = provider === "trex"
    ? "For GitHub, Blender and HyperFrames prefer the github_*, blender_run and hyperframes_run tools when available."
    : "For GitHub, Blender and HyperFrames use the installed CLIs and their native capabilities through your permitted workspace tools.";
  return `${tools} When the user requests one of these applications, check that it is installed before using it. Blender can run workspace Python scripts with its bpy API in a new background process; this is not a connection to an existing Blender window. HyperFrames can lint, snapshot and render compositions using the installed project-local or global CLI. GitHub CLI uses the user's existing authentication; never reveal credentials, and use explicit repository, PR and branch identities. For merges respect repository rules and verify the intended head. Inspect the result of an uncertain external operation before retrying. If a dependency is absent, explain how to install it rather than silently downloading it. Respect the current permission mode and workspace instructions; never execute a mutation in read-only planning mode. ${provider === "trex" ? "If desktop tools are enabled, use desktop_screenshot before each input and inspect the screen and focus. Desktop tools are separate from the application CLIs." : "If the trex_desktop MCP server is connected, use desktop_screenshot before each input and inspect screen and focus. Desktop tools are separate from the application CLIs."}`;
}
