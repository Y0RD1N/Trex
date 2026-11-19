/**
 * Actualizaciones que no son de Claude Code ni de Codex (esas las lleva `useCliUpdates`):
 *
 * - Antigravity: su componente lo descarga trex con una versión y una huella fijas. Cuando un
 *   trex nuevo trae otra versión, la anterior sigue instalada hasta que se pide la nueva.
 * - trex y Trex CLI: llegan juntos en el instalador. Se compara con la última versión publicada
 *   y se abre su página de descarga; trex no se sustituye a sí mismo.
 *
 * Se comprueba poco después de abrir, cada pocas horas y al volver a la ventana tras un rato.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { formatError } from "../api";
import { fetchLatestTrexVersion, isNewer, releasePage, type UpdateKind, type UpdateNotice } from "../cliUpdates";

const FIRST_CHECK_MS = 20_000;
const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;
const FOCUS_CHECK_MS = 60 * 60 * 1000;
const DISMISSED_KEY = "trex.dismissedAgentUpdates";

type AntigravityStatus = { current: string; installed: boolean; previous: string | null };
type Dismissed = Partial<Record<UpdateKind, string>>;

export type AgentUpdates = {
  notices: UpdateNotice[];
  check: () => Promise<void>;
  /** Instala o abre la descarga; devuelve el mensaje para el aviso. */
  run: (id: UpdateKind) => Promise<string>;
  dismiss: (id: UpdateKind) => void;
};

function readDismissed(): Dismissed {
  try { return JSON.parse(localStorage.getItem(DISMISSED_KEY) ?? "{}") as Dismissed; } catch { return {}; }
}

export function useAgentUpdates(appVersion: string | null, trexCliInstalled: boolean): AgentUpdates {
  const [antigravity, setAntigravity] = useState<AntigravityStatus | null>(null);
  const [release, setRelease] = useState<string | null>(null);
  const [updating, setUpdating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(readDismissed);
  const checkingRef = useRef(false);
  const checkedAtRef = useRef(0);

  const check = useCallback(async (): Promise<void> => {
    if (checkingRef.current || !isTauri()) return;
    checkingRef.current = true;
    try {
      const [status, latest] = await Promise.all([
        invoke<AntigravityStatus>("antigravity_update_status").catch(() => null),
        fetchLatestTrexVersion().catch(() => null),
      ]);
      if (status) setAntigravity(status);
      if (latest) setRelease(latest);
      checkedAtRef.current = Date.now();
    } finally {
      checkingRef.current = false;
    }
  }, []);

  useEffect(() => {
    const first = window.setTimeout(() => void check(), FIRST_CHECK_MS);
    const every = window.setInterval(() => void check(), CHECK_EVERY_MS);
    const onFocus = (): void => {
      if (checkedAtRef.current && Date.now() - checkedAtRef.current > FOCUS_CHECK_MS) void check();
    };
    window.addEventListener("focus", onFocus);
    return () => { window.clearTimeout(first); window.clearInterval(every); window.removeEventListener("focus", onFocus); };
  }, [check]);

  const notices: UpdateNotice[] = [];
  // Solo si ya se usaba Antigravity: quien nunca lo instaló no recibe avisos.
  if (antigravity && antigravity.previous && (!antigravity.installed || updating) && dismissed.antigravity !== antigravity.current) {
    notices.push({ id: "antigravity", name: "Antigravity", installed: antigravity.previous, latest: antigravity.current, updating, error, action: "Actualizar" });
  }
  if (isNewer(release, appVersion) && dismissed.trex !== release) {
    notices.push({ id: "trex", name: trexCliInstalled ? "trex y Trex CLI" : "trex", installed: appVersion, latest: release, updating: false, error: null, action: "Descargar" });
  }
  const stateRef = useRef({ antigravity, release });
  stateRef.current = { antigravity, release };

  const run = useCallback(async (id: UpdateKind): Promise<string> => {
    if (id === "trex") {
      const version = stateRef.current.release;
      if (!version) throw new Error("No se encontró la versión nueva de trex.");
      await openUrl(releasePage(version));
      return `Se abrió la página de trex ${version}. Descarga el instalador y ejecútalo con trex cerrado.`;
    }
    if (id !== "antigravity") throw new Error("Esta actualización no se gestiona aquí.");
    setUpdating(true);
    setError(null);
    try {
      await invoke("antigravity_install");
      const status = await invoke<AntigravityStatus>("antigravity_update_status").catch(() => null);
      if (status) setAntigravity(status);
      return `Antigravity se actualizó a la ${stateRef.current.antigravity?.current ?? "versión nueva"}. Las sesiones nuevas ya la usan.`;
    } catch (failure) {
      const message = formatError(failure);
      setError(message);
      throw new Error(`No se pudo actualizar Antigravity: ${message}`);
    } finally {
      setUpdating(false);
    }
  }, []);

  const dismiss = useCallback((id: UpdateKind): void => {
    const version = id === "trex" ? stateRef.current.release : id === "antigravity" ? stateRef.current.antigravity?.current : null;
    if (!version) return;
    setDismissed(previous => {
      const next = { ...previous, [id]: version };
      try { localStorage.setItem(DISMISSED_KEY, JSON.stringify(next)); } catch { /* almacenamiento no disponible */ }
      return next;
    });
  }, []);

  return { notices, check, run, dismiss };
}
