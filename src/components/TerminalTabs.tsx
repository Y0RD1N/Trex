/**
 * Una sola cabecera para la sesión abierta. La navegación vive en la sidebar.
 * Los huecos de la barra siguen siendo arrastrables en la ventana de Tauri.
 *
 * Modo inmersivo (`autoHideTopBar`): el contenedor `.bar-slot` pasa a medir 0 y
 * la barra queda flotando sobre el terminal, fuera de la vista. Al acercar el
 * cursor al borde superior baja deslizándose (la detección es por coordenadas,
 * ver `useHoverReveal`), y se esconde de nuevo al alejarlo. Como no ocupa espacio,
 * aparecer y desaparecer nunca redimensiona el terminal; solo activar o
 * desactivar el modo lo hace, una vez y animado.
 */
import { useEffect, useRef, useState } from "react";
import { useHoverReveal } from "../hooks/useHoverReveal";
import { MOD_LABEL } from "../platform";
import type { FloatingAnchor } from "../hooks/useFloatingPosition";
import type { AgentNotice, LauncherProfile, TabState } from "../types";
import { FolderIcon, PanelIcon, PlusIcon, TerminalIcon } from "./Icons";
import { sessionTitle } from "../sessionTitle";
import WindowControls from "./WindowControls";
import DropdownMenu from "./DropdownMenu";
import AgentIcon from "./AgentIcon";
import ProfileMenuItems from "./ProfileMenuItems";
import NotificationCenter from "./NotificationCenter";

/** Alto de la barra en px: `--header-h` (42) más el borde de la ventana. */
const TOP_BAR_HEIGHT = 43;

type Props = {
  tabs: TabState[];
  activeTabId: string | null;
  projectName: string;
  hasProject: boolean;
  profiles: LauncherProfile[];
  defaultProfileId: string;
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
  /** Barra oculta hasta acercar el cursor al borde superior. */
  autoHideTopBar: boolean;
  onToggleTopBar: () => void;
  onRevealProject: (() => void) | null;
  onNew: (profileId: string) => void;
  onNewShell: () => void;
  onOpenSettings: () => void;
  onOpenProfiles: () => void;
  notices: AgentNotice[];
  soundEnabled: boolean;
  liveTabIds: Set<string>;
  onOpenNotice: (notice: AgentNotice) => void;
  onMarkNoticesRead: () => void;
  onClearNotices: () => void;
  onToggleSound: () => void;
  onPreviewSound: () => void;
};

export default function TerminalTabs({
  tabs, activeTabId, projectName, hasProject, sidebarCollapsed, profiles, defaultProfileId,
  onToggleSidebar, autoHideTopBar, onToggleTopBar, onRevealProject, onNew, onNewShell, onOpenSettings, onOpenProfiles,
  notices, soundEnabled, liveTabIds, onOpenNotice, onMarkNoticesRead, onClearNotices, onToggleSound, onPreviewSound,
}: Props) {
  const [menu, setMenu] = useState<FloatingAnchor | null>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const current = tabs.find((tab) => tab.id === activeTabId);
  const title = current ? sessionTitle(current) : null;
  // Al activar el modo se enseña la barra un instante para que se vea adónde va.
  // `openFrom`: la esquina superior izquierda queda para la barra lateral oculta.
  const reveal = useHoverReveal<HTMLDivElement>({
    enabled: autoHideTopBar, edge: "top", extent: TOP_BAR_HEIGHT, openFrom: 28,
    openDelay: 90, closeDelay: 380, introMs: 1400,
    holdOpen: (slot) => slot.querySelector(":focus-visible") !== null,
  });
  const shown = !autoHideTopBar || reveal.revealed;

  useEffect(() => setMenu(null), [projectName, activeTabId]);

  return (
    <div ref={reveal.ref} className={`bar-slot${autoHideTopBar ? " auto-hide" : ""}${shown ? " shown" : ""}`} {...reveal.handlers}>
    <header className="tabs-bar" data-tauri-drag-region="deep">
      <div className="workspace-title" data-tauri-drag-region>
        <span className={current?.kind === "claude" ? "workspace-mark claude" : "workspace-mark"} aria-hidden="true">
          {current ? <AgentIcon kind={current.kind} activity={current.exited ? "idle" : current.activity} nativeIndicator={title?.nativeIndicator} /> : <FolderIcon size={15} />}
        </span>
        <span className="workspace-title-text" title={title?.label ?? projectName} data-tauri-drag-region>
          {title?.label ?? (hasProject ? projectName : "Tu espacio")}
        </span>
        {current && <span className="workspace-project" data-tauri-drag-region>{projectName}</span>}
        {current?.profileName && <span className="workspace-profile" title={`Perfil: ${current.profileName} · ${current.command}`} data-tauri-drag-region>{current.profileName}</span>}
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
            <ProfileMenuItems profiles={profiles} defaultProfileId={defaultProfileId} onOpen={profileId => { setMenu(null); onNew(profileId); }} />
            <div className="context-sep" role="separator" />
            <button type="button" role="menuitem" tabIndex={-1} className="context-item" onClick={() => { setMenu(null); onNewShell(); }}>
              <span className="context-icon" aria-hidden="true"><TerminalIcon size={16} /></span>
              Nueva terminal
              <span className="kbd">{MOD_LABEL} ⇧ T</span>
            </button>
            <div className="context-sep" role="separator" />
            <button type="button" role="menuitem" tabIndex={-1} className="context-item" onClick={() => { setMenu(null); onOpenProfiles(); }}>Configurar perfiles…</button>
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
      <NotificationCenter notices={notices} soundEnabled={soundEnabled} liveTabIds={liveTabIds}
        onOpenSession={onOpenNotice} onMarkRead={onMarkNoticesRead} onClear={onClearNotices}
        onToggleSound={onToggleSound} onPreviewSound={onPreviewSound} />
      <WindowControls onOpenSettings={onOpenSettings} onRevealProject={onRevealProject}
        autoHideTopBar={autoHideTopBar} onToggleTopBar={onToggleTopBar} />
    </header>
    </div>
  );
}
