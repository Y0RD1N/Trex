import type { Project } from "./types";

/** Mantiene el orden elegido por el usuario dentro de cada sección. */
export const projectSections = (projects: readonly Project[]) => [
  { id: "favorites", label: "Favoritos", projects: projects.filter(project => project.favorite) },
  { id: "projects", label: "Proyectos", projects: projects.filter(project => !project.favorite) },
].filter(section => section.projects.length > 0);
