//! Per-process MCP adapter. Reads cancellation and EOF while a tool is running.
use crate::{desktop::DesktopProvider, tools::ToolProvider};
use anyhow::{ensure, Result};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    io::{self, BufRead, Write},
    path::Path,
    sync::Arc,
    time::Duration,
};
use tokio_util::sync::CancellationToken;
const MAX_FRAME: usize = 64 * 1024;
const MAX_CACHED_BYTES: usize = 16 * 1024 * 1024;
const MAX_CALLS: usize = 1024;

fn frame(reader: &mut impl BufRead) -> io::Result<Option<Vec<u8>>> {
    let mut bytes = Vec::new();
    let mut oversized = false;
    loop {
        let data = reader.fill_buf()?;
        if data.is_empty() {
            return Ok(if oversized {
                Some(Vec::new())
            } else if bytes.is_empty() {
                None
            } else {
                Some(bytes)
            });
        }
        let newline = data.iter().position(|b| *b == b'\n');
        let n = newline.unwrap_or(data.len());
        if !oversized {
            if n > MAX_FRAME.saturating_sub(bytes.len()) {
                oversized = true;
                bytes.clear();
            } else {
                bytes.extend_from_slice(&data[..n]);
            }
        }
        reader.consume(n + usize::from(newline.is_some()));
        if newline.is_some() {
            return Ok(Some(bytes));
        }
    }
}
fn error(id: Value, code: i32, message: &str) -> Value {
    json!({"jsonrpc":"2.0","id":id,"error":{"code":code,"message":message}})
}
fn write(output: &mut impl Write, response: &Value) -> Result<()> {
    serde_json::to_writer(&mut *output, response)?;
    output.write_all(b"\n")?;
    output.flush()?;
    Ok(())
}
struct Pending {
    request: Value,
    cancel: CancellationToken,
    work: tokio::task::JoinHandle<Result<Value>>,
}
fn result(value: Result<Value>) -> Value {
    match value {
        Ok(value) if value.get("content").is_some() => value,
        Ok(value) => {
            json!({"content":[{"type":"text","text":value.to_string()}],"structuredContent":value,"isError":false})
        }
        Err(e) => {
            let uncertain = e
                .downcast_ref::<crate::desktop::DesktopUncertain>()
                .is_some();
            let code = if uncertain {
                "UNCERTAIN"
            } else if e.to_string().starts_with("cancelled") {
                "CANCELLED"
            } else {
                "FAILED"
            };
            json!({"content":[{"type":"text","text":e.to_string()}],"isError":true,"structuredContent":{"error":{"code":code},"manualReview":uncertain}})
        }
    }
}
fn instructions(mode: &str) -> String {
    let permissions = if mode == "plan" {
        "This process is read-only: status, monitors, screenshots and waits only. Input is unavailable."
    } else {
        "Input tools are available subject to the host agent's permission policy. Use their schemas for pointer motion, double clicks, gradual drag, vertical or horizontal scroll, typing and shortcuts."
    };
    format!("Trex desktop controls the real computer and Windows applications; it is separate from the trex_browser project browser. When the user requests computer control, prefer this server's desktop_* tools. Start with desktop_status and desktop_monitors, then take desktop_screenshot for the selected monitor and inspect screen and focus before input. Screenshots are downscaled to 1280 px; input coordinates are pixels of the latest screenshot image. Use region (screen pixels) to zoom into an area cheaply. One observation serves up to 3 inputs within 30 seconds while the screen is unchanged; capture again after focus, layout or display changes. {permissions} Never claim an unadvertised capability. If unavailable, explain the diagnostic rather than silently switching control systems. Never automatically replay uncertain input. For websites requested in Trex Browser, use its connected browser_navigate tool instead of treating a desktop-control failure as a browser failure.")
}
pub async fn serve(mode: &str) -> Result<()> {
    ensure!(
        matches!(mode, "plan" | "full"),
        "desktop MCP mode must be plan or full"
    );
    let provider = Arc::new(DesktopProvider::default());
    let (send, mut receive) = tokio::sync::mpsc::channel(16);
    std::thread::spawn(move || {
        let stdin = io::stdin();
        let mut input = stdin.lock();
        loop {
            match frame(&mut input) {
                Ok(Some(bytes)) => {
                    if send.blocking_send(bytes).is_err() {
                        break;
                    }
                }
                _ => break,
            }
        }
    });
    let stdout = io::stdout();
    let mut output = stdout.lock();
    let mut cache: HashMap<String, (Value, Value)> = HashMap::new();
    let mut cache_bytes = 0usize;
    let mut active: Option<Pending> = None;
    loop {
        tokio::select! {
            completed = async { (&mut active.as_mut().unwrap().work).await }, if active.is_some() => {
                let pending = active.take().unwrap();
                let id = pending.request["id"].clone();
                let result = result(completed.unwrap_or_else(|_| {
                    if crate::desktop::read_only(pending.request["params"]["name"].as_str().unwrap_or("")) { Err(anyhow::anyhow!("desktop worker failed")) }
                    else { Err(crate::desktop::DesktopUncertain.into()) }
                }));
                let response = json!({"jsonrpc":"2.0","id":id,"result":result});
                let cached = if pending.request["params"]["name"] == "desktop_screenshot" {
                    json!({"jsonrpc":"2.0","id":id,"result":{"content":[{"type":"text","text":"This screenshot response was already delivered; request a fresh screenshot with a new ID."}],"isError":true}})
                } else { response.clone() };
                cache_bytes += cached.to_string().len() + pending.request.to_string().len();
                cache.insert(id.to_string(), (pending.request, cached));
                write(&mut output, &response)?;
            }
            bytes = receive.recv() => {
                let Some(bytes) = bytes else { break; };
                let request: Value = match serde_json::from_slice(&bytes) {
                    Ok(v) => v,
                    Err(_) => { write(&mut output, &error(Value::Null, -32700, "Invalid or oversized request"))?; continue; }
                };
                if request["jsonrpc"] == "2.0" && request["method"] == "notifications/cancelled" && request.get("id").is_none() {
                    if let Some(pending) = &active {
                        if request["params"]["requestId"] == pending.request["id"] { pending.cancel.cancel(); }
                    }
                    continue;
                }
                let Some(id) = request.get("id").filter(|id| id.is_string() || id.is_number()).cloned() else { continue; };
                let method = request["method"].as_str().unwrap_or("");
                let response = if request["jsonrpc"] != "2.0" { error(id.clone(), -32600, "Invalid request") }
                else if method == "initialize" { json!({"jsonrpc":"2.0","id":id,"result":{"protocolVersion":"2025-06-18","capabilities":{"tools":{}},"serverInfo":{"name":"trex-desktop","version":"0.1.0"},"instructions":instructions(mode)}}) }
                else if method == "ping" { json!({"jsonrpc":"2.0","id":id,"result":{}}) }
                else if method == "tools/list" {
                    let tools: Vec<Value> = provider.definitions(mode).into_iter().map(|v| {
                        let f = &v["function"]; let read_only = crate::desktop::read_only(f["name"].as_str().unwrap_or(""));
                        json!({"name":f["name"],"description":f["description"],"inputSchema":f["parameters"],"annotations":{"readOnlyHint":read_only,"destructiveHint":!read_only,"idempotentHint":false,"openWorldHint":true}})
                    }).collect();
                    json!({"jsonrpc":"2.0","id":id,"result":{"tools":tools}})
                }
                else if method == "tools/call" {
                    if let Some((prior, response)) = cache.get(&id.to_string()) {
                        if prior == &request { response.clone() } else { error(id.clone(), -32600, "Tool request ID was already used with different arguments") }
                    } else if let Some(pending) = &active {
                        if pending.request == request { continue; }
                        if pending.request["id"] == id { error(id.clone(), -32600, "Tool request ID was already used with different arguments") }
                        else { error(id.clone(), -32001, "Desktop operation in progress; this request was not started") }
                    } else if cache.len() >= MAX_CALLS || cache_bytes >= MAX_CACHED_BYTES - MAX_FRAME - 4096 {
                        error(id.clone(), -32000, "Desktop session operation limit reached; restart the session")
                    } else {
                        let name = request["params"]["name"].as_str().unwrap_or("").to_owned();
                        let arguments = request["params"].get("arguments").cloned().unwrap_or_else(|| json!({}));
                        let available = provider.definitions(mode).iter().any(|t| t["function"]["name"] == name);
                        let cancel = CancellationToken::new();
                        let token = cancel.clone();
                        let service = provider.clone();
                        let mode = mode.to_owned();
                        let key = id.to_string();
                        let work = tokio::spawn(async move {
                            ensure!(available, "Tool unavailable in this permission mode.");
                            service.execute(Path::new("."), &mode, &name, &arguments, &key, token).await
                        });
                        active = Some(Pending { request, cancel, work });
                        continue;
                    }
                } else { error(id.clone(), -32601, "Unknown method") };
                write(&mut output, &response)?;
            }
        }
    }
    if let Some(mut pending) = active {
        pending.cancel.cancel();
        let _ = tokio::time::timeout(Duration::from_secs(2), &mut pending.work).await;
    }
    provider.invalidate_observation();
    Ok(())
}
