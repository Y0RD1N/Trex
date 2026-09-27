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
        <div className="home-emblem" aria-hidden="true"><FolderIcon size={30} /></div>
        <p className="home-eyebrow">TU ESPACIO DE TRABAJO</p>
        <h1 className="home-title">{project.name}</h1>
        <button className="home-path" onClick={onReveal} title="Abrir carpeta en el explorador">
          <FolderIcon size={14} /><span>{project.path}</span><ArrowRightIcon size={14} />
        </button>
        <p className="home-description">Una idea, una terminal. Empieza a construir.</p>
        <div className="home-actions">
          <button className="launch-card launch-claude" onClick={onClaude}>
            <span className="launch-icon" aria-hidden="true">✳</span>
            <span className="launch-copy"><strong>Abrir Claude</strong><span>De la idea al código, juntos.</span></span>
            <span className="launch-bottom"><kbd>{MOD_LABEL} T</kbd><ArrowRightIcon size={18} /></span>
          </button>
          <button className="launch-card" onClick={onShell}>
            <span className="launch-icon"><TerminalIcon size={24} /></span>
            <span className="launch-copy"><strong>Abrir terminal</strong><span>Tu shell, a tu manera.</span></span>
            <span className="launch-bottom"><kbd>{MOD_LABEL} ⇧ T</kbd><ArrowRightIcon size={18} /></span>
          </button>
        </div>
        <div className="home-shortcuts"><span><kbd>{MOD_LABEL} K</kbd> Buscar proyecto</span><span><kbd>{MOD_LABEL} B</kbd> Barra lateral</span></div>
      </div>
      <div className="home-signature" aria-hidden="true">✳ <span>Un poco de foco. Muchas posibilidades.</span></div>
    </section>
  );
}
