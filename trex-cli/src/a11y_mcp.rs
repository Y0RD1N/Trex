//! Control por accesibilidad (experimental): pasarela MCP hacia `agent-desktop`.
//!
//! agent-desktop opera las aplicaciones mediante el árbol de accesibilidad del
//! sistema (UI Automation en Windows), sin mover el ratón ni escribir con el
//! teclado de la persona. Su servidor MCP publica 67 herramientas (unos 39 KB de
//! esquemas) con nombres que chocan con `trex_desktop`; esta pasarela:
//!
//! - publica solo una selección, con el prefijo `a11y_`: lectura en el modo
//!   `plan` y, además, acciones semánticas en `full`. Nunca entrada física
//!   (`mouse_*`, `hover`, `drag`…), sesiones, trazas, portapapeles, notificaciones
//!   ni `batch`, que permitiría saltarse la selección;
//! - acorta descripciones, quita los esquemas de salida y el `structuredContent`
//!   duplicado, y recorta las respuestas enormes (un snapshot de Chrome puede
//!   pasar de 1 MB);
//! - guarda el estado de agent-desktop (refmaps con el texto leído de la
//!   pantalla) en una carpeta privada por proceso que se borra al cerrar, en vez
//!   de `~/.agent-desktop`, donde quedaba sin censurar.
//!
//! Nunca se pasa `--headed`: agent-desktop queda en su modo semántico estricto.
//!
//! En Windows hay además un motor propio (`crate::a11y`), sin dependencias
//! externas: `--engine trex`. `auto` usa el propio si existe en la plataforma.
use anyhow::{ensure, Context, Result};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    env,
    ffi::OsString,
    fs,
    io::{self, BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant, SystemTime},
};

/// Primera versión con servidor MCP.
pub const MINIMUM_VERSION: (u32, u32, u32) = (1, 2, 0);
pub const PREFIX: &str = "a11y_";
/// Solo leen el árbol de accesibilidad o la lista de ventanas.
pub const READ_TOOLS: [&str; 11] = [
    "snapshot", "find", "get", "is", "list_windows", "list_apps", "list_displays", "list_surfaces", "wait", "status",
    "skills_get",
];
/// Acciones semánticas (sin ratón ni teclado físicos) del modo `full`.
pub const ACTION_TOOLS: [&str; 21] = [
    "click", "right_click", "type", "set_value", "clear", "focus", "select", "toggle", "check", "uncheck", "expand",
    "collapse", "scroll", "scroll_to", "press", "launch", "close_app", "focus_window", "minimize", "maximize", "restore",
];
/// Unos 10 000 tokens: lo que pase se recorta con un aviso para acotar la consulta.
const MAX_RESULT_CHARS: usize = 40_000;
const MAX_DESCRIPTION_CHARS: usize = 320;
const MAX_PARAMETER_CHARS: usize = 120;
/// Donde un plazo mayor ayuda (Chromium tarda en asentarse); en el resto, su valor por defecto.
const TIMEOUT_TOOLS: [&str; 3] = ["snapshot", "find", "wait"];
/// Carpetas de procesos que ya no dan señales de vida (se cerraron de golpe).
const STALE_AFTER: Duration = Duration::from_secs(15 * 60);
const HEARTBEAT: Duration = Duration::from_secs(60);
const ROOT_PREFIX: &str = "trex-a11y-";

/// Acciones que usan el teclado o mueven el foco: solo con el permiso de atajos de Ajustes.
const KEYBOARD_GATED: [&str; 3] = ["press", "focus", "focus_window"];
/// Modo interno del modo completo con permiso de teclado.
const FULL_WITH_KEYBOARD: &str = "full+keyboard";

fn allowed(tool: &str, mode: &str) -> bool {
    let full = mode == "full" || mode == FULL_WITH_KEYBOARD;
    READ_TOOLS.contains(&tool) || (full && ACTION_TOOLS.contains(&tool) && (mode == FULL_WITH_KEYBOARD || !KEYBOARD_GATED.contains(&tool)))
}

/// Nombre en agent-desktop de una herramienta publicada, si este modo la permite.
pub fn upstream_name(name: &str, mode: &str) -> Option<String> {
    let tool = name.strip_prefix(PREFIX)?;
    allowed(tool, mode).then(|| format!("desktop_{tool}"))
}

/// Primeras frases, hasta `limit` caracteres.
fn short(description: &str, limit: usize) -> String {
    let text = description.trim();
    if text.chars().count() <= limit {
        return text.to_owned();
    }
    let cut: String = text.chars().take(limit).collect();
    match cut.rfind(". ") {
        Some(end) if end > limit / 3 => cut[..=end].to_owned(),
        _ => format!("{}…", cut.trim_end()),
    }
}

/// Parámetros más ligeros: descripciones cortas y sin plazos donde no hacen falta.
fn slim_schema(schema: &mut Value, tool: &str) {
    let Some(properties) = schema.get_mut("properties").and_then(Value::as_object_mut) else { return };
    if !TIMEOUT_TOOLS.contains(&tool) {
        properties.remove("timeout_ms");
    }
    for property in properties.values_mut() {
        if let Some(description) = property.get("description").and_then(Value::as_str) {
            property["description"] = json!(short(description, MAX_PARAMETER_CHARS));
        }
    }
    if let Some(required) = schema.get_mut("required").and_then(Value::as_array_mut) {
        required.retain(|name| name != "timeout_ms" || TIMEOUT_TOOLS.contains(&tool));
    }
}

/// Selección, nombres `a11y_*` y anotaciones de la lista de herramientas.
pub fn rewrite_tools(result: &mut Value, mode: &str) {
    let Some(tools) = result.get_mut("tools").and_then(Value::as_array_mut) else { return };
    tools.retain_mut(|tool| {
        let Some(name) = tool["name"].as_str().and_then(|name| name.strip_prefix("desktop_")).map(str::to_owned) else {
            return false;
        };
        if !allowed(&name, mode) {
            return false;
        }
        let read_only = READ_TOOLS.contains(&name.as_str());
        tool["name"] = json!(format!("{PREFIX}{name}"));
        let description = short(tool["description"].as_str().unwrap_or(""), MAX_DESCRIPTION_CHARS);
        tool["description"] = json!(description);
        slim_schema(&mut tool["inputSchema"], &name);
        if let Some(object) = tool.as_object_mut() {
            object.remove("outputSchema");
            object.remove("_meta");
        }
        tool["annotations"] = json!({"readOnlyHint": read_only, "destructiveHint": !read_only, "idempotentHint": false, "openWorldHint": true});
        true
    });
}

/// Nombre real y valores por defecto de una llamada; `Err` si no está publicada.
pub fn prepare_call(params: &mut Value, mode: &str) -> Result<(), String> {
    let name = params["name"].as_str().unwrap_or("").to_owned();
    let upstream = upstream_name(&name, mode)
        .ok_or_else(|| format!("Tool {name} is not available in this accessibility session."))?;
    if upstream == "desktop_snapshot" {
        // Lo que recomienda su guía (`snapshot -i --compact`): mucho menos texto.
        if !params["arguments"].is_object() {
            params["arguments"] = json!({});
        }
        for key in ["interactive_only", "compact"] {
            if params["arguments"].get(key).is_none() {
                params["arguments"][key] = json!(true);
            }
        }
    }
    params["name"] = json!(upstream);
    Ok(())
}

/// Sin datos duplicados ni metadatos, y recortado si es enorme.
pub fn rewrite_result(result: &mut Value) {
    let Some(object) = result.as_object_mut() else { return };
    object.remove("_meta");
    let has_text = object.get("content").and_then(Value::as_array).is_some_and(|items| items.iter().any(|item| item["type"] == "text"));
    if has_text {
        object.remove("structuredContent");
    }
    let Some(items) = object.get_mut("content").and_then(Value::as_array_mut) else { return };
    let total: usize = items.iter().filter_map(|item| item["text"].as_str()).map(|text| text.chars().count()).sum();
    if total <= MAX_RESULT_CHARS {
        return;
    }
    let mut budget = MAX_RESULT_CHARS;
    for item in items.iter_mut() {
        if let Some(text) = item["text"].as_str() {
            let kept: String = text.chars().take(budget).collect();
            budget -= kept.chars().count();
            item["text"] = json!(kept);
        }
    }
    items.push(json!({"type": "text", "text": format!(
        "[Trex: result truncated from {total} to {MAX_RESULT_CHARS} characters. Narrow it with app or window_id, interactive_only, skeleton, max_depth or root.]"
    )}));
}

pub fn instructions(mode: &str) -> String {
    let permissions = if mode == "plan" {
        "This process is read-only: only observation tools are available."
    } else {
        "Actions follow the host agent's permission policy."
    };
    format!(
        "Trex accessibility control (experimental, powered by agent-desktop) operates desktop apps through the operating system accessibility tree, \
without moving the user's mouse or typing on their keyboard, so the user can keep working. Loop: a11y_list_windows, then a11y_snapshot of one app or \
window_id (interactive-only and compact by default; use skeleton or root for big apps), act on a fresh @ref, then verify by reading again \
(a11y_get, a11y_find or a new snapshot): set_value and type only verify the element value, not that the application kept it. Refs expire: take a new \
snapshot after changes. On POLICY_DENIED, ACTION_FAILED, AMBIGUOUS_TARGET or STALE_REF explain or re-observe instead of retrying blindly, and never \
repeat an uncertain action automatically. Snapshots include visible document text: never repeat secrets or passwords. focus, focus_window and press \
can bring a window to the front and interrupt the user; avoid them unless needed. For pixels or apps without accessibility data use trex_desktop if \
it is connected. {permissions}"
    )
}

// --- Dónde está agent-desktop ------------------------------------------------------

/// Binario nativo que trae el paquete de npm para esta plataforma.
fn platform_binary() -> Option<&'static str> {
    Some(match (env::consts::OS, env::consts::ARCH) {
        ("windows", "x86_64") => "agent-desktop-win32-x64.exe",
        ("windows", "aarch64") => "agent-desktop-win32-arm64.exe",
        ("macos", "aarch64") => "agent-desktop-darwin-arm64",
        ("macos", "x86_64") => "agent-desktop-darwin-x64",
        ("linux", "x86_64") => "agent-desktop-linux-x64",
        ("linux", "aarch64") => "agent-desktop-linux-arm64",
        _ => return None,
    })
}

/// Un ejecutable de verdad (PE, ELF o Mach-O), no el lanzador de Node de npm.
fn is_native(path: &Path) -> bool {
    let mut magic = [0u8; 4];
    fs::File::open(path).and_then(|mut file| file.read_exact(&mut magic)).is_ok()
        && (magic[..2] == *b"MZ"
            || magic == *b"\x7fELF"
            || [[0xcf, 0xfa, 0xed, 0xfe], [0xce, 0xfa, 0xed, 0xfe], [0xca, 0xfe, 0xba, 0xbe]].contains(&magic))
}

/// `TREX_AGENT_DESKTOP` si se fija; si no, el paquete global de npm o un binario
/// nativo en el PATH (Homebrew, cargo…). El lanzador de npm se resuelve hasta
/// el binario de la plataforma para no depender de Node ni de `cmd`.
pub fn locate_in(path_var: Option<OsString>, explicit: Option<OsString>) -> Option<PathBuf> {
    if let Some(explicit) = explicit.filter(|value| !value.is_empty()).map(PathBuf::from) {
        return (explicit.is_absolute() && explicit.is_file()).then_some(explicit);
    }
    let platform = platform_binary()?;
    for dir in env::split_paths(&path_var?) {
        // npm: `<prefijo>\node_modules` en Windows, `<prefijo>/lib/node_modules` en Unix.
        for package in [dir.join("node_modules"), dir.join("..").join("lib").join("node_modules")] {
            let candidate = package.join("agent-desktop").join("bin").join(platform);
            if candidate.is_file() && is_native(&candidate) {
                return Some(candidate);
            }
        }
        let launcher = dir.join(if cfg!(windows) { "agent-desktop.exe" } else { "agent-desktop" });
        if launcher.is_file() {
            if is_native(&launcher) {
                return Some(launcher);
            }
            // Un enlace al lanzador de Node: el binario está a su lado.
            if let Some(sibling) = fs::canonicalize(&launcher).ok().and_then(|real| real.parent().map(|dir| dir.join(platform))) {
                if sibling.is_file() && is_native(&sibling) {
                    return Some(sibling);
                }
            }
        }
    }
    None
}

pub fn locate() -> Option<PathBuf> {
    locate_in(env::var_os("PATH"), env::var_os("TREX_AGENT_DESKTOP"))
}

pub fn parse_version(text: &str) -> Option<(u32, u32, u32)> {
    let mut parts = text.trim().trim_start_matches('v').split(['.', '-', '+']).map(|part| part.parse::<u32>());
    Some((parts.next()?.ok()?, parts.next()?.ok()?, parts.next().and_then(Result::ok).unwrap_or(0)))
}

fn hide_window(command: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    #[cfg(not(windows))]
    let _ = command;
}

fn wait_or_kill(child: &mut Child, limit: Duration) -> bool {
    let deadline = Instant::now() + limit;
    while Instant::now() < deadline {
        if matches!(child.try_wait(), Ok(Some(_))) {
            return true;
        }
        thread::sleep(Duration::from_millis(50));
    }
    let _ = child.kill();
    let _ = child.wait();
    false
}

/// `agent-desktop version`, con un límite de tiempo.
fn version_of(binary: &Path) -> Result<String> {
    let mut command = Command::new(binary);
    command.arg("version").stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
    hide_window(&mut command);
    let mut child = command.spawn()?;
    let stdout = child.stdout.take().context("missing stdout")?;
    let reader = thread::spawn(move || {
        let mut text = String::new();
        let _ = stdout.take(64 * 1024).read_to_string(&mut text);
        text
    });
    ensure!(wait_or_kill(&mut child, Duration::from_secs(10)), "agent-desktop version timed out");
    let text = reader.join().unwrap_or_default();
    let value: Value = serde_json::from_str(text.trim()).context("unexpected agent-desktop version output")?;
    value["data"]["version"].as_str().map(str::to_owned).context("missing agent-desktop version")
}

/// Disponibilidad para Ajustes: no abre aplicaciones ni lee la pantalla. Los
/// campos de primer nivel describen agent-desktop; `native`, el motor propio.
pub fn doctor() -> Value {
    let minimum = format!("{}.{}.{}", MINIMUM_VERSION.0, MINIMUM_VERSION.1, MINIMUM_VERSION.2);
    let mut status = match locate() {
        None => json!({"available": false, "reason": "notInstalled", "minimumVersion": minimum}),
        Some(path) => match version_of(&path) {
            Ok(version) => {
                let supported = parse_version(&version).is_some_and(|found| found >= MINIMUM_VERSION);
                json!({"available": supported, "path": path, "version": version, "minimumVersion": minimum,
                    "reason": if supported { Value::Null } else { json!("unsupportedVersion") }})
            }
            Err(_) => json!({"available": false, "path": path, "reason": "failed", "minimumVersion": minimum}),
        },
    };
    status["native"] = json!({"available": crate::a11y::available(), "engine": "trex"});
    status
}

/// Motor que se usará: `auto` elige el propio cuando la plataforma lo tiene.
pub fn resolve_engine(engine: &str) -> Result<&'static str> {
    Ok(match engine {
        "trex" => "trex",
        "agent-desktop" => "agent-desktop",
        "auto" => if crate::a11y::available() { "trex" } else { "agent-desktop" },
        other => anyhow::bail!("unknown accessibility engine {other}"),
    })
}

// --- Estado privado ----------------------------------------------------------------

/// Carpeta de estado de agent-desktop solo para este proceso; se borra al cerrar.
struct StateRoot {
    dir: Option<tempfile::TempDir>,
}
impl StateRoot {
    fn create() -> Result<Self> {
        sweep_stale(&env::temp_dir());
        let dir = tempfile::Builder::new().prefix(ROOT_PREFIX).tempdir().context("could not create the accessibility state folder")?;
        let _ = fs::write(dir.path().join("heartbeat"), b"");
        Ok(Self { dir: Some(dir) })
    }
    fn path(&self) -> &Path {
        self.dir.as_ref().map(|dir| dir.path()).expect("state root")
    }
    /// Windows puede tardar en soltar los archivos de un proceso que acaba de salir.
    fn remove(&mut self) {
        let Some(dir) = self.dir.take() else { return };
        let path = dir.keep();
        for attempt in 0..10 {
            if fs::remove_dir_all(&path).is_ok() || !path.exists() {
                return;
            }
            thread::sleep(Duration::from_millis(100 * (attempt + 1)));
        }
    }
}
impl Drop for StateRoot {
    fn drop(&mut self) {
        self.remove();
    }
}

/// Borra las carpetas de pasarelas que se cerraron sin limpiar (sin latido reciente).
fn sweep_stale(temp: &Path) {
    let Ok(entries) = fs::read_dir(temp) else { return };
    for entry in entries.flatten() {
        if !entry.file_name().to_string_lossy().starts_with(ROOT_PREFIX) {
            continue;
        }
        let path = entry.path();
        let beat = fs::metadata(path.join("heartbeat")).or_else(|_| fs::metadata(&path)).and_then(|meta| meta.modified());
        let stale = beat.ok().and_then(|time| SystemTime::now().duration_since(time).ok()).is_some_and(|age| age > STALE_AFTER);
        if stale && fs::symlink_metadata(&path).is_ok_and(|meta| meta.is_dir()) {
            let _ = fs::remove_dir_all(&path);
        }
    }
}

// --- Pasarela ----------------------------------------------------------------------

#[derive(Clone, Copy)]
enum Kind {
    Initialize,
    ToolsList,
    ToolsCall,
}
type Pending = Arc<Mutex<HashMap<String, Kind>>>;

enum Route {
    Upstream(String),
    Reply(Value),
}

/// Un mensaje del cliente (Claude, Codex, Trex CLI…).
fn from_client(line: &str, pending: &Pending, mode: &str) -> Route {
    let Ok(mut message) = serde_json::from_str::<Value>(line) else { return Route::Upstream(line.to_owned()) };
    let (Some(method), Some(id)) = (message["method"].as_str().map(str::to_owned), message.get("id").cloned()) else {
        return Route::Upstream(line.to_owned());
    };
    let kind = match method.as_str() {
        "initialize" => Kind::Initialize,
        "tools/list" => Kind::ToolsList,
        "tools/call" => {
            if let Err(reason) = prepare_call(&mut message["params"], mode) {
                return Route::Reply(json!({"jsonrpc": "2.0", "id": id, "error": {"code": -32602, "message": reason}}));
            }
            Kind::ToolsCall
        }
        _ => return Route::Upstream(line.to_owned()),
    };
    pending.lock().unwrap().insert(id.to_string(), kind);
    Route::Upstream(message.to_string())
}

/// Un mensaje de agent-desktop: se ajustan las respuestas a peticiones conocidas.
fn from_upstream(line: &str, pending: &Pending, mode: &str) -> Option<Value> {
    let mut message: Value = serde_json::from_str(line).ok()?;
    if message.get("method").is_some() {
        return Some(message);
    }
    let kind = message.get("id").and_then(|id| pending.lock().unwrap().remove(&id.to_string()));
    let Some(result) = message.get_mut("result") else { return Some(message) };
    match kind {
        Some(Kind::Initialize) => {
            let version = result["serverInfo"]["version"].as_str().unwrap_or("").to_owned();
            result["serverInfo"] = json!({"name": "trex-a11y", "version": format!("agent-desktop {version}")});
            result["instructions"] = json!(instructions(mode));
        }
        Some(Kind::ToolsList) => rewrite_tools(result, mode),
        Some(Kind::ToolsCall) => rewrite_result(result),
        None => {}
    }
    Some(message)
}

fn send(output: &Mutex<io::Stdout>, message: &Value) {
    let mut output = output.lock().unwrap();
    let _ = serde_json::to_writer(&mut *output, message);
    let _ = output.write_all(b"\n");
    let _ = output.flush();
}

pub fn serve(mode: &str, engine: &str, keyboard: bool) -> Result<()> {
    ensure!(matches!(mode, "plan" | "full"), "accessibility MCP mode must be plan or full");
    if resolve_engine(engine)? == "trex" {
        return crate::a11y::serve(mode, keyboard);
    }
    let mode = if mode == "full" && keyboard { FULL_WITH_KEYBOARD } else { mode };
    let binary = locate().context("agent-desktop is not installed")?;
    let mut root = StateRoot::create()?;
    let mut command = Command::new(&binary);
    command
        .arg("mcp")
        .env("AGENT_DESKTOP_HOME", root.path())
        .env_remove("AGENT_DESKTOP_SESSION")
        .env_remove("AGENT_DESKTOP_AGENT_ID")
        .env_remove("AGENT_DESKTOP_INTERACTION_LEASE_HANDLE")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    hide_window(&mut command);
    let mut child = command.spawn().context("could not start agent-desktop")?;
    let mut upstream = child.stdin.take().context("agent-desktop stdin unavailable")?;
    let downstream = child.stdout.take().context("agent-desktop stdout unavailable")?;
    let output = Arc::new(Mutex::new(io::stdout()));
    let pending: Pending = Arc::default();
    let reader = {
        let (output, pending, mode) = (output.clone(), pending.clone(), mode.to_owned());
        thread::spawn(move || {
            for line in BufReader::new(downstream).lines() {
                let Ok(line) = line else { break };
                if let Some(message) = from_upstream(&line, &pending, &mode) {
                    send(&output, &message);
                }
            }
        })
    };
    let alive = Arc::new(AtomicBool::new(true));
    {
        let (alive, beat) = (alive.clone(), root.path().join("heartbeat"));
        thread::spawn(move || {
            while alive.load(Ordering::Relaxed) {
                thread::sleep(HEARTBEAT);
                if alive.load(Ordering::Relaxed) {
                    let _ = fs::write(&beat, b"");
                }
            }
        });
    }
    for line in io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        match from_client(&line, &pending, mode) {
            Route::Upstream(text) => {
                if writeln!(upstream, "{text}").and_then(|()| upstream.flush()).is_err() {
                    break;
                }
            }
            Route::Reply(message) => send(&output, &message),
        }
    }
    alive.store(false, Ordering::Relaxed);
    drop(upstream);
    wait_or_kill(&mut child, Duration::from_secs(3));
    let _ = reader.join();
    root.remove();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn modes_publish_only_the_selected_tools() {
        assert_eq!(upstream_name("a11y_snapshot", "plan").as_deref(), Some("desktop_snapshot"));
        assert_eq!(upstream_name("a11y_click", "plan"), None, "plan is read-only");
        assert_eq!(upstream_name("a11y_click", "full").as_deref(), Some("desktop_click"));
        // Teclado y foco: solo con el permiso de atajos.
        assert_eq!(upstream_name("a11y_press", "full"), None);
        assert_eq!(upstream_name("a11y_focus_window", "full"), None);
        assert_eq!(upstream_name("a11y_press", FULL_WITH_KEYBOARD).as_deref(), Some("desktop_press"));
        assert_eq!(upstream_name("a11y_press", "plan"), None);
        for hidden in ["a11y_mouse_click", "a11y_hover", "a11y_drag", "a11y_batch", "a11y_clipboard_get", "a11y_session_end", "a11y_screenshot", "desktop_click", "click"] {
            assert_eq!(upstream_name(hidden, "full"), None, "{hidden}");
        }
        assert!(READ_TOOLS.iter().all(|tool| !ACTION_TOOLS.contains(tool)));
    }

    #[test]
    fn the_tool_list_is_renamed_trimmed_and_annotated() {
        let long = "Capture the tree. ".repeat(40);
        let mut result = json!({"tools": [
            {"name": "desktop_snapshot", "description": long, "inputSchema": {"type": "object"}, "outputSchema": {"type": "object"}},
            {"name": "desktop_click", "description": "Click.", "inputSchema": {"type": "object", "properties": {
                "ref_id": {"type": "string", "description": long},
                "timeout_ms": {"type": "integer"}}, "required": ["ref_id"]}},
            {"name": "desktop_mouse_click", "description": "Physical.", "inputSchema": {"type": "object"}},
            {"name": "desktop_session_end", "description": "End.", "inputSchema": {"type": "object"}},
        ]});
        let mut plan = result.clone();
        rewrite_tools(&mut plan, "plan");
        let names: Vec<_> = plan["tools"].as_array().unwrap().iter().map(|tool| tool["name"].as_str().unwrap()).collect();
        assert_eq!(names, ["a11y_snapshot"]);
        assert!(plan["tools"][0].get("outputSchema").is_none());
        assert_eq!(plan["tools"][0]["annotations"]["readOnlyHint"], true);
        assert!(plan["tools"][0]["description"].as_str().unwrap().chars().count() <= MAX_DESCRIPTION_CHARS);
        rewrite_tools(&mut result, "full");
        let names: Vec<_> = result["tools"].as_array().unwrap().iter().map(|tool| tool["name"].as_str().unwrap()).collect();
        assert_eq!(names, ["a11y_snapshot", "a11y_click"]);
        assert_eq!(result["tools"][1]["annotations"]["readOnlyHint"], false);
        // Sin plazo en un clic y con la descripción del parámetro acortada.
        let schema = &result["tools"][1]["inputSchema"];
        assert!(schema["properties"].get("timeout_ms").is_none());
        assert!(schema["properties"]["ref_id"]["description"].as_str().unwrap().chars().count() <= MAX_PARAMETER_CHARS);
        assert_eq!(schema["required"], json!(["ref_id"]));
    }

    #[test]
    fn calls_are_mapped_with_compact_snapshot_defaults() {
        let mut params = json!({"name": "a11y_snapshot", "arguments": {"app": "notepad.exe", "interactive_only": false}});
        prepare_call(&mut params, "plan").unwrap();
        assert_eq!(params, json!({"name": "desktop_snapshot", "arguments": {"app": "notepad.exe", "interactive_only": false, "compact": true}}));
        let mut bare = json!({"name": "a11y_snapshot"});
        prepare_call(&mut bare, "plan").unwrap();
        assert_eq!(bare["arguments"], json!({"interactive_only": true, "compact": true}));
        let mut click = json!({"name": "a11y_click", "arguments": {"ref_id": "@s1:e5"}});
        assert!(prepare_call(&mut click, "plan").is_err());
        prepare_call(&mut click, "full").unwrap();
        assert_eq!(click, json!({"name": "desktop_click", "arguments": {"ref_id": "@s1:e5"}}));
    }

    #[test]
    fn results_drop_duplicates_and_huge_text_is_truncated() {
        let mut small = json!({"_meta": {}, "content": [{"type": "text", "text": "{\"ok\":true}"}], "structuredContent": {"ok": true}, "isError": false});
        rewrite_result(&mut small);
        assert_eq!(small, json!({"content": [{"type": "text", "text": "{\"ok\":true}"}], "isError": false}));
        let mut huge = json!({"content": [{"type": "text", "text": "é".repeat(MAX_RESULT_CHARS + 500)}]});
        rewrite_result(&mut huge);
        let items = huge["content"].as_array().unwrap();
        assert_eq!(items[0]["text"].as_str().unwrap().chars().count(), MAX_RESULT_CHARS);
        assert!(items[1]["text"].as_str().unwrap().contains("truncated"));
    }

    #[test]
    fn the_gateway_rewrites_both_directions() {
        let pending: Pending = Arc::default();
        let Route::Upstream(line) = from_client(r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}"#, &pending, "plan") else { panic!() };
        assert!(line.contains("initialize"));
        let reply = from_upstream(r#"{"jsonrpc":"2.0","id":1,"result":{"serverInfo":{"name":"agent-desktop","version":"1.2.0"},"instructions":"x"}}"#, &pending, "plan").unwrap();
        assert_eq!(reply["result"]["serverInfo"]["name"], "trex-a11y");
        assert!(reply["result"]["instructions"].as_str().unwrap().contains("read-only"));
        // Una acción en modo plan se rechaza sin llegar a agent-desktop.
        let Route::Reply(error) = from_client(r#"{"jsonrpc":"2.0","id":"c","method":"tools/call","params":{"name":"a11y_click","arguments":{}}}"#, &pending, "plan") else { panic!() };
        assert_eq!(error["error"]["code"], -32602);
        // Las notificaciones y respuestas desconocidas pasan tal cual.
        let notice = from_upstream(r#"{"jsonrpc":"2.0","method":"notifications/tools/list_changed"}"#, &pending, "plan").unwrap();
        assert_eq!(notice["method"], "notifications/tools/list_changed");
        assert!(from_upstream("not json", &pending, "plan").is_none());
    }

    #[test]
    fn npm_installs_resolve_to_the_native_binary() {
        let Some(platform) = platform_binary() else { return };
        let temp = tempfile::tempdir().unwrap();
        let prefix = temp.path().join("npm");
        let bin = prefix.join("node_modules").join("agent-desktop").join("bin");
        fs::create_dir_all(&bin).unwrap();
        // Sin binario nativo (solo el lanzador de Node), no hay instalación utilizable.
        fs::write(prefix.join(if cfg!(windows) { "agent-desktop.exe" } else { "agent-desktop" }), b"#!/usr/bin/env node\n").unwrap();
        assert_eq!(locate_in(Some(prefix.clone().into_os_string()), None), None);
        fs::write(bin.join(platform), b"MZ\x90\x00binary").unwrap();
        fs::write(bin.join(format!("{platform}.sha256")), b"x").unwrap();
        assert_eq!(locate_in(Some(prefix.clone().into_os_string()), None), Some(bin.join(platform)));
        assert_eq!(locate_in(Some(prefix.into_os_string()), Some(OsString::from("relative/agent-desktop"))), None, "an override must be absolute");
        assert_eq!(parse_version("1.2.0"), Some((1, 2, 0)));
        assert_eq!(parse_version("v1.10.3-beta"), Some((1, 10, 3)));
        assert!(parse_version("1.1.9").unwrap() < MINIMUM_VERSION);
        assert_eq!(parse_version("abc"), None);
    }

    #[test]
    fn abandoned_state_folders_are_swept() {
        let temp = tempfile::tempdir().unwrap();
        let old = temp.path().join(format!("{ROOT_PREFIX}old"));
        let fresh = temp.path().join(format!("{ROOT_PREFIX}fresh"));
        let other = temp.path().join("other-folder");
        for dir in [&old, &fresh, &other] {
            fs::create_dir_all(dir).unwrap();
            fs::write(dir.join("heartbeat"), b"").unwrap();
        }
        let past = SystemTime::now() - STALE_AFTER - Duration::from_secs(60);
        fs::File::options().write(true).open(old.join("heartbeat")).unwrap().set_modified(past).unwrap();
        fs::File::options().write(true).open(other.join("heartbeat")).unwrap().set_modified(past).unwrap();
        sweep_stale(temp.path());
        assert!(!old.exists(), "a folder without a recent heartbeat is removed");
        assert!(fresh.exists() && other.exists());
    }
}
