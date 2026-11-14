//! Dictado por voz en el campo de texto de un chat.
//!
//! Reutiliza el motor del modo llamada (micrófono, detector de voz y Whisper),
//! pero aquí todo lo que se oye se escribe: no hace falta decir "oye trex".
//! Este módulo solo limpia lo que Whisper devuelve; el resto está en `voice.rs`.

/// Whisper describe el ruido con una acotación («[Música]», «(Ruido de la pared)»)
/// en vez de callar. Eso no lo dijo nadie: una frase que sea solo acotaciones se
/// descarta, y las acotaciones sueltas se quitan del resto.
pub fn clean(text: &str) -> Option<String> {
    let mut kept = String::new();
    let mut closing: Option<char> = None;
    for c in text.chars() {
        match closing {
            Some(end) if c == end => closing = None,
            Some(_) => {}
            None if c == '[' => closing = Some(']'),
            None if c == '(' => closing = Some(')'),
            None => kept.push(c),
        }
    }
    let kept = kept.split_whitespace().collect::<Vec<_>>().join(" ");
    // Sin ninguna letra ni número no hay nada que escribir (queda un signo suelto).
    kept.chars().any(char::is_alphanumeric).then_some(kept)
}

#[cfg(test)]
mod tests {
    use super::clean;

    #[test]
    fn noise_descriptions_are_not_dictated() {
        assert_eq!(clean("[Música]"), None);
        assert_eq!(clean("(Ruido de la pared)"), None);
        assert_eq!(clean("  [Música]  (Aplausos) "), None);
        assert_eq!(clean("(Ruido"), None);
        assert_eq!(clean(""), None);
        assert_eq!(clean("..."), None);
    }

    #[test]
    fn speech_is_kept_and_tidied() {
        assert_eq!(clean("  Corre los tests   y dime qué falla. ").as_deref(), Some("Corre los tests y dime qué falla."));
        assert_eq!(clean("[Música] Abre el archivo de voz.").as_deref(), Some("Abre el archivo de voz."));
        assert_eq!(clean("Sí").as_deref(), Some("Sí"));
    }
}
