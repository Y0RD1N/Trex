/** Comandos del control remoto para Ajustes (ver `src-tauri/src/remote.rs`). */
import { invoke } from "@tauri-apps/api/core";

export type RemoteInterfaceKind = "wireguard" | "tailscale" | "lan" | "other";
export type RemoteInterface = { name: string; ip: string; kind: RemoteInterfaceKind };
export type RemoteDevice = { id: string; name: string; createdAt: number; lastSeen: number; connected: boolean };
export type RemoteServerStatus = {
  enabled: boolean;
  running: boolean;
  address: string;
  port: number;
  tailscaleServe: boolean;
  error: string | null;
  urls: string[];
  devices: RemoteDevice[];
  interfaces: RemoteInterface[];
  tailscale: { installed: boolean; running: boolean; ip: string | null; dnsName: string | null };
};
export type RemoteServerSettings = { enabled: boolean; address: string; port: number; tailscaleServe: boolean };
export type RemotePairing = { code: string; expiresAt: number; url: string | null; qr: { width: number; modules: string } | null };

export const REMOTE_DEFAULT_PORT = 7340;

export const remoteStatus = (): Promise<RemoteServerStatus> => invoke("remote_status");
export const remoteConfigure = (settings: RemoteServerSettings): Promise<RemoteServerStatus> => invoke("remote_configure", { settings });
export const remotePairingStart = (): Promise<RemotePairing> => invoke("remote_pairing_start");
export const remotePairingCancel = (): Promise<void> => invoke("remote_pairing_cancel");
export const remoteRevoke = (device: string): Promise<void> => invoke("remote_revoke", { device });

export const REMOTE_KIND_LABEL: Record<RemoteInterfaceKind, string> = {
  wireguard: "WireGuard", tailscale: "Tailscale", lan: "Red local", other: "Otra red",
};

/** La red sugerida: la de WireGuard si hay, si no la de Tailscale. Nunca una pública sin elegirla. */
export function suggestedInterface(list: RemoteInterface[]): RemoteInterface | null {
  return list.find(item => item.kind === "wireguard") ?? list.find(item => item.kind === "tailscale") ?? null;
}

/** Puerto válido para el servidor (sin los reservados del sistema). */
export const validRemotePort = (value: number): boolean => Number.isInteger(value) && value >= 1024 && value <= 65535;
