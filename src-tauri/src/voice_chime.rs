//! Sonidos de la esfera de voz: activación y cierre.
//!
//! No hay archivos de audio: se sintetizan aquí, siempre iguales. La activación es
//! un barrido grave que sube bajo dos notas de cristal en quinta (mi y si, con
//! parciales algo inarmónicos) y un soplo de aire filtrado; el cierre, las mismas
//! notas bajando y más suaves. Una reverberación corta les da cuerpo y el pico
//! queda en −6 dBFS para que no asusten.

/// Frecuencia de muestreo de los sonidos.
pub const RATE: u32 = 48_000;
/// Pico de la mezcla final (−6 dBFS).
const PEAK: f32 = 0.5;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Chime {
    Wake,
    Close,
}

fn seconds(value: f32) -> usize {
    (value * RATE as f32) as usize
}

/// Nota de cristal: cinco parciales que se apagan antes cuanto más agudos.
fn bell(buffer: &mut [f32], start: f32, freq: f32, duration: f32, gain: f32) {
    const PARTIALS: [(f32, f32); 5] = [(1.0, 1.0), (2.01, 0.35), (3.0, 0.16), (4.17, 0.08), (5.43, 0.05)];
    let attack = 0.006;
    let from = seconds(start);
    for (ratio, amp) in PARTIALS {
        let decay = duration / (1.0 + ratio * 0.6);
        let step = std::f32::consts::TAU * freq * ratio / RATE as f32;
        let mut phase = 0f32;
        for i in 0..seconds(decay) {
            let Some(sample) = buffer.get_mut(from + i) else { break };
            let t = i as f32 / RATE as f32;
            let envelope = if t < attack { t / attack } else { (0.0001f32.ln() * (t - attack) / (decay - attack)).exp() };
            *sample += phase.sin() * amp * envelope * gain;
            phase = (phase + step) % std::f32::consts::TAU;
        }
    }
}

/// Barrido grave de `from_hz` a `to_hz`, con su segundo armónico para que se oiga en altavoces pequeños.
fn sweep(buffer: &mut [f32], start: f32, from_hz: f32, to_hz: f32, duration: f32, gain: f32) {
    let from = seconds(start);
    let glide = duration * 0.6;
    let mut phase = 0f32;
    // Paso bajo de un polo hacia 520 Hz: redondea el armónico.
    let alpha = 1.0 - (-std::f32::consts::TAU * 520.0 / RATE as f32).exp();
    let mut low = 0f32;
    for i in 0..seconds(duration) {
        let Some(sample) = buffer.get_mut(from + i) else { break };
        let t = i as f32 / RATE as f32;
        let freq = from_hz * (to_hz / from_hz).powf((t / glide).min(1.0));
        phase = (phase + std::f32::consts::TAU * freq / RATE as f32) % (std::f32::consts::TAU * 2.0);
        let envelope = if t < 0.05 { 0.0001 * (gain / 0.0001).powf(t / 0.05) } else { gain * (0.0001f32 / gain).powf((t - 0.05) / (duration - 0.05)) };
        let raw = phase.sin() + 0.35 * (2.0 * phase).sin();
        low += alpha * (raw - low);
        *sample += low * envelope;
    }
}

/// Ruido filtrado por un pasa banda que se desliza de `from_hz` a `to_hz`.
fn air(buffer: &mut [f32], start: f32, duration: f32, gain: f32, from_hz: f32, to_hz: f32) {
    let from = seconds(start);
    let mut seed = 0x2545_f491u32;
    let (mut low, mut band) = (0f32, 0f32);
    for i in 0..seconds(duration) {
        let Some(sample) = buffer.get_mut(from + i) else { break };
        let t = i as f32 / RATE as f32;
        seed ^= seed << 13;
        seed ^= seed >> 17;
        seed ^= seed << 5;
        let noise = seed as f32 / u32::MAX as f32 * 2.0 - 1.0;
        let freq = from_hz * (to_hz / from_hz).powf(t / duration);
        // Filtro de variables de estado (Chamberlin), Q ≈ 1,2.
        let f = 2.0 * (std::f32::consts::PI * freq / RATE as f32).sin();
        let high = noise - low - band / 1.2;
        band += f * high;
        low += f * band;
        let rise = duration * 0.45;
        let envelope = if t < rise { 0.0001 * (gain / 0.0001).powf(t / rise) } else { gain * (0.0001f32 / gain).powf((t - rise) / (duration - rise)) };
        *sample += band * envelope;
    }
}

/// Reverberación de Schroeder: cuatro peines en paralelo y dos pasa todo en serie.
fn reverb(dry: &[f32]) -> Vec<f32> {
    let scale = RATE as f32 / 44_100.0;
    let mut wet = vec![0f32; dry.len()];
    for delay in [1557, 1617, 1491, 1422] {
        let delay = (delay as f32 * scale) as usize;
        let mut line = vec![0f32; delay];
        let mut damp = 0f32;
        for (i, &input) in dry.iter().enumerate() {
            let out = line[i % delay];
            damp = out * 0.75 + damp * 0.25;
            line[i % delay] = input + damp * 0.78;
            wet[i] += out * 0.25;
        }
    }
    for delay in [556, 441] {
        let delay = (delay as f32 * scale) as usize;
        let mut line = vec![0f32; delay];
        for (i, sample) in wet.iter_mut().enumerate() {
            let buffered = line[i % delay];
            line[i % delay] = *sample + buffered * 0.5;
            *sample = buffered - *sample;
        }
    }
    wet
}

/// El sonido entero, en muestras mono de −1 a 1 a `RATE` Hz.
pub fn render(chime: Chime) -> Vec<f32> {
    let length = match chime { Chime::Wake => 1.6, Chime::Close => 1.3 };
    let mut tonal = vec![0f32; seconds(length)];
    let mut low = vec![0f32; tonal.len()];
    match chime {
        Chime::Wake => {
            sweep(&mut low, 0.0, 70.0, 150.0, 0.6, 0.5);
            air(&mut tonal, 0.0, 0.45, 0.06, 3000.0, 9000.0);
            bell(&mut tonal, 0.06, 659.25, 1.1, 0.16);
            bell(&mut tonal, 0.17, 987.77, 1.3, 0.14);
            bell(&mut tonal, 0.25, 1975.5, 0.6, 0.03);
        }
        Chime::Close => {
            bell(&mut tonal, 0.0, 987.77, 0.7, 0.10);
            bell(&mut tonal, 0.11, 659.25, 0.9, 0.11);
            sweep(&mut low, 0.02, 150.0, 60.0, 0.5, 0.3);
            air(&mut tonal, 0.0, 0.35, 0.035, 8000.0, 2500.0);
        }
    }
    // Las notas y el aire pasan por la reverberación; el grave va seco para no embarrar.
    let wet = reverb(&tonal);
    let mut mix: Vec<f32> = tonal.iter().zip(&wet).zip(&low).map(|((dry, wet), low)| dry + wet * 0.3 + low).collect();
    let peak = mix.iter().fold(0f32, |max, sample| max.max(sample.abs()));
    if peak > 0.0 {
        let gain = PEAK / peak;
        mix.iter_mut().for_each(|sample| *sample *= gain);
    }
    // Sin clics al final: los últimos 30 ms bajan a cero.
    let fade = seconds(0.03).min(mix.len());
    let total = mix.len();
    for (i, sample) in mix[total - fade..].iter_mut().enumerate() {
        *sample *= 1.0 - (i + 1) as f32 / fade as f32;
    }
    mix
}

/// Hace sonar `chime` por la salida predeterminada y vuelve cuando termina.
#[cfg(windows)]
pub fn play(chime: Chime) -> Result<(), String> {
    use std::time::{Duration, Instant};
    let samples: Vec<i16> = render(chime).iter().map(|sample| (sample.clamp(-1.0, 1.0) * 32767.0) as i16).collect();
    let playback = crate::voice_playback::Playback::start(RATE)?;
    playback.push(&samples);
    let started = Instant::now();
    while playback.pending() && started.elapsed() < Duration::from_secs(4) {
        std::thread::sleep(Duration::from_millis(20));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn peak(samples: &[f32]) -> f32 {
        samples.iter().fold(0f32, |max, sample| max.max(sample.abs()))
    }

    #[test]
    fn both_sounds_are_short_clean_and_never_clip() {
        for (chime, length) in [(Chime::Wake, 1.6), (Chime::Close, 1.3)] {
            let samples = render(chime);
            assert_eq!(samples.len(), (length * RATE as f32) as usize, "{chime:?}");
            assert!(samples.iter().all(|sample| sample.is_finite()), "{chime:?}");
            assert!((peak(&samples) - PEAK).abs() < 1e-4, "{chime:?}: pico {}", peak(&samples));
            // Empieza y acaba en silencio: sin clics.
            assert!(samples[0].abs() < 0.01, "{chime:?}");
            assert_eq!(*samples.last().unwrap(), 0.0, "{chime:?}");
        }
    }

    #[test]
    fn the_sound_lives_in_its_first_second() {
        for chime in [Chime::Wake, Chime::Close] {
            let samples = render(chime);
            let energy = |range: std::ops::Range<usize>| samples[range].iter().map(|sample| sample * sample).sum::<f32>();
            let first = energy(0..RATE as usize);
            let tail = energy(RATE as usize..samples.len());
            assert!(first > tail * 4.0, "{chime:?}: {first} frente a {tail}");
        }
    }

    #[test]
    fn wake_and_close_sound_different() {
        let (wake, close) = (render(Chime::Wake), render(Chime::Close));
        assert!(wake.len() > close.len());
        assert_eq!(render(Chime::Wake), wake, "siempre el mismo sonido");
    }
}
