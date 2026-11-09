//! Motor de accesibilidad propio de Trex (experimental).
//!
//! Lee y maneja las aplicaciones a través del árbol de accesibilidad del sistema
//! (UI Automation en Windows, AT-SPI en Linux), sin mover el ratón ni escribir con el teclado de
//! la persona. Es independiente del control de computadora (capturas y
//! entrada real): la persona elige cuál usar.
//!
//! - va dentro de `trex-agent`: nada que instalar, ni Node ni npm;
//! - las acciones nunca traen la ventana al frente (`AutoSetFocus` desactivado)
//!   y se rechazan si la persona está usando esa misma ventana en ese momento;
//! - cada acción con estado se comprueba releyendo el control poco después, en
//!   vez de dar por bueno lo que el control acepta un instante;
//! - los campos de contraseña nunca se leen, los valores largos se recortan y no
//!   se escribe nada en disco: las referencias viven en memoria;
//! - el árbol se devuelve como texto compacto con referencias `@s1:e4`, mucho
//!   más corto que JSON, y cada acción dice qué cambió (elementos y ventanas
//!   nuevos, ya con referencia), sin tener que releer la ventana;
//! - un resaltado translúcido marca dónde actúa, sin bloquear el ratón (Windows:
//!   Wayland no deja dibujar sobre otras ventanas);
//! - varios agentes no actúan a la vez sobre la misma ventana (`locks`);
//! - los atajos de teclado solo existen si se permiten en Ajustes (`--keyboard`).
//!
//! Este archivo es común a todas las plataformas (catálogo, formato y servidor
//! MCP); el motor de Windows está en `uia.rs` y el de Linux en `atspi.rs`.
use anyhow::Result;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::io::{BufRead, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

#[cfg(windows)]
mod highlight;
pub mod keys;
pub mod locks;
#[cfg(windows)]
mod uia;
#[cfg(target_os = "linux")]
mod atspi;

/// Herramientas de lectura (todas, también al planificar).
pub const READ_TOOLS: [&str; 6] = ["snapshot", "find", "get", "list_windows", "wait", "status"];
/// Acciones semánticas, sin ratón ni teclado físicos. Las variantes de una
/// misma acción van como argumento (`toggle` con `state`, `click` con `button`…):
/// menos herramientas que describir al modelo en cada sesión.
pub const ACTION_TOOLS: [&str; 10] = ["click", "set_value", "toggle", "expand", "select", "scroll", "scroll_to", "launch", "window", "batch"];

/// Lo que puede ir dentro de `a11y_batch` (además de `press` si el teclado está permitido).
pub const BATCH_STEPS: [&str; 10] = ["click", "set_value", "toggle", "expand", "select", "scroll", "scroll_to", "window", "wait", "find"];
pub const MAX_BATCH: usize = 12;

/// Teclado real: solo con el permiso de Ajustes y en modo completo.
pub const KEYBOARD_TOOLS: [&str; 1] = ["press"];

/// Error de una herramienta: un código estable para el agente y una explicación.
#[derive(Debug, Clone, PartialEq)]
pub struct ToolError {
    pub code: &'static str,
    pub message: String,
}
impl ToolError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
    }
}
pub type ToolResult = std::result::Result<String, ToolError>;

/// Un motor de accesibilidad: recibe el nombre sin prefijo (`snapshot`) y sus
/// argumentos. `cancel` se activa si el agente cancela la llamada.
pub trait Engine {
    fn call(&mut self, tool: &str, args: &Value, cancel: &AtomicBool) -> ToolResult;
}

fn allowed(tool: &str, mode: &str, keyboard: bool) -> bool {
    READ_TOOLS.contains(&tool)
        || (mode == "full" && (ACTION_TOOLS.contains(&tool) || (keyboard && KEYBOARD_TOOLS.contains(&tool))))
}

/// Por qué no se puede correr un lote en esta sesión, o None si se puede.
pub fn batch_problem(args: &Value, mode: &str, keyboard: bool) -> Option<String> {
    let Some(steps) = args["steps"].as_array().filter(|steps| (1..=MAX_BATCH).contains(&steps.len())) else {
        return Some(format!("steps must list 1 to {MAX_BATCH} steps, each {{tool, ...its arguments}}."));
    };
    for (index, step) in steps.iter().enumerate() {
        let tool = step["tool"].as_str().unwrap_or("");
        let usable = (BATCH_STEPS.contains(&tool) || KEYBOARD_TOOLS.contains(&tool)) && allowed(tool, mode, keyboard);
        if !usable {
            return Some(format!("steps[{index}]: {tool:?} cannot run in a batch here. Use {}.", BATCH_STEPS.join(", ")));
        }
    }
    None
}

// --- Catálogo ----------------------------------------------------------------------

/// Ejemplos de apps de esta plataforma para las descripciones.
#[cfg(not(target_os = "linux"))]
const APP_EXAMPLE: &str = "Process name (notepad)";
#[cfg(target_os = "linux")]
const APP_EXAMPLE: &str = "Process or app name (gnome-text-editor, nautilus)";
#[cfg(not(target_os = "linux"))]
const LAUNCH_DESCRIPTION: &str = "Open an application (notepad, calc, a path or a document) without activating it when the app allows, and report its new windows.";
#[cfg(target_os = "linux")]
const LAUNCH_DESCRIPTION: &str = "Open an application (a program such as gnome-text-editor, an installed app name such as Calculator, a path or a document) and report its new windows.";
#[cfg(not(target_os = "linux"))]
const PRESS_DESCRIPTION: &str = "Send a real key combination (ctrl+s, alt+f, enter) to a window or element. It briefly brings the window to the front and uses the keyboard, only while the user is not typing, then returns the focus. Use it only when no semantic action exists.";
#[cfg(target_os = "linux")]
const PRESS_DESCRIPTION: &str = "Send a real key combination (ctrl+s, alt+f, enter) to a window or element. Only into the window that is already active (Linux cannot bring windows to the front) and only while the user is not typing; the first time, the desktop asks the user for permission. Use it only when no semantic action exists.";
#[cfg(not(target_os = "linux"))]
const SCROLL_DESCRIPTION: &str = "Scroll to read or reach more: pass ref_id to scroll its nearest scrollable container, or a window (window_id/app) to scroll its \
main content. Uses the app's own scrolling, or mouse-wheel messages sent to the window when it has none (the user's pointer never moves). The \
response lists what came into view, with refs.";
#[cfg(target_os = "linux")]
const SCROLL_DESCRIPTION: &str = "Scroll to read or reach more: pass ref_id to scroll its nearest scrollable container, or a window (window_id/app) to scroll its \
main content. Uses the app's accessible scroll bars, or brings the next off-screen element into view when there are none (web pages); the user's \
pointer never moves. The response lists what came into view, with refs.";
#[cfg(not(target_os = "linux"))]
const SCROLL_TO_DESCRIPTION: &str = "Bring an element that is off screen into view (any ref; uses mouse-wheel messages when the app has no scroll support) and report \
what came into view.";
#[cfg(target_os = "linux")]
const SCROLL_TO_DESCRIPTION: &str = "Bring an element that is off screen into view (any ref; uses the app's own scrolling or its panel's scroll bar) and report what \
came into view.";

fn window_target() -> Value {
    json!({
        "window_id": {"type": "string", "description": "Window id from a11y_list_windows, e.g. w1A2B3C."},
        "app": {"type": "string", "description": format!("{APP_EXAMPLE} or part of the window title, when it matches one window.")}
    })
}

fn with(mut base: Value, extra: Value) -> Value {
    if let (Some(base), Some(extra)) = (base.as_object_mut(), extra.as_object()) {
        for (key, value) in extra {
            base.insert(key.clone(), value.clone());
        }
    }
    base
}

fn reference() -> Value {
    json!({"ref_id": {"type": "string", "description": "Element ref from the latest a11y_snapshot or a11y_find, e.g. @s3:e5."}})
}

fn definition(tool: &str) -> (&'static str, Value, Vec<&'static str>) {
    let ref_only = (reference(), vec!["ref_id"]);
    let (description, properties, required): (&'static str, Value, Vec<&'static str>) = match tool {
        "list_windows" => ("List visible top-level windows: id, process, title and state. Start here.", json!({"app": {"type": "string", "description": "Filter by process name or title text."}}), vec![]),
        "snapshot" => ("Accessibility tree of one window as compact text. Each actionable element has a @ref and its actions in brackets. Values are clipped; read a full one with a11y_get. format:\"text\" returns only the visible text, without refs: the cheapest way to read a page or document, including what is beyond the window.",
            with(window_target(), json!({
                "root": {"type": "string", "description": "Ref of a container to read only that part."},
                "interactive_only": {"type": "boolean", "description": "Only actionable or editable elements (default true). False also lists labels and text."},
                "format": {"type": "string", "enum": ["tree", "text"], "description": "tree (default) or text."},
                "offset": {"type": "integer", "description": "With format text: lines to skip, to read the next part."},
                "max_depth": {"type": "integer", "description": "Tree depth limit (default 25)."},
                "max_elements": {"type": "integer", "description": "Element limit, or line limit with format text (default 300, max 1000)."}
            })), vec![]),
        "find" => ("Find elements in one window by role and/or name (case-insensitive substring). Returns refs.",
            with(window_target(), json!({
                "role": {"type": "string", "description": "button, edit, checkbox, combobox, listitem, menuitem, tabitem, hyperlink, document…"},
                "name": {"type": "string", "description": "Text contained in the element name."},
                "limit": {"type": "integer", "description": "Maximum results (default 20)."}
            })), vec![]),
        "get" => ("Read one element: its value, full text (documents), name, states or bounds. Password fields are never read.",
            with(reference(), json!({"property": {"type": "string", "enum": ["all", "value", "text", "name", "states", "bounds"], "description": "Default all."}})), vec!["ref_id"]),
        "wait" => ("Wait a number of milliseconds, or until an element (role/name) appears or disappears in a window, or until a window appears.",
            with(window_target(), json!({
                "ms": {"type": "integer", "description": "Plain wait, at most 10000."},
                "role": {"type": "string"}, "name": {"type": "string"},
                "gone": {"type": "boolean", "description": "Wait until it disappears."},
                "timeout_ms": {"type": "integer", "description": "Default 5000, at most 15000."}
            })), vec![]),
        "status" => ("Engine state: platform, whether actions keep focus, and how long ago the user last used mouse or keyboard.", json!({}), vec![]),
        "click" => ("Activate an element semantically (invoke, toggle, select or expand) without moving the mouse. button:\"right\" opens its context menu instead.",
            with(reference(), json!({"button": {"type": "string", "enum": ["left", "right"]}})), vec!["ref_id"]),
        "set_value" => ("Write into an editable element and verify the application kept it: replaces the value, or appends with append:true; an empty value clears it. Fields that only accept real keystrokes are refused.",
            with(reference(), json!({"value": {"type": "string"}, "append": {"type": "boolean"}})), vec!["ref_id", "value"]),
        "toggle" => ("Flip a checkbox or switch, or set it with state (no change if it already is), and verify.",
            with(reference(), json!({"state": {"type": "string", "enum": ["on", "off"]}})), vec!["ref_id"]),
        "expand" => ("Expand a menu, tree item, combobox or disclosure (collapse:true collapses it) and verify.",
            with(reference(), json!({"collapse": {"type": "boolean"}})), vec!["ref_id"]),
        "select" => ("Select a list, tab or tree item ref, or pass value to choose an option of a list or combobox by its name.",
            with(reference(), json!({"value": {"type": "string", "description": "Option name inside the referenced list or combobox."}})), vec!["ref_id"]),
        "scroll" => (SCROLL_DESCRIPTION,
            with(with(window_target(), reference()), json!({
                "direction": {"type": "string", "enum": ["up", "down", "left", "right"]},
                "amount": {"type": "integer", "description": "Steps, 1 to 20 (default 3 small steps, or 1 page)."},
                "page": {"type": "boolean", "description": "Steps of about a screen instead of a few lines."},
                "to": {"type": "string", "enum": ["top", "bottom"], "description": "Jump to the top or the bottom instead of a direction."}
            })), vec![]),
        "scroll_to" => (SCROLL_TO_DESCRIPTION, ref_only.0, ref_only.1),
        "launch" => (LAUNCH_DESCRIPTION,
            json!({"app": {"type": "string"}, "args": {"type": "array", "items": {"type": "string"}}}), vec!["app"]),
        "window" => ("Minimize, maximize or restore a window, or close it as its close button would (it may show a save dialog).",
            with(window_target(), json!({"action": {"type": "string", "enum": ["minimize", "maximize", "restore", "close"]}})), vec!["action"]),
        "batch" => ("Run up to 12 steps in order in one call, with a single change report at the end: for example several set_value and a click to fill and \
send a form. Each step is {tool, ...that tool's arguments}, e.g. {\"tool\":\"set_value\",\"ref_id\":\"@s2:e4\",\"value\":\"Ana\"}. Steps: click, set_value, \
toggle, expand, select, scroll, scroll_to, window, wait, find (and press when allowed). Stops at the first failure and lists the steps that completed.",
            json!({"steps": {"type": "array", "minItems": 1, "maxItems": 12, "items": {"type": "object", "properties": {"tool": {"type": "string"}}, "required": ["tool"]}}}), vec!["steps"]),
        "press" => (PRESS_DESCRIPTION,
            with(with(window_target(), reference()), json!({"keys": {"type": "string", "description": "For example ctrl+s, ctrl+shift+n, alt+f4, enter, f5. No Windows-key shortcuts."}})), vec!["keys"]),
        _ => ("", json!({}), vec![]),
    };
    let schema = json!({"type": "object", "properties": properties, "required": required, "additionalProperties": false});
    (description, schema, required)
}

/// Herramientas publicadas en este modo, con el prefijo `a11y_`.
pub fn tools(mode: &str, keyboard: bool) -> Vec<Value> {
    READ_TOOLS
        .iter()
        .chain(ACTION_TOOLS.iter())
        .chain(KEYBOARD_TOOLS.iter())
        .filter(|tool| allowed(tool, mode, keyboard))
        .map(|tool| {
            let (description, schema, _) = definition(tool);
            let read_only = READ_TOOLS.contains(tool);
            json!({"name": format!("{}{tool}", crate::a11y_mcp::PREFIX), "description": description, "inputSchema": schema,
                "annotations": {"readOnlyHint": read_only, "destructiveHint": !read_only, "idempotentHint": false, "openWorldHint": true}})
        })
        .collect()
}

pub fn instructions(mode: &str, keyboard: bool) -> String {
    let permissions = if mode == "plan" {
        "This process is read-only: only observation tools are available."
    } else if keyboard {
        "Actions follow the host agent's permission policy. a11y_press uses the real keyboard for shortcuts such as ctrl+s; prefer menus and buttons when they exist."
    } else {
        "Actions follow the host agent's permission policy. Keyboard shortcuts are disabled; use menus and buttons."
    };
    format!(
        "Trex accessibility engine (experimental) operates desktop apps through the operating system accessibility tree. It never moves the user's \
mouse, never types on their keyboard and never brings windows to the front, so the user can keep working. Loop: a11y_list_windows, then \
a11y_snapshot of one window (compact text; each line is `@ref role \"name\" states [actions]`; line breaks inside text appear as ⏎), act on a \
fresh @ref, and read the result in the tool response: state changes are verified, and it lists what changed (new elements with refs, new \
windows, changed values or focus), so use those refs directly instead of taking another snapshot. Several actions in a row (filling a form) \
go in one a11y_batch call. To read a page or document use a11y_snapshot with format:\"text\" (no refs, much shorter); to reach content beyond \
the window (long lists, hidden bars) use a11y_scroll or a11y_scroll_to: they report what came into view. Refs expire after a few snapshots. \
USER_ACTIVE means the user kept working in that window: wait (a11y_wait) and retry. WINDOW_BUSY means another Trex agent is using that window. NOT_KEPT means the app did not keep \
a value: do not claim success. NOT_EXPOSED means the app is open but hidden from accessibility: tell the user what the message says. Never repeat an uncertain action automatically. Snapshots include visible text: never repeat secrets. Never use \
the clipboard, shell commands or files as a workaround to put text into an app; if a field refuses text, explain it. {permissions}"
    )
}

// --- Formato -----------------------------------------------------------------------

/// Unos 10 000 tokens: lo que pase se recorta con un aviso para acotar la consulta.
const MAX_RESULT_CHARS: usize = 40_000;

/// Una respuesta enorme (un snapshot sin límites de una app gigante) se recorta.
pub fn clip_result(text: String) -> String {
    let total = text.chars().count();
    if total <= MAX_RESULT_CHARS {
        return text;
    }
    let kept: String = text.chars().take(MAX_RESULT_CHARS).collect();
    format!("{kept}
[Trex: result truncated from {total} to {MAX_RESULT_CHARS} characters. Narrow it with root, max_depth, max_elements or a11y_find.]")
}

/// Saltos de línea de cualquier sistema (`\r\n`, `\r` del Bloc de notas, `\n`) como `\n`.
pub fn lines(text: &str) -> String {
    text.replace("\r\n", "\n").replace('\r', "\n")
}

/// Texto entre comillas, en una línea y recortado: `"Guardar…(1204 chars)"`.
/// Los saltos de línea se ven como ⏎ (no se borran: el agente creería que se perdieron).
pub fn quote(text: &str, max: usize) -> String {
    let flat = lines(text).replace('\n', "⏎");
    let total = flat.chars().count();
    let shown: String = flat.chars().take(max).collect();
    let mut quoted = serde_json::to_string(&shown).unwrap_or_default();
    if total > max {
        quoted.pop();
        quoted.push_str(&format!("…({total} chars)\""));
    }
    quoted
}

/// Un elemento del árbol, ya resuelto.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Node {
    pub depth: usize,
    pub reference: Option<String>,
    pub role: &'static str,
    pub name: String,
    pub value: Option<String>,
    pub states: Vec<&'static str>,
    pub actions: Vec<&'static str>,
}

/// `  - @s3:e5 edit "Texto" value="hola" focused [set_value]`
pub fn format_node(node: &Node) -> String {
    let mut line = format!("{}- ", "  ".repeat(node.depth));
    if let Some(reference) = &node.reference {
        line.push_str(reference);
        line.push(' ');
    }
    line.push_str(node.role);
    if !node.name.trim().is_empty() {
        line.push(' ');
        line.push_str(&quote(node.name.trim(), 80));
    }
    if let Some(value) = &node.value {
        line.push_str(" value=");
        line.push_str(&quote(value, 120));
    }
    for state in &node.states {
        line.push(' ');
        line.push_str(state);
    }
    if !node.actions.is_empty() {
        line.push_str(&format!(" [{}]", node.actions.join(",")));
    }
    line
}

// --- Servidor MCP ------------------------------------------------------------------

const PROTOCOLS: [&str; 4] = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

fn respond(output: &mut impl Write, message: &Value) -> Result<()> {
    serde_json::to_writer(&mut *output, message)?;
    output.write_all(b"\n")?;
    output.flush()?;
    Ok(())
}

/// Lo que está atendiendo el motor y lo que se canceló antes de empezar.
#[derive(Default)]
struct Flight {
    current: Option<String>,
    cancelled: HashSet<String>,
}

/// Atiende peticiones MCP por líneas hasta que se cierre la entrada.
///
/// El motor vive en su propio hilo (UI Automation es COM; AT-SPI, su propio
/// runtime de D-Bus): este hilo sigue
/// leyendo mientras una acción tarda, para atender `ping`, la lista de
/// herramientas y las cancelaciones. Una llamada cancelada no responde.
pub fn serve_with<E, F>(factory: F, mode: &str, keyboard: bool, input: impl BufRead, output: impl Write + Send + 'static) -> Result<()>
where
    E: Engine,
    F: FnOnce() -> Result<E> + Send + 'static,
{
    serve_with_grace(factory, mode, keyboard, input, output, SHUTDOWN_GRACE)
}

/// Lo que espera el servidor, al cerrarse la entrada, a que el hilo del motor termine lo pendiente.
const SHUTDOWN_GRACE: Duration = Duration::from_secs(3);

/// `serve_with` con la espera de cierre explícita. Solo dura tanto como haga falta: sale en cuanto
/// el hilo del motor termina; las pruebas la alargan para que una máquina saturada no les pierda respuestas.
fn serve_with_grace<E, F>(factory: F, mode: &str, keyboard: bool, input: impl BufRead, output: impl Write + Send + 'static, grace: Duration) -> Result<()>
where
    E: Engine,
    F: FnOnce() -> Result<E> + Send + 'static,
{
    let output = Arc::new(Mutex::new(output));
    let flight = Arc::new(Mutex::new(Flight::default()));
    let cancel = Arc::new(AtomicBool::new(false));
    let (jobs, receiver) = mpsc::channel::<(Value, String, Value)>();
    let worker = {
        let (output, flight, cancel) = (output.clone(), flight.clone(), cancel.clone());
        std::thread::spawn(move || {
            let mut engine = factory().map_err(|error| error.to_string());
            for (id, tool, args) in receiver {
                let key = id.to_string();
                {
                    let mut flight = flight.lock().unwrap();
                    if flight.cancelled.remove(&key) {
                        continue;
                    }
                    flight.current = Some(key.clone());
                }
                cancel.store(false, Ordering::SeqCst);
                let result = match &mut engine {
                    Ok(engine) => engine.call(&tool, &args, &cancel),
                    Err(error) => Err(ToolError::new("ENGINE_UNAVAILABLE", error.clone())),
                };
                let cancelled = {
                    let mut flight = flight.lock().unwrap();
                    flight.current = None;
                    flight.cancelled.remove(&key)
                };
                if cancelled {
                    continue;
                }
                let result = match result {
                    Ok(text) => json!({"content": [{"type": "text", "text": clip_result(text)}], "isError": false}),
                    Err(error) => json!({"content": [{"type": "text", "text": clip_result(format!("{}: {}", error.code, error.message))}], "isError": true}),
                };
                let _ = respond(&mut *output.lock().unwrap(), &json!({"jsonrpc": "2.0", "id": id, "result": result}));
            }
        })
    };
    for line in input.lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let Ok(message) = serde_json::from_str::<Value>(&line) else {
            respond(&mut *output.lock().unwrap(), &json!({"jsonrpc": "2.0", "id": null, "error": {"code": -32700, "message": "Invalid JSON"}}))?;
            continue;
        };
        let method = message["method"].as_str().unwrap_or("");
        if method == "notifications/cancelled" {
            let request = message["params"]["requestId"].to_string();
            let mut flight = flight.lock().unwrap();
            if flight.current.as_deref() == Some(request.as_str()) {
                cancel.store(true, Ordering::SeqCst);
            }
            flight.cancelled.insert(request);
            continue;
        }
        // Las demás notificaciones (sin id) no tienen respuesta.
        let Some(id) = message.get("id").cloned() else { continue };
        let reply = |result: Value| json!({"jsonrpc": "2.0", "id": id, "result": result});
        let fail = |code: i32, text: String| json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": text}});
        let response = match method {
            "initialize" => {
                let asked = message["params"]["protocolVersion"].as_str().unwrap_or("");
                let protocol = if PROTOCOLS.contains(&asked) { asked } else { "2025-06-18" };
                reply(json!({"protocolVersion": protocol, "capabilities": {"tools": {}},
                    "serverInfo": {"name": "trex-a11y", "version": format!("trex {}", env!("CARGO_PKG_VERSION"))},
                    "instructions": instructions(mode, keyboard)}))
            }
            "ping" => reply(json!({})),
            "tools/list" => reply(json!({"tools": tools(mode, keyboard)})),
            "tools/call" => {
                let name = message["params"]["name"].as_str().unwrap_or("");
                match name.strip_prefix(crate::a11y_mcp::PREFIX).filter(|tool| allowed(tool, mode, keyboard)) {
                    None => fail(-32602, format!("Tool {name} is not available in this accessibility session.")),
                    Some(tool) => {
                        let args = message["params"].get("arguments").filter(|value| value.is_object()).cloned().unwrap_or_else(|| json!({}));
                        // Cada paso de un lote pasa el mismo filtro que una llamada suelta.
                        if let Some(problem) = (tool == "batch").then(|| batch_problem(&args, mode, keyboard)).flatten() {
                            reply(json!({"content": [{"type": "text", "text": format!("INVALID_ARGS: {problem}")}], "isError": true}))
                        } else {
                            let _ = jobs.send((id.clone(), tool.to_owned(), args));
                            continue;
                        }
                    }
                }
            }
            other => fail(-32601, format!("Unknown method {other}")),
        };
        respond(&mut *output.lock().unwrap(), &response)?;
    }
    // Entrada cerrada: lo pendiente termina (o se abandona si sigue bloqueado al salir).
    drop(jobs);
    cancel.store(true, Ordering::SeqCst);
    let deadline = Instant::now() + grace;
    while !worker.is_finished() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(20));
    }
    Ok(())
}

/// El motor de esta plataforma, si Trex lo tiene.
pub fn available() -> bool {
    cfg!(any(windows, target_os = "linux"))
}

/// Por qué el motor no se puede usar ahora en este equipo, o None si se puede.
/// No abre aplicaciones ni lee la pantalla.
pub fn unavailable_reason() -> Option<&'static str> {
    #[cfg(windows)]
    return None;
    #[cfg(target_os = "linux")]
    return atspi::probe();
    #[cfg(not(any(windows, target_os = "linux")))]
    return Some("unsupportedPlatform");
}

pub fn serve(mode: &str, keyboard: bool) -> Result<()> {
    anyhow::ensure!(matches!(mode, "plan" | "full"), "accessibility MCP mode must be plan or full");
    #[cfg(windows)]
    {
        let stdin = std::io::stdin();
        serve_with(move || uia::UiaEngine::new(keyboard), mode, keyboard, stdin.lock(), std::io::stdout())
    }
    #[cfg(target_os = "linux")]
    {
        let stdin = std::io::stdin();
        serve_with(move || atspi::AtspiEngine::new(keyboard), mode, keyboard, stdin.lock(), std::io::stdout())
    }
    #[cfg(not(any(windows, target_os = "linux")))]
    anyhow::bail!("the Trex accessibility engine is only available on Windows and Linux")
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Echo(Arc<Mutex<Vec<String>>>);
    impl Engine for Echo {
        fn call(&mut self, tool: &str, args: &Value, cancel: &AtomicBool) -> ToolResult {
            self.0.lock().unwrap().push(tool.to_owned());
            if tool == "click" {
                return Err(ToolError::new("USER_ACTIVE", "the user is working in that window"));
            }
            if tool == "wait" {
                // Una espera larga que solo termina si se cancela.
                while !cancel.load(Ordering::SeqCst) {
                    std::thread::sleep(Duration::from_millis(5));
                }
                return Err(ToolError::new("CANCELLED", "cancelled"));
            }
            Ok(format!("{tool} {args}"))
        }
    }

    #[derive(Clone, Default)]
    struct Shared(Arc<Mutex<Vec<u8>>>);
    impl Write for Shared {
        fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(data);
            Ok(data.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    fn run_with(mode: &str, keyboard: bool, requests: &[Value]) -> (Vec<Value>, Vec<String>) {
        let input = requests.iter().map(Value::to_string).collect::<Vec<_>>().join("\n");
        let output = Shared::default();
        let calls = Arc::new(Mutex::new(Vec::new()));
        let engine_calls = calls.clone();
        // The server stops waiting for its engine thread after a grace period; a CI runner that freezes
        // for seconds must not make it give up before the replies of the requests above are written.
        serve_with_grace(move || Ok(Echo(engine_calls)), mode, keyboard, input.as_bytes(), output.clone(), Duration::from_secs(60)).unwrap();
        let text = String::from_utf8(output.0.lock().unwrap().clone()).unwrap();
        let mut replies: Vec<Value> = text.lines().map(|line| serde_json::from_str(line).unwrap()).collect();
        replies.sort_by_key(|reply| reply["id"].to_string());
        let calls = calls.lock().unwrap().clone();
        (replies, calls)
    }

    fn run(mode: &str, requests: &[Value]) -> (Vec<Value>, Vec<String>) {
        run_with(mode, false, requests)
    }

    #[test]
    fn plan_publishes_only_reads_and_shortcuts_need_the_setting() {
        assert!(READ_TOOLS.iter().all(|tool| !ACTION_TOOLS.contains(tool)));
        let huge = clip_result("é".repeat(MAX_RESULT_CHARS + 10));
        assert!(huge.starts_with(&"é".repeat(MAX_RESULT_CHARS)) && huge.contains("truncated"), "huge results are clipped");
        assert_eq!(clip_result("ok".into()), "ok");
        let plan: Vec<_> = tools("plan", true).iter().map(|tool| tool["name"].as_str().unwrap().to_owned()).collect();
        assert_eq!(plan.len(), READ_TOOLS.len(), "plan never gets actions, not even the keyboard");
        assert!(plan.iter().all(|name| name.starts_with("a11y_")));
        assert!(KEYBOARD_TOOLS.iter().all(|tool| !ACTION_TOOLS.contains(tool) && !READ_TOOLS.contains(tool)));
        assert!(!tools("full", false).iter().any(|tool| tool["name"] == "a11y_press"), "shortcuts need the setting");
        assert!(tools("full", true).iter().any(|tool| tool["name"] == "a11y_press"));
        let full = tools("full", false);
        assert_eq!(full.len(), READ_TOOLS.len() + ACTION_TOOLS.len());
        assert!(full.iter().all(|tool| !tool["description"].as_str().unwrap().is_empty()));
        assert!(full.iter().any(|tool| tool["name"] == "a11y_set_value" && tool["inputSchema"]["required"] == json!(["ref_id", "value"])));
        // Unos 3 500 tokens de esquemas en modo completo.
        let size = serde_json::to_string(&full).unwrap().len();
        assert!(size < 14_000, "catalog is {size} bytes");
    }

    #[test]
    fn the_server_answers_and_enforces_the_mode() {
        let (replies, calls) = run("plan", &[
            json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-11-25"}}),
            json!({"jsonrpc": "2.0", "method": "notifications/initialized"}),
            json!({"jsonrpc": "2.0", "id": 2, "method": "tools/list"}),
            json!({"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "a11y_snapshot", "arguments": {"app": "notepad"}}}),
            json!({"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {"name": "a11y_click", "arguments": {"ref_id": "@s1:e1"}}}),
        ]);
        assert_eq!(replies.len(), 4, "notifications get no reply");
        // Respuestas ordenadas por id: 1 initialize, 2 tools/list, 3 snapshot, 4 click rechazado.
        assert_eq!(replies[0]["result"]["protocolVersion"], "2025-11-25");
        assert_eq!(replies[0]["result"]["serverInfo"]["name"], "trex-a11y");
        assert!(replies[0]["result"]["instructions"].as_str().unwrap().contains("read-only"));
        assert_eq!(replies[1]["result"]["tools"].as_array().unwrap().len(), READ_TOOLS.len());
        assert_eq!(replies[2]["result"]["content"][0]["text"], "snapshot {\"app\":\"notepad\"}");
        assert_eq!(replies[3]["error"]["code"], -32602, "plan never reaches an action");
        assert_eq!(calls, ["snapshot"]);
        let (replies, _) = run("full", &[json!({"jsonrpc": "2.0", "id": "x", "method": "tools/call", "params": {"name": "a11y_click", "arguments": {}}})]);
        assert_eq!(replies[0]["result"]["isError"], true);
        assert_eq!(replies[0]["result"]["content"][0]["text"], "USER_ACTIVE: the user is working in that window");
        let (replies, _) = run_with("full", false, &[json!({"jsonrpc": "2.0", "id": 9, "method": "tools/call", "params": {"name": "a11y_press", "arguments": {"keys": "ctrl+s"}}})]);
        assert_eq!(replies[0]["error"]["code"], -32602, "no keyboard without the setting");
    }

    #[test]
    fn a_slow_call_does_not_block_the_server_and_can_be_cancelled() {
        let (replies, calls) = run("plan", &[
            json!({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "a11y_wait", "arguments": {}}}),
            json!({"jsonrpc": "2.0", "id": 2, "method": "ping"}),
            json!({"jsonrpc": "2.0", "method": "notifications/cancelled", "params": {"requestId": 1}}),
            json!({"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "a11y_status", "arguments": {}}}),
        ]);
        let ids: Vec<String> = replies.iter().map(|reply| reply["id"].to_string()).collect();
        assert_eq!(ids, ["2", "3"], "the cancelled call gets no reply and the next one still runs");
        // Según cuándo llegue la cancelación, la espera ni empieza o se corta a mitad.
        assert!(calls == ["wait", "status"] || calls == ["status"], "{calls:?}");
    }

    #[test]
    fn nodes_are_compact_lines() {
        let node = Node { depth: 2, reference: Some("@s3:e5".into()), role: "edit", name: "Texto\nlargo".into(),
            value: Some("x".repeat(130)), states: vec!["focused"], actions: vec!["set_value"] };
        let line = format_node(&node);
        assert!(line.starts_with("    - @s3:e5 edit \"Texto⏎largo\" value=\""), "{line}");
        assert!(line.ends_with("…(130 chars)\" focused [set_value]"), "{line}");
        // Los saltos del Bloc de notas (\r) se ven, no desaparecen.
        assert_eq!(quote("Título\r\rVerso\r\nOtro\nFin", 80), "\"Título⏎⏎Verso⏎Otro⏎Fin\"");
        assert_eq!(lines("a\r\rb\r\nc"), "a\n\nb\nc");
        assert_eq!(format_node(&Node { role: "text", name: "Hola".into(), ..Node::default() }), "- text \"Hola\"");
        assert_eq!(quote("comillas \"y\" barra \\", 80), r#""comillas \"y\" barra \\""#);
    }
}
