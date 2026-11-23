//! Esfera de voz: la presencia de trex en pantalla mientras conversáis.
//!
//! Vive en una ventana propia (`orb.html`): transparente, sin bordes ni sombra,
//! siempre encima, fuera de la barra de tareas, sin foco y que deja pasar los
//! clics. Aparece cuando el motor confirma «oye trex», suena la activación, y se
//! va con el sonido de cierre cuando acaba la conversación.
//!
//! Mientras está a la vista, un hilo le manda 30 veces por segundo qué hace trex
//! (escucha, piensa o habla), el pico del micrófono y el de la voz de trex. Ese
//! último sale del medidor que Windows lleva de cada app: solo el sonido de este
//! proceso, no el de otras. Oculta, la esfera no recibe nada ni dibuja nada.
//!
//! Coste: la ventana se crea oculta al oír voz, como Whisper, para aparecer sin
//! retraso, y se destruye tras dos minutos sin uso. Desactivada, no existe.
use serde::Serialize;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

pub const LABEL: &str = "orb";
const EVENT_SHOW: &str = "orb://show";
const EVENT_FRAME: &str = "orb://frame";
/// Unos 30 fotogramas de datos por segundo mientras la esfera está a la vista.
const FRAME: Duration = Duration::from_millis(33);
/// Lo que dura la animación de cierre antes de ocultar la ventana.
const CLOSING: Duration = Duration::from_millis(750);
/// Sin usarse durante este tiempo, la ventana oculta se destruye.
const KEEP_WARM: Duration = Duration::from_secs(120);
const READY_WAIT: Duration = Duration::from_secs(3);
/// Lo que se espera a una ventana que otro hilo está creando antes de darla por perdida.
const CREATE_WAIT: Duration = Duration::from_secs(10);
/// Pico de la salida a partir del cual se considera que trex está sonando.
const VOICE_FLOOR: f32 = 0.015;
/// El micrófono se tapa mientras suena lo fuerte de la activación, no toda su cola.
#[cfg(windows)]
const CHIME_LOUD: Duration = Duration::from_millis(900);

pub const POSITIONS: &[&str] = &["corner", "center", "trex"];
pub const SIZES: &[&str] = &["small", "medium", "large"];

/// Lado de la ventana en puntos (píxeles lógicos).
pub fn size_points(size: &str) -> f64 {
    match size {
        "small" => 200.0,
        "large" => 320.0,
        _ => 260.0,
    }
}

/// Cómo se presenta la esfera: lo que se elige en Ajustes › Voz.
#[derive(Clone, Debug, PartialEq)]
pub struct Look {
    pub position: String,
    pub size: String,
    pub sounds: bool,
    /// Movimiento reducido elegido en trex (el de Windows lo mira la propia página).
    pub reduced: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mood {
    Listening,
    Thinking,
    Speaking,
}

impl Mood {
    pub fn name(self) -> &'static str {
        match self {
            Mood::Listening => "listening",
            Mood::Thinking => "thinking",
            Mood::Speaking => "speaking",
        }
    }
}

/// Lo que el motor de voz sabe en cada instante.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Signals {
    /// Queda ventana de conversación: trex acepta frases sin «oye trex».
    pub open: bool,
    /// Claude prepara una respuesta.
    pub thinking: bool,
    /// Whisper está transcribiendo una frase.
    pub transcribing: bool,
    /// Modo local: trex está diciendo algo.
    pub speaking: bool,
    /// Llamada en tiempo real: `Some(conectando)` mientras dura.
    pub live: Option<bool>,
    /// En la llamada, Gemini espera el resultado de una acción.
    pub live_tools: bool,
}

/// Qué enseña la esfera; `None` cuando la conversación terminó.
///
/// `voice_out` dice si ahora mismo suena la voz de trex: en la llamada en tiempo real
/// es la única forma de saber que Gemini habla.
pub fn mood(signals: &Signals, voice_out: bool) -> Option<Mood> {
    if let Some(connecting) = signals.live {
        return Some(if voice_out {
            Mood::Speaking
        } else if connecting || signals.live_tools {
            Mood::Thinking
        } else {
            Mood::Listening
        });
    }
    if signals.speaking {
        return Some(Mood::Speaking);
    }
    // Transcribir solo cuenta dentro de la conversación: fuera, lo que se oye no va con trex.
    if signals.thinking || (signals.transcribing && signals.open) {
        return Some(Mood::Thinking);
    }
    signals.open.then_some(Mood::Listening)
}

/// Un rectángulo en píxeles físicos.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

/// Esquina superior izquierda de la ventana de la esfera dentro del área útil del monitor.
pub fn placement(position: &str, side: u32, margin: i32, area: Rect, trex: Option<Rect>) -> (i32, i32) {
    let side = side as i32;
    let max_x = (area.x + area.width as i32 - side).max(area.x);
    let max_y = (area.y + area.height as i32 - side).max(area.y);
    let bottom = (max_y - margin).max(area.y);
    match (position, trex) {
        ("center", _) => (area.x + (area.width as i32 - side) / 2, bottom),
        ("trex", Some(window)) => (
            (window.x + (window.width as i32 - side) / 2).clamp(area.x, max_x),
            (window.y + (window.height as i32 - side) / 2).clamp(area.y, max_y),
        ),
        // La esquina inferior derecha, sobre la barra de tareas.
        _ => ((max_x - margin).max(area.x), bottom),
    }
}

#[derive(Clone, Serialize)]
struct Frame {
    /// "listening" | "thinking" | "speaking" | "closing"
    mood: &'static str,
    /// Pico del micrófono desde el fotograma anterior, de 0 a 1.
    mic: f32,
    /// Pico de la voz de trex, de 0 a 1.
    voice: f32,
}

#[derive(Clone, Serialize)]
struct Show {
    reduced: bool,
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[derive(Default)]
struct Shared {
    app: Mutex<Option<AppHandle>>,
    /// La esfera está a la vista (hay un hilo mandándole fotogramas).
    active: AtomicBool,
    /// La página de la esfera cargó y ya escucha sus eventos.
    ready: AtomicBool,
    creating: AtomicBool,
    /// Suena lo fuerte de un sonido de la esfera: el motor no escucha mientras tanto.
    chiming: AtomicBool,
    /// Hay un hilo vigilando cuándo destruir la ventana oculta.
    keeper: AtomicBool,
    used: Mutex<Option<Instant>>,
    /// Pico del micrófono desde el último fotograma (bits de un f32).
    mic: AtomicU32,
    /// Cambia al desactivar la esfera: el hilo en marcha se retira sin despedirse.
    generation: AtomicU64,
    /// trex se está cerrando: la ventana no vuelve a crearse.
    shut: AtomicBool,
}

#[derive(Clone, Default)]
pub struct Orb(Arc<Shared>);

#[cfg_attr(not(windows), allow(dead_code))]
impl Orb {
    pub fn set_app(&self, app: AppHandle) {
        *lock(&self.0.app) = Some(app);
    }

    fn app(&self) -> Option<AppHandle> {
        lock(&self.0.app).clone()
    }

    pub fn active(&self) -> bool {
        self.0.active.load(Ordering::SeqCst)
    }

    pub fn chiming(&self) -> bool {
        self.0.chiming.load(Ordering::SeqCst)
    }

    /// La página avisa de que ya escucha (también tras recargarse).
    pub fn mark_ready(&self) {
        self.0.ready.store(true, Ordering::SeqCst);
    }

    /// Pico de un tramo del micrófono. Solo se guarda con la esfera a la vista.
    pub fn feed_mic(&self, peak: f32) {
        if !self.active() {
            return;
        }
        // Con números positivos, el orden de los bits de un f32 es el de su valor.
        self.0.mic.fetch_max(peak.clamp(0.0, 1.0).to_bits(), Ordering::SeqCst);
    }

    fn touch(&self) {
        *lock(&self.0.used) = Some(Instant::now());
    }

    /// Alguien habla: la ventana se prepara oculta para aparecer al instante si le llaman.
    pub fn prewarm(&self) {
        self.touch();
        let Some(app) = self.app() else { return };
        // Se llama en cada tramo con voz: la creación se reserva aquí, antes de lanzar el hilo.
        if self.shut() || self.active() || app.get_webview_window(LABEL).is_some() || self.0.creating.swap(true, Ordering::SeqCst) {
            return;
        }
        let orb = self.clone();
        let spawned = std::thread::Builder::new().name("trex-orb-prewarm".into()).spawn(move || {
            if let Err(error) = create(&app) {
                if cfg!(debug_assertions) { eprintln!("[esfera] no se pudo preparar la ventana: {error}"); }
            }
            orb.0.creating.store(false, Ordering::SeqCst);
            // trex se cerró mientras se creaba: que no lo mantenga abierto.
            if orb.shut() { orb.destroy(&app); return; }
            orb.keep();
        });
        if spawned.is_err() {
            self.0.creating.store(false, Ordering::SeqCst);
        }
    }

    /// La ventana de la esfera: la que ya hay, la que se está preparando o una nueva.
    ///
    /// Una sola creación a la vez. Tauri solo rechaza una etiqueta repetida cuando la primera
    /// ventana ya existe: si «oye trex» llegaba mientras `prewarm` preparaba la ventana oculta,
    /// se creaban dos «orb», la esfera no se dibujaba y la otra quedaba huérfana y oculta,
    /// manteniendo trex vivo al cerrarlo.
    fn window(&self, app: &AppHandle) -> Result<WebviewWindow, String> {
        single_flight(&self.0.creating, || app.get_webview_window(LABEL), || create(app), CREATE_WAIT)
    }

    /// Enseña la esfera y la mantiene mientras `signals` diga que la conversación sigue.
    /// Devuelve `false` si ya estaba a la vista.
    pub fn wake(&self, look: Look, signals: impl Fn() -> Signals + Send + 'static) -> bool {
        let Some(app) = self.app() else { return false };
        if self.shut() || self.0.active.swap(true, Ordering::SeqCst) {
            return false;
        }
        self.0.mic.store(0, Ordering::SeqCst);
        let generation = self.0.generation.load(Ordering::SeqCst);
        let orb = self.clone();
        let spawned = std::thread::Builder::new()
            .name("trex-orb".into())
            .spawn(move || orb.run(&app, &look, signals, generation));
        if spawned.is_err() {
            self.0.active.store(false, Ordering::SeqCst);
            return false;
        }
        true
    }

    /// Desactivada en Ajustes: se retira ya, sin sonido, y la ventana se destruye.
    pub fn disable(&self) {
        self.0.generation.fetch_add(1, Ordering::SeqCst);
        if self.active() {
            return; // El hilo en marcha la destruye al salir.
        }
        if let Some(app) = self.app() {
            let orb = self.clone();
            // Fuera del hilo principal: destruir una ventana desde un comando síncrono puede bloquearlo.
            let _ = std::thread::Builder::new().name("trex-orb-close".into()).spawn(move || orb.destroy(&app));
        }
    }

    fn shut(&self) -> bool {
        self.0.shut.load(Ordering::SeqCst)
    }

    /// trex se cierra: la esfera desaparece ya y no vuelve a crearse. Desde el hilo principal.
    pub fn shutdown(&self) {
        self.0.shut.store(true, Ordering::SeqCst);
        self.0.generation.fetch_add(1, Ordering::SeqCst);
        if let Some(app) = self.app() {
            self.destroy(&app);
        }
    }

    fn destroy(&self, app: &AppHandle) {
        if let Some(window) = app.get_webview_window(LABEL) {
            let _ = window.destroy();
        }
        self.0.ready.store(false, Ordering::SeqCst);
    }

    fn run(&self, app: &AppHandle, look: &Look, signals: impl Fn() -> Signals, generation: u64) {
        let window = match self.window(app) {
            Ok(window) => window,
            Err(error) => {
                if cfg!(debug_assertions) { eprintln!("[esfera] no se pudo abrir la ventana: {error}"); }
                self.0.active.store(false, Ordering::SeqCst);
                return;
            }
        };
        place(app, &window, look);
        let waiting = Instant::now();
        while !self.0.ready.load(Ordering::SeqCst) && waiting.elapsed() < READY_WAIT {
            std::thread::sleep(Duration::from_millis(15));
        }
        let _ = app.emit_to(LABEL, EVENT_SHOW, Show { reduced: look.reduced });
        let _ = window.show();
        // Algunas versiones de Windows olvidan estos ajustes al mostrar la ventana.
        let _ = window.set_ignore_cursor_events(true);
        let _ = window.set_always_on_top(true);
        if look.sounds {
            self.chime(crate::voice_chime::Chime::Wake);
        }

        #[cfg(windows)]
        let mut meter = meter::OutputMeter::new();
        let mut loud_at: Option<Instant> = None;
        let (mut frames, mut loudest) = (0u32, 0f32);
        loop {
            if self.0.generation.load(Ordering::SeqCst) != generation {
                break;
            }
            let now = signals();
            #[cfg(windows)]
            let voice = meter.peak();
            #[cfg(not(windows))]
            let voice = 0f32;
            frames += 1;
            if voice > VOICE_FLOOR {
                loud_at = Some(Instant::now());
            }
            let voice_out = !self.chiming() && loud_at.is_some_and(|at| at.elapsed() < Duration::from_millis(350));
            let Some(mood) = mood(&now, voice_out) else { break };
            if mood == Mood::Speaking {
                loudest = loudest.max(voice);
            }
            let mic = f32::from_bits(self.0.mic.swap(0, Ordering::SeqCst));
            let _ = app.emit_to(LABEL, EVENT_FRAME, Frame { mood: mood.name(), mic: mic.min(1.0), voice: voice.min(1.0) });
            std::thread::sleep(FRAME);
        }
        if cfg!(debug_assertions) { eprintln!("[esfera] se va tras {frames} fotogramas; pico de la voz de trex mientras hablaba: {loudest:.2}"); }

        if self.0.generation.load(Ordering::SeqCst) != generation {
            // Desactivada en Ajustes: fuera sin despedida.
            self.destroy(app);
        } else {
            let _ = app.emit_to(LABEL, EVENT_FRAME, Frame { mood: "closing", mic: 0.0, voice: 0.0 });
            if look.sounds {
                self.chime(crate::voice_chime::Chime::Close);
            }
            std::thread::sleep(CLOSING);
            let _ = window.hide();
        }
        self.touch();
        self.0.active.store(false, Ordering::SeqCst);
        self.keep();
    }

    #[cfg(windows)]
    fn chime(&self, chime: crate::voice_chime::Chime) {
        self.0.chiming.store(true, Ordering::SeqCst);
        let _ = std::thread::Builder::new().name("trex-orb-chime".into()).spawn(move || {
            if let Err(error) = crate::voice_chime::play(chime) {
                if cfg!(debug_assertions) { eprintln!("[esfera] no sonó {chime:?}: {error}"); }
            }
        });
        let orb = self.clone();
        let _ = std::thread::Builder::new().name("trex-orb-chime-ear".into()).spawn(move || {
            std::thread::sleep(CHIME_LOUD);
            orb.0.chiming.store(false, Ordering::SeqCst);
        });
    }

    #[cfg(not(windows))]
    fn chime(&self, _chime: crate::voice_chime::Chime) {}

    /// Un solo hilo dormido destruye la ventana oculta tras `KEEP_WARM` sin uso.
    fn keep(&self) {
        if self.0.keeper.swap(true, Ordering::SeqCst) {
            return;
        }
        let orb = self.clone();
        let spawned = std::thread::Builder::new().name("trex-orb-keeper".into()).spawn(move || loop {
            std::thread::sleep(Duration::from_secs(15));
            let Some(app) = orb.app() else { continue };
            if app.get_webview_window(LABEL).is_none() {
                orb.0.keeper.store(false, Ordering::SeqCst);
                return;
            }
            let idle = lock(&orb.0.used).is_none_or(|used| used.elapsed() >= KEEP_WARM);
            if !orb.active() && !orb.0.creating.load(Ordering::SeqCst) && idle {
                if cfg!(debug_assertions) { eprintln!("[esfera] ventana liberada tras {} s sin uso", KEEP_WARM.as_secs()); }
                orb.destroy(&app);
                orb.0.keeper.store(false, Ordering::SeqCst);
                return;
            }
        });
        if spawned.is_err() {
            self.0.keeper.store(false, Ordering::SeqCst);
        }
    }
}

/// Lo que hay (`existing`) o lo que crea `create`, sin crear nunca dos a la vez: quien llega
/// mientras otro crea espera a que termine (como mucho `wait`) y se queda con lo suyo.
fn single_flight<T>(
    creating: &AtomicBool,
    existing: impl Fn() -> Option<T>,
    create: impl FnOnce() -> Result<T, String>,
    wait: Duration,
) -> Result<T, String> {
    let started = Instant::now();
    loop {
        if let Some(found) = existing() {
            return Ok(found);
        }
        if !creating.swap(true, Ordering::SeqCst) {
            // Pudo terminar otra creación justo entre la consulta y el turno.
            let made = existing().map(Ok).unwrap_or_else(create);
            creating.store(false, Ordering::SeqCst);
            return made;
        }
        if started.elapsed() >= wait {
            return Err("la ventana de la esfera tarda demasiado en prepararse".into());
        }
        std::thread::sleep(Duration::from_millis(15));
    }
}

fn create(app: &AppHandle) -> Result<WebviewWindow, String> {
    if let Some(window) = app.get_webview_window(LABEL) {
        return Ok(window);
    }
    let side = size_points("medium");
    let builder = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("orb.html".into()));
    // En macOS la transparencia exige la API privada de Tauri, que trex no activa; allí
    // la voz (y con ella la esfera) aún no existe.
    #[cfg(not(target_os = "macos"))]
    let builder = builder.transparent(true);
    let window = builder
        .title("trex")
        .inner_size(side, side)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .decorations(false)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .focusable(false)
        .focused(false)
        .visible(false)
        .background_color(tauri::window::Color(0, 0, 0, 0))
        .build()
        .map_err(|error| error.to_string())?;
    let _ = window.set_ignore_cursor_events(true);
    Ok(window)
}

/// Pone la ventana en el monitor donde está trex (o en el principal si trex está minimizado).
fn place(app: &AppHandle, window: &WebviewWindow, look: &Look) {
    let main = app.get_webview_window("main")
        .filter(|main| main.is_visible().unwrap_or(false) && !main.is_minimized().unwrap_or(false));
    let monitor = main.as_ref().and_then(|main| main.current_monitor().ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten());
    let Some(monitor) = monitor else { return };
    let scale = monitor.scale_factor();
    let side = (size_points(&look.size) * scale).round() as u32;
    let margin = (16.0 * scale).round() as i32;
    let work = monitor.work_area();
    let area = Rect { x: work.position.x, y: work.position.y, width: work.size.width, height: work.size.height };
    let trex = main.as_ref().and_then(|main| {
        let (position, size) = (main.outer_position().ok()?, main.outer_size().ok()?);
        Some(Rect { x: position.x, y: position.y, width: size.width, height: size.height })
    });
    let (x, y) = placement(&look.position, side, margin, area, trex);
    let _ = window.set_position(PhysicalPosition::new(x, y));
    let _ = window.set_size(PhysicalSize::new(side, side));
}

/// Medidor de pico del sonido de este proceso (solo Windows).
#[cfg(windows)]
mod meter {
    use std::time::{Duration, Instant};
    use windows::core::Interface;
    use windows::Win32::Media::Audio::Endpoints::IAudioMeterInformation;
    use windows::Win32::Media::Audio::{
        eConsole, eRender, IAudioSessionControl2, IAudioSessionManager2, IMMDeviceEnumerator, MMDeviceEnumerator,
    };
    use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_MULTITHREADED};

    /// Cada cuánto se vuelven a buscar las sesiones de audio: una voz nueva abre la suya.
    const REFRESH: Duration = Duration::from_millis(800);

    pub struct OutputMeter {
        meters: Vec<IAudioMeterInformation>,
        found: Option<Instant>,
    }

    impl OutputMeter {
        pub fn new() -> Self {
            // El hilo puede venir ya inicializado: ese aviso no es un error.
            let _ = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
            Self { meters: Vec::new(), found: None }
        }

        fn find() -> windows::core::Result<Vec<IAudioMeterInformation>> {
            unsafe {
                let enumerator: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
                let device = enumerator.GetDefaultAudioEndpoint(eRender, eConsole)?;
                let manager: IAudioSessionManager2 = device.Activate(CLSCTX_ALL, None)?;
                let sessions = manager.GetSessionEnumerator()?;
                let me = std::process::id();
                let mut meters = Vec::new();
                for index in 0..sessions.GetCount()? {
                    let Ok(control) = sessions.GetSession(index) else { continue };
                    let Ok(owner) = control.cast::<IAudioSessionControl2>() else { continue };
                    if owner.GetProcessId().ok() != Some(me) {
                        continue;
                    }
                    if let Ok(meter) = control.cast::<IAudioMeterInformation>() {
                        meters.push(meter);
                    }
                }
                Ok(meters)
            }
        }

        /// Pico del sonido de trex ahora mismo, de 0 a 1.
        pub fn peak(&mut self) -> f32 {
            if self.found.is_none_or(|at| at.elapsed() >= REFRESH) {
                self.meters = Self::find().unwrap_or_default();
                self.found = Some(Instant::now());
            }
            self.meters.iter().filter_map(|meter| unsafe { meter.GetPeakValue() }.ok()).fold(0.0, f32::max)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_local_conversation_listens_thinks_speaks_and_ends() {
        let open = Signals { open: true, ..Default::default() };
        assert_eq!(mood(&open, false), Some(Mood::Listening));
        assert_eq!(mood(&Signals { transcribing: true, ..open }, false), Some(Mood::Thinking));
        assert_eq!(mood(&Signals { thinking: true, ..open }, false), Some(Mood::Thinking));
        assert_eq!(mood(&Signals { speaking: true, thinking: true, ..open }, false), Some(Mood::Speaking));
        // Claude puede tardar más que la ventana de conversación: la esfera sigue pensando.
        assert_eq!(mood(&Signals { thinking: true, ..Default::default() }, false), Some(Mood::Thinking));
        assert_eq!(mood(&Signals::default(), false), None);
        // Fuera de la conversación, una frase que se transcribe no la mantiene viva.
        assert_eq!(mood(&Signals { transcribing: true, ..Default::default() }, false), None);
    }

    #[test]
    fn in_a_live_call_the_voice_decides_who_is_talking() {
        let call = Signals { live: Some(false), ..Default::default() };
        assert_eq!(mood(&Signals { live: Some(true), ..Default::default() }, false), Some(Mood::Thinking));
        assert_eq!(mood(&call, false), Some(Mood::Listening));
        assert_eq!(mood(&call, true), Some(Mood::Speaking));
        assert_eq!(mood(&Signals { live_tools: true, ..call }, false), Some(Mood::Thinking));
        // Sin ventana de conversación, la llamada sigue mientras esté abierta.
        assert!(mood(&call, false).is_some());
    }

    #[test]
    fn the_window_sits_inside_the_work_area() {
        let area = Rect { x: 0, y: 0, width: 1920, height: 1032 };
        assert_eq!(placement("corner", 260, 16, area, None), (1920 - 260 - 16, 1032 - 260 - 16));
        assert_eq!(placement("center", 260, 16, area, None), ((1920 - 260) / 2, 1032 - 260 - 16));
        let trex = Rect { x: 100, y: 50, width: 1280, height: 820 };
        assert_eq!(placement("trex", 260, 16, area, Some(trex)), (100 + (1280 - 260) / 2, 50 + (820 - 260) / 2));
        // Sin la ventana de trex a la vista, a la esquina.
        assert_eq!(placement("trex", 260, 16, area, None), placement("corner", 260, 16, area, None));
        // Con trex casi fuera de la pantalla, la esfera no se sale.
        let off = Rect { x: 1800, y: -400, width: 1280, height: 820 };
        assert_eq!(placement("trex", 260, 16, area, Some(off)), (1920 - 260, 0));
        // Un segundo monitor a la izquierda, con coordenadas negativas y escala 1,5.
        let left = Rect { x: -2560, y: 0, width: 2560, height: 1392 };
        assert_eq!(placement("corner", 390, 24, left, None), (-2560 + 2560 - 390 - 24, 1392 - 390 - 24));
    }

    #[test]
    fn only_one_window_is_created_when_several_threads_ask_at_once() {
        use std::sync::atomic::AtomicUsize;
        use std::sync::Barrier;
        let creating = Arc::new(AtomicBool::new(false));
        let made = Arc::new(AtomicUsize::new(0));
        let registry: Arc<Mutex<Option<usize>>> = Arc::new(Mutex::new(None));
        let barrier = Arc::new(Barrier::new(4));
        let threads: Vec<_> = (0..4).map(|_| {
            let (creating, made, registry, barrier) = (creating.clone(), made.clone(), registry.clone(), barrier.clone());
            std::thread::spawn(move || {
                barrier.wait();
                single_flight(&creating, || *lock(&registry), || {
                    // Como una ventana de Tauri: tarda en crearse y solo después se puede encontrar.
                    let id = made.fetch_add(1, Ordering::SeqCst);
                    std::thread::sleep(Duration::from_millis(80));
                    *lock(&registry) = Some(id);
                    Ok(id)
                }, Duration::from_secs(5))
            })
        }).collect();
        let windows: Vec<usize> = threads.into_iter().map(|thread| thread.join().unwrap().unwrap()).collect();
        assert_eq!(made.load(Ordering::SeqCst), 1, "una sola ventana «orb»");
        assert!(windows.iter().all(|window| *window == windows[0]));
        assert!(!creating.load(Ordering::SeqCst));
    }

    #[test]
    fn a_window_being_prepared_is_awaited_and_a_failure_frees_the_turn() {
        // `prewarm` reservó la creación y la ventana aún no existe: «oye trex» la espera.
        let creating = AtomicBool::new(true);
        let registry = Mutex::new(None);
        std::thread::scope(|scope| {
            scope.spawn(|| {
                std::thread::sleep(Duration::from_millis(60));
                *lock(&registry) = Some(7);
                creating.store(false, Ordering::SeqCst);
            });
            let got = single_flight(&creating, || *lock(&registry), || Ok(99), Duration::from_secs(5));
            assert_eq!(got, Ok(7), "usa la ventana preparada en vez de crear otra");
        });
        // Una creación que falla deja el turno libre para la siguiente.
        let creating = AtomicBool::new(false);
        assert!(single_flight(&creating, || None::<u8>, || Err("sin ventana".into()), Duration::from_secs(1)).is_err());
        assert!(!creating.load(Ordering::SeqCst));
        // Una reserva que nunca se suelta no cuelga a quien espera.
        let stuck = AtomicBool::new(true);
        assert!(single_flight(&stuck, || None::<u8>, || Ok(1), Duration::from_millis(50)).is_err());
    }

    #[test]
    fn sizes_and_positions_have_safe_defaults() {
        assert_eq!(size_points("small"), 200.0);
        assert_eq!(size_points("large"), 320.0);
        assert_eq!(size_points("cualquiera"), 260.0);
        assert!(POSITIONS.contains(&"corner") && SIZES.contains(&"medium"));
    }
}
