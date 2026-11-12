//! Live Blender: lets an agent see and drive a Blender the user has open, through a
//! bridge add-on that Trex ships (`assets/blender/trex_bridge.py`).
//!
//! The add-on listens on `127.0.0.1` (ephemeral port, random token) and publishes both in
//! a per-user file; this module reads that file, speaks one JSON line per message and turns
//! the answers into tool results, including images the model can look at.
use crate::tools::{ToolFuture, ToolProvider};
use anyhow::{anyhow, bail, ensure, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Map, Value};
use std::{
    path::{Path, PathBuf},
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt, BufReader},
    net::TcpStream,
};
use tokio_util::sync::CancellationToken;

/// The add-on, embedded so a machine needs nothing but Trex and Blender.
pub const BRIDGE_PY: &str = include_str!("../assets/blender/trex_bridge.py");
const PROTOCOL: u64 = 1;
const MAX_RESPONSE: u64 = 64 * 1024 * 1024;
const READ: &[&str] = &["blender_scene", "blender_view", "blender_render"];

/// The bridge was reached, the request may have been applied, and the answer never came.
#[derive(Debug)]
pub struct BlenderLiveUncertain;
impl std::fmt::Display for BlenderLiveUncertain {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("The Blender session stopped answering; the change may or may not have been applied. Call blender_scene to inspect the scene before continuing, and do not repeat the operation automatically.")
    }
}
impl std::error::Error for BlenderLiveUncertain {}

// ----------------------------------------------------------------------------- sessions
/// Where the add-on publishes one JSON file per running Blender (mirrors `bridge_dir()` in the add-on).
pub fn bridge_dir() -> Option<PathBuf> {
    if let Some(explicit) = std::env::var_os("TREX_BRIDGE_DIR").map(PathBuf::from).filter(|p| p.is_absolute()) {
        return Some(explicit);
    }
    let home = dirs::home_dir()?;
    if cfg!(windows) {
        let base = std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .filter(|p| p.is_absolute())
            .unwrap_or_else(|| home.join("AppData").join("Local"));
        Some(base.join("Trex").join("blender-bridge"))
    } else if cfg!(target_os = "macos") {
        Some(home.join("Library/Application Support/Trex/blender-bridge"))
    } else {
        let base = std::env::var_os("XDG_STATE_HOME")
            .map(PathBuf::from)
            .filter(|p| p.is_absolute())
            .unwrap_or_else(|| home.join(".local/state"));
        Some(base.join("trex/blender-bridge"))
    }
}

#[derive(Clone)]
pub struct Session {
    pub pid: u64,
    pub port: u16,
    token: String,
    pub blender: String,
    pub started: f64,
    file: PathBuf,
}
impl std::fmt::Debug for Session {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // The token is a credential: it never appears in logs or error chains.
        f.debug_struct("Session").field("pid", &self.pid).field("port", &self.port).field("blender", &self.blender).finish()
    }
}

fn parse_session(file: &Path, text: &str) -> Option<Session> {
    let value: Value = serde_json::from_str(text).ok()?;
    if value["protocol"].as_u64()? != PROTOCOL {
        return None;
    }
    Some(Session {
        pid: value["pid"].as_u64()?,
        port: u16::try_from(value["port"].as_u64()?).ok()?,
        token: value["token"].as_str().filter(|t| !t.is_empty())?.to_owned(),
        blender: value["blender"].as_str().unwrap_or("").to_owned(),
        started: value["started"].as_f64().unwrap_or(0.0),
        file: file.to_owned(),
    })
}

/// Published sessions, newest first. Files for Blenders that exited are filtered later by connecting.
pub fn read_sessions(dir: &Path) -> Vec<Session> {
    let mut sessions: Vec<Session> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "json"))
        .filter_map(|entry| {
            let text = std::fs::read_to_string(entry.path()).ok()?;
            parse_session(&entry.path(), &text)
        })
        .collect();
    sessions.sort_by(|a, b| b.started.partial_cmp(&a.started).unwrap_or(std::cmp::Ordering::Equal));
    sessions
}

// ----------------------------------------------------------------------------- wire
/// How a bridge call failed; only `Interrupted` leaves the outcome unknown.
#[derive(Debug)]
enum Failure {
    /// Nothing reached Blender (no listener, refused, bad token): safe to retry.
    Unreachable(String),
    /// Blender received the request and then went silent or the call was cancelled.
    Interrupted,
    /// Blender answered with an error.
    Remote(String),
    Protocol(String),
}
impl std::fmt::Display for Failure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Failure::Unreachable(why) => write!(f, "Could not reach Blender: {why}"),
            Failure::Interrupted => f.write_str("The Blender request was interrupted before an answer arrived"),
            Failure::Remote(message) => f.write_str(message),
            Failure::Protocol(why) => write!(f, "Unexpected answer from the Blender bridge: {why}"),
        }
    }
}
impl std::error::Error for Failure {}

async fn call(session: &Session, op: &str, params: Value, timeout: Duration, cancel: &CancellationToken) -> std::result::Result<Value, Failure> {
    let connect = tokio::time::timeout(Duration::from_secs(3), TcpStream::connect(("127.0.0.1", session.port)));
    let mut stream = match connect.await {
        Ok(Ok(stream)) => stream,
        Ok(Err(error)) => return Err(Failure::Unreachable(error.to_string())),
        Err(_) => return Err(Failure::Unreachable("connection timed out".into())),
    };
    let mut request = match params {
        Value::Object(map) => map,
        _ => Map::new(),
    };
    request.insert("v".into(), json!(PROTOCOL));
    request.insert("id".into(), json!(uuid::Uuid::new_v4().to_string()));
    request.insert("token".into(), json!(session.token));
    request.insert("op".into(), json!(op));
    request.insert("timeout".into(), json!(timeout.as_secs_f64()));
    let mut line = serde_json::to_vec(&Value::Object(request)).map_err(|e| Failure::Protocol(e.to_string()))?;
    line.push(b'\n');
    if let Err(error) = stream.write_all(&line).await {
        return Err(Failure::Unreachable(error.to_string()));
    }
    let wait = async {
        let mut reader = BufReader::new(stream).take(MAX_RESPONSE);
        let mut answer = Vec::new();
        let mut buffer = [0u8; 65536];
        loop {
            let n = reader.read(&mut buffer).await.map_err(|_| Failure::Interrupted)?;
            if n == 0 {
                break;
            }
            answer.extend_from_slice(&buffer[..n]);
            if answer.ends_with(b"\n") {
                break;
            }
        }
        if answer.is_empty() {
            return Err(Failure::Interrupted);
        }
        Ok(answer)
    };
    // A little slack over the add-on's own limit, so its message wins over ours.
    let answer = tokio::select! {
        biased;
        _ = cancel.cancelled() => return Err(Failure::Interrupted),
        outcome = tokio::time::timeout(timeout + Duration::from_secs(5), wait) => match outcome {
            Ok(result) => result?,
            Err(_) => return Err(Failure::Interrupted),
        },
    };
    let value: Value = serde_json::from_slice(&answer).map_err(|e| Failure::Protocol(e.to_string()))?;
    if value["ok"] == true {
        Ok(value["result"].clone())
    } else {
        Err(Failure::Remote(value["error"].as_str().unwrap_or("Blender reported an error").to_owned()))
    }
}

/// The session to talk to: the requested pid, or the newest Blender that answers.
async fn pick(dir: &Path, wanted: Option<u64>, cancel: &CancellationToken) -> Result<(Session, Value)> {
    let mut sessions = read_sessions(dir);
    if let Some(pid) = wanted {
        sessions.retain(|s| s.pid == pid);
    }
    for session in sessions {
        match call(&session, "hello", json!({}), Duration::from_secs(5), cancel).await {
            Ok(hello) => return Ok((session, hello)),
            Err(Failure::Unreachable(_)) => {
                // Blender exited without cleaning up: forget its file (best effort).
                let _ = std::fs::remove_file(&session.file);
            }
            Err(_) => {}
        }
    }
    bail!("No Blender with the Trex bridge is running. Call blender_open to start one (the user will see it on screen), or ask the user to open Blender after enabling the Trex Bridge add-on.")
}

// ----------------------------------------------------------------------------- launching
/// Write the add-on where Blender can read it and return its path. Rewritten when the
/// embedded copy changes, so upgrading Trex upgrades the bridge.
pub fn data_dir() -> Result<PathBuf> {
    let dir = dirs::data_local_dir().context("no per-user data directory")?.join("trex").join("blender");
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}
pub fn install_bridge_file() -> Result<PathBuf> {
    let dir = data_dir()?;
    let path = dir.join("trex_bridge.py");
    if std::fs::read_to_string(&path).map(|existing| existing != BRIDGE_PY).unwrap_or(true) {
        std::fs::write(&path, BRIDGE_PY)?;
    }
    Ok(path)
}

fn spawn_blender(install: &crate::blender::Install, bridge: &Path, file: Option<&Path>) -> Result<()> {
    let mut command = std::process::Command::new(install.program());
    command.args(install.prefix());
    if let Some(file) = file {
        command.arg(file);
    }
    command.arg("--python").arg(bridge);
    command.stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0); // outlives this process: the user keeps their Blender
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0000_0008 | 0x0000_0200); // DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
    }
    command.spawn().context("could not start Blender")?;
    Ok(())
}

pub struct Opened {
    pub session: Session,
    pub hello: Value,
    pub already_running: bool,
}
/// The running bridge session, or a new Blender started with the bridge (which the user can watch).
pub async fn open_session(dir: &Path, file: Option<&Path>, cancel: &CancellationToken) -> Result<Opened> {
    if let Ok((session, hello)) = pick(dir, None, cancel).await {
        return Ok(Opened { session, hello, already_running: true });
    }
    let install = crate::blender::locate().context("Blender not found; install it from https://www.blender.org/download/")?;
    let bridge = install_bridge_file()?;
    spawn_blender(&install, &bridge, file)?;
    let deadline = Instant::now() + Duration::from_secs(90);
    loop {
        ensure!(!cancel.is_cancelled(), "cancelled while Blender was starting");
        if let Ok((session, hello)) = pick(dir, None, cancel).await {
            return Ok(Opened { session, hello, already_running: false });
        }
        ensure!(Instant::now() < deadline, "Blender was started but the Trex bridge did not come up within 90 seconds. Ask the user whether Blender is showing a dialog.");
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
}

/// Every Blender that answers on the bridge, newest first (files of Blenders that exited are removed).
pub async fn live_sessions(dir: &Path, cancel: &CancellationToken) -> Vec<Value> {
    let mut out = Vec::new();
    for session in read_sessions(dir) {
        match call(&session, "hello", json!({}), Duration::from_secs(3), cancel).await {
            Ok(hello) => out.push(json!({
                "pid": session.pid, "version": hello["blender"]["version"], "file": hello["blender"]["file"],
                "dirty": hello["blender"]["dirty"], "paused": hello["paused"], "started": session.started,
            })),
            Err(Failure::Unreachable(_)) => {
                let _ = std::fs::remove_file(&session.file);
            }
            Err(_) => {}
        }
    }
    out
}

// ----------------------------------------------------------------------------- results
fn text(value: impl Into<String>) -> Value {
    json!({"type": "text", "text": value.into()})
}
fn image(png_base64: &str) -> Value {
    json!({"type": "image", "mimeType": "image/png", "data": png_base64})
}
fn done(content: Vec<Value>, structured: Value, is_error: bool) -> Value {
    json!({"content": content, "structuredContent": structured, "isError": is_error})
}
fn allowed(input: &Value, keys: &[&str]) -> Result<Map<String, Value>> {
    let map = input.as_object().context("expected an object")?;
    ensure!(map.keys().all(|key| keys.contains(&key.as_str())), "unknown field; allowed: {}", keys.join(", "));
    Ok(map.clone())
}
fn session_pid(map: &Map<String, Value>) -> Result<Option<u64>> {
    match map.get("session") {
        None | Some(Value::Null) => Ok(None),
        Some(value) => value.as_u64().map(Some).context("session must be a Blender process id from blender_open or blender_scene"),
    }
}
fn bounded(map: &Map<String, Value>, key: &str, min: u64, max: u64) -> Result<Option<u64>> {
    match map.get(key) {
        None => Ok(None),
        Some(value) => {
            let n = value.as_u64().with_context(|| format!("{key} must be an integer"))?;
            ensure!((min..=max).contains(&n), "{key} must be between {min} and {max}");
            Ok(Some(n))
        }
    }
}
fn one_of(map: &Map<String, Value>, key: &str, options: &[&str]) -> Result<Option<String>> {
    match map.get(key) {
        None => Ok(None),
        Some(value) => {
            let s = value.as_str().with_context(|| format!("{key} must be text"))?;
            ensure!(options.contains(&s), "{key} must be one of: {}", options.join(", "));
            Ok(Some(s.to_owned()))
        }
    }
}
fn names(map: &Map<String, Value>, key: &str) -> Result<Option<Value>> {
    match map.get(key) {
        None => Ok(None),
        Some(Value::String(s)) if matches!(s.as_str(), "scene" | "selected") => Ok(Some(json!(s))),
        Some(Value::Array(items)) => {
            ensure!(items.len() <= 100 && items.iter().all(|v| v.as_str().is_some_and(|s| !s.is_empty() && s.len() <= 256)), "focus must list at most 100 object names");
            Ok(Some(Value::Array(items.clone())))
        }
        _ => bail!("focus must be \"scene\", \"selected\" or a list of object names"),
    }
}

const VIEWS: &[&str] = &["iso", "iso_back", "front", "back", "right", "left", "top", "bottom", "camera", "sheet", "window"];
const SHADINGS: &[&str] = &["WIREFRAME", "SOLID", "MATERIAL", "RENDERED"];

/// The first image of a bridge answer, with its size and the answer minus the pixels.
fn take_png(mut result: Value) -> Result<(String, Value)> {
    let png = result
        .as_object_mut()
        .and_then(|map| map.remove("png"))
        .and_then(|v| v.as_str().map(str::to_owned))
        .context("the bridge returned no image")?;
    ensure!(STANDARD.decode(&png).is_ok_and(|bytes| bytes.starts_with(b"\x89PNG")), "the bridge returned an invalid image");
    Ok((png, result))
}

// ----------------------------------------------------------------------------- provider
pub struct BlenderLiveProvider {
    dir: Option<PathBuf>,
}
impl Default for BlenderLiveProvider {
    fn default() -> Self {
        Self { dir: bridge_dir() }
    }
}
impl BlenderLiveProvider {
    /// A provider reading sessions from an explicit directory (tests).
    pub fn with_dir(dir: PathBuf) -> Self {
        Self { dir: Some(dir) }
    }
    fn dir(&self) -> Result<&Path> {
        self.dir.as_deref().context("no per-user state directory for the Blender bridge")
    }

    async fn open(&self, cwd: &Path, input: &Value, cancel: &CancellationToken) -> Result<Value> {
        let map = allowed(input, &["file"])?;
        let file = map
            .get("file")
            .map(|v| crate::blender::workspace_file(cwd, v.as_str().context("file must be text")?, "blend"))
            .transpose()?;
        let opened = open_session(self.dir()?, file.as_deref(), cancel).await?;
        let (session, hello) = (opened.session, opened.hello);
        let message = if opened.already_running {
            format!("Blender {} is already running with the Trex bridge (session {}). Use blender_scene to see it.", session.blender, session.pid)
        } else {
            format!("Blender {} started with the Trex bridge (session {}). The user can watch it live.", session.blender, session.pid)
        };
        Ok(done(vec![text(message)], json!({"session": session.pid, "alreadyRunning": opened.already_running, "hello": hello}), false))
    }

    async fn scene(&self, input: &Value, cancel: &CancellationToken) -> Result<Value> {
        let map = allowed(input, &["level", "name", "offset", "limit", "type", "match", "session"])?;
        let level = one_of(&map, "level", &["overview", "objects", "object", "datablocks"])?.unwrap_or_else(|| "overview".into());
        ensure!(level != "object" || map.get("name").and_then(Value::as_str).is_some_and(|n| !n.is_empty()), "level=object needs name");
        let mut params = json!({"level": level});
        for key in ["name", "type", "match"] {
            if let Some(value) = map.get(key) {
                ensure!(value.as_str().is_some_and(|s| s.len() <= 256), "{key} must be short text");
                params[key] = value.clone();
            }
        }
        if let Some(offset) = bounded(&map, "offset", 0, 1_000_000)? {
            params["offset"] = json!(offset);
        }
        if let Some(limit) = bounded(&map, "limit", 1, 200)? {
            params["limit"] = json!(limit);
        }
        let (session, _) = pick(self.dir()?, session_pid(&map)?, cancel).await?;
        let result = call(&session, "scene", params, Duration::from_secs(30), cancel).await.map_err(|e| anyhow!(e))?;
        Ok(done(vec![text(serde_json::to_string(&result)?)], json!({"session": session.pid, "scene": result}), false))
    }

    fn view_params(map: &Map<String, Value>) -> Result<Value> {
        let view = one_of(map, "view", VIEWS)?.unwrap_or_else(|| "iso".into());
        let mut params = json!({"view": view});
        if let Some(width) = bounded(map, "width", 64, 4096)? {
            params["width"] = json!(width);
        }
        if let Some(height) = bounded(map, "height", 64, 4096)? {
            params["height"] = json!(height);
        }
        if let Some(shading) = one_of(map, "shading", SHADINGS)? {
            params["shading"] = json!(shading);
        }
        if let Some(overlays) = map.get("overlays") {
            ensure!(overlays.is_boolean(), "overlays must be true or false");
            params["overlays"] = overlays.clone();
        }
        if let Some(focus) = names(map, "focus")? {
            params["focus"] = focus;
        }
        if let Some(fov) = map.get("fov") {
            let fov = fov.as_f64().context("fov must be a number")?;
            ensure!((10.0..=120.0).contains(&fov), "fov must be between 10 and 120 degrees");
            params["fov"] = json!(fov);
        }
        for key in ["eye", "target"] {
            if let Some(point) = map.get(key) {
                let ok = point.as_array().is_some_and(|a| a.len() == 3 && a.iter().all(|n| n.as_f64().is_some_and(f64::is_finite)));
                ensure!(ok, "{key} must be three numbers [x, y, z]");
                params[key] = point.clone();
            }
        }
        ensure!(params.get("eye").is_some() == params.get("target").is_some(), "eye and target go together");
        if let Some(area) = map.get("area") {
            ensure!(area.as_str().is_some_and(|s| s.len() <= 32), "area must be short text such as VIEWPORT, SHADER, TIMELINE or WINDOW");
            params["area"] = area.clone();
        }
        Ok(params)
    }

    async fn view(&self, input: &Value, cancel: &CancellationToken) -> Result<Value> {
        let map = allowed(input, &["view", "focus", "width", "height", "shading", "overlays", "fov", "eye", "target", "area", "session"])?;
        let params = Self::view_params(&map)?;
        let (session, _) = pick(self.dir()?, session_pid(&map)?, cancel).await?;
        let result = call(&session, "view", params.clone(), Duration::from_secs(90), cancel).await.map_err(|e| anyhow!(e))?;
        let (png, meta) = take_png(result)?;
        let how = if params["view"] == "window" {
            "Exactly what the user sees on screen."
        } else {
            "Drawn from a virtual camera: the user's own viewport is untouched."
        };
        let summary = format!("Blender view {} ({}x{}). {}", params["view"].as_str().unwrap_or("iso"), meta["width"], meta["height"], meta["note"].as_str().unwrap_or(how));
        Ok(done(vec![text(summary), image(&png)], json!({"session": session.pid, "view": meta}), false))
    }

    async fn render(&self, input: &Value, cancel: &CancellationToken) -> Result<Value> {
        let map = allowed(input, &["width", "height", "engine", "samples", "frame", "session"])?;
        let mut params = json!({});
        for key in ["width", "height"] {
            if let Some(n) = bounded(&map, key, 64, 4096)? {
                params[key] = json!(n);
            }
        }
        if let Some(n) = bounded(&map, "samples", 1, 4096)? {
            params["samples"] = json!(n);
        }
        if let Some(n) = bounded(&map, "frame", 0, 1_000_000)? {
            params["frame"] = json!(n);
        }
        if let Some(engine) = one_of(&map, "engine", &["BLENDER_EEVEE", "BLENDER_EEVEE_NEXT", "BLENDER_WORKBENCH", "CYCLES"])? {
            params["engine"] = json!(engine);
        }
        let (session, _) = pick(self.dir()?, session_pid(&map)?, cancel).await?;
        let result = call(&session, "render", params, Duration::from_secs(600), cancel).await.map_err(|e| anyhow!(e))?;
        let (png, meta) = take_png(result)?;
        let summary = format!("Blender render {}x{} in {} s. Scene settings were restored.", meta["width"], meta["height"], meta["seconds"]);
        Ok(done(vec![text(summary), image(&png)], json!({"session": session.pid, "render": meta}), false))
    }

    async fn undo(&self, input: &Value, cancel: &CancellationToken) -> Result<Value> {
        let map = allowed(input, &["steps", "session"])?;
        let steps = bounded(&map, "steps", 1, 20)?.unwrap_or(1);
        let (session, _) = pick(self.dir()?, session_pid(&map)?, cancel).await?;
        let result = call(&session, "undo", json!({"steps": steps}), Duration::from_secs(60), cancel).await.map_err(uncertain)?;
        Ok(done(vec![text(format!("Undid {} step(s) in Blender.", result["undone"]))], json!({"session": session.pid, "undo": result}), false))
    }

    async fn exec(&self, input: &Value, cancel: &CancellationToken) -> Result<Value> {
        let map = allowed(input, &["code", "verify", "shading", "width", "height", "timeoutMs", "session"])?;
        let code = map.get("code").and_then(Value::as_str).context("code is required")?;
        ensure!(!code.trim().is_empty() && code.len() <= 1024 * 1024 && !code.contains('\0'), "code must be non-empty Python under 1 MiB");
        let verify = match map.get("verify") {
            None => "auto".to_owned(),
            Some(v) => {
                let v = v.as_str().context("verify must be text")?;
                ensure!(v == "auto" || v == "none" || VIEWS.contains(&v) && v != "window", "verify must be auto, none or a view preset");
                v.to_owned()
            }
        };
        let timeout = Duration::from_millis(bounded(&map, "timeoutMs", 1000, 600_000)?.unwrap_or(120_000));
        let (session, _) = pick(self.dir()?, session_pid(&map)?, cancel).await?;
        let result = call(&session, "exec", json!({"code": code}), timeout, cancel).await.map_err(uncertain)?;
        let ok = result["ok"] == true;
        let changes = &result["changes"];
        let listed = |key: &str| -> Vec<String> { changes[key].as_array().map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_owned)).collect()).unwrap_or_default() };
        let (added, removed, changed) = (listed("added"), listed("removed"), listed("changed"));
        let mut report = if ok {
            format!("Python ran OK in {} s.", result["seconds"])
        } else {
            "Python raised an error. Blender may be partly modified: inspect with blender_scene or step back with blender_undo.".to_owned()
        };
        let describe = |label: &str, items: &[String]| if items.is_empty() { String::new() } else { format!(" {label}: {}.", items.join(", ")) };
        report += &describe("Added", &added);
        report += &describe("Changed", &changed);
        report += &describe("Removed", &removed);
        if added.is_empty() && changed.is_empty() && removed.is_empty() {
            report += " No object changes detected.";
        }
        if let Some(output) = result["output"].as_str().filter(|o| !o.trim().is_empty()) {
            report += &format!("\nOutput:\n{output}");
        }
        if !result["result"].is_null() {
            report += &format!("\nResult: {}", result["result"]);
        }
        if let Some(error) = result["error"].as_str() {
            report += &format!("\n{error}");
        }
        let mut content = vec![text(report)];
        let mut structured = json!({"session": session.pid, "ok": ok, "changes": changes, "seconds": result["seconds"]});
        // Show the model what it just did: a quick look at what changed, or the whole scene.
        let should_look = verify != "none" && (!added.is_empty() || !changed.is_empty() || !removed.is_empty() || verify != "auto");
        if should_look {
            let focus: Vec<&String> = added.iter().chain(changed.iter()).take(30).collect();
            // By default the four-angle sheet: one image shows contact with the floor, overlaps and
            // proportions that a single isometric view hides (a model that only saw iso still reported front/top).
            let preset = if verify == "auto" { "sheet" } else { verify.as_str() };
            let (default_width, default_height) = if preset == "sheet" { (1024, 576) } else { (768, 432) };
            // MATERIAL by default: SOLID ignores shader colours, so a correct material would look unchanged.
            let shading = one_of(&map, "shading", SHADINGS)?.unwrap_or_else(|| "MATERIAL".into());
            let mut view = json!({"view": preset, "shading": shading, "width": map.get("width").cloned().unwrap_or(json!(default_width)), "height": map.get("height").cloned().unwrap_or(json!(default_height))});
            if !focus.is_empty() {
                view["focus"] = json!(focus);
            }
            match call(&session, "view", view, Duration::from_secs(90), cancel).await.map_err(|e| anyhow!(e)).and_then(take_png) {
                Ok((png, meta)) => {
                    let what = meta["note"].as_str().map(|note| format!(" {note}.")).unwrap_or_default();
                    content.push(text(format!("Verification view ({preset}, {}x{}) of the result:{what} Check it before the next step; only claim the views you can see here.", meta["width"], meta["height"])));
                    content.push(image(&png));
                    structured["verification"] = meta;
                }
                Err(error) => content.push(text(format!("(Verification view unavailable: {error}. Call blender_view.)"))),
            }
        }
        Ok(done(content, structured, !ok))
    }
}

/// A call that may change Blender: losing the answer means "unknown", never "retry".
fn uncertain(failure: Failure) -> anyhow::Error {
    match failure {
        Failure::Interrupted => BlenderLiveUncertain.into(),
        other => anyhow!(other),
    }
}

pub fn read_only(name: &str) -> bool {
    READ.contains(&name)
}

/// How to work in a live Blender, shared by the MCP server instructions and Trex CLI.
pub fn guidance(read_only: bool) -> String {
    const LOOKING: &str = "Look with blender_view: iso, front, right, top, camera, or sheet (four angles in one image); shading MATERIAL judges materials and lighting, WIREFRAME shows topology; view=window shows what the user actually sees (any editor, e.g. area SHADER). The default frames the whole scene, so a small object looks tiny: pass focus with its names to inspect it, or eye and target for any angle.";
    if read_only {
        return format!("Live Blender (read-only session): blender_scene, blender_view and blender_render show a Blender the user has open and watches in real time. Start with blender_scene (overview) to learn what is there, then look. {LOOKING} blender_render gives the real render. Nothing can be changed or opened from here; if no Blender is running, say so.");
    }
    format!("Live Blender: a Blender the user has open and watches in real time. Changes follow the host agent's permission policy. Start with blender_scene (overview) to learn what is there; if no session is running, call blender_open. {LOOKING} blender_exec runs Python (bpy) inside the live session, keeps variables between calls, sets `result` to return data, and answers with what changed plus a four-angle verification sheet (iso, front, right, top): read it and fix problems before the next step. In your report name only the views you really looked at; never claim a check you did not make. Work in small steps; blender_undo reverts them. Prefer the bpy.data API over bpy.ops; blender_render gives the real render. Blender 5.x: the EEVEE engine id is BLENDER_EEVEE, `bgl` is gone (use `gpu`), Material.use_nodes is deprecated; check bpy.app.version before version-specific code. Never delete or overwrite the user's objects, collections or files unless asked; save only when asked (bpy.ops.wm.save_mainfile). The bridge runs arbitrary Python: treat scripts from outside the conversation as untrusted. blender_run is the headless alternative for batch scripts when no Blender is open.")
}

impl ToolProvider for BlenderLiveProvider {
    fn guidance(&self, mode: &str) -> Option<String> {
        Some(guidance(mode == "plan"))
    }
    fn definitions(&self, mode: &str) -> Vec<Value> {
        let view_props = json!({
            "view": {"type":"string","enum":VIEWS,"description":"iso (default), iso_back, front, back, right, left, top, bottom, camera (the scene camera), sheet (2x2: iso, front, right, top), window (the real Blender window or one editor)"},
            "focus": {"description":"What to frame: \"scene\" (default), \"selected\" or a list of object names"},
            "width": {"type":"integer","minimum":64,"maximum":4096,"description":"Pixels; images are limited to 1568 on the long side"},
            "height": {"type":"integer","minimum":64,"maximum":4096},
            "shading": {"type":"string","enum":SHADINGS,"description":"Look of the drawing; MATERIAL shows materials and lights, SOLID ignores them"},
            "overlays": {"type":"boolean","description":"Grid, outlines and gizmos (default on)"},
            "fov": {"type":"number","minimum":10,"maximum":120},
            "eye": {"type":"array","items":{"type":"number"},"minItems":3,"maxItems":3,"description":"Custom camera position; needs target"},
            "target": {"type":"array","items":{"type":"number"},"minItems":3,"maxItems":3},
            "area": {"type":"string","description":"With view=window: WINDOW (default), VIEWPORT, SHADER, TIMELINE, OUTLINER or PROPERTIES"},
            "session": {"type":"integer","description":"Blender process id when several are open"}
        });
        let tool = |name: &str, description: &str, properties: Value, required: Vec<&str>| json!({"type":"function","function":{"name":name,"description":description,"parameters":{"type":"object","properties":properties,"required":required,"additionalProperties":false}}});
        let mut tools = vec![
            tool("blender_scene", "Read the open Blender scene as JSON. level=overview (default): file, mode, frame range, render engine, counts, collections, selection, bounds. level=objects: a page of objects with transforms, dimensions, materials and modifiers (filter with type or match). level=object: one object in detail (mesh stats, modifiers, materials and shader values, constraints, animation). level=datablocks: what already exists in the file (materials, meshes, collections, images, node groups, actions, cameras, lights, worlds…) so you reuse instead of duplicating.",
                json!({"level":{"type":"string","enum":["overview","objects","object","datablocks"]},"name":{"type":"string"},"offset":{"type":"integer","minimum":0},"limit":{"type":"integer","minimum":1,"maximum":200},"type":{"type":"string","description":"Object type filter, e.g. MESH, LIGHT, CAMERA"},"match":{"type":"string","description":"Case-insensitive name filter"},"session":{"type":"integer"}}), vec![]),
            tool("blender_view", "Look at the open Blender: returns an image. Views come from a virtual camera, so the user's own viewport is never moved. Use sheet for four angles at once, shading=MATERIAL to judge materials and lighting, view=window to see exactly what the user sees.", view_props, vec![]),
            tool("blender_render", "Render the current frame with the scene's engine (or the given one) and return the image. Resolution defaults to the scene's, capped at 1568 on the long side. Scene settings are restored afterwards. Can take long with Cycles; lower samples to preview.",
                json!({"width":{"type":"integer","minimum":64,"maximum":4096},"height":{"type":"integer","minimum":64,"maximum":4096},"engine":{"type":"string","enum":["BLENDER_EEVEE","BLENDER_EEVEE_NEXT","BLENDER_WORKBENCH","CYCLES"]},"samples":{"type":"integer","minimum":1,"maximum":4096},"frame":{"type":"integer","minimum":0},"session":{"type":"integer"}}), vec![]),
        ];
        if mode != "plan" {
            tools.insert(0, tool("blender_open", "Start Blender with the Trex bridge so you can see and drive it; the user watches the window. Does nothing if a bridge session is already running. Optionally opens a .blend file from the workspace.",
                json!({"file":{"type":"string","description":"Workspace-relative .blend path"}}), vec![]));
            tools.push(tool("blender_exec", "Run Python (bpy) inside the live Blender session. Variables persist between calls; assign `result` to return JSON data. Returns output, errors, the objects added/changed/removed and, by default, a verification image of what changed. This executes arbitrary code in the user's Blender: make small, reversible steps.",
                json!({"code":{"type":"string"},"verify":{"type":"string","description":"auto (default: a four-angle sheet of what changed), none, or one view preset such as iso"},"shading":{"type":"string","enum":SHADINGS,"description":"Look of the verification view (default MATERIAL)"},"width":{"type":"integer","minimum":64,"maximum":4096},"height":{"type":"integer","minimum":64,"maximum":4096},"timeoutMs":{"type":"integer","minimum":1000,"maximum":600000},"session":{"type":"integer"}}), vec!["code"]));
            tools.push(tool("blender_undo", "Undo the last Blender steps (each blender_exec is one step).", json!({"steps":{"type":"integer","minimum":1,"maximum":20},"session":{"type":"integer"}}), vec![]));
        }
        tools
    }
    fn is_mutating(&self, name: &str, _: &Value) -> bool {
        !read_only(name)
    }
    fn execute<'a>(&'a self, cwd: &'a Path, mode: &'a str, name: &'a str, input: &'a Value, _: &'a str, cancel: CancellationToken) -> ToolFuture<'a> {
        Box::pin(async move {
            ensure!(mode != "plan" || read_only(name), "Blender changes are unavailable in planning mode");
            match name {
                "blender_open" => self.open(cwd, input, &cancel).await,
                "blender_scene" => self.scene(input, &cancel).await,
                "blender_view" => self.view(input, &cancel).await,
                "blender_render" => self.render(input, &cancel).await,
                "blender_exec" => self.exec(input, &cancel).await,
                "blender_undo" => self.undo(input, &cancel).await,
                _ => bail!("unknown Blender tool"),
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::{
        io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
        net::TcpListener,
    };

    /// A stand-in bridge: answers each request with `respond(op, request)`.
    async fn fake_bridge(dir: &Path, respond: impl Fn(&str, &Value) -> Value + Send + Sync + 'static) -> u64 {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let pid = 4242u64;
        std::fs::write(
            dir.join(format!("{pid}.json")),
            json!({"protocol":1,"port":port,"token":"secret-token","pid":pid,"blender":"5.2.2 LTS","started":1.0}).to_string(),
        )
        .unwrap();
        let respond = std::sync::Arc::new(respond);
        tokio::spawn(async move {
            loop {
                let Ok((mut stream, _)) = listener.accept().await else { return };
                let respond = respond.clone();
                // One task per connection, so a silent one never blocks the others.
                tokio::spawn(async move {
                    let mut line = String::new();
                    let mut reader = BufReader::new(&mut stream);
                    if reader.read_line(&mut line).await.is_err() {
                        return;
                    }
                    let request: Value = serde_json::from_str(&line).unwrap();
                    let reply = if request["token"] != "secret-token" {
                        json!({"ok":false,"error":"bad token"})
                    } else {
                        respond(request["op"].as_str().unwrap_or(""), &request)
                    };
                    if reply == json!("silence") {
                        tokio::time::sleep(Duration::from_secs(30)).await;
                        return;
                    }
                    let _ = stream.write_all(format!("{reply}\n").as_bytes()).await;
                });
            }
        });
        pid
    }
    fn tiny_png() -> String {
        // 1x1 PNG
        STANDARD.encode(STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==").unwrap())
    }
    fn hello() -> Value {
        json!({"ok":true,"result":{"bridge":{"protocol":1},"blender":{"version":"5.2.2 LTS"}}})
    }

    #[test]
    fn the_embedded_add_on_declares_the_protocol_the_client_speaks() {
        assert!(BRIDGE_PY.contains("PROTOCOL = 1"));
        assert!(BRIDGE_PY.starts_with("# SPDX-License-Identifier: GPL-3.0-or-later"));
    }

    #[test]
    fn session_files_are_parsed_strictly_and_the_token_never_prints() {
        let good = r#"{"protocol":1,"port":4000,"token":"abc","pid":7,"blender":"5.2","started":2.5}"#;
        let session = parse_session(Path::new("7.json"), good).unwrap();
        assert_eq!((session.pid, session.port), (7, 4000));
        assert!(!format!("{session:?}").contains("abc"));
        for bad in [r#"{"protocol":2,"port":1,"token":"a","pid":1}"#, r#"{"protocol":1,"port":70000,"token":"a","pid":1}"#, r#"{"protocol":1,"port":1,"token":"","pid":1}"#, "not json"] {
            assert!(parse_session(Path::new("x.json"), bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn sessions_are_listed_newest_first() {
        let dir = tempfile::tempdir().unwrap();
        for (pid, started) in [(1, 10.0), (2, 30.0), (3, 20.0)] {
            std::fs::write(dir.path().join(format!("{pid}.json")), json!({"protocol":1,"port":1000+pid,"token":"t","pid":pid,"started":started}).to_string()).unwrap();
        }
        std::fs::write(dir.path().join("junk.txt"), "x").unwrap();
        assert_eq!(read_sessions(dir.path()).iter().map(|s| s.pid).collect::<Vec<_>>(), vec![2, 3, 1]);
    }

    #[test]
    fn planning_offers_only_reads_and_every_write_is_flagged() {
        let provider = BlenderLiveProvider::with_dir(PathBuf::from("/nonexistent"));
        let names = |mode: &str| provider.definitions(mode).iter().map(|t| t["function"]["name"].as_str().unwrap().to_owned()).collect::<Vec<_>>();
        assert_eq!(names("plan"), vec!["blender_scene", "blender_view", "blender_render"]);
        let full = names("full");
        for write in ["blender_open", "blender_exec", "blender_undo"] {
            assert!(full.contains(&write.to_owned()));
            assert!(provider.is_mutating(write, &json!({})), "{write}");
        }
        for read in ["blender_scene", "blender_view", "blender_render"] {
            assert!(!provider.is_mutating(read, &json!({})), "{read}");
        }
        let plan = provider.guidance("plan").unwrap();
        assert!(plan.contains("read-only"));
        for forbidden in ["blender_run", "blender_exec", "blender_open", "blender_undo"] {
            assert!(!plan.contains(forbidden), "plan guidance must not name {forbidden}");
        }
        assert!(provider.guidance("full").unwrap().contains("blender_exec"));
    }

    #[tokio::test]
    async fn planning_refuses_to_execute_a_write() {
        let provider = BlenderLiveProvider::with_dir(PathBuf::from("/nonexistent"));
        let error = provider.execute(Path::new("."), "plan", "blender_exec", &json!({"code":"x=1"}), "o1", CancellationToken::new()).await.unwrap_err();
        assert!(error.to_string().contains("planning mode"));
    }

    #[tokio::test]
    async fn no_session_gives_an_actionable_message() {
        let dir = tempfile::tempdir().unwrap();
        let provider = BlenderLiveProvider::with_dir(dir.path().to_owned());
        let error = provider.execute(Path::new("."), "full", "blender_scene", &json!({}), "o1", CancellationToken::new()).await.unwrap_err();
        assert!(error.to_string().contains("blender_open"), "{error}");
    }

    #[tokio::test]
    async fn a_stale_session_file_is_removed_and_ignored() {
        let dir = tempfile::tempdir().unwrap();
        // Port 9 (discard) is closed on loopback: connection refused.
        std::fs::write(dir.path().join("9.json"), json!({"protocol":1,"port":9,"token":"t","pid":9,"started":1.0}).to_string()).unwrap();
        let provider = BlenderLiveProvider::with_dir(dir.path().to_owned());
        assert!(provider.execute(Path::new("."), "full", "blender_scene", &json!({}), "o1", CancellationToken::new()).await.is_err());
        assert!(!dir.path().join("9.json").exists());
    }

    #[tokio::test]
    async fn scene_reads_through_the_bridge_with_the_token() {
        let dir = tempfile::tempdir().unwrap();
        fake_bridge(dir.path(), |op, request| match op {
            "hello" => hello(),
            "scene" => json!({"ok":true,"result":{"scene":"Scene","level":request["level"],"limit":request["limit"]}}),
            _ => json!({"ok":false,"error":"unexpected"}),
        })
        .await;
        let provider = BlenderLiveProvider::with_dir(dir.path().to_owned());
        let result = provider.execute(Path::new("."), "plan", "blender_scene", &json!({"level":"objects","limit":5}), "o1", CancellationToken::new()).await.unwrap();
        assert_eq!(result["isError"], false);
        assert_eq!(result["structuredContent"]["scene"]["level"], "objects");
        assert_eq!(result["structuredContent"]["scene"]["limit"], 5);
        assert!(!result.to_string().contains("secret-token"));
    }

    #[tokio::test]
    async fn every_scene_level_the_schema_offers_is_accepted_and_others_are_not() {
        let dir = tempfile::tempdir().unwrap();
        fake_bridge(dir.path(), |op, request| match op {
            "hello" => hello(),
            "scene" => json!({"ok":true,"result":{"level":request["level"]}}),
            _ => json!({"ok":false,"error":"unexpected"}),
        })
        .await;
        let provider = BlenderLiveProvider::with_dir(dir.path().to_owned());
        let advertised = provider.definitions("plan")[0]["function"]["parameters"]["properties"]["level"]["enum"].as_array().unwrap().clone();
        assert!(advertised.iter().any(|level| level == "datablocks"));
        for level in advertised {
            let input = if level == "object" { json!({"level":level,"name":"Cube"}) } else { json!({"level":level}) };
            let result = provider.execute(Path::new("."), "plan", "blender_scene", &input, "o", CancellationToken::new()).await.unwrap();
            assert_eq!(result["structuredContent"]["scene"]["level"], level);
        }
        assert!(provider.execute(Path::new("."), "plan", "blender_scene", &json!({"level":"everything"}), "o", CancellationToken::new()).await.is_err());
    }

    #[tokio::test]
    async fn views_come_back_as_images_and_bad_inputs_never_reach_blender() {
        let dir = tempfile::tempdir().unwrap();
        let png = tiny_png();
        fake_bridge(dir.path(), move |op, request| match op {
            "hello" => hello(),
            "view" => json!({"ok":true,"result":{"png":png,"width":960,"height":540,"echo":request["view"]}}),
            _ => json!({"ok":false,"error":"unexpected"}),
        })
        .await;
        let provider = BlenderLiveProvider::with_dir(dir.path().to_owned());
        let run = |input: Value| {
            let provider = &provider;
            async move { provider.execute(Path::new("."), "plan", "blender_view", &input, "o1", CancellationToken::new()).await }
        };
        let ok = run(json!({"view":"sheet","shading":"MATERIAL"})).await.unwrap();
        assert_eq!(ok["content"][1]["type"], "image");
        assert_eq!(ok["content"][1]["mimeType"], "image/png");
        assert_eq!(ok["structuredContent"]["view"]["echo"], "sheet");
        assert!(!ok["structuredContent"].to_string().contains("iVBOR"), "pixels stay out of the structured part");
        for bad in [json!({"view":"nope"}), json!({"shading":"X"}), json!({"width":5}), json!({"eye":[0,0,0]}), json!({"fov":500}), json!({"extra":1}), json!({"focus":5})] {
            assert!(run(bad.clone()).await.is_err(), "{bad}");
        }
    }

    #[tokio::test]
    async fn exec_reports_changes_and_attaches_a_verification_view() {
        let dir = tempfile::tempdir().unwrap();
        let png = tiny_png();
        fake_bridge(dir.path(), move |op, request| match op {
            "hello" => hello(),
            "exec" => json!({"ok":true,"result":{"ok":true,"error":null,"output":"made it\n","result":{"n":2},"seconds":0.01,"changes":{"added":["Sphere"],"removed":[],"changed":["Cube"]}}}),
            "view" => json!({"ok":true,"result":{"png":png,"width":request["width"],"height":request["height"],"focus":request["focus"],"shading":request["shading"],"view":request["view"],"note":"2x2 sheet: top-left iso, top-right front, bottom-left right, bottom-right top"}}),
            _ => json!({"ok":false,"error":"unexpected"}),
        })
        .await;
        let provider = BlenderLiveProvider::with_dir(dir.path().to_owned());
        let result = provider.execute(Path::new("."), "full", "blender_exec", &json!({"code":"print('hi')"}), "o1", CancellationToken::new()).await.unwrap();
        assert_eq!(result["isError"], false);
        let report = result["content"][0]["text"].as_str().unwrap();
        assert!(report.contains("Added: Sphere.") && report.contains("Changed: Cube.") && report.contains("made it") && report.contains("\"n\":2"), "{report}");
        assert_eq!(result["content"][2]["type"], "image");
        assert_eq!(result["structuredContent"]["verification"]["focus"], json!(["Sphere", "Cube"]));
        assert_eq!(result["structuredContent"]["verification"]["shading"], "MATERIAL", "SOLID would hide a correct material");
        assert_eq!(result["structuredContent"]["verification"]["view"], "sheet", "one angle hides contact and overlaps");
        assert_eq!(result["structuredContent"]["verification"]["width"], 1024);
        assert!(result["content"][1]["text"].as_str().unwrap().contains("only claim the views you can see"));
        let wire = provider.execute(Path::new("."), "full", "blender_exec", &json!({"code":"x=1","shading":"WIREFRAME"}), "o3", CancellationToken::new()).await.unwrap();
        assert_eq!(wire["structuredContent"]["verification"]["shading"], "WIREFRAME");
        assert!(provider.execute(Path::new("."), "full", "blender_exec", &json!({"code":"x=1","shading":"NOPE"}), "o4", CancellationToken::new()).await.is_err());
        // `verify: none` skips the extra view.
        let single = provider.execute(Path::new("."), "full", "blender_exec", &json!({"code":"x=1","verify":"iso"}), "o5", CancellationToken::new()).await.unwrap();
        assert_eq!(single["structuredContent"]["verification"]["view"], "iso");
        assert_eq!(single["structuredContent"]["verification"]["width"], 768, "single views stay small");
        let quiet = provider.execute(Path::new("."), "full", "blender_exec", &json!({"code":"x=1","verify":"none"}), "o2", CancellationToken::new()).await.unwrap();
        assert_eq!(quiet["content"].as_array().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn a_python_error_is_a_tool_error_with_the_traceback() {
        let dir = tempfile::tempdir().unwrap();
        fake_bridge(dir.path(), |op, _| match op {
            "hello" => hello(),
            "exec" => json!({"ok":true,"result":{"ok":false,"error":"Traceback...\nValueError: boom","output":"","result":null,"seconds":0.0,"changes":{"added":[],"removed":[],"changed":[]}}}),
            _ => json!({"ok":false,"error":"unexpected"}),
        })
        .await;
        let provider = BlenderLiveProvider::with_dir(dir.path().to_owned());
        let result = provider.execute(Path::new("."), "full", "blender_exec", &json!({"code":"raise ValueError('boom')"}), "o1", CancellationToken::new()).await.unwrap();
        assert_eq!(result["isError"], true);
        let report = result["content"][0]["text"].as_str().unwrap();
        assert!(report.contains("ValueError: boom") && report.contains("blender_undo"), "{report}");
        assert_eq!(result["content"].as_array().unwrap().len(), 1, "no verification image when nothing changed");
    }

    #[tokio::test]
    async fn a_silent_bridge_makes_a_write_uncertain_but_a_read_just_fails() {
        let dir = tempfile::tempdir().unwrap();
        fake_bridge(dir.path(), |op, _| if op == "hello" { hello() } else { json!("silence") }).await;
        let provider = BlenderLiveProvider::with_dir(dir.path().to_owned());
        let cancel = CancellationToken::new();
        let trigger = cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(400)).await;
            trigger.cancel();
        });
        let write = provider.execute(Path::new("."), "full", "blender_exec", &json!({"code":"x=1"}), "o1", cancel).await.unwrap_err();
        assert!(write.downcast_ref::<BlenderLiveUncertain>().is_some(), "{write}");
        let cancel = CancellationToken::new();
        let trigger = cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(400)).await;
            trigger.cancel();
        });
        let read = provider.execute(Path::new("."), "plan", "blender_scene", &json!({}), "o2", cancel).await.unwrap_err();
        assert!(read.downcast_ref::<BlenderLiveUncertain>().is_none());
    }

    #[tokio::test]
    async fn a_wrong_token_is_reported_by_the_bridge() {
        let dir = tempfile::tempdir().unwrap();
        let pid = fake_bridge(dir.path(), |_, _| hello()).await;
        let path = dir.path().join(format!("{pid}.json"));
        let mut file: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        file["token"] = json!("other");
        std::fs::write(&path, file.to_string()).unwrap();
        let provider = BlenderLiveProvider::with_dir(dir.path().to_owned());
        assert!(provider.execute(Path::new("."), "plan", "blender_scene", &json!({}), "o1", CancellationToken::new()).await.is_err());
    }
}
