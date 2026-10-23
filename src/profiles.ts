import type { AgentProvider, LauncherProfile, PersistedTab, SessionLaunch, Settings, TabKind } from "./types";

export const PROVIDER_NAMES: Record<AgentProvider, string> = { claude: "Claude Code", codex: "Codex", trex: "Trex CLI" };

/** Literal fragments work with the native argument parser on Windows and Unix. */
export function trexProfileArgs(name: string): string {
  return `--profile ${name.split("'").map(part => `'${part}'`).join(`"'"`)}`;
}

export function trexProfileName(profile: Pick<LauncherProfile, "args" | "name">): string {
  const tokens: string[] = [];
  let token = "", quote = "", started = false;
  for (const char of profile.args) {
    if (quote) { if (char === quote) quote = ""; else token += char; }
    else if (char === "'" || char === '"') { quote = char; started = true; }
    else if (/\s/.test(char)) { if (started) { tokens.push(token); token = ""; started = false; } }
    else { token += char; started = true; }
  }
  if (quote) return profile.name;
  if (started) tokens.push(token);
  for (let index = 0; index < tokens.length; index++) {
    if (tokens[index] === "--profile" && tokens[index + 1]) return tokens[index + 1];
    if (tokens[index].startsWith("--profile=")) return tokens[index].slice(10) || profile.name;
  }
  return profile.name;
}

export function initialProfiles(settings: Pick<Settings, "claudeCommand" | "claudeArgs" | "launchMode">): LauncherProfile[] {
  return [
    { id: "claude-default", name: "Claude Code", provider: "claude", command: settings.claudeCommand.trim() || "claude", args: settings.claudeArgs, shell: "", launchMode: settings.launchMode === "inject" ? "inject" : "arg", configDir: "" },
    { id: "codex-default", name: "Codex", provider: "codex", command: "codex", args: "", shell: "", launchMode: "arg", configDir: "" },
  ];
}

/** Solo las instalaciones antiguas sin perfiles se migran al comando de Claude anterior. */
export function normalizeProfiles(raw: unknown, legacy: Pick<Settings, "claudeCommand" | "claudeArgs" | "launchMode">): LauncherProfile[] {
  if (!Array.isArray(raw) || raw.length === 0) return initialProfiles(legacy);
  const ids = new Set<string>();
  const profiles: LauncherProfile[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const rec = entry as Record<string, unknown>;
    if (typeof rec.id !== "string" || !rec.id.trim() || ids.has(rec.id)) continue;
    if (rec.provider !== "claude" && rec.provider !== "codex" && rec.provider !== "trex") continue;
    ids.add(rec.id);
    const str = (key: string, fallback = ""): string => typeof rec[key] === "string" ? rec[key] as string : fallback;
    profiles.push({ id: rec.id, provider: rec.provider, name: str("name", PROVIDER_NAMES[rec.provider]).trim() || PROVIDER_NAMES[rec.provider],
      command: str("command", rec.provider === "trex" ? "trex-agent" : rec.provider).trim() || (rec.provider === "trex" ? "trex-agent" : rec.provider), args: str("args"), shell: str("shell"),
      launchMode: rec.launchMode === "inject" ? "inject" : "arg", configDir: str("configDir").trim() });
  }
  return profiles.length ? profiles : initialProfiles(legacy);
}

export function defaultProfile(settings: Settings): LauncherProfile {
  return settings.profiles.find(profile => profile.id === settings.defaultProfileId) ?? settings.profiles[0];
}

/** La elección opcional del instalador nunca elimina la configuración de una cuenta. */
export function profilesForInstallation(settings: Settings, trexInstalled: boolean): LauncherProfile[] {
  const profiles = settings.profiles.filter(profile => trexInstalled || profile.provider !== "trex");
  return profiles.length ? profiles : initialProfiles(settings);
}

export function launchForProfile(settings: Settings, profile: LauncherProfile | null): SessionLaunch {
  return {
    profileId: profile?.id ?? null,
    profileName: profile?.name ?? null,
    command: profile?.command.trim() || null,
    args: profile?.args.trim() || null,
    shell: profile?.shell || settings.shell,
    launchMode: profile?.launchMode ?? "arg",
    env: profile?.configDir.trim() ? { [profile.provider === "trex" ? "TREX_HOME" : profile.provider === "codex" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR"]: profile.configDir.trim() } : null,
  };
}

/** Conserva el comando original incluso si después se renombra o elimina su perfil. */
export function restoreLaunch(tab: PersistedTab, settings: Settings): SessionLaunch {
  if (tab.launch) return tab.launch;
  if (tab.kind === "shell") return launchForProfile(settings, null);
  if (tab.kind === "claude" && !settings.autoRunClaude) return launchForProfile(settings, null);
  const profile = settings.profiles.find(item => item.provider === tab.kind);
  // Las pestañas antiguas de Claude conservan los ajustes antiguos, aunque el predeterminado sea Codex.
  if (tab.kind === "claude") return launchForProfile(settings, { ...initialProfiles(settings)[0], id: profile?.id ?? "claude-default" });
  if (tab.kind === "trex") return launchForProfile(settings, profile ?? { id: "trex-default", name: "TREX1", provider: "trex", command: "trex-agent", args: "--profile TREX1", shell: "", launchMode: "arg", configDir: "" });
  return launchForProfile(settings, profile ?? initialProfiles(settings)[1]);
}

export function normalizeLaunch(raw: unknown, kind: TabKind): SessionLaunch | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const rec = raw as Record<string, unknown>;
  if (typeof rec.shell !== "string") return undefined;
  // Nunca sustituir silenciosamente un lanzador persistido por el de otra cuenta.
  if (kind !== "shell" && (typeof rec.command !== "string" || !rec.command.trim())) return undefined;
  const nullable = (key: string): string | null => typeof rec[key] === "string" ? rec[key] as string : null;
  const env: Record<string, string> = {};
  if (rec.env && typeof rec.env === "object") for (const [key, value] of Object.entries(rec.env)) {
    if (typeof value === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) env[key] = value;
  }
  return { profileId: nullable("profileId"), profileName: nullable("profileName"), command: kind === "shell" ? null : nullable("command"), args: nullable("args"),
    shell: rec.shell, launchMode: rec.launchMode === "inject" ? "inject" : "arg", env: Object.keys(env).length ? env : null };
}

export function profilesError(profiles: LauncherProfile[]): string | null {
  if (!profiles.length) return "Añade al menos un perfil.";
  for (const profile of profiles) {
    if (!profile.name.trim()) return "Todos los perfiles necesitan un nombre.";
    if (!profile.command.trim()) return `Escribe el comando de «${profile.name}».`;
    if (/[\r\n\0]/.test(profile.command + profile.args + profile.configDir)) return `Revisa los campos de «${profile.name}»: deben ocupar una sola línea.`;
    if (profile.configDir.trim() && !/^(\/|~[\\/]|[A-Za-z]:[\\/]|\\\\)/.test(profile.configDir.trim())) return `La carpeta de «${profile.name}» debe ser una ruta completa o empezar por ~/.`;
  }
  const names = profiles.map(profile => profile.name.trim().toLocaleLowerCase());
  return new Set(names).size === names.length ? null : "Usa nombres distintos para reconocer cada perfil.";
}
