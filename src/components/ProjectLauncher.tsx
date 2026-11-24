import { useEffect, useId, useMemo, useRef, useState } from "react";
import { listProjectFolders } from "../api";
import { launchCandidates, LAUNCHER_VISIBLE_LIMIT, rankCandidates, type LaunchCandidate, type ProjectFolder } from "../projectLauncher";
import { shortcutLabel } from "../shortcuts";
import type { LauncherProfile, Project } from "../types";
import AgentIcon from "./AgentIcon";
import FeatureDialog, { type FeatureDialogMotionProps } from "./FeatureDialog";
import { ArrowRightIcon, ChevronIcon, CloseIcon, FolderIcon, FolderPlusIcon, SearchIcon } from "./Icons";
import ProjectCore from "./ProjectCore";
import "./CommandPalette.css";
import "./ProjectLauncher.css";

type Props = {
  projects: Project[];
  /** Carpetas raíz de Ajustes; sin ellas solo aparecen los proyectos de trex. */
  roots: string[];
  profiles: LauncherProfile[];
  initialProfileId: string;
  /** Atajo que abre el lanzador; null mientras está apagado (sin carpetas). */
  shortcut: string | null;
  onLaunch: (path: string, profileId: string) => void;
  onAddRoot: () => void;
  onClose: () => void;
} & FeatureDialogMotionProps;

/** Lanzador de proyectos: escribes el nombre, eliges agente con Tab y Enter abre el chat. */
export default function ProjectLauncher({ projects, roots, profiles, initialProfileId, shortcut, onLaunch, onAddRoot, onClose, surfaceRef, ...motion }: Props) {
  const localSurfaceRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const executingRef = useRef(false);
  const pendingActionRef = useRef<(() => void) | null>(null);
  const id = useId();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const [profileId, setProfileId] = useState(() => profiles.some(profile => profile.id === initialProfileId) ? initialProfileId : profiles[0]?.id ?? "");
  const [folders, setFolders] = useState<ProjectFolder[]>([]);
  const [missing, setMissing] = useState<string[]>([]);
  const [loading, setLoading] = useState(roots.length > 0);
  const [readError, setReadError] = useState(false);
  const rootsKey = roots.join("\n");

  useEffect(() => {
    if (!roots.length) { setFolders([]); setMissing([]); setLoading(false); return; }
    let current = true;
    setLoading(true); setReadError(false);
    listProjectFolders(roots).then(result => {
      if (!current) return;
      setFolders(result.folders); setMissing(result.missing);
    }).catch(() => { if (current) setReadError(true); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [rootsKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const candidates = useMemo(() => launchCandidates(projects, folders), [projects, folders]);
  const ranked = useMemo(() => rankCandidates(candidates, query), [candidates, query]);
  const visible = ranked.slice(0, LAUNCHER_VISIBLE_LIMIT);
  const hidden = ranked.length - visible.length;
  useEffect(() => setSelected(0), [query]);
  const index = Math.min(selected, Math.max(0, visible.length - 1));
  useEffect(() => {
    document.getElementById(`${id}-${index}`)?.scrollIntoView({ block: "nearest" });
  }, [id, index]);
  useEffect(() => () => {
    const run = pendingActionRef.current;
    pendingActionRef.current = null;
    // Igual que la paleta: se abre cuando el diálogo ya devolvió el foco y la inercia del fondo.
    if (run) requestAnimationFrame(run);
  }, []);

  const profile = profiles.find(item => item.id === profileId) ?? null;
  const launch = (candidate: LaunchCandidate): void => {
    if (executingRef.current || !profile) return;
    executingRef.current = true;
    const chosen = profile.id;
    pendingActionRef.current = () => onLaunch(candidate.path, chosen);
    onClose();
  };
  const cycleProfile = (step: 1 | -1): void => {
    if (profiles.length < 2) return;
    const position = Math.max(0, profiles.findIndex(item => item.id === profileId));
    setProfileId(profiles[(position + step + profiles.length) % profiles.length].id);
  };
  const addRoot = (): void => {
    if (executingRef.current) return;
    executingRef.current = true;
    pendingActionRef.current = onAddRoot;
    onClose();
  };

  const summary = query.trim() ? "Resultados"
    : roots.length ? `${roots.length === 1 ? "1 carpeta de proyectos" : `${roots.length} carpetas de proyectos`} y los proyectos de trex`
    : "Proyectos de trex";
  const count = loading && !folders.length ? "Leyendo carpetas…"
    : ranked.length === 1 ? "1 proyecto" : `${ranked.length} proyectos`;

  return (
    <FeatureDialog
      {...motion}
      surfaceRef={surfaceRef ?? localSurfaceRef}
      title="Abrir proyecto"
      onClose={onClose}
      className="command-dialog launcher-dialog"
      footer={
        <div className="command-keyboard">
          <span><kbd>↑</kbd><kbd>↓</kbd> <span>Elegir</span></span>
          <span><kbd>↵</kbd> <span>Abrir</span></span>
          {profiles.length > 1 && <span><kbd>Tab</kbd> <span>Cambiar agente</span></span>}
          <span><kbd>Esc</kbd> <span>Cerrar</span></span>
          {shortcut && <span className="launcher-shortcut-hint"><kbd>{shortcutLabel(shortcut)}</kbd> <span>abre esta ventana</span></span>}
        </div>
      }
    >
      <div className="command-search">
        <SearchIcon size={18} />
        <input
          ref={inputRef}
          data-autofocus
          className="input"
          role="combobox"
          aria-label="Buscar un proyecto por su nombre"
          aria-expanded="true"
          aria-controls={`${id}-list`}
          aria-autocomplete="list"
          aria-describedby={`${id}-agent`}
          aria-activedescendant={visible.length ? `${id}-${index}` : undefined}
          placeholder="Escribe el nombre del proyecto…"
          spellCheck={false}
          autoComplete="off"
          value={query}
          onChange={event => setQuery(event.currentTarget.value)}
          onKeyDown={event => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              setSelected(visible.length ? (index + (event.key === "ArrowDown" ? 1 : -1) + visible.length) % visible.length : 0);
            } else if (event.key === "Enter" && visible[index]) {
              event.preventDefault();
              launch(visible[index]);
            } else if (event.key === "Tab" && !event.ctrlKey && !event.altKey && !event.metaKey && profiles.length > 1) {
              // Tab elige el agente sin salir del buscador: es lo único que se cambia aquí.
              event.preventDefault();
              event.stopPropagation();
              cycleProfile(event.shiftKey ? -1 : 1);
            }
          }}
        />
        {query && <button type="button" className="command-clear" aria-label="Limpiar búsqueda" title="Limpiar búsqueda"
          onClick={() => { setQuery(""); inputRef.current?.focus({ preventScroll: true }); }}><CloseIcon size={15} /></button>}
      </div>

      <div className="launcher-agents" role="radiogroup" aria-label="Agente con el que se abre">
        <span className="launcher-agents-label" aria-hidden="true">Abrir con</span>
        {profiles.map(item => (
          <button key={item.id} type="button" role="radio" aria-checked={item.id === profileId} tabIndex={-1}
            className={`launcher-agent${item.id === profileId ? " selected" : ""}`}
            onClick={() => { setProfileId(item.id); inputRef.current?.focus({ preventScroll: true }); }}>
            <AgentIcon kind={item.provider} size={14} />
            <span>{item.name}</span>
          </button>
        ))}
        <span id={`${id}-agent`} className="sr-only" aria-live="polite">{profile ? `Se abrirá con ${profile.name}` : "No hay agentes configurados"}</span>
      </div>

      <div className="command-summary">
        <span>{summary}</span>
        <span role="status" aria-live="polite" aria-atomic="true">{count}</span>
      </div>
      {(missing.length > 0 || readError) && <p className="launcher-warning" role="status">
        {readError ? "No se pudieron leer las carpetas de proyectos." : `No se encontró ${missing.length === 1 ? "la carpeta" : "las carpetas"} ${missing.join(", ")}. Revísalas en Ajustes → Proyectos.`}
      </p>}

      <div id={`${id}-list`} role="listbox" aria-label="Proyectos" className="command-results">
        {!roots.length && !query.trim() && (
          <div className="launcher-setup">
            <p>Añade la carpeta donde guardas tus proyectos y aparecerán todos aquí, sin añadirlos uno a uno.</p>
            <button type="button" className="btn btn-small" onClick={addRoot}><FolderPlusIcon size={15} />Añadir carpeta de proyectos</button>
          </div>
        )}
        {visible.length > 0 && <div className="command-section">
          {visible.map((candidate, position) => (
            <button
              id={`${id}-${position}`}
              key={candidate.key}
              type="button"
              role="option"
              aria-selected={index === position}
              tabIndex={-1}
              className={`command-result${index === position ? " selected" : ""}`}
              onMouseMove={() => setSelected(position)}
              onClick={() => launch(candidate)}
            >
              {index === position && <span className="row-pointer" aria-hidden="true"><ChevronIcon size={12} strokeWidth={2} /></span>}
              <span className="command-icon" aria-hidden="true">
                {candidate.projectId ? <ProjectCore seed={candidate.projectId} /> : <FolderIcon size={18} />}
              </span>
              <span className="command-label">
                <strong title={candidate.name}>{candidate.name}</strong>
                <small title={candidate.path}>{candidate.path}</small>
              </span>
              <span className="command-tail">
                {candidate.projectId && <span className="launcher-tag">en trex</span>}
                <span className="command-open" aria-hidden="true"><ArrowRightIcon size={15} /></span>
              </span>
            </button>
          ))}
          {hidden > 0 && <p className="launcher-more">{hidden === 1 ? "Y 1 más" : `Y ${hidden} más`}: sigue escribiendo para afinar.</p>}
        </div>}
        {!visible.length && !loading && (roots.length > 0 || projects.length > 0 || query.trim()) && (
          <div className="command-empty">
            <span aria-hidden="true"><SearchIcon size={22} /></span>
            <strong>{query.trim() ? "Ningún proyecto se llama así" : "No hay proyectos todavía"}</strong>
            <p>{query.trim() ? "Prueba con otra parte del nombre o con las letras en orden: «trx» encuentra «trex»." : "Las carpetas elegidas están vacías."}</p>
          </div>
        )}
      </div>
    </FeatureDialog>
  );
}
