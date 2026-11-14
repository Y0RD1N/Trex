//! Captura del micrófono por defecto con WASAPI en modo "crudo" (solo Windows).
//!
//! El modo crudo se salta el procesado del controlador. En portátiles con
//! Intel Smart Sound el micrófono integrado aplica una puerta de ruido que
//! entrega silencio digital y se come el principio de cada frase; en crudo no.
//! Por eso no se usa una biblioteca de audio genérica: ninguna lo expone.

use std::sync::mpsc;
use std::time::Duration;

use windows::core::{HSTRING, PWSTR};
use windows::Win32::Devices::FunctionDiscovery::PKEY_Device_FriendlyName;
use windows::Win32::Media::Audio::{
    eCapture, eConsole, AudioCategory_Other, AudioClientProperties, IAudioCaptureClient,
    IAudioClient2, IMMDeviceEnumerator, MMDeviceEnumerator, AUDCLNT_SHAREMODE_SHARED,
    AUDCLNT_STREAMOPTIONS_NONE, AUDCLNT_STREAMOPTIONS_RAW, DEVICE_STATE_ACTIVE,
};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoTaskMemFree, CLSCTX_ALL, COINIT_MULTITHREADED, STGM_READ,
};

/// Un micrófono conectado, para elegirlo en Ajustes.
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Microphone {
    /// Identificador del dispositivo en Windows; es lo que se guarda.
    pub id: String,
    pub name: String,
    /// Es el que Windows tiene como entrada predeterminada.
    pub is_default: bool,
}

unsafe fn take_string(text: PWSTR) -> String {
    let value = text.to_string().unwrap_or_default();
    CoTaskMemFree(Some(text.0 as *const _));
    value
}

/// Micrófonos activos, con el predeterminado marcado.
pub fn list() -> Result<Vec<Microphone>, String> {
    unsafe { list_devices() }.map_err(|error| format!("No se pudieron listar los micrófonos: {error}"))
}

unsafe fn list_devices() -> windows::core::Result<Vec<Microphone>> {
    // El hilo puede venir ya inicializado: ese aviso no es un error.
    let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    let enumerator: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
    let default = match enumerator.GetDefaultAudioEndpoint(eCapture, eConsole) {
        Ok(device) => Some(take_string(device.GetId()?)),
        Err(_) => None,
    };
    let devices = enumerator.EnumAudioEndpoints(eCapture, DEVICE_STATE_ACTIVE)?;
    let mut list = Vec::new();
    for index in 0..devices.GetCount()? {
        let device = devices.Item(index)?;
        let id = take_string(device.GetId()?);
        let name = device.OpenPropertyStore(STGM_READ)
            .and_then(|store| store.GetValue(&PKEY_Device_FriendlyName))
            .map(|value| value.to_string())
            .unwrap_or_default();
        let is_default = default.as_deref() == Some(id.as_str());
        list.push(Microphone { name: if name.is_empty() { "Micrófono".into() } else { name }, id, is_default });
    }
    Ok(list)
}

/// Abre un micrófono en un hilo propio: el de `device` si sigue conectado y, si
/// no (o sin elegir), el predeterminado. Devuelve la frecuencia de muestreo y un
/// canal por el que llegan trozos de audio mono. El hilo termina solo cuando se
/// suelta el receptor.
pub fn start(raw: bool, device: Option<String>) -> Result<(u32, mpsc::Receiver<Vec<f32>>), String> {
    let (tx, rx) = mpsc::channel::<Vec<f32>>();
    let (ready_tx, ready_rx) = mpsc::channel::<Result<u32, String>>();
    std::thread::Builder::new()
        .name("trex-voice-mic".into())
        .spawn(move || {
            if let Err(error) = unsafe { run(raw, device.as_deref(), &tx, &ready_tx) } {
                let _ = ready_tx.send(Err(format!("No se pudo abrir el micrófono: {error}")));
            }
        })
        .map_err(|e| e.to_string())?;
    let rate = ready_rx
        .recv()
        .map_err(|_| "El micrófono se cerró antes de empezar.".to_string())??;
    Ok((rate, rx))
}

unsafe fn run(
    raw: bool,
    wanted: Option<&str>,
    tx: &mpsc::Sender<Vec<f32>>,
    ready: &mpsc::Sender<Result<u32, String>>,
) -> windows::core::Result<()> {
    CoInitializeEx(None, COINIT_MULTITHREADED).ok()?;
    let enumerator: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
    // Un micrófono elegido que ya no está (auriculares apagados) no deja a trex sordo.
    let chosen = wanted.filter(|id| !id.is_empty()).and_then(|id| enumerator.GetDevice(&HSTRING::from(id)).ok());
    let device = match chosen {
        Some(device) => device,
        None => enumerator.GetDefaultAudioEndpoint(eCapture, eConsole)?,
    };
    let client: IAudioClient2 = device.Activate(CLSCTX_ALL, None)?;

    let props = AudioClientProperties {
        cbSize: std::mem::size_of::<AudioClientProperties>() as u32,
        bIsOffload: false.into(),
        eCategory: AudioCategory_Other,
        Options: if raw {
            AUDCLNT_STREAMOPTIONS_RAW
        } else {
            AUDCLNT_STREAMOPTIONS_NONE
        },
    };
    client.SetClientProperties(&props)?;

    let format = client.GetMixFormat()?;
    let channels = (*format).nChannels as usize;
    let rate = (*format).nSamplesPerSec;
    let bits = (*format).wBitsPerSample;
    let tag = (*format).wFormatTag;
    // WAVE_FORMAT_EXTENSIBLE: el formato real es el primer campo del SubFormat.
    let kind = if tag == 0xFFFE {
        std::ptr::read_unaligned((format as *const u8).add(24) as *const u32)
    } else {
        tag as u32
    };
    let float = kind == 3;

    // Un segundo de búfer: el hilo lo vacía cada 20 ms.
    client.Initialize(AUDCLNT_SHAREMODE_SHARED, 0, 10_000_000, 0, format, None)?;
    let capture: IAudioCaptureClient = client.GetService()?;
    client.Start()?;
    let _ = ready.send(Ok(rate));

    loop {
        std::thread::sleep(Duration::from_millis(20));
        let mut mono: Vec<f32> = Vec::new();
        while capture.GetNextPacketSize()? > 0 {
            let mut data = std::ptr::null_mut();
            let mut frames = 0u32;
            let mut flags = 0u32;
            capture.GetBuffer(&mut data, &mut frames, &mut flags, None, None)?;
            for frame in 0..frames as usize {
                let mut sum = 0f32;
                for channel in 0..channels {
                    let i = frame * channels + channel;
                    sum += match (float, bits) {
                        (true, 32) => std::ptr::read_unaligned((data as *const f32).add(i)),
                        (false, 16) => {
                            std::ptr::read_unaligned((data as *const i16).add(i)) as f32 / 32768.0
                        }
                        (false, 32) => {
                            std::ptr::read_unaligned((data as *const i32).add(i)) as f32
                                / 2_147_483_648.0
                        }
                        _ => 0.0,
                    };
                }
                mono.push(sum / channels.max(1) as f32);
            }
            capture.ReleaseBuffer(frames)?;
        }
        if tx.send(mono).is_err() {
            let _ = client.Stop();
            return Ok(());
        }
    }
}
