//! Motor de accesibilidad propio de Trex (experimental).
//!
//! Lee y maneja las aplicaciones a través del árbol de accesibilidad del sistema
//! (UI Automation en Windows), sin mover el ratón ni escribir con el teclado de
//! la persona. Diferencias con agent-desktop, que sigue disponible como motor
//! externo:
//!
//! - va dentro de `trex-agent`: nada que instalar, ni Node ni npm;
//! - las acciones nunca traen la ventana al frente (`AutoSetFocus` desactivado)
//!   y se rechazan si la persona está usando esa misma ventana en ese momento;
//! - cada acción con estado se comprueba releyendo el control poco después, en
//!   vez de dar por bueno lo que el control acepta un instante;
//! - los campos de contraseña nunca se leen, los valores largos se recortan y no
//!   se escribe nada en disco: las referencias viven en memoria;
//! - el árbol se devuelve como texto compacto con referencias `@s1:e4`, mucho
//!   más corto que JSON.
//!
//! Este archivo es común a todas las plataformas (catálogo, formato y servidor
//! MCP); el motor de Windows está en `uia.rs`.
use anyhow::Result;
use serde_json::{json, Value};
use std::io::{BufRead, Write};

#[cfg(windows)]
mod uia;

/// Herramientas de lectura (todas, también al planificar).
pub const READ_TOOLS: [&str; 6] = ["snapshot", "find", "get", "list_windows", "wait", "status"];
/// Acciones semánticas, sin ratón ni teclado físicos.
pub const ACTION_TOOLS: [&str; 18] = [
    "click", "right_click", "set_value", "type", "clear", "toggle", "check", "uncheck", "expand", "collapse", "select",
    "scroll", "scroll_to", "launch", "close_app", "minimize", "maximize", "restore",
];

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

/// Un motor de accesibilidad: recibe el nombre sin prefijo (`snapshot`) y sus argumentos.
pub trait Engine {
    fn call(&mut self, tool: &str, args: &Value) -> ToolResult;
}

fn allowed(tool: &str, mode: &str) -> bool {
    READ_TOOLS.contains(&tool) || (mode == "full" && ACTION_TOOLS.contains(&tool))
}

// --- Catálogo ----------------------------------------------------------------------

fn window_target() -> Value {
    json!({
        "window_id": {"type": "string", "description": "Window id from a11y_list_windows, e.g. w1A2B3C."},
        "app": {"type": "string", "description": "Process name (notepad) or part of the window title, when it matches one window."}
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
        "snapshot" => ("Accessibility tree of one window as compact text. Each actionable element has a @ref and its actions in brackets. Values are clipped; read a full one with a11y_get.",
            with(window_target(), json!({
                "root": {"type": "string", "description": "Ref of a container to read only that part."},
                "interactive_only": {"type": "boolean", "description": "Only actionable or editable elements (default true). False also lists labels and text."},
                "max_depth": {"type": "integer", "description": "Tree depth limit (default 25)."},
                "max_elements": {"type": "integer", "description": "Element limit (default 300, max 1000)."}
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
        "click" => ("Activate an element semantically (invoke, toggle, select or expand) without moving the mouse.", ref_only.0, ref_only.1),
        "right_click" => ("Open the element's context menu semantically; then snapshot the menu.", ref_only.0, ref_only.1),
        "set_value" => ("Replace the value of an editable element and verify the application kept it.",
            with(reference(), json!({"value": {"type": "string"}})), vec!["ref_id", "value"]),
        "type" => ("Append text to the value of an editable element and verify it was kept. Fields that only accept real keystrokes are refused.",
            with(reference(), json!({"text": {"type": "string"}})), vec!["ref_id", "text"]),
        "clear" => ("Empty an editable element and verify it.", ref_only.0, ref_only.1),
        "toggle" => ("Flip a checkbox or switch and verify the new state.", ref_only.0, ref_only.1),
        "check" => ("Ensure a checkbox or switch is on (no change if it already is).", ref_only.0, ref_only.1),
        "uncheck" => ("Ensure a checkbox or switch is off (no change if it already is).", ref_only.0, ref_only.1),
        "expand" => ("Expand a menu, tree item, combobox or disclosure and verify it.", ref_only.0, ref_only.1),
        "collapse" => ("Collapse a menu, tree item, combobox or disclosure and verify it.", ref_only.0, ref_only.1),
        "select" => ("Select a list, tab or tree item ref, or pass value to choose an option of a list or combobox by its name.",
            with(reference(), json!({"value": {"type": "string", "description": "Option name inside the referenced list or combobox."}})), vec!["ref_id"]),
        "scroll" => ("Scroll the element or its nearest scrollable container.",
            with(reference(), json!({"direction": {"type": "string", "enum": ["up", "down", "left", "right"]}, "amount": {"type": "integer", "description": "Small steps, 1 to 20 (default 3)."}})), vec!["ref_id", "direction"]),
        "scroll_to" => ("Scroll an element into view.", ref_only.0, ref_only.1),
        "launch" => ("Open an application (notepad, calc, a path or a document) without activating it when the app allows, and report its new windows.",
            json!({"app": {"type": "string"}, "args": {"type": "array", "items": {"type": "string"}}}), vec!["app"]),
        "close_app" => ("Ask a window to close, as its close button would (it may show a save dialog).", window_target(), vec![]),
        "minimize" => ("Minimize a window.", window_target(), vec![]),
        "maximize" => ("Maximize a window.", window_target(), vec![]),
        "restore" => ("Restore a minimized or maximized window.", window_target(), vec![]),
        _ => ("", json!({}), vec![]),
    };
    let schema = json!({"type": "object", "properties": properties, "required": required, "additionalProperties": false});
    (description, schema, required)
}

/// Herramientas publicadas en este modo, con el prefijo `a11y_`.
pub fn tools(mode: &str) -> Vec<Value> {
    READ_TOOLS
        .iter()
        .chain(if mode == "full" { ACTION_TOOLS.iter() } else { [].iter() })
        .map(|tool| {
            let (description, schema, _) = definition(tool);
            let read_only = READ_TOOLS.contains(tool);
            json!({"name": format!("{}{tool}", crate::a11y_mcp::PREFIX), "description": description, "inputSchema": schema,
                "annotations": {"readOnlyHint": read_only, "destructiveHint": !read_only, "idempotentHint": false, "openWorldHint": true}})
        })
        .collect()
}

pub fn instructions(mode: &str) -> String {
    let permissions = if mode == "plan" {
        "This process is read-only: only observation tools are available."
    } else {
        "Actions follow the host agent's permission policy."
    };
    format!(
        "Trex accessibility engine (experimental) operates desktop apps through the operating system accessibility tree. It never moves the user's \
mouse, never types on their keyboard and never brings windows to the front, so the user can keep working. Loop: a11y_list_windows, then \
a11y_snapshot of one window (compact text; each line is `@ref role \"name\" states [actions]`), act on a fresh @ref, and read the result in the \
tool response (state changes are verified). Refs expire after a few snapshots: take a new one after the window changes. USER_ACTIVE means the \
user is working in that window right now: wait (a11y_wait) and retry. NOT_KEPT means the app did not keep a value: do not claim success. Never \
repeat an uncertain action automatically. Snapshots include visible text: never repeat secrets. Fields that only accept real keystrokes are \
refused; explain it instead of switching to other control tools unless the user asks. {permissions}"
    )
}

// --- Formato -----------------------------------------------------------------------

/// Texto entre comillas, en una línea y recortado: `"Guardar…(1204 chars)"`.
pub fn quote(text: &str, max: usize) -> String {
    let flat = text.replace('\r', "").replace('\n', "⏎");
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

/// `  - @s3:e5 edit "Texto" value="hola" focused [set_value,type]`
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

/// Atiende peticiones MCP por líneas hasta que se cierre la entrada.
pub fn serve_with(engine: &mut dyn Engine, mode: &str, input: impl BufRead, mut output: impl Write) -> Result<()> {
    for line in input.lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let Ok(message) = serde_json::from_str::<Value>(&line) else {
            respond(&mut output, &json!({"jsonrpc": "2.0", "id": null, "error": {"code": -32700, "message": "Invalid JSON"}}))?;
            continue;
        };
        // Las notificaciones (sin id) no tienen respuesta.
        let Some(id) = message.get("id").cloned() else { continue };
        let reply = |result: Value| json!({"jsonrpc": "2.0", "id": id, "result": result});
        let fail = |code: i32, text: String| json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": text}});
        let response = match message["method"].as_str().unwrap_or("") {
            "initialize" => {
                let asked = message["params"]["protocolVersion"].as_str().unwrap_or("");
                let protocol = if PROTOCOLS.contains(&asked) { asked } else { "2025-06-18" };
                reply(json!({"protocolVersion": protocol, "capabilities": {"tools": {}},
                    "serverInfo": {"name": "trex-a11y", "version": format!("trex {}", env!("CARGO_PKG_VERSION"))},
                    "instructions": instructions(mode)}))
            }
            "ping" => reply(json!({})),
            "tools/list" => reply(json!({"tools": tools(mode)})),
            "tools/call" => {
                let name = message["params"]["name"].as_str().unwrap_or("");
                match name.strip_prefix(crate::a11y_mcp::PREFIX).filter(|tool| allowed(tool, mode)) {
                    None => fail(-32602, format!("Tool {name} is not available in this accessibility session.")),
                    Some(tool) => {
                        let empty = json!({});
                        let args = message["params"].get("arguments").filter(|value| value.is_object()).unwrap_or(&empty);
                        let mut result = match engine.call(tool, args) {
                            Ok(text) => json!({"content": [{"type": "text", "text": text}], "isError": false}),
                            Err(error) => json!({"content": [{"type": "text", "text": format!("{}: {}", error.code, error.message)}], "isError": true}),
                        };
                        crate::a11y_mcp::rewrite_result(&mut result);
                        reply(result)
                    }
                }
            }
            other => fail(-32601, format!("Unknown method {other}")),
        };
        respond(&mut output, &response)?;
    }
    Ok(())
}

/// El motor de esta plataforma, si Trex lo tiene.
pub fn available() -> bool {
    cfg!(windows)
}

pub fn serve(mode: &str) -> Result<()> {
    anyhow::ensure!(matches!(mode, "plan" | "full"), "accessibility MCP mode must be plan or full");
    #[cfg(windows)]
    {
        let mut engine = uia::UiaEngine::new()?;
        let stdin = std::io::stdin();
        serve_with(&mut engine, mode, stdin.lock(), std::io::stdout().lock())
    }
    #[cfg(not(windows))]
    anyhow::bail!("the Trex accessibility engine is only available on Windows; use the agent-desktop engine")
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Echo(Vec<String>);
    impl Engine for Echo {
        fn call(&mut self, tool: &str, args: &Value) -> ToolResult {
            self.0.push(tool.to_owned());
            if tool == "click" {
                return Err(ToolError::new("USER_ACTIVE", "the user is working in that window"));
            }
            Ok(format!("{tool} {args}"))
        }
    }

    fn run(mode: &str, requests: &[Value]) -> (Vec<Value>, Vec<String>) {
        let input = requests.iter().map(Value::to_string).collect::<Vec<_>>().join("\n");
        let mut output = Vec::new();
        let mut engine = Echo(vec![]);
        serve_with(&mut engine, mode, input.as_bytes(), &mut output).unwrap();
        let replies = String::from_utf8(output).unwrap().lines().map(|line| serde_json::from_str(line).unwrap()).collect();
        (replies, engine.0)
    }

    #[test]
    fn the_catalog_is_a_subset_of_the_gateway_selection() {
        for tool in READ_TOOLS {
            assert!(crate::a11y_mcp::READ_TOOLS.contains(&tool), "{tool}");
        }
        for tool in ACTION_TOOLS {
            assert!(crate::a11y_mcp::ACTION_TOOLS.contains(&tool), "{tool}");
        }
        let plan: Vec<_> = tools("plan").iter().map(|tool| tool["name"].as_str().unwrap().to_owned()).collect();
        assert_eq!(plan.len(), READ_TOOLS.len());
        assert!(plan.iter().all(|name| name.starts_with("a11y_")));
        let full = tools("full");
        assert_eq!(full.len(), READ_TOOLS.len() + ACTION_TOOLS.len());
        assert!(full.iter().all(|tool| !tool["description"].as_str().unwrap().is_empty()));
        assert!(full.iter().any(|tool| tool["name"] == "a11y_set_value" && tool["inputSchema"]["required"] == json!(["ref_id", "value"])));
        // Bastante menos que los ~20 KB (5 000 tokens) de la selección de agent-desktop.
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
    }

    #[test]
    fn nodes_are_compact_lines() {
        let node = Node { depth: 2, reference: Some("@s3:e5".into()), role: "edit", name: "Texto\nlargo".into(),
            value: Some("x".repeat(130)), states: vec!["focused"], actions: vec!["set_value", "type"] };
        let line = format_node(&node);
        assert!(line.starts_with("    - @s3:e5 edit \"Texto⏎largo\" value=\""), "{line}");
        assert!(line.ends_with("…(130 chars)\" focused [set_value,type]"), "{line}");
        assert_eq!(format_node(&Node { role: "text", name: "Hola".into(), ..Node::default() }), "- text \"Hola\"");
        assert_eq!(quote("comillas \"y\" barra \\", 80), r#""comillas \"y\" barra \\""#);
    }
}
