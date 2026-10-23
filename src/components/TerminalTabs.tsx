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
import type { FloatingAnchor } from "../hooks/useFloatingPosition";
import type { AgentNotice, LauncherProfile, TabState } from "../types";
import { FolderIcon, GridIcon, LayoutIcon, MapIcon, MaximizeIcon, PlusIcon, SearchIcon, SplitIcon, TerminalIcon } from "./Icons";
import type { SplitDirection } from "../splitLayout";
import { sessionTitle } from "../sessionTitle";
import WindowControls from "./WindowControls";
import DropdownMenu from "./DropdownMenu";
import AgentIcon from "./AgentIcon";
import ProfileMenuItems from "./ProfileMenuItems";
import NotificationCenter from "./NotificationCenter";
import { shortcutLabel, type ShortcutBindings } from "../shortcuts";

/** Alto de la barra en px: `--header-h` (42) más el borde de la ventana. */
const TOP_BAR_HEIGHT = 43;

type Props = {
  tabs: TabState[];
  activeTabId: string | null;
  projectName: string;
  hasProject: boolean;
  profiles: LauncherProfile[];
  defaultProfileId: string;
  /** Barra oculta hasta acercar el cursor al borde superior. */
  autoHideTopBar: boolean;
  onToggleTopBar: () => void;
  onRevealProject: (() => void) | null;
  onNew: (profileId: string) => void;
  onNewShell: () => void;
  onWorkflow?: () => void;
  onOpenSettings: () => void;
  onOpenProfiles: () => void;
  onCommandPalette: () => void;
  onRecover: () => void;
  onChangeSplit: (direction: SplitDirection | null) => void;
  splitDirection: SplitDirection | null;
  shortcuts: ShortcutBindings;
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
  tabs, activeTabId, projectName, hasProject, profiles, defaultProfileId,
  autoHideTopBar, onToggleTopBar, onRevealProject, onNew, onNewShell, onWorkflow, onOpenSettings, onOpenProfiles,
  onCommandPalette,onRecover,onChangeSplit,splitDirection,shortcuts,
  notices, soundEnabled, liveTabIds, onOpenNotice, onMarkNoticesRead, onClearNotices, onToggleSound, onPreviewSound,
}: Props) {
  const [menu, setMenu] = useState<FloatingAnchor | null>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const [layoutMenu, setLayoutMenu] = useState<FloatingAnchor | null>(null);
  const layoutButtonRef = useRef<HTMLButtonElement>(null);
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

  useEffect(() => { setMenu(null); setLayoutMenu(null); }, [projectName, activeTabId]);

  return (
    <div ref={reveal.ref} className={`bar-slot${autoHideTopBar ? " auto-hide" : ""}${shown ? " shown" : ""}`} {...reveal.handlers}>
    <header className="tabs-bar" data-tauri-drag-region="deep">
      <div className="workspace-title" data-tauri-drag-region>
        <span className={current?.kind === "claude" ? "workspace-mark claude" : "workspace-mark"} aria-hidden="true">
          {current?.agentRoom ? <span className="workspace-team-mark"><AgentIcon kind={current.agentRoom.planner.agent.provider} size={12} /><AgentIcon kind={current.agentRoom.executor.agent.provider} size={12} /></span>
            : current ? <AgentIcon kind={current.kind} activity={current.exited ? "idle" : current.activity} nativeIndicator={title?.nativeIndicator} /> : <FolderIcon size={15} />}
        </span>
        <span className="workspace-title-text" title={title?.label ?? projectName} data-tauri-drag-region>
          {title?.label ?? (hasProject ? projectName : "Tu espacio")}
        </span>
        {current && <span className="workspace-project" data-tauri-drag-region>{projectName}</span>}
        {current?.agentRoom ? <span className="workspace-profile" data-tauri-drag-region>{current.agentRoom.planner.agent.profileName} + {current.agentRoom.executor.agent.profileName}</span>
          : current?.profileName && <span className="workspace-profile" title={`Perfil: ${current.profileName} · ${current.command}`} data-tauri-drag-region>{current.profileName}</span>}
      </div>

      <div className="session-create">
        <button type="button" className="icon-btn tip tip-below" aria-label="Paleta de comandos" data-tip={`Paleta de comandos (${shortcutLabel(shortcuts.commandPalette)})`} onClick={onCommandPalette}><SearchIcon size={18} /></button>
        <button ref={layoutButtonRef} type="button" className={`icon-btn tip tip-below${splitDirection ? " active" : ""}`} aria-label="Distribución de terminales" data-tip={`Distribución de terminales (${shortcutLabel(shortcuts.toggleSplit)})`} aria-expanded={layoutMenu !== null} aria-haspopup="menu" disabled={!hasProject || tabs.length === 0} onClick={event => { setMenu(null); setLayoutMenu(layoutMenu ? null : { element:event.currentTarget }); }} onKeyDown={event => { if (event.key === "ArrowDown") { event.preventDefault(); setMenu(null); setLayoutMenu({ element:event.currentTarget }); } }}>
          {splitDirection === "grid" ? <GridIcon /> : <LayoutIcon />}
        </button>
        <DropdownMenu anchor={layoutMenu} triggerRef={layoutButtonRef} label="Distribución de terminales" onClose={() => setLayoutMenu(null)}>
          {([
            { direction:null, label:"Una terminal", icon:<MaximizeIcon size={18} /> },
            { direction:"columns", label:"Dos columnas", icon:<SplitIcon /> },
            { direction:"rows", label:"Dos filas", icon:<SplitIcon rows /> },
            { direction:"grid", label:"Cuatro paneles · 2 × 2", icon:<GridIcon /> },
          ] as const).map(view => <button key={view.direction ?? "single"} type="button" role="menuitemradio" aria-checked={splitDirection === view.direction} tabIndex={-1} className="context-item" onClick={() => { setLayoutMenu(null); onChangeSplit(view.direction); }}>
            <span className="context-icon" aria-hidden="true">{view.icon}</span>{view.label}
          </button>)}
        </DropdownMenu>
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
          onClick={event => { setLayoutMenu(null); setMenu(menu ? null : { element: event.currentTarget }); }}
        >
          <PlusIcon size={16} />
        </button>
        {
          <DropdownMenu anchor={menu} triggerRef={menuButtonRef} label="Crear sesión"
            className="session-create-menu" onClose={() => setMenu(null)}>
            <ProfileMenuItems profiles={profiles} defaultProfileId={defaultProfileId} defaultShortcut={shortcuts.newClaudeTab} onOpen={profileId => { setMenu(null); onNew(profileId); }} />
            {onWorkflow && <button type="button" role="menuitem" tabIndex={-1} className="context-item" onClick={() => { setMenu(null); onWorkflow(); }}>
              <span className="context-icon" aria-hidden="true"><MapIcon size={16} /></span>Planear y ejecutar con agentes…
            </button>}
            <div className="context-sep" role="separator" />
            <button type="button" role="menuitem" tabIndex={-1} className="context-item" onClick={() => { setMenu(null); onNewShell(); }}>
              <span className="context-icon" aria-hidden="true"><TerminalIcon size={16} /></span>
              Nueva terminal
              <span className="kbd">{shortcutLabel(shortcuts.newShellTab)}</span>
            </button>
            <div className="context-sep" role="separator" />
            <button type="button" role="menuitem" tabIndex={-1} className="context-item" onClick={() => {setMenu(null);onRecover();}}>Recuperar conversación…<span className="kbd">{shortcutLabel(shortcuts.recoverSessions)}</span></button>
            <button type="button" role="menuitem" tabIndex={-1} className="context-item" onClick={() => { setMenu(null); onOpenProfiles(); }}>Configurar perfiles…</button>
          </DropdownMenu>
        }
      </div>

      <NotificationCenter notices={notices} soundEnabled={soundEnabled} liveTabIds={liveTabIds}
        onOpenSession={onOpenNotice} onMarkRead={onMarkNoticesRead} onClear={onClearNotices}
        onToggleSound={onToggleSound} onPreviewSound={onPreviewSound} />
      <WindowControls onOpenSettings={onOpenSettings} onRevealProject={onRevealProject}
        autoHideTopBar={autoHideTopBar} onToggleTopBar={onToggleTopBar} />
    </header>
    </div>
  );
}
