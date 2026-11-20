//! Puente con la extensión «trex para tu navegador»: los agentes manejan las pestañas
//! que la persona comparte en su navegador de siempre (Chrome, Brave, Edge).
//!
//! Apagado por defecto. Activado, un servidor HTTP + WebSocket escucha **solo en
//! 127.0.0.1** y tiene dos clases de clientes, que no se pueden confundir:
//!
//! - **La extensión** (`/pair`, `/ws`). Se empareja una vez con un código de un solo
//!   uso (5 min, 5 intentos) y recibe un token aleatorio de 256 bits del que aquí solo
//!   se guarda el SHA-256. El navegador pone él mismo la cabecera `Origin`
//!   (`chrome-extension://<id>`), que una página web no puede falsificar: se exige en
//!   ambas rutas y debe ser la de la extensión emparejada.
//! - **Los agentes** (`/mcp`, MCP por HTTP con respuestas JSON). Cada chat recibe un
//!   token propio, ligado a su modo (observar o completo), que viaja en una variable de
//!   entorno. Aquí se rechaza cualquier petición que traiga `Origin`: un agente no es
//!   un navegador, y así ninguna web puede llamar a las herramientas.
//!
//! Este módulo no decide qué pestañas se pueden tocar: eso lo hace la extensión, que
//! solo actúa dentro del grupo de pestañas «trex». Aquí se validan orígenes, tokens,
//! tamaños y qué herramientas admite cada modo, y se reparten las órdenes.
use axum::body::Bytes;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{DefaultBodyLimit, State as AxumState};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::net::{Ipv4Addr, SocketAddr};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::{broadcast, mpsc, oneshot, watch};

use crate::remote::{base64_url, hex, new_code, normalize_code, now_ms, random_bytes, same_secret, token_hash, valid_hash};

const CONFIG_FILE: &str = "browser-bridge.json";
pub const DEFAULT_PORT: u16 = 7341;
const PAIRING_TTL: Duration = Duration::from_secs(5 * 60);
const PAIRING_ATTEMPTS: u32 = 5;
const MAX_BROWSERS: usize = 8;
/// Una captura de pantalla viaja en base64 dentro de un mensaje de la extensión.
const MAX_EXTENSION_MESSAGE: usize = 16 * 1024 * 1024;
const MAX_MCP_BODY: usize = 1024 * 1024;
const HELLO_TIMEOUT: Duration = Duration::from_secs(10);
/// Navegar y esperar a que cargue una página lenta cabe aquí; más es que algo se colgó.
const TOOL_TIMEOUT: Duration = Duration::from_secs(60);
const RETRY_BIND: Duration = Duration::from_secs(20);
/// Un mensaje de texto cada poco mantiene despierto el service worker de la extensión
/// (los `ping` de WebSocket no llegan a su código y Chrome lo dormiría a los 30 s).
const KEEPALIVE: Duration = Duration::from_secs(20);
const MAX_SESSIONS: usize = 256;
const EVENT_STATUS: &str = "browser-bridge://status";
const PROTOCOL: &str = "2025-11-25";
const MCP_VERSIONS: [&str; 4] = ["2024-11-05", "2025-03-26", "2025-06-18", PROTOCOL];
const INSTRUCTIONS: &str = "Estas herramientas manejan el navegador real de la persona, con sus sesiones iniciadas. \
Solo alcanzan las pestañas del grupo «trex»: las que abras tú con tab_open y las que la persona haya compartido. \
Empieza con tabs_list; lee con read_page antes de actuar y usa las referencias ref_N que devuelve. \
Nunca escribas contraseñas, códigos de verificación ni datos de pago: pide a la persona que lo haga ella. \
Antes de enviar formularios, comprar, publicar o borrar algo, confirma con la persona.";

// --- Herramientas ---------------------------------------------------------------

/// Las que solo miran: disponibles también al planificar o en solo lectura.
pub const OBSERVE_TOOLS: [&str; 3] = ["tabs_list", "read_page", "screenshot"];
/// Las que cambian algo en el navegador: solo en modo completo.
pub const ACTION_TOOLS: [&str; 7] = ["tab_open", "navigate", "click", "type", "key", "scroll", "tab_close"];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode { Observe, Full }

impl Mode {
    fn parse(value: &str) -> Option<Self> {
        match value { "observe" => Some(Self::Observe), "full" => Some(Self::Full), _ => None }
    }
    fn name(self) -> &'static str { if self == Self::Observe { "observe" } else { "full" } }
    fn allows(self, tool: &str) -> bool {
        OBSERVE_TOOLS.contains(&tool) || (self == Self::Full && ACTION_TOOLS.contains(&tool))
    }
}

fn tool_specs() -> Vec<Value> {
    let tab = json!({ "type": "integer", "description": "Id de la pestaña, de tabs_list." });
    let reference = json!({ "type": "string", "description": "Referencia ref_N de un elemento, de read_page." });
    vec![
        json!({ "name": "tabs_list", "description": "Lista las pestañas del grupo «trex» (id, título, dirección y cuál está activa). Son las únicas que puedes ver y manejar.",
            "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false }, "annotations": { "readOnlyHint": true } }),
        json!({ "name": "read_page", "description": "Lee una pestaña: su título, dirección, texto visible y los elementos con los que se puede interactuar, cada uno con una referencia ref_N.",
            "inputSchema": { "type": "object", "properties": { "tabId": tab, "maxChars": { "type": "integer", "minimum": 1000, "maximum": 100000, "description": "Tope de texto devuelto (por defecto 20000)." } },
                "required": ["tabId"], "additionalProperties": false }, "annotations": { "readOnlyHint": true } }),
        json!({ "name": "screenshot", "description": "Captura lo que se ve ahora en una pestaña.",
            "inputSchema": { "type": "object", "properties": { "tabId": tab }, "required": ["tabId"], "additionalProperties": false }, "annotations": { "readOnlyHint": true } }),
        json!({ "name": "tab_open", "description": "Abre una pestaña nueva en el grupo «trex» con una dirección http(s) y espera a que cargue.",
            "inputSchema": { "type": "object", "properties": { "url": { "type": "string" } }, "required": ["url"], "additionalProperties": false } }),
        json!({ "name": "navigate", "description": "Lleva una pestaña a otra dirección http(s), o atrás/adelante con «back» y «forward», y espera a que cargue.",
            "inputSchema": { "type": "object", "properties": { "tabId": tab, "url": { "type": "string" } }, "required": ["tabId", "url"], "additionalProperties": false } }),
        json!({ "name": "click", "description": "Hace clic en un elemento por su referencia ref_N.",
            "inputSchema": { "type": "object", "properties": { "tabId": tab, "ref": reference }, "required": ["tabId", "ref"], "additionalProperties": false } }),
        json!({ "name": "type", "description": "Escribe texto en el elemento indicado (o en el que tiene el foco). Con «submit» pulsa Intro al terminar. No lo uses para contraseñas ni datos de pago.",
            "inputSchema": { "type": "object", "properties": { "tabId": tab, "ref": reference, "text": { "type": "string", "maxLength": 20000 }, "submit": { "type": "boolean" } },
                "required": ["tabId", "text"], "additionalProperties": false } }),
        json!({ "name": "key", "description": "Pulsa una tecla o combinación en la pestaña: Enter, Escape, Tab, ArrowDown, PageDown, ctrl+a…",
            "inputSchema": { "type": "object", "properties": { "tabId": tab, "key": { "type": "string", "maxLength": 40 } }, "required": ["tabId", "key"], "additionalProperties": false } }),
        json!({ "name": "scroll", "description": "Desplaza la página, o lleva a la vista un elemento por su referencia.",
            "inputSchema": { "type": "object", "properties": { "tabId": tab, "direction": { "type": "string", "enum": ["up", "down", "top", "bottom"] }, "ref": reference },
                "required": ["tabId"], "additionalProperties": false } }),
        json!({ "name": "tab_close", "description": "Cierra una pestaña del grupo «trex».",
            "inputSchema": { "type": "object", "properties": { "tabId": tab }, "required": ["tabId"], "additionalProperties": false } }),
    ]
}


// --- Configuración guardada -------------------------------------------------------

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
struct Browser {
    id: String,
    name: String,
    /// Identificador de la extensión en ese navegador: el `Origin` que debe traer.
    extension_id: String,
    /// SHA-256 del token en hexadecimal; el token nunca se guarda.
    token_hash: String,
    created_at: u64,
    last_seen: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
struct BridgeConfig {
    enabled: bool,
    port: u16,
    browsers: Vec<Browser>,
}

impl Default for BridgeConfig {
    fn default() -> Self { Self { enabled: false, port: DEFAULT_PORT, browsers: Vec::new() } }
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map(|dir| dir.join(CONFIG_FILE))
        .map_err(|error| format!("No se encontró la carpeta de datos de la app: {error}"))
}

fn clean_config(mut config: BridgeConfig) -> BridgeConfig {
    config.browsers.retain(|browser| valid_hash(&browser.token_hash) && !browser.id.is_empty() && valid_extension_id(&browser.extension_id));
    if config.port < 1024 { config.port = DEFAULT_PORT; }
    config
}

fn load_config(app: &AppHandle) -> BridgeConfig {
    let Ok(path) = config_path(app) else { return BridgeConfig::default() };
    let Ok(text) = std::fs::read_to_string(path) else { return BridgeConfig::default() };
    clean_config(serde_json::from_str(&text).unwrap_or_default())
}

fn save_config(app: &AppHandle, config: &BridgeConfig) -> Result<(), String> {
    let path = config_path(app)?;
    if let Some(dir) = path.parent() { std::fs::create_dir_all(dir).map_err(|e| e.to_string())?; }
    let text = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    let temporary = path.with_extension("json.tmp");
    std::fs::write(&temporary, text).map_err(|e| format!("No se pudo guardar la conexión con el navegador: {e}"))?;
    std::fs::rename(&temporary, &path).map_err(|e| format!("No se pudo guardar la conexión con el navegador: {e}"))
}

// --- Comprobaciones de las cabeceras ----------------------------------------------

/// Los identificadores de extensión de Chromium son 32 letras de la «a» a la «p».
fn valid_extension_id(value: &str) -> bool {
    value.len() == 32 && value.bytes().all(|byte| (b'a'..=b'p').contains(&byte))
}

/// El identificador de la extensión que hace la petición, si el `Origin` es el de una extensión.
fn extension_origin(headers: &HeaderMap) -> Option<String> {
    let origin = headers.get(header::ORIGIN)?.to_str().ok()?;
    let id = origin.strip_prefix("chrome-extension://")?.trim_end_matches('/');
    valid_extension_id(id).then(|| id.to_string())
}

/// El `Host` debe ser exactamente este servidor: corta el DNS rebinding (una web que
/// resuelve su dominio a 127.0.0.1 llegaría con su propio nombre en `Host`).
fn local_host(headers: &HeaderMap, port: u16) -> bool {
    let Some(host) = headers.get(header::HOST).and_then(|value| value.to_str().ok()) else { return false };
    host == format!("127.0.0.1:{port}") || host == format!("localhost:{port}")
}

fn bearer(headers: &HeaderMap) -> Option<&str> {
    headers.get(header::AUTHORIZATION)?.to_str().ok()?.strip_prefix("Bearer ")
}

fn clean_name(value: &str) -> String {
    let name: String = value.chars().filter(|c| !c.is_control()).collect::<String>().split_whitespace().collect::<Vec<_>>().join(" ");
    let name: String = name.chars().take(60).collect();
    if name.is_empty() { "Navegador".into() } else { name }
}

// --- Estado compartido --------------------------------------------------------------

struct Pairing { code: String, expires: Instant, attempts: u32 }

struct Running { shutdown: watch::Sender<bool>, port: u16 }

/// La extensión conectada ahora mismo (una a la vez: la última que entra manda).
struct Link {
    connection: u64,
    browser_id: String,
    version: String,
    tx: mpsc::Sender<String>,
}

/// Un chat con acceso a las herramientas: su token (solo el hash) y su modo.
struct Session { key: String, mode: Mode, used: Instant }

pub struct Inner {
    app: Mutex<Option<AppHandle>>,
    config: Mutex<BridgeConfig>,
    pairing: Mutex<Option<Pairing>>,
    server: Mutex<Option<Running>>,
    error: Mutex<Option<String>>,
    link: Mutex<Option<Link>>,
    pending: Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>,
    /// Por hash del token.
    sessions: Mutex<HashMap<String, Session>>,
    /// Navegadores desvinculados: su conexión se cierra y la extensión olvida su token.
    revoked: broadcast::Sender<Arc<str>>,
    next_id: AtomicU64,
    /// Sube cada vez que el servidor se para. Lo vigilan el arranque pendiente (para no
    /// seguir) y las conexiones abiertas de la extensión (para cerrarse sin desemparejar).
    generation: watch::Sender<u64>,
}

#[derive(Clone)]
pub struct BridgeState(Arc<Inner>);

impl Default for BridgeState {
    fn default() -> Self {
        let (revoked, _) = broadcast::channel(16);
        Self(Arc::new(Inner {
            app: Mutex::new(None), config: Mutex::new(BridgeConfig::default()), pairing: Mutex::new(None), server: Mutex::new(None),
            error: Mutex::new(None), link: Mutex::new(None), pending: Mutex::new(HashMap::new()), sessions: Mutex::new(HashMap::new()),
            revoked, next_id: AtomicU64::new(1), generation: watch::channel(0).0,
        }))
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl Inner {
    fn app(&self) -> Option<AppHandle> { lock(&self.app).clone() }

    fn announce(&self) {
        if let Some(app) = self.app() { let _ = app.emit(EVENT_STATUS, json!({})); }
    }

    fn port(&self) -> Option<u16> { lock(&self.server).as_ref().map(|running| running.port) }

    fn generation(&self) -> u64 { *self.generation.borrow() }

    /// Canjea el código por un token. El navegador queda ligado a la extensión que lo pidió.
    fn pair(&self, code: &str, name: &str, extension_id: &str) -> Result<(String, Browser), (StatusCode, String)> {
        let code = normalize_code(code);
        let mut pairing = lock(&self.pairing);
        let Some(active) = pairing.as_mut() else {
            return Err((StatusCode::FORBIDDEN, "No hay ningún emparejado abierto. Ábrelo en trex › Ajustes › Conexiones › Navegador.".into()));
        };
        if active.expires < Instant::now() {
            *pairing = None;
            return Err((StatusCode::FORBIDDEN, "El código caducó. Genera otro en trex.".into()));
        }
        if !same_secret(&active.code, &code) {
            active.attempts += 1;
            if active.attempts >= PAIRING_ATTEMPTS {
                *pairing = None;
                return Err((StatusCode::FORBIDDEN, "Demasiados intentos. Genera un código nuevo en trex.".into()));
            }
            return Err((StatusCode::UNAUTHORIZED, "El código no es correcto.".into()));
        }
        *pairing = None;
        drop(pairing);
        let token = base64_url(&random_bytes::<32>().map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?);
        let id = hex(&random_bytes::<8>().map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?);
        let now = now_ms();
        let browser = Browser { id, name: clean_name(name), extension_id: extension_id.to_string(), token_hash: token_hash(&token), created_at: now, last_seen: now };
        let snapshot = {
            let mut config = lock(&self.config);
            config.browsers.push(browser.clone());
            while config.browsers.len() > MAX_BROWSERS {
                let oldest = config.browsers.iter().enumerate().min_by_key(|(_, b)| b.last_seen).map(|(i, _)| i).unwrap_or(0);
                config.browsers.remove(oldest);
            }
            config.clone()
        };
        if let Some(app) = self.app() { save_config(&app, &snapshot).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?; }
        Ok((token, browser))
    }

    /// El navegador de un token, solo si la petición viene de su misma extensión.
    fn authenticate(&self, token: &str, extension_id: &str) -> Option<Browser> {
        if token.len() < 32 || token.len() > 128 { return None; }
        let hash = token_hash(token);
        let mut config = lock(&self.config);
        let browser = config.browsers.iter_mut().find(|browser| same_secret(&browser.token_hash, &hash) && browser.extension_id == extension_id)?;
        browser.last_seen = now_ms();
        let found = browser.clone();
        let snapshot = config.clone();
        drop(config);
        if let Some(app) = self.app() { let _ = save_config(&app, &snapshot); }
        Some(found)
    }

    fn session(&self, token: &str) -> Option<(String, Mode)> {
        if token.len() != 64 || !token.bytes().all(|byte| byte.is_ascii_hexdigit()) { return None; }
        let hash = token_hash(token);
        let mut sessions = lock(&self.sessions);
        let session = sessions.iter_mut().find(|(known, _)| same_secret(known, &hash)).map(|(_, session)| session)?;
        session.used = Instant::now();
        Some((session.key.clone(), session.mode))
    }

    /// Token para un chat. Volver a pedirlo para el mismo chat sustituye al anterior
    /// (por ejemplo, al cambiar de modo): el viejo deja de valer.
    fn issue_session(&self, key: &str, mode: Mode) -> Result<String, String> {
        let token = hex(&random_bytes::<32>()?);
        let mut sessions = lock(&self.sessions);
        sessions.retain(|_, session| session.key != key);
        while sessions.len() >= MAX_SESSIONS {
            let Some(oldest) = sessions.iter().min_by_key(|(_, session)| session.used).map(|(hash, _)| hash.clone()) else { break };
            sessions.remove(&oldest);
        }
        sessions.insert(token_hash(&token), Session { key: key.to_string(), mode, used: Instant::now() });
        Ok(token)
    }

    /// El modo del chat cambió (por ejemplo, salió de planificar): mismo token, otro permiso.
    fn set_mode(&self, key: &str, mode: Mode) -> bool {
        let mut sessions = lock(&self.sessions);
        let Some(session) = sessions.values_mut().find(|session| session.key == key) else { return false };
        session.mode = mode;
        true
    }

    /// Manda una orden a la extensión y espera su respuesta.
    async fn call(&self, method: &str, params: Value) -> Result<Value, String> {
        let tx = lock(&self.link).as_ref().map(|link| link.tx.clone())
            .ok_or("La extensión de trex no está conectada. Abre el navegador y comprueba que la extensión esté activa.")?;
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (done_tx, done_rx) = oneshot::channel();
        lock(&self.pending).insert(id, done_tx);
        let message = json!({ "type": "call", "id": id, "method": method, "params": params }).to_string();
        if tx.send(message).await.is_err() {
            lock(&self.pending).remove(&id);
            return Err("La extensión de trex se desconectó.".into());
        }
        let outcome = tokio::time::timeout(TOOL_TIMEOUT, done_rx).await;
        lock(&self.pending).remove(&id);
        match outcome {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err("La extensión de trex se desconectó antes de responder.".into()),
            Err(_) => Err("El navegador no respondió a tiempo.".into()),
        }
    }

    fn fail_pending(&self, reason: &str) {
        for (_, sender) in lock(&self.pending).drain() { let _ = sender.send(Err(reason.to_string())); }
    }
}

// --- Rutas de la extensión ------------------------------------------------------------

#[derive(Deserialize)]
struct PairRequest {
    code: String,
    #[serde(default)]
    name: String,
}

fn forbidden() -> Response { (StatusCode::FORBIDDEN, Json(json!({ "error": "Origen no permitido." }))).into_response() }

fn no_store(mut response: Response) -> Response {
    let headers = response.headers_mut();
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert("x-content-type-options", HeaderValue::from_static("nosniff"));
    response
}

async fn pair(AxumState(state): AxumState<BridgeState>, headers: HeaderMap, Json(request): Json<PairRequest>) -> Response {
    let (Some(port), Some(extension)) = (state.0.port(), extension_origin(&headers)) else { return forbidden() };
    if !local_host(&headers, port) { return forbidden(); }
    if request.code.len() > 32 || request.name.len() > 256 { return (StatusCode::BAD_REQUEST, Json(json!({ "error": "Petición no válida." }))).into_response(); }
    match state.0.pair(&request.code, &request.name, &extension) {
        Ok((token, browser)) => {
            state.0.announce();
            no_store(Json(json!({ "token": token, "browser": { "id": browser.id, "name": browser.name } })).into_response())
        }
        Err((status, error)) => {
            // Un intento fallido puede haber cerrado el emparejado (caducado o sin intentos):
            // Ajustes deja de mostrar un código que ya no sirve.
            state.0.announce();
            no_store((status, Json(json!({ "error": error }))).into_response())
        }
    }
}

async fn websocket(AxumState(state): AxumState<BridgeState>, headers: HeaderMap, upgrade: WebSocketUpgrade) -> Response {
    // La del servidor que acepta la conexión: si se para después, ella también se cierra.
    let generation = state.0.generation();
    let (Some(port), Some(extension)) = (state.0.port(), extension_origin(&headers)) else { return forbidden() };
    if !local_host(&headers, port) { return forbidden(); }
    // Sin navegadores emparejados con esa extensión no hay nada que hablar.
    if !lock(&state.0.config).browsers.iter().any(|browser| browser.extension_id == extension) { return forbidden(); }
    upgrade.max_message_size(MAX_EXTENSION_MESSAGE).max_frame_size(MAX_EXTENSION_MESSAGE)
        .on_upgrade(move |socket| connection(state, socket, extension, generation))
}

fn text(value: Value) -> Message { Message::Text(value.to_string().into()) }

/// La conexión de la extensión: primero el token, después órdenes y respuestas.
async fn connection(state: BridgeState, mut socket: WebSocket, extension: String, generation: u64) {
    let inner = state.0.clone();
    // Se suscribe antes que nada: un `watch` entrega el valor actual, así que un paro que
    // llegue mientras se saluda tampoco se pierde.
    let mut stopped = inner.generation.subscribe();
    let hello = tokio::time::timeout(HELLO_TIMEOUT, socket.recv()).await;
    let hello = match hello {
        Ok(Some(Ok(Message::Text(message)))) => serde_json::from_str::<Value>(message.as_str()).ok().filter(|value| value["type"] == "hello"),
        _ => None,
    };
    let browser = hello.as_ref().and_then(|value| value["token"].as_str()).and_then(|token| inner.authenticate(token, &extension));
    let Some(browser) = browser else {
        let _ = socket.send(text(json!({ "type": "denied", "error": "Este navegador ya no está emparejado con trex. Vuelve a emparejarlo." }))).await;
        let _ = socket.send(Message::Close(None)).await;
        return;
    };
    let version: String = hello.as_ref().and_then(|value| value["version"].as_str()).unwrap_or("").chars().filter(|c| c.is_ascii_graphic()).take(24).collect();
    let id = inner.next_id.fetch_add(1, Ordering::Relaxed);
    let (tx, mut rx) = mpsc::channel::<String>(32);
    let mut revoked = inner.revoked.subscribe();
    *lock(&inner.link) = Some(Link { connection: id, browser_id: browser.id.clone(), version, tx });
    inner.announce();

    let mut ok = socket.send(text(json!({ "type": "ready", "app": env!("CARGO_PKG_VERSION"), "browser": { "id": browser.id, "name": browser.name } }))).await.is_ok();
    let mut keepalive = tokio::time::interval(KEEPALIVE);
    keepalive.tick().await;
    while ok {
        tokio::select! {
            incoming = socket.recv() => {
                let Some(Ok(message)) = incoming else { break };
                match message {
                    Message::Text(body) => handle_extension(&inner, body.as_str()),
                    Message::Close(_) => break,
                    _ => {}
                }
            }
            outgoing = rx.recv() => {
                // Otra conexión de la extensión ocupó el sitio: esta se cierra.
                let Some(outgoing) = outgoing else { break };
                ok = socket.send(Message::Text(outgoing.into())).await.is_ok();
            }
            gone = revoked.recv() => {
                if matches!(gone, Ok(ref id) if **id == *browser.id) {
                    let _ = socket.send(text(json!({ "type": "denied", "error": "Este navegador se desvinculó desde trex." }))).await;
                    break;
                }
            }
            _ = keepalive.tick() => { ok = socket.send(text(json!({ "type": "ping" }))).await.is_ok(); }
            _ = async { let _ = stopped.wait_for(|current| *current != generation).await; } => {
                // trex apagó el puente o cambió de puerto. No es una desvinculación: sin `denied`,
                // la extensión conserva su token y vuelve a conectar cuando el puente escuche otra vez.
                let _ = socket.send(Message::Close(None)).await;
                break;
            }
        }
    }
    let mine = {
        let mut link = lock(&inner.link);
        let mine = link.as_ref().is_some_and(|link| link.connection == id);
        if mine { *link = None; }
        mine
    };
    if mine {
        inner.fail_pending("La extensión de trex se desconectó.");
        inner.announce();
    }
}

/// Respuesta de la extensión a una orden. Lo demás (el `pong`) solo mantiene viva la conexión.
fn handle_extension(inner: &Arc<Inner>, body: &str) {
    let Ok(value) = serde_json::from_str::<Value>(body) else { return };
    if value["type"] != "result" { return; }
    let Some(id) = value["id"].as_u64() else { return };
    let Some(sender) = lock(&inner.pending).remove(&id) else { return };
    let outcome = if value["ok"] == true {
        Ok(value.get("value").cloned().unwrap_or(Value::Null))
    } else {
        Err(value["error"].as_str().unwrap_or("El navegador no pudo hacerlo.").chars().take(2000).collect())
    };
    let _ = sender.send(outcome);
}

// --- Herramientas para los agentes (MCP por HTTP, respuestas JSON) ---------------------

fn mcp_reply(status: StatusCode, body: Option<Value>) -> Response {
    no_store(match body {
        Some(body) => (status, Json(body)).into_response(),
        None => status.into_response(),
    })
}

/// Lo que devuelve la extensión, en la forma que espera el agente: texto y, si hay, una imagen.
fn tool_content(value: &Value) -> Value {
    let mut content = Vec::new();
    if let Some(text) = value["text"].as_str().filter(|text| !text.is_empty()) {
        content.push(json!({ "type": "text", "text": text }));
    }
    let image = &value["image"];
    if let (Some(mime), Some(data)) = (image["mimeType"].as_str(), image["data"].as_str()) {
        if matches!(mime, "image/png" | "image/jpeg") && !data.is_empty() {
            content.push(json!({ "type": "image", "mimeType": mime, "data": data }));
        }
    }
    if content.is_empty() { content.push(json!({ "type": "text", "text": "Hecho." })); }
    json!({ "content": content, "isError": false })
}

fn tool_error(message: &str) -> Value {
    json!({ "content": [{ "type": "text", "text": message }], "isError": true })
}

/// Una petición JSON-RPC de un agente ya autenticado. `None`: es un aviso, no lleva respuesta.
async fn handle_mcp(inner: &Arc<Inner>, session: &str, mode: Mode, message: &Value) -> Option<Value> {
    let id = message.get("id")?.clone();
    let ok = |result: Value| Some(json!({ "jsonrpc": "2.0", "id": id, "result": result }));
    let fail = |code: i64, text: &str| Some(json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": text } }));
    match message["method"].as_str().unwrap_or("") {
        "initialize" => {
            let requested = message["params"]["protocolVersion"].as_str().unwrap_or("");
            let version = if MCP_VERSIONS.contains(&requested) { requested } else { PROTOCOL };
            ok(json!({ "protocolVersion": version, "capabilities": { "tools": { "listChanged": false } },
                "serverInfo": { "name": "trex-chrome", "version": env!("CARGO_PKG_VERSION") }, "instructions": INSTRUCTIONS }))
        }
        "ping" => ok(json!({})),
        // Se listan todas: el modo de un chat puede cambiar sin que el agente vuelva a pedir la
        // lista, y lo que vale es la comprobación de cada llamada, más abajo.
        "tools/list" => ok(json!({ "tools": tool_specs() })),
        "tools/call" => {
            let params = &message["params"];
            let (Some(name), true) = (params["name"].as_str(), params["arguments"].is_object() || params["arguments"].is_null()) else {
                return fail(-32602, "tools/call necesita un nombre y un objeto de argumentos");
            };
            if !OBSERVE_TOOLS.contains(&name) && !ACTION_TOOLS.contains(&name) { return fail(-32602, "Herramienta desconocida"); }
            if !mode.allows(name) {
                return ok(tool_error("Este chat está en modo de solo lectura: puede mirar el navegador, pero no manejarlo. Cambia el modo de permisos para actuar."));
            }
            let arguments = if params["arguments"].is_object() { params["arguments"].clone() } else { json!({}) };
            match inner.call(name, json!({ "session": session, "arguments": arguments })).await {
                Ok(value) => ok(tool_content(&value)),
                Err(error) => ok(tool_error(&error)),
            }
        }
        _ => fail(-32601, "Método no encontrado"),
    }
}

async fn mcp(AxumState(state): AxumState<BridgeState>, headers: HeaderMap, body: Bytes) -> Response {
    let inner = &state.0;
    let Some(port) = inner.port() else { return mcp_reply(StatusCode::SERVICE_UNAVAILABLE, None) };
    // Un agente no es un navegador: cualquier `Origin` delata a una web y se rechaza.
    if !local_host(&headers, port) || headers.contains_key(header::ORIGIN) {
        return mcp_reply(StatusCode::FORBIDDEN, Some(json!({ "error": "Forbidden" })));
    }
    let Some((session, mode)) = bearer(&headers).and_then(|token| inner.session(token)) else {
        let mut response = mcp_reply(StatusCode::UNAUTHORIZED, Some(json!({ "error": "La sesión de trex para el navegador no es válida o caducó." })));
        response.headers_mut().insert(header::WWW_AUTHENTICATE, HeaderValue::from_static("Bearer"));
        return response;
    };
    let json_body = headers.get(header::CONTENT_TYPE).and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.to_ascii_lowercase().starts_with("application/json"));
    if !json_body { return mcp_reply(StatusCode::UNSUPPORTED_MEDIA_TYPE, Some(json!({ "error": "application/json required" }))); }
    let message: Value = match serde_json::from_slice(&body) {
        Ok(message) => message,
        Err(_) => return mcp_reply(StatusCode::BAD_REQUEST, Some(json!({ "jsonrpc": "2.0", "id": null, "error": { "code": -32700, "message": "JSON no válido" } }))),
    };
    if !message.is_object() || message["jsonrpc"] != "2.0" {
        return mcp_reply(StatusCode::BAD_REQUEST, Some(json!({ "jsonrpc": "2.0", "id": null, "error": { "code": -32600, "message": "Petición no válida" } })));
    }
    match handle_mcp(inner, &session, mode, &message).await {
        Some(reply) => mcp_reply(StatusCode::OK, Some(reply)),
        None => mcp_reply(StatusCode::ACCEPTED, None),
    }
}

/// Este servidor no transmite: quien pida el canal de eventos con GET recibe un 405.
async fn mcp_get() -> Response {
    let mut response = mcp_reply(StatusCode::METHOD_NOT_ALLOWED, Some(json!({ "error": "Use POST; this server does not stream" })));
    response.headers_mut().insert(header::ALLOW, HeaderValue::from_static("POST"));
    response
}

// --- Arranque y parada ------------------------------------------------------------------

fn stop(inner: &Arc<Inner>) {
    // Las conexiones abiertas no se cierran solas con el servidor: vigilan este número.
    inner.generation.send_modify(|generation| *generation += 1);
    if let Some(running) = lock(&inner.server).take() { let _ = running.shutdown.send(true); }
    lock(&inner.sessions).clear();
    *lock(&inner.pairing) = None;
}

fn start(state: &BridgeState) {
    let inner = state.0.clone();
    stop(&inner);
    *lock(&inner.error) = None;
    let config = lock(&inner.config).clone();
    if !config.enabled { return; }
    let generation = inner.generation();
    let state = state.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            if inner.generation() != generation { return; }
            match bind(&state, config.port).await {
                Ok(running) => {
                    if inner.generation() != generation { let _ = running.shutdown.send(true); return; }
                    *lock(&inner.server) = Some(running);
                    *lock(&inner.error) = None;
                    inner.announce();
                    return;
                }
                Err(error) => {
                    *lock(&inner.error) = Some(error);
                    inner.announce();
                    tokio::time::sleep(RETRY_BIND).await;
                }
            }
        }
    });
}

fn router(state: &BridgeState) -> Router {
    Router::new()
        .route("/pair", post(pair))
        .route("/ws", get(websocket))
        .route("/mcp", post(mcp).get(mcp_get))
        .layer(DefaultBodyLimit::max(MAX_MCP_BODY))
        .with_state(state.clone())
}

async fn bind(state: &BridgeState, port: u16) -> Result<Running, String> {
    // Solo la interfaz local: nada de fuera del equipo puede llegar a este servidor.
    let address = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    let listener = tokio::net::TcpListener::bind(address).await.map_err(|error| match error.kind() {
        std::io::ErrorKind::AddrInUse => format!("El puerto {port} ya está en uso. Elige otro."),
        _ => format!("No se pudo escuchar en {address}: {error}"),
    })?;
    // El puerto real (el pedido, salvo en pruebas, que piden «cualquiera libre»).
    let port = listener.local_addr().map(|address| address.port()).unwrap_or(port);
    let (shutdown, _) = watch::channel(false);
    let mut stop = shutdown.subscribe();
    let router = router(state);
    tauri::async_runtime::spawn(async move {
        let _ = axum::serve(listener, router).with_graceful_shutdown(async move { let _ = stop.wait_for(|stop| *stop).await; }).await;
    });
    Ok(Running { shutdown, port })
}

/// Al abrir trex: arranca solo si la persona lo dejó activado.
pub fn init(app: &AppHandle) {
    let state = app.state::<BridgeState>().inner().clone();
    *lock(&state.0.app) = Some(app.clone());
    *lock(&state.0.config) = load_config(app);
    if lock(&state.0.config).enabled { start(&state); }
}

/// Carpeta de la extensión para «Cargar descomprimida»: junto a la app instalada, o la del repositorio al desarrollar.
/// Abre la carpeta de la extensión en el explorador de archivos. La ruta la decide la app,
/// no la interfaz: así no hace falta dar a la ventana permiso para abrir rutas cualesquiera.
#[tauri::command]
pub fn browser_bridge_open_extension(app: AppHandle) -> Result<(), String> {
    let dir = extension_dir(&app).ok_or("No se encontró la carpeta de la extensión.")?;
    tauri_plugin_opener::open_path(&dir, None::<&str>).map_err(|error| format!("No se pudo abrir «{}»: {error}", dir.display()))
}

fn extension_dir(app: &AppHandle) -> Option<PathBuf> {
    let bundled = app.path().resource_dir().ok().map(|dir| dir.join("extension"));
    let development = cfg!(debug_assertions).then(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("extension"));
    [bundled, development].into_iter().flatten().find(|dir| dir.join("manifest.json").is_file())
        .map(|dir| dir.canonicalize().unwrap_or(dir))
}

// --- Para Ajustes y para los chats ---------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairedBrowser { id: String, name: String, created_at: u64, last_seen: u64, connected: bool, version: Option<String> }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeStatus {
    enabled: bool,
    port: u16,
    running: bool,
    error: Option<String>,
    /// Hay una extensión conectada ahora: las herramientas funcionan.
    connected: bool,
    browsers: Vec<PairedBrowser>,
    pairing: bool,
    extension_path: Option<String>,
}

fn status_of(app: &AppHandle, state: &BridgeState) -> BridgeStatus {
    let inner = &state.0;
    let config = lock(&inner.config).clone();
    let link = lock(&inner.link).as_ref().map(|link| (link.browser_id.clone(), link.version.clone()));
    let pairing = lock(&inner.pairing).as_ref().is_some_and(|pairing| pairing.expires > Instant::now());
    let mut browsers: Vec<PairedBrowser> = config.browsers.iter().map(|browser| {
        let live = link.as_ref().filter(|(id, _)| *id == browser.id);
        PairedBrowser { id: browser.id.clone(), name: browser.name.clone(), created_at: browser.created_at, last_seen: browser.last_seen,
            connected: live.is_some(), version: live.map(|(_, version)| version.clone()).filter(|version| !version.is_empty()) }
    }).collect();
    browsers.sort_by(|a, b| b.connected.cmp(&a.connected).then(b.last_seen.cmp(&a.last_seen)));
    BridgeStatus { enabled: config.enabled, port: config.port, running: lock(&inner.server).is_some(), error: lock(&inner.error).clone(),
        connected: link.is_some(), browsers, pairing, extension_path: extension_dir(app).map(|dir| dir.to_string_lossy().into_owned()) }
}

#[tauri::command]
pub fn browser_bridge_status(app: AppHandle, state: State<'_, BridgeState>) -> BridgeStatus {
    status_of(&app, state.inner())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeSettings { enabled: bool, port: u16 }

#[tauri::command]
pub fn browser_bridge_configure(app: AppHandle, state: State<'_, BridgeState>, settings: BridgeSettings) -> Result<BridgeStatus, String> {
    if settings.port < 1024 { return Err("Usa un puerto entre 1024 y 65535.".into()); }
    let state = state.inner().clone();
    let (previous, snapshot) = {
        let mut config = lock(&state.0.config);
        let previous = config.clone();
        config.enabled = settings.enabled;
        config.port = settings.port;
        (previous, config.clone())
    };
    save_config(&app, &snapshot)?;
    if !snapshot.enabled { stop(&state.0); *lock(&state.0.error) = None; }
    else if !previous.enabled || previous.port != snapshot.port || lock(&state.0.server).is_none() { start(&state); }
    state.0.announce();
    Ok(status_of(&app, &state))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingCode { code: String, expires_at: u64, port: u16 }

#[tauri::command]
pub fn browser_bridge_pairing_start(state: State<'_, BridgeState>) -> Result<PairingCode, String> {
    let port = state.0.port().ok_or("Activa la conexión con tu navegador y espera a que esté lista.")?;
    let code = new_code()?;
    *lock(&state.0.pairing) = Some(Pairing { code: code.clone(), expires: Instant::now() + PAIRING_TTL, attempts: 0 });
    state.0.announce();
    Ok(PairingCode { code, expires_at: now_ms() + PAIRING_TTL.as_millis() as u64, port })
}

#[tauri::command]
pub fn browser_bridge_pairing_cancel(state: State<'_, BridgeState>) {
    *lock(&state.0.pairing) = None;
    state.0.announce();
}

#[tauri::command]
pub fn browser_bridge_revoke(app: AppHandle, state: State<'_, BridgeState>, browser: String) -> Result<BridgeStatus, String> {
    let snapshot = {
        let mut config = lock(&state.0.config);
        config.browsers.retain(|known| known.id != browser);
        config.clone()
    };
    save_config(&app, &snapshot)?;
    let _ = state.0.revoked.send(browser.into());
    state.0.announce();
    Ok(status_of(&app, state.inner()))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpSession { url: String, token: String, mode: &'static str, connected: bool }

/// Acceso de un chat a las herramientas. `None`: la función está apagada o aún no escucha,
/// y el chat simplemente no las tiene.
#[tauri::command]
pub fn browser_bridge_mcp_session(state: State<'_, BridgeState>, session: String, mode: String) -> Result<Option<McpSession>, String> {
    let mode = Mode::parse(&mode).ok_or("Modo no válido.")?;
    if session.is_empty() || session.len() > 128 || !session.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b':' | b'.')) {
        return Err("Sesión no válida.".into());
    }
    let Some(port) = state.0.port() else { return Ok(None) };
    let token = state.0.issue_session(&session, mode)?;
    let connected = lock(&state.0.link).is_some();
    Ok(Some(McpSession { url: format!("http://127.0.0.1:{port}/mcp"), token, mode: mode.name(), connected }))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpStdio { command: String, args: Vec<String>, token: String, mode: &'static str }

/// Lo mismo para los agentes que solo hablan MCP por stdio (Antigravity, Trex CLI): este mismo
/// ejecutable hace de adaptador (`browser_bridge_stdio.rs`). El token no va en los argumentos:
/// quien lanza al agente lo pone en su entorno.
#[tauri::command]
pub fn browser_bridge_mcp_stdio(state: State<'_, BridgeState>, session: String, mode: String) -> Result<Option<McpStdio>, String> {
    let Some(http) = browser_bridge_mcp_session(state, session, mode)? else { return Ok(None) };
    let command = std::env::current_exe().map_err(|error| format!("No se encontró el ejecutable de trex: {error}"))?;
    Ok(Some(McpStdio { command: command.to_string_lossy().into_owned(), args: vec![crate::browser_bridge_stdio::FLAG.into(), http.url], token: http.token, mode: http.mode }))
}

/// El modo de permisos de un chat cambió: sus herramientas pasan a observar o a completo.
#[tauri::command]
pub fn browser_bridge_set_mode(state: State<'_, BridgeState>, session: String, mode: String) -> Result<bool, String> {
    let mode = Mode::parse(&mode).ok_or("Modo no válido.")?;
    Ok(state.0.set_mode(&session, mode))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn headers(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut map = HeaderMap::new();
        for (name, value) in pairs {
            map.insert(axum::http::HeaderName::from_bytes(name.as_bytes()).unwrap(), HeaderValue::from_str(value).unwrap());
        }
        map
    }

    const EXTENSION: &str = "abcdefghijklmnopabcdefghijklmnop";

    fn state_with_pairing(code: &str) -> BridgeState {
        let state = BridgeState::default();
        *lock(&state.0.pairing) = Some(Pairing { code: code.into(), expires: Instant::now() + PAIRING_TTL, attempts: 0 });
        state
    }

    #[test]
    fn only_a_real_extension_origin_is_accepted() {
        let origin = format!("chrome-extension://{EXTENSION}");
        assert_eq!(extension_origin(&headers(&[("origin", &origin)])).as_deref(), Some(EXTENSION));
        // Una web, por muy local que sea, no es la extensión.
        for other in ["http://127.0.0.1:7341", "https://example.com", "chrome-extension://short", "chrome-extension://ABCDEFGHIJKLMNOPABCDEFGHIJKLMNOP",
            "chrome-extension://abcdefghijklmnopabcdefghijklmnoz", "null", ""] {
            assert_eq!(extension_origin(&headers(&[("origin", other)])), None, "{other}");
        }
        assert_eq!(extension_origin(&headers(&[])), None);
    }

    #[test]
    fn the_host_header_must_be_this_local_server() {
        assert!(local_host(&headers(&[("host", "127.0.0.1:7341")]), 7341));
        assert!(local_host(&headers(&[("host", "localhost:7341")]), 7341));
        // DNS rebinding: la web llega con su propio nombre aunque resuelva a 127.0.0.1.
        for other in ["evil.example:7341", "127.0.0.1:7342", "127.0.0.1", "127.0.0.1.evil.example:7341"] {
            assert!(!local_host(&headers(&[("host", other)]), 7341), "{other}");
        }
        assert!(!local_host(&headers(&[]), 7341));
    }

    #[test]
    fn a_code_pairs_once_and_binds_the_token_to_its_extension() {
        let state = state_with_pairing("ABC234");
        let (token, browser) = state.0.pair("abc-234", "Brave de casa", EXTENSION).unwrap();
        assert_eq!(browser.name, "Brave de casa");
        assert_eq!(browser.extension_id, EXTENSION);
        // En disco solo iría el hash, nunca el token.
        let stored = lock(&state.0.config).browsers[0].clone();
        assert!(valid_hash(&stored.token_hash) && stored.token_hash != token);
        // El código ya se gastó.
        assert_eq!(state.0.pair("ABC234", "otro", EXTENSION).unwrap_err().0, StatusCode::FORBIDDEN);
        // El token solo vale desde la misma extensión.
        assert!(state.0.authenticate(&token, EXTENSION).is_some());
        assert!(state.0.authenticate(&token, "ponmlkjihgfedcbaponmlkjihgfedcba").is_none());
        assert!(state.0.authenticate("no-es-un-token-pero-es-largo-de-sobra-123", EXTENSION).is_none());
    }

    #[test]
    fn wrong_codes_run_out_and_expired_codes_are_refused() {
        let state = state_with_pairing("ABC234");
        for _ in 0..PAIRING_ATTEMPTS - 1 {
            assert_eq!(state.0.pair("ZZZZZZ", "x", EXTENSION).unwrap_err().0, StatusCode::UNAUTHORIZED);
        }
        assert_eq!(state.0.pair("ZZZZZZ", "x", EXTENSION).unwrap_err().0, StatusCode::FORBIDDEN);
        // Tras agotar los intentos, ni el código bueno vale.
        assert_eq!(state.0.pair("ABC234", "x", EXTENSION).unwrap_err().0, StatusCode::FORBIDDEN);

        let state = BridgeState::default();
        *lock(&state.0.pairing) = Some(Pairing { code: "ABC234".into(), expires: Instant::now() - Duration::from_secs(1), attempts: 0 });
        assert_eq!(state.0.pair("ABC234", "x", EXTENSION).unwrap_err().0, StatusCode::FORBIDDEN);
    }

    #[test]
    fn each_mode_only_lists_and_allows_its_tools() {
        let listed: Vec<String> = tool_specs().into_iter().map(|tool| tool["name"].as_str().unwrap().to_string()).collect();
        assert_eq!(listed, [OBSERVE_TOOLS.as_slice(), ACTION_TOOLS.as_slice()].concat());
        for tool in OBSERVE_TOOLS { assert!(Mode::Observe.allows(tool) && Mode::Full.allows(tool), "{tool}"); }
        for tool in ACTION_TOOLS { assert!(!Mode::Observe.allows(tool) && Mode::Full.allows(tool), "{tool}"); }
        assert!(!Mode::Full.allows("eval") && !Mode::Full.allows(""));
        // Toda herramienta declara un esquema cerrado.
        for tool in tool_specs() {
            assert_eq!(tool["inputSchema"]["additionalProperties"], false, "{}", tool["name"]);
        }
    }

    #[test]
    fn a_chat_token_is_replaced_when_reissued_and_unknown_tokens_fail() {
        let state = BridgeState::default();
        let first = state.0.issue_session("t-1", Mode::Observe).unwrap();
        assert_eq!(state.0.session(&first), Some(("t-1".into(), Mode::Observe)));
        // Cambiar de modo da otro token; el anterior deja de valer.
        let second = state.0.issue_session("t-1", Mode::Full).unwrap();
        assert_eq!(state.0.session(&second), Some(("t-1".into(), Mode::Full)));
        assert_eq!(state.0.session(&first), None);
        assert_eq!(state.0.session(&"0".repeat(64)), None);
        assert_eq!(state.0.session("corto"), None);
        assert_eq!(lock(&state.0.sessions).len(), 1);
        // El modo de un chat abierto cambia sin tocar su token.
        assert!(state.0.set_mode("t-1", Mode::Observe));
        assert_eq!(state.0.session(&second), Some(("t-1".into(), Mode::Observe)));
        assert!(!state.0.set_mode("otro", Mode::Full));
    }

    #[test]
    fn tool_results_become_text_and_image_content() {
        let content = tool_content(&json!({ "text": "Hola", "image": { "mimeType": "image/png", "data": "AAAA" } }));
        assert_eq!(content["isError"], false);
        assert_eq!(content["content"][0], json!({ "type": "text", "text": "Hola" }));
        assert_eq!(content["content"][1]["type"], "image");
        // Un tipo que no es imagen no se reenvía como tal.
        let odd = tool_content(&json!({ "image": { "mimeType": "text/html", "data": "AAAA" } }));
        assert_eq!(odd["content"], json!([{ "type": "text", "text": "Hecho." }]));
        assert_eq!(tool_error("no")["isError"], true);
    }

    #[test]
    fn the_agent_protocol_answers_without_a_browser_and_respects_the_mode() {
        let state = BridgeState::default();
        let run = |mode, message: Value| tauri::async_runtime::block_on(handle_mcp(&state.0, "t-1", mode, &message));
        let init = run(Mode::Observe, json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": "2025-06-18" } })).unwrap();
        assert_eq!(init["result"]["protocolVersion"], "2025-06-18");
        assert_eq!(init["result"]["serverInfo"]["name"], "trex-chrome");
        // Los avisos no llevan respuesta.
        assert!(run(Mode::Observe, json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })).is_none());
        let listed = run(Mode::Observe, json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" })).unwrap();
        assert_eq!(listed["result"]["tools"].as_array().unwrap().len(), OBSERVE_TOOLS.len() + ACTION_TOOLS.len());
        // En solo lectura, una acción se rechaza aquí, antes de llegar al navegador.
        let blocked = run(Mode::Observe, json!({ "jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": { "name": "click", "arguments": { "tabId": 1, "ref": "ref_1" } } })).unwrap();
        assert_eq!(blocked["result"]["isError"], true);
        // Sin extensión conectada, la herramienta responde con un error legible en vez de colgarse.
        let offline = run(Mode::Full, json!({ "jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": { "name": "tabs_list", "arguments": {} } })).unwrap();
        assert_eq!(offline["result"]["isError"], true);
        assert!(offline["result"]["content"][0]["text"].as_str().unwrap().contains("no está conectada"));
        let unknown = run(Mode::Full, json!({ "jsonrpc": "2.0", "id": 5, "method": "tools/call", "params": { "name": "eval", "arguments": {} } })).unwrap();
        assert_eq!(unknown["error"]["code"], -32602);
        assert_eq!(run(Mode::Full, json!({ "jsonrpc": "2.0", "id": 6, "method": "resources/list" })).unwrap()["error"]["code"], -32601);
    }

    #[test]
    fn saved_browsers_with_a_broken_hash_or_extension_are_dropped() {
        let good = Browser { id: "a1".into(), name: "Brave".into(), extension_id: EXTENSION.into(), token_hash: "a".repeat(64), created_at: 1, last_seen: 1 };
        let config = clean_config(BridgeConfig { enabled: true, port: 80, browsers: vec![
            good.clone(),
            Browser { token_hash: "corto".into(), ..good.clone() },
            Browser { extension_id: "no".into(), ..good.clone() },
            Browser { id: String::new(), ..good.clone() },
        ] });
        assert_eq!(config.browsers, vec![good]);
        // Un puerto reservado guardado a mano vuelve al de siempre.
        assert_eq!(config.port, DEFAULT_PORT);
        assert!(!BridgeConfig::default().enabled, "apagado por defecto");
    }

    /// El recorrido completo, con un servidor de verdad en un puerto libre y una extensión de
    /// mentira: emparejar, conectar, y que la llamada de un agente llegue al navegador y vuelva.
    #[cfg(windows)]
    #[test]
    fn an_agent_call_travels_to_the_paired_extension_and_back() {
        use futures_util::{SinkExt, StreamExt};
        use std::io::{Read, Write};
        use tokio_tungstenite::tungstenite::client::IntoClientRequest;
        use tokio_tungstenite::tungstenite::Message as WsMessage;

        /// Una petición HTTP a mano, para poder poner el `Host` y el `Origin` que se quiera.
        fn http(port: u16, method: &str, path: &str, headers: &[(&str, String)], body: &str) -> (u16, Value) {
            let mut stream = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
            stream.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
            let mut request = format!("{method} {path} HTTP/1.1\r\nConnection: close\r\nContent-Length: {}\r\n", body.len());
            if !headers.iter().any(|(name, _)| name.eq_ignore_ascii_case("host")) { request.push_str(&format!("Host: 127.0.0.1:{port}\r\n")); }
            for (name, value) in headers { request.push_str(&format!("{name}: {value}\r\n")); }
            request.push_str("\r\n");
            request.push_str(body);
            stream.write_all(request.as_bytes()).unwrap();
            let mut response = String::new();
            let _ = stream.read_to_string(&mut response);
            let status = response.split_whitespace().nth(1).and_then(|code| code.parse().ok()).unwrap_or(0);
            let body = response.split("\r\n\r\n").nth(1).unwrap_or("");
            (status, serde_json::from_str(body).unwrap_or(Value::Null))
        }
        fn json_type() -> (&'static str, String) { ("Content-Type", "application/json".to_string()) }
        fn origin() -> (&'static str, String) { ("Origin", format!("chrome-extension://{EXTENSION}")) }
        async fn request(port: u16, method: &'static str, path: &'static str, headers: Vec<(&'static str, String)>, body: &'static str) -> (u16, Value) {
            tauri::async_runtime::spawn_blocking(move || http(port, method, path, &headers, body)).await.unwrap()
        }
        async fn next_json<S: StreamExt<Item = Result<WsMessage, tokio_tungstenite::tungstenite::Error>> + Unpin>(socket: &mut S) -> Value {
            loop {
                let message = socket.next().await.expect("la conexión sigue abierta").unwrap();
                if let WsMessage::Text(text) = message { return serde_json::from_str(text.as_str()).unwrap(); }
            }
        }

        tauri::async_runtime::block_on(async {
            let state = state_with_pairing("ABC234");
            lock(&state.0.config).enabled = true;
            let running = bind(&state, 0).await.unwrap();
            let port = running.port;
            *lock(&state.0.server) = Some(running);

            // Emparejar: una web no puede, ni con el código bueno; tampoco con otro `Host`.
            let pair_body = r#"{"code":"ABC234","name":"Brave"}"#;
            let (status, _) = request(port, "POST", "/pair", vec![json_type(), ("Origin", "https://evil.example".into())], pair_body).await;
            assert_eq!(status, 403);
            let (status, _) = request(port, "POST", "/pair", vec![json_type(), origin(), ("Host", "evil.example".into())], pair_body).await;
            assert_eq!(status, 403);
            let (status, paired) = request(port, "POST", "/pair", vec![json_type(), origin()], pair_body).await;
            assert_eq!(status, 200, "{paired}");
            let token = paired["token"].as_str().unwrap().to_string();

            // La extensión se conecta: sin su `Origin` no entra; con él y su token, sí.
            let plain = format!("ws://127.0.0.1:{port}/ws").into_client_request().unwrap();
            assert!(tokio_tungstenite::connect_async(plain).await.is_err(), "sin Origin de extensión no hay conexión");
            let mut upgrade = format!("ws://127.0.0.1:{port}/ws").into_client_request().unwrap();
            upgrade.headers_mut().insert("Origin", format!("chrome-extension://{EXTENSION}").parse().unwrap());
            let (mut extension, _) = tokio_tungstenite::connect_async(upgrade).await.unwrap();
            extension.send(WsMessage::Text(json!({ "type": "hello", "token": token, "version": "0.1.0" }).to_string().into())).await.unwrap();
            assert_eq!(next_json(&mut extension).await["type"], "ready");
            assert!(lock(&state.0.link).is_some());

            // Un agente: sin token, 401; con `Origin` (una web), 403; con GET, 405.
            let call = r#"{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"tabs_list","arguments":{}}}"#;
            assert_eq!(request(port, "POST", "/mcp", vec![json_type()], call).await.0, 401);
            let session = state.0.issue_session("t-1", Mode::Full).unwrap();
            let bearer = || ("Authorization", format!("Bearer {session}"));
            assert_eq!(request(port, "POST", "/mcp", vec![json_type(), bearer(), ("Origin", "https://evil.example".into())], call).await.0, 403);
            assert_eq!(request(port, "GET", "/mcp", vec![], "").await.0, 405);

            // La llamada buena llega a la extensión, que contesta, y el agente recibe el texto.
            let pending = tauri::async_runtime::spawn(request(port, "POST", "/mcp", vec![json_type(), bearer()], call));
            let order = loop {
                let message = next_json(&mut extension).await;
                if message["type"] == "call" { break message; }
            };
            assert_eq!(order["method"], "tabs_list");
            assert_eq!(order["params"]["session"], "t-1");
            extension.send(WsMessage::Text(json!({ "type": "result", "id": order["id"], "ok": true, "value": { "text": "tabId 4 · Inicio" } }).to_string().into())).await.unwrap();
            let (status, reply) = pending.await.unwrap();
            assert_eq!(status, 200);
            assert_eq!(reply["id"], 7);
            assert_eq!(reply["result"]["isError"], false);
            assert_eq!(reply["result"]["content"][0]["text"], "tabId 4 · Inicio");

            // En solo lectura, un clic se rechaza en trex: a la extensión no le llega nada.
            assert!(state.0.set_mode("t-1", Mode::Observe));
            let click = r#"{"jsonrpc":"2.0","id":8,"method":"tools/call","params":{"name":"click","arguments":{"tabId":4,"ref":"ref_1"}}}"#;
            let (status, reply) = request(port, "POST", "/mcp", vec![json_type(), bearer()], click).await;
            assert_eq!((status, reply["result"]["isError"].as_bool()), (200, Some(true)));
            assert!(lock(&state.0.pending).is_empty());

            // Desvincular cierra la conexión de ese navegador.
            let browser = lock(&state.0.config).browsers[0].id.clone();
            let _ = state.0.revoked.send(browser.into());
            let denied = loop {
                let message = next_json(&mut extension).await;
                if message["type"] != "ping" { break message; }
            };
            assert_eq!(denied["type"], "denied");
            stop(&state.0);
        });
    }

    /// Apagar el puente (o cambiarlo de puerto) cierra la conexión de la extensión, pero no la
    /// desempareja: sin `denied`, la extensión conserva su token y vuelve a conectar sola.
    #[cfg(windows)]
    #[test]
    fn stopping_the_bridge_closes_the_extension_without_unpairing_it() {
        use futures_util::{SinkExt, StreamExt};
        use tokio_tungstenite::tungstenite::client::IntoClientRequest;
        use tokio_tungstenite::tungstenite::Message as WsMessage;

        tauri::async_runtime::block_on(async {
            let state = state_with_pairing("ABC234");
            lock(&state.0.config).enabled = true;
            let (token, _) = state.0.pair("ABC234", "Brave", EXTENSION).unwrap();
            let running = bind(&state, 0).await.unwrap();
            let port = running.port;
            *lock(&state.0.server) = Some(running);

            let mut upgrade = format!("ws://127.0.0.1:{port}/ws").into_client_request().unwrap();
            upgrade.headers_mut().insert("Origin", format!("chrome-extension://{EXTENSION}").parse().unwrap());
            let (mut extension, _) = tokio_tungstenite::connect_async(upgrade).await.unwrap();
            extension.send(WsMessage::Text(json!({ "type": "hello", "token": token, "version": "0.1.0" }).to_string().into())).await.unwrap();
            let ready = loop {
                if let Some(Ok(WsMessage::Text(text))) = extension.next().await { break serde_json::from_str::<Value>(text.as_str()).unwrap(); }
            };
            assert_eq!(ready["type"], "ready");

            stop(&state.0);
            // Lo que llegue hasta el cierre: ningún `denied`, que haría a la extensión olvidar su token.
            let closing = tokio::time::timeout(Duration::from_secs(10), async {
                let mut seen = Vec::new();
                while let Some(Ok(message)) = extension.next().await {
                    match message {
                        WsMessage::Text(text) => seen.push(serde_json::from_str::<Value>(text.as_str()).unwrap()),
                        WsMessage::Close(_) => break,
                        _ => {}
                    }
                }
                seen
            }).await.expect("la conexión se cierra al apagar el puente");
            assert!(closing.iter().all(|message| message["type"] != "denied"), "{closing:?}");
            // El navegador sigue emparejado: su token vale para cuando el puente vuelva.
            assert_eq!(lock(&state.0.config).browsers.len(), 1);
            assert!(state.0.authenticate(&token, EXTENSION).is_some());
            // El servidor suelta la conexión justo después de mandar el cierre.
            for _ in 0..100 {
                if lock(&state.0.link).is_none() { break; }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            assert!(lock(&state.0.link).is_none(), "la conexión cerrada deja de contar como conectada");
        });
    }
}
