//! The app executable can also run as a small, newline-delimited MCP server.
//! Reading claims a durable receipt; only the frontend acknowledges delivery.
use crate::message_queue::{list_in, read_in};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::ffi::OsString;
use std::io::{self, BufRead, Write};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

const MCP_FLAG: &str = "--trex-inbox-mcp";
const TOOL_NAME: &str = "trex_read_messages";
const TASK_TOOL: &str = "trex_update_tasks";
const MAX_LINE_BYTES: usize = 64 * 1024;
const PROTOCOL_VERSION: &str = "2025-06-18";
// Trex entrega la cola sola al terminar el turno: la herramienta es solo para
// puntos de control de trabajos largos, así se evitan peticiones extra.
const TOOL_DESCRIPTION: &str = "Lee los mensajes que el usuario dejó en cola durante este turno, en orden y con imágenes. Trex los entrega solo al terminar el turno: consúltala únicamente tras un paso importante de un trabajo largo, nunca en bucle. Sin argumentos. Procesa cada recibo una sola vez.";
// La guía completa va una sola vez en las instrucciones del desarrollador del
// chat; el servidor solo se presenta (texto estable para la caché del prompt).
const SERVER_INSTRUCTIONS: &str = "Trex chat tools: trex_update_tasks (visible task list, plan:[{step,status}], metadata only) and, when listed, trex_read_messages (queued user messages).";

struct Launch {
    data_dir: PathBuf,
    queue_id: String,
    tasks_only: bool,
}

/// Return true for every invocation of this mode, including invalid arguments,
/// so the caller never starts Tauri after a failed MCP startup.
pub fn run_if_requested() -> bool {
    let launch = match parse_args(std::env::args_os().skip(1)) {
        Ok(None) => return false,
        Ok(Some(launch)) => launch,
        Err(error) => {
            eprintln!("trex inbox MCP: {error}");
            return true;
        }
    };
    let stdin = io::stdin();
    let stdout = io::stdout();
    if let Err(error) = serve_tools(
        stdin.lock(),
        stdout.lock(),
        &launch.data_dir,
        &launch.queue_id,
        launch.tasks_only,
    ) {
        eprintln!("trex inbox MCP: {error}");
    }
    true
}

fn parse_args(mut args: impl Iterator<Item = OsString>) -> Result<Option<Launch>, String> {
    if args.next().as_deref() != Some(std::ffi::OsStr::new(MCP_FLAG)) {
        return Ok(None);
    }
    let usage = "Uso: --trex-inbox-mcp <appDataDir> <queueId>";
    let data_dir = args.next().ok_or(usage)?;
    let queue_id = args.next().ok_or(usage)?;
    let option = args.next();
    let tasks_only = option.as_deref() == Some(std::ffi::OsStr::new("--tasks-only"));
    if data_dir.is_empty() || option.is_some() && !tasks_only || args.next().is_some() {
        return Err(usage.into());
    }
    let queue_id = queue_id
        .into_string()
        .map_err(|_| "El identificador de la cola debe ser UTF-8 válido.".to_string())?;
    Ok(Some(Launch {
        data_dir: PathBuf::from(data_dir),
        queue_id,
        tasks_only,
    }))
}

#[tauri::command]
pub async fn message_queue_mcp_config(app: AppHandle, queue_id: String, tasks_only: Option<bool>) -> Result<Value, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("No se encontró la carpeta de datos de la app: {error}"))?;
    let executable = std::env::current_exe()
        .map_err(|error| format!("No se encontró el ejecutable de la app: {error}"))?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut config = mcp_config(&executable, &data_dir, &queue_id)?;
        if tasks_only == Some(true) { config["mcp_servers.trex_inbox.args"].as_array_mut().ok_or("Configuración MCP inválida.")?.push(json!("--tasks-only")); }
        Ok(config)
    })
        .await
        .map_err(|error| error.to_string())?
}

fn mcp_config(executable: &Path, data_dir: &Path, queue_id: &str) -> Result<Value, String> {
    // This validates IDs and existing storage without claiming an inbox.
    list_in(data_dir, queue_id)?;
    if !executable.is_absolute() || !data_dir.is_absolute() {
        return Err("El ejecutable y la carpeta de datos deben tener rutas absolutas.".into());
    }
    let executable = executable
        .to_str()
        .ok_or("La ruta del ejecutable no es UTF-8 válida.")?;
    let data_dir = data_dir
        .to_str()
        .ok_or("La carpeta de datos no es UTF-8 válida.")?;
    Ok(json!({
        "mcp_servers.trex_inbox.command": executable,
        "mcp_servers.trex_inbox.args": [MCP_FLAG, data_dir, queue_id],
        "mcp_servers.trex_inbox.enabled": true,
        "mcp_servers.trex_inbox.required": true,
        "mcp_servers.trex_inbox.default_tools_approval_mode": "approve"
    }))
}

enum Frame {
    Json(Vec<u8>),
    TooLarge,
}

fn task_tool() -> Value {
    json!({
        "name":TASK_TOOL,
        "description":"Publish or replace this chat's visible task list, in ordinary chats or planning mode. Mark the current step in_progress, verified work completed and unfinished work pending. At most one step can be in progress. plan:[] clears the list. This only tracks tasks: it never executes work, edits workspace files or changes permissions. Maximum 64 steps and 32 KiB of JSON arguments.",
        "inputSchema":{"type":"object","properties":{"plan":{"type":"array","maxItems":64,"items":{"type":"object","properties":{"step":{"type":"string","minLength":1,"maxLength":2000},"status":{"type":"string","enum":["pending","in_progress","completed"]}},"required":["step","status"],"additionalProperties":false}}},"required":["plan"],"additionalProperties":false},
        "annotations":{"readOnlyHint":false,"destructiveHint":false,"idempotentHint":true,"openWorldHint":false}
    })
}

fn update_tasks(args: Option<&Value>) -> Result<Value, &'static str> {
    let invalid = "Expected plan with up to 64 valid steps, at most one in_progress, and at most 32 KiB of JSON.";
    let args = args.and_then(Value::as_object).ok_or(invalid)?;
    if args.len() != 1 {
        return Err(invalid);
    }
    let plan = args.get("plan").and_then(Value::as_array).ok_or(invalid)?;
    if plan.len() > 64 || serde_json::to_vec(args).map_err(|_| invalid)?.len() > 32 * 1024 {
        return Err(invalid);
    }
    let mut active = 0;
    for entry in plan {
        let step = entry.as_object().ok_or(invalid)?;
        let title = step.get("step").and_then(Value::as_str).ok_or(invalid)?;
        let status = step.get("status").and_then(Value::as_str).ok_or(invalid)?;
        if step.len() != 2
            || title.trim().is_empty()
            || title.chars().count() > 2000
            || !["pending", "in_progress", "completed"].contains(&status)
        {
            return Err(invalid);
        }
        if status == "in_progress" {
            active += 1;
            if active > 1 {
                return Err(invalid);
            }
        }
    }
    let accepted = json!({"plan":plan});
    Ok(
        json!({"content":[{"type":"text","text":accepted.to_string()}],"structuredContent":accepted,"isError":false}),
    )
}

/// Drain an oversized line without buffering more than the input bound.
fn read_frame(reader: &mut impl BufRead) -> io::Result<Option<Frame>> {
    let mut bytes = Vec::new();
    let mut too_large = false;
    loop {
        let buffer = reader.fill_buf()?;
        if buffer.is_empty() {
            return Ok(if too_large {
                Some(Frame::TooLarge)
            } else if bytes.is_empty() {
                None
            } else {
                Some(Frame::Json(bytes))
            });
        }
        let newline = buffer.iter().position(|&byte| byte == b'\n');
        let count = newline.unwrap_or(buffer.len());
        if !too_large {
            if count > MAX_LINE_BYTES.saturating_sub(bytes.len()) {
                too_large = true;
            } else {
                bytes.extend_from_slice(&buffer[..count]);
            }
        }
        reader.consume(count + usize::from(newline.is_some()));
        if newline.is_some() {
            return Ok(Some(if too_large {
                Frame::TooLarge
            } else {
                Frame::Json(bytes)
            }));
        }
    }
}

#[cfg(test)]
fn serve(
    reader: impl BufRead,
    writer: impl Write,
    data_dir: &Path,
    queue_id: &str,
) -> Result<(), String> { serve_tools(reader, writer, data_dir, queue_id, false) }

fn serve_tools(
    mut reader: impl BufRead,
    mut writer: impl Write,
    data_dir: &Path,
    queue_id: &str,
    tasks_only: bool,
) -> Result<(), String> {
    // Even initialize must not succeed for an invalid queue. Listing does not
    // create an inbox or claim pending messages.
    list_in(data_dir, queue_id)?;
    let mut replies = HashMap::new();
    while let Some(frame) = read_frame(&mut reader)
        .map_err(|error| format!("No se pudo leer una petición MCP: {error}"))?
    {
        let response = match frame {
            Frame::TooLarge => Some(rpc_error(
                Value::Null,
                -32600,
                "La petición MCP supera 64 KiB.",
            )),
            Frame::Json(bytes) => match serde_json::from_slice(&bytes) {
                Ok(request) => {
                    let request: Value = request;
                    if tasks_only && request["method"] == "tools/call" && request["params"]["name"] != TASK_TOOL {
                        request.get("id").cloned().map(|id| rpc_error(id, -32601, "Esta conexión solo ofrece trex_update_tasks."))
                    } else {
                        let listing = request.get("method").and_then(Value::as_str) == Some("tools/list");
                        let mut response = cached_request(request, data_dir, queue_id, &mut replies);
                        if tasks_only && listing {
                            if let Some(tools) = response.as_mut().and_then(|r| r.get_mut("result")).and_then(|r| r.get_mut("tools")).and_then(Value::as_array_mut) { tools.retain(|t| t["name"] == TASK_TOOL); }
                        }
                        response
                    }
                },
                Err(_) => Some(rpc_error(Value::Null, -32700, "JSON no válido.")),
            },
        };
        if let Some(response) = response {
            serde_json::to_writer(&mut writer, &response)
                .map_err(|error| format!("No se pudo escribir una respuesta MCP: {error}"))?;
            writer
                .write_all(b"\n")
                .and_then(|_| writer.flush())
                .map_err(|error| format!("No se pudo entregar una respuesta MCP: {error}"))?;
        }
    }
    Ok(())
}

fn rpc_error(id: Value, code: i32, message: &str) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}})
}

fn cached_request(
    request: Value,
    data_dir: &Path,
    queue_id: &str,
    replies: &mut HashMap<String, Value>,
) -> Option<Value> {
    let key = (request.get("method").and_then(Value::as_str) == Some("tools/call"))
        .then(|| request.get("id"))
        .flatten()
        .filter(|id| id.is_string() || id.is_number())
        .map(Value::to_string);
    if let Some(reply) = key.as_ref().and_then(|key| replies.get(key)) {
        return Some(reply.clone());
    }
    let reply = handle_request(request, data_dir, queue_id);
    if let (Some(key), Some(reply)) = (key, &reply) {
        replies.insert(key, reply.clone());
    }
    reply
}

fn handle_request(request: Value, data_dir: &Path, queue_id: &str) -> Option<Value> {
    let Some(object) = request.as_object() else {
        return Some(rpc_error(Value::Null, -32600, "Petición MCP no válida."));
    };
    let method = object.get("method").and_then(Value::as_str);
    let id = object.get("id");
    // Notifications never execute tools, including a tools/call without an ID.
    if id.is_none() && method.is_some() {
        return None;
    }
    let id = match id {
        Some(id) if id.is_string() || id.is_number() => id.clone(),
        _ => {
            return Some(rpc_error(
                Value::Null,
                -32600,
                "Identificador MCP no válido.",
            ))
        }
    };
    if object.get("jsonrpc").and_then(Value::as_str) != Some("2.0") || method.is_none() {
        return Some(rpc_error(id, -32600, "Petición MCP no válida."));
    }
    let params = object.get("params");
    if params.is_some_and(|params| !params.is_object()) {
        return Some(rpc_error(id, -32602, "Los parámetros deben ser un objeto."));
    }
    let result = match method.unwrap() {
        "initialize" => {
            let Some(version) = params
                .and_then(|params| params.get("protocolVersion"))
                .and_then(Value::as_str)
                .filter(|version| !version.is_empty())
            else {
                return Some(rpc_error(id, -32602, "Falta protocolVersion."));
            };
            let capabilities = params.and_then(|params| params.get("capabilities"));
            let client_info = params.and_then(|params| params.get("clientInfo"));
            if !capabilities.is_some_and(Value::is_object)
                || !client_info.is_some_and(|info| {
                    info.get("name").is_some_and(Value::is_string)
                        && info.get("version").is_some_and(Value::is_string)
                })
            {
                return Some(rpc_error(
                    id,
                    -32602,
                    "initialize requiere capabilities y clientInfo con name y version.",
                ));
            }
            let version = match version {
                "2024-11-05" | "2025-03-26" | "2025-06-18" | "2025-11-25" => version,
                _ => PROTOCOL_VERSION,
            };
            json!({
                "protocolVersion": version,
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "trex-inbox", "version": env!("CARGO_PKG_VERSION")},
                "instructions": SERVER_INSTRUCTIONS
            })
        }
        "ping" => json!({}),
        "tools/list" => json!({"tools": [{
            "name": TOOL_NAME,
            "description": TOOL_DESCRIPTION,
            "inputSchema": {"type": "object", "properties": {}, "additionalProperties": false}
        }, task_tool()]}),
        "tools/call" => {
            let Some(params) = params else {
                return Some(rpc_error(
                    id,
                    -32602,
                    "Faltan los parámetros de la herramienta.",
                ));
            };
            if params.get("name").and_then(Value::as_str) == Some(TASK_TOOL) {
                return Some(match update_tasks(params.get("arguments")) {
                    Ok(result) => json!({"jsonrpc":"2.0","id":id,"result":result}),
                    Err(error) => rpc_error(id, -32602, error),
                });
            }
            if params.get("name").and_then(Value::as_str) != Some(TOOL_NAME)
                || params
                    .get("arguments")
                    .is_some_and(|args| !args.as_object().is_some_and(|args| args.is_empty()))
            {
                return Some(rpc_error(
                    id,
                    -32602,
                    "La herramienta requiere trex_read_messages y argumentos vacíos.",
                ));
            }
            read_messages(data_dir, queue_id)
        }
        _ => return Some(rpc_error(id, -32601, "Método MCP desconocido.")),
    };
    Some(json!({"jsonrpc": "2.0", "id": id, "result": result}))
}

fn read_messages(data_dir: &Path, queue_id: &str) -> Value {
    let snapshot = match read_in(data_dir, queue_id) {
        Ok(snapshot) => snapshot,
        Err(error) => {
            return json!({
                "content": [{"type": "text", "text": error}],
                "isError": true,
                "_meta": {"trex/receiptId": null}
            });
        }
    };
    let Some(receipt) = snapshot.receipt else {
        return json!({
            "content": [{"type": "text", "text": "No hay mensajes del usuario en cola."}],
            "_meta": {"trex/receiptId": null}
        });
    };
    let mut content = vec![json!({
        "type": "text",
        "text": format!("Mensajes del usuario en cola. Recibo: {}. Procesa este recibo una sola vez.", receipt.id)
    })];
    for message in receipt.messages {
        if !message.text.is_empty() {
            content.push(json!({"type": "text", "text": message.text}));
        }
        for image in message.images {
            content
                .push(json!({"type": "image", "mimeType": image.media_type, "data": image.data}));
        }
    }
    // Codex sends structuredContent INSTEAD OF content to the model when it is
    // present. Keep our delivery bookkeeping in client-only MCP metadata so
    // both the queued instructions and native image blocks reach the model.
    json!({"content": content, "_meta": {"trex/receiptId": receipt.id}})
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::message_queue::{enqueue_in, QueueImage, QueueMessage};
    use std::fs;
    use std::io::Cursor;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    const QUEUE: &str = "t-mcp-test";
    #[test]
    fn server_guidance_is_a_stable_one_liner_and_never_asks_for_a_final_read() {
        let dir = TestDir::new();
        let reply = handle_request(json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{
            "protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"test","version":"1"}}}), &dir.0, QUEUE).unwrap();
        let instructions = reply["result"]["instructions"].as_str().unwrap();
        assert_eq!(instructions, SERVER_INSTRUCTIONS);
        assert!(instructions.len() < 200, "the developer instructions carry the full guidance once");
        assert!(!TOOL_DESCRIPTION.contains("antes de la respuesta final"));
        assert!(TOOL_DESCRIPTION.contains("nunca en bucle"));
    }
    #[test]
    fn tasks_only_connection_cannot_claim_queued_messages() {
        let dir = TestDir::new();
        enqueue_in(&dir.0, QUEUE, message("preserved")).unwrap();
        let before = serde_json::to_value(list_in(&dir.0, QUEUE).unwrap()).unwrap();
        let requests = [json!({"jsonrpc":"2.0","id":1,"method":"tools/list"}), call(json!(2)),
            json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":TASK_TOOL,"arguments":{"plan":[{"step":"Inspect","status":"in_progress"}]}}}),
            json!({"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":TASK_TOOL,"arguments":{"plan":"bad"}}})];
        let input = requests.iter().map(Value::to_string).collect::<Vec<_>>().join("\n") + "\n";
        let mut output = Vec::new();
        serve_tools(Cursor::new(input), &mut output, &dir.0, QUEUE, true).unwrap();
        let replies: Vec<Value> = output.split(|b| *b == b'\n').filter(|v| !v.is_empty()).map(|v| serde_json::from_slice(v).unwrap()).collect();
        assert_eq!(replies[0]["result"]["tools"].as_array().unwrap().len(), 1);
        assert_eq!(replies[0]["result"]["tools"][0]["name"], TASK_TOOL);
        assert_eq!(replies[1]["error"]["code"], -32601);
        assert_eq!(replies[2]["result"]["structuredContent"]["plan"][0]["step"], "Inspect");
        assert!(replies[3].get("error").is_some());
        assert!(replies[3].get("result").is_none(), "An error cannot gain a result through tools/list filtering.");
        assert_eq!(serde_json::to_value(list_in(&dir.0, QUEUE).unwrap()).unwrap(), before);
    }
    static NEXT_DIR: AtomicU64 = AtomicU64::new(0);

    struct TestDir(PathBuf);
    impl TestDir {
        fn new() -> Self {
            let now = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "trex inbox mcp {}-{now}-{}",
                std::process::id(),
                NEXT_DIR.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn message(id: &str) -> QueueMessage {
        QueueMessage {
            id: id.into(),
            text: format!("Mensaje {id} 🦖\nSegunda línea"),
            images: vec![],
            previews: vec![],
            created_at: 123,
        }
    }

    fn call(id: Value) -> Value {
        json!({"jsonrpc": "2.0", "id": id, "method": "tools/call", "params": {"name": TOOL_NAME, "arguments": {}}})
    }

    fn exchange_bytes(dir: &Path, bytes: &[u8]) -> Vec<Value> {
        let mut output = Vec::new();
        serve(Cursor::new(bytes), &mut output, dir, QUEUE).unwrap();
        output
            .split(|&byte| byte == b'\n')
            .filter(|line| !line.is_empty())
            .map(|line| serde_json::from_slice(line).unwrap())
            .collect()
    }

    fn exchange(dir: &Path, requests: &[Value]) -> Vec<Value> {
        let mut bytes = Vec::new();
        for request in requests {
            serde_json::to_writer(&mut bytes, request).unwrap();
            bytes.push(b'\n');
        }
        exchange_bytes(dir, &bytes)
    }

    #[test]
    fn cli_requires_exact_arity_and_preserves_path_spaces() {
        let parse = |args: &[&str]| parse_args(args.iter().map(OsString::from));
        assert!(parse(&[]).unwrap().is_none());
        assert!(parse(&["--other", MCP_FLAG]).unwrap().is_none());
        for args in [
            vec![MCP_FLAG],
            vec![MCP_FLAG, "data"],
            vec![MCP_FLAG, "data", QUEUE, "extra"],
            vec![MCP_FLAG, "", QUEUE],
        ] {
            assert!(parse(&args).is_err());
        }
        let launch = parse(&[MCP_FLAG, "C:\\App Data\\trex 🦖", QUEUE])
            .unwrap()
            .unwrap();
        assert_eq!(launch.data_dir, PathBuf::from("C:\\App Data\\trex 🦖"));
        assert_eq!(launch.queue_id, QUEUE);
    }

    #[test]
    fn config_is_flat_native_and_does_not_claim_messages() {
        let dir = TestDir::new();
        let pending = enqueue_in(&dir.0, QUEUE, message("config")).unwrap();
        let executable = dir.0.join("app executable.exe");
        let config = mcp_config(&executable, &dir.0, QUEUE).unwrap();
        assert_eq!(config.as_object().unwrap().len(), 5);
        assert_eq!(config["mcp_servers.trex_inbox.required"], true);
        assert_eq!(
            config["mcp_servers.trex_inbox.default_tools_approval_mode"],
            "approve"
        );
        assert_eq!(
            config["mcp_servers.trex_inbox.command"],
            executable.to_str().unwrap()
        );
        assert_eq!(
            config["mcp_servers.trex_inbox.args"],
            json!([MCP_FLAG, dir.0.to_str().unwrap(), QUEUE])
        );
        assert_eq!(config["mcp_servers.trex_inbox.enabled"], true);
        assert_eq!(list_in(&dir.0, QUEUE).unwrap(), pending);
        assert!(mcp_config(&executable, &dir.0, "../invalid").is_err());
        assert!(mcp_config(Path::new("relative.exe"), &dir.0, QUEUE).is_err());
    }

    #[test]
    fn startup_rejects_invalid_queue_before_replying() {
        let dir = TestDir::new();
        for queue in ["", "t-", "../escape", "wrong-prefix", "t-with space"] {
            let mut output = Vec::new();
            assert!(serve(Cursor::new(b"{}\n"), &mut output, &dir.0, queue).is_err());
            assert!(output.is_empty());
        }
    }

    #[test]
    fn initialize_ping_listing_and_notifications_do_not_claim() {
        let dir = TestDir::new();
        let pending = enqueue_in(&dir.0, QUEUE, message("pending")).unwrap();
        let replies = exchange(
            &dir.0,
            &[
                json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-11-25", "capabilities": {}, "clientInfo": {"name": "test", "version": "1"}}}),
                json!({"jsonrpc": "2.0", "method": "notifications/initialized"}),
                json!({"jsonrpc": "2.0", "id": "ping", "method": "ping"}),
                json!({"jsonrpc": "2.0", "id": 3, "method": "tools/list", "params": {}}),
                json!({"jsonrpc": "2.0", "method": "tools/call", "params": {"name": TOOL_NAME, "arguments": {}}}),
                json!({"jsonrpc": "2.0", "method": "unknown/notification"}),
            ],
        );
        assert_eq!(replies.len(), 3);
        assert_eq!(replies[0]["result"]["protocolVersion"], "2025-11-25");
        assert_eq!(replies[0]["result"]["capabilities"], json!({"tools": {}}));
        assert_eq!(replies[0]["result"]["serverInfo"]["name"], "trex-inbox");
        assert_eq!(replies[1]["id"], "ping");
        assert_eq!(replies[1]["result"], json!({}));
        assert_eq!(replies[2]["result"]["tools"].as_array().unwrap().len(), 2);
        assert_eq!(replies[2]["result"]["tools"][1], task_tool());
        assert_eq!(replies[2]["result"]["tools"][0]["name"], TOOL_NAME);
        assert_eq!(
            replies[2]["result"]["tools"][0]["inputSchema"]["additionalProperties"],
            false
        );
        assert_eq!(list_in(&dir.0, QUEUE).unwrap(), pending);
    }

    #[test]
    fn empty_inbox_reports_null_receipt_without_creating_inbox() {
        let dir = TestDir::new();
        let replies = exchange(&dir.0, &[call(json!(1))]);
        assert_eq!(
            replies[0]["result"]["_meta"],
            json!({"trex/receiptId": null})
        );
        assert!(replies[0]["result"].get("structuredContent").is_none());
        assert_eq!(replies[0]["result"]["content"][0]["type"], "text");
        assert!(!dir.0.join("message-queues").exists());
    }

    #[test]
    fn request_retries_preserve_the_original_receipt_and_distinguish_id_types() {
        let dir = TestDir::new();
        let mut cache = HashMap::new();
        enqueue_in(&dir.0, QUEUE, message("first")).unwrap();
        let first = cached_request(call(json!(7)), &dir.0, QUEUE, &mut cache).unwrap();
        let receipt = first["result"]["_meta"]["trex/receiptId"].as_str().unwrap();
        crate::message_queue::ack_in(&dir.0, QUEUE, receipt).unwrap();
        enqueue_in(&dir.0, QUEUE, message("later")).unwrap();
        assert_eq!(
            cached_request(call(json!(7)), &dir.0, QUEUE, &mut cache).unwrap(),
            first
        );
        assert_eq!(list_in(&dir.0, QUEUE).unwrap().messages[0].id, "later");
        let distinct = cached_request(call(json!("7")), &dir.0, QUEUE, &mut cache).unwrap();
        assert_ne!(distinct["result"]["_meta"]["trex/receiptId"], receipt);
        assert_eq!(
            list_in(&dir.0, QUEUE).unwrap().receipt.unwrap().messages[0].id,
            "later"
        );
    }

    #[test]
    fn retrying_an_empty_read_does_not_consume_later_arrivals() {
        let dir = TestDir::new();
        let mut cache = HashMap::new();
        let first = cached_request(call(json!(1)), &dir.0, QUEUE, &mut cache).unwrap();
        enqueue_in(&dir.0, QUEUE, message("later")).unwrap();
        assert_eq!(
            cached_request(call(json!(1)), &dir.0, QUEUE, &mut cache).unwrap(),
            first
        );
        assert_eq!(list_in(&dir.0, QUEUE).unwrap().messages[0].id, "later");
    }

    #[test]
    fn receipt_replays_images_and_text_without_acknowledging_or_claiming_later_messages() {
        let dir = TestDir::new();
        let mut first = message("first");
        first.text.push_str(
            "\n\nArchivos adjuntos:\n[Archivo 1]: C:\\Usuarios\\Ana\\informe final ñ.csv",
        );
        first.images.push(QueueImage {
            media_type: "image/png".into(),
            data: "AQID".into(),
        });
        enqueue_in(&dir.0, QUEUE, first.clone()).unwrap();
        let mut image_only = message("image-only");
        image_only.text.clear();
        image_only.images = first.images.clone();
        enqueue_in(&dir.0, QUEUE, image_only.clone()).unwrap();
        let mut file_only = message("file-only");
        file_only.text = "Archivos adjuntos:\n[Archivo 1]: /home/ana/datos de prueba.json".into();
        enqueue_in(&dir.0, QUEUE, file_only.clone()).unwrap();
        let initial = exchange(&dir.0, &[call(json!(1))]);
        let result = &initial[0]["result"];
        let receipt_id = result["_meta"]["trex/receiptId"].as_str().unwrap();
        assert!(
            result.get("structuredContent").is_none(),
            "A structured receipt would hide the text and images from Codex"
        );
        assert!(result["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains(&format!("Recibo: {receipt_id}.")));
        assert_eq!(
            result["content"][1],
            json!({"type": "text", "text": first.text})
        );
        assert_eq!(
            result["content"][2],
            json!({"type": "image", "mimeType": "image/png", "data": "AQID"})
        );
        assert_eq!(result["content"][3], result["content"][2]);
        assert_eq!(
            result["content"][4],
            json!({"type":"text","text":file_only.text})
        );
        assert_eq!(result["content"].as_array().unwrap().len(), 5);
        let later = message("later");
        enqueue_in(&dir.0, QUEUE, later.clone()).unwrap();
        let replay = exchange(&dir.0, &[call(json!(2))]);
        assert_eq!(replay[0]["result"], *result);
        let snapshot = list_in(&dir.0, QUEUE).unwrap();
        assert_eq!(snapshot.messages, vec![later]);
        let receipt = snapshot.receipt.unwrap();
        assert_eq!(receipt.id, receipt_id);
        assert_eq!(receipt.messages, vec![first, image_only, file_only]);
    }

    #[test]
    fn invalid_params_and_unknown_methods_do_not_read() {
        let dir = TestDir::new();
        let pending = enqueue_in(&dir.0, QUEUE, message("pending")).unwrap();
        let requests = [
            json!({"jsonrpc": "2.0", "id": 1, "method": "unknown"}),
            json!({"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": "wrong", "arguments": {}}}),
            json!({"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": TOOL_NAME, "arguments": {"extra": true}}}),
            json!({"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {"name": TOOL_NAME, "arguments": null}}),
            json!({"jsonrpc": "2.0", "id": 5, "method": "tools/call", "params": []}),
            json!({"jsonrpc": "2.0", "id": 6, "method": "tools/call"}),
            json!({"jsonrpc": "2.0", "id": 7, "method": "initialize", "params": {}}),
            json!({"jsonrpc": "2.0", "id": 8, "method": "tools/call", "params": {"arguments": {}}}),
        ];
        let replies = exchange(&dir.0, &requests);
        assert_eq!(replies.len(), requests.len());
        assert_eq!(replies[0]["error"]["code"], -32601);
        for reply in &replies[1..] {
            assert_eq!(reply["error"]["code"], -32602);
        }
        assert_eq!(list_in(&dir.0, QUEUE).unwrap(), pending);
    }

    #[test]
    fn malformed_and_oversized_lines_recover_at_next_newline() {
        let dir = TestDir::new();
        let pending = enqueue_in(&dir.0, QUEUE, message("pending")).unwrap();
        let mut input =
            b"{invalid}\n[]\n{\"jsonrpc\":\"2.0\",\"id\":false,\"method\":\"tools/call\"}\n"
                .to_vec();
        input.extend(vec![b' '; MAX_LINE_BYTES + 1]);
        input.push(b'\n');
        input.extend(b"{\"jsonrpc\":\"2.0\",\"id\":\"ok\",\"method\":\"ping\"}\r\n");
        let replies = exchange_bytes(&dir.0, &input);
        assert_eq!(replies.len(), 5);
        assert_eq!(replies[0]["error"]["code"], -32700);
        for reply in &replies[1..4] {
            assert_eq!(reply["error"]["code"], -32600);
            assert!(reply["id"].is_null());
        }
        assert_eq!(replies[4]["id"], "ok");
        assert_eq!(replies[4]["result"], json!({}));
        assert_eq!(list_in(&dir.0, QUEUE).unwrap(), pending);
    }

    #[test]
    fn absent_arguments_are_empty_and_unknown_protocol_negotiates_supported_version() {
        let dir = TestDir::new();
        let replies = exchange(
            &dir.0,
            &[
                json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "future-version", "capabilities": {}, "clientInfo": {"name": "test", "version": "1"}}}),
                json!({"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": TOOL_NAME}}),
            ],
        );
        assert_eq!(replies[0]["result"]["protocolVersion"], PROTOCOL_VERSION);
        assert!(replies[1]["result"]["_meta"]["trex/receiptId"].is_null());
    }

    #[test]
    fn invalid_request_id_and_initialize_fields_do_not_claim() {
        let dir = TestDir::new();
        let pending = enqueue_in(&dir.0, QUEUE, message("pending")).unwrap();
        let mut requests = vec![call(Value::Null), call(json!(false)), call(json!({}))];
        for params in [
            json!({"protocolVersion": PROTOCOL_VERSION}),
            json!({"protocolVersion": PROTOCOL_VERSION, "capabilities": null, "clientInfo": {"name": "test", "version": "1"}}),
            json!({"protocolVersion": PROTOCOL_VERSION, "capabilities": {}, "clientInfo": {"name": "test"}}),
            json!({"protocolVersion": PROTOCOL_VERSION, "capabilities": {}, "clientInfo": {"name": 1, "version": "1"}}),
        ] {
            requests.push(json!({"jsonrpc": "2.0", "id": requests.len(), "method": "initialize", "params": params}));
        }
        let replies = exchange(&dir.0, &requests);
        for reply in &replies[..3] {
            assert_eq!(reply["error"]["code"], -32600);
            assert!(reply["id"].is_null());
        }
        for reply in &replies[3..] {
            assert_eq!(reply["error"]["code"], -32602);
        }
        assert_eq!(list_in(&dir.0, QUEUE).unwrap(), pending);
    }

    #[test]
    fn failed_output_does_not_acknowledge_claimed_receipt() {
        struct BrokenWriter;
        impl Write for BrokenWriter {
            fn write(&mut self, _: &[u8]) -> io::Result<usize> {
                Err(io::ErrorKind::BrokenPipe.into())
            }
            fn flush(&mut self) -> io::Result<()> {
                Ok(())
            }
        }
        let dir = TestDir::new();
        let item = message("durable");
        enqueue_in(&dir.0, QUEUE, item.clone()).unwrap();
        let input = serde_json::to_vec(&call(json!(1))).unwrap();
        assert!(serve(Cursor::new(input), BrokenWriter, &dir.0, QUEUE).is_err());
        let receipt = list_in(&dir.0, QUEUE).unwrap().receipt.unwrap();
        assert_eq!(receipt.messages, vec![item]);
        let replay = exchange(&dir.0, &[call(json!(2))]);
        assert_eq!(replay[0]["result"]["_meta"]["trex/receiptId"], receipt.id);
    }

    #[test]
    fn every_reply_is_flushed_and_eof_without_newline_is_supported() {
        #[derive(Default)]
        struct Output {
            bytes: Vec<u8>,
            flushes: usize,
        }
        impl Write for Output {
            fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
                self.bytes.extend_from_slice(bytes);
                Ok(bytes.len())
            }
            fn flush(&mut self) -> io::Result<()> {
                self.flushes += 1;
                Ok(())
            }
        }
        let dir = TestDir::new();
        let mut output = Output::default();
        let input = b"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"ping\"}\n{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}\n{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"ping\"}";
        serve(Cursor::new(input), &mut output, &dir.0, QUEUE).unwrap();
        assert_eq!(output.flushes, 2);
        assert_eq!(
            output.bytes.iter().filter(|&&byte| byte == b'\n').count(),
            2
        );
    }

    #[test]
    fn task_tool_publishes_progress_without_reading_or_modifying_the_inbox() {
        let dir = TestDir::new();
        let pending = enqueue_in(&dir.0, QUEUE, message("keep-pending")).unwrap();
        let entries = || {
            let mut names: Vec<_> = fs::read_dir(&dir.0)
                .unwrap()
                .map(|entry| entry.unwrap().file_name())
                .collect();
            names.sort();
            names
        };
        let before = entries();
        let plan = json!({"plan":[{"step":"Inspeccionar 🦖","status":"in_progress"},{"step":"Validar","status":"pending"}]});
        let request = |id: i64, args: Value| json!({"jsonrpc":"2.0","id":id,"method":"tools/call","params":{"name":TASK_TOOL,"arguments":args}});
        let replies = exchange(
            &dir.0,
            &[request(1, plan.clone()), request(2, json!({"plan":[]}))],
        );
        assert_eq!(replies[0]["result"]["structuredContent"], plan);
        assert_eq!(replies[0]["result"]["isError"], false);
        assert_eq!(
            replies[1]["result"]["structuredContent"],
            json!({"plan":[]})
        );
        assert_eq!(list_in(&dir.0, QUEUE).unwrap(), pending);
        assert_eq!(
            entries(),
            before,
            "task metadata cannot create storage outside the existing inbox"
        );
    }

    #[test]
    fn task_validation_rejects_the_entire_plan_and_recovers_at_the_next_request() {
        let dir = TestDir::new();
        for invalid in [
            json!(null),
            json!([]),
            json!({}),
            json!({"plan":[],"cwd":"elsewhere"}),
            json!({"plan":[{"step":"valid","status":"completed"},null]}),
            json!({"plan":[{"step":"A","status":"in_progress"},{"step":"B","status":"in_progress"}]}),
            json!({"plan":[{"step":" ","status":"pending"}]}),
            json!({"plan":[{"step":"A","status":"deleted"}]}),
            json!({"plan":[{"step":"A","status":"pending","command":"execute"}]}),
            json!({"plan":[{"step":"x".repeat(2001),"status":"pending"}]}),
            json!({"plan":vec![json!({"step":"A","status":"pending"});65]}),
            json!({"plan":vec![json!({"step":"x".repeat(1999),"status":"pending"});20]}),
        ] {
            let call = |id, args| json!({"jsonrpc":"2.0","id":id,"method":"tools/call","params":{"name":TASK_TOOL,"arguments":args}});
            let replies = exchange(
                &dir.0,
                &[
                    call(1, invalid),
                    call(2, json!({"plan":[{"step":"Accepted","status":"pending"}]})),
                ],
            );
            assert_eq!(replies[0]["error"]["code"], -32602);
            assert_eq!(replies[1]["result"]["isError"], false);
            assert!(!dir.0.join("message-queues").exists());
        }
    }
}
