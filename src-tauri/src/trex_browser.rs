//! Bounded management bridge to the separately installed browser companion.
//! No PATH search, browser launch during doctor, or capability token in argv.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

const PROTOCOL: &str = "2025-11-25";
const INPUT_LIMIT: usize = 256 * 1024;
const OUTPUT_LIMIT: usize = 8 * 1024 * 1024;
const PROBE_LIMIT: usize = 1024 * 1024;
const PROBE_TIMEOUT: Duration = Duration::from_secs(15);
const CALL_TIMEOUT: Duration = Duration::from_secs(100);
// The worker allows its broker 45 s to open a window (cold Electron start), plus starting the broker itself.
const OPEN_TIMEOUT: Duration = Duration::from_secs(70);
const FAILED: &str = "No se pudo completar la operación de Trex Browser.";
const INVALID: &str = "Trex Browser devolvió una respuesta no válida.";
const MISSING: &str = "Trex Browser no está instalado. Activa su opción en el instalador o instala el componente independiente.";
const NO_BROWSER: &str = "No se encontró el navegador de Trex ni Chrome. Reinstala Trex Browser o instala Chromium, Google Chrome o Microsoft Edge.";
const TOOL_NAMES: &[&str] = &[
    "browser_navigate", "browser_navigate_back", "browser_reload", "browser_tabs", "browser_frames",
    "browser_handle_dialog", "browser_snapshot", "browser_click", "browser_hover", "browser_drag",
    "browser_mouse", "browser_press_key", "browser_type", "browser_fill_form", "browser_select_option",
    "browser_evaluate", "browser_resize", "browser_emulate", "browser_console_messages", "browser_network_requests",
    "browser_network_body", "browser_route", "browser_file_upload", "browser_take_screenshot", "browser_start_video",
    "browser_stop_video", "browser_start_trace", "browser_stop_trace", "browser_perf_start", "browser_perf_stop",
    "browser_cpu_profile_start", "browser_cpu_profile_stop", "browser_heap_snapshot", "browser_wait_for", "browser_artifact",
    "browser_status", "browser_pause", "browser_resume", "browser_takeover", "browser_cancel", "browser_close", "browser_batch",
    "browser_save_download",
];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserStatus {
    installed: bool,
    ready: bool,
    compatible: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    protocol_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    browsers: Option<Vec<BrowserSummary>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    capabilities: Option<std::collections::BTreeMap<String, bool>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<BrowserError>,
}

#[derive(Serialize)]
pub struct BrowserSummary {
    id: String,
    name: String,
    available: bool,
}

#[derive(Serialize)]
pub struct BrowserError {
    code: String,
    message: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrowserCallRequest {
    name: String,
    arguments: Value,
    cwd: String,
    mode: String,
    client_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    profile: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    operation_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    timeout_ms: Option<u64>,
}

#[derive(Serialize)]
pub struct BrowserMcpConfig {
    command: String,
    args: Vec<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserProfile {
    id: String,
    name: String,
    project_id: String,
    created_at: String,
}

#[derive(Deserialize, Serialize)]
pub struct BrowserProfiles {
    profiles: Vec<BrowserProfile>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrowserSpaceMember { client_id: String, label: String, #[serde(default, skip_serializing_if = "Option::is_none")] model: Option<String> }
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrowserSpace { client_id: String, label: String, profile: String }
#[derive(Deserialize, Serialize)]
pub struct BrowserSpaces { spaces: Vec<BrowserSpace> }

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrowserSpaceOverview {
    client_id: String, label: String, profile: String,
    running: bool, paused: bool, active: bool, tab_count: usize,
    #[serde(default)] in_use: bool,
    current_tool: Option<String>, url: String,
}
#[derive(Deserialize, Serialize)]
pub struct BrowserSpaceInventory { spaces: Vec<BrowserSpaceOverview> }

#[derive(Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum BrowserContent {
    Text { text: String },
    Image {
        data: String,
        #[serde(rename = "mimeType")]
        mime_type: String,
    },
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserCallResult {
    content: Vec<BrowserContent>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    structured_content: Option<Value>,
    #[serde(default)]
    is_error: bool,
}

fn plain(value: &str, limit: usize) -> bool {
    !value.is_empty() && value.len() <= limit && !value.chars().any(char::is_control)
}

fn opaque(value: &str, limit: usize) -> bool {
    plain(value, limit)
        && value.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"_-.:".contains(&byte))
}

fn validate_context(cwd: &str, mode: &str, client: &str, profile: Option<&str>) -> Result<(), String> {
    if !plain(cwd, 32768)
        || !Path::new(cwd).is_absolute()
        || !Path::new(cwd).is_dir()
        || !matches!(mode, "observe" | "qa" | "full")
        || !opaque(client, 128)
        || client.starts_with('-')
        || profile.is_some_and(|value| {
            !value.starts_with("BROWSER")
                || value.len() <= 7
                || value.len() > 9
                || !value[7..].bytes().all(|byte| byte.is_ascii_digit())
                || value.as_bytes()[7] == b'0'
        })
    {
        return Err("El contexto de Trex Browser no es válido.".into());
    }
    Ok(())
}

fn validate_request(request: &BrowserCallRequest) -> Result<(), String> {
    validate_context(&request.cwd, &request.mode, &request.client_id, request.profile.as_deref())?;
    // Tools can never replace the grant established by the outer app context.
    let Some(arguments) = request.arguments.as_object() else { return Err(FAILED.into()) };
    if !TOOL_NAMES.contains(&request.name.as_str())
        || arguments.keys().any(|key| matches!(key.as_str(),
            "cwd" | "mode" | "clientId" | "client" | "profile" | "home" | "token" | "capability"))
        || request.operation_id.as_ref().is_some_and(|id| !opaque(id, 128))
        || request.timeout_ms.is_some_and(|value| value == 0 || value > 90_000)
    {
        return Err("La solicitud de Trex Browser no es válida.".into());
    }
    Ok(())
}

fn ordinary_path(path: &Path) -> bool {
    if !path.is_absolute() { return false; }
    #[cfg(windows)]
    {
        use std::path::{Component, Prefix};
        if !matches!(path.components().next(), Some(Component::Prefix(prefix))
            if matches!(prefix.kind(), Prefix::Disk(_) | Prefix::VerbatimDisk(_)))
            || path.components().any(|component| matches!(component, Component::ParentDir | Component::CurDir)
                || matches!(component, Component::Normal(name) if {
                    let value = name.to_string_lossy();
                    value.contains(':') || value.ends_with(['.', ' ']) || value.chars().any(char::is_control)
                }))
        { return false; }
    }
    path.ancestors().all(|part| {
        std::fs::symlink_metadata(part).is_ok_and(|metadata| {
            if metadata.file_type().is_symlink() { return false; }
            #[cfg(windows)]
            {
                use std::os::windows::fs::MetadataExt;
                if metadata.file_attributes() & 0x400 != 0 { return false; }
            }
            true
        })
    })
}

fn browser_binary(directory: &Path) -> Option<PathBuf> {
    let binary = directory.join(if cfg!(windows) { "trex-browser.exe" } else { "trex-browser" });
    (ordinary_path(&binary) && binary.is_file()).then(|| binary.canonicalize().ok())
        .flatten().filter(|canonical| ordinary_path(canonical))
}

#[cfg(windows)]
fn registered_directory() -> Option<PathBuf> {
    use std::ffi::c_void;
    #[link(name = "advapi32")]
    extern "system" {
        fn RegGetValueW(key: isize, subkey: *const u16, value: *const u16,
            flags: u32, kind: *mut u32, data: *mut c_void, bytes: *mut u32) -> i32;
    }
    let wide = |text: &str| text.encode_utf16().chain(Some(0)).collect::<Vec<_>>();
    let subkey = wide(r"Software\com.trex.browser\Install");
    let name = wide("InstallDir");
    let mut buffer = vec![0u16; 32768];
    let mut bytes = (buffer.len() * 2) as u32;
    // REG_SZ only, explicit 64-bit view, no expandable/environment value.
    let result = unsafe { RegGetValueW(0x8000_0001u32 as i32 as isize,
        subkey.as_ptr(), name.as_ptr(), 0x0001_0002, std::ptr::null_mut(),
        buffer.as_mut_ptr().cast(), &mut bytes) };
    if result != 0 || bytes < 4 || bytes as usize > buffer.len() * 2 || bytes % 2 != 0 { return None; }
    buffer.truncate(bytes as usize / 2);
    if buffer.pop() != Some(0) || buffer.contains(&0) { return None; }
    let text = String::from_utf16(&buffer).ok()?;
    plain(&text, 32768).then(|| PathBuf::from(text))
}

#[cfg(target_os = "linux")]
fn registered_directory() -> Option<PathBuf> {
    let base = std::env::var_os("XDG_DATA_HOME").map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".local/share")))?;
    base.is_absolute().then(|| base.join("trex-browser"))
}
#[cfg(not(any(windows, target_os = "linux")))]
fn registered_directory() -> Option<PathBuf> { None }

#[cfg(debug_assertions)]
fn development_browser_directory() -> Option<PathBuf> {
    Path::new(env!("CARGO_MANIFEST_DIR")).parent()
        .map(|root| root.join("trex-browser/target/debug"))
}

/// Production uses the app sibling first, then the standalone install registry.
/// Debug alone additionally accepts this checkout's built target/debug layout.
pub(crate) fn installed_browser_path() -> Result<PathBuf, String> {
    if let Some(binary) = std::env::current_exe().ok()
        .and_then(|path| path.parent().and_then(browser_binary)) { return Ok(binary); }
    if let Some(binary) = registered_directory().as_deref().and_then(browser_binary) { return Ok(binary); }
    #[cfg(debug_assertions)]
    if let Some(binary) = development_browser_directory().as_deref().and_then(browser_binary) { return Ok(binary); }
    Err(MISSING.into())
}

fn read_output(mut output: impl Read, limit: usize) -> Result<Vec<u8>, ()> {
    let mut bytes = Vec::new();
    let mut buffer = [0u8; 8192];
    let mut overflow = false;
    loop {
        let count = output.read(&mut buffer).map_err(|_| ())?;
        if count == 0 { break; }
        if bytes.len().saturating_add(count) <= limit { bytes.extend_from_slice(&buffer[..count]); }
        else { overflow = true; }
    }
    if overflow { Err(()) } else { Ok(bytes) }
}

fn browser_command(path: &Path) -> Command {
    let mut command = Command::new(path);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    // The companion owns its private runtime; injected Node startup code is
    // never inherited. Broker credentials stay in the companion's private home.
    command.env_remove("NODE_OPTIONS").env_remove("NODE_PATH");
    command
}

fn invoke_at(path: &Path, args: &[&str], input: Option<Vec<u8>>, timeout: Duration, limit: usize) -> Result<Vec<u8>, String> {
    invoke_command(browser_command(path), args, input, timeout, limit)
}

fn invoke_command(mut command: Command, args: &[&str], input: Option<Vec<u8>>, timeout: Duration, limit: usize) -> Result<Vec<u8>, String> {
    if input.as_ref().is_some_and(|bytes| bytes.len() > INPUT_LIMIT) { return Err("La solicitud de Trex Browser supera el límite permitido.".into()); }
    command.args(args).stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped()).stderr(Stdio::null());
    let mut child = command.spawn().map_err(|_| FAILED.to_string())?;
    let Some(stdout) = child.stdout.take() else {
        let _ = child.kill(); let _ = child.wait(); return Err(FAILED.into());
    };
    let (output_tx, output_rx) = mpsc::sync_channel(1);
    thread::spawn(move || { let _ = output_tx.send(read_output(stdout, limit)); });
    let input_rx = input.map(|bytes| {
        let stdin = child.stdin.take();
        let (tx, rx) = mpsc::sync_channel(1);
        thread::spawn(move || {
            let result = stdin.ok_or(()).and_then(|mut pipe| pipe.write_all(&bytes).map_err(|_| ()));
            let _ = tx.send(result);
        }); rx
    });
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(15)),
            _ => { let _ = child.kill(); let _ = child.wait(); return Err(FAILED.into()); }
        }
    };
    if let Some(rx) = input_rx {
        rx.recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .map_err(|_| FAILED.to_string())?.map_err(|_| FAILED.to_string())?;
    }
    let bytes = output_rx.recv_timeout(deadline.saturating_duration_since(Instant::now()))
        .map_err(|_| FAILED.to_string())?.map_err(|_| FAILED.to_string())?;
    if !status.success() { return Err(worker_failure(&bytes)); }
    Ok(bytes)
}

/// A failing worker still writes its error envelope to stdout before exiting 1
/// (`errorResult` in worker.mjs: `structuredContent.error.{code,message}`, with
/// private paths already stripped). stderr stays discarded. Without a readable
/// envelope the reason is the generic sentence.
fn worker_failure(stdout: &[u8]) -> String {
    let Ok(envelope) = serde_json::from_slice::<Value>(stdout) else { return FAILED.into() };
    let error = envelope.pointer("/structuredContent/error");
    let field = |name: &str| error.and_then(|error| error.get(name)).and_then(Value::as_str);
    let message = field("message").or_else(|| envelope.pointer("/content/0/text").and_then(Value::as_str)).unwrap_or("");
    explain_failure(field("code").unwrap_or(""), message)
}

/// Spanish reason for a worker failure. The broker's HTTP replies drop error codes
/// (everything arrives as BROWSER_ERROR), so known causes are also recognised by
/// their message; anything else is shown as the worker wrote it.
fn explain_failure(code: &str, message: &str) -> String {
    let lower = message.to_lowercase();
    let has = |needles: &[&str]| needles.iter().any(|needle| lower.contains(needle));
    let known = if code == "PROFILE_IN_USE" || has(&["older separate trex browser window", "open in a person's trex browser window"]) {
        "Este espacio está abierto en otra ventana independiente de Trex Browser. Ciérrala e inténtalo de nuevo."
    } else if code == "PROFILE_CLOSING" || has(&["profile is closing"]) {
        "Este espacio se está cerrando. Espera unos segundos e inténtalo de nuevo."
    } else if has(&["shell is not installed"]) {
        "Falta la ventana de Trex Browser. Reinstala el componente."
    } else if has(&["install google chrome"]) {
        NO_BROWSER
    } else if has(&["broker startup", "broker launch", "broker is not running", "aborted due to timeout", "fetch failed"]) {
        "El servicio de Trex Browser no respondió a tiempo. Vuelve a intentarlo en unos segundos."
    } else if has(&["no free browser profiles"]) {
        "No quedan espacios de navegador libres en este proyecto (máximo 98); los existentes se conservan."
    } else if has(&["shell ui did not start", "shell ui documents", "new tab did not attach"]) {
        "La ventana de Trex Browser no llegó a abrirse. Vuelve a intentarlo."
    } else if has(&["tab not found"]) {
        "Esa pestaña ya no existe."
    } else if plain(message, 2000) {
        return format!("Trex Browser indicó: {}", message.chars().take(300).collect::<String>());
    } else { FAILED };
    known.into()
}

fn status_error(installed: bool, code: &str, message: &str) -> BrowserStatus {
    BrowserStatus { installed, ready: false, compatible: false,
        protocol_version: None, version: None, browsers: None, capabilities: None,
        error: Some(BrowserError { code: code.into(), message: message.into() }) }
}

fn doctor_status(bytes: &[u8]) -> Result<BrowserStatus, String> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Doctor {
        version: String, protocol_version: String,
        runtime: Runtime, browser: Browser,
        #[serde(default)] capabilities: std::collections::BTreeMap<String, Value>,
    }
    #[derive(Deserialize)]
    struct Runtime { node: bool, playwright: bool, #[serde(default)] ffmpeg: Option<bool> }
    #[derive(Deserialize)]
    struct Browser { available: bool, #[serde(default)] channel: Option<String> }
    let doctor: Doctor = serde_json::from_slice(bytes).map_err(|_| INVALID.to_string())?;
    if !plain(&doctor.version, 128) || !plain(&doctor.protocol_version, 128) || doctor.capabilities.len() > 128 { return Err(INVALID.into()); }
    let compatible = doctor.protocol_version == PROTOCOL;
    let runtime_ready = doctor.runtime.node && doctor.runtime.playwright && doctor.runtime.ffmpeg != Some(false);
    let channel = doctor.browser.channel.filter(|value| matches!(value.as_str(), "chrome" | "msedge" | "edge" | "chromium"));
    let mut status = BrowserStatus { installed: true, ready: compatible && runtime_ready && doctor.browser.available,
        compatible, protocol_version: Some(doctor.protocol_version), version: Some(doctor.version),
        browsers: Some(vec![BrowserSummary { id: channel.clone().unwrap_or_else(|| "chrome".into()),
            name: match channel.as_deref() { Some("msedge" | "edge") => "Microsoft Edge", Some("chromium") => "Chromium", _ => "Google Chrome" }.into(),
            available: doctor.browser.available }]),
        capabilities: Some(doctor.capabilities.into_iter().filter_map(|(key, value)| {
            (opaque(&key, 80)).then(|| value.as_bool().map(|value| (key, value))).flatten()
        }).collect()), error: None };
    status.error = if !compatible { Some(BrowserError { code: "incompatible".into(), message: "Actualiza Trex Browser para usar este protocolo.".into() }) }
        else if !runtime_ready { Some(BrowserError { code: "missing_runtime".into(), message: "Faltan archivos del runtime de Trex Browser. Reinstala el componente.".into() }) }
        else if !doctor.browser.available { Some(BrowserError { code: "missing_browser".into(), message: NO_BROWSER.into() }) }
        else { None };
    Ok(status)
}

fn probe_status(path: &Path) -> Result<BrowserStatus, String> {
    let runtime = path.parent().ok_or_else(|| FAILED.to_string())?.join("trex-browser-runtime");
    #[cfg(target_os = "linux")]
    let runtime = if path.parent() == Some(Path::new("/usr/bin")) && !runtime.exists() {
        PathBuf::from("/usr/lib/trex/trex-browser-runtime")
    } else { runtime };
    let required = [if cfg!(windows) { "node.exe" } else { "node" }, "worker.mjs", "package.json", "package-lock.json",
        "node_modules/playwright/package.json", "node_modules/playwright-core/package.json"];
    if required.iter().any(|name| {
        let file = runtime.join(name);
        !ordinary_path(&file) || !file.is_file()
    }) || !ordinary_path(&runtime.join("ffmpeg")) || !runtime.join("ffmpeg").is_dir() {
        return Ok(status_error(true, "missing_runtime", "Faltan archivos del runtime de Trex Browser. Reinstala el componente."));
    }
    doctor_status(&invoke_at(path, &["doctor", "--json"], None, PROBE_TIMEOUT, PROBE_LIMIT)?)
}

fn prepared_broker(bytes: &[u8]) -> Result<(), String> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Prepared { ready: bool, protocol_version: String }
    let status: Prepared = serde_json::from_slice(bytes).map_err(|_| INVALID.to_string())?;
    if !status.ready || status.protocol_version != PROTOCOL { return Err(FAILED.into()); }
    Ok(())
}

#[tauri::command]
pub async fn trex_browser_status() -> Result<BrowserStatus, String> {
    crate::blocking(|| {
        let Ok(path) = installed_browser_path() else { return Ok(status_error(false, "not_installed", MISSING)); };
        Ok(match probe_status(&path) {
            Ok(status) => status,
            Err(_) => status_error(true, "probe_failed", "No se pudo comprobar Trex Browser. Reinstala el componente o vuelve a intentarlo."),
        })
    }).await
}

#[tauri::command]
pub async fn trex_browser_mcp_config(cwd: String, mode: String, client_id: String, profile: Option<String>) -> Result<BrowserMcpConfig, String> {
    crate::blocking(move || {
        validate_context(&cwd, &mode, &client_id, profile.as_deref())?;
        let path = installed_browser_path()?;
        let status = probe_status(&path)?;
        if !status.ready { return Err(status.error.map(|error| error.message).unwrap_or_else(|| FAILED.into())); }
        // Codex/Claude may wrap MCP children in a non-breakaway Windows job.
        // Start the broker from the app, whose manual controls can launch it,
        // before those clients attach. This never opens a browser or profile.
        prepared_broker(&invoke_at(&path, &["prepare", "--json"], None, Duration::from_secs(30), PROBE_LIMIT)?)?;
        let mut args = vec!["mcp".into(), "--cwd".into(), cwd, "--mode".into(), mode, "--client".into(), client_id];
        if let Some(profile) = profile { args.extend(["--profile".into(), profile]); }
        Ok(BrowserMcpConfig { command: path.to_string_lossy().into_owned(), args })
    }).await
}

fn call_result(bytes: &[u8]) -> Result<BrowserCallResult, String> {
    if bytes.len() > OUTPUT_LIMIT { return Err(INVALID.into()); }
    let result: BrowserCallResult = serde_json::from_slice(bytes).map_err(|_| INVALID.to_string())?;
    if result.content.len() > 128 || result.structured_content.as_ref().is_some_and(|value| !value.is_object())
        || result.content.iter().any(|content| match content {
            BrowserContent::Text { text } => text.len() > OUTPUT_LIMIT,
            BrowserContent::Image { data, mime_type } => data.len() > 6 * 1024 * 1024
                || !matches!(mime_type.as_str(), "image/png" | "image/jpeg" | "image/webp")
                || base64::Engine::decode(&base64::engine::general_purpose::STANDARD, data).is_err(),
        }) { return Err(INVALID.into()); }
    Ok(result)
}

fn call(request: BrowserCallRequest) -> Result<BrowserCallResult, String> {
    validate_request(&request)?;
    let path = installed_browser_path()?;
    let status = probe_status(&path)?;
    if !status.compatible || status.error.as_ref().is_some_and(|error| error.code == "missing_runtime") {
        return Err(status.error.map(|error| error.message).unwrap_or_else(|| FAILED.into()));
    }
    let bytes = serde_json::to_vec(&request).map_err(|_| FAILED.to_string())?;
    call_result(&invoke_at(&path, &["call", "--stdin-json"], Some(bytes), CALL_TIMEOUT, OUTPUT_LIMIT)?)
}

fn profiles_result(bytes: &[u8]) -> Result<BrowserProfiles, String> {
    let result: BrowserProfiles = serde_json::from_slice(bytes).map_err(|_| INVALID.to_string())?;
    if result.profiles.len() > 1024 || result.profiles.iter().any(|profile| {
        !opaque(&profile.id, 32) || !plain(&profile.name, 128) || !opaque(&profile.project_id, 128)
            || !plain(&profile.created_at, 64)
    }) { return Err(INVALID.into()); }
    Ok(result)
}

#[tauri::command]
pub async fn trex_browser_profiles(cwd: String) -> Result<BrowserProfiles, String> {
    crate::blocking(move || {
        validate_context(&cwd, "observe", "settings", None)?;
        let path = installed_browser_path()?;
        profiles_result(&invoke_at(&path, &["profiles", "list", "--cwd", &cwd], None, PROBE_TIMEOUT, PROBE_LIMIT)?)
    }).await
}

#[tauri::command]
pub async fn trex_browser_create_profile(cwd: String, profile: String) -> Result<BrowserProfiles, String> {
    crate::blocking(move || {
        validate_context(&cwd, "observe", "settings", Some(&profile))?;
        let path = installed_browser_path()?;
        profiles_result(&invoke_at(&path, &["profiles", "create", "--cwd", &cwd, "--profile", &profile], None, PROBE_TIMEOUT, PROBE_LIMIT)?)
    }).await
}

#[tauri::command]
pub async fn trex_browser_spaces(cwd: String, members: Vec<BrowserSpaceMember>) -> Result<BrowserSpaces, String> {
    crate::blocking(move || {
        if members.is_empty() || members.len() > 9 { return Err(INVALID.into()); }
        let mut clients = std::collections::HashSet::new();
        for member in &members {
            validate_context(&cwd, "observe", &member.client_id, None)?;
            if !plain(&member.label, 100) || member.label.trim().is_empty() || !clients.insert(&member.client_id) { return Err(INVALID.into()); }
            if member.model.as_ref().is_some_and(|model| !plain(model, 60) || model.chars().any(char::is_control)) { return Err(INVALID.into()); }
        }
        let bytes = serde_json::to_vec(&serde_json::json!({"cwd":cwd,"members":members})).map_err(|_| FAILED.to_string())?;
        let output = invoke_at(&installed_browser_path()?, &["spaces","--stdin-json"], Some(bytes), PROBE_TIMEOUT, PROBE_LIMIT)?;
        let result: BrowserSpaces = serde_json::from_slice(&output).map_err(|_| INVALID.to_string())?;
        let mut profiles = std::collections::HashSet::new();
        if result.spaces.len() != members.len() { return Err(INVALID.into()); }
        for space in &result.spaces {
            validate_context(&cwd, "observe", &space.client_id, Some(&space.profile))?;
            if !members.iter().any(|member| member.client_id == space.client_id && member.label == space.label)
                || !profiles.insert(&space.profile) || !clients.remove(&space.client_id) { return Err(INVALID.into()); }
        }
        Ok(result)
    }).await
}

fn space_inventory(bytes: &[u8], cwd: &str) -> Result<BrowserSpaceInventory, String> {
    if bytes.len()>PROBE_LIMIT {return Err(INVALID.into());}
    let result: BrowserSpaceInventory = serde_json::from_slice(bytes).map_err(|_| INVALID.to_string())?;
    if result.spaces.len() > 99 { return Err(INVALID.into()); }
    let mut profiles=std::collections::HashSet::new();
    for space in &result.spaces {
        validate_context(cwd,"observe",&space.client_id,Some(&space.profile))?;
        if !plain(&space.label,400) || space.label.chars().any(char::is_control) || !profiles.insert(&space.profile)
            || space.tab_count > 10000 || space.url.len() > 4096 || space.url.chars().any(char::is_control)
            || space.current_tool.as_ref().is_some_and(|name| !TOOL_NAMES.contains(&name.as_str())) { return Err(INVALID.into()); }
    }
    Ok(result)
}

#[tauri::command]
pub async fn trex_browser_list_spaces(cwd: String) -> Result<BrowserSpaceInventory, String> {
    crate::blocking(move || {
        validate_context(&cwd,"observe","host-spaces",None)?;
        let output=invoke_at(&installed_browser_path()?, &["spaces","list","--cwd",&cwd,"--json"],None,PROBE_TIMEOUT,PROBE_LIMIT)?;
        space_inventory(&output,&cwd)
    }).await
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct BrowserFocus { pub focused: bool, #[serde(default, skip_serializing_if = "Option::is_none")] pub reason: Option<String> }

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct BrowserMcpSession { pub url: String, pub token: String, pub mode: String }

/// Per-agent MCP-over-HTTP session served by the broker. The token is handed to
/// the agent through its environment, never its command line. Re-issuing for
/// the same agent keeps the token and only changes the bound mode.
#[tauri::command]
pub async fn trex_browser_mcp_session(cwd: String, mode: String, client_id: String, profile: Option<String>) -> Result<BrowserMcpSession, String> {
    crate::blocking(move || {
        validate_context(&cwd, &mode, &client_id, profile.as_deref())?;
        let bytes = serde_json::to_vec(&serde_json::json!({"cwd":cwd,"mode":mode,"clientId":client_id,"profile":profile})).map_err(|_| FAILED.to_string())?;
        let output = invoke_at(&installed_browser_path()?, &["mcp-session","--stdin-json"], Some(bytes), Duration::from_secs(30), PROBE_LIMIT)?;
        let session: BrowserMcpSession = serde_json::from_slice(&output).map_err(|_| INVALID.to_string())?;
        let valid_url = session.url.strip_prefix("http://127.0.0.1:").and_then(|rest| rest.strip_suffix("/mcp"))
            .is_some_and(|port| port.parse::<u16>().is_ok_and(|p| p > 0));
        if !valid_url || session.token.len() != 64 || !session.token.bytes().all(|b| b.is_ascii_hexdigit()) || session.mode != mode { return Err(INVALID.into()); }
        Ok(session)
    }).await
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct BrowserOpen { pub opened: bool, #[serde(default, skip_serializing_if = "Option::is_none")] pub reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")] pub reused: Option<bool>, #[serde(default, skip_serializing_if = "Option::is_none")] pub pid: Option<u32> }

/// Opens a person's Trex Browser window without automation: the personal
/// profile, or (with cwd + profile) an agent's closed space to sign in.
#[tauri::command]
pub async fn trex_browser_open(cwd: Option<String>, profile: Option<String>, url: Option<String>) -> Result<BrowserOpen, String> {
    crate::blocking(move || {
        if url.as_ref().is_some_and(|u| !plain(u, 4096) || !(u.starts_with("http://") || u.starts_with("https://"))) { return Err(INVALID.into()); }
        let input = match (&cwd, &profile) {
            (Some(cwd), Some(profile)) => { validate_context(cwd, "observe", "host-open", Some(profile))?; serde_json::json!({"cwd":cwd,"profile":profile,"url":url}) }
            (None, None) => serde_json::json!({"personal":true,"url":url}),
            _ => return Err(INVALID.into()),
        };
        let bytes = serde_json::to_vec(&input).map_err(|_| FAILED.to_string())?;
        let output = invoke_command(browser_command(&installed_browser_path()?), &["open","--stdin-json"], Some(bytes), OPEN_TIMEOUT, PROBE_LIMIT)?;
        serde_json::from_slice(&output).map_err(|_| INVALID.to_string())
    }).await
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct BrowserEngines { pub trex: bool, pub chrome: bool }
#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct BrowserEngine { pub engine: String, pub engines: BrowserEngines, pub active: Option<String> }

/// Which browser agents get from now on: "auto" (Trex Browser, else Chrome),
/// "trex" or "chrome". Without `engine` it only reads the current choice.
#[tauri::command]
pub async fn trex_browser_engine(engine: Option<String>) -> Result<BrowserEngine, String> {
    crate::blocking(move || {
        let args: Vec<&str> = match engine.as_deref() {
            None => vec!["engine", "--json"],
            Some(value @ ("auto" | "trex" | "chrome")) => vec!["engine", "set", value, "--json"],
            Some(_) => return Err(INVALID.into()),
        };
        let output = invoke_at(&installed_browser_path()?, &args, None, PROBE_TIMEOUT, PROBE_LIMIT)?;
        let result: BrowserEngine = serde_json::from_slice(&output).map_err(|_| INVALID.to_string())?;
        if !["auto", "trex", "chrome"].contains(&result.engine.as_str()) { return Err(INVALID.into()); }
        Ok(result)
    }).await
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct BrowserSaveFolders { pub folders: Vec<String> }

/// Folders (besides each project) where full-mode agents may save their
/// downloads. Only the person adds or removes them, from Trex settings.
#[tauri::command]
pub async fn trex_browser_save_folders(action: Option<String>, folder: Option<String>) -> Result<BrowserSaveFolders, String> {
    crate::blocking(move || {
        let action = action.unwrap_or_else(|| "list".into());
        let browser = installed_browser_path()?;
        let output = match action.as_str() {
            "list" => invoke_at(&browser, &["save-folders", "list", "--json"], None, PROBE_TIMEOUT, PROBE_LIMIT)?,
            "add" | "remove" => {
                let folder = folder.filter(|f| !f.is_empty() && f.len() <= 4096 && !f.chars().any(char::is_control)).ok_or_else(|| INVALID.to_string())?;
                if !std::path::Path::new(&folder).is_absolute() { return Err(INVALID.into()); }
                let bytes = serde_json::to_vec(&serde_json::json!({"folder": folder})).map_err(|_| FAILED.to_string())?;
                invoke_at(&browser, &["save-folders", action.as_str(), "--stdin-json"], Some(bytes), PROBE_TIMEOUT, PROBE_LIMIT)
                    .map_err(|_| "No se puede autorizar esa carpeta. Elige una carpeta concreta (no la carpeta personal completa, la raíz del disco ni carpetas ocultas).".to_string())?
            }
            _ => return Err(INVALID.into()),
        };
        let result: BrowserSaveFolders = serde_json::from_slice(&output).map_err(|_| INVALID.to_string())?;
        if result.folders.len() > 32 || result.folders.iter().any(|f| f.len() > 4096) { return Err(INVALID.into()); }
        Ok(result)
    }).await
}

/// Host-only: raise a space's Trex Browser window, optionally on one tab.
/// Agents never get this; selecting a tab as an agent must not steal focus.
#[tauri::command]
pub async fn trex_browser_focus(cwd: String, profile: String, tab_id: Option<String>) -> Result<BrowserFocus, String> {
    crate::blocking(move || {
        validate_context(&cwd, "observe", "host-focus", Some(&profile))?;
        if tab_id.as_ref().is_some_and(|id| !plain(id, 64) || !id.starts_with("tab-")) { return Err(INVALID.into()); }
        let bytes = serde_json::to_vec(&serde_json::json!({"cwd":cwd,"profile":profile,"tabId":tab_id})).map_err(|_| FAILED.to_string())?;
        let output = invoke_at(&installed_browser_path()?, &["focus","--stdin-json"], Some(bytes), PROBE_TIMEOUT, PROBE_LIMIT)?;
        if output.len() > PROBE_LIMIT { return Err(INVALID.into()); }
        serde_json::from_slice(&output).map_err(|_| INVALID.to_string())
    }).await
}

#[tauri::command]
pub async fn trex_browser_call(request: BrowserCallRequest) -> Result<BrowserCallResult, String> {
    crate::blocking(move || call(request)).await
}

// Artifact opening is an ID-based service operation. No WebView supplied path
// is ever passed to the operating system's opener.
#[tauri::command]
pub async fn trex_browser_open_artifact(id: String, cwd: String, mode: String, client_id: String, profile: Option<String>) -> Result<BrowserCallResult, String> {
    crate::blocking(move || {
        if !opaque(&id, 128) { return Err("El artefacto no es válido.".into()); }
        validate_context(&cwd, &mode, &client_id, profile.as_deref())?;
        let path = installed_browser_path()?;
        let input = serde_json::to_vec(&serde_json::json!({"artifactId":id,"cwd":cwd,"mode":mode,"clientId":client_id,"profile":profile}))
            .map_err(|_| FAILED.to_string())?;
        let mut result = call_result(&invoke_at(&path, &["artifact-open", "--stdin-json"], Some(input), PROBE_TIMEOUT, PROBE_LIMIT)?)?;
        // Settings receives a compact receipt; image bytes are only returned by
        // the explicit tool call path used for model/browser inspection.
        result.content.clear();
        Ok(result)
    }).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn broker_preparation_requires_explicit_ready_and_matching_protocol() {
        assert!(prepared_broker(br#"{"ready":true,"protocolVersion":"2025-11-25"}"#).is_ok());
        for bytes in [br#"{"ready":false,"protocolVersion":"2025-11-25"}"#.as_slice(),br#"{"ready":true,"protocolVersion":"wrong"}"#.as_slice(),br#"{"ready":true}"#.as_slice(),br#"{"error":"private diagnostic"}"#.as_slice()] {
            let error=prepared_broker(bytes).unwrap_err();assert!(!error.contains("private diagnostic"));
        }
    }

    #[test]
    #[cfg(debug_assertions)]
    fn development_fallback_has_no_parent_traversal_components() {
        let directory = development_browser_directory().unwrap();
        assert!(directory.is_absolute());
        assert!(!directory.components().any(|part| matches!(part, std::path::Component::ParentDir)));
        assert!(directory.ends_with("trex-browser/target/debug"));
    }

    #[test]
    fn doctor_is_whitelisted_and_distinguishes_installation_failures() {
        let fixture = |protocol, node, browser| serde_json::to_vec(&serde_json::json!({
            "version":"0.1.0", "protocolVersion":protocol, "runtime":{"node":node,"playwright":true,"token":"private"},
            "browser":{"available":browser,"channel":"chrome","executablePath":"private"},
            "capabilities":{"screenshots":true,"secret":"private"}, "token":"private"
        })).unwrap();
        let ready = doctor_status(&fixture(PROTOCOL, true, true)).unwrap();
        assert!(ready.installed && ready.ready && ready.compatible);
        assert!(!serde_json::to_string(&ready).unwrap().contains("private"));
        assert_eq!(doctor_status(&fixture("future", true, true)).unwrap().error.unwrap().code, "incompatible");
        assert_eq!(doctor_status(&fixture(PROTOCOL, false, true)).unwrap().error.unwrap().code, "missing_runtime");
        assert_eq!(doctor_status(&fixture(PROTOCOL, true, false)).unwrap().error.unwrap().code, "missing_browser");
        assert_eq!(doctor_status(b"secret invalid output").err().unwrap(), INVALID);
    }

    #[test]
    fn bounded_output_drains_and_does_not_return_partial_json() {
        assert_eq!(read_output(std::io::repeat(b'x').take(100), 100).unwrap().len(), 100);
        assert!(read_output(std::io::repeat(b'x').take(101), 100).is_err());
    }

    #[test]
    #[ignore = "subprocess fixture, invoked by bridge_timeout_kills_and_waits_for_a_child_that_never_reads_stdin"]
    fn fixture_blocks_stdin() {
        std::io::stderr().write_all(b"fake-private-diagnostic").unwrap();
        thread::sleep(Duration::from_secs(30));
    }

    #[test]
    fn bridge_timeout_kills_and_waits_for_a_child_that_never_reads_stdin() {
        let started = Instant::now();
        let result = invoke_at(&std::env::current_exe().unwrap(),
            &["--exact", "trex_browser::tests::fixture_blocks_stdin", "--ignored", "--nocapture"],
            Some(vec![b'x'; INPUT_LIMIT]), Duration::from_millis(150), 1024);
        assert_eq!(result.err().unwrap(), FAILED);
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn worker_failures_name_their_cause_in_spanish_and_never_invent_one() {
        let envelope = |code: &str, message: &str| serde_json::to_vec(&serde_json::json!({
            "content":[{"type":"text","text":message}],"isError":true,
            "structuredContent":{"ok":false,"error":{"code":code,"message":message},"receipt":{"status":"rejected"}}
        })).unwrap();
        let reason = |code: &str, message: &str| worker_failure(&envelope(code, message));
        assert!(reason("PROFILE_IN_USE", "anything").contains("otra ventana"));
        // The broker's HTTP reply loses the code: the message still identifies the cause.
        assert!(reason("BROWSER_ERROR", "Close the older separate Trex Browser window before opening this profile in the shared window.").contains("otra ventana"));
        assert!(reason("PROFILE_CLOSING", "x").contains("cerrando"));
        assert!(reason("BROWSER_ERROR", "Trex Browser shell is not installed").contains("Falta la ventana"));
        assert_eq!(reason("BROWSER_ERROR", "Install Google Chrome (or Microsoft Edge) before opening a browser"), NO_BROWSER);
        for timeout in ["Broker startup timed out; inspect private installation/runtime", "Detached broker launch timed out", "The operation was aborted due to timeout"] {
            assert!(reason("BROWSER_ERROR", timeout).contains("no respondió a tiempo"), "{timeout}");
        }
        assert!(reason("BROWSER_ERROR", "No free browser profiles remain in this project; existing profiles are preserved").contains("máximo 98"));
        assert!(reason("BROWSER_ERROR", "Tab not found").contains("pestaña"));
        // Unknown causes are passed through, bounded; unreadable output is the generic sentence.
        assert_eq!(reason("BROWSER_ERROR", "Algo raro"), "Trex Browser indicó: Algo raro");
        assert_eq!(reason("BROWSER_ERROR", &"x".repeat(1000)).chars().count(), "Trex Browser indicó: ".chars().count() + 300);
        assert_eq!(reason("BROWSER_ERROR", ""), FAILED);
        assert_eq!(reason("BROWSER_ERROR", "line\nbreak"), FAILED);
        for bytes in [b"".as_slice(), b"not json".as_slice(), br#"{"engine":"auto"}"#.as_slice()] { assert_eq!(worker_failure(bytes), FAILED); }
        // Without structuredContent the first text block is the message.
        assert!(worker_failure(br#"{"content":[{"type":"text","text":"Tab not found"}],"isError":true}"#).contains("pestaña"));
    }

    #[cfg(unix)]
    #[test]
    fn a_failing_command_reports_the_envelope_on_its_stdout() {
        let run = |script: &str| invoke_command(Command::new("sh"), &["-c", script], None, Duration::from_secs(5), 1024);
        let failing = r#"printf '%s' '{"structuredContent":{"error":{"code":"PROFILE_IN_USE","message":"x"}}}'; exit 1"#;
        assert!(run(failing).unwrap_err().contains("otra ventana"));
        assert_eq!(run("exit 1").unwrap_err(), FAILED);
        assert_eq!(run("printf ok").unwrap(), b"ok");
    }

    #[test]
    fn call_context_rejects_policy_override_and_non_object_arguments() {
        let cwd = std::env::current_dir().unwrap().to_string_lossy().into_owned();
        for arguments in [serde_json::json!({"mode":"full"}), serde_json::json!({"cwd":"other"}), serde_json::json!([])] {
            let request = BrowserCallRequest { name: "browser_snapshot".into(), arguments,
                cwd: cwd.clone(), mode: "observe".into(), client_id: "test-client".into(), profile: Some("BROWSER1".into()),
                operation_id: None, timeout_ms: Some(1000) };
            assert!(validate_request(&request).is_err());
        }
        assert!(validate_context(&cwd, "full", "client", Some("BROWSER1")).is_ok());
        assert!(validate_context(&cwd, "full", "client", Some("BROWSER0")).is_err());
        assert!(validate_context(&cwd, "auto", "client", None).is_err());
        assert!(validate_context("relative", "observe", "client", None).is_err());
    }

    #[test]
    fn mcp_result_preserves_typed_content_and_rejects_unknown_executable_content() {
        let result = call_result(br#"{"content":[{"type":"text","text":"ok","token":"ignored"}],"structuredContent":{"artifacts":[]},"isError":false,"token":"ignored"}"#).unwrap();
        assert!(!serde_json::to_string(&result).unwrap().contains("ignored"));
        assert!(call_result(br#"{"content":[{"type":"resource_link","uri":"file:///evil.exe"}]}"#).is_err());
        assert!(call_result(br#"{"content":[{"type":"image","data":"invalid","mimeType":"image/png"}]}"#).is_err());
    }

    #[test]
    fn one_mib_network_body_accepts_the_complete_core_result_wrapper() {
        let body = "x".repeat(1024 * 1024);
        let structured = serde_json::json!({
            "ok":true,"operationId":"op","projectId":"project1","profile":"BROWSER1",
            "generation":1,"revision":1,
            "data":{"body":body,"bytes":1024 * 1024,"untrustedContent":true},
            "artifacts":[],"receipt":{"status":"completed","manualReview":false,"replaySafe":false}
        });
        // The core repeats structuredContent as a JSON text block. Its 1 MiB
        // body is valid even though that text block needs another 249 bytes.
        let text = serde_json::to_string(&structured).unwrap();
        assert_eq!(text.len(), 1_048_825);
        let wire = serde_json::to_vec(&serde_json::json!({
            "content":[{"type":"text","text":text}],"structuredContent":structured
        })).unwrap();
        assert!(wire.len() < OUTPUT_LIMIT);
        let result = call_result(&wire).unwrap();
        assert!(!result.is_error);
        assert_eq!(result.structured_content.as_ref().unwrap()["data"]["body"].as_str().unwrap().len(), 1024 * 1024);
        assert!(matches!(&result.content[0], BrowserContent::Text { text } if text.len() == 1_048_825));
    }

    #[test]
    fn whole_response_cap_is_inclusive_and_rejects_even_extra_json_whitespace() {
        let envelope = |text: String| serde_json::to_vec(&serde_json::json!({
            "content":[{"type":"text","text":text}]
        })).unwrap();
        let overhead = envelope(String::new()).len();
        let mut wire = envelope("x".repeat(OUTPUT_LIMIT - overhead));
        assert_eq!(wire.len(), OUTPUT_LIMIT);
        assert!(call_result(&wire).is_ok());
        wire.push(b' ');
        assert_eq!(call_result(&wire).err().unwrap(), INVALID);
        assert!(read_output(wire.as_slice(), OUTPUT_LIMIT).is_err());
    }

    #[test]
    #[ignore = "requires TREX_TEST_BROWSER pointing to the assembled real launcher/runtime; doctor only"]
    fn packaged_doctor_roundtrip_uses_an_isolated_private_home() {
        let binary = PathBuf::from(std::env::var_os("TREX_TEST_BROWSER").expect("set TREX_TEST_BROWSER"));
        assert!(binary.is_absolute() && binary.is_file() && ordinary_path(&binary));
        let home = std::env::temp_dir().join(format!("trex-browser-bridge-test-{}-{}",
            std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        assert!(!home.exists());
        struct Cleanup(PathBuf);
        impl Drop for Cleanup {
            fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); }
        }
        let _cleanup = Cleanup(home.clone());
        let mut command = browser_command(&binary);
        command.env("TREX_BROWSER_HOME", &home).env("APPDATA", home.join("roaming"))
            .env("LOCALAPPDATA", home.join("local"));
        let status = doctor_status(&invoke_command(command, &["doctor", "--json"], None, PROBE_TIMEOUT, PROBE_LIMIT).unwrap()).unwrap();
        assert!(status.installed && status.compatible);
        assert_eq!(status.protocol_version.as_deref(), Some(PROTOCOL));
        assert!(!home.join("broker.token").exists(), "doctor must not start a broker");
        assert!(!home.join("projects").exists(), "doctor must not create browser profiles");
    }

    #[cfg(target_os = "linux")]
    #[test]
    #[ignore = "requires the built RPM installed in an isolated Fedora test system"]
    fn installed_linux_rpm_runtime_passes_app_preflight() {
        let status = probe_status(Path::new("/usr/bin/trex-browser")).unwrap();
        assert!(status.installed && status.compatible);
        assert_eq!(status.protocol_version.as_deref(), Some(PROTOCOL));
        assert!(status.error.as_ref().is_none_or(|error| error.code == "missing_browser"));
    }

    #[test]
    fn project_space_inventory_is_bounded_and_keeps_legacy_and_allocated_profiles_distinct() {
        let cwd=std::env::temp_dir().to_string_lossy().into_owned();
        let first=serde_json::json!({"clientId":"same-client","label":"Manual","profile":"BROWSER1","running":true,"paused":false,"active":true,"tabCount":1,"currentTool":"browser_snapshot","url":"http://127.0.0.1:5176/vender"});
        let mut second=first.clone();second["profile"]=serde_json::json!("BROWSER2");second["label"]=serde_json::json!("Codex");
        let decode=|spaces:Value|space_inventory(&serde_json::to_vec(&serde_json::json!({"spaces":spaces})).unwrap(),&cwd);
        assert_eq!(decode(serde_json::json!([first,second])).unwrap().spaces.len(),2);
        assert!(decode(serde_json::json!([first,first])).is_err());
        for (field,value) in [("currentTool",serde_json::json!("shell")),("profile",serde_json::json!("../other")),("url",serde_json::json!("http://localhost/\ninvalid")),("tabCount",serde_json::json!(-1))] {
            let mut invalid=first.clone();invalid[field]=value;assert!(decode(serde_json::json!([invalid])).is_err());
        }
        assert!(decode(serde_json::json!(vec![first;100])).is_err());
        assert!(space_inventory(&vec![b' ';PROBE_LIMIT+1],&cwd).is_err());
    }

    #[test]
    fn project_space_inventory_accepts_shared_window_usage_and_legacy_companions() {
        let cwd=std::env::temp_dir().to_string_lossy().into_owned();
        let space=serde_json::json!({"clientId":"agent","label":"Codex","profile":"BROWSER2","running":false,"inUse":true,"paused":false,"active":false,"tabCount":0,"currentTool":null,"url":""});
        let decode=|space:Value|space_inventory(&serde_json::to_vec(&serde_json::json!({"spaces":[space]})).unwrap(),&cwd);
        let result=decode(space.clone()).expect("the companion's inUse field must be accepted");
        assert!(result.spaces[0].in_use);
        assert!(!result.spaces[0].running, "a shared window can retain a loaded profile after its automation closes");
        assert_eq!(serde_json::to_value(result).unwrap()["spaces"][0]["inUse"],true);
        let mut legacy=space.clone();legacy.as_object_mut().unwrap().remove("inUse");
        assert!(!decode(legacy).unwrap().spaces[0].in_use);
        for (field,value) in [("inUse",serde_json::json!("true")),("inUse",Value::Null),("unexpected",serde_json::json!(true))] {
            let mut invalid=space.clone();invalid[field]=value;assert!(decode(invalid).is_err());
        }
    }

    #[test]
    #[ignore = "requires TREX_TEST_BROWSER; run the compiled test directly on Windows, outside Cargo's restrictive job"]
    fn packaged_space_inventory_cold_start_uses_the_real_companion_contract() {
        let binary=PathBuf::from(std::env::var_os("TREX_TEST_BROWSER").expect("set TREX_TEST_BROWSER"));
        assert!(binary.is_absolute() && binary.is_file() && ordinary_path(&binary));
        let home=std::env::temp_dir().join(format!("trex-browser-inventory-test-{}-{}",std::process::id(),std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        assert!(!home.exists());
        struct Cleanup { home: PathBuf, binary: PathBuf }
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let mut command=browser_command(&self.binary);command.env("TREX_BROWSER_HOME",&self.home);
                let _=invoke_command(command,&["stop"],None,Duration::from_secs(20),PROBE_LIMIT);
                let deadline=Instant::now()+Duration::from_secs(5);
                while self.home.join("broker.json").exists() && Instant::now()<deadline { thread::sleep(Duration::from_millis(20)); }
                let _=std::fs::remove_dir_all(&self.home);
            }
        }
        let _cleanup=Cleanup { home:home.clone(),binary:binary.clone() };
        let run=|args:&[&str],input:Option<Vec<u8>>| {
            let mut command=browser_command(&binary);
            command.env("TREX_BROWSER_HOME",&home).env("APPDATA",home.join("roaming")).env("LOCALAPPDATA",home.join("local"));
            invoke_command(command,args,input,Duration::from_secs(30),PROBE_LIMIT).unwrap()
        };
        let cwd=std::env::temp_dir().to_string_lossy().into_owned();
        let empty=run(&["spaces","list","--cwd",&cwd,"--json"],None);
        assert!(space_inventory(&empty,&cwd).unwrap().spaces.is_empty());
        assert!(home.join("broker.json").is_file(),"the first query must start the broker without a manual window");
        let members=serde_json::to_vec(&serde_json::json!({"cwd":cwd,"members":[{"clientId":"inventory-test","label":"Codex"}]})).unwrap();
        let allocated:BrowserSpaces=serde_json::from_slice(&run(&["spaces","--stdin-json"],Some(members))).unwrap();
        assert_eq!(allocated.spaces.len(),1);
        let inventory=run(&["spaces","list","--cwd",&cwd,"--json"],None);
        let wire:Value=serde_json::from_slice(&inventory).unwrap();
        assert!(wire["spaces"][0]["inUse"].is_boolean(),"exercise the companion output instead of a handwritten fixture");
        let result=space_inventory(&inventory,&cwd).expect("the app must accept real nonempty inventory");
        assert!(result.spaces.iter().any(|space|space.client_id=="inventory-test" && space.profile==allocated.spaces[0].profile));
        assert!(result.spaces.iter().all(|space|!space.running && !space.in_use));
    }
}
