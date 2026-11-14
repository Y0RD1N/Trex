/**
 * App: layout principal y orquestación de todo el estado de trex.
 *
 *   sidebar (proyectos)  +  área principal (pestañas + terminales)
 *
 * Responsabilidades: carga y persistencia de la configuración, gestión de
 * proyectos y pestañas, atajos de teclado, detección de Claude Code,
 * restauración de la sesión anterior y las confirmaciones de la app (mediante
 * el sistema de diálogos propio, montado en el proveedor de la raíz).
 */
import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type SetStateAction } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { openPath } from "@tauri-apps/plugin-opener";
import {
  DEFAULT_CONFIG,
  DEFAULT_SETTINGS,
  PROJECT_COLORS,
  clamp,
  deriveProjectName,
  detectClaude as detectClaudeCode,
  detectCodex,
  formatError,
  getAppInfo,
  loadConfig,
  restoreConfigBackup,
  newProjectId,
  newSessionId,
  normalizePath,
  normalizeConfig,
  normalizeText,
  ptyKill,
  prepareHandoff,
  saveConfig,
} from "./api";
import { useShortcuts } from "./hooks/useShortcuts";
import { shortcutLabel } from "./shortcuts";
import { useWindowFrame } from "./hooks/useWindowFrame";
import { usePresence } from "./hooks/usePresence";
import { waitForMotion } from "./motion";
import { applyTheme, getThemeMode, onThemeChange, type ThemeMode } from "./theme";
import type {
  AppConfig,
  AgentActivity,
  AgentNotice,
  AgentProvider,
  AgentNoticeKind,
  AppInfo,
  ClaudeInfo,
  LauncherProfile,
  PersistedTab,
  Project,
  Settings,
  Conversation,
  TabKind,
  TabState,
} from "./types";
import ClaudeBanner from "./components/ClaudeBanner";
import DialogProvider, { useDialog } from "./components/DialogProvider";
import { configFailure, recoverConfig } from "./configRecovery";
import { lazyComponent } from "./lazyComponent";
import Sidebar from "./components/Sidebar";
import TerminalTabs from "./components/TerminalTabs";
import TerminalView from "./components/TerminalView";
import ChatView, { type ChatViewProps } from "./components/ChatView";
import AgentRoomView from "./components/AgentRoomView";
import ErrorBoundary from "./components/ErrorBoundary";
import Toast from "./components/Toast";
import VoiceIndicator from "./components/VoiceIndicator";
import { useVoiceCall } from "./hooks/useVoiceCall";

const NO_PROJECTS: Project[] = [];
import TooltipProvider from "./components/TooltipProvider";
import ImageViewerProvider from "./components/ImageViewer";
import FileViewerProvider from "./components/FileViewer";
import ProjectHome from "./components/ProjectHome";
import { sessionLabel } from "./sessionTitle";
import { remoteBridge } from "./remoteBridge";
import { filterProjects, includeAddedProject, normalizeProjectFilter, type ProjectFilter } from "./projectFilter";
import WelcomeScreen from "./components/WelcomeScreen";
import { defaultProfile, launchForProfile, profilesForInstallation, restoreLaunch } from "./profiles";
import { applyDesign } from "./visualDesign";
import { syncWindowMaterial } from "./windowMaterial";
import { syncBrowserTheme } from "./browserThemeSync";
import { applyTimeFormat } from "./timeFormat";
import { defaultAgentPermission, validAgentPermission } from "./agentPermissions";
import type { ClipboardContent } from "./paste";
import { resumedLaunch } from "./conversations";
import { codexChatSupported } from "./codexChat";
import { normalizeEffortChoice, normalizeModelChoice } from "./chatState";
import { showDesktopNotice } from "./desktopNotifications";
import { createSplitLayout, replaceSplitPane, splitPaneStyle, visibleSplit, type SplitDirection, type SplitLayout } from "./splitLayout";
import SplitDivider from "./components/SplitDivider";
import SplitPaneHeader from "./components/SplitPaneHeader";
import AgentIcon from "./components/AgentIcon";
import { PanelIcon, TerminalIcon } from "./components/Icons";
import FeatureDialog from "./components/FeatureDialog";
import HandoffDialog, { handoffTargetReason } from "./components/HandoffDialog";
import { normalizeHandoffReference, sanitizeHandoffInstruction, type HandoffContext, type HandoffReference, type PreparedHandoff } from "./handoff";
import type { WorkflowRequest } from "./components/AgentWorkflowDialog";
import { IMPLEMENTATION_INSTRUCTION, normalizeAgentWorkflow, restoreAgentWorkflow, type AgentWorkflow, type WorkflowAgent } from "./agentWorkflow";
import { claudePlanningArgs } from "./workflowSafety";
import { normalizeAgentRoom, restoreAgentRoom, type AgentRoom, type RoomRole } from "./agentRoom";
import { normalizeAgentTeam, restoreAgentTeam, teamConfigurationText, type AgentTeam, type TeamMember } from "./agentTeam";
import AgentTeamView from "./components/AgentTeamView";
import type { TeamRequest, TeamMemberChoice } from "./components/AgentTeamDialog";
import { readQueuedMessages } from "./api";
import { sanitizeHandoffText } from "./handoff";
import { IS_WINDOWS } from "./platform";
import type { PaletteCommand } from "./commandPalette";
import { useNotificationSound } from "./hooks/useNotificationSound";
import { useCliUpdates } from "./hooks/useCliUpdates";
import { useAccountUsageUpkeep } from "./hooks/useAccountUsage";
import { requestUsagePanel } from "./accountUsageStore";
import type { CliId } from "./cliUpdates";
// Ajustes, paleta y diálogos poco frecuentes: en su propio fragmento (ver lazyComponent).
const SettingsPanel = lazyComponent(() => import("./components/SettingsPanel"));
const CommandPalette = lazyComponent(() => import("./components/CommandPalette"));
const RecoverConversations = lazyComponent(() => import("./components/RecoverConversations"));
const UsageDialog = lazyComponent(() => import("./components/UsageDialog"));
const AgentWorkflowDialog = lazyComponent(() => import("./components/AgentWorkflowDialog"));

/** Información de Claude usada cuando la detección no puede ejecutarse. */
const CLAUDE_INFO_FALLBACK: ClaudeInfo = {
  found: false,
  path: null,
  version: null,
  source: null,
  hint: null,
  candidates: [],
};

/** Crea una pestaña nueva aplicando los ajustes vigentes. */
const buildTab = (
  projectId: string,
  kind: TabKind,
  subtitle: string,
  settings: Settings,
  profile: LauncherProfile | null = null,
): TabState => {
  return {
    conversationId: null,
    chatMode: null,
    chatModel: null,
    chatEffort: null,
    id: newSessionId(),
    projectId,
    kind,
    subtitle,
    ...launchForProfile(settings, profile),
    exited: false,
    exitCode: null,
    oscTitle: null,
    activity: "idle",
    createdAt: Date.now(),
  };
};

function SessionChat({ room, agentTeam, onTeamChange, onRoomChange, trexInstalled, ...props }: ChatViewProps & { room?: AgentRoom | null; agentTeam?: AgentTeam | null; trexInstalled: boolean; onRoomChange: (room: AgentRoom) => void; onTeamChange: (team: AgentTeam) => void }) {
  if (!trexInstalled && (props.provider === "trex" || room?.planner.agent.provider === "trex" || room?.executor.agent.provider === "trex" || agentTeam?.workers.some(member => member.agent.provider === "trex"))) {
    return <div className="project-home"><div className="project-home-content"><h2>Este chat utiliza Trex CLI</h2><p>Activa «Instalar Trex CLI» en el instalador para recuperar sus conexiones API. El historial y los perfiles se conservan. Puedes abrir Claude o Codex desde Nueva sesión.</p></div></div>;
  }
  return <ErrorBoundary scope="view">
    {agentTeam ? <AgentTeamView {...props} team={agentTeam} onTeamChange={onTeamChange} /> : room ? <AgentRoomView {...props} room={room} onRoomChange={onRoomChange} /> : <ChatView {...props} />}
  </ErrorBoundary>;
}

const usesChatView = (tab: TabState): tab is TabState & { kind: AgentProvider } =>
  tab.kind !== "shell" && (tab.kind !== "codex" || codexChatSupported(tab.args));

function AppShell() {
  useWindowFrame();
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [tabs, setTabsState] = useState<TabState[]>([]);
  const tabsRef = useRef<TabState[]>([]);
  // Las notificaciones del proceso y las transiciones pueden llegar en el mismo lote de React.
  // Todas las escrituras pasan por el mismo espejo para conservar sus cambios acumulados.
  const setTabs = useCallback((action: SetStateAction<TabState[]>) => {
    const next = typeof action === "function" ? action(tabsRef.current) : action;
    tabsRef.current = next;
    setTabsState(next);
  }, []);
  const [notices, setNotices] = useState<AgentNotice[]>([]);
  const noticeIdRef = useRef(0);
  const closingTabIdsRef = useRef(new Set<string>());
  const playNotificationSound = useNotificationSound(config?.ui.notificationSound ?? true);
  const liveTabIds = useMemo(() => new Set(tabs.map(tab => tab.id)), [tabs]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [expandedPaneId, setExpandedPaneId] = useState<string | null>(null);
  const [claudeInfo, setClaudeInfo] = useState<ClaudeInfo | null>(null);
  const [codexInfo, setCodexInfo] = useState<ClaudeInfo | null>(null);
  const [trexInstalled, setTrexInstalled] = useState(false);
  const [trexChecked, setTrexChecked] = useState(false);
  const trexInstalledRef = useRef(false);
  const [settingsInitialSection, setSettingsInitialSection] = useState<"appearance" | "profiles">("appearance");
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  useEffect(() => {
    let current = true;
    void invoke<{ installed: boolean }>("trex_cli_status").then(status => {
      if (current) { trexInstalledRef.current = status?.installed === true; setTrexInstalled(status?.installed === true); }
    }).catch(() => { if (current) { trexInstalledRef.current = false; setTrexInstalled(false); } })
      .finally(() => { if (current) setTrexChecked(true); });
    return () => { current = false; };
  }, [settingsOpen]);
  const [paletteOpen,setPaletteOpen] = useState(false);
  const [usageOpen,setUsageOpen] = useState(false);
  // El uso vive en la pestaña «Uso» del chat; sin un chat a la vista, en su ventana.
  const openUsage = useCallback(() => { if (!requestUsagePanel()) setUsageOpen(true); }, []);
  const [recoveryOpen,setRecoveryOpen] = useState(false);
  const [handoffDialog, setHandoffDialog] = useState<{ context: HandoffContext; prepared: PreparedHandoff | null; loading: boolean; error: string | null } | null>(null);
  const [handoffSubmitting, setHandoffSubmitting] = useState(false);
  const handoffGeneration = useRef(0);
  const handoffSubmittingRef = useRef(false);
  const handoffSurfaceRef = useRef<HTMLDivElement>(null);
  const [workflowProject, setWorkflowProject] = useState<Project | null>(null);
  const workflowSourceRef = useRef<{ context: HandoffContext; itemIds: string[] } | null>(null);
  const [workflowSubmitting, setWorkflowSubmitting] = useState(false);
  const [workflowError, setWorkflowError] = useState<string | null>(null);
  const workflowSurfaceRef = useRef<HTMLDivElement>(null);
  const workflowStartingRef = useRef(false);
  const workflowTransfersRef = useRef(new Set<string>());
  const [imagePreview,setImagePreview] = useState<{ image: Extract<ClipboardContent,{kind:"image"}>; tabId:string; resolve:(paste:boolean)=>void } | null>(null);
  const imagePreviewRef = useRef(imagePreview); imagePreviewRef.current = imagePreview;
  const previewImage = useCallback((image: Extract<ClipboardContent,{kind:"image"}>,tabId:string): Promise<boolean> => new Promise(resolve => {
    imagePreviewRef.current?.resolve(false);
    const preview = { image, tabId, resolve };
    imagePreviewRef.current = preview;
    setImagePreview(preview);
  }),[]);
  const dismissImage = useCallback((paste:boolean) => { imagePreviewRef.current?.resolve(paste); imagePreviewRef.current = null; setImagePreview(null); },[]);
  useEffect(() => () => { imagePreviewRef.current?.resolve(false); },[]);
  const settingsSurfaceRef = useRef<HTMLDivElement>(null);
  const paletteSurfaceRef = useRef<HTMLDivElement>(null);
  const usageSurfaceRef = useRef<HTMLDivElement>(null);
  const recoverySurfaceRef = useRef<HTMLDivElement>(null);
  const imagePreviewSurfaceRef = useRef<HTMLDivElement>(null);
  const settingsPresence = usePresence(settingsOpen ? true : null, 160, settingsSurfaceRef);
  const palettePresence = usePresence(paletteOpen ? true : null, 160, paletteSurfaceRef);
  const usagePresence = usePresence(usageOpen ? true : null, 160, usageSurfaceRef);
  const recoveryPresence = usePresence(recoveryOpen ? true : null, 160, recoverySurfaceRef);
  const handoffPresence = usePresence(handoffDialog, 160, handoffSurfaceRef);
  const workflowPresence = usePresence(workflowProject, 160, workflowSurfaceRef);
  const imagePreviewPresence = usePresence(imagePreview, 160, imagePreviewSurfaceRef);
  const shownImagePreview = imagePreviewPresence.value;
  const [bannerDismissed, setBannerDismissed] = useState(false);
  const [toast, setToast] = useState<{ id: number; message: string } | null>(null);
  /** Modo realmente pintado (resuelve "system" con la preferencia del equipo). */
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => getThemeMode());
  /** Texto del buscador de proyectos (filtra por nombre y por ruta). */
  const [search, setSearch] = useState("");
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  // Espejos de estado para usarlos desde callbacks estables.
  const configRef = useRef<AppConfig | null>(null);
  configRef.current = config;
  const activeTabIdRef = useRef<string | null>(activeTabId);
  activeTabIdRef.current = activeTabId;

  const loadedRef = useRef(false);
  /** Falso cuando la configuración no se pudo leer y la persona eligió no escribir nada encima. */
  const saveAllowedRef = useRef(true);
  const restoredRef = useRef(false);
  const [workspaceReady, setWorkspaceReady] = useState(false);
  const toastIdRef = useRef(0);

  /** Sistema de diálogos propio (sustituye a los nativos del sistema). */
  const dialog = useDialog();

  // El toast se autogestiona (entrada, espera y fundido); aquí solo lo lanzamos.
  const showToast = useCallback((message: string) => {
    toastIdRef.current += 1;
    setToast({ id: toastIdRef.current, message });
  }, []);

  /** Lleva el foco al buscador de proyectos desde cualquier sitio. */
  const focusSearch = useCallback(() => {
    setConfig((prev) => prev ? { ...prev, ui: { ...prev.ui, sidebarCollapsed: false } } : prev);
    const input = searchInputRef.current;
    if (!input) return;
    requestAnimationFrame(() => { input.focus(); input.select(); });
  }, []);

  // --- Carga inicial ---------------------------------------------------------

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      let loaded: AppConfig | null;
      try {
        loaded = await loadConfig();
      } catch (error) {
        console.warn("load_config falló:", formatError(error));
        // La app espera sin configuración (y sin guardar nada) hasta que la persona decide.
        const recovery = await recoverConfig(configFailure(error), { confirm: dialog.confirm, load: loadConfig, restore: restoreConfigBackup });
        if (cancelled) return;
        loaded = recovery.config;
        saveAllowedRef.current = recovery.save;
        if (!recovery.save) showToast("Esta sesión no guardará cambios en la configuración.");
      }
      if (cancelled) return;
      const normalized = normalizeConfig(loaded ?? DEFAULT_CONFIG);
      setConfig(normalized);
      loadedRef.current = true;
      applyTheme(
        normalized.settings.appearance,
        normalized.settings.theme || DEFAULT_SETTINGS.theme,
        normalized.settings.colorScheme,
        { hue: normalized.settings.surfaceHue, tint: normalized.settings.surfaceTint },
      );
      applyDesign(normalized.settings);
      applyTimeFormat(normalized.settings.timeFormat);
    })();

    void (async () => {
      try {
        const info = await getAppInfo();
        if (!cancelled) setAppInfo(info);
      } catch (error) {
        console.warn("app_info falló:", formatError(error));
      }
    })();

    void (async () => {
      try {
        const info = await detectClaudeCode();
        if (!cancelled) setClaudeInfo(info);
      } catch (error) {
        console.warn("detect_claude falló:", formatError(error));
        if (!cancelled) setClaudeInfo(CLAUDE_INFO_FALLBACK);
      }
    })();
    void detectCodex().then(info => { if (!cancelled) setCodexInfo(info); })
      .catch(() => { if (!cancelled) setCodexInfo(CLAUDE_INFO_FALLBACK); });

    return () => {
      cancelled = true;
    };
  }, [showToast]);

  const redetectClaude = useCallback(() => {
    setCodexInfo(null);
    void detectCodex().then(setCodexInfo).catch(() => setCodexInfo(CLAUDE_INFO_FALLBACK));
    void (async () => {
      setClaudeInfo(null);
      try {
        setClaudeInfo(await detectClaudeCode());
      } catch (error) {
        console.warn("detect_claude falló:", formatError(error));
        setClaudeInfo(CLAUDE_INFO_FALLBACK);
      }
    })();
  }, []);

  // Comprobación silenciosa (sin vaciar lo mostrado) para saber la versión instalada.
  const refreshCliInfo = useCallback(async () => {
    const [claude, codex] = await Promise.all([detectClaudeCode().catch(() => null), detectCodex().catch(() => null)]);
    if (claude) setClaudeInfo(claude);
    if (codex) setCodexInfo(codex);
  }, []);
  const cliUpdates = useCliUpdates({ claude: claudeInfo, codex: codexInfo }, refreshCliInfo);
  // El uso de las cuentas se lee en segundo plano: la pestaña «Uso» abre con datos.
  useAccountUsageUpkeep(config?.settings ?? null, appInfo ? appInfo.homeDir || "/" : null);
  const { update: runCliUpdate, dismiss: dismissCliUpdate } = cliUpdates;
  const updateCli = useCallback((id: CliId) => {
    void runCliUpdate(id).then(showToast, (error: unknown) => showToast(formatError(error)));
  }, [runCliUpdate, showToast]);
  const pendingUpdates = [cliUpdates.status.claude, cliUpdates.status.codex]
    .filter(status => status.updating || (status.available && !status.dismissed));

  const openSettings = useCallback(() => { setSettingsInitialSection("appearance"); setSettingsOpen(true); }, []);
  const openProfiles = useCallback(() => { setSettingsInitialSection("profiles"); setSettingsOpen(true); }, []);

  // --- Persistencia (con debounce) --------------------------------------------

  /** Primer cambio aún sin guardar y si el último guardado falló. */
  const pendingSaveRef = useRef<number | null>(null);
  const saveFailedRef = useRef(false);

  // Títulos OSC y códigos de salida son estado transitorio. Solo los campos
  // restaurables deben reprogramar la escritura del archivo de configuración.
  const persistedTabsKey = JSON.stringify(tabs.map<PersistedTab>((tab) => ({
    id:tab.id,
    projectId: tab.projectId,
    kind: tab.kind,
    subtitle: tab.subtitle,
    conversationId:tab.conversationId,
    chatMode: tab.chatMode,
    chatModel: tab.chatModel ?? null,
    chatEffort: tab.chatEffort ?? null,
    handoff: normalizeHandoffReference(tab.handoff),
    workflow: normalizeAgentWorkflow(tab.workflow),
    agentRoom: normalizeAgentRoom(tab.agentRoom),
    agentTeam: normalizeAgentTeam(tab.agentTeam),
    launch: { profileId: tab.profileId, profileName: tab.profileName, command: tab.command, args: tab.args,
      shell: tab.shell, launchMode: tab.launchMode, env: tab.env },
  })));
  useEffect(() => {
    if (!config || !loadedRef.current || !restoredRef.current || !saveAllowedRef.current) return;
    const payload: AppConfig = {
      ...config,
      ui: {
        ...config.ui,
        lastTabs: JSON.parse(persistedTabsKey) as PersistedTab[],
      },
    };
    // Con cambios seguidos se guarda igualmente: como mucho 2 s después del primero.
    const since = pendingSaveRef.current ?? Date.now();
    pendingSaveRef.current = since;
    const timer = window.setTimeout(() => {
      pendingSaveRef.current = null;
      void saveConfig(payload)
        .then(() => { saveFailedRef.current = false; })
        .catch((error: unknown) => {
          console.warn("save_config falló:", formatError(error));
          // Se avisa una vez: si no, las pestañas y sus conversaciones se perderían en silencio al cerrar.
          if (!saveFailedRef.current) showToast(`No se pudieron guardar las pestañas: ${formatError(error)}`);
          saveFailedRef.current = true;
        });
    }, Math.max(0, Math.min(400, since + 2000 - Date.now())));
    return () => window.clearTimeout(timer);
  }, [config, persistedTabsKey, showToast]);

  // Tema y acento se aplican en vivo cuando cambia la configuración y, si la
  // apariencia es "system", también cuando el sistema cambia de modo.
  useEffect(() => { if (config) applyTimeFormat(config.settings.timeFormat); }, [config?.settings.timeFormat]);
  useEffect(() => {
    if (!config) return;
    applyTheme(config.settings.appearance, config.settings.theme || DEFAULT_SETTINGS.theme, config.settings.colorScheme,
      { hue: config.settings.surfaceHue, tint: config.settings.surfaceTint });
  }, [config?.settings.appearance, config?.settings.theme, config?.settings.colorScheme, config?.settings.surfaceHue, config?.settings.surfaceTint]);
  // Trex Browser lleva el mismo tono, acento y modo; se engancha una vez, con el tema ya aplicado.
  useEffect(() => { if (config) syncBrowserTheme(); }, [!!config]);
  useEffect(() => {
    if (config) applyDesign(config.settings);
  }, [config?.settings.terminalRadius, config?.settings.terminalMargin, config?.settings.terminalBorder, config?.settings.motion, config?.settings.glass, config?.settings.materialTint]);
  // Mica (Windows 11) sigue al ajuste guardado; el tema claro/oscuro lo sigue solo.
  useEffect(() => {
    if (config) syncWindowMaterial(config.settings.glass, config.settings.windowBackdrop);
  }, [config?.settings.glass, config?.settings.windowBackdrop]);

  // El icono sol/luna del pie de la sidebar refleja el modo realmente pintado.
  useEffect(() => onThemeChange(setThemeMode), []);

  // --- Restauración de la sesión anterior --------------------------------------

  useEffect(() => {
    if (!config || !trexChecked || restoredRef.current) return;
    restoredRef.current = true;
    // Publish the workspace together with its restored tabs, never in between.
    setWorkspaceReady(true);

    const settings = config.settings;
    const validIds = new Set(config.projects.map((project) => project.id));
    const requested =
      config.ui.activeProjectId && validIds.has(config.ui.activeProjectId)
        ? config.ui.activeProjectId
        : null;
    const fallbackProjectId = requested ?? config.projects[0]?.id ?? null;

    const setActiveProject = (projectId: string): void => {
      setConfig((prev) =>
        prev
          ? {
              ...prev,
              ui: { ...prev.ui, activeProjectId: projectId, lastProjectId: projectId },
            }
          : prev,
      );
    };

    if (fallbackProjectId) setActiveProject(fallbackProjectId);
    if (!settings.restoreOnStart) return;

    const persisted = (config.ui.lastTabs ?? []).filter(
      (tab) => validIds.has(tab.projectId) && tab.subtitle,
    );

    if (persisted.length > 0) {
      // Recrea las pestañas de la sesión anterior (mismo proyecto y comando).
      const restored = persisted.map((tab) => {
        const launch = restoreLaunch(tab, settings);
        return { ...buildTab(tab.projectId, launch.command ? tab.kind : "shell", tab.subtitle, settings), ...launch, id:tab.id ?? newSessionId(), conversationId:tab.conversationId ?? null, chatMode: tab.chatMode ?? null, chatModel: tab.chatModel ?? null, chatEffort: tab.chatEffort ?? null, handoff: tab.handoff ?? null, handoffRestored: !!tab.handoff?.pending, workflow: restoreAgentWorkflow(tab.workflow), agentRoom: restoreAgentRoom(tab.agentRoom), agentTeam: restoreAgentTeam(tab.agentTeam) };
      });
      setTabs(restored);
      // Proyecto activo: el persistido si tiene pestañas restauradas; si no, el de la primera.
      const preferredProject =
        fallbackProjectId && restored.some((tab) => tab.projectId === fallbackProjectId)
          ? fallbackProjectId
          : restored[0].projectId;
      const savedSplit = config.ui.splitLayouts[preferredProject];
      const preferredTab =
        restored.find((tab) => tab.projectId === preferredProject && tab.id === savedSplit?.panes.find(id => id !== null)) ??
        restored.find((tab) => tab.projectId === preferredProject) ?? restored[0];
      setActiveTabId(preferredTab.id);
      setActiveProject(preferredProject);
      return;
    }

    if (fallbackProjectId) {
      const profile = settings.autoRunClaude ? defaultProfile({ ...settings, profiles: profilesForInstallation(settings, trexInstalledRef.current) }) : null;
      const tab = buildTab(fallbackProjectId, profile?.provider ?? "shell", profile?.name ?? "shell", settings, profile);
      setTabs([tab]);
      setActiveTabId(tab.id);
    }
  }, [config, trexChecked]);

  // --- Coherencia de proyecto activo y pestañas --------------------------------

  useEffect(() => {
    if (!config) return;
    const exists = config.projects.some((project) => project.id === config.ui.activeProjectId);
    if (!exists) {
      const first = config.projects[0]?.id ?? null;
      if (first !== config.ui.activeProjectId) {
        setConfig((prev) =>
          prev
            ? {
                ...prev,
                ui: {
                  ...prev.ui,
                  activeProjectId: first,
                  lastProjectId: first ?? prev.ui.lastProjectId,
                },
              }
            : prev,
        );
      }
      if (first === null) setActiveTabId(null);
    }
  }, [config]);

  const activeProjectId = config?.ui.activeProjectId ?? null;

  const projectTabs = useMemo(
    () => (activeProjectId ? tabs.filter((tab) => tab.projectId === activeProjectId) : []),
    [tabs, activeProjectId],
  );
  const split = visibleSplit(activeProjectId ? config?.ui.splitLayouts[activeProjectId] ?? null : null,projectTabs.map(tab => tab.id),activeTabId);
  const paneExpanded = expandedPaneId === activeTabId && !!split?.panes.includes(expandedPaneId);
  const displayedSplit = paneExpanded ? null : split;
  const updateSplit = useCallback((layout: SplitLayout | null) => {
    setConfig(previous => {
      if (!previous?.ui.activeProjectId) return previous;
      const splitLayouts = { ...previous.ui.splitLayouts };
      if (layout) splitLayouts[previous.ui.activeProjectId] = layout; else delete splitLayouts[previous.ui.activeProjectId];
      return { ...previous,ui:{ ...previous.ui,splitLayouts } };
    });
  },[]);
  const changeSplit = useCallback((direction: SplitDirection | null) => {
    const current = configRef.current, active = activeTabIdRef.current;
    if (!current?.ui.activeProjectId || !active) return;
    const ids = tabsRef.current.filter(tab => tab.projectId === current.ui.activeProjectId).map(tab => tab.id);
    if (!ids.includes(active)) return;
    setExpandedPaneId(null);
    const previous = visibleSplit(current.ui.splitLayouts[current.ui.activeProjectId] ?? null,ids,active);
    updateSplit(direction ? createSplitLayout(direction, ids, active, previous) : null);
  },[updateSplit]);
  const toggleSplit = useCallback(() => changeSplit(split ? null : "columns"), [changeSplit,split]);
  const focusOtherPane = useCallback(() => {
    if (!split) return;
    const ids = split.panes.filter((id): id is string => id !== null);
    const index = ids.indexOf(activeTabIdRef.current ?? "");
    if (ids.length) setActiveTabId(ids[(index + 1) % ids.length]);
  },[split]);
  const splitKey = JSON.stringify(split);
  useEffect(() => {
    if (split && activeProjectId && JSON.stringify(config?.ui.splitLayouts[activeProjectId]) !== splitKey) updateSplit(split);
  },[splitKey,activeProjectId,updateSplit]);

  // Si la pestaña activa no es del proyecto visible, activamos la última suya.
  useEffect(() => {
    if (projectTabs.length === 0) return;
    if (!projectTabs.some((tab) => tab.id === activeTabId)) {
      setActiveTabId(projectTabs[projectTabs.length - 1].id);
    }
  }, [projectTabs, activeTabId]);

  // --- Proyectos ---------------------------------------------------------------

  const selectProject = useCallback((projectId: string) => {
    setExpandedPaneId(null);
    setConfig((prev) =>
      prev
        ? { ...prev, ui: { ...prev.ui, activeProjectId: projectId, lastProjectId: projectId } }
        : prev,
    );
    const savedPanes = configRef.current?.ui.splitLayouts[projectId]?.panes;
    const lastTab = [...tabsRef.current].reverse().find(tab => tab.projectId === projectId && savedPanes?.includes(tab.id)) ??
      [...tabsRef.current].reverse().find(tab => tab.projectId === projectId);
    if (lastTab) setActiveTabId(lastTab.id);
  }, []);

  const addProject = useCallback(async () => {
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement.closest<HTMLElement>("button") : null;
    let selected: string | null = null;
    try {
      selected = await open({
        directory: true,
        multiple: false,
        title: "Selecciona la carpeta del proyecto",
      });
    } catch (error) {
      void dialog.alert({
        trigger,
        title: "No se pudo abrir el selector de carpetas",
        message: "Comprueba los permisos del sistema e inténtalo de nuevo.",
        detail: formatError(error),
      });
      return;
    }
    if (typeof selected !== "string" || !selected) return;

    const path = selected;
    const existing = configRef.current?.projects.find(
      (project) => normalizePath(project.path) === normalizePath(path),
    );
    if (existing) {
      selectProject(existing.id);
      showToast(`Ese proyecto ya está en la lista: ${existing.name}`);
      return;
    }

    const projects = configRef.current?.projects ?? [];
    const project: Project = {
      id: newProjectId(),
      name: deriveProjectName(path),
      path,
      color: PROJECT_COLORS[projects.length % PROJECT_COLORS.length],
      createdAt: Date.now(),
      lastOpenedAt: null,
    };
    setConfig((prev) =>
      prev
        ? {
            ...prev,
            projects: [...prev.projects, project],
            ui: { ...prev.ui, activeProjectId: project.id, lastProjectId: project.id,
              projectFilter: includeAddedProject(prev.ui.projectFilter, project.id) },
          }
        : prev,
    );
    showToast(`Proyecto añadido: ${project.name}`);
  }, [dialog, selectProject, showToast]);

  const renameProject = useCallback((projectId: string, name: string) => {
    const clean = name.trim();
    if (!clean) return;
    setConfig((prev) =>
      prev
        ? {
            ...prev,
            projects: prev.projects.map((project) =>
              project.id === projectId ? { ...project, name: clean } : project,
            ),
          }
        : prev,
    );
  }, []);

  const toggleFavorite = useCallback((projectId: string) => {
    setConfig(previous => previous ? { ...previous, projects: previous.projects.map(project => project.id === projectId ? { ...project, favorite: !project.favorite } : project) } : previous);
  }, []);

  const setProjectFilter = useCallback((filter: ProjectFilter) => {
    setConfig(previous => previous ? { ...previous, ui: { ...previous.ui,
      projectFilter: normalizeProjectFilter(filter, previous.projects) } } : previous);
  }, []);

  const deleteProject = useCallback(async (projectId: string, trigger: HTMLElement, returnFocus: HTMLElement | null) => {
    const project = configRef.current?.projects.find((item) => item.id === projectId);
    if (!project) return;

    const ok = await dialog.confirm({
      trigger,
      returnFocus,
      title: `Eliminar «${project.name}»`,
      message: "Se quitará el proyecto de la lista y se cerrarán sus pestañas abiertas.",
      detail: "La carpeta del proyecto no se modifica: solo desaparece de trex.",
      confirmLabel: "Eliminar",
      cancelLabel: "Cancelar",
      tone: "danger",
    });
    if (!ok) return;

    // Termina los procesos del proyecto antes de quitarlo de la lista.
    const closingTabs = tabsRef.current.filter((item) => item.projectId === projectId);
    for (const tab of closingTabs) closingTabIdsRef.current.add(tab.id);
    for (const tab of closingTabs) {
      try {
        await ptyKill(tab.id);
      } catch {
        /* la sesión ya no existía */
      }
    }

    const remainingTabs = tabsRef.current.filter((tab) => tab.projectId !== projectId);
    tabsRef.current = remainingTabs;
    for (const tab of closingTabs) closingTabIdsRef.current.delete(tab.id);
    setTabs(remainingTabs);
    if (!remainingTabs.some((tab) => tab.id === activeTabIdRef.current)) {
      const nextActive =
        remainingTabs.length > 0 ? remainingTabs[remainingTabs.length - 1].id : null;
      activeTabIdRef.current = nextActive;
      setActiveTabId(nextActive);
    }

    setConfig((prev) => {
      if (!prev) return prev;
      const projects = prev.projects.filter((item) => item.id !== projectId);
      const nextActive =
        prev.ui.activeProjectId === projectId
          ? projects[0]?.id ?? null
          : prev.ui.activeProjectId;
      return {
        ...prev,
        projects,
        ui: { ...prev.ui, activeProjectId: nextActive, lastProjectId: nextActive,
          projectFilter: normalizeProjectFilter(prev.ui.projectFilter, projects) },
      };
    });
  }, [dialog]);

  const revealProject = useCallback(
    (projectId: string) => {
      const project = configRef.current?.projects.find((item) => item.id === projectId);
      if (!project) return;
      void openPath(project.path).catch((error: unknown) => {
        showToast(`No se pudo abrir la carpeta: ${formatError(error)}`);
      });
    },
    [showToast],
  );

  const copyPath = useCallback(
    (path: string) => {
      void navigator.clipboard
        .writeText(path)
        .then(() => showToast("Ruta copiada al portapapeles"))
        .catch(() => showToast("No se pudo copiar la ruta"));
    },
    [showToast],
  );

  // --- Pestañas ---------------------------------------------------------------

  const openTab = useCallback((projectId: string, profileId: string | null, conversation?: Conversation, handoff?: HandoffReference, model?: string | null, workflow?: AgentWorkflow, room?: AgentRoom, team?: AgentTeam) => {
    const currentConfig = configRef.current;
    if (!currentConfig) return;
    const settings = currentConfig.settings;
    if (!currentConfig.projects.some((project) => project.id === projectId)) return;

    const profile = profileId ? profilesForInstallation(settings, trexInstalledRef.current).find(item => item.id === profileId) : null;
    if (profileId && !profile && !workflow) return;
    const sameKind = tabsRef.current.filter(
      (tab) => tab.projectId === projectId && tab.profileId === (profile?.id ?? null),
    );
    const base = profile?.name ?? "shell";
    const subtitle =
      sameKind.length === 0 ? base : `${base} ${sameKind.length + 1}`;

    const tab = buildTab(projectId, profile?.provider ?? "shell", subtitle, settings, profile ?? null);
    if (team) {
      Object.assign(tab, team.master.agent.launch);
      tab.agentTeam = team; tab.kind = team.master.agent.provider; tab.subtitle = "Equipo delegado";
      tab.chatModel = team.master.agent.model; tab.chatEffort = team.master.agent.effort ?? null;
      tab.chatMode = "plan"; tab.conversationId = team.master.conversationId;
    }
    if (room) {
      tab.agentRoom = room;
      tab.subtitle = "Chat de equipo";
      tab.chatModel = room.planner.agent.model;
      tab.chatEffort = room.planner.agent.effort ?? null;
    }
    if (workflow) {
      const stage = workflow.role === "planner" ? workflow.planner : workflow.executor;
      Object.assign(tab, stage.launch);
      tab.kind = stage.provider;
      tab.workflow = workflow;
      tab.chatModel = stage.model;
      tab.chatEffort = stage.effort ?? null;
      tab.chatMode = workflow.role === "planner" ? "plan" : stage.provider === "claude" ? "acceptEdits" : "auto";
      tab.handoff = handoff;
      tab.subtitle = `${workflow.role === "planner" ? "Plan" : "Implementación"} · ${stage.profileName}`;
    }
    if (handoff && profile && !workflow) {
      tab.handoff = handoff;
      tab.chatModel = normalizeModelChoice(model);
      tab.subtitle = `${profile.name} · continuación de ${handoff.sourceLabel}`;
    }
    if (conversation && profile) {
      // El chat retoma la conversación por su id; la terminal necesita la opción en el comando.
      const chat = profile.provider !== "codex" || codexChatSupported(tab.args);
      if (!chat) Object.assign(tab,resumedLaunch(tab,profile.provider,conversation.id));
      tab.conversationId = conversation.id; tab.subtitle = conversation.title;
    }
    // Actualiza el espejo al instante para numerar bien aperturas seguidas.
    const nextTabs = [...tabsRef.current, tab];
    tabsRef.current = nextTabs;
    activeTabIdRef.current = tab.id;
    setTabs(nextTabs);
    setActiveTabId(tab.id);
    setConfig((prev) =>
      prev
        ? {
            ...prev,
            projects: prev.projects.map((project) =>
              project.id === projectId ? { ...project, lastOpenedAt: Date.now() } : project,
            ),
            ui: { ...prev.ui, activeProjectId: projectId, lastProjectId: projectId },
          }
        : prev,
    );
    return tab.id;
  }, []);

  // Modo llamada: las órdenes habladas abren proyectos y sesiones por el mismo camino que la interfaz.
  const openVoiceSession = useCallback((projectId: string): string | null => {
    const settings = configRef.current?.settings;
    if (!settings) return null;
    return openTab(projectId, defaultProfile({ ...settings, profiles: profilesForInstallation(settings, trexInstalledRef.current) }).id) ?? null;
  }, [openTab]);
  useVoiceCall({ projects: config?.projects ?? NO_PROJECTS, activeProjectId, selectProject, openSession: openVoiceSession });

  const requestHandoff =useCallback((context: HandoffContext) => {
    const source = tabsRef.current.find(tab => tab.id === context.source.sessionId);
    if (!source || source.projectId !== context.source.projectId || source.activity === "working" || source.activity === "waiting") {
      showToast("Espera a que termine la respuesta o detenla antes de continuar en otro perfil.");
      return;
    }
    const generation = ++handoffGeneration.current;
    setHandoffDialog({ context, prepared: null, loading: true, error: null });
    // Otro asistente continúa sin este historial: necesita también las diferencias pendientes.
    void prepareHandoff(context, { git: "full" }).then(prepared => {
      if (handoffGeneration.current === generation) setHandoffDialog({ context, prepared, loading: false, error: null });
    }).catch(error => {
      if (handoffGeneration.current === generation) setHandoffDialog({ context, prepared: null, loading: false, error: formatError(error) });
    });
  }, [showToast]);

  const closeHandoff = useCallback(() => {
    if (handoffSubmittingRef.current) return;
    handoffGeneration.current++;
    setHandoffDialog(null);
  }, []);

  const continueHandoff = (profileId: string, instruction: string, model: string | null): void => {
    if (handoffSubmittingRef.current || !handoffDialog?.prepared) return;
    const source = tabsRef.current.find(tab => tab.id === handoffDialog.context.source.sessionId);
    const current = configRef.current;
    const profile = current ? profilesForInstallation(current.settings, trexInstalledRef.current).find(item => item.id === profileId) : null;
    if (!source || !current || !profile || !current.projects.some(project => project.id === source.projectId)) {
      setHandoffDialog(previous => previous && { ...previous, error: "El proyecto o el perfil ya no está disponible." });
      return;
    }
    const reason = handoffTargetReason(profile, source.profileId, current.settings);
    if (reason || source.activity === "working" || source.activity === "waiting") {
      setHandoffDialog(previous => previous && { ...previous, error: reason ?? "Detén la respuesta del origen antes de continuar." });
      return;
    }
    handoffSubmittingRef.current = true;
    setHandoffSubmitting(true);
    const reference: HandoffReference = { id: handoffDialog.prepared.id, sourceLabel: handoffDialog.prepared.sourceLabel,
      pending: true, instruction: sanitizeHandoffInstruction(instruction) };
    const surface = handoffSurfaceRef.current;
    handoffGeneration.current++;
    setHandoffDialog(null);
    // El destino recibe el foco cuando el diálogo ya ha liberado el proyecto.
    requestAnimationFrame(() => waitForMotion(surface, () => requestAnimationFrame(() => {
      openTab(source.projectId, profileId, undefined, reference, model);
      handoffSubmittingRef.current = false;
      setHandoffSubmitting(false);
    })));
  };

  const handoffConsumed = useCallback((tabId: string, id: string) => {
    const next = tabsRef.current.map(tab => tab.id === tabId && tab.handoff?.id === id && tab.handoff.pending
      ? { ...tab, handoff: { ...tab.handoff, pending: false } } : tab);
    tabsRef.current = next;
    setTabs(next);
  }, []);

  const changeWorkflow = useCallback((tabId: string, runId: string, patch: Partial<AgentWorkflow>, entireRun = false) => {
    const next = tabsRef.current.map(tab => tab.workflow?.id === runId && (entireRun || tab.id === tabId)
      ? { ...tab, workflow: { ...tab.workflow, ...patch } } : tab);
    tabsRef.current = next;
    setTabs(next);
  }, []);

  const openWorkflow = useCallback((projectId: string, context?: HandoffContext, itemIds: string[] = []) => {
    const project = configRef.current?.projects.find(item => item.id === projectId);
    if (!project) return;
    workflowSourceRef.current = context ? { context, itemIds } : null;
    setWorkflowError(null);
    setWorkflowProject(project);
  }, []);
  const closeWorkflow = useCallback(() => { if (!workflowStartingRef.current) setWorkflowProject(null); }, []);
  const planInChat = useCallback((context: HandoffContext, itemIds: string[]) => {
    openWorkflow(context.source.projectId, context, itemIds);
  }, [openWorkflow]);
  const changeRoom = useCallback((tabId: string, room: AgentRoom) => {
    setTabs(previous => previous.map(tab => tab.id === tabId && tab.agentRoom?.id === room.id ? { ...tab, agentRoom: room } : tab));
  }, [setTabs]);

  const startWorkflow = async (request: WorkflowRequest): Promise<void> => {
    if (workflowStartingRef.current || !workflowProject) return;
    const current = configRef.current;
    const project = current?.projects.find(item => item.id === workflowProject.id);
    if (!current || !project) { setWorkflowError("El proyecto ya no está disponible."); return; }
    const pick = (choice: WorkflowRequest["planner"]): WorkflowAgent => {
      const profile = profilesForInstallation(current.settings, trexInstalledRef.current).find(item => item.id === choice.profileId);
      if (!profile) throw new Error("El perfil elegido ya no está disponible.");
      const reason = handoffTargetReason(profile, null, current.settings);
      if (reason) throw new Error(reason);
      const model = normalizeModelChoice(choice.model);
      if (choice.model !== null && !model) throw new Error("El modelo elegido no es válido.");
      const effort = normalizeEffortChoice(choice.effort);
      if (choice.effort != null && !effort) throw new Error("El nivel de esfuerzo elegido no es válido.");
      if (choice.fast != null && typeof choice.fast !== "boolean") throw new Error("La velocidad elegida no es válida.");
      const launch = launchForProfile(current.settings, profile);
      // Cada etapa tiene su propio modo; un --permission-mode del perfil no debe sustituirlo.
      if (profile.provider === "claude") launch.args = claudePlanningArgs(launch.args, IS_WINDOWS && launch.shell !== "wsl");
      return { profileId: profile.id, profileName: profile.name, provider: profile.provider, model, effort, ...(typeof choice.fast === "boolean" ? { fast: choice.fast } : {}), launch };
    };
    workflowStartingRef.current = true;
    setWorkflowSubmitting(true);
    setWorkflowError(null);
    try {
      const planner = pick(request.planner), executor = pick(request.executor);
      const captured = workflowSourceRef.current;
      const sourceTab = captured ? tabsRef.current.find(tab => tab.id === captured.context.source.sessionId && tab.projectId === project.id) : null;
      if (captured && (!sourceTab || sourceTab.activity !== "idle")) throw new Error("Este chat cambió mientras configurabas el equipo. Espera a que termine y vuelve a intentarlo.");
      const matchesSource = (agent: WorkflowAgent) => sourceTab && agent.profileId === sourceTab.profileId && agent.provider === sourceTab.kind;
      const sourceRole: RoomRole | null = matchesSource(executor) ? "executor" : matchesSource(planner) ? "planner" : null;
      if (sourceTab && !sourceRole) throw new Error("Para conservar esta conversación, elige su perfil actual en una de las dos etapas.");
      if (sourceTab && sourceRole) {
        const participant = sourceRole === "planner" ? planner : executor;
        participant.launch = { profileId: sourceTab.profileId, profileName: sourceTab.profileName, command: sourceTab.command,
          args: sourceTab.kind === "claude" ? claudePlanningArgs(sourceTab.args, IS_WINDOWS && sourceTab.shell !== "wsl") : sourceTab.args,
          shell: sourceTab.shell, launchMode: sourceTab.launchMode, env: sourceTab.env };
        participant.profileName = sourceTab.profileName ?? participant.profileName;
      }
      const id = crypto.randomUUID();
      // Only the role that does not resume this chat receives it; that delivery attaches
      // its own current Git snapshot, so the stored context needs none.
      const inherited = captured ? await prepareHandoff(captured.context, { git: "none" }) : null;
      const permission = (choice: WorkflowRequest["planner"], agent: WorkflowAgent, planning: boolean): string | null => {
        if (choice.mode != null && !validAgentPermission(agent.provider, choice.mode)) throw new Error("El modo de permisos no es válido para este asistente.");
        return choice.mode ?? defaultAgentPermission(agent.provider, !planning);
      };
      const room: AgentRoom = { id: `room-${id}`, planner: { agent: planner, conversationId: sourceRole === "planner" ? sourceTab!.conversationId : null, mode: permission(request.planner, planner, true) },
        executor: { agent: executor, conversationId: sourceRole === "executor" ? sourceTab!.conversationId : null,
          mode: request.executor.mode !== undefined ? permission(request.executor, executor, false) : sourceRole === "executor" ? sourceTab!.chatMode : defaultAgentPermission(executor.provider) },
        active: "planner", phase: "idle", cycle: 0, pending: null,
        setupContext: inherited ? { id: inherited.id, sourceLabel: inherited.sourceLabel, pending: false } : null,
        ...(inherited && sourceRole ? { setupRole: sourceRole === "planner" ? "executor" as const : "planner" as const } : {}),
        order: sourceRole ? captured!.itemIds.map(item => `${sourceRole}::${item}`) : [], plan: null, error: null };
      const surface = workflowSurfaceRef.current;
      setWorkflowProject(null);
      requestAnimationFrame(() => waitForMotion(surface, () => requestAnimationFrame(() => {
        if (sourceTab) {
          const latest = tabsRef.current.find(tab => tab.id === sourceTab.id);
          if (latest && latest.activity === "idle" && latest.conversationId === sourceTab.conversationId) {
            setTabs(previous => previous.map(tab => tab.id === sourceTab.id ? { ...tab, agentRoom: room, workflow: null, handoff: null } : tab));
            setActiveTabId(sourceTab.id);
          } else showToast("El chat cambió antes de iniciar el equipo. Vuelve a configurar la planificación.");
        } else if (!openTab(project.id, planner.profileId, undefined, undefined, planner.model, undefined, room)) showToast("No se pudo abrir el chat compartido: el proyecto ya no está disponible.");
        workflowStartingRef.current = false;
        setWorkflowSubmitting(false);
      })));
    } catch (error) {
      setWorkflowError(formatError(error));
      workflowStartingRef.current = false;
      setWorkflowSubmitting(false);
    }
  };

  const startTeam = async (request: TeamRequest): Promise<void> => {
    if (workflowStartingRef.current || !workflowProject) return;
    const config = configRef.current, project = config?.projects.find(project => project.id === workflowProject.id);
    if (!config || !project) { setWorkflowError("El proyecto ya no está disponible."); return; }
    workflowStartingRef.current = true; setWorkflowSubmitting(true); setWorkflowError(null);
    try {
      const pick = (choice: TeamMemberChoice, principal = false): TeamMember => {
        const profile = profilesForInstallation(config.settings, trexInstalledRef.current).find(profile => profile.id === choice.profileId);
        if (!profile) throw new Error("La cuenta elegida ya no está disponible.");
        const reason = handoffTargetReason(profile, null, config.settings);
        if (reason) throw new Error(reason);
        const model = normalizeModelChoice(choice.model), effort = normalizeEffortChoice(choice.effort);
        if (choice.model !== null && !model || choice.effort !== null && !effort) throw new Error("Modelo o esfuerzo no válidos.");
        const launch = launchForProfile(config.settings, profile);
        if (profile.provider === "claude") launch.args = claudePlanningArgs(launch.args, IS_WINDOWS && launch.shell !== "wsl");
        const mode = choice.mode ?? defaultAgentPermission(profile.provider, choice.canWrite);
        if (mode != null && !validAgentPermission(profile.provider, mode)) throw new Error("El modo de permisos no es válido para esta cuenta.");
        return { id: choice.id, name: sanitizeHandoffText(choice.name), role: principal ? "coordinator" : choice.role,
          instructions: sanitizeHandoffText(choice.instructions), canWrite: mode !== "plan", mode,
          // Explicit Trex Browser choice from the dialog; absent means the role default.
          ...(typeof choice.browser === "boolean" ? { browser: choice.browser } : {}),
          agent: { profileId: profile.id, profileName: profile.name, provider: profile.provider, model, effort, ...(typeof choice.fast === "boolean" ? { fast: choice.fast } : {}), launch }, conversationId: null };
      };
      const master = pick(request.master, true), workers = request.workers.map(worker => pick(worker));
      const captured = workflowSourceRef.current;
      const sourceTab = captured ? tabsRef.current.find(tab => tab.id === captured.context.source.sessionId && tab.projectId === project.id) : null;
      if (captured && (!sourceTab || sourceTab.activity !== "idle")) throw new Error("Espera a que termine este chat antes de cambiar su flujo de trabajo.");
      const sourceMember = sourceTab ? [master,...workers].find(member => member.agent.profileId === sourceTab.profileId && member.agent.provider === sourceTab.kind) : null;
      if (sourceTab && !sourceMember) throw new Error("Conserva la cuenta de este chat en el principal o en uno de los subagentes para mantener su historial.");
      if (sourceTab && sourceMember) {
        const queue = await readQueuedMessages(sourceTab.id);
        if (queue.messages.length || queue.receipt || queue.outbox?.length) throw new Error("Resuelve los mensajes pendientes de la cola antes de convertir este chat en un equipo.");
        sourceMember.conversationId = sourceTab.conversationId;
        sourceMember.agent.launch = { profileId: sourceTab.profileId, profileName: sourceTab.profileName, command: sourceTab.command,
          args: sourceTab.kind === "claude" ? claudePlanningArgs(sourceTab.args, IS_WINDOWS && sourceTab.shell !== "wsl") : sourceTab.args,
          shell: sourceTab.shell, launchMode: sourceTab.launchMode, env: sourceTab.env };
      }
      const id = "team-" + crypto.randomUUID();
      let team = normalizeAgentTeam({ id, epoch: crypto.randomUUID(), master, workers, phase: "running",
        order: sourceMember ? captured!.itemIds.map(id => sourceMember.id + "::" + id) : [], initial: null, setup: { context: null }, error: null,
        ...(request.budget ? { budget: request.budget } : {}) });
      if (!team) throw new Error("La configuración del equipo no es válida.");
      // The member whose conversationId came from this chat resumes it and already has the
      // history. The setup context is for the principal's first message, so a principal
      // that is the source gets none (setup stays { context: null }); a principal that is
      // not receives it. Branch and status suffice: the principal reads diffs if needed.
      const inherited = captured && sourceMember !== master ? await prepareHandoff(captured.context, { git: "status" }) : null;
      team = { ...team, setup: { context: inherited ? { id: inherited.id, sourceLabel: inherited.sourceLabel, pending: false } : null } };
      teamConfigurationText(team,inherited?.content);
      const readyTeam = team;
      const surface = workflowSurfaceRef.current;
      setWorkflowProject(null);
      requestAnimationFrame(() => waitForMotion(surface, () => requestAnimationFrame(() => {
        if (sourceTab) {
          const current = tabsRef.current.find(tab => tab.id === sourceTab.id);
          if (current?.activity === "idle" && current.conversationId === sourceTab.conversationId) {
            setTabs(previous => previous.map(tab => tab.id === sourceTab.id ? { ...tab, ...readyTeam.master.agent.launch,
              kind: readyTeam.master.agent.provider, agentTeam: readyTeam, agentRoom: null, workflow: null, handoff: null,
              conversationId: readyTeam.master.conversationId, chatMode: "plan", chatModel: readyTeam.master.agent.model, chatEffort: readyTeam.master.agent.effort ?? null } : tab));
            setActiveTabId(sourceTab.id);
          } else showToast("El chat cambió antes de iniciar el equipo. Vuelve a configurarlo.");
        } else if (!openTab(project.id, master.agent.profileId, undefined, undefined, master.agent.model, undefined, undefined, readyTeam)) showToast("No se pudo abrir el equipo.");
        workflowStartingRef.current = false; setWorkflowSubmitting(false);
      })));
    } catch (error) {
      setWorkflowError(formatError(error)); workflowStartingRef.current = false; setWorkflowSubmitting(false);
    }
  };

  const implementWorkflow = useCallback(async (tabId: string, runId: string, context?: HandoffContext): Promise<void> => {
    const source = tabsRef.current.find(tab => tab.id === tabId);
    const workflow = source?.workflow;
    if (!source || !workflow || workflow.id !== runId || workflow.role !== "planner" || workflowTransfersRef.current.has(runId)) return;
    // Un destino ya reservado siempre se reutiliza, incluso tras restaurar las pestañas.
    const existing = tabsRef.current.find(tab => tab.workflow?.id === runId && tab.workflow.role === "executor");
    if (existing) { setActiveTabId(existing.id); return; }
    if (workflow.peerTabId) { changeWorkflow(tabId, runId, { status: "paused", error: "El ejecutor ya se abrió y su pestaña está cerrada. Recupera esa conversación para revisar su progreso." }); return; }
    if (context && workflow.status !== "planning" && workflow.status !== "waiting") return;
    if (!context && !workflow.plan) return;
    workflowTransfersRef.current.add(runId);
    changeWorkflow(tabId, runId, { status: "transferring", error: null });
    try {
      // Plan, request and tasks for the executor: branch and status suffice, it inspects the diffs itself.
      const prepared = context ? await prepareHandoff(context, { git: "status" }) : null;
      const current = tabsRef.current.find(tab => tab.id === tabId);
      if (current?.workflow?.id !== runId || current.workflow.status !== "transferring") return;
      const plan: HandoffReference = prepared ? { id: prepared.id, sourceLabel: workflow.planner.profileName, pending: true, instruction: IMPLEMENTATION_INSTRUCTION } : { ...workflow.plan!, pending: true };
      changeWorkflow(tabId, runId, { plan });
      const executor: AgentWorkflow = { ...workflow, role: "executor", status: "executing", plan, peerTabId: tabId, error: null };
      const targetId = openTab(source.projectId, workflow.executor.profileId, undefined, plan, workflow.executor.model, executor);
      if (!targetId) throw new Error("No se pudo abrir el ejecutor: el proyecto ya no está disponible.");
      changeWorkflow(tabId, runId, { status: "executing", peerTabId: targetId, error: null });
    } catch (error) {
      changeWorkflow(tabId, runId, { status: "failed", error: `No se pudo entregar el plan: ${formatError(error)}` });
    } finally { workflowTransfersRef.current.delete(runId); }
  }, [changeWorkflow, openTab]);

  const workflowStatus = useCallback((tabId: string, runId: string, status: AgentWorkflow["status"], error: string | null = null) => {
    changeWorkflow(tabId, runId, { status, error }, status === "paused" || status === "completed" || status === "failed");
  }, [changeWorkflow]);

  const selectWorkflowPeer = useCallback((id: string) => {
    const tab = tabsRef.current.find(item => item.id === id);
    if (!tab) { showToast("La otra conversación ya no está abierta."); return; }
    setConfig(previous => previous && { ...previous, ui: { ...previous.ui, activeProjectId: tab.projectId } });
    setActiveTabId(id);
  }, [showToast]);

  const selectPaneSession = (index: number, id: string): void => {
    if (!split || !projectTabs.some(tab => tab.id === id)) return;
    const next = replaceSplitPane(split, index, id);
    if (next === split) return;
    updateSplit(next);
    setActiveTabId(id);
    if (paneExpanded) setExpandedPaneId(id);
  };

  const newPaneSession = (index: number, profileId: string | null): void => {
    if (!split || !activeProjectId) return;
    const id = openTab(activeProjectId, profileId);
    if (id) {
      updateSplit(replaceSplitPane(split, index, id));
      if (paneExpanded) setExpandedPaneId(id);
    }
  };

  const closeTab = useCallback(async (tabId: string, trigger?: HTMLElement) => {
    const tab = tabsRef.current.find((item) => item.id === tabId);
    if (!tab) return;

    const settings = configRef.current?.settings;
    if (settings?.confirmCloseTab && !tab.exited) {
      const ok = await dialog.confirm({
        trigger,
        title: `Cerrar «${sessionLabel(tab)}»`,
        message: "El proceso que se está ejecutando en esta pestaña se terminará.",
        detail: "Puedes volver a abrirla cuando quieras desde Nueva sesión (+).",
        confirmLabel: "Cerrar pestaña",
        cancelLabel: "Cancelar",
        tone: "danger",
      });
      if (!ok) return;
    }

    closingTabIdsRef.current.add(tabId);
    try {
      await ptyKill(tabId);
    } catch {
      /* la sesión puede haber terminado ya */
    }

    const next = tabsRef.current.filter((item) => item.id !== tabId);
    tabsRef.current = next;
    closingTabIdsRef.current.delete(tabId);
    setTabs(next);
    if (activeTabIdRef.current === tabId) {
      const paneIds = configRef.current?.ui.splitLayouts[tab.projectId]?.panes;
      const lastOfProject = [...next].reverse().find(item => item.projectId === tab.projectId && paneIds?.includes(item.id)) ??
        [...next].reverse().find(item => item.projectId === tab.projectId);
      const nextActive = lastOfProject ? lastOfProject.id : null;
      activeTabIdRef.current = nextActive;
      setActiveTabId(nextActive);
    }
  }, [dialog]);

  const renameTab = useCallback((tabId: string, subtitle: string) => {
    setTabs((prev) =>
      prev.map((tab) => (tab.id === tabId ? { ...tab, subtitle } : tab)),
    );
  }, []);

  const closeActiveTab = useCallback(() => {
    const id = activeTabIdRef.current;
    if (id) void closeTab(id, document.querySelector<HTMLElement>(".session-row.active .session-close") ?? undefined);
  }, [closeTab]);

  const cycleTab = useCallback((direction: 1 | -1) => {
    const currentConfig = configRef.current;
    if (!currentConfig) return;
    const list = tabsRef.current.filter(
      (tab) => tab.projectId === currentConfig.ui.activeProjectId,
    );
    if (list.length === 0) return;
    const currentIndex = list.findIndex((tab) => tab.id === activeTabIdRef.current);
    const nextIndex =
      currentIndex === -1 ? 0 : (currentIndex + direction + list.length) % list.length;
    setActiveTabId(list[nextIndex].id);
  }, []);

  const selectTabByIndex = useCallback((index: number) => {
    const currentConfig = configRef.current;
    if (!currentConfig) return;
    const list = tabsRef.current.filter(
      (tab) => tab.projectId === currentConfig.ui.activeProjectId,
    );
    if (index < 0 || index >= list.length) return;
    setActiveTabId(list[index].id);
  }, []);

  const handleTabExit = useCallback((tabId: string, code: number | null) => {
    setTabs((prev) =>
      prev.map((tab) => (tab.id === tabId ? { ...tab, exited: true, exitCode: code, activity: "idle" } : tab)),
    );
  }, []);

  const handleTabRunning = useCallback((tabId: string) => {
    setTabs(prev => {
      const tab = prev.find(item => item.id === tabId);
      if (!tab || (!tab.exited && tab.exitCode === null)) return prev;
      return prev.map(item => item.id === tabId ? { ...item, exited: false, exitCode: null } : item);
    });
  }, []);

  const handleTabActivity = useCallback((tabId: string, activity: AgentActivity) => {
    setTabs(prev => {
      const tab = prev.find(item => item.id === tabId);
      if (!tab || tab.activity === activity) return prev;
      return prev.map(item => item.id === tabId ? { ...item, activity } : item);
    });
  }, []);

  const handleAgentNotice = useCallback((tabId: string, kind: AgentNoticeKind) => {
    const tab = tabsRef.current.find(item => item.id === tabId);
    const project = configRef.current?.projects.find(item => item.id === tab?.projectId);
    if (!tab || tab.kind === "shell" || !project || closingTabIdsRef.current.has(tabId)) return;
    const notice: AgentNotice = { id: ++noticeIdRef.current, tabId, projectId: project.id,
      sessionName: sessionLabel(tab), projectName: project.name, provider: tab.kind, kind, createdAt: Date.now(), read: false };
    setNotices(previous => [notice, ...previous].slice(0, 50));
    void playNotificationSound();
    const settings = configRef.current?.settings;
    if (settings) void showDesktopNotice(notice,settings).catch(error => console.warn("Notificación del escritorio:",formatError(error)));
  }, [playNotificationSound]);

  const openNotice = useCallback((notice: AgentNotice) => {
    setNotices(previous => previous.map(item => item.id === notice.id ? { ...item, read: true } : item));
    const tab = tabsRef.current.find(item => item.id === notice.tabId);
    if (tab) {
      setSearch("");
      selectProject(tab.projectId);
      setActiveTabId(tab.id);
    } else showToast("Esta sesión ya se cerró.");
  }, [selectProject, showToast]);

  const toggleNotificationSound = useCallback(() => {
    setConfig(previous => previous ? { ...previous, ui: { ...previous.ui, notificationSound: !previous.ui.notificationSound } } : previous);
  }, []);

  /** El chat guarda su conversación para reanudarla al reabrir trex. */
  const handleConversation = useCallback((tabId: string, conversationId: string) => {
    setTabs(prev => prev.some(tab => tab.id === tabId && tab.conversationId !== conversationId)
      ? prev.map(tab => tab.id === tabId ? { ...tab, conversationId } : tab) : prev);
  }, []);

  /** Como en las apps de chat, la sesión toma el nombre del primer mensaje si no se renombró. */
  const handleChatMode = useCallback((tabId: string, provider: AgentProvider, mode: string) => {
    setTabs(prev => prev.some(tab => tab.id === tabId && tab.chatMode !== mode)
      ? prev.map(tab => tab.id === tabId ? { ...tab, chatMode: mode } : tab) : prev);
    // Planificar es pasajero: los chats nuevos heredan el último modo de trabajo.
    if (mode === "plan" || tabsRef.current.find(tab => tab.id === tabId)?.workflow) return;
    setConfig(previous => !previous || previous.ui.chatModes?.[provider] === mode ? previous
      : { ...previous, ui: { ...previous.ui, chatModes: { ...previous.ui.chatModes, [provider]: mode } } });
  }, []);

  const handleChatModel = useCallback((tabId: string, model: string | null) => {
    setTabs(previous => previous.some(tab => tab.id === tabId && (tab.chatModel ?? null) !== model)
      ? previous.map(tab => tab.id === tabId ? { ...tab, chatModel: model } : tab) : previous);
  }, []);

  const handleChatEffort = useCallback((tabId: string, effort: string | null) => {
    const choice = normalizeEffortChoice(effort);
    setTabs(previous => previous.some(tab => tab.id === tabId && (tab.chatEffort ?? null) !== choice)
      ? previous.map(tab => tab.id === tabId ? { ...tab, chatEffort: choice } : tab) : previous);
  }, []);

  const handleChatTitle = useCallback((tabId: string, title: string) => {
    setTabs(prev => prev.map(tab => {
      const name = tab.profileName ?? "";
      const automatic = !!name && (tab.subtitle === name || (tab.subtitle.startsWith(`${name} `) && /^\d+$/.test(tab.subtitle.slice(name.length + 1))));
      return tab.id === tabId && title && automatic ? { ...tab, subtitle: title } : tab;
    }));
  }, []);

  const handleTabTitle = useCallback((tabId: string, title: string) => {
    setTabs((prev) => {
      const tab = prev.find(item => item.id === tabId);
      if (!tab || tab.oscTitle === title) return prev;
      return prev.map(item => item.id === tabId ? { ...item, oscTitle: title } : item);
    });
  }, []);

  // --- Ajustes y tipografía ------------------------------------------------------

  const updateSettings = useCallback(
    (next: Settings) => {
      setConfig((prev) => (prev ? { ...prev, settings: next } : prev));
      setSettingsOpen(false);
      showToast("Ajustes guardados");
    },
    [showToast],
  );

  /** Alterna claro ↔ oscuro (Ctrl+Shift+L) y lo persiste con el resto de ajustes. */
  const toggleTheme = useCallback(() => {
    const next = getThemeMode() === "light" ? "dark" : "light";
    setConfig((prev) =>
      prev ? { ...prev, settings: { ...prev.settings, appearance: next } } : prev,
    );
    showToast(next === "light" ? "Modo claro activado" : "Modo oscuro activado");
  }, [showToast]);

  const changeFontSize = useCallback((delta: number) => {
    setConfig((prev) =>
      prev
        ? {
            ...prev,
            settings: {
              ...prev.settings,
              fontSize: clamp(prev.settings.fontSize + delta, 10, 24),
            },
          }
        : prev,
    );
  }, []);

  const resetFontSize = useCallback(() => {
    setConfig((prev) =>
      prev ? { ...prev, settings: { ...prev.settings, fontSize: DEFAULT_SETTINGS.fontSize } } : prev,
    );
  }, []);

  const setSidebarWidth = useCallback((width: number) => {
    setConfig((prev) =>
      prev ? { ...prev, ui: { ...prev.ui, sidebarWidth: clamp(width, 180, 520) } } : prev,
    );
  }, []);

  /**
   * Muestra u oculta la barra lateral (cabecera de proyectos, botón flotante y
   * Ctrl+B / ⌘B). El estado vive en "ui", así que se persiste con el resto de
   * la configuración y se recuerda en el siguiente arranque.
   */
  const toggleSidebar = useCallback(() => {
    const collapsed = !configRef.current?.ui.sidebarCollapsed;
    const moveFocus = document.activeElement instanceof Element &&
      document.activeElement.closest(".sidebar, .sidebar-reopen") !== null;
    setConfig((prev) =>
      prev
        ? { ...prev, ui: { ...prev.ui, sidebarCollapsed: !prev.ui.sidebarCollapsed } }
        : prev,
    );
    if (moveFocus) requestAnimationFrame(() => {
      document.querySelector<HTMLButtonElement>(collapsed ? ".sidebar-reopen" : ".sidebar-collapse")?.focus({ preventScroll: true });
    });
  }, []);

  /**
   * Alterna el ocultado automático de la barra superior (Ctrl+Shift+B o la
   * entrada del menú "⋯"). Se persiste en "ui" igual que la barra lateral.
   */
  const toggleTopBar = useCallback(() => {
    setConfig((prev) =>
      prev ? { ...prev, ui: { ...prev.ui, autoHideTopBar: !prev.ui.autoHideTopBar } } : prev,
    );
  }, []);

  // --- Atajos de teclado -----------------------------------------------------------

  useShortcuts(
    {
      newClaudeTab: () => {
        const projectId = configRef.current?.ui.activeProjectId;
        const settings = configRef.current?.settings;
        if (projectId && settings) openTab(projectId, defaultProfile({ ...settings, profiles: profilesForInstallation(settings, trexInstalledRef.current) }).id);
      },
      newShellTab: () => {
        const projectId = configRef.current?.ui.activeProjectId;
        if (projectId) openTab(projectId, null);
      },
      focusSearch,
      commandPalette: () => setPaletteOpen(true),
      recoverSessions: () => { if (configRef.current?.ui.activeProjectId) setRecoveryOpen(true); },
      toggleSplit,
      focusOtherPane,
      toggleSidebar,
      toggleTopBar,
      closeTab: closeActiveTab,
      nextTab: () => cycleTab(1),
      prevTab: () => cycleTab(-1),
      selectTab: selectTabByIndex,
      toggleSettings: () => {
        if (settingsOpen) window.dispatchEvent(new Event("trex:settings-close"));
        else openSettings();
      },
      toggleTheme,
      openInExplorer: () => {
        const projectId = configRef.current?.ui.activeProjectId;
        if (projectId) revealProject(projectId);
      },
      increaseFont: () => changeFontSize(1),
      decreaseFont: () => changeFontSize(-1),
      resetFont: resetFontSize,
    },
    { enabled: config !== null && workspaceReady, settingsOpen: settingsPresence.value !== null,
      modalOpen: palettePresence.value !== null || usagePresence.value !== null || recoveryPresence.value !== null || imagePreviewPresence.value !== null || handoffPresence.value !== null || workflowPresence.value !== null,
      bindings:config?.settings.shortcuts },
  );

  // --- Datos derivados para la interfaz ---------------------------------------------

  /** Proyectos visibles: filtrado en vivo por nombre y por ruta, sin acentos. */
  const visibleProjects = useMemo(() => {
    const all = config ? filterProjects(config.projects, config.ui.projectFilter) : [];
    const needle = normalizeText(search);
    if (!needle) return all;
    return all.filter(
      (project) =>
        normalizeText(project.name).includes(needle) ||
        normalizeText(project.path).includes(needle) ||
        tabs.some((tab) => tab.projectId === project.id && normalizeText(sessionLabel(tab)).includes(needle)),
    );
  }, [config?.projects, config?.ui.projectFilter, search, tabs]);
  // El móvil agrupa las sesiones por proyecto en el mismo orden que la barra lateral.
  useEffect(() => { remoteBridge.setProjectOrder(config?.projects.map(project => project.id) ?? []); }, [config?.projects]);

  if (!config || !workspaceReady) return <Splash />;

  const activeProject = config.projects.find((project) => project.id === activeProjectId) ?? null;
  const availableProfiles = profilesForInstallation(config.settings, trexInstalled);
  const preferredProfile = defaultProfile({ ...config.settings, profiles: availableProfiles });
  const standardClaude = preferredProfile.provider === "claude" && preferredProfile.command === "claude";
  const claudeMissing = standardClaude && claudeInfo !== null && !claudeInfo.found;
  const hasProjects = config.projects.length > 0;
  const selectedTab = projectTabs.find(tab => tab.id === activeTabId);
  const chatCanvas = !split && !!selectedTab && usesChatView(selectedTab)
    && !(hasProjects && claudeMissing && !bannerDismissed);
  // Las claves conservan cada PTY; el orden del DOM sigue el orden visual para Tab.
  const terminalTabs = split ? [...tabs].sort((a,b) => {
    const position = (tab: TabState): number => tab.projectId === activeProjectId && split.panes.includes(tab.id) ? split.panes.indexOf(tab.id) : 4;
    return position(a) - position(b);
  }) : tabs;
  const paletteCommands: PaletteCommand[] = [
    {id:"split",label:split ? "Unir terminales" : "Dividir terminales",group:"Acciones",shortcut:config.settings.shortcuts.toggleSplit,run:toggleSplit,disabled:!activeProject || !projectTabs.length},
    {id:"grid",label:"Cuatro terminales · cuadrícula 2 × 2",group:"Acciones",run:()=>changeSplit("grid"),disabled:!activeProject || !projectTabs.length},
    {id:"rotate",label:"Cambiar división horizontal / vertical",group:"Acciones",run:()=>{if(split) changeSplit(split.direction === "columns" ? "rows" : "columns");},disabled:!split || split.direction === "grid"},
    {id:"recover",label:"Recuperar conversación",group:"Acciones",shortcut:config.settings.shortcuts.recoverSessions,run:()=>setRecoveryOpen(true),disabled:!activeProject},
    {id:"usage",label:"Ver uso de las cuentas",detail:"Sesión de 5 horas y semana de cada perfil",group:"Acciones",run:openUsage},
    {id:"settings",label:"Abrir ajustes",group:"Acciones",shortcut:config.settings.shortcuts.toggleSettings,run:openSettings},
    {id:"theme",label:"Cambiar tema claro / oscuro",group:"Acciones",shortcut:config.settings.shortcuts.toggleTheme,run:toggleTheme},
    {id:"sidebar",label:"Mostrar / ocultar barra lateral",group:"Acciones",shortcut:config.settings.shortcuts.toggleSidebar,run:toggleSidebar},
    {id:"folder",label:"Abrir carpeta del proyecto",group:"Acciones",run:()=>{if(activeProject) revealProject(activeProject.id);},disabled:!activeProject},
    {id:"add",label:"Añadir proyecto",group:"Acciones",run:()=>void addProject()},
    {id:"shell",label:"Nueva terminal",group:"Crear sesión",shortcut:config.settings.shortcuts.newShellTab,run:()=>{if(activeProject)openTab(activeProject.id,null);},disabled:!activeProject},
    {id:"agent-workflow",label:"Planear y ejecutar con agentes…",detail:"Elige un agente y un modelo para cada etapa",group:"Crear sesión",run:()=>{if(activeProject)openWorkflow(activeProject.id);},disabled:!activeProject},
    ...availableProfiles.map(profile=>({id:`profile-${profile.id}`,label:`Nueva sesión · ${profile.name}`,detail:profile.command,group:"Crear sesión",run:()=>{if(activeProject)openTab(activeProject.id,profile.id);},disabled:!activeProject})),
    ...config.projects.map(project=>({id:`project-${project.id}`,label:project.name,detail:project.path,group:"Proyectos",run:()=>{setSearch("");selectProject(project.id);}})),
    ...tabs.map(tab=>({id:`tab-${tab.id}`,label:sessionLabel(tab),detail:config.projects.find(project=>project.id===tab.projectId)?.name,group:"Sesiones abiertas",run:()=>{setSearch("");selectProject(tab.projectId);setActiveTabId(tab.id);}})),
  ];

  return (
    <div className="app">
      <Sidebar
        projects={visibleProjects}
        allProjects={config.projects}
        projectFilter={config.ui.projectFilter}
        onProjectFilterChange={setProjectFilter}
        activeProjectId={activeProjectId}
        sidebarWidth={config.ui.sidebarWidth}
        sidebarCollapsed={config.ui.sidebarCollapsed}
        claudeInfo={standardClaude ? claudeInfo : null}
        profiles={availableProfiles}
        tabs={tabs}
        activeTabId={activeTabId}
        search={search}
        shortcuts={config.settings.shortcuts}
        themeMode={themeMode}
        searchInputRef={searchInputRef}
        onSearchChange={setSearch}
        onAdd={() => void addProject()}
        onSelect={selectProject}
        onQuickOpen={(projectId, profileId) => openTab(projectId, profileId)}
        onWorkflow={projectId => openWorkflow(projectId)}
        onNewShell={projectId => openTab(projectId, null)}
        onSelectSession={(projectId, tabId) => {
          selectProject(projectId);
          setActiveTabId(tabId);
        }}
        onCloseSession={(tabId, trigger) => void closeTab(tabId, trigger)}
        onRenameSession={renameTab}
        onRename={renameProject}
        onToggleFavorite={toggleFavorite}
        onDelete={(projectId, trigger, returnFocus) => void deleteProject(projectId, trigger, returnFocus)}
        onReveal={revealProject}
        onCopyPath={copyPath}
        onOpenSettings={openSettings}
        onToggleTheme={toggleTheme}
        onToggleSidebar={toggleSidebar}
        onResize={setSidebarWidth}
        updates={pendingUpdates}
        onUpdateCli={updateCli}
        onDismissUpdate={dismissCliUpdate}
      />

      <main className={`main${chatCanvas ? " chat-canvas" : ""}`}>
        <button type="button" className="sidebar-reopen tip tip-below" hidden={!config.ui.sidebarCollapsed}
          aria-label="Mostrar barra lateral" aria-controls="workspace-sidebar" aria-expanded="false"
          data-tip={`Mostrar barra lateral (${shortcutLabel(config.settings.shortcuts.toggleSidebar)})`} onClick={toggleSidebar}>
          <PanelIcon size={18} />
        </button>
        <TerminalTabs
          tabs={projectTabs}
          activeTabId={activeTabId}
          projectName={activeProject?.name ?? "trex"}
          hasProject={activeProjectId !== null}
          profiles={availableProfiles}
          defaultProfileId={preferredProfile.id}
          autoHideTopBar={config.ui.autoHideTopBar}
          onToggleTopBar={toggleTopBar}
          onRevealProject={
            activeProjectId ? () => revealProject(activeProjectId) : null
          }
          onNew={(profileId) => {
            if (activeProjectId) openTab(activeProjectId, profileId);
          }}
          onNewShell={() => {
            if (activeProjectId) openTab(activeProjectId, null);
          }}
          onWorkflow={() => { if (activeProjectId) openWorkflow(activeProjectId); }}
          onOpenSettings={openSettings}
          onOpenProfiles={openProfiles}
          onCommandPalette={() => setPaletteOpen(true)}
          onRecover={() => setRecoveryOpen(true)}
          onChangeSplit={changeSplit}
          splitDirection={displayedSplit?.direction ?? null}
          shortcuts={config.settings.shortcuts}
          notices={notices}
          soundEnabled={config.ui.notificationSound}
          liveTabIds={liveTabIds}
          onOpenNotice={openNotice}
          onMarkNoticesRead={() => setNotices(previous => previous.map(notice => ({ ...notice, read: true })))}
          onClearNotices={() => setNotices([])}
          onToggleSound={toggleNotificationSound}
          onPreviewSound={() => void playNotificationSound()}
        />

        {hasProjects && claudeMissing && !bannerDismissed && (
          <ClaudeBanner
            hint={claudeInfo?.hint ?? null}
            onHowToInstall={openProfiles}
            onDismiss={() => setBannerDismissed(true)}
          />
        )}

        {hasProjects ? (
          <div className={`terminals${displayedSplit ? ` split-${displayedSplit.direction}` : ""}`}>
            {terminalTabs.map((tab) => {
              const project = config.projects.find((item) => item.id === tab.projectId);
              if (!project) return null;
              const isActive = tab.id === activeTabId && tab.projectId === activeProjectId;
              const paneIndex = split?.panes.indexOf(tab.id) ?? -1;
              const isVisible = tab.projectId === activeProjectId && (displayedSplit ? paneIndex !== -1 : isActive);
              const paneStyle = displayedSplit && isVisible ? splitPaneStyle(displayedSplit, paneIndex) : {};
              const chat = usesChatView(tab);
              return (
                <div
                  key={tab.id}
                  className={`terminal-host${chat ? " chat-host" : ""}${split && isVisible ? " split-pane" : ""}${isActive ? " focused-pane" : ""}`}
                  style={{ display: isVisible ? "block" : "none",...paneStyle }}
                  onPointerDownCapture={() => { if(isVisible) setActiveTabId(tab.id); }}
                >
                  {split && isVisible && <SplitPaneHeader layout={split} index={paneIndex} tabs={projectTabs} profiles={availableProfiles}
                    expanded={paneExpanded}
                    onSelect={id => selectPaneSession(paneIndex,id)} onNew={profileId => newPaneSession(paneIndex,profileId)}
                    onRotate={() => changeSplit(split.direction === "columns" ? "rows" : "columns")}
                    onSingle={() => { setActiveTabId(tab.id); setExpandedPaneId(paneExpanded ? null : tab.id); }} />}
                  {chat ? <SessionChat
                    room={tab.agentRoom}
                    agentTeam={tab.agentTeam}
                    onTeamChange={team => setTabs(previous => previous.map(value => value.id === tab.id && value.agentTeam?.id === team.id ? { ...value, agentTeam: team } : value))}
                    trexInstalled={trexInstalled}
                    onRoomChange={room => changeRoom(tab.id, room)}
                    projectId={project.id}
                    profileId={tab.profileId}
                    profileName={tab.profileName}
                    sessionTitle={sessionLabel(tab)}
                    handoff={tab.handoff}
                    handoffRestored={tab.handoffRestored}
                    workflow={tab.workflow}
                    planningOnly={tab.workflow?.role === "planner"}
                    onWorkflowPlan={implementWorkflow}
                    onWorkflowStatus={workflowStatus}
                    onWorkflowPeer={selectWorkflowPeer}
                    onHandoffRequest={requestHandoff}
                    onPlanHere={tab.agentRoom || tab.agentTeam ? undefined : planInChat}
                    onHandoffConsumed={handoffConsumed}
                    provider={tab.kind}
                    sessionId={tab.id}
                    cwd={project.path}
                    projectName={project.name}
                    command={tab.command}
                    args={tab.args}
                    shell={tab.shell}
                    env={tab.env}
                    conversationId={tab.conversationId}
                    mode={tab.chatMode ?? config.ui.chatModes?.[tab.kind] ?? null}
                    model={tab.chatModel ?? null}
                    effort={tab.chatEffort ?? null}
                    settings={config.settings}
                    visible={isVisible}
                    focused={isActive}
                    onExit={handleTabExit}
                    onRunning={handleTabRunning}
                    onActivity={handleTabActivity}
                    onNotice={handleAgentNotice}
                    onConversation={handleConversation}
                    onTitle={handleChatTitle}
                    onMode={handleChatMode}
                    onModel={handleChatModel}
                    onEffort={handleChatEffort}
                    onMessage={showToast}
                  /> : <TerminalView
                    sessionId={tab.id}
                    cwd={project.path}
                    command={tab.command}
                    args={tab.args}
                    shell={tab.shell}
                    launchMode={tab.launchMode}
                    env={tab.env}
                    launchLabel={tab.profileName}
                    kind={tab.kind}
                    settings={config.settings}
                    visible={isVisible}
                    focused={isActive}
                    onImagePreview={previewImage}
                    onExit={handleTabExit}
                    onTitle={handleTabTitle}
                    onActivity={handleTabActivity}
                    onRunning={handleTabRunning}
                    onNotice={handleAgentNotice}
                    onMessage={showToast}
                  />}
                </div>
              );
            })}
            {displayedSplit && displayedSplit.panes.map((id,index) => id === null && <div key={`empty-${index}`} className="terminal-host split-pane empty-split-pane" style={splitPaneStyle(displayedSplit,index)}>
              <SplitPaneHeader layout={displayedSplit} index={index} tabs={projectTabs} profiles={availableProfiles}
                onSelect={id => selectPaneSession(index,id)} onNew={profileId => newPaneSession(index,profileId)}
                onRotate={() => changeSplit(displayedSplit.direction === "columns" ? "rows" : "columns")} onSingle={() => changeSplit(null)} />
              <div className="split-pane-empty">
                <span className="split-empty-mark" aria-hidden="true"><TerminalIcon size={24} /></span>
                <h3>Panel {index + 1}</h3><p>Elige una sesión arriba o abre una nueva.</p>
                <div className="split-empty-actions">
                  {availableProfiles.map(profile => <button key={profile.id} className="split-empty-action" onClick={() => newPaneSession(index,profile.id)}><AgentIcon kind={profile.provider} activity="idle" /><span>{profile.name}</span></button>)}
                  <button className="split-empty-action" onClick={() => newPaneSession(index,null)}><TerminalIcon /><span>Terminal</span></button>
                </div>
              </div>
            </div>)}
            {displayedSplit && displayedSplit.direction !== "rows" && <SplitDivider layout={displayedSplit} axis="columns" onChange={updateSplit} />}
            {displayedSplit && displayedSplit.direction !== "columns" && <SplitDivider layout={displayedSplit} axis="rows" onChange={updateSplit} />}

            {activeProject && projectTabs.length === 0 && (
              <ProjectHome
                project={activeProject}
                profiles={availableProfiles}
                defaultProfileId={preferredProfile.id}
                shortcuts={config.settings.shortcuts}
                onOpen={(profileId) => openTab(activeProject.id, profileId)}
                onShell={() => openTab(activeProject.id, null)}
                onWorkflow={() => openWorkflow(activeProject.id)}
                onReveal={() => revealProject(activeProject.id)}
              />
            )}

            {!activeProject && (
              <div className="terminals-empty">
                Selecciona un proyecto en la barra lateral para empezar.
              </div>
            )}
          </div>
        ) : (
          <WelcomeScreen
            claudeInfo={claudeInfo}
            codexInfo={codexInfo}
            onAddProject={() => void addProject()}
            onOpenSettings={openProfiles}
            onRedetect={redetectClaude}
          />
        )}
      </main>

      {settingsPresence.value && (<Suspense fallback={null}>
        <SettingsPanel
          surfaceRef={settingsSurfaceRef}
          entering={settingsPresence.entering}
          leaving={settingsPresence.leaving}
          settings={config.settings}
          cwd={activeProject?.path}
          appInfo={appInfo}
          claudeInfo={claudeInfo}
          codexInfo={codexInfo}
          initialSection={settingsInitialSection}
          cliUpdates={cliUpdates}
          onUpdateCli={updateCli}
          onSave={updateSettings}
          onClose={() => setSettingsOpen(false)}
          onRedetect={redetectClaude}
        />
      </Suspense>)}

      {toast && (
        <Toast key={toast.id} message={toast.message} onDismiss={() => setToast(null)} />
      )}
      <VoiceIndicator />
      {workflowPresence.value && <Suspense fallback={null}><AgentWorkflowDialog project={workflowPresence.value} profiles={availableProfiles}
        initialExecutor={(() => { const source = workflowSourceRef.current; const tab = source && tabs.find(item => item.id === source.context.source.sessionId);
          return tab?.profileId ? { profileId: tab.profileId, model: tab.chatModel ?? null, effort: tab.chatEffort ?? null } : undefined; })()}
        settings={config.settings} onClose={closeWorkflow} onStart={startWorkflow} onStartTeam={startTeam} submitting={workflowSubmitting} error={workflowError}
        entering={workflowPresence.entering} leaving={workflowPresence.leaving} surfaceRef={workflowSurfaceRef} /></Suspense>}
      {handoffPresence.value && <HandoffDialog {...handoffPresence.value}
        profiles={availableProfiles} settings={config.settings} onClose={closeHandoff}
        onContinue={continueHandoff} submitting={handoffSubmitting}
        entering={handoffPresence.entering} leaving={handoffPresence.leaving} surfaceRef={handoffSurfaceRef} />}
      {palettePresence.value && <Suspense fallback={null}><CommandPalette commands={paletteCommands} onClose={()=>setPaletteOpen(false)}
        surfaceRef={paletteSurfaceRef} entering={palettePresence.entering} leaving={palettePresence.leaving} /></Suspense>}
      {usagePresence.value && <Suspense fallback={null}><UsageDialog settings={config.settings} onClose={()=>setUsageOpen(false)}
        surfaceRef={usageSurfaceRef} entering={usagePresence.entering} leaving={usagePresence.leaving} /></Suspense>}
      {recoveryPresence.value && activeProject && <Suspense fallback={null}><RecoverConversations project={activeProject} settings={config.settings} onClose={()=>setRecoveryOpen(false)}
        surfaceRef={recoverySurfaceRef} entering={recoveryPresence.entering} leaving={recoveryPresence.leaving} onResume={(profile,conversation)=>{
        const surface = recoverySurfaceRef.current;
        setRecoveryOpen(false);
        // La sesión recibe el foco cuando la ventana de recuperación ya ha
        // liberado el fondo, también si el proceso arranca inmediatamente.
        requestAnimationFrame(() => waitForMotion(surface, () => requestAnimationFrame(() => {
          const existing=tabsRef.current.find(tab=>!tab.exited && tab.profileId===profile.id && tab.conversationId===conversation.id);
          if(existing) setActiveTabId(existing.id); else { try { openTab(activeProject.id,profile.id,conversation); } catch(error) { showToast(formatError(error)); } }
        })));
      }} /></Suspense>}
      {shownImagePreview && <FeatureDialog title="Vista previa de la captura" onClose={()=>dismissImage(false)}
        surfaceRef={imagePreviewSurfaceRef} entering={imagePreviewPresence.entering} leaving={imagePreviewPresence.leaving}
        footer={<><button className="btn btn-ghost" onClick={()=>dismissImage(false)}>Cancelar</button><button className="btn btn-primary" onClick={()=>dismissImage(true)}>Pegar imagen</button></>}>
        {shownImagePreview.image.preview ? <img className="clipboard-preview" src={shownImagePreview.image.preview} alt="Captura que se adjuntará al asistente" /> : <p>No se pudo mostrar la vista previa.</p>}
        <p className="feature-hint">{shownImagePreview.image.width} × {shownImagePreview.image.height} px · {sessionLabel(tabs.find(tab=>tab.id===shownImagePreview.tabId) ?? {subtitle:"Sesión",oscTitle:null,kind:"shell"})}</p><p className="feature-hint">Se adjunta a la sesión. El mensaje se envía cuando pulses Enter en el asistente.</p>
      </FeatureDialog>}
    </div>
  );
}

// --- Raíz: proveedor de diálogos --------------------------------------------------

/**
 * Envuelve la aplicación con el host de diálogos propios (los nativos del
 * sistema ya no se usan). Se monta una única vez para toda la vida de la app.
 */
export default function App() {
  return (
    <DialogProvider>
      <ImageViewerProvider>
        <FileViewerProvider>
          <AppShell />
        </FileViewerProvider>
      </ImageViewerProvider>
      <TooltipProvider />
    </DialogProvider>
  );
}

// --- Pantalla de carga -----------------------------------------------------------

function Splash() {
  return (
    <div className="splash">
      <div className="splash-logo"><span className="loader loader-lg" aria-hidden="true" /></div>
      <div className="splash-name">trex</div>
      <div className="splash-sub" role="status">Cargando configuración…</div>
    </div>
  );
}
