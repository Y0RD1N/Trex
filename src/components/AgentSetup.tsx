import { useId, type KeyboardEvent, type ReactNode } from "react";
import { agentPermissionOptions } from "../agentPermissions";
import type { Stage } from "../hooks/useWorkflowStage";
import { BoltIcon } from "./Icons";
import Select from "./Select";
import "./AgentSetup.css";

export type SegmentedOption<T extends string> = { value: T; label: ReactNode; disabled?: boolean };

/** Grupo de opciones excluyentes, con flechas para moverse y un único tabulador. */
export function Segmented<T extends string>({ value, options, onChange, label, labelledBy, disabled, className = "" }: {
  value: T; options: SegmentedOption<T>[]; onChange: (value: T) => void;
  label?: string; labelledBy?: string; disabled?: boolean; className?: string;
}) {
  const move = (event: KeyboardEvent<HTMLDivElement>): void => {
    const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
    if (!step || disabled) return;
    const group = event.currentTarget;
    const enabled = options.filter(option => !option.disabled);
    const index = enabled.findIndex(option => option.value === value);
    const next = enabled[(index + step + enabled.length) % enabled.length];
    if (!next) return;
    event.preventDefault();
    event.stopPropagation();
    onChange(next.value);
    requestAnimationFrame(() => group.querySelector<HTMLElement>('[aria-checked="true"]')?.focus());
  };
  return <div className={`segmented ${className}`.trim()} role="radiogroup" aria-label={label} aria-labelledby={labelledBy} onKeyDown={move}>
    {options.map(option => <button key={option.value} type="button" role="radio" aria-checked={option.value === value}
      tabIndex={option.value === value ? 0 : -1} disabled={disabled || option.disabled} onClick={() => onChange(option.value)}>{option.label}</button>)}
  </div>;
}

/** Alterna entre el flujo de dos agentes y el equipo con subagentes. */
export function SetupSwitch({ team, disabled, onChange }: { team: boolean; disabled: boolean; onChange: (team: boolean) => void }) {
  return <Segmented className="setup-switch" label="Tipo de flujo" value={team ? "team" : "pair"} disabled={disabled}
    options={[{ value: "pair", label: "Dos agentes" }, { value: "team", label: "Equipo" }]}
    onChange={value => { if ((value === "team") !== team) onChange(value === "team"); }} />;
}

export function Field({ label, htmlFor, labelId, title, wide, children }: {
  label: string; htmlFor?: string; labelId?: string; title?: string; wide?: boolean; children: ReactNode;
}) {
  return <div className={`agent-field${wide ? " wide" : ""}`} title={title || undefined}>
    {htmlFor ? <label id={labelId} htmlFor={htmlFor}>{label}</label> : <span id={labelId} className="agent-field-label">{label}</span>}
    {children}
  </div>;
}

/**
 * Modelo, esfuerzo, velocidad y permisos de un agente. Sin textos de ayuda: los
 * motivos de un control desactivado salen al pasar el cursor y los avisos
 * (catálogo caído, modelo retirado) solo aparecen cuando hacen falta.
 */
export function AgentFields({ stage, mode, onMode, onModel, onEffort, disabled, accessibleName }: {
  stage: Stage;
  /** Permiso vigente (el elegido o el predeterminado de este rol). */
  mode: string;
  onMode: (mode: string | null) => void;
  onModel?: () => void;
  onEffort?: () => void;
  disabled: boolean;
  accessibleName: string;
}) {
  const id = useId();
  const unusable = disabled || !stage.profile;
  const speedLabel = `${id}-speed`;
  return <>
    <div className="agent-fields">
      <Field label="Modelo" htmlFor={`${id}-model`}>
        <Select id={`${id}-model`} aria-label={`Modelo · ${accessibleName}`} aria-invalid={!stage.loading && !stage.validModel || undefined}
          className="agent-select" align="start" value={stage.model} options={stage.options}
          placeholder={stage.loading ? "Cargando…" : "Elegir"} disabled={unusable || stage.loading}
          onChange={value => { onModel?.(); stage.setModel(value); }} />
      </Field>
      <Field label="Esfuerzo" htmlFor={`${id}-effort`} title={stage.effortLevels.length ? undefined : stage.effortHint}>
        <Select id={`${id}-effort`} aria-label={`Esfuerzo · ${accessibleName}`} className="agent-select" align="start"
          value={stage.effort ?? ""} options={stage.effortOptions} disabled={unusable || !stage.effortLevels.length}
          onChange={value => { onEffort?.(); stage.setEffort(value); }} />
      </Field>
      <Field label="Velocidad" labelId={speedLabel} title={stage.speedHint}>
        <Segmented labelledBy={speedLabel} className="agent-speed" value={stage.fast ? "fast" : "standard"} disabled={unusable || !stage.speed}
          options={[{ value: "standard", label: "Estándar" }, { value: "fast", label: <><BoltIcon size={12} />Rápida</> }]}
          onChange={value => stage.setFast(value === "fast")} />
      </Field>
      <Field label="Permisos" htmlFor={`${id}-mode`}>
        <Select id={`${id}-mode`} aria-label={`Permisos · ${accessibleName}`} className="agent-select" align="start" disabled={unusable}
          value={mode} options={agentPermissionOptions(stage.profile?.provider ?? "claude")} onChange={value => onMode(value || null)} />
      </Field>
    </div>
    {(stage.error || !stage.loading && !stage.validModel) && <p className={`agent-note${stage.error ? "" : " error"}`} role="status">
      {stage.error ? <>No se pudo cargar el catálogo de modelos.
        <button type="button" className="agent-link" disabled={disabled} onClick={stage.retry}>Reintentar</button></>
        : "El modelo elegido ya no está disponible."}
    </p>}
  </>;
}
