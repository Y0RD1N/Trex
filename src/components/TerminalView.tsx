/**
 * TerminalView: monta un terminal xterm.js conectado a una sesión PTY del
 * backend (eventos `pty-data-<id>` / `pty-exit-<id>` y comandos pty_write,
 * pty_resize, pty_spawn).
 *
 * El componente se monta una sola vez por pestaña y nunca se desmonta al
 * cambiar de pestaña (el padre lo oculta con display:none), así que el buffer
 * y el proceso se conservan.
 */
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { Terminal, type IDisposable } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { UnicodeGraphemesAddon } from "@xterm/addon-unicode-graphemes";
import { WebLinksAddon } from "@xterm/addon-web-links";
import type { WebglAddon } from "@xterm/addon-webgl";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  DEFAULT_FONT_FAMILY,
  b64ToBytes,
  formatError,
  listenPtyData,
  listenPtyExit,
  ptyAck,
  ptyKill,
  ptyResize,
  ptySpawn,
  ptyWrite,
  readClipboard,
} from "../api";
import { clipboardPasteAction, matchesPasteShortcut } from "../paste";
import { IS_WINDOWS } from "../platform";
import { applyCursorOptions, cursorOptions, installCursorPolicy } from "../cursor";
import { CloseIcon, SearchIcon } from "./Icons";
import { getSearchDecorations, getTerminalTheme, getThemeMode, onThemeChange } from "../theme";
import type { AgentActivity, AgentNoticeKind, Settings, TabKind } from "../types";
import { ACTIVITY_FOOTER_ROWS, ACTIVITY_SAMPLE_MS, ACTIVITY_SETTLE_MS, activitySignal, screenActivity } from "../agentActivity";
import { usePresence } from "../hooks/usePresence";
import { AgentNoticeTracker, NoticeScheduler, noticeSignal } from "../agentNotices";

type Status = "spawning" | "running" | "exited" | "error";

/**
 * Retardo con el que se avisa al PTY del tamaño final. Cada cambio de tamaño
 * del PTY hace que la TUI (Claude Code) repinte su interfaz completa, así que
 * el aviso se agrupa para que un arrastre del divisor cuente como uno solo.
 */
const PTY_RESIZE_DEBOUNCE_MS = 120;

export type TerminalViewProps = {
  sessionId: string;
  cwd: string;
  command: string | null;
  args: string | null;
  shell: string;
  launchMode: string;
  env: Record<string, string> | null;
  launchLabel: string | null;
  kind: TabKind;
  settings: Settings;
  /** El padre controla la visibilidad con display:none sin desmontar nada. */
  visible: boolean;
  onExit: (tabId: string, code: number | null) => void;
  onTitle: (tabId: string, title: string) => void;
  onActivity: (tabId: string, activity: AgentActivity) => void;
  onRunning: (tabId: string) => void;
  onNotice: (tabId: string, kind: AgentNoticeKind) => void;
  onMessage: (message: string) => void;
};

function TerminalView({
  sessionId,
  cwd,
  command,
  args,
  shell,
  launchMode,
  env,
  launchLabel,
  kind,
  settings,
  visible,
  onExit,
  onTitle,
  onActivity,
  onRunning,
  onNotice,
  onMessage,
}: TerminalViewProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const rendererFailedRef = useRef(false);
  const disposablesRef = useRef<IDisposable[]>([]);
  const unlistensRef = useRef<Array<() => void>>([]);
  const releaseOutputRef = useRef<(() => void) | null>(null);
  const disposedRef = useRef(false);
  const spawnedRef = useRef(false);
  const exitedIdRef = useRef<string | null>(null);
  /** Id de sesión actual: cambia al reiniciar el proceso. */
  const currentIdRef = useRef(sessionId);
  const restartCountRef = useRef(0);
  const restartingRef = useRef(false);
  /** Timer del debounce con el que se avisa al PTY del tamaño final. */
  const ptyResizeTimerRef = useRef<number | null>(null);
  /** Último {cols, rows} enviado al PTY: evita avisos redundantes. */
  const lastPtySizeRef = useRef<{ cols: number; rows: number } | null>(null);
  /** Última medida del contenedor con la que se ejecutó `fit()`. */
  const lastFitBoxRef = useRef<{ width: number; height: number }>({ width: -1, height: -1 });

  // Refs espejo de las props para usarlas desde callbacks estables.
  const launchRef = useRef({ cwd, command, args, shell, launchMode, env });
  launchRef.current = { cwd, command, args, shell, launchMode, env };
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;
  const onTitleRef = useRef(onTitle);
  onTitleRef.current = onTitle;
  const onActivityRef = useRef(onActivity);
  onActivityRef.current = onActivity;
  const onRunningRef = useRef(onRunning);
  onRunningRef.current = onRunning;
  const kindRef = useRef(kind);
  kindRef.current = kind;
  const onNoticeRef = useRef(onNotice);
  onNoticeRef.current = onNotice;
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;
  const pasteQueueRef = useRef<Promise<void>>(Promise.resolve());

  const [status, setStatus] = useState<Status>("spawning");
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [overlayDismissed, setOverlayDismissed] = useState(false);
  const overlayPresence = usePresence(status !== "running" && !overlayDismissed ? status : null);
  const [searchOpen, setSearchOpen] = useState(false);
  const searchPresence = usePresence(searchOpen ? true : null);
  const [searchTerm, setSearchTerm] = useState("");
  const searchInputRef = useRef<HTMLInputElement | null>(null);


  // --- Suscripciones a los eventos del PTY --------------------------------

  const cleanSubscriptions = useCallback(() => {
    releaseOutputRef.current?.();
    releaseOutputRef.current = null;
    for (const unlisten of unlistensRef.current) {
      try {
        unlisten();
      } catch {
        /* ya estaba cancelada */
      }
    }
    unlistensRef.current = [];
  }, []);

  const subscribe = useCallback(
    async (id: string) => {
      cleanSubscriptions();
      // Devuelve créditos cuando xterm ha procesado los bytes, no al recibirlos.
      // Agrupa los avisos para evitar un viaje IPC por cada pequeño fragmento.
      let parsedBytes = 0;
      let ackTimer: number | null = null;
      let released = false;
      const term = termRef.current;
      let sampleTimer: number | null = null;
      let settleTimer: number | null = null;
      let activity: AgentActivity = "idle";
      let pendingActivity: AgentActivity | null = null;
      let progress: AgentActivity | undefined;
      let notification: AgentActivity | undefined;
      const activityListeners: IDisposable[] = [];
      const notices = new AgentNoticeTracker();
      const publishNotice = (notice: AgentNoticeKind | undefined): void => {
        if (notice && !released && !disposedRef.current && kindRef.current !== "shell") {
          onNoticeRef.current(sessionIdRef.current, notice);
        }
      };
      // Los avisos deducidos de la pantalla esperan a que el agente se quede quieto:
      // el indicador "trabajando" se apaga entre pasos de una misma tarea.
      const scheduler = new NoticeScheduler(publishNotice);
      const publishActivity = (next: AgentActivity): void => {
        if (released || disposedRef.current || exitedIdRef.current === id || activity === next) return;
        activity = next;
        onActivityRef.current(sessionIdRef.current, next);
        if (next === "working") scheduler.working();
        else if (scheduler.cancel() === "ready") notices.resume();
        const notice = notices.transition(next);
        if (notice) scheduler.propose(notice);
      };
      const cancelSettle = (): void => {
        if (settleTimer !== null) window.clearTimeout(settleTimer);
        settleTimer = null;
        pendingActivity = null;
      };
      const resetActivity = (): void => {
        if (sampleTimer !== null) window.clearTimeout(sampleTimer);
        sampleTimer = null;
        cancelSettle();
        progress = notification = undefined;
        activity = "idle";
        notices.reset();
        scheduler.reset();
        if (!disposedRef.current) onActivityRef.current(sessionIdRef.current, "idle");
      };
      const sampleActivity = (): void => {
        sampleTimer = null;
        if (!term || released || disposedRef.current || exitedIdRef.current === id) return;
        const buffer = term.buffer.active;
        // Las TUIs cortas dejan filas vacías debajo; las largas usan toda la
        // pantalla. baseY sigue el proceso aunque el usuario mire el historial.
        let bottom = term.rows - 1;
        while (bottom > 0 && !buffer.getLine(buffer.baseY + bottom)?.translateToString(true).trim()) bottom--;
        const footer: string[] = [];
        for (let row = Math.max(0, bottom - ACTIVITY_FOOTER_ROWS + 1); row <= bottom; row++) {
          footer.push(buffer.getLine(buffer.baseY + row)?.translateToString(true) ?? "");
        }
        const screen = screenActivity(kindRef.current, footer);
        const next = screen === "waiting" ? screen : notification ?? progress ?? screen;
        notification = undefined;
        if (next === activity) { cancelSettle(); return; }
        if (next === "working") {
          cancelSettle();
          publishActivity(next);
        } else if (pendingActivity !== next) {
          // Un borrado y repintado intermedio no debe detener el icono.
          cancelSettle();
          pendingActivity = next;
          settleTimer = window.setTimeout(() => {
            settleTimer = null;
            pendingActivity = null;
            publishActivity(next);
          }, ACTIVITY_SETTLE_MS);
        }
      };
      const scheduleActivity = (): void => {
        if (released || disposedRef.current || sampleTimer !== null) return;
        sampleTimer = window.setTimeout(sampleActivity, ACTIVITY_SAMPLE_MS);
      };
      if (term && kindRef.current !== "shell") {
        activityListeners.push(term.onWriteParsed(scheduleActivity));
        for (const osc of [9, 133, 777]) {
          activityListeners.push(term.parser.registerOscHandler(osc, data => {
            const next = activitySignal(osc, data);
            if (next !== undefined) {
              if (osc === 9 && data.startsWith("4;")) {
                if (next === "working" && progress !== "working") { notices.begin(); scheduler.working(); }
                if (next === "idle" && progress === "working") {
                  const ready = notices.signal("ready");
                  if (ready) scheduler.propose(ready);
                }
                progress = next;
              }
              else { progress = undefined; notification = next; }
              // La notificación explícita del propio agente es fiable: sin espera.
              const notice = noticeSignal(osc, data);
              if (notice) {
                const explicit = notices.signal(notice);
                if (explicit) scheduler.emitNow(explicit);
              }
              scheduleActivity();
            }
            return false; // Deja que los demás handlers de xterm reciban el OSC.
          }));
        }
      }
      const flushAck = (): void => {
        if (ackTimer !== null) window.clearTimeout(ackTimer);
        ackTimer = null;
        if (!parsedBytes || released) return;
        const bytes = parsedBytes;
        parsedBytes = 0;
        void ptyAck(id, bytes).catch(() => { /* sesión cerrada */ });
      };
      const acknowledge = (bytes: number): void => {
        if (released || disposedRef.current) return;
        parsedBytes += bytes;
        if (parsedBytes >= 64 * 1024) flushAck();
        else if (ackTimer === null) ackTimer = window.setTimeout(flushAck, 8);
      };
      releaseOutputRef.current = () => {
        flushAck();
        resetActivity();
        released = true;
        for (const listener of activityListeners) listener.dispose();
      };
      const unData = await listenPtyData(id, (payload) => {
        if (released || disposedRef.current) return;
        const bytes = b64ToBytes(payload.data);
        termRef.current?.write(bytes, () => acknowledge(bytes.length));
      });
      const unExit = await listenPtyExit(id, (payload) => {
        if (released || disposedRef.current) return;
        // Al salir se anuncia ya lo que estuviera pendiente (p. ej. `claude -p`).
        const exitNotice = notices.exit(payload.code);
        if (exitNotice) scheduler.emitNow(exitNotice);
        else scheduler.flush();
        resetActivity();
        exitedIdRef.current = id;
        spawnedRef.current = false;
        // Barrera de escritura: el aviso no tapa la última salida aún en cola.
        termRef.current?.write("", () => {
          if (released || disposedRef.current) return;
          flushAck();
          spawnedRef.current = false;
          setStatus("exited");
          setExitCode(payload.code);
          setOverlayDismissed(false);
          onExitRef.current(sessionIdRef.current, payload.code);
        });
      });
      if (disposedRef.current || released || currentIdRef.current !== id) {
        // El componente se desmontó mientras se registraban los listeners.
        unData();
        unExit();
        return;
      }
      unlistensRef.current = [unData, unExit];
    },
    [cleanSubscriptions],
  );

  // --- Ajuste de tamaño ------------------------------------------------------

  /**
   * Avisa al PTY del tamaño actual, solo si ha cambiado desde el último aviso.
   * Después de aplicarlo se refresca la vista desde el buffer para eliminar
   * los restos del repintado anterior del terminal.
   */
  const flushPtyResize = useCallback(() => {
    ptyResizeTimerRef.current = null;
    const term = termRef.current;
    if (!term || disposedRef.current || !spawnedRef.current) return;
    const { cols, rows } = term;
    const last = lastPtySizeRef.current;
    if (last && last.cols === cols && last.rows === rows) return;
    lastPtySizeRef.current = { cols, rows };
    void ptyResize(currentIdRef.current, cols, rows)
      .then(() => {
        if (disposedRef.current) return;
        // El reflow deja artefactos del repintado anterior: se vuelve a pintar
        // el buffer completo para que solo se vea su contenido actual.
        const current = termRef.current;
        if (current) current.refresh(0, current.rows - 1);
      })
      .catch(() => {
        /* la sesión ya no existe */
      });
  }, []);

  /** Reprograma el aviso de tamaño al PTY (debounce: solo cuenta el tamaño final). */
  const schedulePtyResize = useCallback(() => {
    if (ptyResizeTimerRef.current !== null) window.clearTimeout(ptyResizeTimerRef.current);
    ptyResizeTimerRef.current = window.setTimeout(flushPtyResize, PTY_RESIZE_DEBOUNCE_MS);
  }, [flushPtyResize]);

  /**
   * Reajusta el terminal al contenedor. El fit visual es inmediato (el terminal
   * se ve siempre ajustado), pero el aviso al PTY va con debounce para que un
   * arrastre del divisor o la animación de la barra lateral no generen decenas
   * de SIGWINCH. `force` salta el atajo de "mismo tamaño" cuando algo externo
   * cambió las medidas de la rejilla (tamaño de fuente, visibilidad de la pestaña).
   */
  const safeFit = useCallback(
    (force = false) => {
      const term = termRef.current;
      const fit = fitRef.current;
      const host = hostRef.current;
      if (!term || !fit || !host) return;
      // Con la pestaña oculta el contenedor no tiene medidas: no hay nada que ajustar.
      const width = host.clientWidth;
      const height = host.clientHeight;
      if (width < 16 || height < 16) return;
      const lastBox = lastFitBoxRef.current;
      if (!force && width === lastBox.width && height === lastBox.height) return;
      try {
        fit.fit();
      } catch {
        /* el terminal aún no está listo para medirse */
        return;
      }
      lastFitBoxRef.current = { width, height };
      schedulePtyResize();
    },
    [schedulePtyResize],
  );

  // --- Arranque del proceso ---------------------------------------------------

  const startPty = useCallback(async () => {
    const term = termRef.current;
    if (!term || disposedRef.current) return;
    setStatus("spawning");
    exitedIdRef.current = null;
    setErrorMsg(null);
    setExitCode(null);
    setOverlayDismissed(false);
    const id = currentIdRef.current;
    const { cwd: dir, command: cmd, args: extraArgs, shell: sh, launchMode: mode, env: profileEnv } =
      launchRef.current;
    const cols = term.cols > 1 ? term.cols : 80;
    const rows = term.rows > 1 ? term.rows : 24;

    try {
      // Los listeners se registran antes de lanzar el proceso para no perder salida.
      await subscribe(id);
      if (disposedRef.current) return;
      await ptySpawn({
        id,
        cwd: dir,
        command: cmd,
        args: extraArgs,
        shell: sh,
        env: profileEnv,
        cols,
        rows,
        launchMode: mode,
        flowControl: true,
      });
      if (disposedRef.current || currentIdRef.current !== id) {
        // La fila pudo cerrarse mientras el backend todavía arrancaba.
        void ptyKill(id).catch(() => {});
        return;
      }
      if (exitedIdRef.current === id) return;
      spawnedRef.current = true;
      onRunningRef.current(sessionIdRef.current);
      // El PTY nace con este tamaño: que el debounce no repita el mismo aviso.
      lastPtySizeRef.current = { cols, rows };
      setStatus("running");
      // Si el contenedor cambió mientras arrancaba el proceso, el debounce pudo
      // consumirse antes de que la sesión estuviera viva: se reprograma.
      if (term.cols !== cols || term.rows !== rows) schedulePtyResize();
    } catch (error) {
      if (disposedRef.current) return;
      spawnedRef.current = false;
      cleanSubscriptions();
      const message = formatError(error);
      setErrorMsg(message);
      setStatus("error");
      // El error se muestra también dentro del propio terminal, en rojo.
      term.write(`\r\n\x1b[1;31m✖ No se pudo iniciar el proceso\x1b[0m\r\n`);
      term.write(`\x1b[31m${message}\x1b[0m\r\n`);
    }
  }, [cleanSubscriptions, schedulePtyResize, subscribe]);

  /** Reinicia el proceso con un id nuevo derivado del original. */
  const restart = useCallback(() => {
    if (restartingRef.current) return;
    restartingRef.current = true;
    setStatus("spawning");
    cleanSubscriptions();
    spawnedRef.current = false;
    // La sesión finalizada aún conserva el master y el lector en el backend.
    // Suéltalos antes de crear otro proceso para esta misma vista.
    void ptyKill(currentIdRef.current).catch(() => {});
    restartCountRef.current += 1;
    currentIdRef.current = `${sessionIdRef.current}-r${restartCountRef.current}`;
    termRef.current?.write("", () => {
      if (disposedRef.current) return;
      termRef.current?.reset();
      void startPty().finally(() => { restartingRef.current = false; });
    });
  }, [cleanSubscriptions, startPty]);

  // --- Portapapeles ------------------------------------------------------------

  const copySelection = useCallback(async () => {
    const selection = termRef.current?.getSelection() ?? "";
    if (!selection) return;
    try {
      await navigator.clipboard.writeText(selection);
    } catch {
      /* portapapeles no disponible */
    }
  }, []);

  const pasteFromClipboard = useCallback(async () => {
    const term = termRef.current;
    const id = currentIdRef.current;
    if (!term || !spawnedRef.current || disposedRef.current) return;
    // Mantiene el orden de pegados rápidos. Una sesión cerrada o reiniciada
    // nunca recibe una lectura que empezó para el proceso anterior.
    const pending = pasteQueueRef.current.then(async () => {
      if (disposedRef.current || currentIdRef.current !== id || !spawnedRef.current) return;
      const content = await readClipboard();
      if (disposedRef.current || currentIdRef.current !== id || !spawnedRef.current) return;
      const action = clipboardPasteAction(content, kindRef.current, IS_WINDOWS);
      if (action.kind === "text") {
        if (action.text) term.paste(action.text); // Conserva el bracketed paste de xterm.
      } else if (action.kind === "key") {
        await ptyWrite(id, action.data);
      } else {
        onMessageRef.current("Las imágenes se pueden pegar en sesiones de Claude Code o Codex.");
      }
    }).catch(error => {
      if (!disposedRef.current && currentIdRef.current === id) onMessageRef.current(formatError(error));
    });
    pasteQueueRef.current = pending;
    await pending;
  }, []);

  // --- Búsqueda ---------------------------------------------------------------

  const runSearch = useCallback(
    (direction: "next" | "prev") => {
      const search = searchRef.current;
      if (!search || !searchTerm) return;
      const options = { incremental: true, decorations: getSearchDecorations(getThemeMode()) };
      if (direction === "next") search.findNext(searchTerm, options);
      else search.findPrevious(searchTerm, options);
    },
    [searchTerm],
  );

  // --- Montaje del terminal (una sola vez) ------------------------------------

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    disposedRef.current = false;

    const initialSettings = settingsRef.current;
    const term = new Terminal({
      fontFamily: initialSettings.fontFamily || DEFAULT_FONT_FAMILY,
      fontSize: initialSettings.fontSize,
      lineHeight: 1.12,
      ...cursorOptions(initialSettings),
      scrollback: initialSettings.scrollback,
      allowProposedApi: true,
      theme: getTerminalTheme(getThemeMode()),
    });
    const fit = new FitAddon();
    const search = new SearchAddon();
    const links = new WebLinksAddon((event, uri) => {
      event.preventDefault();
      void openUrl(uri).catch(() => {
        /* no se pudo abrir el enlace */
      });
    });
    term.loadAddon(fit);
    term.loadAddon(search);
    term.loadAddon(links);
    // Anchos Unicode modernos (15 + grafemas). Por defecto xterm usa las tablas de
    // Unicode 6 y cuenta 1 celda para emojis como 📁 🧠 ⚡, mientras que Claude Code
    // y Codex cuentan 2. Con anchos distintos, sus actualizaciones parciales (barra de
    // estado, pie del compositor) posicionan el cursor por columna y caen desplazadas
    // o dejan restos sin repintar. Debe cargarse antes de recibir salida del PTY.
    term.loadAddon(new UnicodeGraphemesAddon());
    termRef.current = term;
    fitRef.current = fit;
    searchRef.current = search;
    term.open(host);
    disposablesRef.current.push(installCursorPolicy(term, () => settingsRef.current));

    // Teclado → PTY
    disposablesRef.current.push(
      term.onData((data) => {
        if (!spawnedRef.current) return;
        void ptyWrite(currentIdRef.current, data).catch(() => {
          /* sesión cerrada */
        });
      }),
    );

    // Copiar/pegar y búsqueda desde el propio terminal
    term.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown" || event.isComposing || event.getModifierState("AltGraph")) return true;
      if (matchesPasteShortcut(event, settingsRef.current.pasteShortcut)
        || ((event.ctrlKey || event.metaKey) && event.shiftKey && !event.altKey && event.key.toLowerCase() === "v")) {
        event.preventDefault();
        event.stopPropagation();
        if (!event.repeat) void pasteFromClipboard();
        return false;
      }
      if (!(event.ctrlKey || event.metaKey)) return true;
      const key = event.key.toLowerCase();
      if (event.shiftKey && key === "c") {
        void copySelection();
        return false;
      }
      if (!event.shiftKey && key === "f") {
        setSearchOpen(true);
        return false;
      }
      return true;
    });

    // Copiar automáticamente al seleccionar (si está activado en ajustes)
    disposablesRef.current.push(
      term.onSelectionChange(() => {
        if (!settingsRef.current.copyOnSelect) return;
        const selection = term.getSelection();
        if (selection) void navigator.clipboard.writeText(selection).catch(() => {});
      }),
    );

    // Claude puede emitir muchos títulos OSC seguidos. Publica solo el último
    // de cada intervalo sin arrastrar React al ritmo de la salida del PTY.
    let titleTimer: number | null = null;
    let latestTitle = "";
    let publishedTitle: string | null = null;
    disposablesRef.current.push(
      term.onTitleChange((title) => {
        latestTitle = title;
        if (titleTimer !== null || title === publishedTitle) return;
        titleTimer = window.setTimeout(() => {
          titleTimer = null;
          if (disposedRef.current || latestTitle === publishedTitle) return;
          publishedTitle = latestTitle;
          onTitleRef.current(sessionIdRef.current, latestTitle);
        }, 100);
      }),
    );

    const onMouseDown = (): void => {
      term.focus();
    };
    host.addEventListener("mousedown", onMouseDown);

    // El terminal sigue el tema activo: se repinta al cambiar claro/oscuro.
    const unTheme = onThemeChange((mode) => {
      const current = termRef.current;
      if (current) current.options.theme = getTerminalTheme(mode);
    });

    // Mientras se desliza la barra lateral (ancho) o se esconde la superior (alto)
    // se conserva la rejilla del terminal: recalcular columnas en cada fotograma
    // haría saltar y envolver el texto. Al asentarse se ajusta una vez. El
    // arrastre manual sigue siendo inmediato.
    let resizeRaf = 0;
    const resize = (): void => {
      resizeRaf = 0;
      if (disposedRef.current) return;
      const moving = Array.from(document.querySelectorAll(".sidebar, .bar-slot")).some(element =>
        element.getAnimations().some(animation =>
          "transitionProperty" in animation
          && (animation.transitionProperty === "width" || animation.transitionProperty === "height")
          && animation.playState === "running"));
      if (moving) {
        resizeRaf = requestAnimationFrame(resize);
      } else {
        safeFit();
      }
    };
    const observer = new ResizeObserver(() => {
      if (!resizeRaf) resizeRaf = requestAnimationFrame(resize);
    });
    observer.observe(host);

    // Primer ajuste y arranque del PTY con las dimensiones reales
    const initialRaf = requestAnimationFrame(() => {
      safeFit();
      void startPty();
    });

    return () => {
      disposedRef.current = true;
      unTheme();
      cancelAnimationFrame(initialRaf);
      if (resizeRaf) cancelAnimationFrame(resizeRaf);
      if (titleTimer !== null) window.clearTimeout(titleTimer);
      if (ptyResizeTimerRef.current !== null) {
        window.clearTimeout(ptyResizeTimerRef.current);
        ptyResizeTimerRef.current = null;
      }
      lastPtySizeRef.current = null;
      lastFitBoxRef.current = { width: -1, height: -1 };
      observer.disconnect();
      host.removeEventListener("mousedown", onMouseDown);
      cleanSubscriptions();
      // Tras reiniciar, el id del proceso difiere del id de la fila. El padre
      // cierra el original; esta vista libera también la sesión reemplazada.
      if (currentIdRef.current !== sessionIdRef.current) {
        void ptyKill(currentIdRef.current).catch(() => {});
      }
      for (const disposable of disposablesRef.current) {
        try {
          disposable.dispose();
        } catch {
          /* ya estaba liberado */
        }
      }
      disposablesRef.current = [];
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      searchRef.current = null;
    };
  }, [cleanSubscriptions, copySelection, pasteFromClipboard, safeFit, startPty]);

  // Solo la sesión visible reserva un contexto gráfico. Las otras conservan
  // su proceso y su historial sin multiplicar texturas ni recursos de GPU.
  useEffect(() => {
    const term = termRef.current;
    if (!visible || !term || rendererFailedRef.current) return;
    let cancelled = false;
    let addon: WebglAddon | null = null;
    let contextLoss: IDisposable | null = null;
    let graphics: WebGL2RenderingContext | null = null;
    let graphicsCanvas: HTMLCanvasElement | null = null;
    const release = (): void => {
      graphicsCanvas?.removeEventListener("webglcontextlost", fallback);
      graphicsCanvas = null;
      contextLoss?.dispose();
      contextLoss = null;
      addon?.dispose();
      addon = null;
      // Soltar texturas no libera inmediatamente el cupo de contextos del
      // navegador. Ciérralo también para poder cambiar muchas veces de sesión.
      if (graphics && !graphics.isContextLost()) {
        graphics.getExtension("WEBGL_lose_context")?.loseContext();
      }
      graphics = null;
    };
    const fallback = (): void => {
      rendererFailedRef.current = true;
      release();
      if (!disposedRef.current) term.refresh(0, term.rows - 1);
    };
    void (async () => {
      try {
        await document.fonts.ready;
        const { WebglAddon } = await import("@xterm/addon-webgl");
        if (cancelled || disposedRef.current) return;
        addon = new WebglAddon();
        contextLoss = addon.onContextLoss(fallback);
        term.loadAddon(addon);
        for (const canvas of term.element?.querySelectorAll<HTMLCanvasElement>(".xterm-screen canvas") ?? []) {
          const context = canvas.getContext("webgl2");
          if (context) {
            graphics = context;
            graphicsCanvas = canvas;
            // El addon espera a que se recupere el contexto. La app muestra
            // el renderer compatible de inmediato para evitar una vista vacía.
            canvas.addEventListener("webglcontextlost", fallback);
            break;
          }
        }
        safeFit(true);
      } catch {
        if (cancelled) return;
        rendererFailedRef.current = true;
        release();
        // Sin WebGL o tras una suspensión, xterm mantiene el dibujado DOM.
      }
    })();
    return () => {
      cancelled = true;
      release();
    };
  }, [visible, safeFit]);

  // --- Cambios de ajustes en vivo ---------------------------------------------

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    const fontFamily = settings.fontFamily || DEFAULT_FONT_FAMILY;
    const fontChanged = term.options.fontSize !== settings.fontSize
      || term.options.fontFamily !== fontFamily;
    term.options.fontSize = settings.fontSize;
    term.options.fontFamily = fontFamily;
    term.options.scrollback = settings.scrollback;
    const raf = fontChanged ? requestAnimationFrame(() => safeFit(true)) : 0;
    return () => cancelAnimationFrame(raf);
  }, [settings.fontSize, settings.fontFamily, settings.scrollback, safeFit]);

  useEffect(() => {
    if (termRef.current) applyCursorOptions(termRef.current, settings);
  }, [settings.cursorStyle, settings.cursorWidth, settings.cursorBlink]);

  // --- Al activarse la pestaña: reajustar y enfocar ---------------------------

  useEffect(() => {
    if (!visible) return;
    const raf = requestAnimationFrame(() => {
      safeFit(true);
      // Cambiar de proyecto desde un menú no debe quitarle el foco al menú.
      if (!document.querySelector('[role="menu"], [role="alertdialog"]')) termRef.current?.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [visible, safeFit]);

  // --- Barra de búsqueda ------------------------------------------------------

  useEffect(() => {
    if (searchOpen) {
      const timer = window.setTimeout(() => {
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      }, 0);
      return () => window.clearTimeout(timer);
    }
    searchRef.current?.clearDecorations();
  }, [searchOpen]);

  return (
    <div className="terminal-view">
      <div className="term-canvas" ref={hostRef} />

      <div className="term-tools">
        <button
          type="button"
          className="term-tool-btn tip-below"
          data-tip="Buscar en el terminal (Ctrl+F)"
          aria-label="Buscar en el terminal"
          onClick={() => setSearchOpen(true)}
        >
          <SearchIcon size={16} />
        </button>
      </div>

      {searchPresence.value && (
        <div className={`term-search motion-popover${searchPresence.entering ? " entering" : ""}${searchPresence.leaving ? " leaving" : ""}`}
          inert={searchPresence.leaving} aria-hidden={searchPresence.leaving || undefined}
          onMouseDown={(event) => event.stopPropagation()}>
          <input
            ref={searchInputRef}
            className="term-search-input"
            value={searchTerm}
            placeholder="Buscar…"
            spellCheck={false}
            onChange={(event) => setSearchTerm(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                runSearch(event.shiftKey ? "prev" : "next");
              } else if (event.key === "Escape") {
                event.preventDefault();
                setSearchOpen(false);
                termRef.current?.focus();
              }
            }}
          />
          <button
            type="button"
            className="term-search-btn"
            data-tip="Anterior (Shift+Enter)"
            aria-label="Resultado anterior"
            onClick={() => runSearch("prev")}
          >
            ↑
          </button>
          <button
            type="button"
            className="term-search-btn"
            data-tip="Siguiente (Enter)"
            aria-label="Resultado siguiente"
            onClick={() => runSearch("next")}
          >
            ↓
          </button>
          <button
            type="button"
            className="term-search-btn"
            data-tip="Cerrar (Esc)"
            aria-label="Cerrar búsqueda"
            onClick={() => {
              setSearchOpen(false);
              termRef.current?.focus();
            }}
          >
            <CloseIcon size={16} />
          </button>
        </div>
      )}

      {(status === "exited" || status === "error") && overlayDismissed && (
        <button
          type="button"
          className="term-status-chip"
          onClick={() => setOverlayDismissed(false)}
        >
          {status === "error"
            ? "error al iniciar · ver detalle"
            : `proceso terminado (${exitCode === null ? "sin código" : `código ${exitCode}`})`}
        </button>
      )}

      {overlayPresence.value && (
        <div className={`term-overlay${overlayPresence.entering ? " entering" : ""}${overlayPresence.leaving ? " leaving" : ""}`}
          inert={overlayPresence.leaving} aria-hidden={overlayPresence.leaving || undefined}>
          <div key={overlayPresence.value}
            className={`term-overlay-card${overlayPresence.value === "error" ? " term-overlay-error" : ""}`}>
            {overlayPresence.value === "spawning" ? <>
            <span className="spinner" aria-hidden="true" />
            <span>{command ? `Iniciando ${launchLabel ?? "asistente"}…` : "Iniciando terminal…"}</span>
            </> : <>
            {overlayPresence.value === "error" ? <>
              <div className="term-overlay-title">No se pudo iniciar el proceso</div>
              <div className="term-overlay-msg">{errorMsg}</div>
            </> : <div className="term-overlay-title">
              Proceso finalizado ·{" "}
              {exitCode === null ? "sin código de salida" : `código ${exitCode}`}
            </div>}
            <div className="term-overlay-actions">
              <button type="button" className="btn btn-primary" onClick={restart}>
                {overlayPresence.value === "error" ? "Reintentar" : "Reiniciar"}
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => {
                  setOverlayDismissed(true);
                  termRef.current?.focus();
                }}
              >
                Ver salida
              </button>
            </div>
            </>}
          </div>
        </div>
      )}
    </div>
  );
}

// memo: evita re-renderizados inútiles de xterm (por ejemplo al arrastrar la sidebar).
export default memo(TerminalView);
