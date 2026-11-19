import BrowserSettings from "./BrowserSettings";
import IntegrationSettings from "./IntegrationSettings";
import RemoteSettings from "./RemoteSettings";
import VoiceSettings from "./VoiceSettings";
/** Ajustes por tema, con cambios en borrador y opciones técnicas desplegables. */
import { cloneElement, isValidElement, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { DEFAULT_FONT_FAMILY, clamp } from "../api";
import AccentPicker from "./AccentPicker";
import { APPEARANCE_OPTIONS, applyTheme, normalizeAppearance, type Appearance } from "../theme";
import type { AppInfo, ClaudeInfo, Settings } from "../types";
import { useDialog } from "./DialogProvider";
import { CheckIcon, ChevronIcon, CloseIcon, CopyIcon, GearIcon, GlobeIcon, InfoIcon, KeyboardIcon, LayoutIcon, MicIcon, MoonIcon, ProfilesIcon, SunIcon, SystemIcon, TerminalIcon } from "./Icons";
import Select from "./Select";
import LauncherProfiles from "./LauncherProfiles";
import AutoCompactSettings from "./AutoCompactSettings";
import CursorSettings from "./CursorSettings";
import WorkspaceAppearance from "./WorkspaceAppearance";
import { applyDesign, normalizeDesign } from "../visualDesign";
import { syncWindowMaterial } from "../windowMaterial";
import { profilesError } from "../profiles";
import { parseShortcut } from "../paste";
import { bindingError } from "../shortcuts";
import ShortcutSettings from "./ShortcutSettings";
import NotificationsSettings from "./NotificationsSettings";
import AgentIcon from "./AgentIcon";
import BrandMark from "./BrandMark";
import SettingInfo from "./SettingInfo";
import type { CliUpdates } from "../hooks/useCliUpdates";
import type { CliId } from "../cliUpdates";
import "./SettingsPanel.css";
import { formatClock } from "../timeFormat";

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

// Las páginas de ajustes. En la lista lateral no aparecen sueltas: van agrupadas (GROUPS).
const SECTIONS = [
  { id: "appearance", label: "Apariencia" },
  { id: "sessions", label: "Inicio" },
  { id: "notifications", label: "Avisos" },
  { id: "terminal", label: "Texto" },
  { id: "cursor", label: "Cursor" },
  { id: "profiles", label: "Asistentes" },
  { id: "voice", label: "Voz" },
  { id: "browser", label: "Navegador" },
  { id: "integrations", label: "Integraciones" },
  { id: "remote", label: "Remoto" },
  { id: "shortcuts", label: "Atajos" },
  { id: "about", label: "Acerca de trex" },
] as const;
type SectionId = typeof SECTIONS[number]["id"];

/** Lo que se ve en la lista lateral: seis apartados; los que reúnen varias páginas las muestran como pestañas. */
const GROUPS: { id: string; label: string; icon: ReactNode; pages: SectionId[] }[] = [
  { id: "general", label: "General", icon: <LayoutIcon size={16} />, pages: ["appearance", "sessions", "notifications"] },
  { id: "terminal", label: "Terminal", icon: <TerminalIcon size={16} />, pages: ["terminal", "cursor"] },
  { id: "profiles", label: "Asistentes", icon: <ProfilesIcon />, pages: ["profiles"] },
  { id: "voice", label: "Voz", icon: <MicIcon size={16} />, pages: ["voice"] },
  { id: "connections", label: "Conexiones", icon: <GlobeIcon size={16} />, pages: ["browser", "integrations", "remote"] },
  { id: "shortcuts", label: "Atajos", icon: <KeyboardIcon size={16} />, pages: ["shortcuts"] },
];
/** «Acerca de» no está en la lista: se abre desde la versión, al pie. */
const ABOUT = { id: "about", label: "Acerca de trex", icon: <InfoIcon size={16} />, pages: ["about"] as SectionId[] };
const groupOf = (section: SectionId) => GROUPS.find(group => group.pages.includes(section)) ?? ABOUT;

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

  useEffect(() => { applyTheme(draft.appearance, draft.theme, draft.colorScheme, { hue: draft.surfaceHue, tint: draft.surfaceTint }); }, [draft.appearance, draft.theme, draft.colorScheme, draft.surfaceHue, draft.surfaceTint]);
  useEffect(() => { applyDesign(draft); }, [draft.terminalRadius, draft.terminalMargin, draft.terminalBorder, draft.motion, draft.glass, draft.materialTint]);
  useEffect(() => { syncWindowMaterial(draft.glass, draft.windowBackdrop); }, [draft.glass, draft.windowBackdrop]);
  useEffect(() => () => {
    const saved = savedThemeRef.current;
    applyTheme(saved.appearance, saved.theme, saved.colorScheme, { hue: saved.surfaceHue, tint: saved.surfaceTint });
    applyDesign(saved);
    syncWindowMaterial(saved.glass, saved.windowBackdrop);
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
    if (["ArrowDown", "ArrowRight"].includes(event.key)) next = (index + 1) % GROUPS.length;
    else if (["ArrowUp", "ArrowLeft"].includes(event.key)) next = (index - 1 + GROUPS.length) % GROUPS.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = GROUPS.length - 1;
    else return;
    event.preventDefault();
    setSection(GROUPS[next].pages[0]);
    document.getElementById(`${id}-tab-${GROUPS[next].id}`)?.focus();
  };
  const group = groupOf(section);

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
            {compact ? <Select className="settings-section-select" aria-label="Sección de ajustes" align="start" value={group.id}
              options={[...GROUPS, ABOUT].map(item => ({ value: item.id, label: item.label, icon: item.icon }))}
              onChange={value => setSection(([...GROUPS, ABOUT].find(item => item.id === value) ?? GROUPS[0]).pages[0])} />
            : <nav className="settings-nav" role="tablist" aria-label="Secciones de ajustes" aria-orientation="vertical">
              {GROUPS.map((item, index) => (
                <button key={item.id} type="button" role="tab" id={`${id}-tab-${item.id}`} aria-selected={group.id === item.id}
                  aria-controls={`${id}-panel-${group.id === item.id ? section : item.pages[0]}`} tabIndex={group.id === item.id || (group === ABOUT && index === 0) ? 0 : -1}
                  className={`settings-nav-item${group.id === item.id ? " active" : ""}`}
                  onClick={() => { if (group.id !== item.id) setSection(item.pages[0]); }} onKeyDown={event => navigate(event, index)}>
                  <span aria-hidden="true">{item.icon}</span>{item.label}
                </button>
              ))}
            </nav>}
            <button type="button" className={`settings-sidebar-version${section === "about" ? " active" : ""}`} aria-label="Acerca de trex" onClick={() => setSection("about")}>trex {appInfo?.version ?? ""}</button>
          </div>

          <div className="settings-content">
            {SECTIONS.map(item => <section key={item.id} hidden={section !== item.id} className={`settings-page settings-page-${item.id}${item.id === "terminal" || item.id === "cursor" ? " settings-terminal-page" : ""}`} role="tabpanel" tabIndex={0} id={`${id}-panel-${item.id}`} aria-label={`${groupOf(item.id).label}${groupOf(item.id).pages.length > 1 ? `: ${item.label}` : ""}`}>
              <div className="settings-page-heading">
                <h3>{groupOf(item.id).label}</h3>
                {groupOf(item.id).pages.length > 1 && <div className="settings-subtabs" role="group" aria-label={`Páginas de ${groupOf(item.id).label}`}>
                  {groupOf(item.id).pages.map(page => <button key={page} type="button" aria-pressed={page === item.id} onClick={() => setSection(page)}>
                    {SECTIONS.find(entry => entry.id === page)?.label}</button>)}
                </div>}
              </div>

              {item.id === "appearance" && <>
                <div className="settings-block">
                  <h4 id={`${id}-theme`}>Tema</h4>
                  <AppearanceControl value={normalizeAppearance(draft.appearance)} labelledBy={`${id}-theme`} onChange={appearance => patch({ appearance })} />
                </div>
                <WorkspaceAppearance settings={draft} onChange={patch} />
                <div className="settings-block">
                  <SettingField label="Formato de hora">
                    <Select aria-label="Formato de hora" value={draft.timeFormat} onChange={value => patch({ timeFormat: value === "12h" ? "12h" : "24h" })}
                      options={[{ value: "24h", label: "24 horas · 17:40" }, { value: "12h", label: "12 horas · 05:40 p. m." }]} />
                  </SettingField>
                </div>
                <div className="settings-block">
                  <h4 id={`${id}-accent`}>Color de acento<SettingInfo text="Colorea los controles y el cursor del terminal. Si se confunde con el fondo, trex lo aclara u oscurece lo justo para que se lea." /></h4>
                  <AccentPicker value={draft.theme} labelledBy={`${id}-accent`} onChange={theme => patch({ theme })} />
                </div>
              </>}

              {item.id === "terminal" && <>
                <div className="settings-terminal-preview" aria-label="Vista previa del terminal" style={{ fontSize: draft.fontSize, fontFamily: draft.fontFamily.trim() || DEFAULT_FONT_FAMILY }}>
                  <span><span className="settings-prompt">❯</span> Tu próximo proyecto empieza aquí.</span>
                  <span className="settings-preview-muted">Un espacio para crear, a tu ritmo.</span>
                </div>
                <SettingField label="Tamaño del texto" labelId={`${id}-font-size`}>
                  <div className="settings-stepper" role="group" aria-labelledby={`${id}-font-size`}>
                    <button type="button" aria-label="Reducir tamaño del texto" disabled={draft.fontSize <= 10} onClick={() => patch({ fontSize: Math.max(10, draft.fontSize - 1) })}>−</button>
                    <output aria-live="polite">{draft.fontSize}<span>px</span></output>
                    <button type="button" aria-label="Aumentar tamaño del texto" disabled={draft.fontSize >= 24} onClick={() => patch({ fontSize: Math.min(24, draft.fontSize + 1) })}>+</button>
                  </div>
                </SettingField>
                <SettingField label="Shell" controlId={`${id}-shell`}>
                  <Select id={`${id}-shell`} value={draft.shell} onChange={shell => patch({ shell })} options={[
                    ...(!shellOptions.some(option => option.id === draft.shell) ? [{ value: draft.shell, label: `${draft.shell} (actual)` }] : []),
                    ...shellOptions.map(option => ({ value: option.id, label: option.label, disabled: !option.available, description: option.available ? undefined : "No disponible" })),
                  ]} />
                </SettingField>
                <div className="settings-toggles">
                  <SettingToggle label="Copiar al seleccionar" checked={draft.copyOnSelect} onChange={copyOnSelect => patch({ copyOnSelect })} />
                  <SettingToggle label="Revisar capturas antes de pegarlas" checked={draft.imagePastePreview} onChange={imagePastePreview => patch({ imagePastePreview })} />
                </div>
                <Advanced title="Avanzado" open={terminalAdvanced} onToggle={() => setTerminalAdvanced(previous => !previous)}>
                  <SettingField label="Fuente" hint="vacío: la de trex" controlId={`${id}-font-family`} stacked>
                    <input id={`${id}-font-family`} className="input settings-mono" value={draft.fontFamily} spellCheck={false} placeholder="Fuente predeterminada de trex" onChange={event => patch({ fontFamily: event.currentTarget.value })} />
                  </SettingField>
                  <SettingField label="Historial" hint="líneas, de 200 a 200.000" controlId={`${id}-history`} stacked>
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
              {item.id === "profiles" && <AutoCompactSettings value={draft.autoCompact} onChange={autoCompact => patch({ autoCompact })} />}

              {item.id === "browser" && section === "browser" && <BrowserSettings settings={draft} cwd={cwd} onChange={patch} />}
              {item.id === "integrations" && section === "integrations" && <IntegrationSettings cwd={cwd} integrations={draft.integrations} onIntegrationsChange={integrations => patch({ integrations })} desktopEnabled={draft.desktopEnabled} onDesktopChange={desktopEnabled => patch({ desktopEnabled })} a11yEnabled={draft.a11yEnabled} onA11yChange={a11yEnabled => patch({ a11yEnabled })} a11yKeyboard={draft.a11yKeyboard} onA11yKeyboardChange={a11yKeyboard => patch({ a11yKeyboard })} />}

              {item.id === "remote" && section === "remote" && <RemoteSettings />}
              {item.id === "voice" && section === "voice" && <VoiceSettings />}
              {item.id === "shortcuts" && <ShortcutSettings settings={draft} onChange={patch} />}
              {item.id === "notifications" && <NotificationsSettings settings={draft} onChange={patch} />}

              {item.id === "sessions" && <div className="settings-toggles">
                <SettingToggle label="Abrir con un asistente" info="Si no hay sesiones que restaurar, abre el perfil predeterminado. Apagado, abre una terminal normal." checked={draft.autoRunClaude} onChange={autoRunClaude => patch({ autoRunClaude })} />
                <SettingToggle label="Reabrir lo que dejaste abierto" checked={draft.restoreOnStart} onChange={restoreOnStart => patch({ restoreOnStart })} />
                <SettingToggle label="Preguntar antes de cerrar una sesión activa" checked={draft.confirmCloseTab} onChange={confirmCloseTab => patch({ confirmCloseTab })} />
              </div>}

              {item.id === "about" && <>
                <div className="settings-about-brand"><BrandMark size={48} /><div><strong>trex</strong></div></div>
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
                  {cliUpdates.checkedAt && <p className="settings-hint">Comprobado a las {formatClock(cliUpdates.checkedAt, draft.timeFormat)}</p>}
                </div>
              </>}
            </section>)}
            {/* Guardar flota al pie del contenido: se alcanza sin volver arriba, desde cualquier punto de la página. */}
            {(dirty || profileBusy || profileError || shortcutError || !validHistory) && <div className="settings-savebar">
              <div className="settings-savebar-inner" role="group" aria-label="Cambios pendientes">
                <div className="settings-save-status" aria-live="polite">
                  {profileBusy ? "Guardando la conexión…" : profileError ? <button type="button" className="settings-error-link" onClick={() => setSection("profiles")}>{profileError}</button>
                    : shortcutError ? <button type="button" className="settings-error-link" onClick={() => setSection("shortcuts")}>{shortcutError}</button>
                    : !validHistory ? <button type="button" className="settings-error-link" onClick={reviewHistory}>Revisa el historial del terminal</button>
                    : <><span className="settings-dirty-dot" aria-hidden="true" />Cambios sin guardar</>}
                </div>
                <button type="button" className="btn btn-primary settings-save" disabled={profileBusy || !dirty || !validHistory || !!profileError || !!shortcutError} onClick={save}><CheckIcon size={15} />Guardar cambios</button>
              </div>
            </div>}
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

/** Una fila: nombre, pista de dos o tres palabras y, si hace falta explicar más, el icono de información. */
function SettingField({ label, hint, info, controlId, labelId, children, stacked = false }: { label: string; hint?: string; info?: string; controlId?: string; labelId?: string; children: ReactNode; stacked?: boolean }) {
  const control = controlId && hint && isValidElement<{ "aria-describedby"?: string }>(children)
    ? cloneElement(children, { "aria-describedby": children.props["aria-describedby"] ?? `${controlId}-hint` }) : children;
  return <div className={`setting-field${stacked ? " stacked" : ""}`}>
    <div className="setting-field-info"><label htmlFor={controlId} id={labelId}>{label}</label>
      {hint && <small id={controlId ? `${controlId}-hint` : undefined}>{hint}</small>}{info && <SettingInfo text={info} />}</div>
    <div className="setting-field-control">{control}</div>
  </div>;
}

function SettingToggle({ label, hint, info, checked, onChange }: { label: string; hint?: string; info?: string; checked: boolean; onChange: (checked: boolean) => void }) {
  const id = useId();
  return <label className="settings-toggle">
    <span className="setting-field-info"><span id={`${id}-label`}>{label}</span>{hint && <small id={`${id}-hint`}>{hint}</small>}{info && <SettingInfo text={info} />}</span>
    <input type="checkbox" role="switch" className="settings-switch" checked={checked} aria-labelledby={`${id}-label`} aria-describedby={hint ? `${id}-hint` : undefined} onChange={event => onChange(event.currentTarget.checked)} />
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
