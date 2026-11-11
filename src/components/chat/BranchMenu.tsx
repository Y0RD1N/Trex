import { memo, useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { createGitBranch, formatError, listGitBranches, switchGitBranch, type GitBranchInfo, type GitBranches } from "../../api";
import DropdownMenu from "../DropdownMenu";
import { BranchIcon, CheckIcon, ChevronIcon, CloseIcon, PlusIcon, RefreshIcon, SearchIcon } from "../Icons";
import type { FloatingAnchor } from "../../hooks/useFloatingPosition";
import "./BranchMenu.css";

export const GIT_BRANCH_CHANGED = "trex:git-branch-changed";

function BranchMenu({ cwd, branch, busy, visible, onChange, onMessage }: {
  cwd: string;
  branch: string;
  busy: boolean;
  visible: boolean;
  onChange: (name: string | null) => void;
  onMessage: (message: string) => void;
}) {
  const id = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState<FloatingAnchor | null>(null);
  const [snapshot, setSnapshot] = useState<GitBranches | null>(null);
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const mutating = useRef(false);
  const openRef = useRef(false);
  openRef.current = !!anchor;
  const currentCwd = useRef(cwd);
  const previousCwd = useRef(cwd);
  const mounted = useRef(true);
  currentCwd.current = cwd;

  useEffect(() => {
    if (previousCwd.current !== cwd) {
      previousCwd.current = cwd;
      generation.current++;
      setAnchor(null);
      setSnapshot(null);
      setError(null);
    }
    return () => { generation.current++; };
  }, [cwd]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { if (!visible) setAnchor(null); }, [visible]);
  useEffect(() => {
    if (creating && anchor) nameRef.current?.focus({ preventScroll: true });
  }, [creating, anchor]);

  const refresh = async (): Promise<void> => {
    const request = ++generation.current;
    setLoading(true);
    setError(null);
    try {
      const next = await listGitBranches(cwd);
      if (request !== generation.current) return;
      setSnapshot(next);
      onChange(next.current);
    } catch (cause) {
      if (request === generation.current) setError(formatError(cause));
    } finally {
      if (request === generation.current) setLoading(false);
    }
  };
  const open = (): void => {
    setQuery("");
    setCreating(false);
    setName("");
    setAnchor({ element: triggerRef.current! });
    void refresh();
  };
  const close = (): void => {
    setAnchor(null);
    triggerRef.current?.focus({ preventScroll: true });
  };
  const mutate = async (target: GitBranchInfo | null): Promise<void> => {
    if (busy || mutating.current || loading || !snapshot) return;
    if (target?.current) { close(); return; }
    const operationCwd = cwd;
    const newName = name.trim();
    if (!target && !newName) { nameRef.current?.focus(); return; }
    mutating.current = true;
    generation.current++;
    setPending(target?.reference ?? "create");
    setError(null);
    try {
      const next = target ? await switchGitBranch(operationCwd, target.reference) : await createGitBranch(operationCwd, newName);
      window.dispatchEvent(new CustomEvent(GIT_BRANCH_CHANGED, { detail: { cwd: operationCwd } }));
      if (mounted.current && currentCwd.current === operationCwd) {
        setSnapshot(next);
        onChange(next.current);
        if (openRef.current) close();
      }
      onMessage(target ? `Rama actual: ${next.current}` : `Rama creada: ${next.current}`);
    } catch (cause) {
      const message = formatError(cause);
      if (mounted.current && currentCwd.current === operationCwd) setError(message);
      onMessage(message);
      // Git puede haber cambiado HEAD antes de que falle un hook de checkout.
      window.dispatchEvent(new CustomEvent(GIT_BRANCH_CHANGED, { detail: { cwd: operationCwd } }));
    } finally {
      mutating.current = false;
      if (mounted.current) setPending(null);
    }
  };

  const items = (snapshot?.branches ?? []).filter(item => item.name.toLocaleLowerCase().includes(query.toLocaleLowerCase().trim()));
  const shown = items.slice(0, 200);
  const disabled = busy || !!pending || loading;
  const listKeys = (event: KeyboardEvent<HTMLElement>): void => {
    const options = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>('[data-branch-option]:not(:disabled)') ?? []);
    if (!options.length || !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    const index = options.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "ArrowUp" && index <= 0) { searchRef.current?.focus(); return; }
    const next = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1
      : event.key === "ArrowDown" ? (index + 1) % options.length : index - 1;
    options[next]?.focus({ preventScroll: true });
    options[next]?.scrollIntoView({ block: "nearest" });
  };

  return <>
    <button type="button" ref={triggerRef} className="chat-tray-info chat-branch-trigger" aria-haspopup="dialog"
      aria-expanded={!!anchor} aria-controls={anchor ? id : undefined} aria-label={`Rama de Git: ${branch}. Ver ramas`}
      title={`Rama de Git: ${branch}`} onClick={() => anchor ? close() : open()}
      onKeyDown={event => { if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); open(); } }}>
      <BranchIcon /><span>{branch}</span><ChevronIcon size={11} />
    </button>
    <DropdownMenu id={id} anchor={anchor} triggerRef={triggerRef} role="dialog" label={creating ? "Crear rama" : "Ramas de Git"}
      className="chat-glass-menu chat-branch-menu" onClose={() => setAnchor(null)}>
      <div className="chat-branch-header">
        <span className="chat-branch-heading"><BranchIcon size={16} /><strong>{creating ? "Crear rama" : "Ramas"}</strong></span>
        <div className="chat-branch-header-actions">
          {!creating && <button type="button" className="chat-branch-icon" aria-label="Actualizar ramas" title="Actualizar ramas"
            disabled={loading || !!pending} onClick={() => void refresh()}>{loading ? <span className="chat-spinner" /> : <RefreshIcon size={14} />}</button>}
          <button type="button" className="chat-branch-icon" aria-label="Cerrar ramas" title="Cerrar" onClick={close}><CloseIcon size={14} /></button>
        </div>
      </div>
      {creating ? <form className="chat-branch-create" onSubmit={event => { event.preventDefault(); void mutate(null); }}>
        <label htmlFor={`${id}-name`}>Nombre de la nueva rama</label>
        <input ref={nameRef} id={`${id}-name`} data-menu-autofocus className="input" value={name} autoComplete="off"
          spellCheck={false} placeholder="feature/nueva-idea" disabled={!!pending} onChange={event => { setName(event.target.value); setError(null); }} />
        <p className="chat-branch-base">Desde <span><BranchIcon size={12} />{snapshot?.current ?? branch}</span></p>
        {error && <div className="chat-branch-error" role="alert">{error}</div>}
        {busy && <div className="chat-branch-note" role="status">Puedes crear una rama cuando termine la tarea del agente.</div>}
        <div className="chat-branch-create-actions">
          <button type="button" className="btn btn-small" disabled={!!pending} onClick={() => { setCreating(false); setError(null); requestAnimationFrame(() => searchRef.current?.focus()); }}>Volver</button>
          <button type="submit" className="btn btn-primary btn-small" disabled={disabled || !name.trim()}>
            {pending ? <span className="chat-spinner" /> : <PlusIcon size={14} />} {pending ? "Creando…" : "Crear y cambiar"}
          </button>
        </div>
      </form> : <>
        <div className="chat-branch-search"><SearchIcon size={14} />
          <input ref={searchRef} data-menu-autofocus type="search" aria-label="Buscar ramas" placeholder="Buscar rama…" value={query}
            autoComplete="off" spellCheck={false} onChange={event => setQuery(event.target.value)}
            onKeyDown={event => { if (event.key === "ArrowDown") listKeys(event); else if (event.key === "Enter" && shown[0]) { event.preventDefault(); void mutate(shown[0]); } }} />
        </div>
        {busy && <div className="chat-branch-note" role="status">Puedes cambiar de rama cuando termine la tarea del agente.</div>}
        <div className="chat-branch-list" ref={listRef} onKeyDown={listKeys} aria-busy={loading}>
          {error && <div className="chat-branch-error" role="alert">{error}</div>}
          {loading && !snapshot && <div className="chat-branch-empty" role="status"><span className="chat-spinner" /> Cargando ramas…</div>}
          {!loading && !shown.length && !error && <div className="chat-branch-empty" role="status">{query ? "No hay ramas con ese nombre" : "No hay ramas disponibles"}</div>}
          {snapshot && [false, true].map(remote => {
            const group = shown.filter(item => item.remote === remote);
            if (!group.length) return null;
            return <div key={String(remote)} role="group" aria-label={remote ? "Ramas remotas" : "Ramas locales"}>
              <div className="chat-branch-section">{remote ? "Remotas" : "Locales"}</div>
              {group.map(item => {
                const tracking = item.remote ? snapshot?.branches.find(local => !local.remote && local.upstream === item.reference) : null;
                const detail = item.upstream?.replace(/^refs\/remotes\//, "")
                  ?? (item.remote ? tracking ? `Usar ${tracking.name}` : "Crear rama local al elegirla" : null);
                return <button key={item.reference} type="button" className={`context-item chat-branch-option${item.current ? " current" : ""}`}
                data-branch-option tabIndex={-1} aria-pressed={item.current} title={item.name} disabled={disabled && !item.current || !!pending}
                onClick={() => item.current ? close() : void mutate(item)}>
                <BranchIcon size={14} />
                <span className="chat-branch-option-text"><span>{item.name}</span>{detail && <small>{detail}</small>}</span>
                {pending === item.reference ? <span className="chat-spinner" /> : item.current && <span className="chat-branch-current"><CheckIcon size={12} /> Actual</span>}
              </button>; })}
            </div>;
          })}
          {items.length > shown.length && <div className="chat-branch-note">{shown.length} de {items.length} ramas. Usa la búsqueda para encontrar otra.</div>}
        </div>
        <div className="chat-branch-footer"><button type="button" className="context-item chat-branch-new" disabled={disabled || !snapshot}
          onClick={() => { setName(query.trim()); setCreating(true); setError(null); }}><PlusIcon size={15} /><span>Crear rama</span></button></div>
      </>}
    </DropdownMenu>
  </>;
}

/** Memorizado: el chat se repinta con cada tanda de texto y este componente no depende de ella. */
export default memo(BranchMenu);
