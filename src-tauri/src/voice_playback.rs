//! Reproducción de voz en streaming (solo Windows).
//!
//! Las voces de nube mandan el audio a trozos mientras lo generan. Aquí se
//! encolan y suenan según llegan, y `clear` los corta al instante: es lo que
//! permite interrumpir a trex a mitad de frase.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

use windows::Win32::Media::Audio::{
    eConsole, eRender, IAudioClient, IAudioRenderClient, IMMDeviceEnumerator, MMDeviceEnumerator,
    AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM, AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
    WAVEFORMATEX,
};
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_MULTITHREADED};

struct Shared {
    queue: Mutex<VecDeque<i16>>,
    /// Pedido de corte: vaciar también lo que el dispositivo ya tiene en su búfer.
    flush: AtomicBool,
    /// Queda audio por sonar (en la cola o en el dispositivo).
    busy: AtomicBool,
    stop: AtomicBool,
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Una salida de audio mono de 16 bits. Al soltarla, el hilo de reproducción termina.
pub struct Playback(Arc<Shared>);

impl Playback {
    /// Abre la salida predeterminada para audio a `rate` Hz.
    pub fn start(rate: u32) -> Result<Self, String> {
        let shared = Arc::new(Shared {
            queue: Mutex::new(VecDeque::new()),
            flush: AtomicBool::new(false),
            busy: AtomicBool::new(false),
            stop: AtomicBool::new(false),
        });
        let (ready_tx, ready_rx) = mpsc::channel::<Result<(), String>>();
        let thread_shared = shared.clone();
        std::thread::Builder::new()
            .name("trex-voice-out".into())
            .spawn(move || {
                if let Err(error) = unsafe { run(rate, &thread_shared, &ready_tx) } {
                    let _ = ready_tx.send(Err(format!("No se pudo abrir la salida de audio: {error}")));
                }
            })
            .map_err(|e| e.to_string())?;
        ready_rx.recv().map_err(|_| "La salida de audio se cerró antes de empezar.".to_string())??;
        Ok(Self(shared))
    }

    /// Encola audio para que suene a continuación de lo que haya.
    pub fn push(&self, samples: &[i16]) {
        if samples.is_empty() { return; }
        lock(&self.0.queue).extend(samples.iter().copied());
        self.0.busy.store(true, Ordering::SeqCst);
    }

    /// Calla ya: descarta lo encolado y lo que el dispositivo aún no ha sonado.
    pub fn clear(&self) {
        lock(&self.0.queue).clear();
        self.0.flush.store(true, Ordering::SeqCst);
    }

    /// `true` mientras quede algo por sonar.
    pub fn pending(&self) -> bool {
        self.0.busy.load(Ordering::SeqCst)
    }
}

impl Drop for Playback {
    fn drop(&mut self) {
        self.0.stop.store(true, Ordering::SeqCst);
    }
}

unsafe fn run(rate: u32, shared: &Shared, ready: &mpsc::Sender<Result<(), String>>) -> windows::core::Result<()> {
    // El hilo puede venir ya inicializado: ese aviso no es un error.
    let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    let enumerator: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
    let device = enumerator.GetDefaultAudioEndpoint(eRender, eConsole)?;
    let client: IAudioClient = device.Activate(CLSCTX_ALL, None)?;
    // Windows convierte este formato al del dispositivo: no hay que remuestrear aquí.
    let format = WAVEFORMATEX {
        wFormatTag: 1, // PCM
        nChannels: 1,
        nSamplesPerSec: rate,
        nAvgBytesPerSec: rate * 2,
        nBlockAlign: 2,
        wBitsPerSample: 16,
        cbSize: 0,
    };
    // 200 ms de búfer: bastante para no entrecortarse y poco para cortar rápido.
    client.Initialize(
        AUDCLNT_SHAREMODE_SHARED,
        AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
        2_000_000,
        0,
        &format,
        None,
    )?;
    let capacity = client.GetBufferSize()?;
    let render: IAudioRenderClient = client.GetService()?;
    client.Start()?;
    let _ = ready.send(Ok(()));

    while !shared.stop.load(Ordering::SeqCst) {
        if shared.flush.swap(false, Ordering::SeqCst) {
            client.Stop()?;
            client.Reset()?;
            client.Start()?;
        }
        let padding = client.GetCurrentPadding()?;
        let free = capacity.saturating_sub(padding) as usize;
        let chunk: Vec<i16> = {
            let mut queue = lock(&shared.queue);
            let take = free.min(queue.len());
            queue.drain(..take).collect()
        };
        if !chunk.is_empty() {
            let buffer = render.GetBuffer(chunk.len() as u32)?;
            std::ptr::copy_nonoverlapping(chunk.as_ptr(), buffer as *mut i16, chunk.len());
            render.ReleaseBuffer(chunk.len() as u32, 0)?;
        } else if padding == 0 && lock(&shared.queue).is_empty() {
            shared.busy.store(false, Ordering::SeqCst);
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    let _ = client.Stop();
    Ok(())
}
