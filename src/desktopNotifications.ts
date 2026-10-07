import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  isPermissionGranted,
  requestPermission,
} from "@tauri-apps/plugin-notification";
import type { AgentNotice, Settings } from "./types";
import { noticeLabel } from "./agentNotices";
export function shouldNotify(
  enabled: boolean,
  whenFocused: boolean,
  focused: boolean,
): boolean {
  return enabled && (whenFocused || !focused);
}
export async function enableDesktopNotifications(): Promise<boolean> {
  return (
    (await isPermissionGranted()) || (await requestPermission()) === "granted"
  );
}
export async function showDesktopNotice(
  notice: AgentNotice,
  settings: Settings,
): Promise<void> {
  if (!settings.desktopNotifications) return;
  const focused = await getCurrentWindow()
    .isFocused()
    .catch(() => document.hasFocus());
  if (
    !shouldNotify(
      settings.desktopNotifications,
      settings.notifyWhenFocused,
      focused,
    ) ||
    !(await isPermissionGranted())
  )
    return;
  await invoke("desktop_notification", {
    title: `TREX · ${noticeLabel(notice.kind)}`,
    body: `${notice.sessionName} · ${notice.projectName}`,
  });
}
export async function testDesktopNotification(): Promise<void> {
  if (!(await enableDesktopNotifications()))
    throw new Error(
      "Las notificaciones están bloqueadas en el sistema. Actívalas para TREX en los ajustes de Windows o Linux.",
    );
  await invoke("desktop_notification", {
    title: "TREX · Notificaciones listas",
    body: "Te avisaremos cuando una tarea termine o necesite tu atención.",
  });
}
