import { MOD_LABEL } from "../platform";
import type { Project } from "../types";
import { FolderIcon, TerminalIcon, ArrowRightIcon } from "./Icons";

type Props = {
  project: Project;
  onClaude: () => void;
  onShell: () => void;
  onReveal: () => void;
};

export default function ProjectHome({ project, onClaude, onShell, onReveal }: Props) {
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
          <button type="button" className="home-action primary" onClick={onClaude}>
            <span aria-hidden="true">✳</span>
            <span>Abrir Claude</span>
            <kbd>{MOD_LABEL} T</kbd>
          </button>
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
