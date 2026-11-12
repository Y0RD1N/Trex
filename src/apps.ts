/**
 * Control de aplicaciones: los agentes ven y manejan Blender y HyperFrames mediante un servidor MCP
 * por sesión, `trex-agent apps-mcp --apps …` (servidor `trex_apps`). Trex CLI usa los mismos
 * proveedores de forma nativa.
 *
 * El modo (observar o actuar), la carpeta del proyecto y qué aplicaciones se anuncian se fijan al
 * arrancar el servidor. Los nombres deben coincidir con los de `trex-cli/src/blender_live.rs`,
 * `hyperframes.rs` y `github.rs`; una prueba lo comprueba.
 */
import { formatError, trexAppsMcpConfig } from "./api";
import type { BrowserConfig, BrowserMode } from "./browser";
import type { ApplicationIntegrations } from "./types";

export const APPS_SERVER = "trex_apps";
export type AppId = "blender" | "hyperframes" | "github";
const ORDER: readonly AppId[] = ["blender", "hyperframes", "github"];

export const BLENDER_READ_TOOLS = ["blender_scene", "blender_view", "blender_render"] as const;
export const BLENDER_ACTION_TOOLS = ["blender_open", "blender_exec", "blender_undo"] as const;
export const HYPERFRAMES_READ_TOOLS = ["hyperframes_project", "hyperframes_docs", "hyperframes_doctor", "hyperframes_check"] as const;
export const HYPERFRAMES_ACTION_TOOLS = ["hyperframes_snapshot", "hyperframes_render", "hyperframes_preview", "hyperframes_init"] as const;
export const GITHUB_READ_TOOLS = ["github_repos", "github_prs", "github_pr_view", "github_pr_checks", "github_issues", "github_runs", "github_api"] as const;
export const GITHUB_ACTION_TOOLS = ["github_pr_create", "github_pr_merge", "github_comment"] as const;
/** Todas las de solo lectura, de las aplicaciones que haya: lo que queda al planificar. */
export const APPS_READ_TOOLS = [...BLENDER_READ_TOOLS, ...HYPERFRAMES_READ_TOOLS, ...GITHUB_READ_TOOLS] as const;
/** Las que cambian algo (abrir, ejecutar, renderizar, crear, fusionar, comentar). */
export const APPS_ACTION_TOOLS = [...BLENDER_ACTION_TOOLS, ...HYPERFRAMES_ACTION_TOOLS, ...GITHUB_ACTION_TOOLS] as const;

/** Las herramientas de solo lectura y las de acción que un servidor con estas aplicaciones ofrece. */
export function appToolsFor(apps: readonly AppId[]): { read: string[]; action: string[] } {
  const has = (app: AppId): boolean => apps.includes(app);
  return {
    read: [...(has("blender") ? BLENDER_READ_TOOLS : []), ...(has("hyperframes") ? HYPERFRAMES_READ_TOOLS : []), ...(has("github") ? GITHUB_READ_TOOLS : [])],
    action: [...(has("blender") ? BLENDER_ACTION_TOOLS : []), ...(has("hyperframes") ? HYPERFRAMES_ACTION_TOOLS : []), ...(has("github") ? GITHUB_ACTION_TOOLS : [])],
  };
}

/**
 * Qué aplicaciones debe recibir esta sesión: las activadas que no se detectaron como ausentes. Sin
 * detección (null) se asumen presentes: las herramientas explican cómo instalarlas si faltan.
 */
export function appsWanted(integrations: ApplicationIntegrations | undefined, available: Partial<ApplicationIntegrations> | null | undefined): AppId[] {
  return ORDER.filter(app => {
    const enabled = integrations && typeof integrations[app] === "boolean" ? integrations[app] : true;
    return enabled && available?.[app] !== false;
  });
}

/** Las aplicaciones con las que arrancó un servidor, leídas de sus argumentos (`--apps blender,hyperframes`). */
export function appsFromArgs(args: unknown): AppId[] {
  if (!Array.isArray(args)) return [];
  const list = args[args.indexOf("--apps") + 1];
  if (args.indexOf("--apps") < 0 || typeof list !== "string") return [];
  return ORDER.filter(app => list.split(",").includes(app));
}

const NAMES: Record<AppId, string> = { blender: "Blender", hyperframes: "HyperFrames", github: "GitHub" };

/**
 * Configuración del servidor para esta sesión, o null con un aviso si no se puede usar (Trex CLI
 * antiguo, carpeta no válida): el chat sigue sin esta integración en vez de fallar al arrancar.
 */
export async function appsServer(mode: BrowserMode, cwd: string, apps: readonly AppId[], warn: (text: string) => void): Promise<BrowserConfig | null> {
  try { return await trexAppsMcpConfig(mode, cwd, [...apps]); }
  catch (error) {
    warn(`Las aplicaciones (${apps.map(app => NAMES[app]).join(", ")}) no se activaron en este chat: ${formatError(error)}`);
    return null;
  }
}
