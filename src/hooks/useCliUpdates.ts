/**
 * Busca versiones nuevas de Claude Code y Codex y las instala con su propio
 * comando. Se comprueba poco después de abrir trex, cada pocas horas y al
 * volver a la ventana tras un rato; nunca durante el arranque.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { formatError } from "../api";
import { CLI_NAMES, fetchLatestVersion, isNewer, parseVersion, type CliId } from "../cliUpdates";
import type { ClaudeInfo } from "../types";

const FIRST_CHECK_MS = 15_000;
const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;
const FOCUS_CHECK_MS = 60 * 60 * 1000;
const DISMISSED_KEY = "trex.dismissedUpdates";

export type CliStatus = {
  id: CliId;
  name: string;
  path: string | null;
  installed: string | null;
  latest: string | null;
  available: boolean;
  /** La persona eligió «Ahora no» para esta versión. */
  dismissed: boolean;
  updating: boolean;
  error: string | null;
};

export type CliUpdates = {
  status: Record<CliId, CliStatus>;
  checking: boolean;
  checkedAt: number | null;
  check: () => Promise<void>;
  /** Instala la versión nueva; devuelve el mensaje para el aviso. */
  update: (id: CliId) => Promise<string>;
  dismiss: (id: CliId) => void;
};

function readDismissed(): Partial<Record<CliId, string>> {
  try { return JSON.parse(localStorage.getItem(DISMISSED_KEY) ?? "{}") as Partial<Record<CliId, string>>; } catch { return {}; }
}

export function useCliUpdates(info: Record<CliId, ClaudeInfo | null>, refreshInstalled: () => Promise<void>): CliUpdates {
  const [latest, setLatest] = useState<Record<CliId, string | null>>({ claude: null, codex: null });
  const [checking, setChecking] = useState(false);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const [updating, setUpdating] = useState<Record<CliId, boolean>>({ claude: false, codex: false });
  const [errors, setErrors] = useState<Record<CliId, string | null>>({ claude: null, codex: null });
  const [dismissed, setDismissed] = useState(readDismissed);
  const checkingRef = useRef(false);
  const checkedAtRef = useRef(0);
  const refreshRef = useRef(refreshInstalled);
  refreshRef.current = refreshInstalled;

  const check = useCallback(async (): Promise<void> => {
    if (checkingRef.current || !isTauri()) return;
    checkingRef.current = true;
    setChecking(true);
    try {
      const channel = await invoke<string>("claude_update_channel", { configDir: null }).catch(() => "latest");
      const [claude, codex] = await Promise.all([
        fetchLatestVersion("claude", channel).catch(() => null),
        fetchLatestVersion("codex").catch(() => null),
      ]);
      setLatest(previous => ({ claude: claude ?? previous.claude, codex: codex ?? previous.codex }));
      // La versión instalada también cambia fuera de trex (la app de Claude, npm…).
      await refreshRef.current().catch(() => {});
      checkedAtRef.current = Date.now();
      setCheckedAt(checkedAtRef.current);
    } finally {
      checkingRef.current = false;
      setChecking(false);
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

  const statusOf = (id: CliId): CliStatus => {
    const installed = parseVersion(info[id]?.version);
    const available = isNewer(latest[id], installed);
    return {
      id, name: CLI_NAMES[id], path: info[id]?.path ?? null, installed, latest: latest[id], available,
      dismissed: available && dismissed[id] === latest[id], updating: updating[id], error: errors[id],
    };
  };
  const status = { claude: statusOf("claude"), codex: statusOf("codex") };
  const statusRef = useRef(status);
  statusRef.current = status;

  const update = useCallback(async (id: CliId): Promise<string> => {
    const current = statusRef.current[id];
    if (!current.path) throw new Error(`No se encontró ${CLI_NAMES[id]} en este equipo.`);
    setUpdating(previous => ({ ...previous, [id]: true }));
    setErrors(previous => ({ ...previous, [id]: null }));
    try {
      await invoke<string>("update_cli", { path: current.path });
      await refreshRef.current().catch(() => {});
      const target = current.latest ? ` a la ${current.latest}` : "";
      return `${CLI_NAMES[id]} se actualizó${target}. Las sesiones nuevas ya la usan; las abiertas siguen con la anterior hasta reiniciarlas.`;
    } catch (error) {
      const message = formatError(error);
      setErrors(previous => ({ ...previous, [id]: message }));
      // Un ejecutable en uso no se puede sustituir en Windows.
      const busy = /in use|being used|os error 32|EBUSY|EPERM|acceso denegado|access is denied/i.test(message);
      throw new Error(busy
        ? `No se pudo actualizar ${CLI_NAMES[id]} porque está en uso. Cierra sus sesiones y vuelve a intentarlo.`
        : `No se pudo actualizar ${CLI_NAMES[id]}: ${message.split("\n").slice(-3).join(" ")}`);
    } finally {
      setUpdating(previous => ({ ...previous, [id]: false }));
    }
  }, []);

  const dismiss = useCallback((id: CliId): void => {
    const version = statusRef.current[id].latest;
    if (!version) return;
    setDismissed(previous => {
      const next = { ...previous, [id]: version };
      try { localStorage.setItem(DISMISSED_KEY, JSON.stringify(next)); } catch { /* almacenamiento no disponible */ }
      return next;
    });
  }, []);

  return { status, checking, checkedAt, check, update, dismiss };
}
