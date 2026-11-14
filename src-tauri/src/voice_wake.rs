//! Frase de activación del modo llamada ("oye trex", "hola trex").
//!
//! No hay un detector dedicado: Whisper transcribe cada frase y aquí se decide
//! si empezaba llamando a trex. Whisper casi nunca escribe "trex" tal cual
//! (en las pruebas salió «Tricks», «Trix», «frex», «coetrexx»…), así que la
//! comparación es por sonido y no por letras exactas.

/// Minúsculas, sin tildes ni signos.
fn normalize(word: &str) -> String {
    word.to_lowercase()
        .chars()
        .filter_map(|c| match c {
            'á' => Some('a'),
            'é' => Some('e'),
            'í' => Some('i'),
            'ó' => Some('o'),
            'ú' | 'ü' => Some('u'),
            c if c.is_alphanumeric() => Some(c),
            _ => None,
        })
        .collect()
}

/// ¿La palabra suena a "trex"? Acaba en tr/fr/dr + e/i + sonido de "x".
fn sounds_like_trex(word: &str) -> bool {
    const TAILS: &[&str] = &[
        "ex", "ecs", "eks", "ecks", "ix", "ics", "iks", "icks", "ice", "ax",
    ];
    // "coetrexx" → "coetrex": las letras repetidas no cambian el sonido.
    let mut plain = String::new();
    for c in word.chars() {
        if !plain.ends_with(c) {
            plain.push(c);
        }
    }
    ["tr", "fr", "dr"].iter().any(|start| {
        plain
            .rfind(start)
            .is_some_and(|pos| TAILS.contains(&&plain[pos + 2..]))
    })
}

/// Si la frase empieza llamando a trex, devuelve el resto: la orden (puede
/// quedar vacía si solo se dijo "oye trex").
pub fn wake_command(text: &str) -> Option<String> {
    // Nombres demasiado comunes para valer solos: exigen el saludo delante.
    const WEAK_NAMES: &[&str] = &[
        "tres", "rex", "trek", "tex", "tri", "tris", "trip", "trips",
    ];
    const GREETINGS: &[&str] = &["oye", "oie", "oi", "hoy", "hola", "ola", "hey", "ey"];

    let original: Vec<&str> = text.split_whitespace().collect();
    let words: Vec<String> = original
        .iter()
        .map(|w| normalize(w))
        .filter(|w| !w.is_empty())
        .collect();

    // El nombre debe estar entre las tres primeras palabras ("oye, tú, trex").
    for i in 0..words.len().min(3) {
        let split = i + 1 < words.len()
            && matches!(words[i].as_str(), "t" | "ti" | "te")
            && words[i + 1] == "rex";
        let strong = split || sounds_like_trex(&words[i]);
        let weak = WEAK_NAMES.contains(&words[i].as_str())
            && words[..i].iter().any(|w| GREETINGS.contains(&w.as_str()));
        if !strong && !weak {
            continue;
        }
        let rest = if split { i + 2 } else { i + 1 };
        // Saltar en el texto original tantas palabras con contenido como `rest`.
        let mut seen = 0;
        let mut skip = original.len();
        for (index, word) in original.iter().enumerate() {
            if seen >= rest {
                skip = index;
                break;
            }
            if !normalize(word).is_empty() {
                seen += 1;
            }
        }
        return Some(original[skip..].join(" "));
    }
    None
}

#[cfg(test)]
mod tests {
    use super::wake_command;

    #[test]
    fn detects_the_phrase_and_returns_the_command() {
        assert_eq!(
            wake_command("Oye, Trex, ¿cómo va Claude?").as_deref(),
            Some("¿cómo va Claude?")
        );
        assert_eq!(
            wake_command("Oye T-Rex abre el proyecto").as_deref(),
            Some("abre el proyecto")
        );
        assert_eq!(wake_command("oye tres, buenos días").as_deref(), Some("buenos días"));
        assert_eq!(wake_command("Oye T Rex hola").as_deref(), Some("hola"));
        assert_eq!(
            wake_command("Hola Trex, ¿cómo estás?").as_deref(),
            Some("¿cómo estás?")
        );
    }

    #[test]
    fn accepts_the_spellings_whisper_produced_in_testing() {
        for heard in ["Hola Tricks", "Hola, Trix", "Polietrics", "una frex", "coetrexx", "poje tricks", "Oye Trix", "callatrix"] {
            assert_eq!(wake_command(heard).as_deref(), Some(""), "{heard}");
        }
    }

    #[test]
    fn ignores_unrelated_speech() {
        for heard in [
            "tengo tres manzanas en la mesa",
            "pásame la sal por favor",
            "las actrices llegaron tarde",
            "y en el que está",
            "",
        ] {
            assert_eq!(wake_command(heard), None, "{heard}");
        }
    }

    #[test]
    fn the_name_must_come_at_the_start() {
        assert_eq!(wake_command("ayer estuve hablando con trex un rato"), None);
    }
}
