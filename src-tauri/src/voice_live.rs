//! Conversación en tiempo real con Gemini Live (solo Windows).
//!
//! Tras "oye trex" se abre un WebSocket: el micrófono viaja a Gemini y su voz
//! vuelve en streaming, así que se le puede interrumpir a mitad de frase. Las
//! herramientas que pide (abrir un proyecto, mandar un mensaje…) las ejecuta el
//! frontend, igual que en el modo local. La sesión se cierra sola tras un rato
//! de silencio: fuera de ella no sale audio de este equipo.
//!
//! El armado y la lectura de mensajes son funciones puras, con tests; el resto
//! es la conexión.
use base64::Engine;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::{mpsc, oneshot};

pub const MODEL: &str = "models/gemini-3.8-live";
pub const DEFAULT_VOICE: &str = "Kore";
/// Voces de Gemini que se ofrecen en Ajustes.
pub const VOICES: &[&str] = &[
    "Kore", "Puck", "Charon", "Zephyr", "Fenrir", "Leda", "Orus", "Aoede", "Callirrhoe", "Autonoe", "Enceladus",
    "Iapetus", "Umbriel", "Algieba", "Despina", "Erinome", "Algenib", "Rasalgethi", "Laomedeia", "Achernar",
    "Alnilam", "Schedar", "Gacrux", "Pulcherrima", "Achird", "Zubenelgenubi", "Vindemiatrix", "Sadachbia",
    "Sadaltager", "Sulafat",
];
const EVENT_LIVE: &str = "voice://live";
const EVENT_TOOL: &str = "voice://tool";
const ENDPOINT: &str = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";
/// Sin que nadie hable durante este tiempo, la sesión se cierra (y deja de costar).
const IDLE: Duration = Duration::from_secs(30);
const TOOL_TIMEOUT: Duration = Duration::from_secs(30);
/// El micrófono se envía en trozos de unos 50 ms.
const SEND_SAMPLES: usize = 800;

const INSTRUCTIONS: &str = "Eres trex, el asistente de voz de una app de escritorio donde una persona trabaja con agentes de programación (Claude Code y otros) en varios proyectos. Hablas siempre en español, con frases cortas y naturales, como en una llamada: nada de listas, símbolos, rutas ni código.\n\
Tienes herramientas para actuar sobre la app. Antes de decir cómo va un proyecto o una sesión, llama a get_status para tener el estado al día. Para resumir lo trabajado (anoche, hoy, esta semana) llama a recent_work y cuenta lo importante en pocas frases.\n\
En send_message redacta una instrucción clara para un agente de programación, sin añadir condiciones ni tareas que la persona no dijo. Usa en `project` el nombre exacto de la lista y en `session` su ref (por ejemplo s2). Si no sabes a qué proyecto o sesión se refieren, pregunta antes de actuar.\n\
No puedes aprobar permisos ni responder preguntas de los agentes: si una sesión necesita eso, dilo y pide que lo revisen en pantalla. No inventes proyectos, sesiones ni resultados.\n\
Cuando la persona se despida o diga que ya está, despídete en una frase y llama a end_call.";

// --- Mensajes: armado ---------------------------------------------------------

fn text_param(description: &str) -> Value {
    json!({ "type": "STRING", "description": description })
}

fn tools() -> Value {
    let declare = |name: &str, description: &str, properties: Value, required: &[&str]| {
        let mut declaration = json!({ "name": name, "description": description });
        if properties.as_object().is_some_and(|map| !map.is_empty()) {
            declaration["parameters"] = json!({ "type": "OBJECT", "properties": properties, "required": required });
        }
        declaration
    };
    json!([{ "functionDeclarations": [
        declare("get_status", "Estado actual de trex: proyectos, proyecto a la vista y sesiones abiertas con lo que hace cada una.", json!({}), &[]),
        declare("select_project", "Muestra un proyecto en la app.", json!({ "project": text_param("Nombre exacto del proyecto") }), &["project"]),
        declare("open_session", "Abre una sesión nueva del asistente de programación en un proyecto.", json!({
            "project": text_param("Nombre exacto del proyecto"),
            "message": text_param("Primera instrucción para la sesión, si la persona dictó una"),
        }), &["project"]),
        declare("send_message", "Envía una instrucción a una sesión abierta.", json!({
            "session": text_param("Ref de la sesión, por ejemplo s2"),
            "text": text_param("La instrucción para el agente"),
        }), &["session", "text"]),
        declare("interrupt", "Detiene lo que una sesión está haciendo.", json!({ "session": text_param("Ref de la sesión") }), &["session"]),
        declare("recent_work", "Commits y estado de las sesiones de un periodo, para resumir lo trabajado.", json!({
            "hours": { "type": "NUMBER", "description": "Cuántas horas hacia atrás mirar" },
            "project": text_param("Nombre del proyecto; vacío para todos"),
        }), &["hours"]),
        declare("end_call", "Termina la conversación cuando la persona se despide.", json!({}), &[]),
    ] }])
}

/// Primer mensaje de la conexión. Con `handle` reanuda una sesión anterior.
pub fn setup_message(voice: &str, status: &Value, handle: Option<&str>) -> String {
    let voice = if VOICES.contains(&voice) { voice } else { DEFAULT_VOICE };
    let instructions = format!("{INSTRUCTIONS}\n\nEstado de trex al empezar la llamada:\n{status}");
    json!({ "setup": {
        "model": MODEL,
        "generationConfig": {
            "responseModalities": ["AUDIO"],
            "speechConfig": { "voiceConfig": { "prebuiltVoiceConfig": { "voiceName": voice } } },
        },
        "systemInstruction": { "parts": [{ "text": instructions }] },
        "tools": tools(),
        "inputAudioTranscription": {},
        "outputAudioTranscription": {},
        "sessionResumption": match handle { Some(handle) => json!({ "handle": handle }), None => json!({}) },
        "contextWindowCompression": { "slidingWindow": {} },
    } }).to_string()
}

/// Audio del micrófono: PCM de 16 bits, mono, 16 kHz.
pub fn audio_message(pcm: &[i16]) -> String {
    let bytes: Vec<u8> = pcm.iter().flat_map(|sample| sample.to_le_bytes()).collect();
    json!({ "realtimeInput": { "audio": {
        "data": base64::engine::general_purpose::STANDARD.encode(bytes),
        "mimeType": "audio/pcm;rate=16000",
    } } }).to_string()
}

pub fn text_message(text: &str) -> String {
    json!({ "realtimeInput": { "text": text } }).to_string()
}

pub fn tool_response(id: &str, name: &str, response: &Value) -> String {
    // La respuesta de una función es siempre un objeto.
    let response = if response.is_object() { response.clone() } else { json!({ "result": response }) };
    json!({ "toolResponse": { "functionResponses": [{ "id": id, "name": name, "response": response }] } }).to_string()
}

// --- Mensajes: lectura ----------------------------------------------------------

#[derive(Debug, PartialEq)]
pub enum ServerEvent {
    SetupComplete,
    /// Voz de Gemini: PCM de 16 bits, mono, 24 kHz.
    Audio(Vec<i16>),
    /// La persona habló encima: hay que callar ya.
    Interrupted,
    TurnComplete,
    Heard(String),
    Said(String),
    ToolCall { id: String, name: String, args: Value },
    ToolCancelled(Vec<String>),
    /// El servidor va a cortar la conexión: toca reanudar.
    GoAway,
    Resumable(String),
}

/// Un mensaje del servidor puede traer varias cosas a la vez; nunca se confía en su forma.
pub fn parse_server(text: &str) -> Vec<ServerEvent> {
    let Ok(message) = serde_json::from_str::<Value>(text) else { return Vec::new() };
    let mut events = Vec::new();
    if message.get("setupComplete").is_some() { events.push(ServerEvent::SetupComplete); }
    if let Some(content) = message.get("serverContent") {
        if let Some(text) = content["inputTranscription"]["text"].as_str().filter(|text| !text.is_empty()) {
            events.push(ServerEvent::Heard(text.to_string()));
        }
        for part in content["modelTurn"]["parts"].as_array().into_iter().flatten() {
            let Some(data) = part["inlineData"]["data"].as_str() else { continue };
            let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(data) else { continue };
            let pcm: Vec<i16> = bytes.chunks_exact(2).map(|pair| i16::from_le_bytes([pair[0], pair[1]])).collect();
            if !pcm.is_empty() { events.push(ServerEvent::Audio(pcm)); }
        }
        if let Some(text) = content["outputTranscription"]["text"].as_str().filter(|text| !text.is_empty()) {
            events.push(ServerEvent::Said(text.to_string()));
        }
        if content["interrupted"] == true { events.push(ServerEvent::Interrupted); }
        if content["turnComplete"] == true { events.push(ServerEvent::TurnComplete); }
    }
    for call in message["toolCall"]["functionCalls"].as_array().into_iter().flatten() {
        let (Some(id), Some(name)) = (call["id"].as_str(), call["name"].as_str()) else { continue };
        events.push(ServerEvent::ToolCall { id: id.to_string(), name: name.to_string(), args: call.get("args").cloned().unwrap_or_else(|| json!({})) });
    }
    if let Some(ids) = message["toolCallCancellation"]["ids"].as_array() {
        events.push(ServerEvent::ToolCancelled(ids.iter().filter_map(|id| id.as_str().map(str::to_string)).collect()));
    }
    if message.get("goAway").is_some() { events.push(ServerEvent::GoAway); }
    let update = &message["sessionResumptionUpdate"];
    if update["resumable"] == true {
        if let Some(handle) = update["newHandle"].as_str().filter(|handle| !handle.is_empty()) {
            events.push(ServerEvent::Resumable(handle.to_string()));
        }
    }
    events
}

// --- Estado compartido con el frontend ------------------------------------------

#[derive(Default)]
pub struct Shared {
    /// Herramientas pedidas al frontend que aún no han contestado.
    tools: Mutex<HashMap<String, oneshot::Sender<Value>>>,
    active: AtomicBool,
    hangup: AtomicBool,
    next: AtomicU64,
}

#[derive(Clone, Default)]
pub struct LiveState(Arc<Shared>);

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl LiveState {
    pub fn active(&self) -> bool { self.0.active.load(Ordering::SeqCst) }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ToolRequest { id: String, name: String, args: Value }

/// Pide al frontend que ejecute una herramienta y espera su resultado.
async fn ask_frontend(app: &AppHandle, state: &LiveState, name: &str, args: Value, timeout: Duration) -> Value {
    let id = format!("t{}", state.0.next.fetch_add(1, Ordering::SeqCst));
    let (tx, rx) = oneshot::channel();
    lock(&state.0.tools).insert(id.clone(), tx);
    let _ = app.emit(EVENT_TOOL, ToolRequest { id: id.clone(), name: name.to_string(), args });
    let result = tokio::time::timeout(timeout, rx).await;
    lock(&state.0.tools).remove(&id);
    match result {
        Ok(Ok(value)) => value,
        _ => json!({ "error": "La app no respondió a tiempo." }),
    }
}

#[tauri::command]
pub fn voice_live_tool_result(state: State<'_, LiveState>, id: String, result: Value) {
    if let Some(waiting) = lock(&state.0.tools).remove(&id) { let _ = waiting.send(result); }
}

/// Cuelga la llamada en curso.
#[tauri::command]
pub fn voice_live_hangup(state: State<'_, LiveState>) {
    state.0.hangup.store(true, Ordering::SeqCst);
}

// --- Sesión -----------------------------------------------------------------------

pub struct LiveOptions {
    pub key: String,
    pub voice: String,
    /// Dejar pasar el micrófono mientras trex habla (interrumpirle). Requiere auriculares.
    pub barge_in: bool,
    /// Lo que la persona dijo tras "oye trex", para no hacérselo repetir.
    pub first_words: String,
}

/// El extremo del motor de voz: por aquí manda el micrófono mientras dure la sesión.
pub struct LiveLink {
    audio: mpsc::UnboundedSender<Vec<i16>>,
    state: LiveState,
}

impl LiveLink {
    pub fn alive(&self) -> bool { self.state.active() }
    /// Audio a 16 kHz. Si la sesión ya terminó, se descarta.
    pub fn send(&self, pcm: Vec<i16>) { let _ = self.audio.send(pcm); }
}

#[cfg(windows)]
pub fn start(app: AppHandle, state: LiveState, options: LiveOptions) -> LiveLink {
    let (audio, audio_rx) = mpsc::unbounded_channel();
    state.0.hangup.store(false, Ordering::SeqCst);
    state.0.active.store(true, Ordering::SeqCst);
    let task_state = state.clone();
    tauri::async_runtime::spawn(async move {
        let _ = app.emit(EVENT_LIVE, json!({ "kind": "state", "state": "connecting" }));
        let reason = match session::run(&app, &task_state, &options, audio_rx).await {
            Ok(reason) => json!({ "kind": "state", "state": "ended", "reason": reason }),
            Err(error) => json!({ "kind": "state", "state": "ended", "error": error }),
        };
        if cfg!(debug_assertions) { eprintln!("[voz] llamada terminada: {reason}"); }
        task_state.0.active.store(false, Ordering::SeqCst);
        lock(&task_state.0.tools).clear();
        let _ = app.emit(EVENT_LIVE, reason);
    });
    LiveLink { audio, state }
}

#[cfg(windows)]
mod session {
    use super::*;
    use crate::voice_playback::Playback;
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message;

    fn tls() -> Result<tokio_tungstenite::Connector, String> {
        let roots = rustls::RootCertStore { roots: webpki_roots::TLS_SERVER_ROOTS.to_vec() };
        let config = rustls::ClientConfig::builder_with_provider(Arc::new(rustls::crypto::aws_lc_rs::default_provider()))
            .with_safe_default_protocol_versions()
            .map_err(|_| "No se pudo preparar la conexión segura.".to_string())?
            .with_root_certificates(roots)
            .with_no_client_auth();
        Ok(tokio_tungstenite::Connector::Rustls(Arc::new(config)))
    }

    /// Lo que dice el servidor al cerrar (clave no válida, cuota…), recortado.
    fn close_reason(message: &Message) -> Option<String> {
        match message {
            Message::Close(Some(frame)) if !frame.reason.is_empty() => Some(frame.reason.chars().take(200).collect()),
            _ => None,
        }
    }

    pub async fn run(app: &AppHandle, state: &LiveState, options: &LiveOptions, mut audio: mpsc::UnboundedReceiver<Vec<i16>>) -> Result<&'static str, String> {
        let status = ask_frontend(app, state, "get_status", json!({}), Duration::from_secs(4)).await;
        let playback = Playback::start(24_000)?;
        let url = format!("{ENDPOINT}?key={}", options.key);
        let (results_tx, mut results) = mpsc::unbounded_channel::<(String, String, Value)>();
        let mut handle: Option<String> = None;
        let mut first_words = Some(options.first_words.trim().to_string()).filter(|text| !text.is_empty());
        let mut announced = false;
        let mut last_activity = Instant::now();
        let mut closing: Option<Instant> = None;
        let mut reconnects = 0u32;

        'connection: loop {
            let connect = tokio_tungstenite::connect_async_tls_with_config(url.as_str(), None, false, Some(tls()?));
            let (socket, _) = tokio::time::timeout(Duration::from_secs(12), connect).await
                .map_err(|_| "Gemini tardó demasiado en contestar.".to_string())?
                // El error puede contener la dirección con la clave: no se muestra.
                .map_err(|_| "No se pudo conectar con Gemini. Revisa la conexión y la clave.".to_string())?;
            let (mut sink, mut stream) = socket.split();
            let lost = |_| "Se perdió la conexión con Gemini.".to_string();
            sink.send(Message::text(setup_message(&options.voice, &status, handle.as_deref()))).await.map_err(lost)?;

            let mut ready = false;
            let mut outgoing: Vec<i16> = Vec::new();
            let mut tick = tokio::time::interval(Duration::from_millis(250));
            loop {
                tokio::select! {
                    chunk = audio.recv() => {
                        let Some(pcm) = chunk else { return Ok("stopped") };
                        // Sin auriculares, el micrófono oiría a trex y Gemini creería que le interrumpen.
                        if !ready || (!options.barge_in && playback.pending()) { outgoing.clear(); continue; }
                        outgoing.extend_from_slice(&pcm);
                        if outgoing.len() >= SEND_SAMPLES {
                            sink.send(Message::text(audio_message(&outgoing))).await.map_err(lost)?;
                            outgoing.clear();
                        }
                    }
                    message = stream.next() => {
                        let text = match message {
                            Some(Ok(Message::Text(text))) => text.to_string(),
                            Some(Ok(Message::Binary(bytes))) => String::from_utf8_lossy(&bytes).into_owned(),
                            Some(Ok(Message::Ping(_) | Message::Pong(_) | Message::Frame(_))) => continue,
                            other => {
                                // Cierre o error. Con una sesión reanudable se reconecta; si no, se acabó.
                                if !ready {
                                    let detail = other.and_then(|result| result.ok()).and_then(|message| close_reason(&message));
                                    return Err(match detail {
                                        Some(detail) => format!("Gemini rechazó la conexión: {detail}"),
                                        None => "Gemini rechazó la conexión. Revisa la clave.".to_string(),
                                    });
                                }
                                if handle.is_some() && reconnects < 20 { reconnects += 1; continue 'connection; }
                                return Err("Se perdió la conexión con Gemini.".into());
                            }
                        };
                        for event in parse_server(&text) {
                            match event {
                                ServerEvent::SetupComplete => {
                                    ready = true;
                                    if !announced {
                                        announced = true;
                                        let _ = app.emit(EVENT_LIVE, json!({ "kind": "state", "state": "talking" }));
                                    }
                                    if let Some(words) = first_words.take() {
                                        sink.send(Message::text(text_message(&words))).await.map_err(lost)?;
                                    }
                                }
                                ServerEvent::Audio(pcm) => { last_activity = Instant::now(); playback.push(&pcm); }
                                ServerEvent::Interrupted => {
                                    playback.clear();
                                    let _ = app.emit(EVENT_LIVE, json!({ "kind": "interrupted" }));
                                }
                                ServerEvent::TurnComplete => { let _ = app.emit(EVENT_LIVE, json!({ "kind": "turn" })); }
                                ServerEvent::Heard(text) => {
                                    last_activity = Instant::now();
                                    let _ = app.emit(EVENT_LIVE, json!({ "kind": "heard", "text": text }));
                                }
                                ServerEvent::Said(text) => { let _ = app.emit(EVENT_LIVE, json!({ "kind": "said", "text": text })); }
                                ServerEvent::ToolCall { id, name, args } => {
                                    last_activity = Instant::now();
                                    if cfg!(debug_assertions) { eprintln!("[voz] Gemini pide {name} {args}"); }
                                    if name == "end_call" {
                                        closing = Some(Instant::now());
                                        let _ = results_tx.send((id, name, json!({ "ok": true })));
                                        continue;
                                    }
                                    let (app, state, results_tx) = (app.clone(), state.clone(), results_tx.clone());
                                    tauri::async_runtime::spawn(async move {
                                        let result = ask_frontend(&app, &state, &name, args, TOOL_TIMEOUT).await;
                                        let _ = results_tx.send((id, name, result));
                                    });
                                }
                                // La persona interrumpió: lo pendiente ya no interesa.
                                ServerEvent::ToolCancelled(ids) => { let mut tools = lock(&state.0.tools); for id in ids { tools.remove(&id); } }
                                ServerEvent::GoAway => { if handle.is_some() { continue 'connection; } }
                                ServerEvent::Resumable(next) => handle = Some(next),
                            }
                        }
                    }
                    Some((id, name, result)) = results.recv() => {
                        sink.send(Message::text(tool_response(&id, &name, &result))).await.map_err(lost)?;
                    }
                    _ = tick.tick() => {
                        if state.0.hangup.load(Ordering::SeqCst) { playback.clear(); let _ = sink.close().await; return Ok("hangup"); }
                        if playback.pending() { last_activity = Instant::now(); }
                        // Tras despedirse se espera a que termine de sonar la despedida.
                        if closing.is_some_and(|since| since.elapsed() > Duration::from_secs(2)) && !playback.pending() {
                            let _ = sink.close().await;
                            return Ok("goodbye");
                        }
                        if last_activity.elapsed() > IDLE { let _ = sink.close().await; return Ok("idle"); }
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn setup_declares_voice_tools_and_resumption() {
        let setup: Value = serde_json::from_str(&setup_message("Puck", &json!({ "proyectos": ["mangi"] }), None)).unwrap();
        let setup = &setup["setup"];
        assert_eq!(setup["model"], MODEL);
        assert_eq!(setup["generationConfig"]["responseModalities"], json!(["AUDIO"]));
        assert_eq!(setup["generationConfig"]["speechConfig"]["voiceConfig"]["prebuiltVoiceConfig"]["voiceName"], "Puck");
        assert!(setup["systemInstruction"]["parts"][0]["text"].as_str().unwrap().contains("\"mangi\""));
        assert_eq!(setup["sessionResumption"], json!({}));
        let names: Vec<&str> = setup["tools"][0]["functionDeclarations"].as_array().unwrap().iter().map(|tool| tool["name"].as_str().unwrap()).collect();
        assert_eq!(names, ["get_status", "select_project", "open_session", "send_message", "interrupt", "recent_work", "end_call"]);
        // Las herramientas sin parámetros no declaran un esquema vacío.
        assert!(setup["tools"][0]["functionDeclarations"][0].get("parameters").is_none());
        assert_eq!(setup["tools"][0]["functionDeclarations"][3]["parameters"]["required"], json!(["session", "text"]));
    }

    #[test]
    fn an_unknown_voice_falls_back_and_a_handle_resumes() {
        let setup: Value = serde_json::from_str(&setup_message("VozInventada", &json!({}), Some("h-123"))).unwrap();
        assert_eq!(setup["setup"]["generationConfig"]["speechConfig"]["voiceConfig"]["prebuiltVoiceConfig"]["voiceName"], DEFAULT_VOICE);
        assert_eq!(setup["setup"]["sessionResumption"], json!({ "handle": "h-123" }));
    }

    #[test]
    fn microphone_audio_is_little_endian_pcm_in_base64() {
        let message: Value = serde_json::from_str(&audio_message(&[1, -2])).unwrap();
        assert_eq!(message["realtimeInput"]["audio"]["mimeType"], "audio/pcm;rate=16000");
        let bytes = base64::engine::general_purpose::STANDARD.decode(message["realtimeInput"]["audio"]["data"].as_str().unwrap()).unwrap();
        assert_eq!(bytes, [1, 0, 0xFE, 0xFF]);
    }

    #[test]
    fn tool_responses_are_always_objects() {
        let wrapped: Value = serde_json::from_str(&tool_response("c1", "get_status", &json!("listo"))).unwrap();
        assert_eq!(wrapped["toolResponse"]["functionResponses"][0], json!({ "id": "c1", "name": "get_status", "response": { "result": "listo" } }));
        let object: Value = serde_json::from_str(&tool_response("c2", "interrupt", &json!({ "ok": true }))).unwrap();
        assert_eq!(object["toolResponse"]["functionResponses"][0]["response"], json!({ "ok": true }));
    }

    #[test]
    fn reads_audio_transcripts_and_interruptions() {
        let audio = base64::engine::general_purpose::STANDARD.encode([1u8, 0, 0xFE, 0xFF, 7]);
        let message = json!({ "serverContent": {
            "inputTranscription": { "text": "hola" },
            "modelTurn": { "parts": [{ "inlineData": { "mimeType": "audio/pcm;rate=24000", "data": audio } }, { "text": "ignorado" }] },
            "outputTranscription": { "text": "Dime." },
            "interrupted": true,
            "turnComplete": true,
        } }).to_string();
        assert_eq!(parse_server(&message), vec![
            ServerEvent::Heard("hola".into()),
            // El byte suelto del final se descarta.
            ServerEvent::Audio(vec![1, -2]),
            ServerEvent::Said("Dime.".into()),
            ServerEvent::Interrupted,
            ServerEvent::TurnComplete,
        ]);
    }

    #[test]
    fn reads_tool_calls_cancellations_and_session_signals() {
        assert_eq!(parse_server(r#"{"setupComplete":{}}"#), vec![ServerEvent::SetupComplete]);
        assert_eq!(
            parse_server(r#"{"toolCall":{"functionCalls":[{"id":"c1","name":"open_session","args":{"project":"mangi"}},{"name":"sin id"}]}}"#),
            vec![ServerEvent::ToolCall { id: "c1".into(), name: "open_session".into(), args: json!({ "project": "mangi" }) }]
        );
        assert_eq!(parse_server(r#"{"toolCallCancellation":{"ids":["c1","c2"]}}"#), vec![ServerEvent::ToolCancelled(vec!["c1".into(), "c2".into()])]);
        assert_eq!(parse_server(r#"{"goAway":{"timeLeft":"5s"}}"#), vec![ServerEvent::GoAway]);
        assert_eq!(parse_server(r#"{"sessionResumptionUpdate":{"newHandle":"h1","resumable":true}}"#), vec![ServerEvent::Resumable("h1".into())]);
        // Mientras genera, la sesión no es reanudable: ese aviso no pisa el último identificador bueno.
        assert_eq!(parse_server(r#"{"sessionResumptionUpdate":{"newHandle":"","resumable":false}}"#), vec![]);
        assert_eq!(parse_server("no es json"), vec![]);
    }
}
