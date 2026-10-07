import type { Project, TabKind, TabState } from "./types";

/** Mantiene el orden elegido por el usuario dentro de cada sección. */
export const projectSections = (projects: readonly Project[]) => [
  { id: "favorites", label: "Favoritos", projects: projects.filter(project => project.favorite) },
  { id: "projects", label: "Proyectos", projects: projects.filter(project => !project.favorite) },
].filter(section => section.projects.length > 0);

const providers: readonly { kind: TabKind; label: string }[] = [
  { kind: "claude", label: "Claude Code" }, { kind: "codex", label: "Codex" }, { kind: "shell", label: "Terminales" },
];
export const sessionGroups = (tabs: readonly TabState[]) => providers.map(provider => ({
  ...provider, tabs: tabs.filter(tab => tab.kind === provider.kind),
})).filter(group => group.tabs.length > 0);
