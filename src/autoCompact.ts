/**
 * Resumen automático del contexto por asistente. Es una opción que la persona
 * activa en Ajustes: apagada, cada CLI conserva su propio comportamiento.
 *
 * Encendida, trex no envía `/compact`: le pasa el umbral al mecanismo propio de
 * cada asistente, que también actúa a mitad de un turno largo.
 */
import type { AgentProvider } from "./types";

export type AutoCompactProvider = "claude" | "codex" | "trex";
export type AutoCompactRule = { enabled: boolean; tokens: number };
export type AutoCompactSettings = Record<AutoCompactProvider, AutoCompactRule>;

type ProviderSpec = { id: AutoCompactProvider; name: string; tokens: number; min: number; max: number; hint: string; detail?: string };
/** Valor propuesto y límites de cada asistente (los de Claude Code son los que acepta su CLI). */
export const AUTO_COMPACT_PROVIDERS: readonly ProviderSpec[] = [
  { id: "claude", name: "Claude Code", tokens: 400_000, min: 100_000, max: 1_000_000,
    hint: "Sin esta opción, Claude Code elige el momento por su cuenta, cerca del límite del modelo.",
    // Medido con get_context_usage: con 400.000 informa una ventana de 400.000 y resume a los 367.000.
    detail: "Claude Code lo toma como tamaño de la ventana y resume unos 33.000 tokens antes, para dejar sitio al resumen." },
  { id: "codex", name: "Codex", tokens: 300_000, min: 50_000, max: 1_000_000,
    hint: "Sin esta opción, Codex resume cuando la ventana del modelo está casi llena." },
  { id: "trex", name: "Trex CLI", tokens: 128_000, min: 16_000, max: 1_000_000,
    hint: "Sin esta opción se aplica el ajuste del propio Trex CLI (128.000 tokens si no lo has cambiado)." },
];
const spec = (provider: AutoCompactProvider): ProviderSpec => AUTO_COMPACT_PROVIDERS.find(entry => entry.id === provider)!;

export const DEFAULT_AUTO_COMPACT: AutoCompactSettings = Object.freeze({
  claude: Object.freeze({ enabled: false, tokens: spec("claude").tokens }),
  codex: Object.freeze({ enabled: false, tokens: spec("codex").tokens }),
  trex: Object.freeze({ enabled: false, tokens: spec("trex").tokens }),
});

/** Umbral válido para el asistente; un valor ausente o absurdo vuelve al propuesto. */
export function autoCompactThreshold(provider: AutoCompactProvider, value: unknown): number {
  const { tokens, min, max } = spec(provider);
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.min(max, Math.max(min, Math.round(value))) : tokens;
}

/** Lo guardado nunca activa la opción por omisión: solo un `enabled: true` explícito. */
export function normalizeAutoCompact(raw: unknown): AutoCompactSettings {
  const saved = typeof raw === "object" && raw !== null ? raw as Record<string, unknown> : {};
  const rule = (provider: AutoCompactProvider): AutoCompactRule => {
    const entry = typeof saved[provider] === "object" && saved[provider] !== null ? saved[provider] as Record<string, unknown> : {};
    return { enabled: entry.enabled === true, tokens: autoCompactThreshold(provider, entry.tokens) };
  };
  return { claude: rule("claude"), codex: rule("codex"), trex: rule("trex") };
}

/** Umbral activo de un asistente, o null si la persona no lo activó (o el asistente no lo admite). */
export function autoCompactTokens(settings: AutoCompactSettings | null | undefined, provider: AgentProvider): number | null {
  if (provider === "antigravity") return null;
  const rule = settings?.[provider];
  return rule?.enabled === true ? autoCompactThreshold(provider, rule.tokens) : null;
}

/** Umbral que trex aplica a Claude Code; un `--autocompact` escrito en el perfil manda y trex no lo pisa. */
export function claudeAutoCompact(settings: AutoCompactSettings | null | undefined, profileArgs: string | null): number | null {
  return /(^|\s)--autocompact(\s|=|$)/.test(profileArgs ?? "") ? null : autoCompactTokens(settings, "claude");
}
/** Claude Code lee su ventana de resumen automático de esta variable; una versión que no la conozca la ignora. */
export function claudeAutoCompactEnv(tokens: number | null): Record<string, string> {
  return tokens === null ? {} : { CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(tokens) };
}

/** Umbral que trex aplica a Codex; el que el perfil ya pase con `-c` manda. */
export function codexAutoCompact(settings: AutoCompactSettings | null | undefined, flags: readonly string[]): number | null {
  return flags.some(flag => /^model_auto_compact_token_limit\s*=/.test(flag)) ? null : autoCompactTokens(settings, "codex");
}
/** Codex lo recibe como opción de configuración del proceso. */
export function codexAutoCompactFlags(tokens: number | null): string[] {
  return tokens === null ? [] : ["-c", `model_auto_compact_token_limit=${tokens}`];
}

/** Trex CLI: ajustes de sesión que se suman a los de su settings.json. */
export function trexAutoCompactSettings(tokens: number | null): { context?: { autoCompact: true; maxActiveTokens: number } } {
  return tokens === null ? {} : { context: { autoCompact: true, maxActiveTokens: tokens } };
}
