/**
 * Actualizaciones de Claude Code y Codex.
 *
 * La versión instalada sale de `--version` (ver `detect_claude`/`detect_codex`)
 * y la última publicada, del registro de npm, que es de donde se distribuyen
 * ambos CLI. Si hay una más nueva se ofrece instalarla con su propio comando
 * (`claude update`, `codex update`).
 */
export type CliId = "claude" | "codex";

export const CLI_NAMES: Record<CliId, string> = { claude: "Claude Code", codex: "Codex" };
const PACKAGES: Record<CliId, string> = { claude: "@anthropic-ai/claude-code", codex: "@openai/codex" };

/** Primera versión `x.y.z` (con su sufijo, si lo tiene) de un texto como `codex-cli 0.163.0`. */
export function parseVersion(text: string | null | undefined): string | null {
  return /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/.exec(text ?? "")?.[0] ?? null;
}

/** Compara dos versiones: negativo si `a` es anterior, positivo si es posterior. */
export function compareVersions(a: string, b: string): number {
  const split = (value: string) => {
    const [core, pre = ""] = value.split("-", 2);
    return { parts: core.split(".").map(Number), pre };
  };
  const left = split(a), right = split(b);
  for (let index = 0; index < 3; index++) {
    const diff = (left.parts[index] || 0) - (right.parts[index] || 0);
    if (diff) return diff;
  }
  // Una versión final es posterior a sus versiones previas (1.0.0 > 1.0.0-beta).
  if (!left.pre !== !right.pre) return left.pre ? -1 : 1;
  return left.pre.localeCompare(right.pre, undefined, { numeric: true });
}

/** La versión publicada es más nueva que la instalada. */
export function isNewer(latest: string | null, installed: string | null): boolean {
  return !!latest && !!installed && compareVersions(latest, installed) > 0;
}

/** Última versión del canal (`latest` o `stable`), según las etiquetas de npm. */
export function versionForChannel(tags: unknown, channel: string): string | null {
  if (!tags || typeof tags !== "object") return null;
  const record = tags as Record<string, unknown>;
  const value = record[channel] ?? record.latest;
  return typeof value === "string" ? parseVersion(value) : null;
}

export async function fetchLatestVersion(id: CliId, channel = "latest", signal?: AbortSignal): Promise<string | null> {
  const response = await fetch(`https://registry.npmjs.org/-/package/${PACKAGES[id]}/dist-tags`, { signal, cache: "no-store" });
  if (!response.ok) throw new Error(`npm respondió ${response.status}`);
  return versionForChannel(await response.json(), channel);
}
