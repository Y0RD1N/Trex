import BrowserSettings from "./BrowserSettings";
import IntegrationSettings from "./IntegrationSettings";
/** Ajustes por tema, con cambios en borrador y opciones técnicas desplegables. */
import { Fragment, cloneElement, isValidElement, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { ACCENT_PRESETS, DEFAULT_FONT_FAMILY, clamp } from "../api";
import { APPEARANCE_OPTIONS, applyTheme, normalizeAppearance, type Appearance } from "../theme";
import type { AppInfo, ClaudeInfo, Settings } from "../types";
import { useDialog } from "./DialogProvider";
import { BellIcon, CheckIcon, ChevronIcon, CloseIcon, CopyIcon, CursorIcon, GearIcon, InfoIcon, KeyboardIcon, MoonIcon, PanelIcon, ProfilesIcon, SunIcon, SystemIcon, TerminalIcon } from "./Icons";
import Select from "./Select";
import LauncherProfiles from "./LauncherProfiles";
import CursorSettings from "./CursorSettings";
import WorkspaceAppearance from "./WorkspaceAppearance";
import { applyDesign, normalizeDesign } from "../visualDesign";
import { profilesError } from "../profiles";
import { parseShortcut } from "../paste";
import { bindingError } from "../shortcuts";
import ShortcutSettings from "./ShortcutSettings";
import NotificationsSettings from "./NotificationsSettings";
import AgentIcon from "./AgentIcon";
import type { CliUpdates } from "../hooks/useCliUpdates";
import type { CliId } from "../cliUpdates";
import "./SettingsPanel.css";

type Props = {
  entering: boolean;
  leaving: boolean;
  surfaceRef?: RefObject<HTMLDivElement | null>;
  settings: Settings;
  cwd?: string;
  appInfo: AppInfo | null;
  claudeInfo: ClaudeInfo | null;
  codexInfo: ClaudeInfo | null;
  initialSection?: "appearance" | "profiles";
  onSave: (settings: Settings) => void;
  onClose: () => void;
  onRedetect: () => void;
  cliUpdates: CliUpdates;
  onUpdateCli: (id: CliId) => void;
};

const SECTIONS = [
  { id: "appearance", label: "Apariencia", icon: <SunIcon size={16} />, description: "Elige el tema y el color de tu espacio." },
  { id: "terminal", label: "Terminal", icon: <TerminalIcon size={16} />, description: "Personaliza el texto, el cursor y la terminal." },
  { id: "cursor", label: "Cursor", icon: <CursorIcon />, description: "Ajusta la forma, el grosor y el parpadeo del cursor de texto." },
  { id: "shortcuts", label: "Atajos", icon: <KeyboardIcon size={16} />, description: "Personaliza las combinaciones del teclado." },
  { id: "notifications", label: "Notificaciones", icon: <BellIcon size={16} strokeWidth={1.6} />, description: "Avisos del escritorio cuando tus asistentes necesitan atención." },
  { id: "profiles", label: "Asistentes", icon: <ProfilesIcon />, description: "Perfiles independientes para Claude Code, Codex y Trex API." },
  { id: "browser", label: "Navegador", icon: <PanelIcon size={16} />, description: "Pruebas, capturas y grabaciones con tus agentes." },
  { id: "integrations", label: "Integraciones", icon: <PanelIcon size={16} />, description: "Estado de las aplicaciones y el control de computadora." },
  { id: "sessions", label: "Sesiones", icon: <PanelIcon size={16} />, description: "Decide qué ocurre al abrir y cerrar trex." },
  { id: "about", label: "Acerca de trex", icon: <InfoIcon size={16} />, description: "Versión e información de tu instalación." },
] as const;
type SectionId = typeof SECTIONS[number]["id"];

export default function SettingsPanel({ entering, leaving, surfaceRef, settings, cwd, appInfo, claudeInfo, codexInfo, initialSection = "appearance", onSave, onClose, onRedetect, cliUpdates, onUpdateCli }: Props) {
  const dialog = useDialog();
  const id = useId();
  const [draft, setDraft] = useState<Settings>(settings);
  const [section, setSection] = useState<SectionId>(initialSection);
  const [terminalAdvanced, setTerminalAdvanced] = useState(false);
  const [scrollbackText, setScrollbackText] = useState(String(settings.scrollback));
  const [copied, setCopied] = useState(false);
  const [profileBusy, setProfileBusy] = useState(false);
  const profileBusyRef = useRef(false);
  const changeProfileBusy = (busy: boolean): void => { profileBusyRef.current = busy; setProfileBusy(busy); };
  const [compact, setCompact] = useState(() => window.matchMedia("(max-width: 760px), (max-height: 520px)").matches);
  const modalRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const historyRef = useRef<HTMLInputElement>(null);
  const copyTimer = useRef<number | undefined>(undefined);
  const closePending = useRef(false);
  const savedThemeRef = useRef(settings);
  savedThemeRef.current = settings;

  useEffect(() => {
    const media = window.matchMedia("(max-width: 760px), (max-height: 520px)");
    const update = (): void => setCompact(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useLayoutEffect(() => {
    if (leaving) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButtonRef.current?.focus({ preventScroll: true });
    return () => {
      if (previous?.isConnected && !previous.closest("[inert]") && previous.getClientRects().length) previous.focus({ preventScroll: true });
      else document.querySelector<HTMLButtonElement>(".sidebar:not(.collapsed) .sidebar-collapse, .sidebar.peek .sidebar-collapse, .sidebar-reopen:not([hidden])")?.focus({ preventScroll: true });
    };
  }, [leaving]);

  useEffect(() => { applyTheme(draft.appearance, draft.theme, draft.colorScheme); }, [draft.appearance, draft.theme, draft.colorScheme]);
  useEffect(() => { applyDesign(draft); }, [draft.terminalRadius, draft.terminalMargin, draft.terminalBorder, draft.motion]);
  useEffect(() => () => {
    const saved = savedThemeRef.current;
    applyTheme(saved.appearance, saved.theme, saved.colorScheme);
    applyDesign(saved);
    window.clearTimeout(copyTimer.current);
  }, []);

  const scrollback = Number(scrollbackText);
  const validHistory = scrollbackText.trim() !== "" && Number.isInteger(scrollback) && scrollback >= 200 && scrollback <= 200000;
  const profileError = profilesError(draft.profiles);
  const shortcutError = bindingError(draft.shortcuts,draft.pasteShortcut);
  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(settings) || scrollback !== settings.scrollback,
    [draft, settings, scrollback]);
  const patch = (partial: Partial<Settings>): void => setDraft(previous => ({ ...previous, ...partial }));
  const shellOptions = appInfo?.shellOptions.length ? appInfo.shellOptions : [{ id: "default", label: "Shell del sistema", available: true, program: "" }];

  useLayoutEffect(() => {
    const content = modalRef.current?.querySelector(".settings-content");
    if (content) content.scrollTop = 0;
  }, [section]);

  const requestClose = useCallback((trigger: HTMLElement | null = closeButtonRef.current) => {
    if (leaving || closePending.current || profileBusyRef.current) return;
    if (!dirty) { onClose(); return; }
    closePending.current = true;
    void dialog.confirm({
      trigger,
      title: "¿Descartar los cambios?",
      message: "Tus ajustes todavía no se han guardado.",
      detail: "Si sales, se recupera la configuración anterior.",
      confirmLabel: "Descartar",
      cancelLabel: "Seguir editando",
      tone: "danger",
    }).then(ok => { if (ok) onClose(); }).finally(() => { closePending.current = false; });
  }, [dialog, dirty, leaving, onClose]);

  useEffect(() => {
    if (leaving) return;
    const onKey = (event: globalThis.KeyboardEvent): void => {
      if (event.key === "Escape" && !document.querySelector('[role="alertdialog"]')) {
        event.preventDefault();
        requestClose();
      }
    };
    window.addEventListener("keydown", onKey);
    const onCloseRequest = (): void => requestClose();
    window.addEventListener("trex:settings-close", onCloseRequest);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("trex:settings-close", onCloseRequest);
    };
  }, [requestClose, leaving]);

  const save = (): void => {
    if (profileBusyRef.current || !dirty || !validHistory || profileError || shortcutError) return;
    onSave({ ...draft,
      profiles: draft.profiles.map(profile => ({ ...profile, name: profile.name.trim(), command: profile.command.trim(), args: profile.args.trim(), configDir: profile.configDir.trim() })),
      claudeCommand: draft.claudeCommand.trim() || "claude",
      claudeArgs: draft.claudeArgs.trim(),
      fontSize: clamp(Math.round(draft.fontSize), 10, 24),
      scrollback,
      shell: draft.shell || "default",
      launchMode: draft.launchMode === "inject" ? "inject" : "arg",
      appearance: normalizeAppearance(draft.appearance),
      ...normalizeDesign(draft),
      pasteShortcut: parseShortcut(draft.pasteShortcut)!,
    });
  };

  const trapFocus = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== "Tab") return;
    const items = Array.from(modalRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled):not([tabindex="-1"]), input:not(:disabled), select:not(:disabled), [tabindex="0"]') ?? [])
      .filter(item => !item.closest("[inert]") && item.getClientRects().length > 0);
    const first = items[0], last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  };

  const navigate = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    let next: number;
    if (["ArrowDown", "ArrowRight"].includes(event.key)) next = (index + 1) % SECTIONS.length;
    else if (["ArrowUp", "ArrowLeft"].includes(event.key)) next = (index - 1 + SECTIONS.length) % SECTIONS.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = SECTIONS.length - 1;
    else return;
    event.preventDefault();
    setSection(SECTIONS[next].id);
    document.getElementById(`${id}-tab-${SECTIONS[next].id}`)?.focus();
  };

  const reviewHistory = (): void => {
    setSection("terminal");
    setTerminalAdvanced(true);
    requestAnimationFrame(() => historyRef.current?.focus());
  };

  const copyPath = (): void => {
    if (!appInfo?.configPath) return;
    void navigator.clipboard.writeText(appInfo.configPath).then(() => {
      setCopied(true);
      window.clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => setCopied(false), 1800);
    }).catch(() => setCopied(false));
  };


  return (
    <div ref={surfaceRef} className={`modal-backdrop settings-backdrop${entering ? " entering" : ""}${leaving ? " leaving" : ""}`}
      inert={leaving} aria-hidden={leaving || undefined}
      onMouseDown={event => { if (event.target === event.currentTarget) requestClose(); }}>
      <div ref={modalRef} data-motion-surface className="modal settings-modal" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} onKeyDown={trapFocus}>
        <button ref={closeButtonRef} type="button" className="icon-btn settings-close" disabled={profileBusy} aria-label="Cerrar ajustes" title="Cerrar (Esc)" onClick={event => requestClose(event.currentTarget)}><CloseIcon size={18} /></button>

        <div className="settings-layout">
          <div className="settings-sidebar">
            <div className="settings-sidebar-heading"><span aria-hidden="true"><GearIcon size={19} /></span><h2 id={`${id}-title`}>Ajustes</h2></div>
            {compact ? <Select className="settings-section-select" aria-label="Sección de ajustes" align="start" value={section}
              options={SECTIONS.map(item => ({ value: item.id, label: item.label, icon: item.icon }))}
              onChange={value => setSection(value as SectionId)} />
            : <nav className="settings-nav" role="tablist" aria-label="Secciones de ajustes" aria-orientation="vertical">
              {SECTIONS.map((item, index) => (
                <Fragment key={item.id}>
                {(index === 0 || index === 3 || index === 7) && <span className="settings-nav-section" aria-hidden="true">{index === 0 ? "Tu espacio" : index === 3 ? "Herramientas" : "Aplicación"}</span>}
                <button type="button" role="tab" id={`${id}-tab-${item.id}`} aria-selected={section === item.id}
                  aria-controls={`${id}-panel-${item.id}`} tabIndex={section === item.id ? 0 : -1}
                  className={`settings-nav-item${section === item.id ? " active" : ""}`}
                  onClick={() => setSection(item.id)} onKeyDown={event => navigate(event, index)}>
                  <span aria-hidden="true">{item.icon}</span>{item.label}
                </button>
                </Fragment>
              ))}
            </nav>}
            <span className="settings-sidebar-version">trex {appInfo?.version ?? ""}</span>
          </div>

          <div className="settings-content">
            {SECTIONS.map(item => <section key={item.id} hidden={section !== item.id} className={`settings-page settings-page-${item.id}${item.id === "terminal" || item.id === "cursor" ? " settings-terminal-page" : ""}`} role="tabpanel" tabIndex={0} id={`${id}-panel-${item.id}`} aria-labelledby={compact ? undefined : `${id}-tab-${item.id}`} aria-label={compact ? item.label : undefined}>
              <div className="settings-page-heading">
                <div className="settings-page-title"><h3>{item.label}</h3><p>{item.description}</p></div>
                {section === item.id && (dirty || profileBusy || profileError || shortcutError || !validHistory) && <div className="settings-inline-actions">
                  <div className="settings-save-status" aria-live="polite">
                    {profileBusy ? "Guardando la conexión…" : profileError ? <button type="button" className="settings-error-link" onClick={() => setSection("profiles")}>{profileError}</button>
                      : shortcutError ? <button type="button" className="settings-error-link" onClick={() => setSection("shortcuts")}>{shortcutError}</button>
                      : !validHistory ? <button type="button" className="settings-error-link" onClick={reviewHistory}>Revisa el historial del terminal</button>
                      : <><span className="settings-dirty-dot" aria-hidden="true" />Cambios sin guardar</>}
                  </div>
                  <button type="button" className="btn btn-primary settings-save" disabled={profileBusy || !dirty || !validHistory || !!profileError || !!shortcutError} onClick={save}><CheckIcon size={15} />Guardar cambios</button>
                </div>}
              </div>

              {item.id === "appearance" && <>
                <div className="settings-block">
                  <h4 id={`${id}-theme`}>Tema</h4>
                  <AppearanceControl value={normalizeAppearance(draft.appearance)} labelledBy={`${id}-theme`} onChange={appearance => patch({ appearance })} />
                  <p className="settings-note">Sistema se adapta al tema claro u oscuro de tu equipo.</p>
                </div>
                <WorkspaceAppearance settings={draft} onChange={patch} />
                <div className="settings-block">
                  <h4 id={`${id}-accent`}>Color de acento</h4>
                  <div className="settings-accents" role="group" aria-labelledby={`${id}-accent`}>
                    {ACCENT_PRESETS.map(preset => <button key={preset.value} type="button" className={`settings-accent${draft.theme === preset.value ? " selected" : ""}`}
                      aria-label={preset.name} aria-pressed={draft.theme === preset.value} title={preset.name} onClick={() => patch({ theme: preset.value })}>
                      <span style={{ backgroundColor: preset.value }}>{draft.theme === preset.value && <CheckIcon size={14} />}</span>
                    </button>)}
                  </div>
                  <p className="settings-note">Un toque de color para los controles y el cursor del terminal.</p>
                </div>
                <p className="settings-preview-note">Los cambios de apariencia se previsualizan al instante. Guarda para conservarlos.</p>
              </>}

              {item.id === "terminal" && <>
                <div className="settings-terminal-preview" aria-label="Vista previa del terminal" style={{ fontSize: draft.fontSize, fontFamily: draft.fontFamily.trim() || DEFAULT_FONT_FAMILY }}>
                  <span className="settings-preview-caption">Vista previa</span>
                  <span><span className="settings-prompt">❯</span> Tu próximo proyecto empieza aquí.</span>
                  <span className="settings-preview-muted">Un espacio para crear, a tu ritmo.</span>
                </div>
                <SettingField label="Tamaño del texto" hint="Se aplica a todas tus terminales al guardar." labelId={`${id}-font-size`}>
                  <div className="settings-stepper" role="group" aria-labelledby={`${id}-font-size`}>
                    <button type="button" aria-label="Reducir tamaño del texto" disabled={draft.fontSize <= 10} onClick={() => patch({ fontSize: Math.max(10, draft.fontSize - 1) })}>−</button>
                    <output aria-live="polite">{draft.fontSize}<span>px</span></output>
                    <button type="button" aria-label="Aumentar tamaño del texto" disabled={draft.fontSize >= 24} onClick={() => patch({ fontSize: Math.min(24, draft.fontSize + 1) })}>+</button>
                  </div>
                </SettingField>
                <SettingField label="Shell" hint="El programa que ejecuta tus comandos." controlId={`${id}-shell`}>
                  <Select id={`${id}-shell`} value={draft.shell} onChange={shell => patch({ shell })} options={[
                    ...(!shellOptions.some(option => option.id === draft.shell) ? [{ value: draft.shell, label: `${draft.shell} (actual)` }] : []),
                    ...shellOptions.map(option => ({ value: option.id, label: option.label, disabled: !option.available, description: option.available ? undefined : "No disponible" })),
                  ]} />
                </SettingField>
                <div className="settings-toggles">
                  <SettingToggle label="Copiar al seleccionar" hint="Copia el texto en cuanto lo seleccionas con el ratón." checked={draft.copyOnSelect} onChange={copyOnSelect => patch({ copyOnSelect })} />
                </div>
                <Advanced title="Opciones avanzadas del terminal" open={terminalAdvanced} onToggle={() => setTerminalAdvanced(previous => !previous)}>
                  <SettingField label="Fuente personalizada" hint="Déjalo vacío para usar JetBrains Mono y las fuentes de símbolos de trex." controlId={`${id}-font-family`} stacked>
                    <input id={`${id}-font-family`} className="input settings-mono" value={draft.fontFamily} spellCheck={false} placeholder="Fuente predeterminada de trex" onChange={event => patch({ fontFamily: event.currentTarget.value })} />
                  </SettingField>
                  <SettingField label="Historial del terminal" hint="Número de líneas que puedes recuperar al desplazarte. Entre 200 y 200.000." controlId={`${id}-history`} stacked>
                    <input ref={historyRef} id={`${id}-history`} className="input" type="number" min={200} max={200000} step={1} value={scrollbackText}
                      aria-invalid={!validHistory} aria-describedby={`${id}-history-hint`}
                      onChange={event => { const text = event.currentTarget.value; setScrollbackText(text); if (text.trim()) patch({ scrollback: Number(text) }); }} />
                  </SettingField>
                </Advanced>
              </>}

              {item.id === "cursor" && <CursorSettings settings={draft} onChange={patch} />}

              {item.id === "profiles" && <LauncherProfiles profiles={draft.profiles} defaultProfileId={draft.defaultProfileId}
                appInfo={appInfo} claudeInfo={claudeInfo} codexInfo={codexInfo} onRedetect={onRedetect}
                onBusyChange={changeProfileBusy}
                onChange={(profiles, defaultProfileId) => patch({ profiles, defaultProfileId })} />}

              {item.id === "browser" && section === "browser" && <BrowserSettings settings={draft} cwd={cwd} onChange={patch} onBusyChange={changeProfileBusy} />}
              {item.id === "integrations" && section === "integrations" && <IntegrationSettings cwd={cwd} desktopEnabled={draft.desktopEnabled} onDesktopChange={desktopEnabled => patch({ desktopEnabled })} />}

              {item.id === "shortcuts" && <ShortcutSettings settings={draft} onChange={patch} />}
              {item.id === "notifications" && <NotificationsSettings settings={draft} onChange={patch} />}
              {item.id === "terminal" && <SettingToggle label="Revisar capturas antes de pegarlas" hint="Muestra la imagen y permite confirmarla o cancelar. El texto se pega directamente con el mismo atajo." checked={draft.imagePastePreview} onChange={imagePastePreview=>patch({imagePastePreview})} />}

              {item.id === "sessions" && <div className="settings-toggles">
                <SettingToggle label="Iniciar un asistente al abrir trex" hint="Si no hay sesiones para restaurar, abre el perfil predeterminado. Si lo desactivas, abre una terminal normal." checked={draft.autoRunClaude} onChange={autoRunClaude => patch({ autoRunClaude })} />
                <SettingToggle label="Reabrir terminales al iniciar" hint="Abre de nuevo las terminales que dejaste abiertas al cerrar trex." checked={draft.restoreOnStart} onChange={restoreOnStart => patch({ restoreOnStart })} />
                <SettingToggle label="Preguntar antes de cerrar una sesión activa" hint="Te permite cancelar el cierre si el proceso sigue en marcha." checked={draft.confirmCloseTab} onChange={confirmCloseTab => patch({ confirmCloseTab })} />
              </div>}

              {item.id === "about" && <>
                <div className="settings-about-brand"><span aria-hidden="true">✳</span><div><strong>trex</strong><span>Tu espacio para crear con Claude Code y Codex.</span></div></div>
                <dl className="settings-details">
                  <div><dt>Versión</dt><dd>{appInfo?.version ?? "No disponible"}</dd></div>
                  <div><dt>Plataforma</dt><dd>{appInfo?.platform ?? "No disponible"}</dd></div>
                </dl>
                <div className="settings-block">
                  <h4>Archivo de configuración</h4>
                  <div className="settings-path-row"><code>{appInfo?.configPath ?? "Ruta no disponible"}</code>
                    <button type="button" className="icon-btn" aria-label={copied ? "Ruta copiada" : "Copiar ruta de configuración"} title={copied ? "Copiado" : "Copiar ruta"} disabled={!appInfo?.configPath} onClick={copyPath}>{copied ? <CheckIcon size={15} /> : <CopyIcon size={15} />}</button>
                  </div>
                </div>
                <div className="settings-block">
                  <div className="settings-block-head">
                    <h4>Claude Code y Codex</h4>
                    <button type="button" className="btn btn-small btn-ghost" disabled={cliUpdates.checking} onClick={() => void cliUpdates.check()}>
                      {cliUpdates.checking ? "Buscando…" : "Buscar actualizaciones"}
                    </button>
                  </div>
                  <div className="cli-versions">
                    {[cliUpdates.status.claude, cliUpdates.status.codex].map(cli => {
                      const info = cli.id === "claude" ? claudeInfo : codexInfo;
                      return <div key={cli.id} className="cli-version">
                        <AgentIcon kind={cli.id} size={16} />
                        <div className="cli-version-text">
                          <strong>{cli.name}</strong>
                          <span>{!info ? "Comprobando…" : !info.found ? "No instalado"
                            : `Versión ${cli.installed ?? info.version ?? "desconocida"}${info.source ? ` · ${info.source}` : ""}`}</span>
                          {info?.path && <code className="settings-mono">{info.path}</code>}
                        </div>
                        {cli.available
                          ? <button type="button" className="btn btn-small btn-primary" disabled={cli.updating} onClick={() => onUpdateCli(cli.id)}>
                            {cli.updating ? "Actualizando…" : `Actualizar a ${cli.latest}`}</button>
                          : <span className="cli-version-state">{info?.found && cli.latest ? "Al día" : ""}</span>}
                      </div>;
                    })}
                  </div>
                  <p className="settings-hint">{cliUpdates.checkedAt
                    ? `Última comprobación: ${new Date(cliUpdates.checkedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · trex vuelve a mirar cada pocas horas.`
                    : "trex busca versiones nuevas poco después de abrirse y cada pocas horas."}</p>
                </div>
              </>}
            </section>)}
          </div>
        </div>

      </div>
    </div>
  );
}

const APPEARANCE_ICONS: Record<Appearance, ReactNode> = { system: <SystemIcon size={15} />, light: <SunIcon size={15} />, dark: <MoonIcon size={15} /> };

function AppearanceControl({ value, labelledBy, onChange }: { value: Appearance; labelledBy: string; onChange: (value: Appearance) => void }) {
  const navigate = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    let next: number;
    if (["ArrowDown", "ArrowRight"].includes(event.key)) next = (index + 1) % APPEARANCE_OPTIONS.length;
    else if (["ArrowUp", "ArrowLeft"].includes(event.key)) next = (index - 1 + APPEARANCE_OPTIONS.length) % APPEARANCE_OPTIONS.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = APPEARANCE_OPTIONS.length - 1;
    else return;
    event.preventDefault();
    onChange(APPEARANCE_OPTIONS[next].id);
    event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus();
  };
  return <div className="settings-theme-options" role="radiogroup" aria-labelledby={labelledBy}>
    {APPEARANCE_OPTIONS.map((option, index) => <button key={option.id} type="button" role="radio" aria-checked={value === option.id}
      tabIndex={value === option.id ? 0 : -1} className={`settings-theme-option${value === option.id ? " selected" : ""}`}
      onClick={() => onChange(option.id)} onKeyDown={event => navigate(event, index)}>
      <span className={`settings-theme-preview ${option.id}`} aria-hidden="true"><span className="settings-mini-sidebar"><i /><i /><i /></span><span className="settings-mini-terminal"><i /><i /><i /></span></span>
      <span className="settings-theme-label">{APPEARANCE_ICONS[option.id]}{option.label}{value === option.id && <CheckIcon size={13} />}</span>
    </button>)}
  </div>;
}

function SettingField({ label, hint, controlId, labelId, children, stacked = false }: { label: string; hint: string; controlId?: string; labelId?: string; children: ReactNode; stacked?: boolean }) {
  const control = controlId && isValidElement<{ "aria-describedby"?: string }>(children)
    ? cloneElement(children, { "aria-describedby": children.props["aria-describedby"] ?? `${controlId}-hint` }) : children;
  return <div className={`setting-field${stacked ? " stacked" : ""}`}>
    <div className="setting-field-info"><label htmlFor={controlId} id={labelId}>{label}</label><p id={controlId ? `${controlId}-hint` : undefined}>{hint}</p></div>
    <div className="setting-field-control">{control}</div>
  </div>;
}

function SettingToggle({ label, hint, checked, onChange }: { label: string; hint: string; checked: boolean; onChange: (checked: boolean) => void }) {
  const id = useId();
  return <label className="settings-toggle">
    <span className="setting-field-info"><span id={`${id}-label`}>{label}</span><span id={`${id}-hint`}>{hint}</span></span>
    <input type="checkbox" role="switch" className="settings-switch" checked={checked} aria-labelledby={`${id}-label`} aria-describedby={`${id}-hint`} onChange={event => onChange(event.currentTarget.checked)} />
  </label>;
}

function Advanced({ title, open, onToggle, children }: { title: string; open: boolean; onToggle: () => void; children: ReactNode }) {
  const id = useId();
  return <div className="settings-advanced">
    <button type="button" className="settings-advanced-trigger" aria-expanded={open} aria-controls={id} onClick={onToggle}><ChevronIcon size={13} />{title}</button>
    <div className={`settings-advanced-content${open ? " open" : ""}`} id={id} inert={!open} aria-hidden={!open || undefined}
      onTransitionEnd={event => {
        if (open && event.target === event.currentTarget && event.propertyName === "grid-template-rows"
          && event.currentTarget.contains(document.activeElement)) {
          (document.activeElement as HTMLElement).scrollIntoView({ block: "nearest" });
        }
      }}>
      <div className="settings-advanced-clip"><div className="settings-advanced-fields">{children}</div></div>
    </div>
  </div>;
}
