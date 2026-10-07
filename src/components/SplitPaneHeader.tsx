import type { LauncherProfile, TabState } from "../types";
import type { SplitLayout } from "../splitLayout";
import { sessionLabel } from "../sessionTitle";
import { MaximizeIcon, RestoreIcon, RotateIcon } from "./Icons";
import Select from "./Select";
import AgentIcon from "./AgentIcon";

export default function SplitPaneHeader({ layout, index, tabs, profiles, expanded = false, onSelect, onNew, onRotate, onSingle }: {
  layout: SplitLayout;
  index: number;
  tabs: TabState[];
  profiles: LauncherProfile[];
  expanded?: boolean;
  onSelect: (id: string) => void;
  onNew: (profileId: string | null) => void;
  onRotate: () => void;
  onSingle: () => void;
}) {
  const id = layout.panes[index];
  return <div className="split-pane-header">
    <span className="split-pane-number" aria-hidden="true">{index + 1}</span>
    <Select className="pane-session-picker" aria-label={`Sesión del panel ${index + 1}`} value={id ? `tab:${id}` : ""} placeholder="Elegir sesión…" onChange={value => {
      if (value.startsWith("tab:")) onSelect(value.slice(4));
      else if (value.startsWith("new:")) onNew(value.slice(4));
      else if (value === "shell") onNew(null);
    }} options={[
      ...tabs.map(tab => ({ value: `tab:${tab.id}`, label: sessionLabel(tab), icon: <AgentIcon kind={tab.kind} size={16} />,
        group: "Sesiones del proyecto", disabled: tab.id !== id && layout.panes.includes(tab.id),
        description: tab.id !== id && layout.panes.includes(tab.id) ? "En otro panel" : undefined })),
      ...profiles.map(profile => ({ value: `new:${profile.id}`, label: profile.name, icon: <AgentIcon kind={profile.provider} size={16} />, group: "Abrir nueva sesión" })),
      { value: "shell", label: "Terminal", icon: <AgentIcon kind="shell" size={16} />, group: "Abrir nueva sesión" },
    ]} />
    {!expanded && layout.direction !== "grid" && <button className="icon-btn tip tip-below" aria-label="Cambiar orientación de los paneles" data-tip="Alternar columnas / filas" onClick={onRotate}><RotateIcon /></button>}
    {id && <button className="icon-btn tip tip-below" aria-label={expanded ? "Restaurar paneles" : `Mostrar solo panel ${index + 1}`} data-tip={expanded ? "Volver a la distribución anterior" : "Mostrar solo esta terminal"} onClick={onSingle}>{expanded ? <RestoreIcon /> : <MaximizeIcon />}</button>}
  </div>;
}
