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
  voiceModeBlocker, voiceSettingsOf, voiceSpeechBlocker, voiceStateLabel, ORB_POSITION_OPTIONS, ORB_SIZE_OPTIONS, VOICE_PHASE_LABEL,
  type VoiceCloudVoice, type VoiceKeyProvider, type VoiceLevel, type VoiceMicrophone, type VoiceOrbPosition, type VoiceOrbSize, type VoiceSettingsPatch,
  type VoiceStatus, type VoiceUtterance,
} from "../voice";
import {
  voiceCloudVoices, voiceConfigure, voiceDownloadDictation, voiceDownloadModels, voiceKeyClear, voiceKeySet, voiceMicrophones, voiceOrbTest, voiceStatus,
  VOICE_LEVEL_EVENT, VOICE_STATUS_EVENT, VOICE_UTTERANCE_EVENT,
} from "../voiceApi";
import Select from "./Select";
import { formatClock } from "../timeFormat";
import { MicIcon } from "./Icons";
import "./BrowserSettings.css";
import "./Voice.css";
import SettingInfo from "./SettingInfo";

/** Lo que dura la prueba de la esfera (escucha, piensa, habla y se despide), con margen. */
const ORB_TEST_MS = 10_000;

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
  const [orbTesting, setOrbTesting] = useState(false);
  const id = useId();

  // Mientras dura la prueba, el botón no la vuelve a lanzar.
  useEffect(() => {
    if (!orbTesting) return;
    const timer = window.setTimeout(() => setOrbTesting(false), ORB_TEST_MS);
    return () => window.clearTimeout(timer);
  }, [orbTesting]);

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

  const downloadDictation = async (): Promise<void> => {
    if (!status) return;
    setError(null);
    setStatus({ ...status, downloading: true, downloadedBytes: 0, totalBytes: status.dictationBytes });
    try { setStatus(await voiceDownloadDictation()); }
    catch (failure) { setError(formatError(failure)); await refresh(); }
  };

  const testOrb = async (): Promise<void> => {
    setError(null);
    setOrbTesting(true);
    try { await voiceOrbTest(); }
    catch (failure) { setError(formatError(failure)); setOrbTesting(false); }
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
        <div><h4>Modo llamada<SettingInfo text="Háblale a trex en voz alta empezando con «oye trex» o «hola trex». El audio se transcribe en este equipo; lo que no llama a trex se descarta al momento." /></h4></div>
        <span className={`browser-settings-status${listening ? " is-ready" : ""}`} role="status">{voiceStateLabel(status)}</span>
      </div>
      {!status.supported
        ? <p className="browser-settings-note">Por ahora, solo en Windows.</p>
        : <label className="browser-settings-toggle"><span><strong>Escuchar «oye trex»</strong></span>
          <input type="checkbox" role="switch" aria-label="Escuchar el micrófono" checked={status.enabled} disabled={busy}
            onChange={event => void apply({ enabled: event.currentTarget.checked })} /></label>}
      {status.error && status.enabled && <p className="browser-settings-error" role="alert">{status.error}</p>}
    </div>

    {status.supported && <div className="browser-settings-card">
      <div className="browser-settings-heading"><div><h4>Modelos de voz</h4>{offer !== "none" && <p>{offer === "speech"
        ? `Falta la voz de trex · ${megabytes(status.totalBytes)}`
        : `Se descargan una vez · ${megabytes(status.totalBytes)}`}</p>}</div>
        {offer !== "none" && !status.downloading && <button type="button" className="btn btn-small btn-primary" onClick={() => void download()}>"Descargar"</button>}
        {offer === "none" && <span className="browser-settings-status is-ready">Listos</span>}
      </div>
      {status.downloading && <div className="voice-progress" role="progressbar" aria-label="Descarga de los modelos de voz" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
        <div className="voice-progress-track"><div className="voice-progress-fill" style={{ width: `${percent}%` }} /></div>
        <span>{megabytes(status.downloadedBytes)} de {megabytes(status.totalBytes)}</span>
      </div>}
    </div>}

    {status.supported && <div className="browser-settings-card">
      <div className="browser-settings-heading"><div><h4>Micrófono</h4></div>
        <button type="button" className="btn btn-small" onClick={() => void loadMicrophones()}>Buscar</button></div>
      <Select value={status.device} options={microphoneOptions(microphones, status.device)} disabled={busy} aria-label="Micrófono"
        onChange={device => void apply({ device })} />
      {listening && <div className={`voice-level${level?.voice ? " is-voice" : ""}`} role="meter" aria-label="Nivel del micrófono" aria-valuemin={0} aria-valuemax={100} aria-valuenow={levelPercent(level?.peak ?? 0)}>
        <div className="voice-level-track"><div className="voice-level-fill" style={{ width: `${levelPercent(level?.peak ?? 0)}%` }} /></div>
        <span>{level?.deaf ? "trex está hablando" : level?.voice ? "Te oye" : level ? "Sin voz" : "Esperando al micrófono…"}</span>
      </div>}
      <label className="browser-settings-toggle"><span><strong>Sin filtros del sistema <SettingInfo text="Algunos portátiles silencian el micrófono entre frases y cortan el principio de lo que dices. Déjalo activado salvo que trex oiga demasiado ruido." /></strong></span>
        <input type="checkbox" role="switch" aria-label="Captar el sonido sin filtros del sistema" checked={status.rawCapture} disabled={busy}
          onChange={event => void apply({ rawCapture: event.currentTarget.checked })} /></label>
    </div>}

    {status.supported && <div className="browser-settings-card">
      <div className="browser-settings-heading"><div><h4>Conversación</h4></div></div>
      <div className="voice-choice" role="radiogroup" aria-label="Modo de conversación">
        <label className={status.mode === "local" ? "is-selected" : ""}>
          <input type="radio" name={`${id}-mode`} checked={status.mode === "local"} disabled={busy} onChange={() => void apply({ mode: "local" })} />
          <span><strong>Local</strong><small>gratis · tarda unos segundos</small></span>
        </label>
        <label className={status.mode === "live" ? "is-selected" : ""}>
          <input type="radio" name={`${id}-mode`} checked={status.mode === "live"} disabled={busy} onChange={() => void apply({ mode: "live" })} />
          <span><strong>Tiempo real</strong><small>Gemini Live · de pago · fluido</small></span>
        </label>
      </div>
      {status.mode === "live" && <>
        <KeyField provider="gemini" label="Clave de API de Gemini" saved={status.hasGeminiKey} onChanged={refresh} onError={setError} />
        <label className="browser-settings-field">Voz de Gemini
          <Select value={status.liveVoice} options={status.liveVoices.map(voice => ({ value: voice, label: voice }))} disabled={busy} aria-label="Voz de Gemini"
            onChange={liveVoice => void apply({ liveVoice })} /></label>
        <label className="browser-settings-toggle"><span><strong>Puedo interrumpirle</strong><small>con auriculares</small></span>
          <input type="checkbox" role="switch" aria-label="Puedo interrumpirle" checked={status.bargeIn} disabled={busy}
            onChange={event => void apply({ bargeIn: event.currentTarget.checked })} /></label>
        {liveBlocker && <p className="browser-settings-note">{liveBlocker}</p>}
        <p className="browser-settings-note">Tu voz se envía a Google durante la llamada, que se cierra sola tras 30 s de silencio.</p>
      </>}
    </div>}

    {status.supported && status.mode === "local" && <div className="browser-settings-card">
      <div className="browser-settings-heading"><div><h4>Voz de las respuestas</h4></div></div>
      <div className="voice-choice" role="radiogroup" aria-label="Voz de las respuestas">
        <label className={status.speech === "local" ? "is-selected" : ""}>
          <input type="radio" name={`${id}-speech`} checked={status.speech === "local"} disabled={busy} onChange={() => void apply({ speech: "local" })} />
          <span><strong>Local</strong><small>gratis · sin conexión</small></span>
        </label>
        <label className={status.speech === "elevenlabs" ? "is-selected" : ""}>
          <input type="radio" name={`${id}-speech`} checked={status.speech === "elevenlabs"} disabled={busy} onChange={() => void apply({ speech: "elevenlabs" })} />
          <span><strong>ElevenLabs</strong><small>de pago · solo se envía el texto</small></span>
        </label>
      </div>
      {status.speech === "elevenlabs" && <>
        <KeyField provider="elevenlabs" label="Clave de API de ElevenLabs" saved={status.hasCloudKey} onChanged={async () => { setCloudVoices(null); await refresh(); }} onError={setError} />
        {status.hasCloudKey && <div className="browser-settings-heading">
          <div><p>{cloudVoices === null ? "" : cloudVoices.length ? `${cloudVoices.length} voces` : "Tu cuenta no tiene voces."}</p></div>
          <button type="button" className="btn btn-small" onClick={() => void loadCloudVoices()}>{cloudVoices === null ? "Cargar voces" : "Recargar"}</button>
        </div>}
        {status.hasCloudKey && (cloudVoices?.length || status.cloudVoice) && <Select value={status.cloudVoice} placeholder="Elegir voz…" disabled={busy} aria-label="Voz de ElevenLabs"
          options={cloudVoiceOptions(cloudVoices ?? [], status.cloudVoice)} onChange={cloudVoice => void apply({ cloudVoice })} />}
        {speechBlocker && <p className="browser-settings-note">{speechBlocker}</p>}
      </>}
    </div>}

    {status.supported && <div className="browser-settings-card">
      <div className="browser-settings-heading"><div><h4>Esfera<SettingInfo text="Al decir «oye trex» aparece una esfera que te escucha, piensa y te habla, y se va cuando acaba la conversación. Flota encima de todo, pero deja pasar los clics y no te quita el teclado. Desactivada no gasta nada." /></h4></div>
        <button type="button" className="btn btn-small" disabled={!status.orb || orbTesting} onClick={() => void testOrb()}>Probar</button></div>
      <label className="browser-settings-toggle"><span><strong>Mostrar la esfera al llamar a trex</strong></span>
        <input type="checkbox" role="switch" aria-label="Mostrar la esfera al llamar a trex" checked={status.orb} disabled={busy}
          onChange={event => void apply({ orb: event.currentTarget.checked })} /></label>
      {status.orb && <>
        <label className="browser-settings-toggle"><span><strong>Sonidos de activación y cierre</strong></span>
          <input type="checkbox" role="switch" aria-label="Sonidos de activación y cierre" checked={status.orbSounds} disabled={busy}
            onChange={event => void apply({ orbSounds: event.currentTarget.checked })} /></label>
        <label className="browser-settings-field">Posición
          <Select value={status.orbPosition} options={ORB_POSITION_OPTIONS} disabled={busy} aria-label="Posición de la esfera"
            onChange={orbPosition => void apply({ orbPosition: orbPosition as VoiceOrbPosition })} /></label>
        <label className="browser-settings-field">Tamaño
          <Select value={status.orbSize} options={ORB_SIZE_OPTIONS} disabled={busy} aria-label="Tamaño de la esfera"
            onChange={orbSize => void apply({ orbSize: orbSize as VoiceOrbSize })} /></label>
      </>}
    </div>}

    {status.supported && <div className="browser-settings-card">
      <div className="browser-settings-heading"><div><h4>Dictado<SettingInfo text="El micrófono del campo de texto de cada chat escribe lo que dices. Funciona aunque el modo llamada esté apagado y todo se transcribe en este equipo. El modelo de dictado acierta más con nombres y palabras técnicas que el básico." /></h4>
        {!status.dictationInstalled && <p>Modelo mejorado · {megabytes(status.dictationBytes)}</p>}</div>
        {!status.dictationInstalled && !status.downloading && <button type="button" className="btn btn-small btn-primary" disabled={!status.modelsInstalled}
          onClick={() => void downloadDictation()}>Descargar</button>}
        {status.dictationInstalled && <span className="browser-settings-status is-ready">Listo</span>}
      </div>
      {!status.modelsInstalled && <p className="browser-settings-note">Antes hacen falta los modelos de voz.</p>}
    </div>}

    {status.supported && status.enabled && <div className="browser-settings-card">
      <div className="browser-settings-heading"><div><h4>Lo último que oyó</h4>{listening && <p>{VOICE_PHASE_LABEL[status.phase]}</p>}</div></div>
      {heard.length > 0
        ? <ul className="voice-heard">
          {heard.map(utterance => <li key={utterance.at}>
            <time>{formatClock(utterance.at)}</time>
            <span>{heardLabel(utterance)}</span>
            <small>{utterance.text}</small>
          </li>)}
        </ul>
        : listening && <p className="settings-hint">Prueba: «oye trex, ¿me oyes?»</p>}
    </div>}
    {error && <p className="browser-settings-error" role="alert">{error}</p>}
  </div>;
}
