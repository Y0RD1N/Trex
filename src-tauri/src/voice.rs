//! Modo llamada: trex escucha el micrófono y entiende lo que se le dice.
//!
//! Apagado por defecto. Al activarlo en Ajustes, un hilo captura el micrófono,
//! un detector de voz (Silero VAD) recorta cada frase y Whisper la transcribe,
//! todo en este equipo. Solo las frases que empiezan llamando a trex ("oye
//! trex…") y las que siguen durante la ventana de conversación se envían al
//! frontend; el resto se descarta aquí mismo.
//!
//! Los modelos (~150 MB) no vienen con trex: se descargan tras un clic
//! explícito, con URL y SHA-256 fijados.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};

const CONFIG_FILE: &str = "voice.json";
/// Carpeta de los modelos dentro de los datos locales de la app. El sufijo
/// cambia si cambia la lista de archivos.
const MODELS_DIR: &str = "whisper-base-1";
const EVENT_STATUS: &str = "voice://status";
#[cfg(windows)]
const EVENT_UTTERANCE: &str = "voice://utterance";
#[cfg(windows)]
const EVENT_LEVEL: &str = "voice://level";
#[cfg(windows)]
const EVENT_DICTATION: &str = "voice://dictation";
/// Tras llamar a trex, cuánto tiempo se sigue escuchando sin repetir su nombre.
#[cfg(windows)]
const CONVERSATION_WINDOW: Duration = Duration::from_secs(20);

struct ModelFile {
    name: &'static str,
    url: &'static str,
    sha256: &'static str,
    size: u64,
}

/// Whisper base cuantizado (repositorio de sherpa-onnx, fijado a un commit) y
/// el detector de voz Silero (descargas de sherpa-onnx en GitHub).
const MODEL_FILES: &[ModelFile] = &[
    ModelFile {
        name: "silero_vad.onnx",
        url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx",
        sha256: "9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6",
        size: 643_854,
    },
    ModelFile {
        name: "base-encoder.int8.onnx",
        url: "https://huggingface.co/csukuangfj/sherpa-onnx-whisper-base/resolve/bb53ee204431c90d314c1cc08d28d23e5b7927cc/base-encoder.int8.onnx",
        sha256: "0b8fb1304b6109976038efff5ace81720e00386f3ff6b54ee8c75291ca0a1e11",
        size: 29_120_534,
    },
    ModelFile {
        name: "base-decoder.int8.onnx",
        url: "https://huggingface.co/csukuangfj/sherpa-onnx-whisper-base/resolve/bb53ee204431c90d314c1cc08d28d23e5b7927cc/base-decoder.int8.onnx",
        sha256: "9759d217388a01b3a4c7c15533201067b48ae819c4daafc8624e64b9409dc02d",
        size: 130_672_026,
    },
    ModelFile {
        name: "base-tokens.txt",
        url: "https://huggingface.co/csukuangfj/sherpa-onnx-whisper-base/resolve/bb53ee204431c90d314c1cc08d28d23e5b7927cc/base-tokens.txt",
        sha256: "b34b360dbb493e781e479794586d661700670d65564001f23024971d1f2fa126",
        size: 816_730,
    },
];

fn total_bytes() -> u64 {
    MODEL_FILES.iter().map(|file| file.size).sum()
}

/// Modelo del dictado: Whisper small cuantizado. Opcional y con su propia descarga;
/// sin él se dicta con el modelo base, que se equivoca más con nombres y tecnicismos.
const DICTATION_DIR: &str = "whisper-small-1";
const DICTATION_FILES: &[ModelFile] = &[
    ModelFile {
        name: "small-encoder.int8.onnx",
        url: "https://huggingface.co/csukuangfj/sherpa-onnx-whisper-small/resolve/8f3c18b358db4d1f2fc1eae49d75cd20989e4309/small-encoder.int8.onnx",
        sha256: "4cbe7b22fa9026b843b60a68640c747de05bafb1a11b57edc0e66c232d9f33a9",
        size: 112_442_483,
    },
    ModelFile {
        name: "small-decoder.int8.onnx",
        url: "https://huggingface.co/csukuangfj/sherpa-onnx-whisper-small/resolve/8f3c18b358db4d1f2fc1eae49d75cd20989e4309/small-decoder.int8.onnx",
        sha256: "acad50b5c782696e91b55914cc5ab4f756f1532f76e22aa6fc615f39fb69a8ee",
        size: 262_226_114,
    },
    ModelFile {
        name: "small-tokens.txt",
        url: "https://huggingface.co/csukuangfj/sherpa-onnx-whisper-small/resolve/8f3c18b358db4d1f2fc1eae49d75cd20989e4309/small-tokens.txt",
        sha256: "b34b360dbb493e781e479794586d661700670d65564001f23024971d1f2fa126",
        size: 816_730,
    },
];

fn dictation_bytes() -> u64 {
    DICTATION_FILES.iter().map(|file| file.size).sum()
}

fn dictation_installed(dir: &Path) -> bool {
    DICTATION_FILES.iter().all(|file| {
        std::fs::metadata(dir.join(file.name)).is_ok_and(|meta| meta.is_file() && meta.len() == file.size)
    })
}

/// La voz de trex: Supertonic 3 (MIT), del paquete que publica sherpa-onnx. Es
/// opcional: sin ella trex habla con la voz que trae Windows.
const SPEECH_DIR: &str = "supertonic-3-1";
const SPEECH_ARCHIVE_URL: &str = "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/sherpa-onnx-supertonic-3-tts-int8-2026-05-11.tar.bz2";
const SPEECH_ARCHIVE_SHA256: &str = "82fa96f91c4ef8abaae3a14a3f4153facf88bed821d1f7331cec2700f432c427";
const SPEECH_ARCHIVE_SIZE: u64 = 128_774_318;
/// Carpeta de primer nivel dentro del paquete.
#[cfg(windows)]
const SPEECH_ARCHIVE_DIR: &str = "sherpa-onnx-supertonic-3-tts-int8-2026-05-11";

struct SpeechFile {
    name: &'static str,
    sha256: &'static str,
    size: u64,
}

const SPEECH_FILES: &[SpeechFile] = &[
    SpeechFile { name: "duration_predictor.int8.onnx", sha256: "c3eb91414d5ff8a7a239b7fe9e34e7e2bf8a8140d8375ffb14718b1c639325db", size: 3_700_147 },
    SpeechFile { name: "text_encoder.int8.onnx", sha256: "c7befd5ea8c3119769e8a6c1486c4edc6a3bc8365c67621c881bbb774b9902ff", size: 36_416_150 },
    SpeechFile { name: "vector_estimator.int8.onnx", sha256: "20cd86fa5c6effedfda0e7cffe5b0569ca401c440a0c3a1d72bf39286c0db3fd", size: 78_400_833 },
    SpeechFile { name: "vocoder.int8.onnx", sha256: "e923d60f53f95eb1ce235f1dc33ec56d9c057823c96fa6f8acf98f32b0da6152", size: 25_991_073 },
    SpeechFile { name: "tts.json", sha256: "42078d3aef1cd43ab43021f3c54f47d2d75ceb4e75f627f118890128b06a0d09", size: 8_253 },
    SpeechFile { name: "unicode_indexer.bin", sha256: "8402ca48e5189a8950138580b0fff64db6f072f24ac07cd54ba8b2fbb9883b30", size: 262_144 },
    SpeechFile { name: "voice.bin", sha256: "67d5209b0ee8ce6c74105ffbe12fe6a7628aea3b4ba2fcb308a4a67938a93ce8", size: 517_168 },
];

/// Bibliotecas de reconocimiento (sherpa-onnx y onnxruntime), del mismo paquete
/// oficial con el que se compila trex. No van en el instalador: quien no usa la
/// voz no las descarga.
const RUNTIME_DIR: &str = "runtime-2.0.1";
const RUNTIME_ARCHIVE_URL: &str = "https://github.com/k2-fsa/sherpa-onnx/releases/download/v2.0.1/sherpa-onnx-v2.0.1-win-x64-shared-MT-Release-lib.tar.bz2";
const RUNTIME_ARCHIVE_SHA256: &str = "afa4de3ca4ab0afd53bb4aab40d28ee15608364b549ffc0fe0caf6489bfc39a5";
const RUNTIME_ARCHIVE_SIZE: u64 = 7_899_712;
#[cfg(windows)]
const RUNTIME_ARCHIVE_DIR: &str = "sherpa-onnx-v2.0.1-win-x64-shared-MT-Release-lib/lib";
const RUNTIME_FILES: &[SpeechFile] = &[
    SpeechFile { name: "onnxruntime.dll", sha256: "7f66f939a881baf4f46a2216496798edf4a1429878b646d12674aa62f27d8a25", size: 17_799_168 },
    SpeechFile { name: "onnxruntime_providers_shared.dll", sha256: "551d0e1fe4c227d8542314ba718d52f4379e0c7bfe729a37c59833a884e27b4d", size: 104_960 },
    SpeechFile { name: "sherpa-onnx-c-api.dll", sha256: "0965a6e4c0254da2beff489cf7a8aaffaf7dc94f90b43b3e66448b8cab4177ea", size: 4_294_656 },
];

fn speech_installed(dir: &Path) -> bool {
    SPEECH_FILES.iter().all(|file| {
        std::fs::metadata(dir.join(file.name)).is_ok_and(|meta| meta.is_file() && meta.len() == file.size)
    })
}

// --- Configuración guardada ---------------------------------------------------

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
struct VoiceConfig {
    enabled: bool,
    /// Capturar sin el procesado del controlador (ver `voice_capture.rs`).
    raw_capture: bool,
    /// Micrófono elegido (su id en Windows); vacío = el predeterminado del sistema.
    device: String,
    /// Quién conversa: "local" (Whisper + Claude, sin costo) o "live" (Gemini Live, de pago).
    mode: String,
    /// Voz de Gemini en el modo en tiempo real.
    live_voice: String,
    /// En tiempo real, dejar que la persona interrumpa a trex. Requiere auriculares.
    barge_in: bool,
    /// Voz de las respuestas en el modo local: "local" o "elevenlabs".
    speech: String,
    /// Voz elegida de ElevenLabs (su id).
    cloud_voice: String,
}

impl Default for VoiceConfig {
    fn default() -> Self {
        Self {
            enabled: false, raw_capture: true, device: String::new(),
            mode: "local".into(), live_voice: crate::voice_live::DEFAULT_VOICE.into(), barge_in: true,
            speech: "local".into(), cloud_voice: String::new(),
        }
    }
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map(|dir| dir.join(CONFIG_FILE))
        .map_err(|error| format!("No se encontró la carpeta de datos de la app: {error}"))
}

fn load_config(app: &AppHandle) -> VoiceConfig {
    let Ok(path) = config_path(app) else { return VoiceConfig::default() };
    let Ok(text) = std::fs::read_to_string(path) else { return VoiceConfig::default() };
    serde_json::from_str(&text).unwrap_or_default()
}

fn save_config(app: &AppHandle, config: &VoiceConfig) -> Result<(), String> {
    let path = config_path(app)?;
    if let Some(dir) = path.parent() { std::fs::create_dir_all(dir).map_err(|e| e.to_string())?; }
    let text = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    let temporary = path.with_extension("json.tmp");
    std::fs::write(&temporary, text).map_err(|e| format!("No se pudo guardar la configuración de voz: {e}"))?;
    std::fs::rename(&temporary, &path).map_err(|e| format!("No se pudo guardar la configuración de voz: {e}"))
}

// --- Estado -------------------------------------------------------------------

pub struct Inner {
    app: Mutex<Option<AppHandle>>,
    config: Mutex<VoiceConfig>,
    /// "off" | "loading" | "idle" | "hearing" | "transcribing" | "speaking" | "live" | "dictating"
    phase: Mutex<&'static str>,
    error: Mutex<Option<String>>,
    /// Último fallo de la voz de nube; se borra cuando vuelve a sonar bien.
    speech_error: Mutex<Option<String>>,
    /// Chat al que se está dictando (su id). Mientras hay uno, todo lo que se oye se escribe allí.
    dictation: Mutex<Option<String>>,
    downloading: AtomicBool,
    downloaded: AtomicU64,
    /// Bytes de la descarga en curso (lo que faltaba al empezarla).
    download_total: AtomicU64,
    /// trex está hablando: el motor ignora el micrófono para no oírse a sí mismo.
    speaking: AtomicBool,
    /// Cada frase nueva interrumpe a la anterior.
    speech: AtomicU64,
    /// Generación del motor: al apagar o reconfigurar, el hilo anterior se retira solo.
    generation: AtomicU64,
}

#[derive(Clone)]
pub struct VoiceState(Arc<Inner>);

impl Default for VoiceState {
    fn default() -> Self {
        Self(Arc::new(Inner {
            app: Mutex::new(None), config: Mutex::new(VoiceConfig::default()), phase: Mutex::new("off"),
            error: Mutex::new(None), speech_error: Mutex::new(None), dictation: Mutex::new(None), downloading: AtomicBool::new(false), downloaded: AtomicU64::new(0),
            download_total: AtomicU64::new(0), speaking: AtomicBool::new(false), speech: AtomicU64::new(0),
            generation: AtomicU64::new(0),
        }))
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl Inner {
    fn emit<S: Serialize + Clone>(&self, event: &str, payload: S) {
        if let Some(app) = lock(&self.app).clone() { let _ = app.emit(event, payload); }
    }

    fn set_phase(&self, phase: &'static str) {
        {
            let mut current = lock(&self.phase);
            if *current == phase { return; }
            *current = phase;
        }
        self.emit(EVENT_STATUS, serde_json::json!({ "phase": phase }));
    }

    fn models_dir(&self) -> Option<PathBuf> {
        let app = lock(&self.app).clone()?;
        Some(app.path().app_local_data_dir().ok()?.join("voice").join(MODELS_DIR))
    }

    fn speech_dir(&self) -> Option<PathBuf> {
        Some(self.models_dir()?.parent()?.join(SPEECH_DIR))
    }

    fn runtime_dir(&self) -> Option<PathBuf> {
        Some(self.models_dir()?.parent()?.join(RUNTIME_DIR))
    }

    fn dictation_dir(&self) -> Option<PathBuf> {
        Some(self.models_dir()?.parent()?.join(DICTATION_DIR))
    }
}

fn models_installed(dir: &Path) -> bool {
    MODEL_FILES.iter().all(|file| {
        std::fs::metadata(dir.join(file.name)).is_ok_and(|meta| meta.is_file() && meta.len() == file.size)
    })
}

/// Las bibliotecas de reconocimiento se cargan bajo demanda (ver `build.rs`), así
/// que trex arranca sin ellas. En desarrollo están junto al ejecutable; en una
/// instalación se descargan con los modelos.
#[cfg(windows)]
fn runtime_beside_exe() -> bool {
    let Ok(exe) = std::env::current_exe() else { return false };
    let Some(dir) = exe.parent() else { return false };
    ["sherpa-onnx-c-api.dll", "onnxruntime.dll"].iter().all(|name| dir.join(name).is_file())
}

fn runtime_installed(dir: &Path) -> bool {
    RUNTIME_FILES.iter().all(|file| {
        std::fs::metadata(dir.join(file.name)).is_ok_and(|meta| meta.is_file() && meta.len() == file.size)
    })
}

/// Hay bibliotecas de reconocimiento que usar (junto al ejecutable o descargadas).
fn runtime_ready(inner: &Inner) -> bool {
    #[cfg(windows)]
    if runtime_beside_exe() { return true; }
    inner.runtime_dir().is_some_and(|dir| runtime_installed(&dir))
}

/// Deja las bibliotecas listas para el primer uso. Las descargadas se cargan por su
/// ruta completa y tras comprobar su SHA-256: así no se usa por error otra
/// `onnxruntime.dll` del sistema ni un archivo cambiado después de instalarlo.
#[cfg(windows)]
fn load_runtime(inner: &Inner) -> bool {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::System::LibraryLoader::{LoadLibraryExW, LOAD_WITH_ALTERED_SEARCH_PATH};
    static LOADED: AtomicBool = AtomicBool::new(false);
    if runtime_beside_exe() || LOADED.load(Ordering::SeqCst) { return true; }
    let Some(dir) = inner.runtime_dir().filter(|dir| runtime_installed(dir)) else { return false };
    if !RUNTIME_FILES.iter().all(|file| digest_file(&dir.join(file.name)).is_ok_and(|digest| digest == file.sha256)) { return false; }
    // Primero onnxruntime: la otra biblioteca la importa por nombre y encuentra la ya cargada.
    for name in ["onnxruntime.dll", "sherpa-onnx-c-api.dll"] {
        let path: Vec<u16> = dir.join(name).as_os_str().encode_wide().chain(std::iter::once(0)).collect();
        if unsafe { LoadLibraryExW(PCWSTR(path.as_ptr()), None, LOAD_WITH_ALTERED_SEARCH_PATH) }.is_err() { return false; }
    }
    LOADED.store(true, Ordering::SeqCst);
    true
}

fn stop(inner: &Arc<Inner>) {
    inner.generation.fetch_add(1, Ordering::SeqCst);
    inner.set_phase("off");
}

/// Arranca el motor con la configuración actual (o deja anotado por qué no).
fn start(state: &VoiceState) {
    let inner = state.0.clone();
    stop(&inner);
    *lock(&inner.error) = None;
    let config = lock(&inner.config).clone();
    // Con el modo llamada apagado, el motor solo corre mientras se dicta.
    if !config.enabled && lock(&inner.dictation).is_none() { return; }
    #[cfg(not(windows))]
    {
        *lock(&inner.error) = Some("El modo llamada solo funciona en Windows por ahora.".into());
    }
    #[cfg(windows)]
    {
        let Some(models) = inner.models_dir().filter(|dir| models_installed(dir)) else {
            *lock(&inner.error) = Some("Faltan los modelos de voz: descárgalos para empezar a escuchar.".into());
            return;
        };
        if !load_runtime(&inner) {
            *lock(&inner.error) = Some("Falta el componente de reconocimiento de voz: descárgalo con los modelos en Ajustes › Voz.".into());
            return;
        }
        let generation = inner.generation.load(Ordering::SeqCst);
        inner.set_phase("loading");
        let spawned = std::thread::Builder::new().name("trex-voice".into()).spawn({
            let inner = inner.clone();
            move || {
                let dictation_models = inner.dictation_dir().filter(|dir| dictation_installed(dir));
                let result = engine::run(&inner, generation, &models, dictation_models.as_deref(), &config);
                if cfg!(debug_assertions) { eprintln!("[voz] el motor terminó: {result:?}"); }
                // Un motor reemplazado no toca el estado del que lo sustituyó.
                if inner.generation.load(Ordering::SeqCst) != generation { return; }
                if let Err(error) = result { *lock(&inner.error) = Some(error); }
                inner.set_phase("off");
                inner.emit(EVENT_STATUS, serde_json::json!({ "phase": "off" }));
            }
        });
        if let Err(error) = spawned {
            *lock(&inner.error) = Some(format!("No se pudo iniciar el motor de voz: {error}"));
            inner.set_phase("off");
        }
    }
}

/// Al abrir trex: escucha solo si la persona lo dejó activado.
pub fn init(app: &AppHandle) {
    let state = app.state::<VoiceState>().inner().clone();
    *lock(&state.0.app) = Some(app.clone());
    *lock(&state.0.config) = load_config(app);
    if lock(&state.0.config).enabled { start(&state); }
}

// --- Motor: micrófono → detector de voz → Whisper -------------------------------

#[cfg(windows)]
mod engine {
    use super::{Inner, VoiceConfig, CONVERSATION_WINDOW, EVENT_DICTATION, EVENT_LEVEL, EVENT_UTTERANCE};
    use crate::voice_live::{self, LiveLink, LiveOptions};
    use crate::{voice_capture, voice_keys, voice_wake};
    use tauri::Manager;
    use serde::Serialize;
    use sherpa_onnx::{
        LinearResampler, OfflineRecognizer, OfflineRecognizerConfig, OfflineWhisperModelConfig,
        SileroVadModelConfig, VadModelConfig, VoiceActivityDetector,
    };
    use std::path::Path;
    use std::sync::atomic::Ordering;
    use std::sync::mpsc::RecvTimeoutError;
    use std::sync::Arc;
    use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

    const RATE: i32 = 16_000;
    const VAD_WINDOW: usize = 512;

    #[derive(Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Utterance {
        /// Lo que Whisper entendió, completo.
        text: String,
        /// La orden: el texto sin el "oye trex" inicial.
        command: String,
        /// `true` si la frase llamó a trex; `false` si llegó dentro de la ventana de conversación.
        wake: bool,
        at: u64,
    }

    fn path(dir: &Path, name: &str) -> Option<String> {
        Some(dir.join(name).to_string_lossy().into_owned())
    }

    /// Nivel del micrófono para el medidor de Ajustes.
    #[derive(Clone, Serialize)]
    struct Level {
        /// Pico del último tramo, de 0 a 1.
        peak: f32,
        /// El detector cree que alguien está hablando.
        voice: bool,
        /// trex está hablando y no escucha.
        deaf: bool,
    }

    /// Abre una llamada en tiempo real si ese modo está elegido y hay clave.
    fn start_live(inner: &Arc<Inner>, config: &VoiceConfig, first_words: &str) -> Option<LiveLink> {
        let app = super::lock(&inner.app).clone()?;
        let key = voice_keys::load(&app, "gemini")?;
        let state = app.state::<voice_live::LiveState>().inner().clone();
        Some(voice_live::start(app, state, LiveOptions {
            key,
            voice: config.live_voice.clone(),
            barge_in: config.barge_in,
            first_words: first_words.to_string(),
        }))
    }

    /// Carga un Whisper cuantizado («base» o «small») de `dir`.
    fn whisper(dir: &Path, size: &str) -> Option<OfflineRecognizer> {
        let mut config = OfflineRecognizerConfig::default();
        config.model_config.whisper = OfflineWhisperModelConfig {
            encoder: path(dir, &format!("{size}-encoder.int8.onnx")),
            decoder: path(dir, &format!("{size}-decoder.int8.onnx")),
            language: Some("es".into()),
            task: Some("transcribe".into()),
            ..Default::default()
        };
        config.model_config.tokens = path(dir, &format!("{size}-tokens.txt"));
        config.model_config.num_threads = 4;
        OfflineRecognizer::create(&config)
    }

    fn transcribe(recognizer: &OfflineRecognizer, speech: &[f32]) -> String {
        let stream = recognizer.create_stream();
        stream.accept_waveform(RATE, speech);
        recognizer.decode(&stream);
        stream.get_result().map(|result| result.text.trim().to_string()).unwrap_or_default()
    }

    #[derive(Clone, Serialize)]
    struct Dictated { target: String, text: String }

    pub fn run(inner: &Arc<Inner>, generation: u64, models: &Path, dictation_models: Option<&Path>, settings: &VoiceConfig) -> Result<(), String> {
        let (raw, device) = (settings.raw_capture, settings.device.clone());
        // El modelo del dictado es más pesado: se carga la primera vez que se dicta.
        let mut dictation_recognizer: Option<OfflineRecognizer> = None;
        // Con una llamada en tiempo real abierta, el micrófono va directo a ella.
        let mut live: Option<LiveLink> = None;
        let alive = || inner.generation.load(Ordering::SeqCst) == generation;

        let recognizer = whisper(models, "base").ok_or("No se pudo cargar el modelo de reconocimiento de voz.")?;

        let vad = VoiceActivityDetector::create(
            &VadModelConfig {
                silero_vad: SileroVadModelConfig {
                    model: path(models, "silero_vad.onnx"),
                    threshold: 0.5,
                    min_silence_duration: 0.5,
                    min_speech_duration: 0.25,
                    window_size: VAD_WINDOW as i32,
                    max_speech_duration: 15.0,
                },
                sample_rate: RATE,
                num_threads: 1,
                ..Default::default()
            },
            30.0,
        )
        .ok_or("No se pudo cargar el detector de voz.")?;

        if !alive() { return Ok(()); }
        let (mic_rate, audio) = voice_capture::start(raw, Some(device).filter(|id| !id.is_empty()))?;
        if cfg!(debug_assertions) { eprintln!("[voz] micrófono abierto a {mic_rate} Hz (crudo: {raw})"); }
        let mut peak = 0f32;
        let mut level_at = Instant::now();
        let resampler = if mic_rate as i32 != RATE {
            Some(LinearResampler::create(mic_rate as i32, RATE).ok_or("No se pudo adaptar el audio del micrófono.")?)
        } else {
            None
        };
        inner.set_phase("idle");

        let mut pending: Vec<f32> = Vec::new();
        // Hasta cuándo se aceptan frases sin "oye trex" delante.
        let mut conversation_until: Option<Instant> = None;
        // Tras hablar trex se descarta un instante más de audio: la cola de su propia voz.
        let mut deaf_until = Instant::now();
        loop {
            if !alive() { return Ok(()); }
            let dictating = super::lock(&inner.dictation).clone();
            // Arrancado solo para dictar: al terminar el dictado, el micrófono se cierra.
            if !settings.enabled && dictating.is_none() { return Ok(()); }
            let chunk = match audio.recv_timeout(Duration::from_millis(250)) {
                Ok(chunk) => chunk,
                Err(RecvTimeoutError::Timeout) => continue,
                Err(RecvTimeoutError::Disconnected) => return Err("El micrófono dejó de responder.".into()),
            };
            if inner.speaking.load(Ordering::SeqCst) {
                deaf_until = Instant::now() + Duration::from_millis(400);
                // Después de responder, la persona puede seguir hablando sin repetir "oye trex".
                conversation_until = Some(Instant::now() + CONVERSATION_WINDOW);
            }
            let deaf = Instant::now() < deaf_until;
            // Medidor de Ajustes: unas cuatro veces por segundo, también mientras trex habla.
            peak = chunk.iter().fold(peak, |max, sample| max.max(sample.abs()));
            if level_at.elapsed() >= Duration::from_millis(250) {
                inner.emit(EVENT_LEVEL, Level { peak: peak.min(1.0), voice: !deaf && vad.detected(), deaf });
                peak = 0.0;
                level_at = Instant::now();
            }
            if deaf {
                pending.clear();
                vad.reset();
                continue;
            }
            let samples = match &resampler {
                Some(resampler) => resampler.resample(&chunk, false),
                None => chunk,
            };
            if let Some(call) = &live {
                if call.alive() {
                    call.send(samples.iter().map(|sample| (sample.clamp(-1.0, 1.0) * 32767.0) as i16).collect());
                    continue;
                }
                // La llamada terminó: vuelve la escucha local, sin restos de audio anteriores.
                live = None;
                pending.clear();
                vad.reset();
                conversation_until = None;
                inner.set_phase("idle");
            }
            pending.extend_from_slice(&samples);
            while pending.len() >= VAD_WINDOW {
                vad.accept_waveform(&pending[..VAD_WINDOW]);
                pending.drain(..VAD_WINDOW);
            }
            let resting = if dictating.is_some() { "dictating" } else { "idle" };
            if vad.is_empty() {
                inner.set_phase(if vad.detected() { "hearing" } else { resting });
                continue;
            }

            while let Some(segment) = vad.front() {
                let speech = segment.samples().to_vec();
                drop(segment);
                vad.pop();
                if !alive() { return Ok(()); }

                inner.set_phase("transcribing");
                if let Some(target) = &dictating {
                    // Dictado: todo se escribe en el chat, sin "oye trex" y sin abrir llamadas.
                    if dictation_recognizer.is_none() {
                        dictation_recognizer = dictation_models.and_then(|dir| whisper(dir, "small"));
                    }
                    let text = transcribe(dictation_recognizer.as_ref().unwrap_or(&recognizer), &speech);
                    if cfg!(debug_assertions) { eprintln!("[voz] dictado ({:.1} s): «{text}»", speech.len() as f32 / RATE as f32); }
                    if let Some(text) = crate::voice_dictation::clean(&text) {
                        inner.emit(EVENT_DICTATION, Dictated { target: target.clone(), text });
                    }
                    continue;
                }
                let text = transcribe(&recognizer, &speech);
                if cfg!(debug_assertions) { eprintln!("[voz] oído ({:.1} s): «{text}»", speech.len() as f32 / RATE as f32); }
                if text.is_empty() { continue; }

                let now = Instant::now();
                let in_conversation = conversation_until.is_some_and(|until| now < until);
                let (command, wake) = match voice_wake::wake_command(&text) {
                    Some(command) => (command, true),
                    None if in_conversation => (text.clone(), false),
                    // Nadie llamó a trex: la frase no sale de este hilo.
                    None => continue,
                };
                if wake && settings.mode == "live" {
                    // Sin clave se sigue por el camino local: trex contesta igual, solo que más despacio.
                    if let Some(call) = start_live(inner, settings, &command) {
                        if cfg!(debug_assertions) { eprintln!("[voz] llamada en tiempo real abierta"); }
                        live = Some(call);
                        vad.clear();
                        inner.set_phase("live");
                        break;
                    }
                }
                conversation_until = Some(now + CONVERSATION_WINDOW);
                let at = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
                inner.emit(EVENT_UTTERANCE, Utterance { text, command, wake, at });
            }
            if live.is_none() { inner.set_phase(resting); }
        }
    }
}

// --- Descarga de modelos ----------------------------------------------------------

fn digest_file(path: &Path) -> Result<String, String> {
    let mut file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut digest = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buffer).map_err(|e| e.to_string())?;
        if n == 0 { break; }
        digest.update(&buffer[..n]);
    }
    Ok(format!("{:x}", digest.finalize()))
}

fn http_client() -> Result<reqwest::blocking::Client, String> {
    // Las fuentes redirigen a su CDN: se siguen pocas redirecciones y solo por HTTPS.
    reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(20))
        .timeout(Duration::from_secs(30 * 60))
        .https_only(true)
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()
        .map_err(|_| "No se pudo preparar la descarga de los modelos de voz.".to_string())
}

/// Descarga `url` a `path` y solo lo da por bueno con el tamaño y el SHA-256 esperados.
fn fetch(inner: &Inner, client: &reqwest::blocking::Client, url: &str, name: &str, size: u64, sha256: &str, path: &Path) -> Result<(), String> {
    let mut response = client.get(url).send().and_then(|r| r.error_for_status())
        .map_err(|_| format!("No se pudo descargar {name}."))?;
    if response.content_length().is_some_and(|length| length != size) {
        return Err(format!("{name} no tiene el tamaño esperado; no se instaló."));
    }
    let mut output = std::fs::File::create(path).map_err(|e| e.to_string())?;
    let mut buffer = [0u8; 64 * 1024];
    let mut written = 0u64;
    loop {
        let n = response.read(&mut buffer).map_err(|_| format!("Se interrumpió la descarga de {name}."))?;
        if n == 0 { break; }
        written += n as u64;
        if written > size {
            return Err(format!("{name} excede el tamaño esperado; no se instaló."));
        }
        output.write_all(&buffer[..n]).map_err(|e| e.to_string())?;
        inner.downloaded.fetch_add(n as u64, Ordering::SeqCst);
    }
    output.sync_all().map_err(|e| e.to_string())?;
    drop(output);
    if written != size || digest_file(path)? != sha256 {
        return Err(format!("La verificación SHA-256 de {name} falló; no se instaló."));
    }
    Ok(())
}

/// Lo que falta por descargar, en bytes: los modelos de escucha y, aparte, la voz de
/// trex y las bibliotecas de reconocimiento.
fn pending_download(listen: &Path, speech: &Path, runtime_missing: bool) -> (bool, bool, u64) {
    let need_listen = !models_installed(listen);
    let need_speech = cfg!(windows) && !speech_installed(speech);
    let bytes = if need_listen { total_bytes() } else { 0 }
        + if need_speech { SPEECH_ARCHIVE_SIZE } else { 0 }
        + if runtime_missing { RUNTIME_ARCHIVE_SIZE } else { 0 };
    (need_listen, need_speech, bytes)
}

/// Descarga lo que falte. `runtime` es la carpeta de las bibliotecas si no están instaladas.
fn download_models(inner: &Inner, listen: &Path, speech: &Path, runtime: Option<&Path>) -> Result<(), String> {
    let (need_listen, need_speech, bytes) = pending_download(listen, speech, runtime.is_some());
    inner.downloaded.store(0, Ordering::SeqCst);
    inner.download_total.store(bytes, Ordering::SeqCst);
    if !need_listen && !need_speech && runtime.is_none() { return Ok(()); }
    let root = listen.parent().ok_or("Carpeta de modelos no válida.")?;
    std::fs::create_dir_all(root).map_err(|e| e.to_string())?;
    let token = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|e| e.to_string())?.as_nanos();
    let stage = root.join(format!("download-{}-{token}", std::process::id()));
    std::fs::create_dir(&stage).map_err(|e| e.to_string())?;
    let result = (|| {
        let client = http_client()?;
        #[cfg(windows)]
        if let Some(target) = runtime { download_archive(inner, &client, &stage, target, &RUNTIME_ARCHIVE)?; }
        if need_listen { download_listen(inner, &client, &stage, listen)?; }
        #[cfg(windows)]
        if need_speech { download_archive(inner, &client, &stage, speech, &SPEECH_ARCHIVE)?; }
        Ok(())
    })();
    let _ = std::fs::remove_dir_all(&stage);
    result
}

fn download_listen(inner: &Inner, client: &reqwest::blocking::Client, stage: &Path, target: &Path) -> Result<(), String> {
    download_files(inner, client, stage, target, MODEL_FILES)
}

/// Descarga el modelo del dictado. Solo se llama tras un clic explícito en Ajustes.
fn download_dictation(inner: &Inner, target: &Path) -> Result<(), String> {
    inner.downloaded.store(0, Ordering::SeqCst);
    inner.download_total.store(dictation_bytes(), Ordering::SeqCst);
    if dictation_installed(target) { return Ok(()); }
    let root = target.parent().ok_or("Carpeta de modelos no válida.")?;
    std::fs::create_dir_all(root).map_err(|e| e.to_string())?;
    let token = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|e| e.to_string())?.as_nanos();
    let stage = root.join(format!("download-{}-{token}", std::process::id()));
    std::fs::create_dir(&stage).map_err(|e| e.to_string())?;
    let result = http_client().and_then(|client| download_files(inner, &client, &stage, target, DICTATION_FILES));
    let _ = std::fs::remove_dir_all(&stage);
    result
}

fn download_files(inner: &Inner, client: &reqwest::blocking::Client, stage: &Path, target: &Path, files: &[ModelFile]) -> Result<(), String> {
    for file in files {
        fetch(inner, client, file.url, file.name, file.size, file.sha256, &stage.join(file.name))?;
    }
    // Todo verificado: se publica archivo a archivo en la carpeta definitiva.
    std::fs::create_dir_all(target).map_err(|e| e.to_string())?;
    for file in files {
        let destination = target.join(file.name);
        let _ = std::fs::remove_file(&destination);
        std::fs::rename(stage.join(file.name), &destination)
            .map_err(|_| "No se pudieron instalar los modelos de voz verificados.".to_string())?;
    }
    Ok(())
}

/// Un paquete .tar.bz2 del que solo interesan unos archivos concretos.
#[cfg(windows)]
struct Archive {
    /// Cómo se nombra en los mensajes de error.
    label: &'static str,
    url: &'static str,
    sha256: &'static str,
    size: u64,
    /// Carpeta dentro del paquete donde están los archivos.
    dir: &'static str,
    files: &'static [SpeechFile],
}

#[cfg(windows)]
const SPEECH_ARCHIVE: Archive = Archive {
    label: "la voz de trex", url: SPEECH_ARCHIVE_URL, sha256: SPEECH_ARCHIVE_SHA256, size: SPEECH_ARCHIVE_SIZE,
    dir: SPEECH_ARCHIVE_DIR, files: SPEECH_FILES,
};

#[cfg(windows)]
const RUNTIME_ARCHIVE: Archive = Archive {
    label: "el componente de reconocimiento", url: RUNTIME_ARCHIVE_URL, sha256: RUNTIME_ARCHIVE_SHA256, size: RUNTIME_ARCHIVE_SIZE,
    dir: RUNTIME_ARCHIVE_DIR, files: RUNTIME_FILES,
};

/// Se verifica el paquete entero, se sacan solo los archivos esperados (nunca
/// rutas del paquete) y cada uno se vuelve a verificar antes de instalarlo.
#[cfg(windows)]
fn download_archive(inner: &Inner, client: &reqwest::blocking::Client, stage: &Path, target: &Path, archive: &Archive) -> Result<(), String> {
    let packed = stage.join(format!("{}.tar.bz2", archive.sha256));
    fetch(inner, client, archive.url, archive.label, archive.size, archive.sha256, &packed)?;
    let unpacked = stage.join(archive.sha256);
    std::fs::create_dir(&unpacked).map_err(|e| e.to_string())?;
    let reader = std::io::BufReader::new(std::fs::File::open(&packed).map_err(|e| e.to_string())?);
    let mut tar = tar::Archive::new(bzip2::read::BzDecoder::new(reader));
    let broken = || format!("No se pudo leer {}; no se instaló.", archive.label);
    for entry in tar.entries().map_err(|_| broken())? {
        let mut entry = entry.map_err(|_| broken())?;
        if !entry.header().entry_type().is_file() { continue; }
        let path = entry.path().map_err(|_| broken())?.into_owned();
        let Some(file) = archive.files.iter().find(|file| path == Path::new(archive.dir).join(file.name)) else { continue };
        if entry.size() != file.size { return Err(broken()); }
        let mut output = std::fs::OpenOptions::new().write(true).create_new(true).open(unpacked.join(file.name)).map_err(|e| e.to_string())?;
        std::io::copy(&mut entry.by_ref().take(file.size), &mut output).map_err(|_| broken())?;
        output.sync_all().map_err(|e| e.to_string())?;
    }
    for file in archive.files {
        let path = unpacked.join(file.name);
        if !std::fs::metadata(&path).is_ok_and(|meta| meta.len() == file.size) || digest_file(&path)? != file.sha256 {
            return Err(format!("La verificación SHA-256 de {} falló; no se instaló.", file.name));
        }
    }
    std::fs::create_dir_all(target).map_err(|e| e.to_string())?;
    for file in archive.files {
        let destination = target.join(file.name);
        let _ = std::fs::remove_file(&destination);
        std::fs::rename(unpacked.join(file.name), &destination)
            .map_err(|_| format!("No se pudo instalar {}.", archive.label))?;
    }
    Ok(())
}

// --- Estado para Ajustes ------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceStatus {
    /// `false` en los sistemas donde el modo llamada aún no existe.
    supported: bool,
    enabled: bool,
    raw_capture: bool,
    /// Micrófono elegido; vacío = el predeterminado del sistema.
    device: String,
    mode: String,
    live_voice: String,
    live_voices: &'static [&'static str],
    barge_in: bool,
    speech: String,
    cloud_voice: String,
    /// Hay clave guardada. El valor de la clave nunca sale de Rust.
    has_gemini_key: bool,
    has_cloud_key: bool,
    /// Por qué la voz de nube no sonó la última vez (se usó la local).
    speech_error: Option<String>,
    phase: &'static str,
    error: Option<String>,
    models_installed: bool,
    /// La voz neuronal de trex está instalada; si no, habla con la de Windows.
    speech_installed: bool,
    /// El modelo del dictado está instalado; si no, se dicta con el modelo base.
    dictation_installed: bool,
    dictation_bytes: u64,
    /// Chat al que se está dictando ahora, si hay alguno.
    dictating: Option<String>,
    downloading: bool,
    downloaded_bytes: u64,
    total_bytes: u64,
}

fn status_of(state: &VoiceState) -> VoiceStatus {
    let inner = &state.0;
    let config = lock(&inner.config).clone();
    let downloading = inner.downloading.load(Ordering::SeqCst);
    let app = lock(&inner.app).clone();
    let missing = match (inner.models_dir(), inner.speech_dir()) {
        (Some(listen), Some(speech)) => pending_download(&listen, &speech, cfg!(windows) && !runtime_ready(inner)).2,
        _ => 0,
    };
    VoiceStatus {
        supported: cfg!(windows),
        enabled: config.enabled,
        raw_capture: config.raw_capture,
        device: config.device.clone(),
        mode: config.mode.clone(),
        live_voice: config.live_voice.clone(),
        live_voices: crate::voice_live::VOICES,
        barge_in: config.barge_in,
        speech: config.speech.clone(),
        cloud_voice: config.cloud_voice.clone(),
        has_gemini_key: app.as_ref().is_some_and(|app| crate::voice_keys::has(app, "gemini")),
        has_cloud_key: app.as_ref().is_some_and(|app| crate::voice_keys::has(app, "elevenlabs")),
        speech_error: lock(&inner.speech_error).clone(),
        phase: *lock(&inner.phase),
        error: lock(&inner.error).clone(),
        // Sin las bibliotecas de reconocimiento los modelos no sirven: cuentan como una sola descarga.
        models_installed: inner.models_dir().is_some_and(|dir| models_installed(&dir)) && runtime_ready(inner),
        speech_installed: inner.speech_dir().is_some_and(|dir| speech_installed(&dir)),
        dictation_installed: inner.dictation_dir().is_some_and(|dir| dictation_installed(&dir)),
        dictation_bytes: dictation_bytes(),
        dictating: lock(&inner.dictation).clone(),
        downloading,
        downloaded_bytes: inner.downloaded.load(Ordering::SeqCst),
        // Durante la descarga, lo que faltaba al empezar; si no, lo que falta ahora.
        total_bytes: if downloading { inner.download_total.load(Ordering::SeqCst) } else { missing },
    }
}

// --- Comandos Tauri -------------------------------------------------------------------

#[tauri::command]
pub fn voice_status(state: State<'_, VoiceState>) -> VoiceStatus {
    status_of(state.inner())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceSettings {
    enabled: bool,
    raw_capture: bool,
    #[serde(default)] device: String,
    #[serde(default)] mode: String,
    #[serde(default)] live_voice: String,
    #[serde(default = "yes")] barge_in: bool,
    #[serde(default)] speech: String,
    #[serde(default)] cloud_voice: String,
}

fn yes() -> bool { true }

/// Voces de la cuenta de ElevenLabs, para elegir una en Ajustes.
#[tauri::command]
pub async fn voice_cloud_voices(app: AppHandle) -> Result<Vec<crate::voice_cloud::CloudVoice>, String> {
    let key = crate::voice_keys::load(&app, "elevenlabs").ok_or("Primero guarda tu clave de ElevenLabs.")?;
    tauri::async_runtime::spawn_blocking(move || crate::voice_cloud::voices(&key)).await.map_err(|e| e.to_string())?
}

/// Micrófonos conectados, para elegir uno en Ajustes.
#[tauri::command]
pub async fn voice_microphones() -> Result<Vec<serde_json::Value>, String> {
    #[cfg(not(windows))]
    { Ok(Vec::new()) }
    #[cfg(windows)]
    {
        tauri::async_runtime::spawn_blocking(|| {
            crate::voice_capture::list().map(|list| list.into_iter().filter_map(|mic| serde_json::to_value(mic).ok()).collect())
        })
        .await
        .map_err(|e| e.to_string())?
    }
}

#[tauri::command]
pub fn voice_configure(app: AppHandle, state: State<'_, VoiceState>, settings: VoiceSettings) -> Result<VoiceStatus, String> {
    let state = state.inner().clone();
    let previous = lock(&state.0.config).clone();
    let snapshot = {
        let mut config = lock(&state.0.config);
        config.enabled = settings.enabled;
        config.raw_capture = settings.raw_capture;
        config.device = settings.device.chars().take(512).collect();
        config.mode = if settings.mode == "live" { "live".into() } else { "local".into() };
        config.live_voice = if crate::voice_live::VOICES.contains(&settings.live_voice.as_str()) { settings.live_voice } else { crate::voice_live::DEFAULT_VOICE.into() };
        config.barge_in = settings.barge_in;
        config.speech = if settings.speech == "elevenlabs" { "elevenlabs".into() } else { "local".into() };
        config.cloud_voice = if crate::voice_cloud::valid_voice(&settings.cloud_voice) { settings.cloud_voice } else { String::new() };
        config.clone()
    };
    save_config(&app, &snapshot)?;
    // Cambiar solo la voz de las respuestas no reinicia la escucha.
    let same_engine = VoiceConfig { speech: previous.speech.clone(), cloud_voice: previous.cloud_voice.clone(), ..snapshot.clone() } == previous;
    if !snapshot.enabled { stop(&state.0); *lock(&state.0.error) = None; }
    else if !same_engine || *lock(&state.0.phase) == "off" { start(&state); }
    if snapshot.speech != previous.speech || snapshot.cloud_voice != previous.cloud_voice { *lock(&state.0.speech_error) = None; }
    Ok(status_of(&state))
}

/// Lee un texto en alto. Mientras suena, el motor no escucha. Una frase nueva corta la anterior.
#[tauri::command]
pub async fn voice_speak(state: State<'_, VoiceState>, text: String) -> Result<(), String> {
    let text: String = text.trim().chars().take(2000).collect();
    if text.is_empty() { return Ok(()); }
    #[cfg(not(windows))]
    {
        let _ = state;
        Err("La voz de trex solo funciona en Windows por ahora.".into())
    }
    #[cfg(windows)]
    {
        let inner = state.inner().0.clone();
        let turn = inner.speech.fetch_add(1, Ordering::SeqCst) + 1;
        tauri::async_runtime::spawn_blocking(move || {
            inner.speaking.store(true, Ordering::SeqCst);
            let listening = !matches!(*lock(&inner.phase), "off" | "loading");
            if listening { inner.set_phase("speaking"); }
            // Con la voz neuronal instalada se usa esa; si no (o si falla), la de Windows.
            let neural = inner.speech_dir().filter(|dir| speech_installed(dir) && load_runtime(&inner));
            if cfg!(debug_assertions) { eprintln!("[voz] hablando (neuronal: {}): «{text}»", neural.is_some()); }
            let cancelled = || inner.speech.load(Ordering::SeqCst) != turn;
            // Voz de nube, si está elegida y hay clave. Si no llega a sonar, se dice con la voz local.
            let config = lock(&inner.config).clone();
            let cloud_key = (config.speech == "elevenlabs").then(|| lock(&inner.app).clone()).flatten()
                .and_then(|app| crate::voice_keys::load(&app, "elevenlabs"));
            let mut said = false;
            if let Some(key) = cloud_key {
                match crate::voice_cloud::speak(&key, &config.cloud_voice, &text, cancelled) {
                    Ok(()) => { said = true; *lock(&inner.speech_error) = None; }
                    Err(crate::voice_cloud::Failure::Midway(error)) => { said = true; *lock(&inner.speech_error) = Some(error); }
                    Err(crate::voice_cloud::Failure::BeforeSound(error)) => { *lock(&inner.speech_error) = Some(error); }
                }
            }
            let result = if said { Ok(()) } else { crate::voice_speech::speak(&text, neural.as_deref(), cancelled) };
            if cfg!(debug_assertions) { eprintln!("[voz] terminó de hablar: {result:?}"); }
            // Si otra frase tomó el relevo, es ella la que cierra el turno.
            if inner.speech.load(Ordering::SeqCst) == turn {
                inner.speaking.store(false, Ordering::SeqCst);
                if *lock(&inner.phase) == "speaking" { inner.set_phase("idle"); }
            }
            result
        })
        .await
        .map_err(|e| e.to_string())?
    }
}

/// Corta lo que trex esté diciendo.
#[tauri::command]
pub fn voice_hush(state: State<'_, VoiceState>) {
    state.inner().0.speech.fetch_add(1, Ordering::SeqCst);
    state.inner().0.speaking.store(false, Ordering::SeqCst);
    if *lock(&state.inner().0.phase) == "speaking" { state.inner().0.set_phase("idle"); }
}

/// Empieza a dictar en un chat: desde ahora, lo que se oiga se escribe allí.
#[tauri::command]
pub fn voice_dictation_start(state: State<'_, VoiceState>, live: State<'_, crate::voice_live::LiveState>, target: String) -> Result<VoiceStatus, String> {
    let state = state.inner().clone();
    if !cfg!(windows) { return Err("El dictado solo funciona en Windows por ahora.".into()); }
    if target.is_empty() || target.len() > 128 { return Err("Chat no válido para dictar.".into()); }
    if live.active() { return Err("Hay una llamada en curso: cuelga para poder dictar.".into()); }
    if !state.0.models_dir().is_some_and(|dir| models_installed(&dir)) || !runtime_ready(&state.0) {
        return Err("Para dictar hacen falta los modelos de voz: descárgalos en Ajustes › Voz.".into());
    }
    *lock(&state.0.dictation) = Some(target);
    // Con el modo llamada apagado el motor no está corriendo: se enciende solo para dictar.
    if *lock(&state.0.phase) == "off" {
        start(&state);
        if let Some(error) = lock(&state.0.error).clone() {
            *lock(&state.0.dictation) = None;
            return Err(error);
        }
    }
    Ok(status_of(&state))
}

/// Deja de dictar. Si el motor solo estaba encendido para eso, se apaga solo.
#[tauri::command]
pub fn voice_dictation_stop(state: State<'_, VoiceState>) -> VoiceStatus {
    *lock(&state.inner().0.dictation) = None;
    status_of(state.inner())
}

/// Descarga el modelo del dictado (Whisper small). Solo se llama tras un clic explícito en Ajustes.
#[tauri::command]
pub async fn voice_download_dictation(state: State<'_, VoiceState>) -> Result<VoiceStatus, String> {
    let state = state.inner().clone();
    if state.0.downloading.swap(true, Ordering::SeqCst) {
        return Err("Ya hay una descarga de modelos de voz en curso.".into());
    }
    struct Guard(Arc<Inner>);
    impl Drop for Guard {
        fn drop(&mut self) { self.0.downloading.store(false, Ordering::SeqCst); }
    }
    let guard = Guard(state.0.clone());
    let target = state.0.dictation_dir().ok_or("No se encontró la carpeta de datos de la app.")?;
    let inner = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = guard;
        download_dictation(&inner, &target)
    })
    .await
    .map_err(|e| e.to_string())??;
    // El motor en marcha no conoce el modelo nuevo: se reinicia para que el próximo dictado lo use.
    if *lock(&state.0.phase) != "off" { start(&state); }
    Ok(status_of(&state))
}

/// Descarga los modelos. Solo se llama tras un clic explícito en Ajustes.
#[tauri::command]
pub async fn voice_download_models(state: State<'_, VoiceState>) -> Result<VoiceStatus, String> {
    let state = state.inner().clone();
    if state.0.downloading.swap(true, Ordering::SeqCst) {
        return Err("Ya hay una descarga de modelos de voz en curso.".into());
    }
    struct Guard(Arc<Inner>);
    impl Drop for Guard {
        fn drop(&mut self) { self.0.downloading.store(false, Ordering::SeqCst); }
    }
    let guard = Guard(state.0.clone());
    let listen = state.0.models_dir().ok_or("No se encontró la carpeta de datos de la app.")?;
    let speech = state.0.speech_dir().ok_or("No se encontró la carpeta de datos de la app.")?;
    let was_listening = models_installed(&listen) && runtime_ready(&state.0);
    let inner = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = guard;
        let runtime = inner.runtime_dir().filter(|_| cfg!(windows) && !runtime_ready(&inner));
        download_models(&inner, &listen, &speech, runtime.as_deref())
    })
    .await
    .map_err(|e| e.to_string())??;
    // Si ya estaba escuchando y solo se añadió la voz, no hace falta reiniciar el motor.
    if lock(&state.0.config).enabled && !was_listening { start(&state); }
    Ok(status_of(&state))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn voice_is_off_by_default() {
        let config = VoiceConfig::default();
        assert!(!config.enabled);
        assert!(config.raw_capture);
        assert_eq!(serde_json::from_str::<VoiceConfig>("{}").unwrap(), config);
    }

    #[test]
    fn model_list_is_pinned_and_https() {
        for file in MODEL_FILES {
            assert!(file.url.starts_with("https://"), "{}", file.name);
            assert_eq!(file.sha256.len(), 64, "{}", file.name);
            assert!(file.size > 0, "{}", file.name);
        }
        assert_eq!(total_bytes(), 161_253_144);
        assert!(SPEECH_ARCHIVE_URL.starts_with("https://"));
        assert_eq!(SPEECH_ARCHIVE_SHA256.len(), 64);
        for file in SPEECH_FILES {
            assert_eq!(file.sha256.len(), 64, "{}", file.name);
            assert!(file.size > 0, "{}", file.name);
        }
    }

    #[test]
    fn only_what_is_missing_gets_downloaded() {
        let dir = std::env::temp_dir().join(format!("trex-voice-pending-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let (listen, speech) = (dir.join("listen"), dir.join("speech"));
        std::fs::create_dir_all(&listen).unwrap();
        let (need_listen, need_speech, bytes) = pending_download(&listen, &speech, false);
        assert!(need_listen);
        assert_eq!(need_speech, cfg!(windows));
        assert_eq!(bytes, total_bytes() + if cfg!(windows) { SPEECH_ARCHIVE_SIZE } else { 0 });
        // Las bibliotecas de reconocimiento se suman cuando faltan.
        assert_eq!(pending_download(&listen, &speech, true).2, bytes + RUNTIME_ARCHIVE_SIZE);
        assert!(!runtime_installed(&dir));
        assert!(RUNTIME_ARCHIVE_URL.starts_with("https://") && RUNTIME_ARCHIVE_SHA256.len() == 64);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn models_count_as_installed_only_when_complete() {
        let dir = std::env::temp_dir().join(format!("trex-voice-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        assert!(!models_installed(&dir));
        // Un archivo con el nombre correcto pero otro tamaño no vale.
        for file in MODEL_FILES { std::fs::write(dir.join(file.name), b"x").unwrap(); }
        assert!(!models_installed(&dir));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
