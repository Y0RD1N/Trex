import { useState } from "react";
import type { Settings } from "../types";
import { testDesktopNotification } from "../desktopNotifications";
import { formatError } from "../api";
export default function NotificationsSettings({
  settings,
  onChange,
}: {
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
}) {
  const [status, setStatus] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <div className="settings-toggles">
      <label className="settings-toggle">
        <span className="setting-field-info">
          <span>Notificaciones del escritorio</span>
          <span>
            Avisa cuando Claude o Codex termine una tarea, pida atención o
            encuentre un error.
          </span>
        </span>
        <input
          type="checkbox"
          role="switch"
          aria-label="Notificaciones del escritorio"
          className="settings-switch"
          checked={settings.desktopNotifications}
          onChange={(event) =>
            onChange({ desktopNotifications: event.currentTarget.checked })
          }
        />
      </label>
      <label className="settings-toggle">
        <span className="setting-field-info">
          <span>Avisar también mientras uso TREX</span>
          <span>
            Si lo desactivas, los avisos del escritorio aparecen cuando trabajas
            en otra ventana. El historial interno sigue disponible.
          </span>
        </span>
        <input
          type="checkbox"
          role="switch"
          aria-label="Avisar también mientras uso TREX"
          className="settings-switch"
          checked={settings.notifyWhenFocused}
          onChange={(event) =>
            onChange({ notifyWhenFocused: event.currentTarget.checked })
          }
        />
      </label>
      <button
        type="button"
        className="btn btn-ghost"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void testDesktopNotification()
            .then(() =>
              setStatus(
                "Aviso enviado. Revisa el centro de notificaciones del sistema.",
              ),
            )
            .catch((error) => setStatus(formatError(error)))
            .finally(() => setBusy(false));
        }}
      >
        {busy ? "Enviando…" : "Probar y habilitar notificaciones"}
      </button>
      <p role="status" className="settings-note">
        {status ||
          "Windows requiere la app instalada. En Linux se usa el servicio de notificaciones del escritorio."}
      </p>
    </div>
  );
}
