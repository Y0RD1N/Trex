/**
 * HyperFrames en Ajustes → Integraciones: qué hay instalado, si falta algo para renderizar y el
 * estado de las skills que HyperFrames instala para los agentes. `trex-agent hyperframes status`
 * lo calcula; aquí solo se traduce a lo que muestra la pantalla. Trex nunca instala ni actualiza
 * HyperFrames: solo informa y, con un botón explícito, instala sus skills.
 */
export type HyperframesAction = "status" | "skillsUpdate";
export type HyperframesSkills = { location: string | null; agent: string | null; updateAvailable: boolean | null; current: number; outdated: number; missing: number; coreMissing: number };
export type HyperframesStatus = {
  found: boolean;
  guide?: string;
  path?: string;
  version?: string | null;
  latestVersion?: string | null;
  updateAvailable?: boolean | null;
  /** Comprobaciones obligatorias que fallan (FFmpeg, Node, el navegador de render…). */
  problems?: string[];
  optional?: string[];
  doctorRan?: boolean;
  skills?: HyperframesSkills | null;
};
export type HyperframesSummary = {
  tone: "loading" | "idle" | "ready" | "attention" | "missing";
  label: string;
  lines: string[];
  /** Texto del botón de skills, o null cuando no se puede (no detectado o sin proyecto). */
  skillsLabel: string | null;
  skillsLocation: string | null;
};

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
/** «FFmpeg: Not found (apt install ffmpeg)» → «FFmpeg» para la lista corta de lo que falta. */
const subject = (problem: string): string => problem.split(":")[0]?.trim() || problem;

export function describeHyperframes(status: HyperframesStatus | null, hasProject = true): HyperframesSummary {
  const none = { skillsLabel: null, skillsLocation: null };
  if (!hasProject) return { tone: "idle", label: "Sin proyecto", lines: ["Abre un proyecto para comprobar HyperFrames."], ...none };
  if (!status) return { tone: "loading", label: "Comprobando…", lines: [], ...none };
  if (!status.found) {
    return { tone: "missing", label: "No detectado", lines: ["Instala HyperFrames con «npm install -g hyperframes» y vuelve a comprobar. Trex no lo instala."], ...none };
  }
  const lines = [status.version ? `HyperFrames ${status.version}` : "HyperFrames detectado"];
  if (status.updateAvailable && status.latestVersion) lines[0] += ` · hay una versión nueva (${status.latestVersion}); la actualizas tú con «hyperframes upgrade»`;
  const problems = status.problems ?? [];
  if (problems.length) lines.push(`Falta o falla: ${problems.slice(0, 4).map(subject).join(", ")}${problems.length > 4 ? "…" : ""}. Los agentes lo verán con hyperframes_doctor.`);
  else if (status.doctorRan === false) lines.push("No se pudo ejecutar la comprobación del entorno (hyperframes doctor).");
  const extras = status.optional?.length ?? 0;
  if (extras) lines.push(`${plural(extras, "extra opcional sin instalar", "extras opcionales sin instalar")} (voz o música locales).`);
  const skills = status.skills;
  let skillsLabel = "Instalar las skills";
  if (!skills) lines.push("No se pudo comprobar el estado de las skills.");
  else {
    if (skills.coreMissing > 0) lines.push("Faltan skills principales de HyperFrames para tus agentes: sin ellas los modelos no conocen sus reglas de composición.");
    else if (skills.outdated > 0) lines.push(`${plural(skills.outdated, "skill desactualizada", "skills desactualizadas")}.`);
    else lines.push(`${plural(skills.current, "skill al día", "skills al día")}${skills.missing > 0 ? ` (${skills.missing} más disponibles bajo demanda)` : ""}.`);
    skillsLabel = skills.coreMissing > 0 || skills.current === 0 ? "Instalar las skills" : skills.outdated > 0 ? "Actualizar las skills" : "Reinstalar las skills";
  }
  return { tone: problems.length ? "attention" : "ready", label: problems.length ? "Revisar entorno" : "Listo", lines, skillsLabel, skillsLocation: skills?.location ?? null };
}
