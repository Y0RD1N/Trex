//! Bounded, user-configured stdio MCP client. Project files cannot choose commands.
use crate::{
    settings::{McpServer, ShellSettings},
    tools::{ToolFuture, ToolProvider},
};
use anyhow::{bail, ensure, Context, Result};
use serde_json::{json, Value};
use std::{collections::HashMap, path::Path, process::Stdio, sync::Arc, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    sync::Mutex,
};
use tokio_util::sync::CancellationToken;
#[derive(Debug)]
pub struct McpUncertain;
impl std::fmt::Display for McpUncertain {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("MCP operation was interrupted or its result is uncertain. Inspect the external service before continuing; this connection will not replay or reconnect automatically.")
    }
}
impl std::error::Error for McpUncertain {}
struct Connection {
    child: tokio::process::Child,
    guard: crate::tools::ProcessTreeGuard,
    stdin: tokio::process::ChildStdin,
    stdout: BufReader<tokio::process::ChildStdout>,
    seq: u64,
    root: String,
}
impl Connection {
    async fn frame(&mut self, value: &Value) -> Result<()> {
        let mut bytes = serde_json::to_vec(value)?;
        ensure!(bytes.len() <= 1024 * 1024, "MCP request exceeds 1 MiB");
        bytes.push(b'\n');
        self.stdin.write_all(&bytes).await?;
        self.stdin.flush().await?;
        Ok(())
    }
    async fn request(&mut self, method: &str, params: Value) -> Result<Value> {
        self.seq += 1;
        let id = self.seq;
        self.frame(&json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}))
            .await?;
        let mut notifications = 0;
        loop {
            let mut bytes = Vec::new();
            loop {
                let available = self.stdout.fill_buf().await?;
                ensure!(!available.is_empty(), "MCP connection closed");
                let n = available
                    .iter()
                    .position(|b| *b == b'\n')
                    .map(|n| n + 1)
                    .unwrap_or(available.len());
                ensure!(
                    bytes.len() + n <= 8 * 1024 * 1024,
                    "MCP response exceeds 8 MiB"
                );
                let end = available[n - 1] == b'\n';
                bytes.extend_from_slice(&available[..n]);
                self.stdout.consume(n);
                if end {
                    break;
                }
            }
            let value: Value = serde_json::from_slice(&bytes)
                .map_err(|_| anyhow::anyhow!("MCP returned invalid JSON"))?;
            ensure!(value["jsonrpc"] == "2.0", "invalid MCP protocol frame");
            if value.get("method").is_some() {
                notifications += 1;
                ensure!(notifications <= 1024, "MCP notification flood");
                if let Some(request_id) = value.get("id") {
                    let response = if value["method"] == "roots/list" {
                        json!({"jsonrpc":"2.0","id":request_id,"result":{"roots":[{"uri":self.root,"name":"workspace"}]}})
                    } else {
                        json!({"jsonrpc":"2.0","id":request_id,"error":{"code":-32601,"message":"Client sampling, elicitation and arbitrary callbacks are unavailable"}})
                    };
                    self.frame(&response).await?;
                }
                continue;
            }
            ensure!(value["id"] == id, "unexpected MCP response ID");
            ensure!(
                value.get("error").is_none(),
                "MCP server rejected the request"
            );
            return Ok(value["result"].clone());
        }
    }
    async fn stop(&mut self) {
        self.guard.terminate();
        let _ = self.child.kill().await;
    }
}
pub struct McpProvider {
    connection: Arc<Mutex<Option<Connection>>>,
    tools: Vec<Value>,
    mapping: HashMap<String, (String, bool)>,
    secrets: Vec<String>,
}
fn redact(value: &mut Value, secrets: &[String]) {
    match value {
        Value::String(s) => {
            for secret in secrets {
                *s = s.replace(secret, "[redacted credential]");
            }
        }
        Value::Array(a) => {
            for v in a {
                redact(v, secrets)
            }
        }
        Value::Object(o) => {
            for v in o.values_mut() {
                redact(v, secrets)
            }
        }
        _ => (),
    }
}
impl McpProvider {
    pub async fn connect(config: &McpServer, cwd: &Path, shell: &ShellSettings) -> Result<Self> {
        ensure!(config.enabled, "MCP server disabled");
        let secrets: Vec<_> = config
            .env
            .iter()
            .filter_map(std::env::var_os)
            .map(|s| s.to_string_lossy().into_owned())
            .filter(|s| !s.is_empty())
            .collect();
        let binary = config
            .command
            .canonicalize()
            .context("MCP executable unavailable")?;
        ensure!(binary.is_file(), "MCP executable unavailable");
        let mut command = tokio::process::Command::new(binary);
        command
            .args(&config.args)
            .current_dir(cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        let mut environment = shell.clone();
        environment.environment = "minimal".into();
        environment.forward_env = config.env.clone();
        crate::settings::configure_environment(&mut command, &environment);
        let (mut child, guard) = crate::tools::spawn_owned_command(command)?;
        let stdin = child.stdin.take().context("MCP stdin unavailable")?;
        let stdout = BufReader::new(child.stdout.take().context("MCP stdout unavailable")?);
        let mut connection = Connection {
            child,
            guard,
            stdin,
            stdout,
            seq: 0,
            root: reqwest::Url::from_directory_path(cwd)
                .map_err(|_| anyhow::anyhow!("invalid MCP workspace"))?
                .to_string(),
        };
        let startup = async {
            let init=connection.request("initialize",json!({"protocolVersion":"2025-11-25","capabilities":{"roots":{"listChanged":false}},"clientInfo":{"name":"trex-agent","version":env!("CARGO_PKG_VERSION")}})).await?;
            ensure!(
                matches!(
                    init["protocolVersion"].as_str(),
                    Some("2025-11-25" | "2025-06-18" | "2025-03-26" | "2024-11-05")
                ),
                "unsupported MCP protocol"
            );
            connection
                .frame(&json!({"jsonrpc":"2.0","method":"notifications/initialized"}))
                .await?;
            let mut listed = Vec::new();
            let mut cursor = None;
            for _ in 0..8 {
                let result = connection
                    .request(
                        "tools/list",
                        cursor
                            .as_ref()
                            .map(|v| json!({"cursor":v}))
                            .unwrap_or(json!({})),
                    )
                    .await?;
                let tools = result["tools"]
                    .as_array()
                    .context("invalid MCP tool catalog")?;
                ensure!(
                    listed.len() + tools.len() <= 128,
                    "MCP catalog exceeds 128 tools"
                );
                listed.extend(tools.iter().cloned());
                cursor = result
                    .get("nextCursor")
                    .and_then(Value::as_str)
                    .filter(|v| !v.is_empty() && v.len() <= 1024)
                    .map(str::to_owned);
                if cursor.is_none() {
                    break;
                }
            }
            ensure!(cursor.is_none(), "MCP catalog pagination limit reached");
            Ok::<_, anyhow::Error>(listed)
        };
        let listed = match tokio::time::timeout(Duration::from_secs(10), startup).await {
            Ok(Ok(v)) => v,
            _ => {
                connection.stop().await;
                bail!("MCP initialization failed or timed out")
            }
        };
        let mut tools = Vec::new();
        let mut mapping = HashMap::new();
        let mut schema_bytes = 0;
        for tool in listed {
            let serialized = serde_json::to_string(&tool)?;
            ensure!(
                !secrets.iter().any(|s| serialized.contains(s)),
                "MCP catalog contains credential material"
            );
            let original = tool["name"]
                .as_str()
                .filter(|s| !s.is_empty() && s.len() <= 128 && !s.chars().any(char::is_control))
                .context("invalid MCP tool name")?;
            let safe: String = original
                .chars()
                .map(|c| {
                    if c.is_ascii_alphanumeric() || c == '_' {
                        c
                    } else {
                        '_'
                    }
                })
                .take(24)
                .collect();
            let hash = crate::changes::hash(original);
            let name = format!("mcp_{}_{}_{}", config.name, safe, &hash[..8]);
            ensure!(!mapping.contains_key(&name), "duplicate MCP tool name");
            ensure!(
                tool["inputSchema"]["type"] == "object",
                "MCP tool schema must describe an object"
            );
            schema_bytes += serde_json::to_vec(&tool)?.len();
            ensure!(
                schema_bytes <= 512 * 1024,
                "MCP tool schemas exceed 512 KiB"
            );
            let read_only = config.read_only_tools.iter().any(|v| v == original)
                && tool.pointer("/annotations/readOnlyHint") == Some(&json!(true));
            let description = format!(
                "External MCP tool from {}. {}",
                config.name,
                crate::context::clip(tool["description"].as_str().unwrap_or(""), 2048)
            );
            tools.push(json!({"type":"function","function":{"name":name,"description":description,"parameters":tool["inputSchema"]}}));
            mapping.insert(name, (original.into(), read_only));
        }
        Ok(Self {
            connection: Arc::new(Mutex::new(Some(connection))),
            tools,
            mapping,
            secrets,
        })
    }
}
impl ToolProvider for McpProvider {
    fn shutdown<'a>(&'a self) -> ToolFuture<'a> {
        Box::pin(async move {
            if let Some(mut connection) = self.connection.lock().await.take() {
                connection.stop().await;
            }
            Ok(json!({"closed":true}))
        })
    }
    fn definitions(&self, mode: &str) -> Vec<Value> {
        self.tools
            .iter()
            .filter(|t| {
                mode != "plan"
                    || self
                        .mapping
                        .get(t["function"]["name"].as_str().unwrap_or(""))
                        .is_some_and(|(_, read)| *read)
            })
            .cloned()
            .collect()
    }
    fn is_mutating(&self, name: &str, _: &Value) -> bool {
        self.mapping.get(name).is_none_or(|(_, read)| !*read)
    }
    fn execute<'a>(
        &'a self,
        _: &'a Path,
        mode: &'a str,
        name: &'a str,
        input: &'a Value,
        operation_id: &'a str,
        cancel: CancellationToken,
    ) -> ToolFuture<'a> {
        Box::pin(async move {
            let (original, read) = self.mapping.get(name).context("unknown MCP tool")?;
            ensure!(
                mode != "plan" || *read,
                "MCP mutation forbidden in planning mode"
            );
            ensure!(!cancel.is_cancelled(), "MCP call cancelled before dispatch");
            let mut slot = self.connection.lock().await;
            let connection = slot
                .as_mut()
                .context("MCP connection unavailable; restart the session after review")?;
            let request = connection.request(
                "tools/call",
                json!({"name":original,"arguments":input,"_meta":{"trexOperationId":operation_id}}),
            );
            let result = tokio::select! {_=cancel.cancelled()=>None,result=tokio::time::timeout(Duration::from_secs(90),request)=>result.ok()};
            match result {
                Some(Ok(mut value)) if value["content"].is_array() => {
                    redact(&mut value, &self.secrets);
                    Ok(value)
                }
                _ => {
                    if let Some(mut connection) = slot.take() {
                        connection.stop().await;
                    }
                    Err(McpUncertain.into())
                }
            }
        })
    }
}
