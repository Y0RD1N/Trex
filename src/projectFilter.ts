import type { Project } from "./types";

/** La visibilidad solo afecta a la navegación; las sesiones siguen abiertas. */
export type ProjectFilter = { mode: "all" | "favorites" | "selected"; projectIds: string[] };

export function normalizeProjectFilter(raw: unknown, projects: readonly Project[]): ProjectFilter {
  const value = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const mode = value.mode === "favorites" || value.mode === "selected" ? value.mode : "all";
  const existing = new Set(projects.map(project => project.id));
  const projectIds = Array.isArray(value.projectIds)
    ? [...new Set(value.projectIds.filter((id): id is string => typeof id === "string" && existing.has(id)))] : [];
  return { mode, projectIds };
}

export function filterProjects(projects: readonly Project[], filter: ProjectFilter): Project[] {
  const selected = new Set(filter.projectIds);
  return projects.filter(project => filter.mode === "all" || (filter.mode === "favorites" ? project.favorite : selected.has(project.id)));
}

/** Un proyecto añadido explícitamente debe ser accesible en la vista actual. */
export function includeAddedProject(filter: ProjectFilter, projectId: string): ProjectFilter {
  return filter.mode === "selected" ? { ...filter, projectIds: [...new Set([...filter.projectIds, projectId])] }
    : filter.mode === "favorites" ? { ...filter, mode: "all" } : filter;
}
