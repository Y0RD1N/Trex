import { MOD_LABEL } from "../platform";
import type { LauncherProfile, Project } from "../types";
import { FolderIcon, TerminalIcon, ArrowRightIcon } from "./Icons";
import AgentIcon from "./AgentIcon";

type Props = {
  project: Project;
  profiles: LauncherProfile[];
  defaultProfileId: string;
  onOpen: (profileId: string) => void;
  onShell: () => void;
  onReveal: () => void;
};

export default function ProjectHome({ project, profiles, defaultProfileId, onOpen, onShell, onReveal }: Props) {
  return (
    <section className="project-home" aria-label={`Inicio de ${project.name}`}>
      <div className="project-home-content" key={project.id}>
        <div className="home-emblem" aria-hidden="true"><FolderIcon size={25} /></div>
        <h1 className="home-title">{project.name}</h1>
        <button type="button" className="home-path" onClick={onReveal} title="Abrir carpeta en el explorador">
          <span>{project.path}</span>
          <ArrowRightIcon size={12} />
        </button>
        <p className="home-description">Abre una sesión para empezar a trabajar en este proyecto.</p>
        <div className="home-actions">
          {profiles.map(profile => <button key={profile.id} type="button" className={`home-action${profile.id === defaultProfileId ? " primary" : ""}`} onClick={() => onOpen(profile.id)}>
            <AgentIcon kind={profile.provider} size={14} />
            <span>Abrir {profile.name}</span>
            {profile.id === defaultProfileId && <kbd>{MOD_LABEL} T</kbd>}
          </button>)}
          <button type="button" className="home-action" onClick={onShell}>
            <TerminalIcon size={14} />
            <span>Abrir terminal</span>
            <kbd>{MOD_LABEL} ⇧ T</kbd>
          </button>
        </div>
        <p className="home-shortcuts"><kbd>{MOD_LABEL} K</kbd> Buscar proyectos y sesiones</p>
      </div>
    </section>
  );
}
