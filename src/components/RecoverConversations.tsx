import { useEffect, useMemo, useRef, useState } from "react";
import { listConversations, canResume, profileAccountDir } from "../conversations";
import { launchForProfile, trexProfileName } from "../profiles";
import { formatError, normalizeText } from "../api";
import type {
  Conversation,
  LauncherProfile,
  Project,
  Settings,
} from "../types";
import FeatureDialog, { type FeatureDialogMotionProps } from "./FeatureDialog";
import AgentIcon from "./AgentIcon";
import Select from "./Select";
import { ArrowRightIcon } from "./Icons";
export default function RecoverConversations({
  project,
  settings,
  onResume,
  onClose,
  ...motion
}: {
  project: Project;
  settings: Settings;
  onResume: (profile: LauncherProfile, conversation: Conversation) => void;
  onClose: () => void;
} & FeatureDialogMotionProps) {
  const [profileId, setProfileId] = useState(settings.defaultProfileId),
    [items, setItems] = useState<Conversation[]>([]),
    [query, setQuery] = useState(""),
    [loading, setLoading] = useState(false),
    [error, setError] = useState(""),
    [revision, setRevision] = useState(0);
  const generation = useRef(0);
  const profile =
    settings.profiles.find((item) => item.id === profileId) ??
    settings.profiles[0];
  const supported = canResume(
    launchForProfile(settings, profile),
    profile.provider,
  );
  useEffect(() => {
    const request = ++generation.current;
    setItems([]);
    setError("");
    if (!supported) {
      setLoading(false);
      setError(
        "Este perfil ya contiene opciones de recuperación o un modo especial. Elige un perfil sin esas opciones.",
      );
      return;
    }
    setLoading(true);
    // Un lanzador como `claude2` guarda sus conversaciones en su propia carpeta.
    void profileAccountDir(profile, settings.shell)
      .then((configDir) => listConversations(profile.provider, configDir, project.path, profile.provider === "trex" ? trexProfileName(profile) : undefined))
      .then((result) => {
        if (generation.current === request) setItems(result);
      })
      .catch((error) => {
        if (generation.current === request) setError(formatError(error));
      })
      .finally(() => {
        if (generation.current === request) setLoading(false);
      });
    return () => {
      generation.current++;
    };
  }, [
    profile.id,
    profile.provider,
    profile.configDir,
    profile.command,
    profile.args,
    profile.shell,
    settings.shell,
    project.path,
    supported,
    revision,
  ]);
  const shown = useMemo(
    () =>
      items.filter((item) =>
        normalizeText(item.title).includes(normalizeText(query)),
      ),
    [items, query],
  );
  return (
    <FeatureDialog
      {...motion}
      title="Recuperar conversación"
      className="recovery-dialog"
      onClose={onClose}
      footer={
        <>
          <span className="feature-hint">
            {project.name} · historial local de este perfil
          </span>
          <button
            className="btn btn-ghost"
            disabled={loading}
            onClick={() => setRevision((value) => value + 1)}
          >
            Actualizar
          </button>
        </>
      }
    >
      <div className="recovery-controls">
        <label>
          Perfil
          <Select
            data-autofocus
            aria-label="Perfil para recuperar conversación"
            value={profile.id}
            onChange={setProfileId}
            options={settings.profiles.map(item => ({ value: item.id, label: item.name, icon: <AgentIcon kind={item.provider} size={16} /> }))}
          />
        </label>
        <label>
          Buscar
          <input
            className="input"
            aria-label="Buscar conversaciones"
            placeholder="Nombre de la conversación…"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
        </label>
      </div>
      <p className="feature-hint">
        Se abre una terminal nueva con el contexto guardado por{" "}
        {profile.provider === "trex" ? "Trex CLI" : profile.provider === "claude" ? "Claude Code" : "Codex"}.
      </p>
      <div className="conversation-results" aria-busy={loading}>
        {loading ? (
          <p className="feature-empty" role="status">
            Buscando conversaciones…
          </p>
        ) : error ? (
          <p className="feature-empty" role="status">
            {error}
          </p>
        ) : shown.length ? (
          shown.map((conversation) => (
            <button
              className="conversation-item"
              key={conversation.id}
              onClick={() => onResume(profile, conversation)}
            >
              <AgentIcon kind={conversation.provider} size={16} />
              <span>
                <strong>{conversation.title}</strong>
                <small>
                  {new Date(conversation.updatedAt).toLocaleString()} ·{" "}
                  {conversation.id.slice(0, 8)}
                </small>
              </span>
              <span className="conversation-open">Continuar <ArrowRightIcon size={16} /></span>
            </button>
          ))
        ) : (
          <p className="feature-empty">
            No hay conversaciones guardadas para este proyecto y perfil
            {query ? " con ese nombre" : ""}.
          </p>
        )}
      </div>
    </FeatureDialog>
  );
}
