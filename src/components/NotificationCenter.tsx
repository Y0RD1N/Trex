import { useRef, useState } from "react";
import type { AgentNotice } from "../types";
import type { FloatingAnchor } from "../hooks/useFloatingPosition";
import { noticeLabel } from "../agentNotices";
import { AlertIcon, BellIcon, CheckIcon, SoundIcon, TrashIcon } from "./Icons";
import AgentIcon from "./AgentIcon";
import DropdownMenu from "./DropdownMenu";
import "./NotificationCenter.css";

type Props = {
  notices: AgentNotice[];
  soundEnabled: boolean;
  liveTabIds: Set<string>;
  onOpenSession: (notice: AgentNotice) => void;
  onMarkRead: () => void;
  onClear: () => void;
  onToggleSound: () => void;
  onPreviewSound: () => void;
};

export default function NotificationCenter({ notices, soundEnabled, liveTabIds, onOpenSession,
  onMarkRead, onClear, onToggleSound, onPreviewSound }: Props) {
  const [anchor, setAnchor] = useState<FloatingAnchor | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const unread = notices.filter(notice => !notice.read).length;
  const latest = notices[0];
  return <>
    <button ref={triggerRef} type="button" className={`window-btn notification-bell tip tip-below${unread ? " has-unread" : ""}`}
      data-tip={`Notificaciones${unread ? ` (${unread} sin leer)` : ""}`} aria-label={`Notificaciones${unread ? `, ${unread} sin leer` : ""}`}
      aria-expanded={anchor !== null} aria-haspopup="menu"
      onClick={event => setAnchor(anchor ? null : { element: event.currentTarget })}
      onKeyDown={event => { if (event.key === "ArrowDown") { event.preventDefault(); setAnchor({ element: event.currentTarget }); } }}>
      <span key={latest?.id ?? "empty"} className={latest && !latest.read ? "notification-bell-motion" : undefined}><BellIcon /></span>
      {unread > 0 && <span className="notification-count" aria-hidden="true">{unread > 9 ? "9+" : unread}</span>}
    </button>
    <DropdownMenu anchor={anchor} triggerRef={triggerRef} label="Notificaciones" className="notification-menu" onClose={() => setAnchor(null)}>
      <div className="notification-heading"><div className="notification-heading-copy"><strong>Notificaciones</strong><span>{unread ? `${unread} sin leer` : "Estás al día"}</span></div>
        {unread > 0 && <button type="button" role="menuitem" tabIndex={-1} className="notification-text-action" onClick={onMarkRead}><CheckIcon size={14} />Marcar leídas</button>}
      </div>
      {notices.length === 0 ? <div className="notification-empty"><BellIcon size={25} />
        <span>Todo al día</span><p>Te avisaremos cuando un agente termine o necesite tu respuesta.</p></div>
        : <div className="notification-list">{notices.map(notice => <button key={notice.id} type="button" role="menuitem" tabIndex={-1}
          className={`notification-item${notice.read ? "" : " unread"}`} data-kind={notice.kind} onClick={() => { setAnchor(null); onOpenSession(notice); }}>
          <span className={`notification-symbol ${notice.kind}`} aria-hidden="true">{notice.kind === "ready" ? <CheckIcon size={16} /> : <AlertIcon size={16} />}</span>
          <span className="notification-copy"><span className="notification-item-heading"><span className="notification-item-title">{noticeLabel(notice.kind)}</span>
          <time className="notification-time" dateTime={new Date(notice.createdAt).toISOString()}>
            {new Date(notice.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time></span>
            <span className="notification-session" title={notice.sessionName}>{notice.sessionName}</span>
            <span className="notification-project"><AgentIcon kind={notice.provider} size={12} /><span>{notice.projectName}</span>{!liveTabIds.has(notice.tabId) && <span className="notification-closed">Cerrada</span>}{!notice.read && <span className="notification-unread-dot" aria-label="Sin leer" />}</span>
          </span>
        </button>)}</div>}
      <div className="notification-footer">
        <button type="button" role="menuitemcheckbox" tabIndex={-1} className="notification-sound" aria-checked={soundEnabled} onClick={onToggleSound}>
          <SoundIcon muted={!soundEnabled} />Sonido {soundEnabled ? "activado" : "silenciado"}<span className="notification-sound-toggle" aria-hidden="true" /></button>
        {soundEnabled && <button type="button" role="menuitem" tabIndex={-1} className="notification-text-action" onClick={onPreviewSound}>Probar sonido</button>}
        {notices.length > 0 && <button type="button" role="menuitem" tabIndex={-1} className="notification-text-action notification-clear" onClick={onClear}><TrashIcon size={14} />Limpiar</button>}
      </div>
    </DropdownMenu>
    <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
      {latest ? `${latest.sessionName}: ${noticeLabel(latest.kind)}. Proyecto ${latest.projectName}.` : ""}
    </span>
  </>;
}
