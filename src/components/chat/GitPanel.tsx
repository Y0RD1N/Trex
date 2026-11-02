import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { formatError, gitProjectAction, gitProjectDiff, gitProjectStatus, listGitBranches, type GitBranches } from "../../api";
import { gitDiffRows, gitFileLabel, type GitProjectDiff, type GitProjectStatus } from "../../gitPanel";
import { formatClock } from "../../timeFormat";
import { useTimeFormat } from "../../hooks/useTimeFormat";
import { ArrowDownIcon, ArrowUpIcon, BranchIcon, CheckIcon, CloseIcon, FileIcon, RefreshIcon } from "../Icons";
import Select from "../Select";
import BranchMenu, { GIT_BRANCH_CHANGED } from "./BranchMenu";
import "./TaskPanel.css";
import "./GitPanel.css";

export default function GitPanel({ cwd, branch, busy, visible, open = true, panelId, onClose, onBranch, onMessage }: {
  cwd: string; branch: string; busy: boolean; visible: boolean; open?: boolean; panelId: string; onClose: () => void;
  onBranch: (branch: string | null) => void; onMessage: (text: string) => void;
}) {
  const id = useId(), timeFormat = useTimeFormat();
  const [state, setState] = useState<GitProjectStatus | null>(null), [branches, setBranches] = useState<GitBranches | null>(null);
  const [loading, setLoading] = useState(false), [pending, setPending] = useState<string | null>(null), [error, setError] = useState("");
  const [message, setMessage] = useState(""), [notice, setNotice] = useState(""), [selected, setSelected] = useState<string[]>([]);
  const [mode, setMode] = useState<"changes" | "compare">("changes"), [base, setBase] = useState("incoming"), [remote, setRemote] = useState<string | null>(null);
  const [path, setPath] = useState<string | null>(null), [comparison, setComparison] = useState<GitProjectDiff | null>(null);
  const [patch, setPatch] = useState<GitProjectDiff | null>(null), [diffLoading, setDiffLoading] = useState(false), [diffError, setDiffError] = useState("");
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const current = useRef(state), active = useRef(true), inflight = useRef(false), writing = useRef(false), generation = useRef(0);
  const viewMode = useRef(mode); viewMode.current = mode;
  const callbacks = useRef({ onBranch, onMessage }); callbacks.current = { onBranch, onMessage }; current.current = state;
  const accept = useCallback((next: GitProjectStatus) => {
    const changedBranch = current.current && current.current.branch !== next.branch;
    setState(next); current.current = next; callbacks.current.onBranch(next.branch ?? next.head?.slice(0, 7) ?? null);
    setSelected(previous => changedBranch ? [] : previous.filter(path => next.files.some(file => file.path === path)));
    setPath(previous => changedBranch || viewMode.current === "changes" && previous && !next.files.some(file => file.path === previous) ? null : previous);
  }, []);
  const refresh = useCallback(async (fetch = false, keepError = false) => {
    if (inflight.current || writing.current) return;
    inflight.current = true; const request = generation.current;
    setLoading(true);
    try {
      const next = await gitProjectStatus(cwd, fetch, remote);
      if (!active.current || request !== generation.current) return;
      accept(next); if (!keepError) setError(""); if (fetch && !next.remoteError) setCheckedAt(Date.now());
      const choices = await listGitBranches(cwd);
      if (active.current && request === generation.current) {
        setBranches(choices);
        setBase(previous => previous === "incoming" && !next.upstream ? choices.branches.find(b => !b.current)?.reference ?? previous : previous);
      }
    } catch (cause) { if (active.current && request === generation.current && !keepError) setError(formatError(cause)); }
    finally { inflight.current = false; if (active.current && request === generation.current) setLoading(false); }
  }, [cwd, remote, accept]);
  useEffect(() => {
    active.current = true; generation.current++; setState(null); current.current = null; setSelected([]); setPath(null); setPatch(null);
    return () => { active.current = false; generation.current++; };
  }, [cwd]);
  useEffect(() => {
    if (!visible) return;
    void refresh(true);
    let lastRemote = Date.now();
    const tick = () => { if (document.visibilityState === "hidden") return; const fetch = Date.now() - lastRemote >= 60000; if (fetch) lastRemote = Date.now(); void refresh(fetch); };
    const timer = window.setInterval(tick, 10000);
    const changed = (event: Event) => { if ((event as CustomEvent<{ cwd: string }>).detail?.cwd === cwd) void refresh(); };
    window.addEventListener("focus", tick); window.addEventListener(GIT_BRANCH_CHANGED, changed);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", tick); window.removeEventListener(GIT_BRANCH_CHANGED, changed); };
  }, [visible, cwd, refresh]);
  useEffect(() => {
    if (!state || mode !== "compare") return;
    let disposed = false; setComparison(null); setDiffError(""); setPath(null);
    void gitProjectDiff(cwd, null, base, remote).then(value => { if (!disposed) setComparison(value); }).catch(cause => { if (!disposed) setDiffError(formatError(cause)); });
    return () => { disposed = true; };
  }, [cwd, mode, base, remote, state?.token, state?.behind]);
  useEffect(() => {
    setPatch(null); if (!path) { setDiffLoading(false); return; }
    let disposed = false; setDiffLoading(true); setDiffError("");
    void gitProjectDiff(cwd, path, mode === "compare" ? base : null, remote).then(value => { if (!disposed) setPatch(value); })
      .catch(cause => { if (!disposed) setDiffError(formatError(cause)); }).finally(() => { if (!disposed) setDiffLoading(false); });
    return () => { disposed = true; };
  }, [cwd, path, mode, base, remote, state?.token]);
  const action = async (action: "commit" | "push" | "pull") => {
    if (!state || writing.current || inflight.current || busy) return;
    writing.current = true; setPending(action); setError(""); setNotice(""); const request = generation.current;
    try {
      const next = await gitProjectAction(cwd, state.token, action, selected, message, remote);
      const success = action === "commit" ? "Commit creado" : action === "push" ? "Rama subida al remoto" : "Cambios remotos incorporados";
      const detail = next.warning ? `${success}. ${next.warning}` : success;
      callbacks.current.onMessage(detail);
      if (active.current && request === generation.current) { accept(next); setNotice(detail); if (action === "commit") { setMessage(""); setSelected([]); } }
      window.dispatchEvent(new CustomEvent(GIT_BRANCH_CHANGED, { detail: { cwd } }));
    } catch (cause) {
      if (active.current && request === generation.current) setError(formatError(cause));
    } finally { writing.current = false; if (active.current && request === generation.current) { setPending(null); void refresh(false, true); } }
  };
  const files = mode === "changes" ? state?.files ?? [] : comparison?.files ?? [];
  const rows = useMemo(() => gitDiffRows(patch?.patch ?? ""), [patch]);
  const added = rows.filter(row => row.kind === "add").length, removed = rows.filter(row => row.kind === "del").length;
  const disabled = busy || !!pending || loading || !state || !!state.operation || state.files.some(file => file.conflicted);
  const diverged = !!state && state.ahead > 0 && state.behind > 0;
  return <aside id={panelId} className="chat-task-panel chat-git-panel" aria-labelledby={id} hidden={!open} inert={!open}
    onKeyDown={event => { if (event.key === "Escape" && !event.defaultPrevented) { event.preventDefault(); event.stopPropagation(); onClose(); } }}>
    <header><div><h2 id={id}><BranchIcon size={16} />Git</h2><p>Repositorio del proyecto</p></div>
      <div className="git-heading-actions"><button type="button" className="icon-btn" aria-label="Comprobar cambios remotos" title="Actualizar archivos y consultar el remoto" disabled={loading || !!pending} onClick={() => void refresh(true)}>
        {loading ? <span className="chat-spinner" /> : <RefreshIcon size={14} />}</button>
      <button type="button" className="icon-btn" aria-label="Cerrar panel de Git" onClick={onClose}><CloseIcon size={14} /></button></div></header>
    <div className="git-panel-scroll">
      <section className="git-branch-card" aria-label="Rama y sincronización">
        <BranchMenu cwd={cwd} branch={state?.branch ?? state?.head?.slice(0, 7) ?? branch} busy={busy || !!pending} visible={visible} onChange={onBranch} onMessage={onMessage} />
        {state && state.remotes.length > 1 && <Select aria-label="Remoto de Git" value={remote ?? state.remote ?? ""} options={state.remotes.map(name => ({ value: name, label: name }))} disabled={!!pending || loading} onChange={setRemote} />}
        <small title={state?.upstream ?? state?.remote ?? undefined}>{state?.remote ? `${state.remote}${state.upstream ? ` · ${state.upstream.replace(/^refs\/remotes\//, "")}` : " · Sin seguimiento configurado"}` : "Sin remoto configurado"}</small>
        <div className="git-sync-actions"><button type="button" className="btn btn-small" title="Subir los commits de esta rama al remoto" disabled={disabled || !state?.remote || !state.head || (state.ahead === 0 && !!state.upstream)} onClick={() => void action("push")}>
          <ArrowUpIcon size={13} /><span>{pending === "push" ? "Subiendo…" : "Push"}</span>{state && <small aria-label={`${state.ahead} commits por subir`}>{state.ahead}</small>}</button>
          <button type="button" className="btn btn-small" title="Traer los commits remotos a esta rama" disabled={disabled || !state?.behind || diverged || state.totalFiles > 0} onClick={() => void action("pull")}>
          <ArrowDownIcon size={13} /><span>{pending === "pull" ? "Trayendo…" : "Pull"}</span>{state && <small aria-label={`${state.behind} commits por traer`}>{state.behind}</small>}</button></div>
        {diverged && <p className="git-hint">Las ramas tienen commits diferentes. Revisa la comparación y resuelve la divergencia antes de hacer pull.</p>}
        {!!state?.behind && state.totalFiles > 0 && <p className="git-hint">Confirma o guarda tus cambios locales para poder hacer pull.</p>}
        {state?.detached && <p className="git-hint">HEAD separado. Elige una rama para confirmar o sincronizar.</p>}
        {state?.operation && <p className="git-hint">Git tiene una operación pendiente: {state.operation}. Resuélvela antes de continuar.</p>}
        {state?.remoteError && <p className="git-error" role="status">No se pudo comprobar el remoto: {state.remoteError}</p>}
      </section>
      {busy && <p className="git-hint git-banner">El agente está trabajando. Puedes revisar los cambios y sincronizar cuando termine.</p>}
      {error && <div className="git-error git-banner" role="alert">{error}<button type="button" onClick={() => void refresh()}>Actualizar estado</button></div>}
      {notice && <p className="git-success git-banner" role="status"><CheckIcon size={13} />{notice}</p>}
      {!state && loading && <p className="git-empty" role="status">Consultando el repositorio…</p>}
      {state && <>
        <div className="git-sections" role="tablist" aria-label="Vista de cambios"><button type="button" role="tab" aria-selected={mode === "changes"} onClick={() => { setMode("changes"); setPath(null); setDiffError(""); }}>Cambios <small>{state.totalFiles}</small></button>
          <button type="button" role="tab" aria-selected={mode === "compare"} onClick={() => { setMode("compare"); setPath(null); }}>Comparar</button></div>
        {mode === "compare" && <div className="git-comparison"><Select aria-label="Comparar con una rama" value={base} onChange={setBase} options={[
          ...(state.upstream ? [{ value: "incoming", label: "Cambios remotos por traer" }] : []),
          ...(branches?.branches ?? []).filter(b => !b.current).map(b => ({ value: b.reference, label: `Mi rama frente a ${b.name}`, group: b.remote ? "Remotas" : "Locales" })),
        ]} placeholder="Elige una rama" /><p className="git-hint">{base === "incoming" ? "Cambios de la rama remota desde el punto común." : "Cambios confirmados de tu rama desde el punto común."}</p></div>}
        {mode === "changes" && files.length > 0 && <div className="git-selection"><span>{selected.length} seleccionados</span><button type="button" disabled={!!pending} onClick={() => setSelected(selected.length === files.length ? [] : files.map(f => f.path))}>{selected.length === files.length ? "Quitar selección" : "Seleccionar todos"}</button></div>}
        <ul className="git-file-list" aria-label={mode === "changes" ? "Archivos modificados" : "Archivos de la comparación"}>
          {files.map(file => <li key={file.path} className={path === file.path ? "selected" : ""}>
            {mode === "changes" && <input type="checkbox" aria-label={`Incluir ${file.path} en el commit`} checked={selected.includes(file.path)} disabled={!!pending || file.conflicted}
              onChange={event => setSelected(previous => event.target.checked ? [...previous, file.path] : previous.filter(p => p !== file.path))} />}
            <button type="button" title={`${file.originalPath ? `${file.originalPath} → ` : ""}${file.path}`} onClick={() => setPath(path === file.path ? null : file.path)} aria-expanded={path === file.path}>
              <FileIcon size={13} /><span>{file.path}</span><small className={file.conflicted ? "conflicted" : ""}>{gitFileLabel(file)}</small></button></li>)}
        </ul>
        {!files.length && !diffError && <p className="git-empty">{mode === "compare" && !comparison ? "Consultando comparación…" : mode === "compare" ? "Las ramas no tienen diferencias en esta dirección." : "No hay cambios locales. Todo al día."}</p>}
        {state.totalFiles > state.files.length && <p className="git-hint git-banner">Mostrando {state.files.length} de {state.totalFiles} archivos.</p>}
        {diffError && <p className="git-error git-banner" role="alert">{diffError}</p>}
        {path && <section className="git-preview" aria-label={`Diferencias de ${path}`}><header><strong>{path}</strong><small>+{added} −{removed}</small></header>
          {diffLoading ? <p role="status">Cargando diferencias…</p> : <pre tabIndex={0} aria-label="Diferencias del archivo">{rows.length ? rows.map((row, i) => <span key={i} className={row.kind}>{row.kind === "add" ? "+" : row.kind === "del" ? "−" : " "}{row.text}{"\n"}</span>) : "Sin diferencias de contenido para mostrar."}</pre>}
          {patch?.truncated && <p className="git-hint">Vista previa abreviada por el tamaño del archivo.</p>}</section>}
        {mode === "changes" && <form className="git-commit" onSubmit={event => { event.preventDefault(); void action("commit"); }}>
          <label htmlFor={`${id}-message`}>Commit</label><textarea id={`${id}-message`} rows={2} maxLength={8192} placeholder="Describe los cambios…" value={message} disabled={!!pending} onChange={event => setMessage(event.target.value)} />
          <button type="submit" className="btn btn-primary btn-small" disabled={disabled || !selected.length || !message.trim() || diffLoading}>{pending === "commit" ? "Creando commit…" : `Crear commit${selected.length ? ` · ${selected.length}` : ""}`}</button>
          <small>Incluye la versión actual de los archivos que selecciones.</small></form>}
      </>}
    </div><footer>{checkedAt ? `Remoto comprobado a las ${formatClock(checkedAt, timeFormat)}` : "Los cambios locales se actualizan mientras este panel está abierto."}</footer>
  </aside>;
}
