import { shortcutLabel } from "../shortcuts";
import { PROVIDER_NAMES } from "../profiles";
import type { LauncherProfile } from "../types";
import AgentIcon from "./AgentIcon";

export default function ProfileMenuItems({ profiles, defaultProfileId, defaultShortcut = "Ctrl+T", onOpen }: {
  profiles: LauncherProfile[]; defaultProfileId?: string; defaultShortcut?: string; onOpen: (id: string) => void;
}) {
  return profiles.map(profile => <button key={profile.id} type="button" role="menuitem" tabIndex={-1}
    className="context-item profile-menu-item" onClick={() => onOpen(profile.id)} aria-label={`Abrir ${profile.name}`}>
    <span className="context-icon" aria-hidden="true"><AgentIcon kind={profile.provider} /></span>
    <span className="profile-menu-text"><span>{profile.name}</span><span>{PROVIDER_NAMES[profile.provider]} · {profile.command}</span></span>
    {profile.id === defaultProfileId && <span className="kbd">{shortcutLabel(defaultShortcut)}</span>}
  </button>);
}
