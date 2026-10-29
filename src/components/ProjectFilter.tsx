import { useId, useRef, useState } from "react";
import type { Project } from "../types";
import { filterProjects, type ProjectFilter as Filter } from "../projectFilter";
import { normalizeText } from "../api";
import type { FloatingAnchor } from "../hooks/useFloatingPosition";
import DropdownMenu from "./DropdownMenu";
import { ChevronIcon, FilterIcon, FolderIcon, SearchIcon, StarIcon } from "./Icons";

type Props = {
  projects: Project[];
  value: Filter;
  activeProjectId: string | null;
  onChange: (filter: Filter) => void;
};

export default function ProjectFilter({ projects, value, activeProjectId, onChange }: Props) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [anchor, setAnchor] = useState<FloatingAnchor | null>(null);
  const [search, setSearch] = useState("");
  const id = useId();
  const visible = filterProjects(projects, value);
  const selected = new Set(value.projectIds);
  const needle = normalizeText(search);
  const choices = projects.filter(project => normalizeText(project.name).includes(needle) || normalizeText(project.path).includes(needle));
  const label = value.mode === "all" ? "Todos los proyectos" : value.mode === "favorites" ? "Solo favoritos"
    : visible.length === 1 ? visible[0].name : "Mi selección";
  const close = (): void => { triggerRef.current?.focus({ preventScroll: true }); setAnchor(null); };
  const chooseMode = (mode: Filter["mode"]): void => {
    const projectIds = mode === "selected" && value.mode !== "selected" && !value.projectIds.length
      ? [projects.find(project => project.id === activeProjectId)?.id ?? projects[0]?.id].filter((id): id is string => !!id)
      : value.projectIds;
    onChange({ mode, projectIds });
  };

  return <div className="sidebar-project-filter">
    <button ref={triggerRef} type="button" className={`project-filter-trigger${value.mode !== "all" ? " filtered" : ""}`}
      aria-label={`Filtrar proyectos: ${label}`} aria-haspopup="dialog" aria-expanded={anchor !== null} aria-controls={anchor ? id : undefined}
      title={label} onClick={event => { setSearch(""); setAnchor(anchor ? null : { element: event.currentTarget }); }}>
      <FilterIcon size={15} /><span className="project-filter-label">{label}</span>
      <span className="project-filter-count">{visible.length}</span><span className="project-filter-chevron"><ChevronIcon size={12} /></span>
    </button>
    <DropdownMenu anchor={anchor} triggerRef={triggerRef} id={id} label="Filtrar proyectos" role="dialog" align="start"
      className="project-filter-menu" onClose={() => setAnchor(null)}>
      <div className="project-filter-heading"><strong>Mostrar proyectos</strong><span>Elige qué aparece en la barra lateral.</span></div>
      <div className="project-filter-modes" role="group" aria-label="Vista de proyectos">
        {([ ["all", "Todos"], ["favorites", "Favoritos"], ["selected", "Elegir"] ] as const).map(([mode, text]) =>
          <button key={mode} type="button" aria-pressed={value.mode === mode} data-menu-autofocus={value.mode === mode ? "" : undefined}
            onClick={() => chooseMode(mode)}>{text}</button>)}
      </div>
      {value.mode === "selected" ? <>
        <div className="project-filter-selection-heading"><span>Elige uno o varios</span>
          <button type="button" disabled={!selected.size} onClick={() => onChange({ ...value, projectIds: [] })}>Limpiar</button></div>
        <label className="project-filter-search"><SearchIcon size={14} />
          <input type="search" aria-label="Buscar en la selección de proyectos" placeholder="Buscar proyecto…" value={search}
            spellCheck={false} onChange={event => setSearch(event.currentTarget.value)} /></label>
        <div className="project-filter-choices" role="group" aria-label="Proyectos a mostrar">
          {choices.map(project => <label key={project.id} className={`project-filter-choice${selected.has(project.id) ? " selected" : ""}`} title={project.path}>
            <input type="checkbox" checked={selected.has(project.id)} onChange={event => onChange({ mode: "selected",
              projectIds: event.currentTarget.checked ? [...value.projectIds, project.id] : value.projectIds.filter(id => id !== project.id) })} />
            <FolderIcon size={16} /><span>{project.name}</span>{project.favorite && <StarIcon size={12} />}
          </label>)}
          {!choices.length && <p className="project-filter-hint">{projects.length ? "No hay proyectos con ese nombre." : "Añade un proyecto para elegirlo aquí."}</p>}
        </div>
      </> : <p className="project-filter-hint">{value.mode === "all" ? "Todos tus proyectos, en un solo lugar."
        : "Solo los proyectos que marcaste con una estrella."}</p>}
      <div className="project-filter-footer"><span role="status">{visible.length} de {projects.length} visibles</span>
        <button type="button" onClick={close}>Listo</button></div>
    </DropdownMenu>
  </div>;
}
