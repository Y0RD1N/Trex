//! Voz de nube para el modo local: ElevenLabs (solo Windows).
//!
//! trex le manda el texto de la respuesta y reproduce el audio según llega. El
//! oído y el cerebro siguen siendo locales; a ElevenLabs solo viaja lo que trex
//! va a decir.
use serde::Serialize;
use serde_json::{json, Value};
use std::io::Read;
use std::time::Duration;

const API: &str = "https://api.elevenlabs.io";
/// El modelo rápido y multilingüe de ElevenLabs.
const MODEL: &str = "eleven_flash_v2_5";
const RATE: u32 = 24_000;

#[derive(Debug)]
pub enum Failure {
    /// No llegó a sonar nada: se puede decir con otra voz.
    BeforeSound(String),
    Midway(String),
}

fn client(timeout: Duration) -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(timeout)
        .https_only(true)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "No se pudo preparar la conexión con ElevenLabs.".to_string())
}

/// Un identificador de voz de ElevenLabs: letras y números, sin nada que pueda alterar la dirección.
pub fn valid_voice(voice: &str) -> bool {
    (8..=64).contains(&voice.len()) && voice.chars().all(|c| c.is_ascii_alphanumeric())
}

pub fn speech_body(text: &str) -> Value {
    json!({
        "text": text,
        "model_id": MODEL,
        "language_code": "es",
        // Para que lea bien números y fechas.
        "apply_text_normalization": "on",
    })
}

/// Traduce un fallo de ElevenLabs a una frase que sirva en Ajustes.
pub fn explain(status: u16, body: &str) -> String {
    let code = serde_json::from_str::<Value>(body).ok()
        .and_then(|value| value["detail"]["code"].as_str().or(value["detail"]["status"].as_str()).map(str::to_string))
        .unwrap_or_default();
    match (status, code.as_str()) {
        (401, _) => "ElevenLabs no aceptó la clave. Revísala en Ajustes.".into(),
        (402, _) | (_, "insufficient_credits" | "quota_exceeded") => "La cuenta de ElevenLabs se quedó sin saldo.".into(),
        (429, _) => "ElevenLabs está ocupado o se superó el límite de la cuenta.".into(),
        (404, _) | (_, "voice_not_found") => "Esa voz de ElevenLabs ya no existe. Elige otra en Ajustes.".into(),
        _ => format!("ElevenLabs respondió con un error ({status})."),
    }
}

/// Lee `text` con ElevenLabs y vuelve cuando termina de sonar, o antes si `cancelled` da `true`.
#[cfg(windows)]
pub fn speak(key: &str, voice: &str, text: &str, cancelled: impl Fn() -> bool) -> Result<(), Failure> {
    use crate::voice_playback::Playback;
    if !valid_voice(voice) { return Err(Failure::BeforeSound("Elige una voz de ElevenLabs en Ajustes.".into())); }
    let before = Failure::BeforeSound;
    let mut response = client(Duration::from_secs(60)).map_err(before)?
        .post(format!("{API}/v1/text-to-speech/{voice}/stream?output_format=pcm_{RATE}"))
        .header("xi-api-key", key)
        .header("content-type", "application/json")
        .body(speech_body(text).to_string())
        .send()
        .map_err(|_| Failure::BeforeSound("No se pudo conectar con ElevenLabs.".into()))?;
    if !response.status().is_success() {
        let status = response.status().as_u16();
        let body = response.text().unwrap_or_default();
        return Err(Failure::BeforeSound(explain(status, &body)));
    }
    let playback = Playback::start(RATE).map_err(before)?;
    let mut buffer = [0u8; 8 * 1024];
    // Un trozo puede partir una muestra de 16 bits por la mitad: el byte suelto espera al siguiente.
    let mut carry: Option<u8> = None;
    let mut heard = false;
    loop {
        if cancelled() { playback.clear(); return Ok(()); }
        let n = match response.read(&mut buffer) {
            Ok(0) => break,
            Ok(n) => n,
            Err(_) if heard => return Err(Failure::Midway("Se cortó la voz de ElevenLabs.".into())),
            Err(_) => return Err(Failure::BeforeSound("Se cortó la conexión con ElevenLabs.".into())),
        };
        let mut bytes = Vec::with_capacity(n + 1);
        bytes.extend(carry.take());
        bytes.extend_from_slice(&buffer[..n]);
        if bytes.len() % 2 == 1 { carry = bytes.pop(); }
        let pcm: Vec<i16> = bytes.chunks_exact(2).map(|pair| i16::from_le_bytes([pair[0], pair[1]])).collect();
        playback.push(&pcm);
        heard = heard || !pcm.is_empty();
    }
    if !heard { return Err(Failure::BeforeSound("ElevenLabs no devolvió audio.".into())); }
    while playback.pending() {
        if cancelled() { playback.clear(); break; }
        std::thread::sleep(Duration::from_millis(30));
    }
    Ok(())
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CloudVoice {
    pub id: String,
    pub name: String,
    /// Idioma, acento o tipo de voz, lo que la cuenta tenga anotado.
    pub detail: String,
}

/// Lee la lista de voces de la cuenta; lo que no tenga forma de voz se descarta.
pub fn parse_voices(body: &str) -> Vec<CloudVoice> {
    let Ok(value) = serde_json::from_str::<Value>(body) else { return Vec::new() };
    value["voices"].as_array().into_iter().flatten().filter_map(|voice| {
        let id = voice["voice_id"].as_str().filter(|id| valid_voice(id))?;
        let name = voice["name"].as_str().filter(|name| !name.trim().is_empty())?;
        let labels = &voice["labels"];
        let detail: Vec<&str> = ["language", "accent", "gender", "use_case"].iter()
            .filter_map(|label| labels[label].as_str().filter(|text| !text.is_empty()))
            .collect();
        Some(CloudVoice { id: id.to_string(), name: name.trim().chars().take(80).collect(), detail: detail.join(" · ") })
    }).collect()
}

/// Voces disponibles en la cuenta de ElevenLabs de la persona.
pub fn voices(key: &str) -> Result<Vec<CloudVoice>, String> {
    let response = client(Duration::from_secs(20))?
        .get(format!("{API}/v2/voices?page_size=100"))
        .header("xi-api-key", key)
        .send()
        .map_err(|_| "No se pudo conectar con ElevenLabs.".to_string())?;
    let status = response.status();
    let body = response.text().unwrap_or_default();
    if !status.is_success() { return Err(explain(status.as_u16(), &body)); }
    Ok(parse_voices(&body))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_request_asks_for_spanish_and_number_reading() {
        let body = speech_body("Son las 3:15.");
        assert_eq!(body["text"], "Son las 3:15.");
        assert_eq!(body["model_id"], "eleven_flash_v2_5");
        assert_eq!(body["language_code"], "es");
        assert_eq!(body["apply_text_normalization"], "on");
    }

    #[test]
    fn voice_ids_cannot_alter_the_request_path() {
        assert!(valid_voice("21m00Tcm4TlvDq8ikWAM"));
        assert!(!valid_voice(""));
        assert!(!valid_voice("../v1/user"));
        assert!(!valid_voice("abc?x=1abcdef"));
    }

    #[test]
    fn failures_are_explained_in_plain_words() {
        assert!(explain(401, r#"{"detail":{"code":"invalid_api_key"}}"#).contains("clave"));
        assert!(explain(402, "").contains("saldo"));
        assert!(explain(400, r#"{"detail":{"status":"quota_exceeded"}}"#).contains("saldo"));
        assert!(explain(429, "no es json").contains("límite"));
        assert!(explain(500, "").contains("500"));
    }

    #[test]
    fn the_voice_list_keeps_only_well_formed_voices() {
        let body = r#"{"voices":[
            {"voice_id":"21m00Tcm4TlvDq8ikWAM","name":" Valentina ","labels":{"language":"es","accent":"mexican","gender":"female"}},
            {"voice_id":"../malo","name":"Trampa"},
            {"voice_id":"AZnzlk1XvdvUeBnXmlld","name":""},
            {"voice_id":"EXAVITQu4vr4xnSDxMaL","name":"Sin etiquetas"}
        ],"has_more":false}"#;
        assert_eq!(parse_voices(body), vec![
            CloudVoice { id: "21m00Tcm4TlvDq8ikWAM".into(), name: "Valentina".into(), detail: "es · mexican · female".into() },
            CloudVoice { id: "EXAVITQu4vr4xnSDxMaL".into(), name: "Sin etiquetas".into(), detail: String::new() },
        ]);
        assert_eq!(parse_voices("basura"), vec![]);
    }
}
