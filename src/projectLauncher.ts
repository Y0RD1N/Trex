/**
 * Lanzador de proyectos: une los proyectos de trex con las subcarpetas de las
 * carpetas raíz elegidas en Ajustes y las ordena para buscarlas escribiendo.
 * Sin dependencias de Tauri: se prueba en `scripts/project-launcher.test.mjs`.
 */
import type { Project } from "./types";

export type ProjectLauncherSettings = {
  /** Carpetas cuyas subcarpetas directas se ofrecen como proyectos. */
  roots: string[];
  /** Perfil con el que se abre el chat; vacío = el perfil predeterminado. */
  profileId: string;
  /** Si el proyecto ya tiene un chat de ese agente, se vuelve a él en vez de abrir otro. */
  reuseChat: boolean;
};

/** Subcarpeta de una carpeta raíz, tal como la devuelve `list_project_folders`. */
export type ProjectFolder = { name: string; path: string; root: string; git: boolean; modified: number | null };

export type LaunchCandidate = {
  /** Ruta normalizada: identifica la fila y evita duplicados. */
  key: string;
  name: string;
  path: string;
  /** Carpeta raíz de la que sale, o null si es un proyecto añadido a mano. */
  root: string | null;
  /** Id del proyecto si ya está en trex. */
  projectId: string | null;
  git: boolean;
  /** Última apertura en trex o última modificación de la carpeta (ms). */
  recent: number;
};

export const MAX_LAUNCHER_ROOTS = 20;
/** Filas que se pintan a la vez; el resto aparece al afinar la búsqueda. */
export const LAUNCHER_VISIBLE_LIMIT = 150;

/** Misma regla que `normalizePath`: sin separador final, con `\` y sin mayúsculas. */
export const launcherPathKey = (path: string): string =>
  path.trim().replace(/[\\/]+$/, "").replace(/\//g, "\\").toLowerCase();

export function normalizeProjectLauncher(raw: unknown): ProjectLauncherSettings {
  const record = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const roots: string[] = [];
  const seen = new Set<string>();
  if (Array.isArray(record.roots)) {
    for (const item of record.roots) {
      if (typeof item !== "string" || roots.length >= MAX_LAUNCHER_ROOTS) continue;
      const root = item.trim(), key = launcherPathKey(root);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      roots.push(root);
    }
  }
  return {
    roots,
    profileId: typeof record.profileId === "string" ? record.profileId : "",
    reuseChat: typeof record.reuseChat === "boolean" ? record.reuseChat : true,
  };
}

/** Añade una carpeta raíz; devuelve null si ya estaba (con otra forma de escribirla) o si no caben más. */
export function addLauncherRoot(settings: ProjectLauncherSettings, root: string): ProjectLauncherSettings | null {
  const clean = root.trim(), key = launcherPathKey(clean);
  if (!key || settings.roots.length >= MAX_LAUNCHER_ROOTS || settings.roots.some(item => launcherPathKey(item) === key)) return null;
  return { ...settings, roots: [...settings.roots, clean] };
}

/** El perfil con el que se abre: el elegido si sigue existiendo, si no el predeterminado. */
export function launcherProfileId(settings: ProjectLauncherSettings, profileIds: readonly string[], fallback: string): string {
  return settings.profileId && profileIds.includes(settings.profileId) ? settings.profileId : fallback;
}

/** Proyectos de trex y subcarpetas de las raíces, sin repetir la misma ruta. */
export function launchCandidates(projects: readonly Project[], folders: readonly ProjectFolder[]): LaunchCandidate[] {
  const byKey = new Map<string, LaunchCandidate>();
  for (const project of projects) {
    const key = launcherPathKey(project.path);
    if (!key || byKey.has(key)) continue;
    byKey.set(key, { key, name: project.name, path: project.path, root: null, projectId: project.id, git: false,
      recent: project.lastOpenedAt ?? project.createdAt ?? 0 });
  }
  for (const folder of folders) {
    const key = launcherPathKey(folder.path);
    if (!key) continue;
    const existing = byKey.get(key);
    if (existing) {
      // Ya está en trex: conserva su nombre y se ordena por lo más reciente de las dos fechas.
      existing.root ??= folder.root;
      existing.git = folder.git;
      existing.recent = Math.max(existing.recent, folder.modified ?? 0);
      continue;
    }
    byKey.set(key, { key, name: folder.name, path: folder.path, root: folder.root, projectId: null, git: folder.git, recent: folder.modified ?? 0 });
  }
  return [...byKey.values()];
}

const fold = (value: string): string => value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const BOUNDARY = /[\s\-_.]/;

/**
 * Cuánto se parece un candidato a lo escrito; menor es mejor y null es que no casa.
 * 0 nombre exacto · 1 empieza igual · 2 empieza una palabra del nombre · 3 lo contiene ·
 * 4 las letras en orden ("trx" → trex) · 5 solo casa con la ruta.
 */
export function launchScore(candidate: Pick<LaunchCandidate, "name" | "path">, query: string): number | null {
  const q = fold(query).trim();
  if (!q) return 0;
  const name = fold(candidate.name);
  if (name === q) return 0;
  if (name.startsWith(q)) return 1;
  for (let index = name.indexOf(q); index > 0; index = name.indexOf(q, index + 1)) {
    if (BOUNDARY.test(name[index - 1])) return 2;
  }
  const words = q.split(/\s+/).filter(Boolean);
  if (name.includes(q) || (words.length > 1 && words.every(word => name.includes(word)))) return 3;
  const letters = q.replace(/[\s\-_.]+/g, "");
  if (letters.length >= 2) {
    let position = 0;
    for (const char of letters) {
      position = name.indexOf(char, position);
      if (position < 0) break;
      position += 1;
    }
    if (position > 0) return 4;
  }
  const path = fold(candidate.path);
  return words.every(word => path.includes(word)) ? 5 : null;
}

/** Ordena por parecido y, a igual parecido (o sin búsqueda), por lo más reciente. */
export function rankCandidates(candidates: readonly LaunchCandidate[], query: string): LaunchCandidate[] {
  const scored: { candidate: LaunchCandidate; score: number }[] = [];
  for (const candidate of candidates) {
    const score = launchScore(candidate, query);
    if (score !== null) scored.push({ candidate, score });
  }
  scored.sort((a, b) => a.score - b.score || b.candidate.recent - a.candidate.recent
    || a.candidate.name.localeCompare(b.candidate.name, "es", { sensitivity: "base" }));
  return scored.map(item => item.candidate);
}
