import type { LauncherProfile, TabState } from "../types";
import type { SplitLayout } from "../splitLayout";
import { sessionLabel } from "../sessionTitle";
import { MaximizeIcon, RestoreIcon, RotateIcon } from "./Icons";

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
    <select aria-label={`Sesión del panel ${index + 1}`} value={id ? `tab:${id}` : ""} onChange={event => {
      const value = event.currentTarget.value;
      if (value.startsWith("tab:")) onSelect(value.slice(4));
      else if (value.startsWith("new:")) onNew(value.slice(4));
      else if (value === "shell") onNew(null);
    }}>
      {!id && <option value="" disabled>Elegir sesión…</option>}
      <optgroup label="Sesiones del proyecto">
        {tabs.map(tab => <option key={tab.id} value={`tab:${tab.id}`} disabled={tab.id !== id && layout.panes.includes(tab.id)}>{sessionLabel(tab)}</option>)}
      </optgroup>
      <optgroup label="Abrir nueva sesión">
        {profiles.map(profile => <option key={profile.id} value={`new:${profile.id}`}>{profile.name}</option>)}
        <option value="shell">Terminal</option>
      </optgroup>
    </select>
    {!expanded && layout.direction !== "grid" && <button className="icon-btn tip tip-below" aria-label="Cambiar orientación de los paneles" data-tip="Alternar columnas / filas" onClick={onRotate}><RotateIcon /></button>}
    {id && <button className="icon-btn tip tip-below" aria-label={expanded ? "Restaurar paneles" : `Mostrar solo panel ${index + 1}`} data-tip={expanded ? "Volver a la distribución anterior" : "Mostrar solo esta terminal"} onClick={onSingle}>{expanded ? <RestoreIcon /> : <MaximizeIcon />}</button>}
  </div>;
}
