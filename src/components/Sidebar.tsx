/**
 * Barra lateral (≈290 px): franja superior arrastrable, cabecera con ✳ +
 * "trex" + botón de añadir proyecto, buscador de proyectos (Ctrl+K), lista de
 * proyectos con icono de carpeta y menú "⋯" por fila, y pie con los ajustes.
 *
 * La franja superior es la barra de título de la ventana sin bordes: lleva
 * `data-tauri-drag-region` (solo en contenedores y textos; nunca en botones ni
 * en el input de búsqueda) para poder arrastrar la ventana desde ahí.
 *
 * La barra se puede colapsar (Ctrl+B o el botón de panel de la barra superior):
 * el ancho se anima hasta 0 y el contenido se desvanece y se recorta dentro de
 * `.sidebar-inner`, de modo que el área principal queda completa y sin huecos.
 */
import { useEffect, useRef, useState, type RefObject } from "react";
import { clamp } from "../api";
import { MOD_LABEL } from "../platform";
import type { ClaudeInfo, Project } from "../types";
import type { ThemeMode } from "../theme";
import { AlertIcon, GearIcon, MoonIcon, PlusIcon, SearchIcon, SunIcon } from "./Icons";
import ProjectItem from "./ProjectItem";

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
  tabCounts: Record<string, number>;
  /** Texto del buscador de proyectos. */
  search: string;
  /** Modo que está pintado ahora mismo (resuelve "system"). */
  themeMode: ThemeMode;
  /** Campo de búsqueda: el atajo Ctrl+K enfoca este input desde App. */
  searchInputRef: RefObject<HTMLInputElement | null>;
  onSearchChange: (value: string) => void;
  onAdd: () => void;
  onSelect: (projectId: string) => void;
  onQuickOpen: (projectId: string) => void;
  onRename: (projectId: string, name: string) => void;
  onDelete: (projectId: string) => void;
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
  tabCounts,
  search,
  themeMode,
  searchInputRef,
  onSearchChange,
  onAdd,
  onSelect,
  onQuickOpen,
  onRename,
  onDelete,
  onReveal,
  onCopyPath,
  onOpenSettings,
  onToggleTheme,
  onResize,
}: Props) {
  const [dragging, setDragging] = useState(false);
  const onResizeRef = useRef(onResize);
  onResizeRef.current = onResize;

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
      className={`sidebar${sidebarCollapsed ? " collapsed" : ""}`}
      style={{ width: sidebarCollapsed ? 0 : sidebarWidth }}
    >
      <div className="sidebar-inner">
        <div className="sidebar-top" data-tauri-drag-region="deep">
          {/* Hueco que dejan los antiguos semáforos: sigue siendo la zona para
              arrastrar la ventana desde la esquina superior izquierda. */}
          <div className="sidebar-drag" data-tauri-drag-region aria-hidden="true" />

          <header className="sidebar-header" data-tauri-drag-region>
            <span className="sidebar-brand" aria-hidden="true" data-tauri-drag-region>
              ✳
            </span>
            <span className="sidebar-name" data-tauri-drag-region>
              trex
            </span>
            <button
              type="button"
              className="sq-btn sidebar-add tip tip-below tip-right"
              data-tip="Añadir proyecto"
              aria-label="Añadir proyecto"
              onClick={onAdd}
            >
              <PlusIcon size={16} />
            </button>
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
              placeholder="Buscar proyectos…"
              spellCheck={false}
              aria-label="Buscar proyectos"
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

        <div className="sidebar-section-label"><span>Proyectos</span><span>{projects.length}</span></div>
        <div className="project-list">
          {projects.map((project) => (
            <ProjectItem
              key={project.id}
              project={project}
              active={project.id === activeProjectId}
              tabCount={tabCounts[project.id] ?? 0}
              onSelect={() => onSelect(project.id)}
              onQuickOpen={() => onQuickOpen(project.id)}
              onReveal={() => onReveal(project.id)}
              onCopyPath={() => onCopyPath(project.path)}
              onRename={(name) => onRename(project.id, name)}
              onDelete={() => onDelete(project.id)}
            />
          ))}

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
        </div>

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
            <button type="button" className="sidebar-settings" onClick={onOpenSettings}>
              <span className="sidebar-settings-icon" aria-hidden="true">
                <GearIcon size={16} />
              </span>
              <span className="sidebar-settings-label">Ajustes</span>
            </button>
            <button
              type="button"
              className="icon-btn sidebar-theme tip tip-right"
              data-tip={goesToLight ? "Modo claro (Ctrl+Shift+L)" : "Modo oscuro (Ctrl+Shift+L)"}
              aria-label={themeTitle}
              onClick={onToggleTheme}
            >
              {goesToLight ? <SunIcon size={16} /> : <MoonIcon size={16} />}
            </button>
            <span className="kbd sidebar-kbd" aria-hidden="true">
              {MOD_LABEL} ,
            </span>
          </div>
        </footer>
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
