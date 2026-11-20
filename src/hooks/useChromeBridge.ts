import { useEffect } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { browserBridgeStatus } from "../api";
import { setChromeAvailable } from "../browserConnection";

/**
 * Mantiene al día si la función «Tu navegador» está activa, para que los chats lo sepan
 * sin preguntar al abrirse. Se consulta al arrancar y cada vez que el puente avisa de un cambio.
 */
export function useChromeBridge(): void {
  useEffect(() => {
    if (!isTauri()) return;
    let alive = true;
    const refresh = (): void => {
      void browserBridgeStatus().then(status => { if (alive) setChromeAvailable(status.enabled && status.running); })
        .catch(() => { if (alive) setChromeAvailable(false); });
    };
    refresh();
    const stop = listen("browser-bridge://status", refresh);
    return () => { alive = false; void stop.then(unlisten => unlisten()); };
  }, []);
}
