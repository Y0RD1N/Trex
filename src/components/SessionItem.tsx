import { useState } from "react";
import type { TabState } from "../types";
import { CloseIcon } from "./Icons";
import AgentIcon from "./AgentIcon";
import { activityLabel } from "../agentActivity";
import { sessionTitle } from "../sessionTitle";

type Props = {
  tab: TabState;
  /** Número de orden de la sesión dentro del proyecto (1 es la primera que se abrió). */
  number: number;
  active: boolean;
  onSelect: () => void;
  onClose: (trigger: HTMLButtonElement) => void;
  onRename: (name: string) => void;
};

export default function SessionItem({ tab, number, active, onSelect, onClose, onRename }: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const { label, nativeIndicator } = sessionTitle(tab);
  const activity = tab.exited ? "idle" : tab.activity;
  const stateLabel = tab.exited ? "Proceso finalizado" : activityLabel(activity);

  const commit = (): void => {
    const value = draft.trim();
    if (value) onRename(value);
    setEditing(false);
  };

  return (
    <div className={`session-row${active ? " active" : ""}${tab.exited ? " exited" : ""}`}>
      {editing ? (
        <input
          className="session-rename-input"
          aria-label="Nombre de la sesión"
          autoFocus
          value={draft}
          onChange={(event) => setDraft(event.currentTarget.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") { event.preventDefault(); commit(); }
            if (event.key === "Escape") { event.preventDefault(); setEditing(false); }
          }}
        />
      ) : (
        <button
          type="button"
          className="session-select tip"
          aria-current={active ? "page" : undefined}
          aria-label={`${label} · ${stateLabel}`}
          data-tip={`${label}\n${stateLabel}${tab.profileName ? ` · Perfil: ${tab.profileName} (${tab.command})` : ""}\nDoble clic para renombrar`}
          onClick={onSelect}
          onDoubleClick={() => { setDraft(label); setEditing(true); }}
        >
          <span className="session-kind" aria-hidden="true">
            <AgentIcon kind={tab.kind} size={14} activity={activity} nativeIndicator={nativeIndicator} />
          </span>
          <span className="session-no" aria-hidden="true">{String(number).padStart(2, "0")}</span>
          <span className="session-label">{label}</span>
          {tab.exited && <span className="session-ended" aria-label="Proceso finalizado" />}
        </button>
      )}
      <button
        type="button"
        className="session-close"
        aria-label={`Cerrar sesión ${label}`}
        title="Cerrar sesión"
        onClick={event => onClose(event.currentTarget)}
      >
        <CloseIcon size={12} />
      </button>
    </div>
  );
}
