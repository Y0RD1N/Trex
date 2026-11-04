/**
 * Sugerencias de modelo y esfuerzo por función del equipo. Es una heurística
 * sobre los identificadores y nombres del catálogo de cada perfil (no hay
 * precios en el catálogo): solo rellena valores que el usuario no eligió.
 * Un principal fuerte con subagentes medios o económicos y poco esfuerzo para
 * tareas acotadas rinde mejor que un único modelo grande para todo.
 */
import { workflowEffortLevels } from "./agentWorkflow";
import type { TeamRole } from "./agentTeam";
import type { ModelInfo } from "./chatState";

export type ModelTier = "cheap" | "mid" | "strong";
const CHEAP = new Set(["haiku", "mini", "flash", "lite", "nano", "small", "fast", "tiny", "micro", "instant"]);
const STRONG = new Set(["opus", "pro", "max", "ultra", "fable", "large", "xl", "xlarge", "o1", "o3", "heavy", "reasoner"]);

/** Gama de un modelo por sus palabras: lo económico gana a lo potente («o4-mini», «codex-mini»). */
export function modelTier(id: string, name = ""): ModelTier {
  const words = `${id} ${name}`.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (words.some(word => CHEAP.has(word))) return "cheap";
  if (words.some(word => STRONG.has(word))) return "strong";
  return "mid";
}

/** «profile»: el modelo del perfil (o el recomendado por el asistente, si el catálogo lo ofrece). */
type Target = "cheap" | "mid" | "strong" | "profile";
export const ROLE_SUGGESTIONS: Record<TeamRole, { model: Target | null; effort: string | null }> = {
  coordinator: { model: "strong", effort: "high" },
  implementation: { model: "profile", effort: "medium" },
  review: { model: "mid", effort: "medium" },
  fix: { model: "mid", effort: "medium" },
  validation: { model: "mid", effort: "low" },
  research: { model: "cheap", effort: "low" },
  custom: { model: null, effort: null },
};

const EFFORT_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
/** El nivel admitido más cercano al deseado (a igual distancia, el menor). */
export function closestEffort(levels: string[], target: string | null): string | null {
  if (!target || !levels.length) return null;
  if (levels.includes(target)) return target;
  const goal = EFFORT_ORDER.indexOf(target);
  if (goal < 0) return null;
  const known = levels.filter(level => EFFORT_ORDER.includes(level) && level !== "none");
  known.sort((a, b) => Math.abs(EFFORT_ORDER.indexOf(a) - goal) - Math.abs(EFFORT_ORDER.indexOf(b) - goal)
    || EFFORT_ORDER.indexOf(a) - EFFORT_ORDER.indexOf(b));
  return known[0] ?? null;
}

/** Modelo sugerido para la función; "" conserva el predeterminado del perfil. */
export function suggestModel(models: ModelInfo[], role: TeamRole): string {
  const target = ROLE_SUGGESTIONS[role].model;
  if (!target) return "";
  if (target === "profile") return models.some(model => model.value === "default" && model.efforts.length) ? "default" : "";
  // Solo modelos destacados: los catálogos de API largos no se recorren a ciegas.
  const pool = models.filter(model => model.featured && model.value !== "default");
  const pick = (tier: ModelTier): string | undefined => pool.find(model => modelTier(model.value, model.displayName) === tier)?.value;
  if (target === "cheap") return pick("cheap") ?? pick("mid") ?? "";
  if (target === "strong") return pick("strong") ?? pick("mid") ?? "";
  return pick("mid") ?? "";
}

/** Esfuerzo sugerido entre los que admite ese modelo; null si no se puede elegir. */
export function suggestEffort(models: ModelInfo[], model: string | null, role: TeamRole): string | null {
  return closestEffort(workflowEffortLevels(models, model || null), ROLE_SUGGESTIONS[role].effort);
}
