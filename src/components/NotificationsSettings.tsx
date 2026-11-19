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
          <small>al terminar, pedir atención o fallar</small>
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
          <span>Avisar también con trex en primer plano</span>
        </span>
        <input
          type="checkbox"
          role="switch"
          aria-label="Avisar también con trex en primer plano"
          className="settings-switch"
          checked={settings.notifyWhenFocused}
          onChange={(event) =>
            onChange({ notifyWhenFocused: event.currentTarget.checked })
          }
        />
      </label>
      <div className="settings-notification-actions"><button
        type="button"
        className="btn btn-ghost"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void testDesktopNotification()
            .then(() =>
              setStatus(
                "Aviso enviado.",
              ),
            )
            .catch((error) => setStatus(formatError(error)))
            .finally(() => setBusy(false));
        }}
      >
        {busy ? "Enviando…" : "Enviar aviso de prueba"}
      </button>
      <p role="status" className="settings-note">{status}</p></div>
    </div>
  );
}
