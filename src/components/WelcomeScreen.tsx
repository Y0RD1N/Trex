/**
 * Pantalla de bienvenida (cuando aún no hay proyectos) y tarjeta de estado de
 * Claude Code, reutilizada también desde el panel de ajustes.
 */
import { useEffect, useRef, useState } from "react";
import { CLAUDE_INSTALL_COMMANDS } from "../api";
import { MOD_LABEL } from "../platform";
import type { AppInfo, ClaudeInfo } from "../types";
import BrandMark from "./BrandMark";

type WelcomeProps = {
  claudeInfo: ClaudeInfo | null;
  codexInfo: ClaudeInfo | null;
  onAddProject: () => void;
  onOpenSettings: () => void;
  onRedetect: () => void;
};

export default function WelcomeScreen({
  claudeInfo,
  codexInfo,
  onAddProject,
  onOpenSettings,
  onRedetect,
}: WelcomeProps) {
  // Sin héroe centrado: un texto alineado a la izquierda, como un mensaje del sistema, con los tres
  // pasos para empezar y el estado de los asistentes detectados.
  const assistants = [{ name: "Claude Code", info: claudeInfo }, { name: "Codex", info: codexInfo }];
  return (
    <div className="welcome">
      <div className="welcome-inner">
        <BrandMark size={56} className="welcome-mark" />
        <h1 className="welcome-title">Aquí empieza el primer yacimiento.</h1>
        <p className="welcome-sub">
          Un proyecto es una carpeta. trex abre en ella sesiones de Claude Code, Codex o un shell, y las guarda numeradas para que nunca pierdas el hilo.
        </p>
        <ol className="welcome-steps">
          <li>
            <span className="welcome-step-no" aria-hidden="true">1</span>
            <span>Añade una carpeta</span>
            <button type="button" className="btn btn-primary btn-small" onClick={onAddProject}>Añadir proyecto</button>
          </li>
          <li>
            <span className="welcome-step-no" aria-hidden="true">2</span>
            <span>Elige con qué asistente trabajar</span>
            <button type="button" className="welcome-action" onClick={onOpenSettings}>Ajustes › Asistentes ({MOD_LABEL} ,)</button>
          </li>
          <li>
            <span className="welcome-step-no" aria-hidden="true">3</span>
            <span>Abre la primera sesión</span>
            <span className="welcome-note">№ 01</span>
          </li>
        </ol>
        <div className="welcome-rule"><span>Asistentes detectados</span></div>
        <ul className="welcome-assistants">
          {assistants.map(({ name, info }) => (
            <li key={name} className={!info ? "checking" : info.found ? "found" : "missing"}>
              <span>{name}</span>
              <span>{!info ? <><span className="loader" aria-hidden="true" /> comprobando</> : info.found ? "● disponible" : "○ no detectado"}</span>
              <span className="welcome-note">{info?.found ? (info.version ?? "") : ""}</span>
            </li>
          ))}
        </ul>
        <button type="button" className="welcome-action" onClick={onRedetect}>Volver a comprobar</button>
      </div>
    </div>
  );
}

// --- Tarjeta de estado de Claude Code ---------------------------------------

type ClaudeStatusCardProps = {
  claudeInfo: ClaudeInfo | null;
  appInfo: AppInfo | null;
  onRedetect: () => void;
};

export function ClaudeStatusCard({ claudeInfo, appInfo, onRedetect }: ClaudeStatusCardProps) {
  const [copied, setCopied] = useState<string | null>(null);
  const copyTimer = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
    };
  }, []);

  const copy = (label: string, text: string): void => {
    void navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(label);
        if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
        copyTimer.current = window.setTimeout(() => setCopied(null), 2200);
      })
      .catch(() => setCopied(null));
  };

  // Destaca el comando recomendado solo si conocemos bien la plataforma.
  const platform = (appInfo?.platform ?? "").toLowerCase();
  const preferred: "windows" | "unix" | null = platform
    ? platform.includes("win")
      ? "windows"
      : "unix"
    : null;

  const allCommands = [
    CLAUDE_INSTALL_COMMANDS.windows,
    CLAUDE_INSTALL_COMMANDS.unix,
    CLAUDE_INSTALL_COMMANDS.npm,
  ].join("\n");

  if (!claudeInfo) {
    return (
      <section className="claude-card">
        <div className="claude-card-head">
          <span className="spinner" aria-hidden="true" />
          <span>Comprobando la instalación de Claude Code…</span>
        </div>
      </section>
    );
  }

  if (claudeInfo.found) {
    return (
      <section className="claude-card ok">
        <div className="claude-card-head">
          <span className="badge badge-ok">✓</span>
          <span className="claude-card-title">Claude Code detectado</span>
        </div>
        <dl className="claude-rows">
          <div className="claude-row">
            <dt>Ruta</dt>
            <dd className="mono">{claudeInfo.path ?? "—"}</dd>
          </div>
          <div className="claude-row">
            <dt>Versión</dt>
            <dd className="mono">{claudeInfo.version ?? "desconocida"}</dd>
          </div>
          {claudeInfo.source && (
            <div className="claude-row">
              <dt>Origen</dt>
              <dd className="mono">{claudeInfo.source}</dd>
            </div>
          )}
        </dl>
        <div className="claude-card-actions">
          <button type="button" className="btn btn-small" onClick={onRedetect}>
            Volver a detectar
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="claude-card warn">
      <div className="claude-card-head">
        <span className="badge badge-warn">!</span>
        <span className="claude-card-title">Claude Code no detectado</span>
      </div>
      <p className="claude-card-text">
        Instala Claude Code y vuelve a comprobar. También puedes seguir usando trex con
        terminales normales.
        {claudeInfo.hint ? ` ${claudeInfo.hint}` : ""}
      </p>

      <div className="install-block">
        <InstallRow
          label="Windows · PowerShell"
          command={CLAUDE_INSTALL_COMMANDS.windows}
          highlighted={preferred === "windows"}
          copied={copied === "windows"}
          onCopy={() => copy("windows", CLAUDE_INSTALL_COMMANDS.windows)}
        />
        <InstallRow
          label="Linux / macOS"
          command={CLAUDE_INSTALL_COMMANDS.unix}
          highlighted={preferred === "unix"}
          copied={copied === "unix"}
          onCopy={() => copy("unix", CLAUDE_INSTALL_COMMANDS.unix)}
        />
        <InstallRow
          label="Alternativa con npm"
          command={CLAUDE_INSTALL_COMMANDS.npm}
          highlighted={false}
          copied={copied === "npm"}
          onCopy={() => copy("npm", CLAUDE_INSTALL_COMMANDS.npm)}
        />
      </div>

      <div className="claude-card-actions">
        <button
          type="button"
          className="btn btn-primary btn-small"
          onClick={() => copy("all", allCommands)}
        >
          {copied === "all" ? "¡Copiados!" : "Copiar comandos de instalación"}
        </button>
        <button type="button" className="btn btn-small" onClick={onRedetect}>
          Volver a detectar
        </button>
      </div>

      {claudeInfo.candidates.length > 0 && (
        <details className="candidates">
          <summary>Rutas comprobadas ({claudeInfo.candidates.length})</summary>
          <ul>
            {claudeInfo.candidates.map((candidate) => (
              <li key={candidate.path} className="mono">
                <span className={candidate.exists ? "exists" : "missing"}>
                  {candidate.exists ? "✓" : "✕"}
                </span>{" "}
                {candidate.path}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

type InstallRowProps = {
  label: string;
  command: string;
  highlighted: boolean;
  copied: boolean;
  onCopy: () => void;
};

function InstallRow({ label, command, highlighted, copied, onCopy }: InstallRowProps) {
  return (
    <div className={`install-row${highlighted ? " highlighted" : ""}`}>
      <div className="install-label">
        {label}
        {highlighted && <span className="install-tag">tu plataforma</span>}
      </div>
      <div className="install-cmd">
        <code>{command}</code>
        <button type="button" className="copy-btn" title="Copiar" onClick={onCopy}>
          {copied ? "✓" : "⧉"}
        </button>
      </div>
    </div>
  );
}
