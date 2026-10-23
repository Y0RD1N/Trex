import { shortcutLabel, type ShortcutBindings } from "../shortcuts";
import type { LauncherProfile, Project } from "../types";
import { FolderIcon, TerminalIcon, ArrowRightIcon, MapIcon } from "./Icons";
import AgentIcon from "./AgentIcon";

type Props = {
  project: Project;
  profiles: LauncherProfile[];
  defaultProfileId: string;
  shortcuts: ShortcutBindings;
  onOpen: (profileId: string) => void;
  onShell: () => void;
  onWorkflow?: () => void;
  onReveal: () => void;
};

export default function ProjectHome({ project, profiles, defaultProfileId, shortcuts, onOpen, onShell, onWorkflow, onReveal }: Props) {
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
            {profile.id === defaultProfileId && <kbd>{shortcutLabel(shortcuts.newClaudeTab)}</kbd>}
          </button>)}
          <button type="button" className="home-action" onClick={onShell}>
            <TerminalIcon size={14} />
            <span>Abrir terminal</span>
            <kbd>{shortcutLabel(shortcuts.newShellTab)}</kbd>
          </button>
          {onWorkflow && <button type="button" className="home-action" onClick={onWorkflow}>
            <MapIcon size={14} /><span>Planear y ejecutar con agentes</span><ArrowRightIcon size={14} />
          </button>}
        </div>
        <p className="home-shortcuts"><kbd>{shortcutLabel(shortcuts.commandPalette)}</kbd> Paleta de comandos</p>
      </div>
    </section>
  );
}
