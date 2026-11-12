//! Control remoto: la app móvil (PWA) ve y dirige las sesiones de chat de este PC.
//!
//! Apagado por defecto. Cuando se activa en Ajustes, un servidor HTTP + WebSocket
//! escucha solo en la dirección elegida (el túnel de WireGuard, la IP de Tailscale o
//! la red local) y, si se pide, también en 127.0.0.1 para `tailscale serve` (HTTPS).
//!
//! El escritorio es la fuente de verdad: el frontend publica aquí un resumen de cada
//! sesión (y el detalle de las que algún móvil mira) y ejecuta las órdenes que llegan
//! (enviar, responder, detener). Este módulo no interpreta los chats: valida tamaños y
//! formas, autentica dispositivos y reparte mensajes.
//!
//! Seguridad: emparejado con un código de un solo uso (5 min, 5 intentos); cada móvil
//! recibe un token aleatorio de 256 bits del que solo se guarda el SHA-256; se puede
//! revocar en cualquier momento (cierra sus conexiones). El WebSocket exige el token en
//! el primer mensaje y rechaza orígenes ajenos (DNS rebinding, otras webs).
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{DefaultBodyLimit, State as AxumState};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::{broadcast, mpsc, oneshot, watch};

use crate::attachments::{attachments_dir, image_type, percent_decode, safe_name, store_attachment, SAVED_MAX_BYTES};

const CONFIG_FILE: &str = "remote.json";
pub const DEFAULT_PORT: u16 = 7340;
const PAIRING_TTL: Duration = Duration::from_secs(5 * 60);
const PAIRING_ATTEMPTS: u32 = 5;
const CODE_ALPHABET: &[u8] = b"ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LEN: usize = 6;
const MAX_DEVICES: usize = 16;
const MAX_CLIENT_MESSAGE: usize = 64 * 1024;
const MAX_SESSIONS_JSON: usize = 512 * 1024;
const MAX_DETAIL_JSON: usize = 2 * 1024 * 1024;
const MAX_SEND_CHARS: usize = 20_000;
const HELLO_TIMEOUT: Duration = Duration::from_secs(10);
const COMMAND_TIMEOUT: Duration = Duration::from_secs(20);
const RETRY_BIND: Duration = Duration::from_secs(20);
/// Adjuntos que sube el móvil: cuántos por mensaje, cuánto tiempo valen y cuántos se recuerdan.
const MAX_ATTACHMENTS: usize = 20;
const UPLOAD_TTL: Duration = Duration::from_secs(6 * 60 * 60);
const MAX_UPLOADS: usize = 64;
/// Una imagen más grande viaja como archivo (el escritorio no adjunta imágenes de más de 20 MB).
const IMAGE_MAX_BYTES: usize = 20 * 1024 * 1024;
/// Eventos hacia el frontend del escritorio.
const EVENT_ACTIVE: &str = "remote://active";
const EVENT_WATCH: &str = "remote://watch";
const EVENT_COMMAND: &str = "remote://command";

// --- Configuración guardada ---------------------------------------------------

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
struct Device {
    id: String,
    name: String,
    /// SHA-256 del token en hexadecimal; el token nunca se guarda.
    token_hash: String,
    created_at: u64,
    last_seen: u64,
}

impl Default for Device {
    fn default() -> Self {
        Self { id: String::new(), name: String::new(), token_hash: String::new(), created_at: 0, last_seen: 0 }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
struct RemoteConfig {
    enabled: bool,
    /// IPv4 en la que escucha (la de WireGuard, Tailscale o la red local).
    address: String,
    port: u16,
    /// Además escucha en 127.0.0.1 y publica el puerto con `tailscale serve` (HTTPS).
    tailscale_serve: bool,
    devices: Vec<Device>,
}

impl Default for RemoteConfig {
    fn default() -> Self {
        Self { enabled: false, address: String::new(), port: DEFAULT_PORT, tailscale_serve: false, devices: Vec::new() }
    }
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map(|dir| dir.join(CONFIG_FILE))
        .map_err(|error| format!("No se encontró la carpeta de datos de la app: {error}"))
}

fn load_config(app: &AppHandle) -> RemoteConfig {
    let Ok(path) = config_path(app) else { return RemoteConfig::default() };
    let Ok(text) = std::fs::read_to_string(path) else { return RemoteConfig::default() };
    let mut config: RemoteConfig = serde_json::from_str(&text).unwrap_or_default();
    config.devices.retain(|device| valid_hash(&device.token_hash) && !device.id.is_empty());
    if config.port == 0 { config.port = DEFAULT_PORT; }
    config
}

fn save_config(app: &AppHandle, config: &RemoteConfig) -> Result<(), String> {
    let path = config_path(app)?;
    if let Some(dir) = path.parent() { std::fs::create_dir_all(dir).map_err(|e| e.to_string())?; }
    let text = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    let temporary = path.with_extension("json.tmp");
    std::fs::write(&temporary, text).map_err(|e| format!("No se pudo guardar el control remoto: {e}"))?;
    std::fs::rename(&temporary, &path).map_err(|e| format!("No se pudo guardar el control remoto: {e}"))
}

// --- Utilidades puras -----------------------------------------------------------

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn random_bytes<const N: usize>() -> Result<[u8; N], String> {
    let mut bytes = [0u8; N];
    getrandom::fill(&mut bytes).map_err(|error| format!("No hay aleatoriedad del sistema: {error}"))?;
    Ok(bytes)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn token_hash(token: &str) -> String {
    hex(&Sha256::digest(token.as_bytes()))
}

fn valid_hash(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Comparación en tiempo constante (para hashes de igual longitud).
fn same_secret(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Código de emparejado: 6 caracteres sin ambigüedades (sin 0/O, 1/I/L).
fn new_code() -> Result<String, String> {
    let bytes = random_bytes::<CODE_LEN>()?;
    // 31 símbolos: el sesgo de módulo de un byte es despreciable para un código de 5 minutos y 5 intentos.
    Ok(bytes.iter().map(|byte| CODE_ALPHABET[*byte as usize % CODE_ALPHABET.len()] as char).collect())
}

/// Lo que escribe la persona: sin guiones ni espacios y en mayúsculas.
fn normalize_code(value: &str) -> String {
    value.chars().filter(|c| c.is_ascii_alphanumeric()).map(|c| c.to_ascii_uppercase()).collect()
}

fn clean_name(value: &str) -> String {
    let name: String = value.chars().filter(|c| !c.is_control()).collect::<String>().split_whitespace().collect::<Vec<_>>().join(" ");
    let name: String = name.chars().take(60).collect();
    if name.is_empty() { "Móvil".into() } else { name }
}

/// Tipo de red de una interfaz, para sugerir la correcta en Ajustes.
fn interface_kind(name: &str, ip: Ipv4Addr) -> &'static str {
    let lower = name.to_ascii_lowercase();
    let octets = ip.octets();
    // Tailscale reparte direcciones de 100.64.0.0/10 (CGNAT).
    if lower.contains("tailscale") || (octets[0] == 100 && (64..128).contains(&octets[1])) { return "tailscale"; }
    if lower.contains("wireguard") || lower.starts_with("wg") || lower.contains("wg-") || lower.contains("wintun") { return "wireguard"; }
    if ip.is_private() { return "lan"; }
    "other"
}

/// Rutas que sirve el servidor: la PWA y sus recursos, nada más del bundle.
fn asset_path(path: &str) -> Option<String> {
    let path = path.trim_start_matches('/');
    if path.is_empty() || path == "index.html" { return Some("remote.html".into()); }
    if path.contains("..") || path.contains('\\') || path.contains("//") { return None; }
    let allowed = path == "remote.html" || path == "remote.webmanifest" || path == "trex.svg" || path.starts_with("remote-icon")
        || (path.starts_with("assets/") && path[7..].chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.')));
    allowed.then(|| path.to_string())
}

fn mime_for(path: &str) -> &'static str {
    match path.rsplit('.').next().unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        "webmanifest" => "application/manifest+json",
        "json" => "application/json",
        _ => "application/octet-stream",
    }
}

/// El navegador solo se acepta si viene de esta misma web (protege del DNS rebinding y de otras webs).
fn same_origin(headers: &HeaderMap) -> bool {
    let Some(origin) = headers.get(header::ORIGIN).and_then(|v| v.to_str().ok()) else { return true };
    let origin_host = origin.split("://").nth(1).unwrap_or("").trim_end_matches('/');
    let hosts = [header::HOST.as_str(), "x-forwarded-host"].iter()
        .filter_map(|name| headers.get(*name).and_then(|v| v.to_str().ok()))
        .map(|host| host.to_string()).collect::<Vec<_>>();
    let strip_default = |host: &str| host.trim_end_matches(":443").trim_end_matches(":80").to_ascii_lowercase();
    !origin_host.is_empty() && hosts.iter().any(|host| strip_default(host) == strip_default(origin_host))
}

// --- Estado compartido ----------------------------------------------------------

struct Pairing {
    code: String,
    expires: std::time::Instant,
    attempts: u32,
}

#[derive(Clone)]
enum Outgoing {
    Sessions(Arc<str>),
    Detail { id: Arc<str>, json: Arc<str> },
    Theme(Arc<str>),
    Revoked(Arc<str>),
}

struct Connection {
    device_id: String,
    watching: Option<String>,
}

struct Running {
    shutdown: watch::Sender<bool>,
    bound: Vec<SocketAddr>,
}

/// Un archivo subido desde un móvil, a la espera de que lo envíe con un mensaje.
struct Upload {
    device: String,
    path: PathBuf,
    name: String,
    image: bool,
    at: std::time::Instant,
}

#[derive(Default)]
struct Hub {
    sessions: Option<Arc<str>>,
    /// Ruta de cada proyecto con sesiones publicadas: solo de esas se sirve el icono.
    projects: HashMap<String, PathBuf>,
    icons: HashMap<PathBuf, Option<String>>,
    details: HashMap<String, Arc<str>>,
    theme: Option<Arc<str>>,
    connections: HashMap<u64, Connection>,
    pending: HashMap<u64, oneshot::Sender<(bool, Option<String>)>>,
}

pub struct Inner {
    app: Mutex<Option<AppHandle>>,
    config: Mutex<RemoteConfig>,
    pairing: Mutex<Option<Pairing>>,
    server: Mutex<Option<Running>>,
    error: Mutex<Option<String>>,
    hub: Mutex<Hub>,
    uploads: Mutex<HashMap<String, Upload>>,
    tx: broadcast::Sender<Outgoing>,
    next_id: AtomicU64,
    /// Generación del servidor: un reintento de una configuración anterior no arranca nada.
    generation: AtomicU64,
}

#[derive(Clone)]
pub struct RemoteState(Arc<Inner>);

impl Default for RemoteState {
    fn default() -> Self {
        let (tx, _) = broadcast::channel(256);
        Self(Arc::new(Inner {
            app: Mutex::new(None), config: Mutex::new(RemoteConfig::default()), pairing: Mutex::new(None),
            server: Mutex::new(None), error: Mutex::new(None), hub: Mutex::new(Hub::default()), uploads: Mutex::new(HashMap::new()), tx,
            next_id: AtomicU64::new(1), generation: AtomicU64::new(0),
        }))
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl Inner {
    fn app(&self) -> Option<AppHandle> { lock(&self.app).clone() }

    fn emit<S: Serialize + Clone>(&self, event: &str, payload: S) {
        if let Some(app) = self.app() { let _ = app.emit(event, payload); }
    }

    fn active(&self) -> bool { !lock(&self.hub).connections.is_empty() }

    fn watching(&self) -> Vec<String> {
        let hub = lock(&self.hub);
        let set: HashSet<&String> = hub.connections.values().filter_map(|c| c.watching.as_ref()).collect();
        let mut ids: Vec<String> = set.into_iter().cloned().collect();
        ids.sort();
        ids
    }

    fn announce(&self) {
        self.emit(EVENT_ACTIVE, json!({ "active": self.active() }));
        self.emit(EVENT_WATCH, json!({ "ids": self.watching() }));
    }

    /// El dispositivo de un token, sin apuntar el uso (para peticiones HTTP sueltas).
    fn device_for(&self, token: &str) -> Option<Device> {
        if token.len() < 32 || token.len() > 128 { return None; }
        let hash = token_hash(token);
        lock(&self.config).devices.iter().find(|device| same_secret(&device.token_hash, &hash)).cloned()
    }

    fn add_upload(&self, id: String, upload: Upload) {
        let mut uploads = lock(&self.uploads);
        uploads.retain(|_, upload| upload.at.elapsed() < UPLOAD_TTL);
        while uploads.len() >= MAX_UPLOADS {
            let Some(oldest) = uploads.iter().min_by_key(|(_, upload)| upload.at).map(|(id, _)| id.clone()) else { break };
            uploads.remove(&oldest);
        }
        uploads.insert(id, upload);
    }

    /// Traduce los ids de adjuntos de un móvil a rutas del PC. Solo valen los suyos.
    fn resolve_uploads(&self, device: &str, ids: &[String]) -> Result<Value, String> {
        let uploads = lock(&self.uploads);
        let mut files = Vec::new();
        for id in ids {
            let upload = uploads.get(id).filter(|upload| upload.device == device && upload.at.elapsed() < UPLOAD_TTL)
                .ok_or("Un adjunto ya no está en el PC. Vuelve a adjuntarlo.")?;
            files.push(json!({ "path": upload.path.to_string_lossy(), "name": upload.name, "image": upload.image }));
        }
        Ok(Value::Array(files))
    }

    fn authenticate(&self, token: &str) -> Option<Device> {
        if token.len() < 32 || token.len() > 128 { return None; }
        let hash = token_hash(token);
        let mut config = lock(&self.config);
        let device = config.devices.iter_mut().find(|device| same_secret(&device.token_hash, &hash))?;
        device.last_seen = now_ms();
        let found = device.clone();
        let snapshot = config.clone();
        drop(config);
        if let Some(app) = self.app() { let _ = save_config(&app, &snapshot); }
        Some(found)
    }

    fn pair(&self, code: &str, name: &str) -> Result<(String, Device), (StatusCode, String)> {
        let code = normalize_code(code);
        let mut pairing = lock(&self.pairing);
        let Some(active) = pairing.as_mut() else {
            return Err((StatusCode::FORBIDDEN, "No hay ningún emparejado abierto. Ábrelo en trex › Ajustes › Control remoto.".into()));
        };
        if active.expires < std::time::Instant::now() {
            *pairing = None;
            return Err((StatusCode::FORBIDDEN, "El código caducó. Genera otro en el PC.".into()));
        }
        if !same_secret(&active.code, &code) {
            active.attempts += 1;
            if active.attempts >= PAIRING_ATTEMPTS {
                *pairing = None;
                return Err((StatusCode::FORBIDDEN, "Demasiados intentos. Genera un código nuevo en el PC.".into()));
            }
            return Err((StatusCode::UNAUTHORIZED, "El código no es correcto.".into()));
        }
        *pairing = None;
        drop(pairing);
        let token = base64_url(&random_bytes::<32>().map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?);
        let id = hex(&random_bytes::<8>().map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?);
        let now = now_ms();
        let device = Device { id, name: clean_name(name), token_hash: token_hash(&token), created_at: now, last_seen: now };
        let snapshot = {
            let mut config = lock(&self.config);
            config.devices.push(device.clone());
            // Los más antiguos sin uso dejan sitio: nunca se acumulan tokens olvidados.
            while config.devices.len() > MAX_DEVICES {
                let oldest = config.devices.iter().enumerate().min_by_key(|(_, d)| d.last_seen).map(|(i, _)| i).unwrap_or(0);
                config.devices.remove(oldest);
            }
            config.clone()
        };
        if let Some(app) = self.app() { save_config(&app, &snapshot).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?; }
        Ok((token, device))
    }
}

fn base64_url(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

// --- Servidor HTTP ----------------------------------------------------------------

#[derive(Deserialize)]
struct PairRequest {
    code: String,
    #[serde(default)]
    name: String,
}

fn security_headers(response: &mut Response, html: bool) {
    let headers = response.headers_mut();
    headers.insert("x-content-type-options", HeaderValue::from_static("nosniff"));
    headers.insert("referrer-policy", HeaderValue::from_static("no-referrer"));
    headers.insert("x-frame-options", HeaderValue::from_static("DENY"));
    headers.insert("cross-origin-opener-policy", HeaderValue::from_static("same-origin"));
    if html {
        headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
        headers.insert("content-security-policy", HeaderValue::from_static(
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ws: wss:; manifest-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"));
    }
}

async fn serve_asset(AxumState(state): AxumState<RemoteState>, uri: Uri) -> Response {
    let Some(path) = asset_path(uri.path()) else { return (StatusCode::NOT_FOUND, "No encontrado").into_response() };
    let Some(app) = state.0.app() else { return StatusCode::SERVICE_UNAVAILABLE.into_response() };
    let Some(asset) = app.asset_resolver().get(path.clone()) else { return (StatusCode::NOT_FOUND, "No encontrado").into_response() };
    let mime = mime_for(&path);
    // El resolvedor puede devolver la página principal para rutas desconocidas: solo vale si se pidió HTML.
    if asset.mime_type.starts_with("text/html") && !path.ends_with(".html") { return (StatusCode::NOT_FOUND, "No encontrado").into_response(); }
    let html = path.ends_with(".html");
    let mut response = (StatusCode::OK, [(header::CONTENT_TYPE, mime)], asset.bytes).into_response();
    if path.starts_with("assets/") {
        response.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("public, max-age=31536000, immutable"));
    }
    security_headers(&mut response, html);
    response
}

async fn pair(AxumState(state): AxumState<RemoteState>, headers: HeaderMap, Json(request): Json<PairRequest>) -> Response {
    if !same_origin(&headers) { return (StatusCode::FORBIDDEN, Json(json!({ "error": "Origen no permitido." }))).into_response(); }
    if request.code.len() > 32 || request.name.len() > 256 { return (StatusCode::BAD_REQUEST, Json(json!({ "error": "Petición no válida." }))).into_response(); }
    match state.0.pair(&request.code, &request.name) {
        Ok((token, device)) => {
            state.0.emit("remote://paired", json!({ "id": device.id, "name": device.name }));
            Json(json!({ "token": token, "device": { "id": device.id, "name": device.name } })).into_response()
        }
        Err((status, error)) => (status, Json(json!({ "error": error }))).into_response(),
    }
}

fn bearer(headers: &HeaderMap) -> Option<&str> {
    headers.get(header::AUTHORIZATION)?.to_str().ok()?.strip_prefix("Bearer ")
}

fn no_store(mut response: Response) -> Response {
    response.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

fn json_error(status: StatusCode, error: impl Into<String>) -> Response {
    no_store((status, Json(json!({ "error": error.into() }))).into_response())
}

/// Un adjunto del móvil: se guarda con los del escritorio y se devuelve un id para enviarlo.
async fn upload(AxumState(state): AxumState<RemoteState>, headers: HeaderMap, body: axum::body::Bytes) -> Response {
    if !same_origin(&headers) { return json_error(StatusCode::FORBIDDEN, "Origen no permitido."); }
    let Some(device) = bearer(&headers).and_then(|token| state.0.device_for(token)) else {
        return json_error(StatusCode::UNAUTHORIZED, "Este móvil ya no está emparejado. Vuelve a emparejarlo.");
    };
    if body.is_empty() { return json_error(StatusCode::BAD_REQUEST, "El archivo está vacío."); }
    if body.len() > SAVED_MAX_BYTES { return json_error(StatusCode::PAYLOAD_TOO_LARGE, "El archivo pesa más de 100 MB."); }
    let name = headers.get("x-file-name").and_then(|value| value.to_str().ok()).map(percent_decode).unwrap_or_default();
    let name: String = safe_name(&name).chars().take(120).collect();
    let Some(app) = state.0.app() else { return json_error(StatusCode::SERVICE_UNAVAILABLE, "trex aún no está listo."); };
    let root = match attachments_dir(&app) { Ok(root) => root, Err(error) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, error) };
    let image = body.len() <= IMAGE_MAX_BYTES && image_type(&body).is_some();
    let size = body.len();
    let stored = { let name = name.clone(); tauri::async_runtime::spawn_blocking(move || store_attachment(&root, &name, &body)).await };
    let path = match stored {
        Ok(Ok(path)) => path,
        Ok(Err(error)) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, error),
        Err(error) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    };
    let id = match random_bytes::<16>() { Ok(bytes) => hex(&bytes), Err(error) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, error) };
    state.0.add_upload(id.clone(), Upload { device: device.id, path, name: name.clone(), image, at: std::time::Instant::now() });
    no_store(Json(json!({ "id": id, "name": name, "size": size, "image": image })).into_response())
}

/// Logo de un proyecto con sesiones abiertas (el mismo que muestra la barra lateral).
async fn icon(AxumState(state): AxumState<RemoteState>, headers: HeaderMap, uri: Uri) -> Response {
    if !same_origin(&headers) { return json_error(StatusCode::FORBIDDEN, "Origen no permitido."); }
    if bearer(&headers).and_then(|token| state.0.device_for(token)).is_none() {
        return json_error(StatusCode::UNAUTHORIZED, "Este móvil ya no está emparejado.");
    }
    let project = uri.query().unwrap_or("").split('&').find_map(|pair| pair.strip_prefix("project=")).map(percent_decode).unwrap_or_default();
    let (path, cached) = {
        let hub = lock(&state.0.hub);
        let Some(path) = hub.projects.get(&project).cloned() else { return json_error(StatusCode::NOT_FOUND, "Proyecto desconocido.") };
        let cached = hub.icons.get(&path).cloned();
        (path, cached)
    };
    let url = match cached {
        Some(url) => url,
        None => {
            let search = path.clone();
            let url = tauri::async_runtime::spawn_blocking(move || crate::project_icon::find_project_icon(&search)).await.ok().flatten();
            lock(&state.0.hub).icons.insert(path, url.clone());
            url
        }
    };
    no_store(Json(json!({ "url": url })).into_response())
}

async fn websocket(AxumState(state): AxumState<RemoteState>, headers: HeaderMap, upgrade: WebSocketUpgrade) -> Response {
    if !same_origin(&headers) { return (StatusCode::FORBIDDEN, "Origen no permitido").into_response(); }
    upgrade.max_message_size(MAX_CLIENT_MESSAGE).max_frame_size(MAX_CLIENT_MESSAGE)
        .on_upgrade(move |socket| connection(state, socket))
}

fn text(value: Value) -> Message { Message::Text(value.to_string().into()) }
fn raw(json: &Arc<str>) -> Message { Message::Text(json.to_string().into()) }

/// Una conexión: primero el token, después reparto de novedades y órdenes.
async fn connection(state: RemoteState, mut socket: WebSocket) {
    let inner = state.0.clone();
    // 1. Saludo con el token.
    let hello = tokio::time::timeout(HELLO_TIMEOUT, socket.recv()).await;
    let token = match hello {
        Ok(Some(Ok(Message::Text(message)))) => serde_json::from_str::<Value>(message.as_str()).ok()
            .filter(|value| value["type"] == "hello").and_then(|value| value["token"].as_str().map(str::to_string)),
        _ => None,
    };
    let Some(device) = token.as_deref().and_then(|token| inner.authenticate(token)) else {
        let _ = socket.send(text(json!({ "type": "denied", "error": "Este móvil ya no está emparejado. Vuelve a emparejarlo." }))).await;
        let _ = socket.send(Message::Close(None)).await;
        return;
    };
    let id = inner.next_id.fetch_add(1, Ordering::Relaxed);
    let mut rx = inner.tx.subscribe();
    {
        let mut hub = lock(&inner.hub);
        hub.connections.insert(id, Connection { device_id: device.id.clone(), watching: None });
    }
    inner.announce();

    let host = std::env::var("COMPUTERNAME").or_else(|_| std::env::var("HOSTNAME")).unwrap_or_else(|_| "PC".into());
    let (snapshot, theme) = { let hub = lock(&inner.hub); (hub.sessions.clone(), hub.theme.clone()) };
    let mut ok = socket.send(text(json!({ "type": "ready", "host": host, "device": { "id": device.id, "name": device.name },
        "version": env!("CARGO_PKG_VERSION") }))).await.is_ok();
    if let Some(theme) = theme { ok = ok && socket.send(raw(&theme)).await.is_ok(); }
    if let Some(snapshot) = snapshot { ok = ok && socket.send(raw(&snapshot)).await.is_ok(); }

    // Respuestas de órdenes: llegan desde tareas aparte.
    let (reply_tx, mut reply_rx) = mpsc::channel::<Message>(32);
    let mut ping = tokio::time::interval(Duration::from_secs(25));
    ping.tick().await;
    while ok {
        tokio::select! {
            incoming = socket.recv() => {
                let Some(Ok(message)) = incoming else { break };
                match message {
                    Message::Text(body) => {
                        if let Some(reply) = handle_client(&inner, id, &device.id, body.as_str(), &reply_tx) {
                            ok = socket.send(reply).await.is_ok();
                        }
                    }
                    Message::Close(_) => break,
                    _ => {}
                }
            }
            outgoing = rx.recv() => {
                let message = match outgoing {
                    Ok(Outgoing::Sessions(json)) | Ok(Outgoing::Theme(json)) => Some(raw(&json)),
                    Ok(Outgoing::Detail { id: session, json }) => {
                        let watching = lock(&inner.hub).connections.get(&id).and_then(|c| c.watching.clone());
                        (watching.as_deref() == Some(&*session)).then(|| raw(&json))
                    }
                    Ok(Outgoing::Revoked(device_id)) if *device_id == *device.id => {
                        let _ = socket.send(text(json!({ "type": "denied", "error": "Este móvil se desvinculó desde el PC." }))).await;
                        break;
                    }
                    Ok(Outgoing::Revoked(_)) => None,
                    // Se perdieron novedades: se manda la foto actual completa.
                    Err(broadcast::error::RecvError::Lagged(_)) => lock(&inner.hub).sessions.clone().map(|json| raw(&json)),
                    Err(broadcast::error::RecvError::Closed) => break,
                };
                if let Some(message) = message { ok = socket.send(message).await.is_ok(); }
            }
            reply = reply_rx.recv() => {
                if let Some(reply) = reply { ok = socket.send(reply).await.is_ok(); }
            }
            _ = ping.tick() => { ok = socket.send(Message::Ping(Vec::new().into())).await.is_ok(); }
        }
    }
    lock(&inner.hub).connections.remove(&id);
    inner.announce();
}

/// Mensaje de un móvil ya autenticado. Devuelve la respuesta inmediata, si la hay.
fn handle_client(inner: &Arc<Inner>, connection: u64, device: &str, body: &str, replies: &mpsc::Sender<Message>) -> Option<Message> {
    let value: Value = serde_json::from_str(body).ok()?;
    match value["type"].as_str()? {
        "ping" => Some(text(json!({ "type": "pong" }))),
        "watch" => {
            let session = value["session"].as_str().filter(|id| valid_session(id)).map(str::to_string);
            let cached = {
                let mut hub = lock(&inner.hub);
                if let Some(entry) = hub.connections.get_mut(&connection) { entry.watching = session.clone(); }
                session.as_ref().and_then(|id| hub.details.get(id).cloned())
            };
            inner.emit(EVENT_WATCH, json!({ "ids": inner.watching() }));
            cached.map(|json| raw(&json))
        }
        "command" => {
            let request = value["req"].as_u64().unwrap_or(0);
            let reply = move |ok: bool, error: Option<String>| text(json!({ "type": "result", "req": request, "ok": ok, "error": error }));
            let Some(session) = value["session"].as_str().filter(|id| valid_session(id)) else { return Some(reply(false, Some("Sesión no válida.".into()))) };
            let mut action = match validate_action(&value["action"]) { Ok(action) => action, Err(error) => return Some(reply(false, Some(error))) };
            // Los adjuntos llegan como ids de lo que este móvil subió: al escritorio van sus rutas.
            if action["kind"] == "send" {
                let ids: Vec<String> = action["attachments"].as_array()
                    .map(|list| list.iter().filter_map(|id| id.as_str().map(str::to_string)).collect()).unwrap_or_default();
                match inner.resolve_uploads(device, &ids) {
                    Ok(files) => if let Some(object) = action.as_object_mut() {
                        object.remove("attachments");
                        object.insert("files".into(), files);
                    },
                    Err(error) => return Some(reply(false, Some(error))),
                }
            }
            let command = inner.next_id.fetch_add(1, Ordering::Relaxed);
            let (done_tx, done_rx) = oneshot::channel();
            lock(&inner.hub).pending.insert(command, done_tx);
            inner.emit(EVENT_COMMAND, json!({ "command": command, "device": device, "session": session, "action": action }));
            let replies = replies.clone();
            let inner = inner.clone();
            tauri::async_runtime::spawn(async move {
                let result = tokio::time::timeout(COMMAND_TIMEOUT, done_rx).await;
                lock(&inner.hub).pending.remove(&command);
                let (ok, error) = match result {
                    Ok(Ok(outcome)) => outcome,
                    _ => (false, Some("El PC no respondió a tiempo. ¿Sigue abierto trex?".into())),
                };
                let _ = replies.send(reply(ok, error)).await;
            });
            None
        }
        _ => None,
    }
}

fn valid_session(id: &str) -> bool {
    !id.is_empty() && id.len() <= 128 && id.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | ':' | '.'))
}

/// Solo pasan al escritorio órdenes conocidas y de tamaño razonable.
fn validate_action(action: &Value) -> Result<Value, String> {
    match action["kind"].as_str() {
        Some("send") => {
            let text = action["text"].as_str().map(str::trim).unwrap_or("");
            let attachments = match &action["attachments"] {
                Value::Null => Vec::new(),
                Value::Array(list) if list.len() <= MAX_ATTACHMENTS => list.iter()
                    .map(|id| id.as_str().filter(|id| id.len() == 32 && id.bytes().all(|b| b.is_ascii_hexdigit()))
                        .map(str::to_string).ok_or_else(|| "Adjunto no válido.".to_string()))
                    .collect::<Result<Vec<_>, _>>()?,
                Value::Array(_) => return Err(format!("Puedes adjuntar hasta {MAX_ATTACHMENTS} archivos por mensaje.")),
                _ => return Err("Adjunto no válido.".into()),
            };
            if text.is_empty() && attachments.is_empty() { return Err("El mensaje está vacío.".into()); }
            if text.chars().count() > MAX_SEND_CHARS { return Err("El mensaje es demasiado largo.".into()); }
            Ok(json!({ "kind": "send", "text": text, "attachments": attachments }))
        }
        Some("answer") => {
            let item = action["item"].as_str().filter(|id| !id.is_empty() && id.len() <= 256).ok_or("Falta la petición a la que respondes.")?;
            let choices = match &action["choices"] {
                Value::Null => Value::Null,
                Value::Array(list) if list.len() <= 16 => {
                    let mut clean = Vec::new();
                    for choice in list {
                        let question = choice["question"].as_str().unwrap_or("");
                        let other = choice["other"].as_str().unwrap_or("");
                        let selected = choice["selected"].as_array().map(|values| values.iter().filter_map(|v| v.as_str()).take(32)
                            .map(|v| v.chars().take(2000).collect::<String>()).collect::<Vec<_>>()).unwrap_or_default();
                        if question.len() > 4000 || other.chars().count() > MAX_SEND_CHARS { return Err("La respuesta es demasiado larga.".into()); }
                        clean.push(json!({ "question": question, "selected": selected, "other": other }));
                    }
                    Value::Array(clean)
                }
                _ => return Err("Respuesta no válida.".into()),
            };
            Ok(json!({ "kind": "answer", "item": item, "allowed": action["allowed"].as_bool().unwrap_or(false),
                "remember": action["remember"].as_bool().unwrap_or(false), "choices": choices }))
        }
        Some("interrupt") => Ok(json!({ "kind": "interrupt" })),
        _ => Err("Orden desconocida.".into()),
    }
}

// --- Arranque y parada ------------------------------------------------------------

fn listen_addresses(config: &RemoteConfig) -> Result<Vec<SocketAddr>, String> {
    let ip: Ipv4Addr = config.address.parse().map_err(|_| "Elige en qué red escucha el control remoto.".to_string())?;
    if ip.is_unspecified() { return Err("Elige una red concreta: escuchar en todas no está permitido.".into()); }
    let mut addresses = vec![SocketAddr::new(IpAddr::V4(ip), config.port)];
    if config.tailscale_serve && !ip.is_loopback() { addresses.push(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), config.port)); }
    Ok(addresses)
}

fn stop(inner: &Arc<Inner>) {
    inner.generation.fetch_add(1, Ordering::SeqCst);
    if let Some(running) = lock(&inner.server).take() { let _ = running.shutdown.send(true); }
    let ids: Vec<String> = lock(&inner.config).devices.iter().map(|d| d.id.clone()).collect();
    for id in ids { let _ = inner.tx.send(Outgoing::Revoked(id.into())); }
    {
        let mut hub = lock(&inner.hub);
        hub.details.clear();
        hub.sessions = None;
    }
}

/// Arranca (o reintenta) el servidor con la configuración actual.
fn start(state: &RemoteState) {
    let inner = state.0.clone();
    stop(&inner);
    *lock(&inner.error) = None;
    let config = lock(&inner.config).clone();
    if !config.enabled { return; }
    let generation = inner.generation.load(Ordering::SeqCst);
    let state = state.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            if inner.generation.load(Ordering::SeqCst) != generation { return; }
            match bind(&state, &config).await {
                Ok(running) => {
                    if inner.generation.load(Ordering::SeqCst) != generation { let _ = running.shutdown.send(true); return; }
                    *lock(&inner.server) = Some(running);
                    *lock(&inner.error) = None;
                    inner.emit("remote://status", json!({}));
                    return;
                }
                Err(error) => {
                    // La VPN puede tardar en levantarse: se reintenta mientras siga activado.
                    *lock(&inner.error) = Some(error);
                    inner.emit("remote://status", json!({}));
                    tokio::time::sleep(RETRY_BIND).await;
                }
            }
        }
    });
}

async fn bind(state: &RemoteState, config: &RemoteConfig) -> Result<Running, String> {
    let addresses = listen_addresses(config)?;
    let (shutdown, _) = watch::channel(false);
    let mut listeners = Vec::new();
    for address in &addresses {
        let listener = tokio::net::TcpListener::bind(address).await.map_err(|error| match error.kind() {
            std::io::ErrorKind::AddrNotAvailable => format!("La dirección {} no está disponible ahora (¿la VPN está conectada?). Se reintentará sola.", address.ip()),
            std::io::ErrorKind::AddrInUse => format!("El puerto {} ya está en uso. Elige otro.", address.port()),
            _ => format!("No se pudo escuchar en {address}: {error}"),
        })?;
        listeners.push(listener);
    }
    let router = Router::new()
        .route("/api/pair", post(pair))
        .route("/api/ws", get(websocket))
        .route("/api/upload", post(upload).layer(DefaultBodyLimit::max(SAVED_MAX_BYTES + 1024)))
        .route("/api/icon", get(icon))
        .fallback(get(serve_asset))
        .with_state(state.clone());
    for listener in listeners {
        let mut stop = shutdown.subscribe();
        let router = router.clone();
        tauri::async_runtime::spawn(async move {
            let _ = axum::serve(listener, router).with_graceful_shutdown(async move { let _ = stop.wait_for(|stop| *stop).await; }).await;
        });
    }
    Ok(Running { shutdown, bound: addresses })
}

/// Al abrir trex: arranca solo si la persona lo dejó activado.
pub fn init(app: &AppHandle) {
    let state = app.state::<RemoteState>().inner().clone();
    *lock(&state.0.app) = Some(app.clone());
    *lock(&state.0.config) = load_config(app);
    if lock(&state.0.config).enabled { start(&state); }
}

// --- Estado para Ajustes ------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkInterface { name: String, ip: String, kind: &'static str }

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TailscaleInfo { installed: bool, running: bool, ip: Option<String>, dns_name: Option<String> }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceInfo { id: String, name: String, created_at: u64, last_seen: u64, connected: bool }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteStatus {
    enabled: bool,
    running: bool,
    address: String,
    port: u16,
    tailscale_serve: bool,
    error: Option<String>,
    urls: Vec<String>,
    devices: Vec<DeviceInfo>,
    interfaces: Vec<NetworkInterface>,
    tailscale: TailscaleInfo,
}

fn interfaces() -> Vec<NetworkInterface> {
    let mut list: Vec<NetworkInterface> = if_addrs::get_if_addrs().unwrap_or_default().into_iter()
        .filter(|interface| !interface.is_loopback() && !interface.is_link_local())
        .filter_map(|interface| match interface.addr.ip() {
            IpAddr::V4(ip) => Some(NetworkInterface { kind: interface_kind(&interface.name, ip), name: interface.name, ip: ip.to_string() }),
            IpAddr::V6(_) => None,
        }).collect();
    let rank = |kind: &str| match kind { "wireguard" => 0, "tailscale" => 1, "lan" => 2, _ => 3 };
    list.sort_by(|a, b| rank(a.kind).cmp(&rank(b.kind)).then(a.name.cmp(&b.name)));
    list
}

fn tailscale_program() -> Option<PathBuf> {
    if crate::exists_in_path("tailscale") { return Some(PathBuf::from("tailscale")); }
    #[cfg(windows)]
    {
        let path = PathBuf::from(r"C:\Program Files\Tailscale\tailscale.exe");
        if path.is_file() { return Some(path); }
    }
    #[cfg(target_os = "macos")]
    {
        let path = PathBuf::from("/Applications/Tailscale.app/Contents/MacOS/Tailscale");
        if path.is_file() { return Some(path); }
    }
    None
}

fn tailscale_command(args: &[&str]) -> Result<std::process::Output, String> {
    let program = tailscale_program().ok_or("Tailscale no está instalado en este PC.")?;
    let mut command = std::process::Command::new(program);
    command.args(args);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    command.output().map_err(|error| format!("No se pudo ejecutar Tailscale: {error}"))
}

fn tailscale_info() -> TailscaleInfo {
    if tailscale_program().is_none() { return TailscaleInfo::default(); }
    let Ok(output) = tailscale_command(&["status", "--json", "--peers=false"]) else { return TailscaleInfo { installed: true, ..Default::default() } };
    let status: Value = serde_json::from_slice(&output.stdout).unwrap_or(Value::Null);
    let me = &status["Self"];
    let ip = me["TailscaleIPs"].as_array().and_then(|ips| ips.iter().filter_map(|ip| ip.as_str()).find(|ip| ip.parse::<Ipv4Addr>().is_ok()).map(str::to_string));
    let dns_name = me["DNSName"].as_str().map(|name| name.trim_end_matches('.').to_string()).filter(|name| !name.is_empty());
    TailscaleInfo { installed: true, running: status["BackendState"] == "Running", ip, dns_name }
}

fn status_of(state: &RemoteState, with_network: bool) -> RemoteStatus {
    let inner = &state.0;
    let config = lock(&inner.config).clone();
    let running = lock(&inner.server).as_ref().map(|running| running.bound.clone());
    let connected: HashSet<String> = lock(&inner.hub).connections.values().map(|c| c.device_id.clone()).collect();
    let tailscale = if with_network { tailscale_info() } else { TailscaleInfo::default() };
    let mut urls = Vec::new();
    if let Some(bound) = &running {
        for address in bound.iter().filter(|address| !address.ip().is_loopback()) { urls.push(format!("http://{address}/")); }
        if config.tailscale_serve { if let Some(name) = &tailscale.dns_name { urls.insert(0, format!("https://{name}/")); } }
    }
    RemoteStatus {
        enabled: config.enabled, running: running.is_some(), address: config.address.clone(), port: config.port,
        tailscale_serve: config.tailscale_serve, error: lock(&inner.error).clone(), urls,
        devices: config.devices.iter().map(|d| DeviceInfo { id: d.id.clone(), name: d.name.clone(), created_at: d.created_at, last_seen: d.last_seen,
            connected: connected.contains(&d.id) }).collect(),
        interfaces: if with_network { interfaces() } else { Vec::new() },
        tailscale,
    }
}

// --- Comandos Tauri -------------------------------------------------------------------

#[tauri::command]
pub async fn remote_status(state: State<'_, RemoteState>) -> Result<RemoteStatus, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || status_of(&state, true)).await.map_err(|e| e.to_string())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteSettings { enabled: bool, address: String, port: u16, tailscale_serve: bool }

#[tauri::command]
pub async fn remote_configure(app: AppHandle, state: State<'_, RemoteState>, settings: RemoteSettings) -> Result<RemoteStatus, String> {
    let state = state.inner().clone();
    if settings.port < 1024 { return Err("Usa un puerto entre 1024 y 65535.".into()); }
    if settings.enabled { settings.address.parse::<Ipv4Addr>().map_err(|_| "Elige en qué red escucha el control remoto.".to_string())?; }
    let previous = lock(&state.0.config).clone();
    let snapshot = {
        let mut config = lock(&state.0.config);
        config.enabled = settings.enabled;
        config.address = settings.address.trim().to_string();
        config.port = settings.port;
        config.tailscale_serve = settings.tailscale_serve;
        config.clone()
    };
    save_config(&app, &snapshot)?;
    let serve_changed = previous.tailscale_serve != snapshot.tailscale_serve || previous.port != snapshot.port || previous.enabled != snapshot.enabled;
    if snapshot.enabled { start(&state); } else { stop(&state.0); *lock(&state.0.error) = None; }
    state.0.announce();
    let port = snapshot.port;
    let serve = snapshot.enabled && snapshot.tailscale_serve;
    let state_for_status = state.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if serve_changed && (serve || previous.tailscale_serve) {
            let result = if serve {
                tailscale_command(&["serve", "--bg", "--https=443", &format!("http://127.0.0.1:{port}")])
            } else {
                tailscale_command(&["serve", "--https=443", "off"])
            };
            match result {
                Ok(output) if !output.status.success() => {
                    let message = String::from_utf8_lossy(&output.stderr).trim().chars().take(400).collect::<String>();
                    *lock(&state_for_status.0.error) = Some(format!("Tailscale no pudo publicar el HTTPS: {message}"));
                }
                Err(error) => *lock(&state_for_status.0.error) = Some(error),
                _ => {}
            }
        }
        status_of(&state_for_status, true)
    }).await.map_err(|e| e.to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingCode { code: String, expires_at: u64, url: Option<String>, qr: Option<QrMatrix> }

/// Matriz del QR: la interfaz la dibuja con los colores del tema.
#[derive(Serialize)]
pub struct QrMatrix { width: usize, modules: String }

fn qr_matrix(text: &str) -> Option<QrMatrix> {
    let code = qrcode::QrCode::with_error_correction_level(text.as_bytes(), qrcode::EcLevel::M).ok()?;
    let modules = code.to_colors().into_iter().map(|color| if color == qrcode::Color::Dark { '1' } else { '0' }).collect();
    Some(QrMatrix { width: code.width(), modules })
}

#[tauri::command]
pub async fn remote_pairing_start(state: State<'_, RemoteState>) -> Result<PairingCode, String> {
    let state = state.inner().clone();
    if lock(&state.0.server).is_none() { return Err("Activa el control remoto y espera a que esté escuchando.".into()); }
    let code = new_code()?;
    *lock(&state.0.pairing) = Some(Pairing { code: code.clone(), expires: std::time::Instant::now() + PAIRING_TTL, attempts: 0 });
    let status = tauri::async_runtime::spawn_blocking(move || status_of(&state, true)).await.map_err(|e| e.to_string())?;
    // El código va en el fragmento (#): el navegador no lo manda al servidor ni queda en registros.
    let url = status.urls.first().map(|base| format!("{base}#pair={code}"));
    let qr = url.as_deref().and_then(qr_matrix);
    Ok(PairingCode { code, expires_at: now_ms() + PAIRING_TTL.as_millis() as u64, url, qr })
}

#[tauri::command]
pub fn remote_pairing_cancel(state: State<'_, RemoteState>) {
    *lock(&state.0.pairing) = None;
}

#[tauri::command]
pub fn remote_revoke(app: AppHandle, state: State<'_, RemoteState>, device: String) -> Result<(), String> {
    let snapshot = {
        let mut config = lock(&state.0.config);
        config.devices.retain(|d| d.id != device);
        config.clone()
    };
    save_config(&app, &snapshot)?;
    let _ = state.0.tx.send(Outgoing::Revoked(device.into()));
    Ok(())
}

#[derive(Serialize)]
pub struct BridgeState { active: bool, watching: Vec<String> }

/// El frontend pregunta al cargar si hay algún móvil conectado y qué sesiones mira.
#[tauri::command]
pub fn remote_bridge_state(state: State<'_, RemoteState>) -> BridgeState {
    BridgeState { active: state.0.active(), watching: state.0.watching() }
}

#[tauri::command]
pub fn remote_publish(state: State<'_, RemoteState>, sessions: Value) -> Result<(), String> {
    let json: Arc<str> = json!({ "type": "sessions", "sessions": sessions }).to_string().into();
    if json.len() > MAX_SESSIONS_JSON { return Err("La lista de sesiones es demasiado grande.".into()); }
    let projects: HashMap<String, PathBuf> = sessions.as_array().into_iter().flatten().filter_map(|session| {
        let project = &session["project"];
        Some((project["id"].as_str()?.to_string(), PathBuf::from(project["path"].as_str().filter(|path| !path.is_empty())?)))
    }).collect();
    {
        let mut hub = lock(&state.0.hub);
        hub.sessions = Some(json.clone());
        hub.projects = projects;
    }
    let _ = state.0.tx.send(Outgoing::Sessions(json));
    Ok(())
}

#[tauri::command]
pub fn remote_publish_detail(state: State<'_, RemoteState>, id: String, detail: Value) -> Result<(), String> {
    if !valid_session(&id) { return Err("Sesión no válida.".into()); }
    let json: Arc<str> = json!({ "type": "detail", "session": id, "detail": detail }).to_string().into();
    if json.len() > MAX_DETAIL_JSON { return Err("El detalle de la sesión es demasiado grande.".into()); }
    lock(&state.0.hub).details.insert(id.clone(), json.clone());
    let _ = state.0.tx.send(Outgoing::Detail { id: id.into(), json });
    Ok(())
}

#[tauri::command]
pub fn remote_publish_theme(state: State<'_, RemoteState>, theme: Value) -> Result<(), String> {
    let json: Arc<str> = json!({ "type": "theme", "theme": theme }).to_string().into();
    if json.len() > 8 * 1024 { return Err("Tema no válido.".into()); }
    lock(&state.0.hub).theme = Some(json.clone());
    let _ = state.0.tx.send(Outgoing::Theme(json));
    Ok(())
}

#[tauri::command]
pub fn remote_command_result(state: State<'_, RemoteState>, command: u64, ok: bool, error: Option<String>) {
    if let Some(done) = lock(&state.0.hub).pending.remove(&command) {
        let _ = done.send((ok, error.map(|e| e.chars().take(500).collect())));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pairing_codes_avoid_ambiguous_characters_and_normalize_what_people_type() {
        let code = new_code().unwrap();
        assert_eq!(code.len(), CODE_LEN);
        assert!(code.bytes().all(|b| CODE_ALPHABET.contains(&b)));
        assert!(!code.contains('0') && !code.contains('O') && !code.contains('1') && !code.contains('I'));
        assert_eq!(normalize_code(" k7q-4m2 "), "K7Q4M2");
    }

    #[test]
    fn a_wrong_code_counts_attempts_and_the_fifth_closes_the_pairing() {
        let state = RemoteState::default();
        *lock(&state.0.pairing) = Some(Pairing { code: "ABCDEF".into(), expires: std::time::Instant::now() + PAIRING_TTL, attempts: 0 });
        for _ in 0..PAIRING_ATTEMPTS - 1 { assert_eq!(state.0.pair("ZZZZZZ", "x").unwrap_err().0, StatusCode::UNAUTHORIZED); }
        assert_eq!(state.0.pair("ZZZZZZ", "x").unwrap_err().0, StatusCode::FORBIDDEN);
        // Ni siquiera el código bueno vale ya.
        assert_eq!(state.0.pair("ABCDEF", "x").unwrap_err().0, StatusCode::FORBIDDEN);
    }

    #[test]
    fn a_right_code_pairs_once_and_only_the_hash_of_the_token_is_kept() {
        let state = RemoteState::default();
        *lock(&state.0.pairing) = Some(Pairing { code: "ABCDEF".into(), expires: std::time::Instant::now() + PAIRING_TTL, attempts: 0 });
        let (token, device) = state.0.pair("abc-def", "  Pixel\n 8 ").unwrap();
        assert_eq!(device.name, "Pixel 8");
        assert!(token.len() >= 43);
        let stored = lock(&state.0.config).devices[0].clone();
        assert_ne!(stored.token_hash, token);
        assert_eq!(stored.token_hash, token_hash(&token));
        assert!(state.0.authenticate(&token).is_some());
        assert!(state.0.authenticate("x".repeat(43).as_str()).is_none());
        assert_eq!(state.0.pair("ABCDEF", "otro").unwrap_err().0, StatusCode::FORBIDDEN);
    }

    #[test]
    fn an_expired_code_is_refused() {
        let state = RemoteState::default();
        *lock(&state.0.pairing) = Some(Pairing { code: "ABCDEF".into(), expires: std::time::Instant::now() - Duration::from_secs(1), attempts: 0 });
        assert_eq!(state.0.pair("ABCDEF", "x").unwrap_err().0, StatusCode::FORBIDDEN);
    }

    #[test]
    fn only_the_mobile_app_files_are_served() {
        assert_eq!(asset_path("/").as_deref(), Some("remote.html"));
        assert_eq!(asset_path("/assets/remote-Ab12_c.js").as_deref(), Some("assets/remote-Ab12_c.js"));
        assert_eq!(asset_path("/remote.webmanifest").as_deref(), Some("remote.webmanifest"));
        assert_eq!(asset_path("/assets/../index.html"), None);
        assert_eq!(asset_path("/assets/a/b.js"), None);
        assert_eq!(asset_path("/preview.html"), None);
        assert_eq!(asset_path("/assets\\x.js"), None);
    }

    #[test]
    fn other_websites_cannot_open_the_socket() {
        let mut headers = HeaderMap::new();
        headers.insert(header::HOST, HeaderValue::from_static("10.8.0.1:7340"));
        headers.insert(header::ORIGIN, HeaderValue::from_static("http://10.8.0.1:7340"));
        assert!(same_origin(&headers));
        headers.insert(header::ORIGIN, HeaderValue::from_static("http://evil.example"));
        assert!(!same_origin(&headers));
        // Detrás de `tailscale serve` el host original llega en X-Forwarded-Host.
        let mut proxied = HeaderMap::new();
        proxied.insert(header::HOST, HeaderValue::from_static("127.0.0.1:7340"));
        proxied.insert("x-forwarded-host", HeaderValue::from_static("pc.tail1234.ts.net"));
        proxied.insert(header::ORIGIN, HeaderValue::from_static("https://pc.tail1234.ts.net"));
        assert!(same_origin(&proxied));
    }

    #[test]
    fn networks_are_recognized_for_the_settings_list() {
        assert_eq!(interface_kind("Tailscale", "100.101.2.3".parse().unwrap()), "tailscale");
        assert_eq!(interface_kind("casa", "100.100.1.1".parse().unwrap()), "tailscale");
        assert_eq!(interface_kind("wg0", "10.8.0.1".parse().unwrap()), "wireguard");
        assert_eq!(interface_kind("Ethernet", "192.168.1.20".parse().unwrap()), "lan");
        assert_eq!(interface_kind("Ethernet", "8.8.8.8".parse().unwrap()), "other");
    }

    #[test]
    fn only_known_and_bounded_actions_reach_the_desktop() {
        assert!(validate_action(&json!({ "kind": "send", "text": "  hola " })).unwrap()["text"] == "hola");
        assert!(validate_action(&json!({ "kind": "send", "text": "   " })).is_err());
        // Solo con adjuntos también vale; lo que no tiene forma de id, no.
        let id = "a".repeat(32);
        assert!(validate_action(&json!({ "kind": "send", "text": "", "attachments": [id] })).is_ok());
        assert!(validate_action(&json!({ "kind": "send", "text": "x", "attachments": ["../../etc"] })).is_err());
        assert!(validate_action(&json!({ "kind": "send", "text": "x", "attachments": vec![id.clone(); MAX_ATTACHMENTS + 1] })).is_err());
        assert!(validate_action(&json!({ "kind": "send", "text": "x".repeat(MAX_SEND_CHARS + 1) })).is_err());
        assert!(validate_action(&json!({ "kind": "shell", "text": "rm -rf" })).is_err());
        let answer = validate_action(&json!({ "kind": "answer", "item": "p-1", "allowed": true, "choices": [{ "question": "¿?", "selected": ["A"], "other": "" }] })).unwrap();
        assert_eq!(answer["choices"][0]["selected"][0], "A");
        assert_eq!(answer["remember"], false);
        assert!(validate_action(&json!({ "kind": "answer" })).is_err());
        assert!(!valid_session("../x") && valid_session("tab-123_a"));
    }

    #[test]
    fn a_phone_only_sends_its_own_uploads() {
        let state = RemoteState::default();
        let upload = |device: &str| Upload { device: device.into(), path: PathBuf::from("C:/a/foto.png"), name: "foto.png".into(), image: true, at: std::time::Instant::now() };
        state.0.add_upload("1".repeat(32), upload("movil"));
        state.0.add_upload("2".repeat(32), upload("otro"));
        let files = state.0.resolve_uploads("movil", &["1".repeat(32)]).unwrap();
        assert_eq!(files[0]["name"], "foto.png");
        assert_eq!(files[0]["image"], true);
        assert!(state.0.resolve_uploads("movil", &["2".repeat(32)]).is_err());
        assert!(state.0.resolve_uploads("movil", &["3".repeat(32)]).is_err());
        for index in 0..MAX_UPLOADS + 5 { state.0.add_upload(format!("{index:032}"), upload("movil")); }
        assert!(lock(&state.0.uploads).len() <= MAX_UPLOADS);
    }

    #[test]
    fn listening_on_every_network_is_refused() {
        let mut config = RemoteConfig { enabled: true, address: "0.0.0.0".into(), ..Default::default() };
        assert!(listen_addresses(&config).is_err());
        config.address = "10.8.0.1".into();
        config.tailscale_serve = true;
        let addresses = listen_addresses(&config).unwrap();
        assert_eq!(addresses.len(), 2);
        assert!(addresses[1].ip().is_loopback());
    }

    #[test]
    fn the_real_server_pairs_over_http_and_refuses_other_websites() {
        let port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        let state = RemoteState::default();
        let config = RemoteConfig { enabled: true, address: "127.0.0.1".into(), port, ..Default::default() };
        let running = tauri::async_runtime::block_on(bind(&state, &config)).unwrap();
        *lock(&state.0.pairing) = Some(Pairing { code: "ABCDEF".into(), expires: std::time::Instant::now() + PAIRING_TTL, attempts: 0 });
        let client = reqwest::blocking::Client::new();
        let url = format!("http://127.0.0.1:{port}/api/pair");
        let post = |origin: &str, code: &str| client.post(&url).header("origin", origin).header("content-type", "application/json")
            .body(json!({ "code": code, "name": "Prueba" }).to_string()).send().unwrap();
        // Otra web no puede emparejar aunque acierte el código.
        assert_eq!(post("http://evil.example", "ABCDEF").status().as_u16(), 403);
        assert_eq!(post(&format!("http://127.0.0.1:{port}"), "ZZZZZZ").status().as_u16(), 401);
        let ok = post(&format!("http://127.0.0.1:{port}"), "abc-def");
        assert_eq!(ok.status().as_u16(), 200);
        let body: Value = serde_json::from_str(&ok.text().unwrap()).unwrap();
        let token = body["token"].as_str().unwrap().to_string();
        assert!(state.0.authenticate(&token).is_some());
        // Solo se sirven los archivos de la app móvil.
        assert_eq!(client.get(format!("http://127.0.0.1:{port}/preview.html")).send().unwrap().status().as_u16(), 404);
        let _ = running.shutdown.send(true);
    }
}
