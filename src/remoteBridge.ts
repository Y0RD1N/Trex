/**
 * Puente del control remoto en el escritorio.
 *
 * Cada chat abierto se apunta aquí (ver `useRemoteSession`). Mientras no haya ningún
 * móvil conectado no se calcula ni se manda nada: el backend avisa con
 * `remote://active` y, solo entonces, se publica la lista de sesiones (y el detalle de
 * las que algún móvil está mirando, `remote://watch`) con un pequeño retardo para
 * agrupar cambios. Las órdenes del móvil (`remote://command`) las ejecuta el propio
 * chat por el mismo camino que el teclado, y el resultado vuelve al backend.
 */
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef } from "react";
import { buildBrowserTheme } from "./browserTheme";
import { parseRemoteCommand, type RemoteAction, type RemoteDetail, type RemoteSession } from "./remoteProtocol";
import { formatError } from "./api";

export type RemoteEntry = {
  summary: () => RemoteSession;
  detail: () => RemoteDetail;
  /** Ejecuta una orden del móvil; un error se le muestra tal cual. */
  run: (action: RemoteAction) => Promise<void>;
};

const PUBLISH_MS = 250;

class RemoteBridge {
  private entries = new Map<string, RemoteEntry>();
  private active = false;
  private watching = new Set<string>();
  private dirtyList = false;
  private dirtyDetails = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private themeObserver: MutationObserver | null = null;
  private themeTimer: ReturnType<typeof setTimeout> | null = null;
  /** Orden de los proyectos en la barra lateral: el móvil los agrupa igual. */
  private projectOrder = new Map<string, number>();

  start(): void {
    if (this.started || !isTauri()) return;
    this.started = true;
    void listen<{ active: boolean }>("remote://active", event => this.setActive(!!event.payload?.active)).catch(() => undefined);
    void listen<{ ids: string[] }>("remote://watch", event => this.setWatching(event.payload?.ids ?? [])).catch(() => undefined);
    void listen<unknown>("remote://command", event => { void this.execute(event.payload); }).catch(() => undefined);
    // Si la ventana se recarga con un móvil ya conectado, se retoma el estado.
    void invoke<{ active: boolean; watching: string[] }>("remote_bridge_state").then(state => {
      this.setWatching(state.watching);
      this.setActive(state.active);
    }).catch(() => undefined);
  }

  register(id: string, entry: RemoteEntry): () => void {
    this.entries.set(id, entry);
    this.changed(id);
    return () => {
      if (this.entries.get(id) !== entry) return;
      this.entries.delete(id);
      this.dirtyList = true;
      this.schedule();
    };
  }

  setProjectOrder(ids: string[]): void {
    const next = new Map(ids.map((id, index) => [id, index]));
    if (next.size === this.projectOrder.size && [...next].every(([id, index]) => this.projectOrder.get(id) === index)) return;
    this.projectOrder = next;
    if (!this.active) return;
    this.dirtyList = true;
    this.schedule();
  }

  /** Algo visible cambió en una sesión. Sin móviles conectados no hace nada. */
  changed(id: string): void {
    if (!this.active) return;
    this.dirtyList = true;
    if (this.watching.has(id)) this.dirtyDetails.add(id);
    this.schedule();
  }

  private setActive(active: boolean): void {
    if (active === this.active) return;
    this.active = active;
    if (!active) {
      this.themeObserver?.disconnect();
      this.themeObserver = null;
      return;
    }
    this.dirtyList = true;
    for (const id of this.watching) this.dirtyDetails.add(id);
    this.publishTheme();
    if (typeof MutationObserver !== "undefined") {
      // Tono, acento y modo siguen a la app mientras haya un móvil mirando.
      this.themeObserver = new MutationObserver(() => {
        if (this.themeTimer) clearTimeout(this.themeTimer);
        this.themeTimer = setTimeout(() => this.publishTheme(), 600);
      });
      this.themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["style", "data-theme", "class"] });
    }
    this.schedule();
  }

  private setWatching(ids: string[]): void {
    const next = new Set(ids);
    for (const id of next) if (!this.watching.has(id)) this.dirtyDetails.add(id);
    this.watching = next;
    if (this.active) this.schedule();
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.flush(); }, PUBLISH_MS);
  }

  private flush(): void {
    if (!this.active) { this.dirtyList = false; this.dirtyDetails.clear(); return; }
    if (this.dirtyList) {
      this.dirtyList = false;
      const sessions: RemoteSession[] = [];
      for (const entry of this.entries.values()) {
        try {
          const summary = entry.summary();
          sessions.push({ ...summary, project: { ...summary.project, order: this.projectOrder.get(summary.project.id) ?? Number.MAX_SAFE_INTEGER } });
        } catch { /* una sesión rota no deja sin lista a las demás */ }
      }
      void invoke("remote_publish", { sessions }).catch(() => undefined);
    }
    for (const id of this.dirtyDetails) {
      const entry = this.entries.get(id);
      if (!entry || !this.watching.has(id)) continue;
      try { void invoke("remote_publish_detail", { id, detail: entry.detail() }).catch(() => undefined); } catch { /* idem */ }
    }
    this.dirtyDetails.clear();
  }

  private publishTheme(): void {
    const root = document.documentElement;
    const styles = getComputedStyle(root);
    const theme = buildBrowserTheme(root.dataset.theme ?? "dark", token => styles.getPropertyValue(token));
    if (theme) void invoke("remote_publish_theme", { theme }).catch(() => undefined);
  }

  // --- Acceso directo desde el escritorio (modo llamada), sin pasar por un móvil ---

  /** Resumen de todas las sesiones abiertas ahora mismo. */
  sessions(): RemoteSession[] {
    const list: RemoteSession[] = [];
    for (const entry of this.entries.values()) {
      try { list.push(entry.summary()); } catch { /* una sesión rota no deja sin lista a las demás */ }
    }
    return list;
  }

  detailOf(id: string): RemoteDetail | null {
    try { return this.entries.get(id)?.detail() ?? null; } catch { return null; }
  }

  has(id: string): boolean { return this.entries.has(id); }

  /** Ejecuta una orden en una sesión por el mismo camino que el móvil. */
  async run(id: string, action: RemoteAction): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) throw new Error("Esa sesión ya no está abierta.");
    await entry.run(action);
  }

  private async execute(payload: unknown): Promise<void> {
    const command = parseRemoteCommand(payload);
    if (!command) return;
    const entry = this.entries.get(command.session);
    let ok = false;
    let error: string | null = null;
    if (!entry) error = "Esa sesión ya no está abierta en el PC.";
    else {
      try { await entry.run(command.action); ok = true; }
      catch (failure) { error = formatError(failure); }
    }
    await invoke("remote_command_result", { command: command.command, ok, error }).catch(() => undefined);
  }
}

export const remoteBridge = new RemoteBridge();

/**
 * Apunta un chat al puente. `entry` puede cambiar en cada render: se lee siempre la
 * última versión. `version` es cualquier valor que cambie cuando cambia lo visible.
 */
export function useRemoteSession(id: string, entry: RemoteEntry, version: unknown[]): void {
  const latest = useRef(entry);
  latest.current = entry;
  useEffect(() => {
    remoteBridge.start();
    return remoteBridge.register(id, {
      summary: () => latest.current.summary(),
      detail: () => latest.current.detail(),
      run: action => latest.current.run(action),
    });
  }, [id]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { remoteBridge.changed(id); }, [id, ...version]);
}
