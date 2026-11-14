/**
 * Ajustes › Voz: activar el modo llamada, descargar los modelos y comprobar qué oye trex.
 *
 * Nace apagado. Todo se aplica al momento con los comandos de `voice.rs`; no forma
 * parte del borrador de Ajustes porque el motor de voz vive aparte de la configuración.
 */
import { useCallback, useEffect, useId, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { formatError } from "../api";
import {
  cloudVoiceOptions, downloadPercent, heardLabel, levelPercent, megabytes, microphoneOptions, pushHeard, voiceDownloadOffer, voiceListening,
  voiceModeBlocker, voiceSettingsOf, voiceSpeechBlocker, voiceStateLabel, VOICE_PHASE_LABEL,
  type VoiceCloudVoice, type VoiceKeyProvider, type VoiceLevel, type VoiceMicrophone, type VoiceSettingsPatch, type VoiceStatus, type VoiceUtterance,
} from "../voice";
import {
  voiceCloudVoices, voiceConfigure, voiceDownloadModels, voiceKeyClear, voiceKeySet, voiceMicrophones, voiceStatus,
  VOICE_LEVEL_EVENT, VOICE_STATUS_EVENT, VOICE_UTTERANCE_EVENT,
} from "../voiceApi";
import Select from "./Select";
import { formatClock } from "../timeFormat";
import { MicIcon } from "./Icons";
import "./BrowserSettings.css";
import "./Voice.css";

/**
 * Campo de una clave de API. La clave se escribe aquí y se guarda cifrada; después solo
 * se sabe que existe: no se vuelve a mostrar ni sale del equipo salvo hacia su proveedor.
 */
function KeyField({ provider, label, saved, onChanged, onError }: {
  provider: VoiceKeyProvider; label: string; saved: boolean; onChanged: () => Promise<void> | void; onError: (message: string | null) => void;
}) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const run = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true); onError(null);
    try { await action(); setValue(""); await onChanged(); }
    catch (failure) { onError(formatError(failure)); }
    finally { setBusy(false); }
  };
  if (saved) return <div className="voice-key">
    <span className="browser-settings-status is-ready">Clave guardada</span>
    <button type="button" className="btn btn-small btn-ghost" disabled={busy} onClick={() => void run(() => voiceKeyClear(provider))}>Quitar clave</button>
  </div>;
  return <form className="voice-key" onSubmit={event => { event.preventDefault(); if (value.trim()) void run(() => voiceKeySet(provider, value)); }}>
    <input className="input" type="password" autoComplete="off" spellCheck={false} aria-label={label} placeholder={label} value={value}
      onChange={event => setValue(event.currentTarget.value)} />
    <button type="submit" className="btn btn-small btn-primary" disabled={busy || !value.trim()}>Guardar</button>
  </form>;
}

export default function VoiceSettings() {
  const [status, setStatus] = useState<VoiceStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [heard, setHeard] = useState<VoiceUtterance[]>([]);
  const [microphones, setMicrophones] = useState<VoiceMicrophone[]>([]);
  const [level, setLevel] = useState<VoiceLevel | null>(null);
  const [cloudVoices, setCloudVoices] = useState<VoiceCloudVoice[] | null>(null);
  const id = useId();

  const refresh = useCallback(async () => {
    try { setStatus(await voiceStatus()); }
    catch (failure) { setError(formatError(failure)); }
  }, []);

  useEffect(() => {
    void refresh();
    const unlisten = Promise.all([
      listen(VOICE_STATUS_EVENT, () => void refresh()),
      listen<VoiceUtterance>(VOICE_UTTERANCE_EVENT, event => setHeard(list => pushHeard(list, event.payload))),
    ]);
    return () => { void unlisten.then(list => list.forEach(stop => stop())); };
  }, [refresh]);

  // Durante la descarga el avance se consulta cada segundo.
  const downloading = status?.downloading ?? false;
  useEffect(() => {
    if (!downloading) return;
    const timer = window.setInterval(() => void refresh(), 1000);
    return () => window.clearInterval(timer);
  }, [downloading, refresh]);

  const loadMicrophones = useCallback(async () => {
    try { setMicrophones(await voiceMicrophones()); }
    catch (failure) { setError(formatError(failure)); }
  }, []);
  useEffect(() => { void loadMicrophones(); }, [loadMicrophones]);

  // El medidor solo se alimenta mientras esta sección está abierta.
  useEffect(() => {
    const unlisten = listen<VoiceLevel>(VOICE_LEVEL_EVENT, event => setLevel(event.payload));
    return () => { void unlisten.then(stop => stop()); };
  }, []);

  const apply = async (patch: Partial<VoiceSettingsPatch>): Promise<void> => {
    if (!status) return;
    setBusy(true); setError(null); setLevel(null);
    try { setStatus(await voiceConfigure({ ...voiceSettingsOf(status), ...patch })); }
    catch (failure) { setError(formatError(failure)); }
    finally { setBusy(false); }
  };

  const loadCloudVoices = async (): Promise<void> => {
    setError(null);
    try { setCloudVoices(await voiceCloudVoices()); }
    catch (failure) { setError(formatError(failure)); }
  };

  const download = async (): Promise<void> => {
    if (!status) return;
    setError(null);
    setStatus({ ...status, downloading: true, downloadedBytes: 0 });
    try { setStatus(await voiceDownloadModels()); }
    catch (failure) { setError(formatError(failure)); await refresh(); }
  };

  if (!status) return <div className="browser-settings"><div className="browser-settings-card"><p className="settings-hint">{error ?? "Comprobando la voz…"}</p></div></div>;

  const listening = voiceListening(status);
  const percent = downloadPercent(status);
  const offer = voiceDownloadOffer(status);
  const liveBlocker = voiceModeBlocker(status);
  const speechBlocker = voiceSpeechBlocker(status);

  return <div className="browser-settings voice-settings">
    <div className="browser-settings-card">
      <div className="browser-settings-heading">
        <span className="browser-settings-badge" aria-hidden="true"><MicIcon size={20} /></span>
        <div><h4>Modo llamada</h4><p>Háblale a trex en voz alta. Empieza la frase con «oye trex» o «hola trex».</p></div>
        <span className={`browser-settings-status${listening ? " is-ready" : ""}`} role="status">{voiceStateLabel(status)}</span>
      </div>
      {!status.supported
        ? <p className="browser-settings-note">Por ahora el modo llamada solo funciona en Windows.</p>
        : <label className="browser-settings-toggle"><span><strong>Escuchar el micrófono</strong>
          <small>El audio se transcribe en este equipo y no sale de él. Solo se atienden las frases que llaman a trex; lo demás se descarta al momento.</small></span>
          <input type="checkbox" role="switch" aria-label="Escuchar el micrófono" checked={status.enabled} disabled={busy}
            onChange={event => void apply({ enabled: event.currentTarget.checked })} /></label>}
      {status.error && status.enabled && <p className="browser-settings-error" role="alert">{status.error}</p>}
    </div>

    {status.supported && <div className="browser-settings-card">
      <div className="browser-settings-heading"><div><h4>Modelos de voz</h4><p>{offer === "none"
        ? "Instalados en este equipo."
        : offer === "speech"
          ? `Falta la voz de trex (${megabytes(status.totalBytes)}). Sin ella responde con la voz de Windows.`
          : `No vienen con trex. Se descargan una vez (${megabytes(status.totalBytes)}) y se verifican antes de instalarse.`}</p></div>
        {offer !== "none" && !status.downloading && <button type="button" className="btn btn-small btn-primary" onClick={() => void download()}>{offer === "speech" ? "Descargar la voz" : "Descargar modelos"}</button>}
        {offer === "none" && <span className="browser-settings-status is-ready">Listos</span>}
      </div>
      {status.downloading && <div className="voice-progress" role="progressbar" aria-label="Descarga de los modelos de voz" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
        <div className="voice-progress-track"><div className="voice-progress-fill" style={{ width: `${percent}%` }} /></div>
        <span>{megabytes(status.downloadedBytes)} de {megabytes(status.totalBytes)}</span>
      </div>}
    </div>}

    {status.supported && <div className="browser-settings-card">
      <div className="browser-settings-heading"><div><h4>Micrófono</h4><p>Elige con cuál te escucha trex.</p></div>
        <button type="button" className="btn btn-small" onClick={() => void loadMicrophones()}>Volver a buscar</button></div>
      <Select value={status.device} options={microphoneOptions(microphones, status.device)} disabled={busy} aria-label="Micrófono"
        onChange={device => void apply({ device })} />
      {listening && <div className={`voice-level${level?.voice ? " is-voice" : ""}`} role="meter" aria-label="Nivel del micrófono" aria-valuemin={0} aria-valuemax={100} aria-valuenow={levelPercent(level?.peak ?? 0)}>
        <div className="voice-level-track"><div className="voice-level-fill" style={{ width: `${levelPercent(level?.peak ?? 0)}%` }} /></div>
        <span>{level?.deaf ? "trex está hablando" : level?.voice ? "Te oye" : level ? "Sin voz" : "Esperando al micrófono…"}</span>
      </div>}
      <label className="browser-settings-toggle"><span><strong>Captar el sonido sin filtros del sistema</strong>
        <small>Algunos portátiles silencian el micrófono entre frases y cortan el principio de lo que dices. Déjalo activado salvo que trex oiga demasiado ruido.</small></span>
        <input type="checkbox" role="switch" aria-label="Captar el sonido sin filtros del sistema" checked={status.rawCapture} disabled={busy}
          onChange={event => void apply({ rawCapture: event.currentTarget.checked })} /></label>
    </div>}

    {status.supported && <div className="browser-settings-card">
      <div className="browser-settings-heading"><div><h4>Conversación</h4><p>Quién escucha y responde después de «oye trex».</p></div></div>
      <div className="voice-choice" role="radiogroup" aria-label="Modo de conversación">
        <label className={status.mode === "local" ? "is-selected" : ""}>
          <input type="radio" name={`${id}-mode`} checked={status.mode === "local"} disabled={busy} onChange={() => void apply({ mode: "local" })} />
          <span><strong>Local</strong><small>Todo se entiende en este equipo y Claude decide qué hacer. Sin costo; tarda unos segundos en responder.</small></span>
        </label>
        <label className={status.mode === "live" ? "is-selected" : ""}>
          <input type="radio" name={`${id}-mode`} checked={status.mode === "live"} disabled={busy} onChange={() => void apply({ mode: "live" })} />
          <span><strong>Tiempo real (Gemini Live)</strong><small>Conversación fluida y puedes interrumpirle. De pago, con tu clave de Google: mientras dura la llamada tu voz se envía a Google.</small></span>
        </label>
      </div>
      {status.mode === "live" && <>
        <KeyField provider="gemini" label="Clave de API de Gemini" saved={status.hasGeminiKey} onChanged={refresh} onError={setError} />
        <label className="browser-settings-field">Voz de Gemini
          <Select value={status.liveVoice} options={status.liveVoices.map(voice => ({ value: voice, label: voice }))} disabled={busy} aria-label="Voz de Gemini"
            onChange={liveVoice => void apply({ liveVoice })} /></label>
        <label className="browser-settings-toggle"><span><strong>Puedo interrumpirle</strong>
          <small>Úsalo con auriculares. Con altavoces el micrófono oye a trex y se interrumpe solo; apagado, trex no te escucha mientras habla.</small></span>
          <input type="checkbox" role="switch" aria-label="Puedo interrumpirle" checked={status.bargeIn} disabled={busy}
            onChange={event => void apply({ bargeIn: event.currentTarget.checked })} /></label>
        {liveBlocker && <p className="browser-settings-note">{liveBlocker}</p>}
        <p className="settings-hint">La llamada se abre al decir «oye trex» y se cierra sola tras 30 segundos de silencio, al despedirte o con «Colgar».</p>
      </>}
    </div>}

    {status.supported && status.mode === "local" && <div className="browser-settings-card">
      <div className="browser-settings-heading"><div><h4>Voz de las respuestas</h4><p>Con qué voz habla trex en el modo local.</p></div></div>
      <div className="voice-choice" role="radiogroup" aria-label="Voz de las respuestas">
        <label className={status.speech === "local" ? "is-selected" : ""}>
          <input type="radio" name={`${id}-speech`} checked={status.speech === "local"} disabled={busy} onChange={() => void apply({ speech: "local" })} />
          <span><strong>Local</strong><small>La voz se genera en este equipo. Sin costo y sin conexión.</small></span>
        </label>
        <label className={status.speech === "elevenlabs" ? "is-selected" : ""}>
          <input type="radio" name={`${id}-speech`} checked={status.speech === "elevenlabs"} disabled={busy} onChange={() => void apply({ speech: "elevenlabs" })} />
          <span><strong>ElevenLabs</strong><small>Voz de nube, de pago con tu clave. A ElevenLabs solo se envía el texto que trex va a decir.</small></span>
        </label>
      </div>
      {status.speech === "elevenlabs" && <>
        <KeyField provider="elevenlabs" label="Clave de API de ElevenLabs" saved={status.hasCloudKey} onChanged={async () => { setCloudVoices(null); await refresh(); }} onError={setError} />
        {status.hasCloudKey && <div className="browser-settings-heading">
          <div><p>{cloudVoices === null ? "Carga las voces de tu cuenta para elegir una." : cloudVoices.length ? `${cloudVoices.length} voces en tu cuenta` : "Tu cuenta no tiene voces disponibles."}</p></div>
          <button type="button" className="btn btn-small" onClick={() => void loadCloudVoices()}>{cloudVoices === null ? "Cargar voces" : "Volver a cargar"}</button>
        </div>}
        {status.hasCloudKey && (cloudVoices?.length || status.cloudVoice) && <Select value={status.cloudVoice} placeholder="Elegir voz…" disabled={busy} aria-label="Voz de ElevenLabs"
          options={cloudVoiceOptions(cloudVoices ?? [], status.cloudVoice)} onChange={cloudVoice => void apply({ cloudVoice })} />}
        {speechBlocker && <p className="browser-settings-note">{speechBlocker}</p>}
      </>}
    </div>}

    {status.supported && status.enabled && <div className="browser-settings-card">
      <div className="browser-settings-heading"><div><h4>Lo último que oyó</h4><p>{listening ? VOICE_PHASE_LABEL[status.phase] : "Cuando esté escuchando, aquí verás lo que entendió."}</p></div></div>
      {heard.length > 0
        ? <ul className="voice-heard">
          {heard.map(utterance => <li key={utterance.at}>
            <time>{formatClock(utterance.at)}</time>
            <span>{heardLabel(utterance)}</span>
            <small>{utterance.text}</small>
          </li>)}
        </ul>
        : listening && <p className="settings-hint">Di «oye trex, ¿me oyes?» para probarlo.</p>}
    </div>}
    {error && <p className="browser-settings-error" role="alert">{error}</p>}
  </div>;
}
