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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
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
  newProjectId,
  newSessionId,
  normalizePath,
  normalizeConfig,
  normalizeText,
  ptyKill,
  saveConfig,
} from "./api";
import { useShortcuts } from "./hooks/useShortcuts";
import { useWindowFrame } from "./hooks/useWindowFrame";
import { usePresence } from "./hooks/usePresence";
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
import SettingsPanel from "./components/SettingsPanel";
import Sidebar from "./components/Sidebar";
import TerminalTabs from "./components/TerminalTabs";
import TerminalView from "./components/TerminalView";
import ChatView from "./components/ChatView";
import Toast from "./components/Toast";
import TooltipProvider from "./components/TooltipProvider";
import ImageViewerProvider from "./components/ImageViewer";
import ProjectHome from "./components/ProjectHome";
import { sessionLabel } from "./sessionTitle";
import WelcomeScreen from "./components/WelcomeScreen";
import { defaultProfile, launchForProfile, restoreLaunch } from "./profiles";
import { applyDesign } from "./visualDesign";
import type { ClipboardContent } from "./paste";
import { resumedLaunch } from "./conversations";
import { codexChatSupported } from "./codexChat";
import { showDesktopNotice } from "./desktopNotifications";
import { createSplitLayout, replaceSplitPane, splitPaneStyle, visibleSplit, type SplitDirection, type SplitLayout } from "./splitLayout";
import SplitDivider from "./components/SplitDivider";
import SplitPaneHeader from "./components/SplitPaneHeader";
import AgentIcon from "./components/AgentIcon";
import { TerminalIcon } from "./components/Icons";
import CommandPalette from "./components/CommandPalette";
import RecoverConversations from "./components/RecoverConversations";
import UsageDialog from "./components/UsageDialog";
import FeatureDialog from "./components/FeatureDialog";
import type { PaletteCommand } from "./commandPalette";
import { useNotificationSound } from "./hooks/useNotificationSound";

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

function AppShell() {
  useWindowFrame();
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [tabs, setTabs] = useState<TabState[]>([]);
  const [notices, setNotices] = useState<AgentNotice[]>([]);
  const noticeIdRef = useRef(0);
  const closingTabIdsRef = useRef(new Set<string>());
  const playNotificationSound = useNotificationSound(config?.ui.notificationSound ?? true);
  const liveTabIds = useMemo(() => new Set(tabs.map(tab => tab.id)), [tabs]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [expandedPaneId, setExpandedPaneId] = useState<string | null>(null);
  const [claudeInfo, setClaudeInfo] = useState<ClaudeInfo | null>(null);
  const [codexInfo, setCodexInfo] = useState<ClaudeInfo | null>(null);
  const [settingsInitialSection, setSettingsInitialSection] = useState<"appearance" | "profiles">("appearance");
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [paletteOpen,setPaletteOpen] = useState(false);
  const [usageOpen,setUsageOpen] = useState(false);
  const openUsage = useCallback(() => setUsageOpen(true), []);
  const [recoveryOpen,setRecoveryOpen] = useState(false);
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
  const settingsPresence = usePresence(settingsOpen ? true : null);
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
  const tabsRef = useRef<TabState[]>(tabs);
  tabsRef.current = tabs;
  const activeTabIdRef = useRef<string | null>(activeTabId);
  activeTabIdRef.current = activeTabId;

  const loadedRef = useRef(false);
  const restoredRef = useRef(false);
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
      let loaded: AppConfig;
      let failed = false;
      try {
        loaded = await loadConfig();
      } catch (error) {
        console.warn("load_config falló:", formatError(error));
        loaded = DEFAULT_CONFIG;
        failed = true;
      }
      if (cancelled) return;
      const normalized = normalizeConfig(failed ? DEFAULT_CONFIG : loaded);
      setConfig(normalized);
      loadedRef.current = true;
      applyTheme(
        normalized.settings.appearance,
        normalized.settings.theme || DEFAULT_SETTINGS.theme,
        normalized.settings.colorScheme,
      );
      applyDesign(normalized.settings);
      if (failed) showToast("No se pudo cargar la configuración; se usarán valores por defecto.");
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
    launch: { profileId: tab.profileId, profileName: tab.profileName, command: tab.command, args: tab.args,
      shell: tab.shell, launchMode: tab.launchMode, env: tab.env },
  })));
  useEffect(() => {
    if (!config || !loadedRef.current) return;
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
  useEffect(() => {
    if (!config) return;
    applyTheme(config.settings.appearance, config.settings.theme || DEFAULT_SETTINGS.theme, config.settings.colorScheme);
  }, [config?.settings.appearance, config?.settings.theme, config?.settings.colorScheme]);
  useEffect(() => {
    if (config) applyDesign(config.settings);
  }, [config?.settings.terminalRadius, config?.settings.terminalMargin, config?.settings.terminalBorder, config?.settings.motion]);

  // El icono sol/luna del pie de la sidebar refleja el modo realmente pintado.
  useEffect(() => onThemeChange(setThemeMode), []);

  // --- Restauración de la sesión anterior --------------------------------------

  useEffect(() => {
    if (!config || restoredRef.current) return;
    restoredRef.current = true;

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
        return { ...buildTab(tab.projectId, launch.command ? tab.kind : "shell", tab.subtitle, settings), ...launch, id:tab.id ?? newSessionId(), conversationId:tab.conversationId ?? null, chatMode: tab.chatMode ?? null };
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
      const profile = settings.autoRunClaude ? defaultProfile(settings) : null;
      const tab = buildTab(fallbackProjectId, profile?.provider ?? "shell", profile?.name ?? "shell", settings, profile);
      setTabs([tab]);
      setActiveTabId(tab.id);
    }
  }, [config]);

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
            ui: { ...prev.ui, activeProjectId: project.id, lastProjectId: project.id },
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
        ui: { ...prev.ui, activeProjectId: nextActive, lastProjectId: nextActive },
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

  const openTab = useCallback((projectId: string, profileId: string | null, conversation?: Conversation) => {
    const currentConfig = configRef.current;
    if (!currentConfig) return;
    const settings = currentConfig.settings;
    if (!currentConfig.projects.some((project) => project.id === projectId)) return;

    const profile = profileId ? settings.profiles.find(item => item.id === profileId) : null;
    if (profileId && !profile) return;
    const sameKind = tabsRef.current.filter(
      (tab) => tab.projectId === projectId && tab.profileId === (profile?.id ?? null),
    );
    const base = profile?.name ?? "shell";
    const subtitle =
      sameKind.length === 0 ? base : `${base} ${sameKind.length + 1}`;

    const tab = buildTab(projectId, profile?.provider ?? "shell", subtitle, settings, profile ?? null);
    if (conversation && profile) {
      // El chat retoma la conversación por su id; la terminal necesita la opción en el comando.
      const chat = profile.provider === "claude" || codexChatSupported(tab.args);
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
    if (mode === "plan") return;
    setConfig(previous => !previous || previous.ui.chatModes?.[provider] === mode ? previous
      : { ...previous, ui: { ...previous.ui, chatModes: { ...previous.ui.chatModes, [provider]: mode } } });
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
   * Muestra u oculta la barra lateral (botón de panel de la barra superior y
   * Ctrl+B / ⌘B). El estado vive en "ui", así que se persiste con el resto de
   * la configuración y se recuerda en el siguiente arranque.
   */
  const toggleSidebar = useCallback(() => {
    if (document.querySelector(".sidebar")?.contains(document.activeElement)) {
      document.querySelector<HTMLButtonElement>(".panel-toggle")?.focus({ preventScroll: true });
    }
    setConfig((prev) =>
      prev
        ? { ...prev, ui: { ...prev.ui, sidebarCollapsed: !prev.ui.sidebarCollapsed } }
        : prev,
    );
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
        if (projectId && settings) openTab(projectId, defaultProfile(settings).id);
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
    { enabled: config !== null, settingsOpen, modalOpen: paletteOpen || recoveryOpen || imagePreview !== null, bindings:config?.settings.shortcuts },
  );

  // --- Datos derivados para la interfaz ---------------------------------------------

  /** Proyectos visibles: filtrado en vivo por nombre y por ruta, sin acentos. */
  const visibleProjects = useMemo(() => {
    const all = config?.projects ?? [];
    const needle = normalizeText(search);
    if (!needle) return all;
    return all.filter(
      (project) =>
        normalizeText(project.name).includes(needle) ||
        normalizeText(project.path).includes(needle) ||
        tabs.some((tab) => tab.projectId === project.id && normalizeText(sessionLabel(tab)).includes(needle)),
    );
  }, [config?.projects, search, tabs]);

  if (!config) return <Splash />;

  const activeProject = config.projects.find((project) => project.id === activeProjectId) ?? null;
  const preferredProfile = defaultProfile(config.settings);
  const standardClaude = preferredProfile.provider === "claude" && preferredProfile.command === "claude";
  const claudeMissing = standardClaude && claudeInfo !== null && !claudeInfo.found;
  const hasProjects = config.projects.length > 0;
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
    ...config.settings.profiles.map(profile=>({id:`profile-${profile.id}`,label:`Nueva sesión · ${profile.name}`,detail:profile.command,group:"Crear sesión",run:()=>{if(activeProject)openTab(activeProject.id,profile.id);},disabled:!activeProject})),
    ...config.projects.map(project=>({id:`project-${project.id}`,label:project.name,detail:project.path,group:"Proyectos",run:()=>{setSearch("");selectProject(project.id);}})),
    ...tabs.map(tab=>({id:`tab-${tab.id}`,label:sessionLabel(tab),detail:config.projects.find(project=>project.id===tab.projectId)?.name,group:"Sesiones abiertas",run:()=>{setSearch("");selectProject(tab.projectId);setActiveTabId(tab.id);}})),
  ];

  return (
    <div className="app">
      <Sidebar
        projects={visibleProjects}
        activeProjectId={activeProjectId}
        sidebarWidth={config.ui.sidebarWidth}
        sidebarCollapsed={config.ui.sidebarCollapsed}
        claudeInfo={standardClaude ? claudeInfo : null}
        profiles={config.settings.profiles}
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
        onOpenUsage={openUsage}
        onToggleTheme={toggleTheme}
        onResize={setSidebarWidth}
      />

      <main className="main">
        <TerminalTabs
          tabs={projectTabs}
          activeTabId={activeTabId}
          projectName={activeProject?.name ?? "trex"}
          hasProject={activeProjectId !== null}
          profiles={config.settings.profiles}
          defaultProfileId={preferredProfile.id}
          sidebarCollapsed={config.ui.sidebarCollapsed}
          onToggleSidebar={toggleSidebar}
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
              return (
                <div
                  key={tab.id}
                  className={`terminal-host${split && isVisible ? " split-pane" : ""}${isActive ? " focused-pane" : ""}`}
                  style={{ display: isVisible ? "block" : "none",...paneStyle }}
                  onPointerDownCapture={() => { if(isVisible) setActiveTabId(tab.id); }}
                >
                  {split && isVisible && <SplitPaneHeader layout={split} index={paneIndex} tabs={projectTabs} profiles={config.settings.profiles}
                    expanded={paneExpanded}
                    onSelect={id => selectPaneSession(paneIndex,id)} onNew={profileId => newPaneSession(paneIndex,profileId)}
                    onRotate={() => changeSplit(split.direction === "columns" ? "rows" : "columns")}
                    onSingle={() => { setActiveTabId(tab.id); setExpandedPaneId(paneExpanded ? null : tab.id); }} />}
                  {tab.kind !== "shell" && (tab.kind === "claude" || codexChatSupported(tab.args)) ? <ChatView
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
                    onMessage={showToast}
                    onOpenUsage={openUsage}
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
              <SplitPaneHeader layout={displayedSplit} index={index} tabs={projectTabs} profiles={config.settings.profiles}
                onSelect={id => selectPaneSession(index,id)} onNew={profileId => newPaneSession(index,profileId)}
                onRotate={() => changeSplit(displayedSplit.direction === "columns" ? "rows" : "columns")} onSingle={() => changeSplit(null)} />
              <div className="split-pane-empty">
                <span className="split-empty-mark" aria-hidden="true"><TerminalIcon size={24} /></span>
                <h3>Panel {index + 1}</h3><p>Elige una sesión arriba o abre una nueva.</p>
                <div className="split-empty-actions">
                  {config.settings.profiles.map(profile => <button key={profile.id} className="split-empty-action" onClick={() => newPaneSession(index,profile.id)}><AgentIcon kind={profile.provider} activity="idle" /><span>{profile.name}</span></button>)}
                  <button className="split-empty-action" onClick={() => newPaneSession(index,null)}><TerminalIcon /><span>Terminal</span></button>
                </div>
              </div>
            </div>)}
            {displayedSplit && displayedSplit.direction !== "rows" && <SplitDivider layout={displayedSplit} axis="columns" onChange={updateSplit} />}
            {displayedSplit && displayedSplit.direction !== "columns" && <SplitDivider layout={displayedSplit} axis="rows" onChange={updateSplit} />}

            {activeProject && projectTabs.length === 0 && (
              <ProjectHome
                project={activeProject}
                profiles={config.settings.profiles}
                defaultProfileId={preferredProfile.id}
                shortcuts={config.settings.shortcuts}
                onOpen={(profileId) => openTab(activeProject.id, profileId)}
                onShell={() => openTab(activeProject.id, null)}
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

      {settingsPresence.value && (
        <SettingsPanel
          entering={settingsPresence.entering}
          leaving={settingsPresence.leaving}
          settings={config.settings}
          appInfo={appInfo}
          claudeInfo={claudeInfo}
          codexInfo={codexInfo}
          initialSection={settingsInitialSection}
          onSave={updateSettings}
          onClose={() => setSettingsOpen(false)}
          onRedetect={redetectClaude}
        />
      )}

      {toast && (
        <Toast key={toast.id} message={toast.message} onDismiss={() => setToast(null)} />
      )}
      {paletteOpen && <CommandPalette commands={paletteCommands} onClose={()=>setPaletteOpen(false)} />}
      {usageOpen && <UsageDialog settings={config.settings} cwd={appInfo?.homeDir || activeProject?.path || "/"} onClose={()=>setUsageOpen(false)} />}
      {recoveryOpen && activeProject && <RecoverConversations project={activeProject} settings={config.settings} onClose={()=>setRecoveryOpen(false)} onResume={(profile,conversation)=>{
        setRecoveryOpen(false); const existing=tabs.find(tab=>!tab.exited && tab.profileId===profile.id && tab.conversationId===conversation.id);
        if(existing) setActiveTabId(existing.id); else { try { openTab(activeProject.id,profile.id,conversation); } catch(error) { showToast(formatError(error)); } }
      }} />}
      {imagePreview && <FeatureDialog title="Vista previa de la captura" onClose={()=>dismissImage(false)} footer={<><button className="btn btn-ghost" onClick={()=>dismissImage(false)}>Cancelar</button><button className="btn btn-primary" onClick={()=>dismissImage(true)}>Pegar imagen</button></>}>
        {imagePreview.image.preview ? <img className="clipboard-preview" src={imagePreview.image.preview} alt="Captura que se adjuntará al asistente" /> : <p>No se pudo mostrar la vista previa.</p>}
        <p className="feature-hint">{imagePreview.image.width} × {imagePreview.image.height} px · {sessionLabel(tabs.find(tab=>tab.id===imagePreview.tabId) ?? {subtitle:"Sesión",oscTitle:null,kind:"shell"})}</p><p className="feature-hint">Se adjunta a la sesión. El mensaje se envía cuando pulses Enter en el asistente.</p>
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
        <AppShell />
      </ImageViewerProvider>
      <TooltipProvider />
    </DialogProvider>
  );
}

// --- Pantalla de carga -----------------------------------------------------------

function Splash() {
  return (
    <div className="splash">
      <div className="splash-logo">✳</div>
      <div className="splash-name">trex</div>
      <div className="splash-sub">Cargando configuración…</div>
    </div>
  );
}
