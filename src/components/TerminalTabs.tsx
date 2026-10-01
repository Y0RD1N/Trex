/**
 * Una sola cabecera para la sesión abierta. La navegación vive en la sidebar.
 * Los huecos de la barra siguen siendo arrastrables en la ventana de Tauri.
 */
import { useEffect, useRef, useState } from "react";
import { MOD_LABEL } from "../platform";
import type { FloatingAnchor } from "../hooks/useFloatingPosition";
import type { TabState } from "../types";
import { FolderIcon, PanelIcon, PlusIcon, TerminalIcon } from "./Icons";
import { sessionLabel } from "./SessionItem";
import WindowControls from "./WindowControls";
import DropdownMenu from "./DropdownMenu";

type Props = {
  tabs: TabState[];
  activeTabId: string | null;
  projectName: string;
  hasProject: boolean;
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
  onRevealProject: (() => void) | null;
  onNew: () => void;
  onNewShell: () => void;
  onOpenSettings: () => void;
};

export default function TerminalTabs({
  tabs, activeTabId, projectName, hasProject, sidebarCollapsed,
  onToggleSidebar, onRevealProject, onNew, onNewShell, onOpenSettings,
}: Props) {
  const [menu, setMenu] = useState<FloatingAnchor | null>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const current = tabs.find((tab) => tab.id === activeTabId);

  useEffect(() => setMenu(null), [projectName, activeTabId]);

  return (
    <header className="tabs-bar" data-tauri-drag-region="deep">
      <div className="workspace-title" data-tauri-drag-region>
        <span className={current?.kind === "claude" ? "workspace-mark claude" : "workspace-mark"} aria-hidden="true">
          {current ? current.kind === "claude" ? "✳" : <TerminalIcon size={15} /> : <FolderIcon size={15} />}
        </span>
        <span className="workspace-title-text" title={current ? sessionLabel(current) : projectName} data-tauri-drag-region>
          {current ? sessionLabel(current) : hasProject ? projectName : "Tu espacio"}
        </span>
        {current && <span className="workspace-project" data-tauri-drag-region>{projectName}</span>}
      </div>

      <div className="session-create">
        <button
          ref={menuButtonRef}
          type="button"
          className="icon-btn tip tip-below"
          data-tip="Nueva sesión"
          aria-label="Nueva sesión"
          aria-expanded={menu !== null}
          aria-haspopup="menu"
          onKeyDown={event => {
            if (event.key === "ArrowDown") { event.preventDefault(); setMenu({ element: event.currentTarget }); }
          }}
          disabled={!hasProject}
          onClick={event => setMenu(menu ? null : { element: event.currentTarget })}
        >
          <PlusIcon size={16} />
        </button>
        {
          <DropdownMenu anchor={menu} triggerRef={menuButtonRef} label="Crear sesión"
            className="session-create-menu" onClose={() => setMenu(null)}>
            <button type="button" role="menuitem" tabIndex={-1} className="context-item" onClick={() => { setMenu(null); onNew(); }}>
              <span className="context-icon" aria-hidden="true">✳</span>
              Nueva sesión de Claude
              <span className="kbd">{MOD_LABEL} T</span>
            </button>
            <button type="button" role="menuitem" tabIndex={-1} className="context-item" onClick={() => { setMenu(null); onNewShell(); }}>
              <span className="context-icon" aria-hidden="true"><TerminalIcon size={16} /></span>
              Nueva terminal
              <span className="kbd">{MOD_LABEL} ⇧ T</span>
            </button>
          </DropdownMenu>
        }
      </div>

      <button
        type="button"
        className="window-btn panel-toggle tip tip-below"
        data-tip={`${sidebarCollapsed ? "Mostrar" : "Ocultar"} barra lateral (${MOD_LABEL}+B)`}
        aria-label={sidebarCollapsed ? "Mostrar barra lateral" : "Ocultar barra lateral"}
        aria-expanded={!sidebarCollapsed}
        onClick={onToggleSidebar}
      >
        <PanelIcon size={16} />
      </button>
      <WindowControls onOpenSettings={onOpenSettings} onRevealProject={onRevealProject} />
    </header>
  );
}
