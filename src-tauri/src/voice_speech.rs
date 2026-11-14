//! Voz de trex (solo Windows).
//!
//! Con la voz neuronal instalada (Supertonic 3, local) el texto se sintetiza
//! frase a frase: la primera empieza a sonar mientras se generan las demás. Sin
//! ella, o si falla, se usa el sintetizador que trae Windows. Nada sale a la red.

use std::path::Path;
use std::sync::{mpsc, Mutex};
use std::time::{Duration, Instant};

use sherpa_onnx::{GenerationConfig, OfflineTts, OfflineTtsConfig, OfflineTtsModelConfig, OfflineTtsSupertonicModelConfig};
use windows::core::{Interface, HSTRING};
use windows::Media::Core::MediaSource;
use windows::Media::Playback::{MediaPlaybackState, MediaPlayer};
use windows::Media::SpeechSynthesis::{SpeechSynthesizer, VoiceInformation};
use windows::Storage::Streams::{DataWriter, IRandomAccessStream, InMemoryRandomAccessStream};
use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};

/// Tope por si la reproducción nunca avisa de que terminó.
const MAX_SPEECH: Duration = Duration::from_secs(120);
/// La voz elegida de las diez que trae el modelo.
const NEURAL_VOICE: i32 = 9;

/// El modelo tarda alrededor de un segundo en cargar: se conserva entre frases.
static NEURAL: Mutex<Option<OfflineTts>> = Mutex::new(None);

/// Lee `text` y vuelve cuando termina de sonar, o antes si `cancelled` pasa a dar `true`.
pub fn speak(text: &str, neural: Option<&Path>, cancelled: impl Fn() -> bool + Sync) -> Result<(), String> {
    // El hilo puede venir ya inicializado: ese aviso no es un error.
    let _ = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
    if let Some(models) = neural {
        match speak_neural(text, models, &cancelled) {
            Ok(()) => return Ok(()),
            // Sin haber dicho nada todavía: se intenta con la voz del sistema.
            Err(Failure::BeforeSound) => {}
            Err(Failure::Midway(error)) => return Err(error),
        }
    }
    speak_system(text, &cancelled).map_err(|error| format!("No se pudo reproducir la voz: {error}"))
}

enum Failure {
    BeforeSound,
    Midway(String),
}

fn path(dir: &Path, name: &str) -> Option<String> {
    Some(dir.join(name).to_string_lossy().into_owned())
}

fn load_neural(models: &Path) -> Option<OfflineTts> {
    OfflineTts::create(&OfflineTtsConfig {
        model: OfflineTtsModelConfig {
            supertonic: OfflineTtsSupertonicModelConfig {
                duration_predictor: path(models, "duration_predictor.int8.onnx"),
                text_encoder: path(models, "text_encoder.int8.onnx"),
                vector_estimator: path(models, "vector_estimator.int8.onnx"),
                vocoder: path(models, "vocoder.int8.onnx"),
                tts_json: path(models, "tts.json"),
                unicode_indexer: path(models, "unicode_indexer.bin"),
                voice_style: path(models, "voice.bin"),
            },
            num_threads: 4,
            ..Default::default()
        },
        max_num_sentences: 1,
        ..Default::default()
    })
}

fn speak_neural(text: &str, models: &Path, cancelled: &(impl Fn() -> bool + Sync)) -> Result<(), Failure> {
    let sentences = split_sentences(text);
    let (tx, rx) = mpsc::channel::<Option<Vec<u8>>>();
    std::thread::scope(|scope| {
        // Un hilo genera; este reproduce. Así la segunda frase se prepara mientras suena la primera.
        scope.spawn(move || {
            let mut engine = NEURAL.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            if engine.is_none() { *engine = load_neural(models); }
            let Some(tts) = engine.as_ref() else { let _ = tx.send(None); return };
            let config = GenerationConfig {
                sid: NEURAL_VOICE,
                extra: Some(std::collections::HashMap::from([("lang".to_string(), serde_json::json!("es"))])),
                ..Default::default()
            };
            for sentence in &sentences {
                if cancelled() { return; }
                let wav = tts
                    .generate_with_config(sentence, &config, None::<fn(&[f32], f32) -> bool>)
                    .filter(|audio| !audio.samples().is_empty())
                    .map(|audio| wav_bytes(audio.samples(), audio.sample_rate() as u32));
                let failed = wav.is_none();
                if tx.send(wav).is_err() || failed { return; }
            }
        });

        let mut played = false;
        for wav in rx {
            let Some(wav) = wav else {
                return Err(if played { Failure::Midway("La voz de trex falló a mitad de la frase.".into()) } else { Failure::BeforeSound });
            };
            if cancelled() { return Ok(()); }
            match play_wav(&wav, cancelled) {
                Ok(()) => played = true,
                Err(_) if !played => return Err(Failure::BeforeSound),
                Err(error) => return Err(Failure::Midway(format!("No se pudo reproducir la voz: {error}"))),
            }
        }
        Ok(())
    })
}

/// Parte el texto en frases para empezar a hablar cuanto antes. Los trozos muy
/// cortos se unen al siguiente: una frase de dos palabras suena entrecortada.
pub fn split_sentences(text: &str) -> Vec<String> {
    let mut sentences: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut chars = text.trim().chars().peekable();
    while let Some(c) = chars.next() {
        current.push(c);
        let ends = matches!(c, '.' | '!' | '?' | '…') && chars.peek().is_none_or(|next| next.is_whitespace());
        if ends && current.trim().chars().count() >= 24 {
            sentences.push(current.trim().to_string());
            current.clear();
        }
    }
    let rest = current.trim();
    if !rest.is_empty() {
        // Un final corto se pega a la frase anterior en vez de sonar suelto.
        match sentences.last_mut() {
            Some(last) if rest.chars().count() < 24 => { last.push(' '); last.push_str(rest); }
            _ => sentences.push(rest.to_string()),
        }
    }
    sentences
}

/// WAV mono de 16 bits en memoria.
fn wav_bytes(samples: &[f32], rate: u32) -> Vec<u8> {
    let data = samples.len() as u32 * 2;
    let mut wav = Vec::with_capacity(44 + data as usize);
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&(36 + data).to_le_bytes());
    wav.extend_from_slice(b"WAVEfmt ");
    wav.extend_from_slice(&16u32.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes());
    wav.extend_from_slice(&rate.to_le_bytes());
    wav.extend_from_slice(&(rate * 2).to_le_bytes());
    wav.extend_from_slice(&2u16.to_le_bytes());
    wav.extend_from_slice(&16u16.to_le_bytes());
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&data.to_le_bytes());
    for sample in samples {
        wav.extend_from_slice(&((sample.clamp(-1.0, 1.0) * 32767.0) as i16).to_le_bytes());
    }
    wav
}

fn play_wav(wav: &[u8], cancelled: &impl Fn() -> bool) -> windows::core::Result<()> {
    let stream = InMemoryRandomAccessStream::new()?;
    let writer = DataWriter::CreateDataWriter(&stream)?;
    writer.WriteBytes(wav)?;
    writer.StoreAsync()?.join()?;
    writer.DetachStream()?;
    let stream: IRandomAccessStream = stream.cast()?;
    stream.Seek(0)?;
    play(&MediaSource::CreateFromStream(&stream, &HSTRING::from("audio/wav"))?, cancelled)
}

fn spanish_voice() -> Option<VoiceInformation> {
    let voices = SpeechSynthesizer::AllVoices().ok()?;
    voices.into_iter().find(|voice| {
        voice.Language().is_ok_and(|language| language.to_string().to_lowercase().starts_with("es"))
    })
}

fn speak_system(text: &str, cancelled: &impl Fn() -> bool) -> windows::core::Result<()> {
    let synthesizer = SpeechSynthesizer::new()?;
    if let Some(voice) = spanish_voice() {
        synthesizer.SetVoice(&voice)?;
    }
    let stream = synthesizer.SynthesizeTextToStreamAsync(&HSTRING::from(text))?.join()?;
    play(&MediaSource::CreateFromStream(&stream, &stream.ContentType()?)?, cancelled)
}

fn play(source: &MediaSource, cancelled: &impl Fn() -> bool) -> windows::core::Result<()> {
    let player = MediaPlayer::new()?;
    player.SetSource(source)?;
    player.Play()?;
    let session = player.PlaybackSession()?;
    let start = Instant::now();
    let mut started = false;
    while start.elapsed() < MAX_SPEECH && !cancelled() {
        std::thread::sleep(Duration::from_millis(40));
        let state = session.PlaybackState()?;
        if state == MediaPlaybackState::Playing {
            started = true;
        } else if started && (state == MediaPlaybackState::Paused || state == MediaPlaybackState::None) {
            break;
        } else if !started && start.elapsed() > Duration::from_secs(5) {
            break;
        }
    }
    player.Close()
}

#[cfg(test)]
mod tests {
    use super::{split_sentences, wav_bytes};

    #[test]
    fn splits_into_sentences_and_joins_short_pieces() {
        assert_eq!(
            split_sentences("Anoche Claude terminó el lector sin conexión. Los tests pasan. Queda pendiente revisar un permiso en trex."),
            vec!["Anoche Claude terminó el lector sin conexión.", "Los tests pasan. Queda pendiente revisar un permiso en trex."]
        );
        assert_eq!(split_sentences("Hecho."), vec!["Hecho."]);
        assert_eq!(split_sentences("  "), Vec::<String>::new());
        // Un punto dentro de un número o un nombre de archivo no corta la frase.
        assert_eq!(split_sentences("Subió a la versión 0.5.0 de trex y nada más."), vec!["Subió a la versión 0.5.0 de trex y nada más."]);
        // Un final corto se une a la frase anterior.
        assert_eq!(
            split_sentences("Abro una sesión de Claude Code en mangi. Listo."),
            vec!["Abro una sesión de Claude Code en mangi. Listo."]
        );
    }

    #[test]
    fn wav_header_matches_the_audio() {
        let wav = wav_bytes(&[0.0, 1.0, -1.0, 2.0], 44_100);
        assert_eq!(wav.len(), 44 + 8);
        assert_eq!(&wav[0..4], b"RIFF");
        assert_eq!(u32::from_le_bytes(wav[24..28].try_into().unwrap()), 44_100);
        assert_eq!(u32::from_le_bytes(wav[40..44].try_into().unwrap()), 8);
        // Fuera de rango se recorta en vez de dar la vuelta.
        assert_eq!(i16::from_le_bytes(wav[50..52].try_into().unwrap()), 32767);
    }
}
