/**
 * Aviso persistente y cerrable cuando Claude Code no está detectado.
 * El botón "Cómo instalar" lleva a los ajustes, donde vive la tarjeta de
 * instalación de Claude Code.
 */
import { AlertIcon, CloseIcon } from "./Icons";

type Props = {
  onHowToInstall: () => void;
  onDismiss: () => void;
  hint?: string | null;
};

export default function ClaudeBanner({ onHowToInstall, onDismiss, hint }: Props) {
  return (
    <div className="claude-banner" role="status">
      <span className="claude-banner-icon" aria-hidden="true">
        <AlertIcon size={16} />
      </span>
      <span className="claude-banner-text">
        No se ha encontrado Claude Code en este equipo: las pestañas se abrirán como
        terminal normal.
        {hint ? <span className="claude-banner-hint"> {hint}</span> : null}
      </span>
      <button type="button" className="btn btn-small" onClick={onHowToInstall}>
        Cómo instalar
      </button>
      <button
        type="button"
        className="claude-banner-close"
        title="Ocultar aviso"
        aria-label="Ocultar aviso"
        onClick={onDismiss}
      >
        <CloseIcon size={12} strokeWidth={2} />
      </button>
    </div>
  );
}
