/**
 * Navegación de proyectos y sesiones, con superficies suaves y búsqueda global.
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
import { shortcutLabel, type ShortcutBindings } from "../shortcuts";
import type { ClaudeInfo, LauncherProfile, Project, TabState } from "../types";
import type { ThemeMode } from "../theme";
import { projectSections } from "../sidebarGroups";
import type { CliStatus } from "../hooks/useCliUpdates";
import type { CliId } from "../cliUpdates";
import AgentIcon from "./AgentIcon";
import { AlertIcon, CloseIcon, FolderPlusIcon, GaugeIcon, MoonIcon, PanelIcon, SettingsIcon, SearchIcon, SunIcon } from "./Icons";
import ProjectItem from "./ProjectItem";
import SessionItem from "./SessionItem";
import { sessionLabel } from "../sessionTitle";
import { projectActivity } from "../agentActivity";

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
  shortcuts: ShortcutBindings;
  /** Modo que está pintado ahora mismo (resuelve "system"). */
  themeMode: ThemeMode;
  /** Campo de búsqueda: el atajo configurado enfoca este input desde App. */
  searchInputRef: RefObject<HTMLInputElement | null>;
  onSearchChange: (value: string) => void;
  onAdd: () => void;
  onSelect: (projectId: string) => void;
  onQuickOpen: (projectId: string, profileId: string) => void;
  onWorkflow: (projectId: string) => void;
  onNewShell: (projectId: string) => void;
  onSelectSession: (projectId: string, tabId: string) => void;
  onCloseSession: (tabId: string, trigger: HTMLElement) => void;
  onRenameSession: (tabId: string, name: string) => void;
  onRename: (projectId: string, name: string) => void;
  onToggleFavorite: (projectId: string) => void;
  onDelete: (projectId: string, trigger: HTMLElement, returnFocus: HTMLElement | null) => void;
  onReveal: (projectId: string) => void;
  onCopyPath: (path: string) => void;
  onOpenSettings: () => void;
  /** Uso del plan de todas las cuentas. */
  onOpenUsage: () => void;
  onToggleTheme: () => void;
  onToggleSidebar: () => void;
  onResize: (width: number) => void;
  /** Versiones nuevas de Claude Code o Codex pendientes de instalar. */
  updates: CliStatus[];
  onUpdateCli: (id: CliId) => void;
  onDismissUpdate: (id: CliId) => void;
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
  shortcuts,
  themeMode,
  searchInputRef,
  onSearchChange,
  onAdd,
  onSelect,
  onQuickOpen,
  onWorkflow,
  onNewShell,
  onSelectSession,
  onCloseSession,
  onRenameSession,
  onRename,
  onToggleFavorite,
  onDelete,
  onReveal,
  onCopyPath,
  onOpenSettings,
  onOpenUsage,
  onToggleTheme,
  onToggleSidebar,
  onResize,
  updates,
  onUpdateCli,
  onDismissUpdate,
}: Props) {
  const [dragging, setDragging] = useState(false);
  // Al abrir la app todas las carpetas empiezan contraídas.
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(new Set());
  const restoredTab = useRef(false);
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

  const expandProject = (projectId: string): void => {
    setExpandedProjects((previous) => previous.has(projectId) ? previous : new Set(previous).add(projectId));
  };

  // Los atajos pueden activar sesiones de carpetas contraídas; la sesión que se
  // restaura al abrir la app no despliega su carpeta.
  useEffect(() => {
    if (!activeTabId || !activeProjectId) return;
    if (!restoredTab.current) { restoredTab.current = true; return; }
    expandProject(activeProjectId);
  }, [activeTabId, activeProjectId]);

  const toggleProject = (projectId: string): void => {
    setExpandedProjects((previous) => {
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
    ? `Cambiar a modo claro (${shortcutLabel(shortcuts.toggleTheme)})`
    : `Cambiar a modo oscuro (${shortcutLabel(shortcuts.toggleTheme)})`;
  const query = search.trim();
  const noResults = projects.length === 0 && query.length > 0;

  return (
    <aside
      id="workspace-sidebar"
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
            <span className="sidebar-identity" data-tauri-drag-region>
              <span className="sidebar-name" data-tauri-drag-region>trex</span>
              <span className="sidebar-caption" data-tauri-drag-region>Espacio de trabajo</span>
            </span>
            <button type="button" className="icon-btn sidebar-collapse tip tip-below"
              aria-label={peek ? "Fijar barra lateral" : "Ocultar barra lateral"}
              data-tip={`${peek ? "Fijar" : "Ocultar"} barra lateral (${shortcutLabel(shortcuts.toggleSidebar)})`}
              aria-controls="workspace-sidebar" aria-expanded={!sidebarCollapsed} onClick={onToggleSidebar}>
              <PanelIcon size={17} />
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
                {shortcutLabel(shortcuts.focusSearch)}
              </span>
            )}
          </div>
        </div>

        <nav className="project-list" aria-label="Proyectos y sesiones">
          {projectSections(projects).map(section => <section key={section.id} className="sidebar-project-section" aria-label={section.label}>
          <div className="sidebar-section-label"><span>{section.label}</span><span>{section.projects.length}</span></div>
          {section.projects.map((project) => {
            const sessions = tabs.filter((tab) => tab.projectId === project.id);
            const expanded = query.length > 0 || expandedProjects.has(project.id);
            const needle = normalizeText(query);
            const matchesProject = normalizeText(project.name).includes(needle) || normalizeText(project.path).includes(needle);
            const visibleSessions = matchesProject ? sessions : sessions.filter((tab) => normalizeText(sessionLabel(tab)).includes(needle));
            return (
              <div className="project-group" key={project.id}>
                <ProjectItem
                  project={project}
                  active={project.id === activeProjectId}
                  tabCount={sessions.length}
                  activity={projectActivity(sessions)}
                  expanded={expanded}
                  onToggleExpanded={() => toggleProject(project.id)}
                  onSelect={() => onSelect(project.id)}
                  profiles={profiles}
                  onQuickOpen={profileId => {
                    onQuickOpen(project.id, profileId);
                    expandProject(project.id);
                    if (peek) reveal.hide();
                  }}
                  onWorkflow={() => {
                    onWorkflow(project.id);
                    if (peek) reveal.hide();
                  }}
                  onNewShell={() => {
                    onNewShell(project.id);
                    expandProject(project.id);
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
                    {visibleSessions.map((tab) => (
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
          {updates.map(update => (
            <div key={update.id} className={`cli-update${update.error ? " has-error" : ""}`} role="status"
              title={update.error ?? `Tienes la ${update.installed}; ya está disponible la ${update.latest}.`}>
              <span className="cli-update-icon" aria-hidden="true"><AgentIcon kind={update.id} size={14} /></span>
              <div className="cli-update-body">
                <div className="cli-update-head">
                  <strong>{update.name}</strong>
                  {!update.updating && <button type="button" className="cli-update-close tip" data-tip="Ahora no"
                    aria-label={`No actualizar ${update.name} ahora`} onClick={() => onDismissUpdate(update.id)}>
                    <CloseIcon size={12} />
                  </button>}
                </div>
                <div className="cli-update-row">
                  <small>{update.updating ? "Actualizando…" : update.error ? "No se pudo actualizar" : `Nueva: ${update.latest}`}</small>
                  <button type="button" className="cli-update-action" disabled={update.updating}
                    aria-label={`Actualizar ${update.name} a la ${update.latest}`} onClick={() => onUpdateCli(update.id)}>
                    {update.updating ? <span className="cli-update-spinner" aria-hidden="true" /> : update.error ? "Reintentar" : "Actualizar"}
                  </button>
                </div>
              </div>
            </div>
          ))}
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
              className="icon-btn sidebar-footer-control sidebar-add tip"
              data-tip="Añadir proyecto"
              aria-label="Añadir proyecto"
              onClick={onAdd}
            >
              <FolderPlusIcon size={17} />
              <span>{sidebarWidth < 260 ? "Nuevo" : "Nuevo proyecto"}</span>
            </button>
            <button
              type="button"
              className="icon-btn sidebar-footer-control tip"
              data-tip="Uso de las cuentas"
              aria-label="Uso de las cuentas"
              onClick={onOpenUsage}
            >
              <GaugeIcon size={19} strokeWidth={1.7} />
            </button>
            <button
              type="button"
              className="icon-btn sidebar-footer-control sidebar-theme tip"
              data-tip={`${goesToLight ? "Modo claro" : "Modo oscuro"} (${shortcutLabel(shortcuts.toggleTheme)})`}
              aria-label={themeTitle}
              onClick={onToggleTheme}
            >
              {goesToLight ? <SunIcon size={19} strokeWidth={1.7} /> : <MoonIcon size={19} strokeWidth={1.7} />}
            </button>
            <button
              type="button"
              className="icon-btn sidebar-footer-control tip"
              data-tip={`Ajustes (${shortcutLabel(shortcuts.toggleSettings)})`}
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
