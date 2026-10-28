//! Per-process MCP adapter with an immutable desktop permission mode.
use crate::{desktop::DesktopProvider, tools::ToolProvider};
use anyhow::{ensure, Result};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    io::{self, BufRead, Write},
    path::Path,
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

pub async fn serve(mode: &str) -> Result<()> {
    ensure!(
        matches!(mode, "plan" | "full"),
        "desktop MCP mode must be plan or full"
    );
    let provider = DesktopProvider::default();
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut input = stdin.lock();
    let mut output = stdout.lock();
    let mut cache: HashMap<String, (Value, Value)> = HashMap::new();
    let mut cache_bytes = 0usize;
    while let Some(bytes) = frame(&mut input)? {
        let request: Value = match serde_json::from_slice(&bytes) {
            Ok(v) => v,
            Err(_) => {
                writeln!(
                    output,
                    "{}",
                    error(Value::Null, -32700, "Invalid or oversized request")
                )?;
                output.flush()?;
                continue;
            }
        };
        let Some(id) = request
            .get("id")
            .filter(|id| id.is_string() || id.is_number())
            .cloned()
        else {
            continue;
        };
        let method = request["method"].as_str().unwrap_or("");
        let response = if request["jsonrpc"] != "2.0" {
            error(id.clone(), -32600, "Invalid request")
        } else if method == "initialize" {
            json!({"jsonrpc":"2.0","id":id,"result":{"protocolVersion":"2025-06-18","capabilities":{"tools":{}},"serverInfo":{"name":"trex-desktop","version":"0.1.0"}}})
        } else if method == "ping" {
            json!({"jsonrpc":"2.0","id":id,"result":{}})
        } else if method == "tools/list" {
            let tools:Vec<Value>=provider.definitions(mode).into_iter().map(|v| { let f=&v["function"]; let name=f["name"].as_str().unwrap_or(""); json!({"name":name,"description":f["description"],"inputSchema":f["parameters"],"annotations":{"readOnlyHint":name=="desktop_screenshot","destructiveHint":name!="desktop_screenshot","idempotentHint":false,"openWorldHint":true}}) }).collect();
            json!({"jsonrpc":"2.0","id":id,"result":{"tools":tools}})
        } else if method == "tools/call" {
            let key = id.to_string();
            if let Some((prior, response)) = cache.get(&key) {
                if prior == &request {
                    response.clone()
                } else {
                    error(
                        id.clone(),
                        -32600,
                        "Tool request ID was already used with different arguments",
                    )
                }
            } else if cache.len() >= MAX_CALLS || cache_bytes >= MAX_CACHED_BYTES - MAX_FRAME - 4096
            {
                error(
                    id.clone(),
                    -32000,
                    "Desktop session operation limit reached; restart the session",
                )
            } else {
                let name = request["params"]["name"].as_str().unwrap_or("");
                let arguments = request["params"]
                    .get("arguments")
                    .cloned()
                    .unwrap_or_else(|| json!({}));
                let result = if !provider
                    .definitions(mode)
                    .iter()
                    .any(|t| t["function"]["name"] == name)
                {
                    json!({"content":[{"type":"text","text":"Tool unavailable in this permission mode."}],"isError":true})
                } else {
                    match provider
                        .execute(
                            Path::new("."),
                            mode,
                            name,
                            &arguments,
                            &key,
                            CancellationToken::new(),
                        )
                        .await
                    {
                        Ok(value) if value.get("content").is_some() => value,
                        Ok(value) => {
                            json!({"content":[{"type":"text","text":value.to_string()}],"isError":false})
                        }
                        Err(e) => {
                            json!({"content":[{"type":"text","text":e.to_string()}],"isError":true})
                        }
                    }
                };
                let response = json!({"jsonrpc":"2.0","id":id,"result":result});
                // Image bytes are sent once, not retained in the replay cache. A
                // duplicate ID never captures again and cannot revive an old token.
                let cached = if name == "desktop_screenshot" {
                    json!({"jsonrpc":"2.0","id":id,"result":{"content":[{"type":"text","text":"This screenshot response was already delivered; request a fresh screenshot with a new ID."}],"isError":true}})
                } else {
                    response.clone()
                };
                cache_bytes += cached.to_string().len() + request.to_string().len();
                cache.insert(key, (request.clone(), cached));
                response
            }
        } else {
            error(id.clone(), -32601, "Unknown method")
        };
        serde_json::to_writer(&mut output, &response)?;
        output.write_all(b"\n")?;
        output.flush()?;
    }
    Ok(())
}
