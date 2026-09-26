/**
 * Barra superior: hace a la vez de barra de título y de barra de pestañas
 * (44 px, con hairline inferior).
 *
 * A la izquierda, la pestaña activa se dibuja como un chip elevado (icono de
 * carpeta, nombre del proyecto, subtítulo renombrable y una X siempre visible);
 * el resto de pestañas quedan sin fondo y con el texto atenuado. Junto al chip
 * está el botón cuadrado "+" y, al extremo derecho, el botón de panel lateral
 * seguido de los controles de ventana (⋯ ▢ —).
 *
 * La franja es arrastrable (`data-tauri-drag-region`): se arrastra la ventana
 * desde el hueco entre las pestañas, el hueco de la barra y el hueco libre de
 * la zona de pestañas. Los botones, el input de renombrado y las pestañas
 * quedan fuera del arrastre por el propio script de Tauri.
 */
import { useEffect, useState } from "react";
import { MOD_LABEL } from "../platform";
import type { TabState } from "../types";
import { CloseIcon, FolderIcon, PanelIcon, PlusIcon } from "./Icons";
import WindowControls from "./WindowControls";

type Props = {
  tabs: TabState[];
  activeTabId: string | null;
  projectName: string;
  /** ¿Hay proyecto activo? (sin él, el "+" queda desactivado) */
  hasProject: boolean;
  /** ¿Está oculta la barra lateral? (el botón de panel lo refleja) */
  sidebarCollapsed: boolean;
  /** Muestra u oculta la barra lateral (Ctrl+B). */
  onToggleSidebar: () => void;
  /** Abre la carpeta del proyecto activo en el explorador. */
  onRevealProject: (() => void) | null;
  onSelect: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onRename: (tabId: string, subtitle: string) => void;
  onNew: () => void;
  onOpenSettings: () => void;
};

export default function TerminalTabs({
  tabs,
  activeTabId,
  projectName,
  hasProject,
  sidebarCollapsed,
  onToggleSidebar,
  onRevealProject,
  onSelect,
  onClose,
  onRename,
  onNew,
  onOpenSettings,
}: Props) {
  const [editing, setEditing] = useState<{ id: string; value: string } | null>(null);

  // Si la pestaña que se estaba renombrando desaparece, cerramos el editor.
  useEffect(() => {
    if (editing && !tabs.some((tab) => tab.id === editing.id)) setEditing(null);
  }, [tabs, editing]);

  const commitRename = (): void => {
    if (!editing) return;
    const tab = tabs.find((item) => item.id === editing.id);
    const fallback = tab?.kind === "shell" ? "shell" : "claude";
    const value = editing.value.trim() || fallback;
    if (tab && value !== tab.subtitle) onRename(editing.id, value);
    setEditing(null);
  };

  return (
    <div className="tabs-bar" data-tauri-drag-region="deep">
      <div className="tabs-scroll" data-tauri-drag-region>
        {tabs.map((tab) => {
          const active = tab.id === activeTabId;
          const tooltipParts = [`${projectName} · ${tab.subtitle}`];
          if (tab.oscTitle && tab.oscTitle.trim()) tooltipParts.push(tab.oscTitle.trim());
          if (tab.exited) {
            tooltipParts.push(
              tab.exitCode === null
                ? "proceso terminado"
                : `proceso terminado (código ${tab.exitCode})`,
            );
          }
          return (
            <div
              key={tab.id}
              role="tab"
              aria-selected={active}
              tabIndex={0}
              title={tooltipParts.join("\n")}
              className={`tab${active ? " active" : ""}${tab.exited ? " exited" : ""}`}
              onClick={() => onSelect(tab.id)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onSelect(tab.id);
                }
              }}
            >
              <span
                className={`tab-icon${tab.kind === "claude" ? " claude" : ""}`}
                aria-hidden="true"
              >
                <FolderIcon size={16} />
              </span>
              <span className="tab-name">{projectName}</span>
              <span className="tab-sep" aria-hidden="true">
                ·
              </span>
              {editing && editing.id === tab.id ? (
                <input
                  className="tab-rename-input"
                  value={editing.value}
                  autoFocus
                  spellCheck={false}
                  onClick={(event) => event.stopPropagation()}
                  onChange={(event) =>
                    setEditing({ id: tab.id, value: event.currentTarget.value })
                  }
                  onBlur={commitRename}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      commitRename();
                    } else if (event.key === "Escape") {
                      event.preventDefault();
                      setEditing(null);
                    }
                  }}
                />
              ) : (
                <span
                  className="tab-subtitle"
                  title="Doble clic para renombrar"
                  onDoubleClick={(event) => {
                    event.stopPropagation();
                    setEditing({ id: tab.id, value: tab.subtitle });
                  }}
                >
                  {tab.subtitle}
                </span>
              )}
              {tab.exited && (
                <span
                  className="tab-status"
                  title={
                    tab.exitCode === null
                      ? "proceso terminado"
                      : `proceso terminado (código ${tab.exitCode})`
                  }
                />
              )}
              <button
                type="button"
                className="tab-close"
                title="Cerrar pestaña (Ctrl+W)"
                aria-label="Cerrar pestaña"
                onClick={(event) => {
                  event.stopPropagation();
                  onClose(tab.id);
                }}
              >
                <CloseIcon size={12} strokeWidth={2} />
              </button>
            </div>
          );
        })}
      </div>

      <button
        type="button"
        className="sq-btn tabs-add tip tip-below"
        data-tip="Nueva pestaña de Claude (Ctrl+T)"
        aria-label="Nueva pestaña de Claude"
        disabled={!hasProject}
        onClick={onNew}
      >
        <PlusIcon size={16} />
      </button>

      <button
        type="button"
        className="window-btn panel-toggle tip tip-below"
        data-tip={
          sidebarCollapsed
            ? `Mostrar barra lateral (${MOD_LABEL}+B)`
            : `Ocultar barra lateral (${MOD_LABEL}+B)`
        }
        aria-label={sidebarCollapsed ? "Mostrar barra lateral" : "Ocultar barra lateral"}
        aria-expanded={!sidebarCollapsed}
        onClick={onToggleSidebar}
      >
        <PanelIcon size={16} />
      </button>

      <WindowControls onOpenSettings={onOpenSettings} onRevealProject={onRevealProject} />
    </div>
  );
}
