/**
 * Panel «Memoria» del chat: lo que recuerdan todos los agentes (Claude Code, Codex, Antigravity y
 * Trex CLI) de este proyecto y de la persona. Aquí se revisa lo que guardan, se corrige, se lleva a
 * lo global, se olvida (a la papelera) y se recupera. La memoria vive en `memory.rs`.
 */
import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { openPath } from "@tauri-apps/plugin-opener";
import { AlertIcon, CheckIcon, CloseIcon, FolderIcon, GlobeIcon, MemoryIcon, PencilIcon, PlusIcon, RotateIcon, TrashIcon } from "../Icons";
import {
  MEMORY_CHANGED, MEMORY_KINDS, memoryApprove, memoryForget, memoryKindLabel, memoryMove, memoryName, memoryOverview, memoryRead,
  memoryRestore, memorySetEnabled, memoryWrite, type MemoryKind, type MemoryOverview, type MemoryScope, type MemorySummary,
} from "../../memory";
import { formatDateTime } from "../../timeFormat";
import { useTimeFormat } from "../../hooks/useTimeFormat";
import "./TaskPanel.css";
import "./MemoryPanel.css";

type Draft = { scope: MemoryScope; title: string; kind: MemoryKind; description: string; body: string; version: string | null; name: string | null };
const emptyDraft = (scope: MemoryScope): Draft => ({ scope, title: "", kind: scope === "global" ? "user" : "project", description: "", body: "", version: null, name: null });

const normalize = (text: string): string => text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

export default function MemoryPanel({ project, onClose, panelId }: { project: string; onClose: () => void; panelId?: string }) {
  const id = useId();
  const timeFormat = useTimeFormat();
  const [overview, setOverview] = useState<MemoryOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [bodies, setBodies] = useState<Record<string, string>>({});
  const [draft, setDraft] = useState<Draft | null>(null);

  const refresh = useCallback(() => {
    void memoryOverview(project).then(next => { setOverview(next); setError(null); },
      reason => setError(`No se pudo leer la memoria: ${String(reason)}`));
  }, [project]);
  useEffect(() => { refresh(); }, [refresh]);
  // Los agentes guardan durante sus turnos: el panel se pone al día solo.
  useEffect(() => {
    const listener = (event: Event): void => { if ((event as CustomEvent<{ project?: string }>).detail?.project === project) refresh(); };
    window.addEventListener(MEMORY_CHANGED, listener);
    return () => window.removeEventListener(MEMORY_CHANGED, listener);
  }, [project, refresh]);

  const key = (entry: Pick<MemorySummary, "scope" | "name">): string => `${entry.scope}:${entry.name}`;
  const act = (work: () => Promise<unknown>, after?: () => void): void => {
    setBusy(true);
    setError(null);
    void work().then(() => { after?.(); refresh(); }, reason => setError(String(reason))).finally(() => setBusy(false));
  };
  const toggle = (entry: MemorySummary): void => {
    const k = key(entry);
    if (open === k) { setOpen(null); return; }
    setOpen(k);
    setDraft(null);
    void memoryRead(project, entry.scope, entry.name).then(read => setBodies(current => ({ ...current, [k]: read.body })),
      reason => setError(`No se pudo leer «${entry.name}»: ${String(reason)}`));
  };
  const edit = (entry: MemorySummary): void => setDraft({ scope: entry.scope, title: entry.name, kind: entry.kind, description: entry.description,
    body: bodies[key(entry)] ?? "", version: entry.version, name: entry.name });
  const save = (): void => {
    if (!draft) return;
    const name = draft.name ?? memoryName(draft.title);
    if (!name) { setError("Pon un título con letras o números."); return; }
    act(() => memoryWrite(project, { scope: draft.scope, name, kind: draft.kind, description: draft.description, body: draft.body, version: draft.version }),
      () => { setDraft(null); setOpen(`${draft.scope}:${name}`); setBodies(current => ({ ...current, [`${draft.scope}:${name}`]: draft.body })); });
  };

  const memories = useMemo(() => {
    const words = normalize(query).split(/\s+/).filter(Boolean);
    return (overview?.memories ?? []).filter(entry => {
      const text = normalize(`${entry.name} ${entry.description} ${bodies[key(entry)] ?? ""}`);
      return words.every(word => text.includes(word));
    });
  }, [overview, query, bodies]);
  const flagged = memories.filter(entry => entry.flagged);
  const projectEntries = memories.filter(entry => !entry.flagged && entry.scope === "project");
  const globalEntries = memories.filter(entry => !entry.flagged && entry.scope === "global");
  const enabled = overview?.enabled !== false;

  const form = draft && <form className="memory-form" onSubmit={event => { event.preventDefault(); save(); }}>
    {!draft.name && <label>Título<input className="input" value={draft.title} maxLength={64} autoFocus required
      onChange={event => setDraft({ ...draft, title: event.target.value })} placeholder="Estilo de commits" /></label>}
    <label>Resumen (una línea: decide cuándo es relevante)<input className="input" value={draft.description} maxLength={200} required
      onChange={event => setDraft({ ...draft, description: event.target.value })} /></label>
    <div className="memory-form-row">
      <label>Tipo<select className="input" value={draft.kind} onChange={event => setDraft({ ...draft, kind: event.target.value as MemoryKind })}>
        {MEMORY_KINDS.map(kind => <option key={kind.value} value={kind.value} title={kind.hint}>{kind.label}</option>)}</select></label>
      {!draft.name && <label>Ámbito<select className="input" value={draft.scope} onChange={event => setDraft({ ...draft, scope: event.target.value as MemoryScope })}>
        <option value="project">Este proyecto</option><option value="global">Global (todos los proyectos)</option></select></label>}
    </div>
    <label>Contenido<textarea className="input" rows={6} value={draft.body} maxLength={8192} required
      onChange={event => setDraft({ ...draft, body: event.target.value })} placeholder={"El hecho y su porqué.\n**Why:** …\n**How to apply:** …"} /></label>
    <div className="memory-actions">
      <button type="submit" className="btn btn-small btn-primary" disabled={busy}>Guardar</button>
      <button type="button" className="btn btn-small" onClick={() => setDraft(null)}>Cancelar</button>
    </div>
  </form>;

  const item = (entry: MemorySummary) => {
    const k = key(entry), expanded = open === k;
    return <li key={k} className={entry.flagged ? "is-flagged" : undefined}>
      <button type="button" className="memory-entry" aria-expanded={expanded} onClick={() => toggle(entry)}>
        <span className="memory-entry-head"><strong>{entry.name}</strong><span className="memory-kind">{memoryKindLabel(entry.kind)}</span></span>
        <span className="memory-entry-description">{entry.description}</span>
      </button>
      {expanded && (draft?.name === entry.name && draft.scope === entry.scope ? form : <div className="memory-detail">
        {entry.flagged && <p className="memory-warning"><AlertIcon size={13} />Parece dar órdenes en lugar de recordar algo: está apartado y ningún agente lo ve hasta que lo apruebes.</p>}
        <div className="memory-body">{bodies[k] ?? "Cargando…"}</div>
        <p className="memory-meta">{[entry.source ? `Guardado por ${entry.source}` : null, formatDateTime(entry.modifiedMs, timeFormat)].filter(Boolean).join(" · ")}</p>
        <div className="memory-actions">
          {entry.flagged && <button type="button" className="btn btn-small" disabled={busy} onClick={() => act(() => memoryApprove(project, entry))}><CheckIcon size={13} />Aprobar</button>}
          <button type="button" className="btn btn-small" disabled={busy || bodies[k] === undefined} onClick={() => edit(entry)}><PencilIcon size={13} />Editar</button>
          {!entry.flagged && <button type="button" className="btn btn-small" disabled={busy} onClick={() => act(() => memoryMove(project, entry), () => setOpen(null))}>
            <GlobeIcon size={13} />{entry.scope === "project" ? "Hacer global" : "Solo este proyecto"}</button>}
          <button type="button" className="btn btn-small" disabled={busy} onClick={() => act(() => memoryForget(project, entry), () => setOpen(null))}><TrashIcon size={13} />Olvidar</button>
        </div>
      </div>)}
    </li>;
  };
  const section = (title: string, list: MemorySummary[], empty: string) => <section className="memory-section">
    <h3>{title}<small>{list.length}</small></h3>
    {list.length ? <ul className="memory-list">{list.map(item)}</ul> : <p className="memory-empty">{empty}</p>}
  </section>;

  return <aside id={panelId} className="chat-task-panel memory-panel" aria-labelledby={id}>
    <header><div><h2 id={id}><MemoryIcon size={16} />Memoria</h2>
      <p>Compartida por Claude Code, Codex, Antigravity y Trex CLI.</p></div>
      <button type="button" className="icon-btn" onClick={onClose} aria-label="Contraer la memoria"><CloseIcon size={14} /></button></header>
    <div className="memory-toolbar">
      <label className="memory-switch"><span>{enabled ? "Activada" : "Desactivada"}</span>
        <input type="checkbox" role="switch" checked={enabled} disabled={busy || !overview}
          onChange={event => act(() => memorySetEnabled(project, event.target.checked))} /></label>
      <input className="input memory-search" type="search" value={query} placeholder="Buscar…" aria-label="Buscar en la memoria" onChange={event => setQuery(event.target.value)} />
      <button type="button" className="icon-btn tip" data-tip="Nuevo recuerdo" aria-label="Nuevo recuerdo" disabled={busy}
        onClick={() => { setOpen(null); setDraft(emptyDraft("project")); }}><PlusIcon size={14} /></button>
    </div>
    {!enabled && <p className="memory-off">Apagada: las sesiones nuevas no reciben ni guardan recuerdos (las abiertas, al reiniciarse). Los recuerdos se conservan.</p>}
    {error && <p className="memory-error" role="alert">{error}</p>}
    <div className="memory-scroll">
      {draft && !draft.name && <section className="memory-section"><h3>Nuevo recuerdo</h3>{form}</section>}
      {flagged.length > 0 && section("Por revisar", flagged, "")}
      {section("Este proyecto", projectEntries, query ? "Nada coincide." : "Aún no hay recuerdos de este proyecto.")}
      {section("Global", globalEntries, query ? "Nada coincide." : "Aún no hay recuerdos tuyos para todos los proyectos.")}
      {(overview?.problems.length ?? 0) > 0 && <section className="memory-section"><h3>No se pudieron leer<small>{overview!.problems.length}</small></h3>
        <ul className="memory-plain">{overview!.problems.map(problem => <li key={`${problem.scope}:${problem.file}`}><AlertIcon size={13} /><span><strong>{problem.file}</strong> {problem.reason}</span></li>)}</ul></section>}
      {(overview?.trash.length ?? 0) > 0 && <details className="memory-section memory-trash"><summary>Papelera<small>{overview!.trash.length}</small></summary>
        <ul className="memory-plain">{overview!.trash.map(entry => <li key={`${entry.scope}:${entry.file}`}>
          <span><strong>{entry.name}</strong> {entry.description}<small>{formatDateTime(entry.deletedMs, timeFormat)}{entry.scope === "global" ? " · global" : ""}</small></span>
          <button type="button" className="btn btn-small" disabled={busy} onClick={() => act(() => memoryRestore(project, entry))}><RotateIcon size={13} />Recuperar</button>
        </li>)}</ul></details>}
    </div>
    <footer className="memory-footer">
      <p>Son archivos Markdown con historial: puedes editarlos a mano.</p>
      {overview && <button type="button" className="btn btn-small" onClick={() => void openPath(overview.projectDir).catch(reason => setError(String(reason)))}>
        <FolderIcon size={13} />Abrir carpeta</button>}
    </footer>
  </aside>;
}
