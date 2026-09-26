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
import { WebLinksAddon } from "@xterm/addon-web-links";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  DEFAULT_FONT_FAMILY,
  b64ToBytes,
  formatError,
  listenPtyData,
  listenPtyExit,
  ptyResize,
  ptySpawn,
  ptyWrite,
} from "../api";
import { CloseIcon, SearchIcon } from "./Icons";
import { getSearchDecorations, getTerminalTheme, getThemeMode, onThemeChange } from "../theme";
import type { Settings } from "../types";

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
  settings: Settings;
  /** El padre controla la visibilidad con display:none sin desmontar nada. */
  visible: boolean;
  onExit: (tabId: string, code: number | null) => void;
  onTitle: (tabId: string, title: string) => void;
};

function TerminalView({
  sessionId,
  cwd,
  command,
  args,
  shell,
  launchMode,
  settings,
  visible,
  onExit,
  onTitle,
}: TerminalViewProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const disposablesRef = useRef<IDisposable[]>([]);
  const unlistensRef = useRef<Array<() => void>>([]);
  const disposedRef = useRef(false);
  const spawnedRef = useRef(false);
  /** Id de sesión actual: cambia al reiniciar el proceso. */
  const currentIdRef = useRef(sessionId);
  const restartCountRef = useRef(0);
  /** Timer del debounce con el que se avisa al PTY del tamaño final. */
  const ptyResizeTimerRef = useRef<number | null>(null);
  /** Último {cols, rows} enviado al PTY: evita avisos redundantes. */
  const lastPtySizeRef = useRef<{ cols: number; rows: number } | null>(null);
  /** Última medida del contenedor con la que se ejecutó `fit()`. */
  const lastFitBoxRef = useRef<{ width: number; height: number }>({ width: -1, height: -1 });

  // Refs espejo de las props para usarlas desde callbacks estables.
  const launchRef = useRef({ cwd, command, args, shell, launchMode });
  launchRef.current = { cwd, command, args, shell, launchMode };
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;
  const onTitleRef = useRef(onTitle);
  onTitleRef.current = onTitle;

  const [status, setStatus] = useState<Status>("spawning");
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [overlayDismissed, setOverlayDismissed] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  const isClaude = command !== null;

  // --- Suscripciones a los eventos del PTY --------------------------------

  const cleanSubscriptions = useCallback(() => {
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
      const unData = await listenPtyData(id, (payload) => {
        termRef.current?.write(b64ToBytes(payload.data));
      });
      const unExit = await listenPtyExit(id, (payload) => {
        spawnedRef.current = false;
        setStatus("exited");
        setExitCode(payload.code);
        setOverlayDismissed(false);
        onExitRef.current(sessionIdRef.current, payload.code);
      });
      if (disposedRef.current) {
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
    setErrorMsg(null);
    setExitCode(null);
    setOverlayDismissed(false);
    const id = currentIdRef.current;
    const { cwd: dir, command: cmd, args: extraArgs, shell: sh, launchMode: mode } =
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
        env: null,
        cols,
        rows,
        launchMode: mode,
      });
      if (disposedRef.current) return;
      spawnedRef.current = true;
      // El PTY nace con este tamaño: que el debounce no repita el mismo aviso.
      lastPtySizeRef.current = { cols, rows };
      setStatus("running");
      // Si el contenedor cambió mientras arrancaba el proceso, el debounce pudo
      // consumirse antes de que la sesión estuviera viva: se reprograma.
      if (term.cols !== cols || term.rows !== rows) schedulePtyResize();
    } catch (error) {
      if (disposedRef.current) return;
      spawnedRef.current = false;
      const message = formatError(error);
      setErrorMsg(message);
      setStatus("error");
      // El error se muestra también dentro del propio terminal, en rojo.
      term.write(`\r\n\x1b[1;31m✖ No se pudo iniciar el proceso\x1b[0m\r\n`);
      term.write(`\x1b[31m${message}\x1b[0m\r\n`);
    }
  }, [schedulePtyResize, subscribe]);

  /** Reinicia el proceso con un id nuevo derivado del original. */
  const restart = useCallback(() => {
    restartCountRef.current += 1;
    currentIdRef.current = `${sessionIdRef.current}-r${restartCountRef.current}`;
    termRef.current?.reset();
    void startPty();
  }, [startPty]);

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
    if (!term) return;
    try {
      const text = await navigator.clipboard.readText();
      if (text) term.paste(text);
    } catch {
      /* sin permiso de lectura del portapapeles */
    }
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
      cursorBlink: initialSettings.cursorBlink,
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
    termRef.current = term;
    fitRef.current = fit;
    searchRef.current = search;
    term.open(host);

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
      if (event.type !== "keydown" || !(event.ctrlKey || event.metaKey)) return true;
      const key = event.key.toLowerCase();
      if (event.shiftKey && key === "c") {
        void copySelection();
        return false;
      }
      if (event.shiftKey && key === "v") {
        void pasteFromClipboard();
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

    // Título emitido por el programa (OSC 0/2): informativo, para el tooltip
    disposablesRef.current.push(
      term.onTitleChange((title) => {
        onTitleRef.current(sessionIdRef.current, title);
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

    // Reajuste ante cambios de tamaño del contenedor: el callback se agrupa con
    // rAF y un bucle de "asentamiento" acompaña a las animaciones (la barra
    // lateral tarda ~220 ms en colapsar). Mientras el tamaño siga cambiando no
    // hace nada (ya lo ajusta el observer); en la primera medida estable hace un
    // último fit con las dimensiones definitivas. Sin tamaño nuevo no se
    // reprograma nada, así que no puede entrar en bucle.
    let resizeRaf = 0;
    let settleRaf = 0;
    let settleChecks = 0;
    let settleFrames = 0;
    let settleWidth = -1;
    let settleHeight = -1;
    const settle = (): void => {
      settleRaf = 0;
      const current = hostRef.current;
      if (!current || disposedRef.current) return;
      const width = current.clientWidth;
      const height = current.clientHeight;
      if (width === settleWidth && height === settleHeight) settleFrames += 1;
      else {
        settleFrames = 0;
        settleWidth = width;
        settleHeight = height;
      }
      // Tamaño estable o presupuesto agotado (~4 s): fit definitivo y fin.
      if (settleFrames >= 1 || settleChecks >= 240) {
        safeFit(true);
        return;
      }
      settleChecks += 1;
      settleRaf = requestAnimationFrame(settle);
    };
    const observer = new ResizeObserver(() => {
      if (resizeRaf) return;
      resizeRaf = requestAnimationFrame(() => {
        resizeRaf = 0;
        safeFit();
        if (!settleRaf) {
          settleChecks = 0;
          settleFrames = 0;
          const current = hostRef.current;
          settleWidth = current ? current.clientWidth : -1;
          settleHeight = current ? current.clientHeight : -1;
          settleRaf = requestAnimationFrame(settle);
        }
      });
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
      if (settleRaf) cancelAnimationFrame(settleRaf);
      if (ptyResizeTimerRef.current !== null) {
        window.clearTimeout(ptyResizeTimerRef.current);
        ptyResizeTimerRef.current = null;
      }
      lastPtySizeRef.current = null;
      lastFitBoxRef.current = { width: -1, height: -1 };
      observer.disconnect();
      host.removeEventListener("mousedown", onMouseDown);
      cleanSubscriptions();
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

  // --- Cambios de ajustes en vivo ---------------------------------------------

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.fontSize = settings.fontSize;
    term.options.fontFamily = settings.fontFamily || DEFAULT_FONT_FAMILY;
    term.options.cursorBlink = settings.cursorBlink;
    term.options.scrollback = settings.scrollback;
    const raf = requestAnimationFrame(() => safeFit(true));
    return () => cancelAnimationFrame(raf);
  }, [settings.fontSize, settings.fontFamily, settings.cursorBlink, settings.scrollback, safeFit]);

  // --- Al activarse la pestaña: reajustar y enfocar ---------------------------

  useEffect(() => {
    if (!visible) return;
    const raf = requestAnimationFrame(() => {
      safeFit(true);
      termRef.current?.focus();
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
          className="term-tool-btn"
          title="Buscar en el terminal (Ctrl+F)"
          aria-label="Buscar en el terminal"
          onClick={() => setSearchOpen(true)}
        >
          <SearchIcon size={16} />
        </button>
      </div>

      {searchOpen && (
        <div className="term-search" onMouseDown={(event) => event.stopPropagation()}>
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
            title="Anterior (Shift+Enter)"
            onClick={() => runSearch("prev")}
          >
            ↑
          </button>
          <button
            type="button"
            className="term-search-btn"
            title="Siguiente (Enter)"
            onClick={() => runSearch("next")}
          >
            ↓
          </button>
          <button
            type="button"
            className="term-search-btn"
            title="Cerrar (Esc)"
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

      {status === "spawning" && (
        <div className="term-overlay">
          <div className="term-overlay-card">
            <span className="spinner" aria-hidden="true" />
            <span>{isClaude ? "Iniciando Claude…" : "Iniciando terminal…"}</span>
          </div>
        </div>
      )}

      {status === "exited" && !overlayDismissed && (
        <div className="term-overlay">
          <div className="term-overlay-card">
            <div className="term-overlay-title">
              Proceso finalizado ·{" "}
              {exitCode === null ? "sin código de salida" : `código ${exitCode}`}
            </div>
            <div className="term-overlay-actions">
              <button type="button" className="btn btn-primary" onClick={restart}>
                Reiniciar
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
          </div>
        </div>
      )}

      {status === "error" && !overlayDismissed && (
        <div className="term-overlay">
          <div className="term-overlay-card term-overlay-error">
            <div className="term-overlay-title">No se pudo iniciar el proceso</div>
            <div className="term-overlay-msg">{errorMsg}</div>
            <div className="term-overlay-actions">
              <button type="button" className="btn btn-primary" onClick={restart}>
                Reintentar
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => setOverlayDismissed(true)}
              >
                Ver salida
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// memo: evita re-renderizados inútiles de xterm (por ejemplo al arrastrar la sidebar).
export default memo(TerminalView);
