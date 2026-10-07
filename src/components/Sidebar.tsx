/**
 * Navegación de proyectos y sesiones, con controles planos y búsqueda global.
 *
 * La franja superior es la barra de título de la ventana sin bordes: lleva
 * `data-tauri-drag-region` (solo en contenedores y textos; nunca en botones ni
 * en el input de búsqueda) para poder arrastrar la ventana desde ahí.
 *
 * La barra se puede colapsar (Ctrl+B o el botón de panel de la barra superior):
 * el ancho se anima hasta 0 mientras el contenido se desliza hacia la izquierda,
 * de modo que el área principal queda completa y sin huecos.
 *
 * Colapsada, al acercar el cursor al borde izquierdo reaparece como una capa
 * flotante (`.peek`) por encima del terminal, sin tocar el layout: el terminal no
 * se redimensiona. Se esconde al alejar el cursor; el botón de panel la fija.
 */
import { useEffect, useRef, useState, type RefObject } from "react";
import { clamp, normalizeText } from "../api";
import { useHoverReveal } from "../hooks/useHoverReveal";
import { MOD_LABEL } from "../platform";
import type { ClaudeInfo, LauncherProfile, Project, TabState } from "../types";
import type { ThemeMode } from "../theme";
import { projectSections, sessionGroups } from "../sidebarGroups";
import { AlertIcon, FolderPlusIcon, MoonIcon, SettingsIcon, SearchIcon, SunIcon } from "./Icons";
import ProjectItem from "./ProjectItem";
import SessionItem from "./SessionItem";
import { sessionLabel } from "../sessionTitle";

/** Ancho al que vuelve la barra lateral con doble clic en el divisor. */
const DEFAULT_SIDEBAR_WIDTH = 290;

type Props = {
  /** Proyectos ya filtrados por el buscador. */
  projects: Project[];
  activeProjectId: string | null;
  sidebarWidth: number;
  /** Barra lateral oculta: ancho 0 y contenido desvanecido. */
  sidebarCollapsed: boolean;
  claudeInfo: ClaudeInfo | null;
  profiles: LauncherProfile[];
  tabs: TabState[];
  activeTabId: string | null;
  /** Texto del buscador de proyectos. */
  search: string;
  /** Modo que está pintado ahora mismo (resuelve "system"). */
  themeMode: ThemeMode;
  /** Campo de búsqueda: el atajo Ctrl+K enfoca este input desde App. */
  searchInputRef: RefObject<HTMLInputElement | null>;
  onSearchChange: (value: string) => void;
  onAdd: () => void;
  onSelect: (projectId: string) => void;
  onQuickOpen: (projectId: string, profileId: string) => void;
  onSelectSession: (projectId: string, tabId: string) => void;
  onCloseSession: (tabId: string, trigger: HTMLElement) => void;
  onRenameSession: (tabId: string, name: string) => void;
  onRename: (projectId: string, name: string) => void;
  onToggleFavorite: (projectId: string) => void;
  onDelete: (projectId: string, trigger: HTMLElement, returnFocus: HTMLElement | null) => void;
  onReveal: (projectId: string) => void;
  onCopyPath: (path: string) => void;
  onOpenSettings: () => void;
  onToggleTheme: () => void;
  onResize: (width: number) => void;
};

export default function Sidebar({
  projects,
  activeProjectId,
  sidebarWidth,
  sidebarCollapsed,
  claudeInfo,
  profiles,
  tabs,
  activeTabId,
  search,
  themeMode,
  searchInputRef,
  onSearchChange,
  onAdd,
  onSelect,
  onQuickOpen,
  onSelectSession,
  onCloseSession,
  onRenameSession,
  onRename,
  onToggleFavorite,
  onDelete,
  onReveal,
  onCopyPath,
  onOpenSettings,
  onToggleTheme,
  onResize,
}: Props) {
  const [dragging, setDragging] = useState(false);
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(new Set());
  const onResizeRef = useRef(onResize);
  onResizeRef.current = onResize;
  // Escribir en el buscador o renombrar una sesión mantiene la capa abierta.
  const reveal = useHoverReveal<HTMLElement>({
    enabled: sidebarCollapsed, edge: "left", extent: sidebarWidth + 1,
    openDelay: 70, closeDelay: 340,
    holdOpen: (aside) => {
      const active = document.activeElement;
      return active instanceof HTMLInputElement && aside.contains(active);
    },
  });
  const peek = sidebarCollapsed && reveal.revealed;

  // Los atajos pueden activar sesiones de carpetas que el usuario contrajo.
  useEffect(() => {
    if (!activeTabId || !activeProjectId) return;
    setCollapsedProjects((previous) => {
      if (!previous.has(activeProjectId)) return previous;
      const next = new Set(previous);
      next.delete(activeProjectId);
      return next;
    });
  }, [activeTabId, activeProjectId]);

  const toggleProject = (projectId: string): void => {
    setCollapsedProjects((previous) => {
      const next = new Set(previous);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
  };

  // Arrastre del divisor: el ancho sigue al puntero y se limita a un rango útil.
  useEffect(() => {
    if (!dragging) return;
    const onMove = (event: PointerEvent): void => {
      onResizeRef.current(clamp(Math.round(event.clientX), 180, 520));
    };
    const onUp = (): void => setDragging(false);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    document.body.classList.add("dragging-sidebar");
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.classList.remove("dragging-sidebar");
    };
  }, [dragging]);

  const claudeMissing = claudeInfo !== null && !claudeInfo.found;
  const goesToLight = themeMode === "dark";
  const themeTitle = goesToLight
    ? "Cambiar a modo claro (Ctrl+Shift+L)"
    : "Cambiar a modo oscuro (Ctrl+Shift+L)";
  const query = search.trim();
  const noResults = projects.length === 0 && query.length > 0;

  return (
    <aside
      ref={reveal.ref}
      className={`sidebar${sidebarCollapsed ? " collapsed" : ""}${peek ? " peek" : ""}${sidebarWidth <= 220 ? " compact" : ""}`}
      style={{ width: sidebarCollapsed ? 0 : sidebarWidth }}
      {...reveal.handlers}
    >
      <div className="sidebar-clip" inert={sidebarCollapsed && !peek} aria-hidden={(sidebarCollapsed && !peek) || undefined}>
      <div className="sidebar-inner" style={{ width: sidebarWidth }}>
        <div className="sidebar-top" data-tauri-drag-region="deep">
          <header className="sidebar-header" data-tauri-drag-region>
            <span className="sidebar-brand" aria-hidden="true" data-tauri-drag-region>
              ✳
            </span>
            <span className="sidebar-name" data-tauri-drag-region>
              trex
            </span>
            <span className="sidebar-caption" data-tauri-drag-region>workspace</span>
          </header>
        </div>

        <div className="sidebar-search">
          <div className="search-field">
            <span className="search-icon" aria-hidden="true">
              <SearchIcon size={15} />
            </span>
            <input
              ref={searchInputRef}
              className="search-input"
              type="text"
              value={search}
              placeholder="Buscar…"
              spellCheck={false}
              aria-label="Buscar proyectos y sesiones"
              onChange={(event) => onSearchChange(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  onSearchChange("");
                  event.currentTarget.blur();
                }
              }}
            />
            {search.length === 0 && (
              <span className="kbd search-kbd" aria-hidden="true">
                {MOD_LABEL} K
              </span>
            )}
          </div>
        </div>

        <nav className="project-list" aria-label="Proyectos y sesiones">
          {projectSections(projects).map(section => <section key={section.id} className="sidebar-project-section" aria-label={section.label}>
          <div className="sidebar-section-label"><span>{section.label}</span><span>{section.projects.length}</span></div>
          {section.projects.map((project) => {
            const sessions = tabs.filter((tab) => tab.projectId === project.id);
            const expanded = query.length > 0 || !collapsedProjects.has(project.id);
            const needle = normalizeText(query);
            const matchesProject = normalizeText(project.name).includes(needle) || normalizeText(project.path).includes(needle);
            const visibleSessions = matchesProject ? sessions : sessions.filter((tab) => normalizeText(sessionLabel(tab)).includes(needle));
            return (
              <div className="project-group" key={project.id}>
                <ProjectItem
                  project={project}
                  active={project.id === activeProjectId}
                  tabCount={sessions.length}
                  expanded={expanded}
                  onToggleExpanded={() => toggleProject(project.id)}
                  onSelect={() => onSelect(project.id)}
                  profiles={profiles}
                  onQuickOpen={profileId => {
                    onQuickOpen(project.id, profileId);
                    if (peek) reveal.hide();
                  }}
                  onReveal={() => onReveal(project.id)}
                  onCopyPath={() => onCopyPath(project.path)}
                  onRename={(name) => onRename(project.id, name)}
                  onToggleFavorite={() => onToggleFavorite(project.id)}
                  onDelete={(trigger, returnFocus) => onDelete(project.id, trigger, returnFocus)}
                />
                {visibleSessions.length > 0 && (
                  <div className={`project-sessions${expanded ? " expanded" : ""}`}
                    inert={!expanded} aria-hidden={!expanded || undefined}
                    aria-label={`Sesiones de ${project.name}`}>
                    <div className="project-sessions-clip"><div className="project-sessions-inner">
                    {sessionGroups(visibleSessions).map(group => <div className="session-provider-group" key={group.kind}>
                    <div className="session-group-label"><span>{group.label}</span><span>{group.tabs.length}</span></div>
                    {group.tabs.map((tab) => (
                      <SessionItem
                        key={tab.id}
                        tab={tab}
                        active={tab.id === activeTabId && project.id === activeProjectId}
                        onSelect={() => {
                          onSelectSession(project.id, tab.id);
                          if (peek) reveal.hide();
                        }}
                        onClose={trigger => onCloseSession(tab.id, trigger)}
                        onRename={(name) => onRenameSession(tab.id, name)}
                      />
                    ))}
                    </div>)}
                    </div></div>
                  </div>
                )}
              </div>
            );
          })}
          </section>)}

          {noResults && (
            <div className="sidebar-empty sidebar-empty-centered">
              Sin resultados para «{query}»
            </div>
          )}

          {projects.length === 0 && !noResults && (
            <div className="sidebar-empty">
              Todavía no hay proyectos. Añade una carpeta para empezar.
            </div>
          )}
        </nav>

        <footer className="sidebar-footer">
          {claudeMissing && (
            <div
              className="claude-warn"
              title={claudeInfo?.hint ?? "Claude Code no está instalado o no se encuentra en el PATH"}
            >
              <span className="claude-warn-icon" aria-hidden="true">
                <AlertIcon size={13} />
              </span>
              <span className="claude-warn-text">Claude Code no detectado</span>
            </div>
          )}

          <div className="sidebar-footer-row">
            <button
              type="button"
              className="icon-btn sidebar-footer-control tip"
              data-tip="Añadir proyecto"
              aria-label="Añadir proyecto"
              onClick={onAdd}
            >
              <FolderPlusIcon size={19} />
            </button>
            <span className="sidebar-footer-spacer" />
            <button
              type="button"
              className="icon-btn sidebar-footer-control sidebar-theme tip"
              data-tip={goesToLight ? "Modo claro (Ctrl+Shift+L)" : "Modo oscuro (Ctrl+Shift+L)"}
              aria-label={themeTitle}
              onClick={onToggleTheme}
            >
              {goesToLight ? <SunIcon size={19} strokeWidth={1.7} /> : <MoonIcon size={19} strokeWidth={1.7} />}
            </button>
            <button
              type="button"
              className="icon-btn sidebar-footer-control tip"
              data-tip={`Ajustes (${MOD_LABEL} ,)`}
              aria-label="Ajustes"
              onClick={onOpenSettings}
            >
              <SettingsIcon size={19} strokeWidth={1.7} />
            </button>
          </div>
        </footer>
      </div>
      </div>

      <div
        className={`sidebar-resizer${dragging ? " dragging" : ""}`}
        role="separator"
        aria-orientation="vertical"
        aria-label="Redimensionar barra lateral"
        title="Arrastra para cambiar el ancho"
        onPointerDown={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDoubleClick={() => onResize(DEFAULT_SIDEBAR_WIDTH)}
      />
    </aside>
  );
}
