/**
 * Conexión de la app móvil con trex: emparejado por HTTP y un WebSocket que se
 * reconecta solo. El token del dispositivo vive en este navegador (localStorage);
 * si el PC lo revoca, se borra y se vuelve a la pantalla de emparejar.
 */
import type { RemoteAction, RemoteDetail, RemoteSession } from "../remoteProtocol";

/** Lo que manda el móvil: los adjuntos van como ids de lo ya subido (el PC los traduce a rutas). */
export type PhoneAction = Exclude<RemoteAction, { kind: "send" }> | { kind: "send"; text: string; attachments: string[] };
export type Uploaded = { id: string; name: string; size: number; image: boolean };

export type RemoteTheme = { mode: "dark" | "light"; colors: Record<string, string> };
export type ConnectionState = "connecting" | "online" | "offline" | "denied";

export type ClientEvents = {
  state: (state: ConnectionState, reason: string | null) => void;
  ready: (info: { host: string; device: { id: string; name: string } }) => void;
  sessions: (sessions: RemoteSession[]) => void;
  detail: (session: string, detail: RemoteDetail) => void;
  theme: (theme: RemoteTheme) => void;
  latency: (ms: number) => void;
};

const TOKEN_KEY = "trex-remote-token";
const DEVICE_KEY = "trex-remote-device";

export const storedToken = (): string | null => { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } };
export const forgetToken = (): void => { try { localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(DEVICE_KEY); } catch { /* sin almacenamiento */ } };

/** Nombre por defecto del dispositivo, a partir del navegador. */
export function defaultDeviceName(): string {
  const agent = navigator.userAgent;
  if (/iPhone/.test(agent)) return "iPhone";
  if (/iPad/.test(agent)) return "iPad";
  const android = /Android[^;]*;\s*([^;)]+?)(?:\sBuild|\))/.exec(agent);
  if (android?.[1] && !/^(K|wv)$/.test(android[1].trim())) return android[1].trim().slice(0, 40);
  if (/Android/.test(agent)) return "Android";
  if (/Windows/.test(agent)) return "PC con Windows";
  if (/Mac OS X/.test(agent)) return "Mac";
  return "Navegador";
}

export async function pairDevice(code: string, name: string): Promise<void> {
  const response = await fetch("/api/pair", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, name }), credentials: "omit", cache: "no-store",
  });
  const body = await response.json().catch(() => ({})) as { token?: string; device?: { id: string; name: string }; error?: string };
  if (!response.ok || !body.token) throw new Error(body.error ?? "No se pudo emparejar. Comprueba la conexión con el PC.");
  localStorage.setItem(TOKEN_KEY, body.token);
  if (body.device) localStorage.setItem(DEVICE_KEY, JSON.stringify(body.device));
}

const authHeaders = (): Record<string, string> => ({ authorization: `Bearer ${storedToken() ?? ""}` });

/** Sube un adjunto al PC (queda en su carpeta de adjuntos) y devuelve su id. */
export function uploadFile(file: Blob, name: string, progress?: (fraction: number) => void, signal?: AbortSignal): Promise<Uploaded> {
  return new Promise((resolve, reject) => {
    // XHR y no fetch: así se ve el progreso de subida, que con fotos grandes por VPN importa.
    const request = new XMLHttpRequest();
    request.open("POST", "/api/upload");
    for (const [key, value] of Object.entries(authHeaders())) request.setRequestHeader(key, value);
    request.setRequestHeader("x-file-name", encodeURIComponent(name || "archivo"));
    request.upload.onprogress = event => { if (event.lengthComputable) progress?.(event.loaded / event.total); };
    request.onload = () => {
      let body: Partial<Uploaded> & { error?: string } = {};
      try { body = JSON.parse(request.responseText); } catch { /* respuesta sin JSON */ }
      if (request.status === 200 && body.id) resolve(body as Uploaded);
      else reject(new Error(body.error ?? (request.status === 413 ? "El archivo pesa más de 100 MB." : "No se pudo subir el archivo al PC.")));
    };
    request.onerror = () => reject(new Error("Se cortó la conexión al subir el archivo."));
    request.onabort = () => reject(new DOMException("Cancelado", "AbortError"));
    signal?.addEventListener("abort", () => request.abort(), { once: true });
    request.send(file);
  });
}

const icons = new Map<string, Promise<string | null>>();

/** Logo del proyecto (el de la barra lateral del PC); null si no tiene. Se pide una vez. */
export function projectIcon(project: string): Promise<string | null> {
  let pending = icons.get(project);
  if (!pending) {
    pending = fetch(`/api/icon?project=${encodeURIComponent(project)}`, { headers: authHeaders(), credentials: "omit", cache: "no-store" })
      .then(response => response.ok ? response.json() as Promise<{ url: string | null }> : { url: null })
      .then(body => typeof body.url === "string" && body.url.startsWith("data:image/") ? body.url : null)
      .catch(() => { icons.delete(project); return null; });
    icons.set(project, pending);
  }
  return pending;
}

export class RemoteClient {
  private socket: WebSocket | null = null;
  private retry = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pingSent = 0;
  private requests = new Map<number, { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private nextRequest = 1;
  private watching: string | null = null;
  private stopped = false;
  state: ConnectionState = "connecting";

  constructor(private events: ClientEvents) {
    document.addEventListener("visibilitychange", () => {
      // Al volver a la app no se espera al siguiente reintento.
      if (!document.hidden && !this.stopped && this.state === "offline") this.connect();
    });
    window.addEventListener("online", () => { if (!this.stopped && this.state === "offline") this.connect(); });
  }

  connect(): void {
    const token = storedToken();
    if (!token) { this.setState("denied", null); return; }
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    this.socket?.close();
    this.setState("connecting", null);
    const socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/ws`);
    this.socket = socket;
    socket.onopen = () => socket.send(JSON.stringify({ type: "hello", token }));
    socket.onmessage = event => { if (this.socket === socket) this.receive(String(event.data)); };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.stopPing();
      this.failRequests("Se perdió la conexión con el PC.");
      if (this.state === "denied" || this.stopped) return;
      this.setState("offline", null);
      const delay = Math.min(15_000, 800 * 2 ** this.retry++);
      this.retryTimer = setTimeout(() => this.connect(), delay);
    };
  }

  stop(): void {
    this.stopped = true;
    this.socket?.close();
    this.stopPing();
  }

  watch(session: string | null): void {
    this.watching = session;
    this.send({ type: "watch", session });
  }

  /** Orden para una sesión; se resuelve cuando el PC la ejecutó (o falla con su motivo). */
  command(session: string, action: PhoneAction): Promise<void> {
    if (!this.socket || this.state !== "online") return Promise.reject(new Error("Sin conexión con el PC."));
    const req = this.nextRequest++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.requests.delete(req); reject(new Error("El PC no respondió a tiempo.")); }, 25_000);
      this.requests.set(req, { resolve, reject, timer });
      this.send({ type: "command", req, session, action });
    });
  }

  private send(value: unknown): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(value));
  }

  private setState(state: ConnectionState, reason: string | null): void {
    this.state = state;
    this.events.state(state, reason);
  }

  private receive(text: string): void {
    let message: Record<string, unknown>;
    try { message = JSON.parse(text); } catch { return; }
    switch (message.type) {
      case "ready":
        this.retry = 0;
        this.setState("online", null);
        this.events.ready(message as never);
        if (this.watching) this.send({ type: "watch", session: this.watching });
        this.startPing();
        break;
      case "denied":
        forgetToken();
        this.setState("denied", typeof message.error === "string" ? message.error : null);
        this.socket?.close();
        break;
      case "sessions": this.events.sessions(Array.isArray(message.sessions) ? message.sessions as RemoteSession[] : []); break;
      case "detail": if (typeof message.session === "string" && message.detail) this.events.detail(message.session, message.detail as RemoteDetail); break;
      case "theme": if (message.theme) this.events.theme(message.theme as RemoteTheme); break;
      case "pong": if (this.pingSent) this.events.latency(Math.round(performance.now() - this.pingSent)); break;
      case "result": {
        const request = this.requests.get(Number(message.req));
        if (!request) break;
        this.requests.delete(Number(message.req));
        clearTimeout(request.timer);
        if (message.ok) request.resolve();
        else request.reject(new Error(typeof message.error === "string" ? message.error : "El PC no pudo hacerlo."));
        break;
      }
    }
  }

  private startPing(): void {
    this.stopPing();
    const ping = () => { this.pingSent = performance.now(); this.send({ type: "ping" }); };
    ping();
    this.pingTimer = setInterval(ping, 15_000);
  }

  private stopPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  private failRequests(reason: string): void {
    for (const request of this.requests.values()) { clearTimeout(request.timer); request.reject(new Error(reason)); }
    this.requests.clear();
  }
}
