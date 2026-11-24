//! The person's own browser («Tu navegador»): the Trex extension in their Chrome, Brave
//! or Edge, reached through the app's local bridge, an MCP server over HTTP with JSON
//! responses. The app puts the endpoint and a per-chat token in this CLI's environment
//! (`TREX_CHROME_URL`, `TREX_CHROME_TOKEN`); without both there are no browser tools.
//! The token only travels in `Authorization: Bearer`: it is never logged, quoted in an
//! error or returned to the model. The bridge checks the chat's mode on every call too.
use crate::tools::{ToolFuture, ToolProvider};
use anyhow::{anyhow, bail, ensure, Context, Result};
use reqwest::{header, StatusCode};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::Path,
    sync::atomic::{AtomicU64, Ordering},
    time::Duration,
};
use tokio_util::sync::CancellationToken;

/// Name of the connection (`unavailableMcpServers`, like the other agents see it).
pub const SERVER: &str = "trex_chrome";
pub const URL_ENV: &str = "TREX_CHROME_URL";
/// Never inherited by a child process (see `take_from_env`).
pub const TOKEN_ENV: &str = "TREX_CHROME_TOKEN";
/// Model-facing names: `browser_tabs_list`, `browser_click`…
pub const PREFIX: &str = "browser_";
/// Tools that only look. Must match OBSERVE_TOOLS in src-tauri/src/browser_bridge.rs.
pub const READ_TOOLS: [&str; 4] = ["tabs_list", "read_page", "screenshot", "wait_for"];
const PROTOCOL: &str = "2025-11-25";
const PROTOCOLS: [&str; 4] = ["2024-11-05", "2025-03-26", "2025-06-18", PROTOCOL];
const STARTUP_TIMEOUT: Duration = Duration::from_secs(10);
/// The bridge gives up on the extension after 60 s and answers with an error; past
/// this it is the bridge itself that stopped answering.
const CALL_TIMEOUT: Duration = Duration::from_secs(90);
/// A screenshot travels in base64; the bridge accepts up to 16 MiB from the extension.
const MAX_RESPONSE: usize = 24 * 1024 * 1024;
const MAX_REQUEST: usize = 1024 * 1024;
const MAX_TOOLS: usize = 64;

/// Where this chat's browser tools live. `Debug` never shows the token.
#[derive(Clone, PartialEq, Eq)]
pub struct Endpoint {
    url: String,
    port: u16,
    token: String,
}

impl std::fmt::Debug for Endpoint {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Endpoint").field("url", &self.url).finish_non_exhaustive()
    }
}

/// What `take_from_env` found when this process started.
static STARTUP: std::sync::OnceLock<Option<std::result::Result<Endpoint, String>>> = std::sync::OnceLock::new();

/// `None` when neither variable is set. An error never quotes their values.
fn read_env() -> Option<std::result::Result<Endpoint, String>> {
    let read = |name| std::env::var(name).ok().filter(|value: &String| !value.is_empty());
    Endpoint::parse(read(URL_ENV), read(TOKEN_ENV)).map(|endpoint| endpoint.map_err(|error| error.to_string()))
}

/// Reads both variables once and removes them from this process's environment, so
/// no child (shells, PTYs, gh, git, Blender, hyperframes…) can inherit the token,
/// whatever environment it is given. `main` calls it first, before any thread exists.
pub fn take_from_env() {
    let found = read_env();
    for name in [URL_ENV, TOKEN_ENV] {
        // Safe to call here (and the reason it would be a sound `unsafe` block in
        // edition 2024): the process is still single-threaded, so nothing can be
        // reading the environment concurrently.
        std::env::remove_var(name);
    }
    let _ = STARTUP.set(found);
}

/// This process's browser binding: what `take_from_env` captured at startup or,
/// when the crate is used without it (library tests), the current environment.
pub fn configured() -> Option<std::result::Result<Endpoint, String>> {
    STARTUP.get().cloned().unwrap_or_else(read_env)
}

impl Endpoint {
    fn parse(url: Option<String>, token: Option<String>) -> Option<Result<Self>> {
        if url.is_none() && token.is_none() {
            return None;
        }
        Some((|| -> Result<Self> {
            let url = url.with_context(|| format!("{URL_ENV} is missing"))?;
            let token = token.with_context(|| format!("{TOKEN_ENV} is missing"))?;
            let port = local_port(&url)
                .with_context(|| format!("{URL_ENV} must be http://127.0.0.1:<port>/mcp"))?;
            ensure!(valid_token(&token), "{TOKEN_ENV} is not a valid token");
            Ok(Self { url, port, token })
        })())
    }
}

/// `http://127.0.0.1:<port>/mcp`, with a plain unprivileged port.
fn local_port(url: &str) -> Option<u16> {
    let port = url.strip_prefix("http://127.0.0.1:")?.strip_suffix("/mcp")?;
    port.parse::<u16>()
        .ok()
        .filter(|value| *value >= 1024 && value.to_string() == port)
}

/// Header-safe, and long enough that redacting it never mangles ordinary text.
fn valid_token(token: &str) -> bool {
    (16..=512).contains(&token.len())
        && token
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-._~+/=".contains(&b))
}

fn valid_name(name: &str) -> bool {
    (1..=48).contains(&name.len())
        && name.starts_with(|c: char| c.is_ascii_lowercase())
        && name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
}

/// An action may have reached the browser without a valid answer. The runner settles
/// it as requiring review; it is never replayed.
#[derive(Debug)]
pub struct BrowserUncertain;
impl std::fmt::Display for BrowserUncertain {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Browser action interrupted or its result is uncertain; check the browser (or ask the person) before continuing. It will never be automatically replayed.")
    }
}
impl std::error::Error for BrowserUncertain {}

/// Why a request got no usable answer.
#[derive(Debug)]
enum Failure {
    /// Nothing was dispatched: no connection, or the bridge refused the request.
    Refused(String),
    /// The request left, but no valid answer came back: an action may have happened.
    Unknown(&'static str),
}

impl Failure {
    fn into_error(self) -> anyhow::Error {
        match self {
            Self::Refused(message) => anyhow!(message),
            Self::Unknown(reason) => anyhow!(reason),
        }
    }
}

pub struct ChromeProvider {
    client: reqwest::Client,
    endpoint: Endpoint,
    protocol: String,
    instructions: Option<String>,
    tools: Vec<Value>,
    /// Model-facing name → (the bridge's name, only reads).
    mapping: HashMap<String, (String, bool)>,
    next_id: AtomicU64,
    timeout: Duration,
}

impl ChromeProvider {
    /// `initialize` and `tools/list`; the bridge answers both without the extension.
    pub async fn connect(endpoint: &Endpoint) -> Result<Self> {
        Self::connect_with(endpoint, CALL_TIMEOUT).await
    }

    async fn connect_with(endpoint: &Endpoint, timeout: Duration) -> Result<Self> {
        let client = reqwest::Client::builder()
            // A proxy from the environment would see the token; the bridge is loopback only.
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(5))
            .build()
            .context("cannot prepare the browser connection")?;
        let mut provider = Self {
            client,
            endpoint: endpoint.clone(),
            protocol: PROTOCOL.into(),
            instructions: None,
            tools: Vec::new(),
            mapping: HashMap::new(),
            next_id: AtomicU64::new(0),
            timeout,
        };
        let listed = tokio::time::timeout(STARTUP_TIMEOUT, provider.handshake())
            .await
            .map_err(|_| anyhow!("the browser bridge did not answer in time"))??;
        provider.catalog(listed)?;
        Ok(provider)
    }

    async fn handshake(&mut self) -> Result<Vec<Value>> {
        let init = self
            .request("initialize", json!({"protocolVersion":PROTOCOL,"capabilities":{},"clientInfo":{"name":"trex-agent","version":env!("CARGO_PKG_VERSION")}}), STARTUP_TIMEOUT)
            .await
            .map_err(Failure::into_error)?;
        self.protocol = init["protocolVersion"]
            .as_str()
            .filter(|version| PROTOCOLS.contains(version))
            .context("unsupported browser bridge protocol")?
            .to_owned();
        self.instructions = init["instructions"]
            .as_str()
            .map(|text| crate::context::clip(text.trim(), 2_000).to_owned())
            .filter(|text| !text.is_empty() && !text.contains(&self.endpoint.token));
        self.notify("notifications/initialized").await?;
        let mut listed = Vec::new();
        let mut cursor: Option<String> = None;
        for _ in 0..8 {
            let params = cursor.as_ref().map_or(json!({}), |cursor| json!({"cursor":cursor}));
            let result = self
                .request("tools/list", params, STARTUP_TIMEOUT)
                .await
                .map_err(Failure::into_error)?;
            let tools = result["tools"].as_array().context("invalid browser tool catalog")?;
            ensure!(listed.len() + tools.len() <= MAX_TOOLS, "too many browser tools");
            listed.extend(tools.iter().cloned());
            cursor = result
                .get("nextCursor")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty() && value.len() <= 1024)
                .map(str::to_owned);
            if cursor.is_none() {
                return Ok(listed);
            }
        }
        bail!("browser tool catalog pagination limit reached")
    }

    fn catalog(&mut self, listed: Vec<Value>) -> Result<()> {
        let mut schema_bytes = 0;
        for tool in listed {
            // A tool this client cannot name or describe safely is left out, not trusted.
            let Some(original) = tool["name"].as_str().filter(|name| valid_name(name)) else {
                continue;
            };
            if tool["inputSchema"]["type"] != "object" {
                continue;
            }
            let serialized = serde_json::to_string(&tool)?;
            ensure!(
                !serialized.contains(&self.endpoint.token),
                "browser tool catalog contains credential material"
            );
            schema_bytes += serialized.len();
            ensure!(schema_bytes <= 256 * 1024, "browser tool schemas exceed 256 KiB");
            let name = format!("{PREFIX}{original}");
            ensure!(!self.mapping.contains_key(&name), "duplicate browser tool name");
            // Both this client and the bridge must agree that a tool only looks.
            let read_only = READ_TOOLS.contains(&original)
                && tool.pointer("/annotations/readOnlyHint") == Some(&json!(true));
            let description = crate::context::clip(tool["description"].as_str().unwrap_or(""), 2048);
            self.tools.push(json!({"type":"function","function":{"name":name,
                "description":format!("In the person's own browser (Trex extension). {description}"),"parameters":tool["inputSchema"]}}));
            self.mapping.insert(name, (original.to_owned(), read_only));
        }
        ensure!(!self.tools.is_empty(), "the browser bridge offered no tools");
        Ok(())
    }

    fn offline(&self) -> String {
        format!("Trex is not answering on its local browser bridge (127.0.0.1:{}). The person can check it in Trex › Settings › Connections › Browser; do not retry automatically.", self.endpoint.port)
    }

    /// The only place the token is used: the `Authorization` header.
    async fn send(&self, body: Vec<u8>) -> Result<reqwest::Response, Failure> {
        self.client
            .post(&self.endpoint.url)
            .bearer_auth(&self.endpoint.token)
            .header(header::CONTENT_TYPE, "application/json")
            .header(header::ACCEPT, "application/json, text/event-stream")
            .header("MCP-Protocol-Version", &self.protocol)
            .body(body)
            .send()
            .await
            .map_err(|error| {
                if error.is_connect() {
                    Failure::Refused(self.offline())
                } else {
                    Failure::Unknown("the connection to the browser bridge broke")
                }
            })
    }

    async fn notify(&self, method: &str) -> Result<()> {
        let body = serde_json::to_vec(&json!({"jsonrpc":"2.0","method":method}))?;
        let response = tokio::time::timeout(STARTUP_TIMEOUT, self.send(body))
            .await
            .map_err(|_| anyhow!("the browser bridge did not answer in time"))?
            .map_err(Failure::into_error)?;
        ensure!(
            matches!(response.status(), StatusCode::ACCEPTED | StatusCode::OK),
            "the browser bridge refused the initialization (HTTP {})",
            response.status().as_u16()
        );
        Ok(())
    }

    /// One JSON-RPC request and its result.
    async fn request(&self, method: &str, params: Value, timeout: Duration) -> Result<Value, Failure> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        let body = serde_json::to_vec(&json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}))
            .map_err(|_| Failure::Refused("invalid browser request".into()))?;
        if body.len() > MAX_REQUEST {
            return Err(Failure::Refused("browser request exceeds 1 MiB".into()));
        }
        let exchange = async {
            let response = self.send(body).await?;
            match response.status() {
                StatusCode::OK => {}
                StatusCode::UNAUTHORIZED => return Err(Failure::Refused("the browser session of this chat is invalid or expired; the person can restart the chat in Trex to reconnect it".into())),
                status => return Err(Failure::Refused(format!("the browser bridge refused the request (HTTP {})", status.as_u16()))),
            }
            let json = response
                .headers()
                .get(header::CONTENT_TYPE)
                .and_then(|value| value.to_str().ok())
                .is_some_and(|value| value.to_ascii_lowercase().starts_with("application/json"));
            if !json {
                return Err(Failure::Unknown("the browser bridge sent an unexpected answer"));
            }
            let bytes = read_limited(response).await?;
            let reply: Value = serde_json::from_slice(&bytes)
                .map_err(|_| Failure::Unknown("the browser bridge sent invalid JSON"))?;
            if reply["jsonrpc"] != "2.0" || reply["id"] != id {
                return Err(Failure::Unknown("the browser bridge sent an unexpected answer"));
            }
            // The bridge rejects with a JSON-RPC error only before reaching the browser.
            if let Some(error) = reply.get("error").filter(|error| !error.is_null()) {
                let message = crate::context::clip(error["message"].as_str().unwrap_or("unknown error"), 300);
                return Err(Failure::Refused(format!(
                    "the browser bridge rejected the request: {}",
                    message.replace(&self.endpoint.token, "[redacted credential]")
                )));
            }
            reply
                .get("result")
                .cloned()
                .ok_or(Failure::Unknown("the browser bridge sent an unexpected answer"))
        };
        tokio::time::timeout(timeout, exchange)
            .await
            .unwrap_or(Err(Failure::Unknown("the browser did not answer in time")))
    }
}

async fn read_limited(mut response: reqwest::Response) -> Result<Vec<u8>, Failure> {
    const TOO_LARGE: Failure = Failure::Unknown("the browser answer is too large");
    if response.content_length().is_some_and(|length| length > MAX_RESPONSE as u64) {
        return Err(TOO_LARGE);
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| Failure::Unknown("the connection to the browser bridge broke"))?
    {
        if bytes.len() + chunk.len() > MAX_RESPONSE {
            return Err(TOO_LARGE);
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

fn redact(value: &mut Value, token: &str) {
    match value {
        Value::String(text) if text.contains(token) => {
            *text = text.replace(token, "[redacted credential]");
        }
        Value::Array(items) => items.iter_mut().for_each(|item| redact(item, token)),
        Value::Object(fields) => fields.values_mut().for_each(|field| redact(field, token)),
        _ => {}
    }
}

/// The bridge answers `{content:[text|image…], isError}`; anything else is not a valid
/// answer. Image bytes are left untouched for the artifact store.
fn tool_result(result: &Value, token: &str) -> Option<Value> {
    let content = result.get("content")?.as_array()?;
    let valid = content.iter().all(|item| match item["type"].as_str() {
        Some("text") => item["text"].is_string(),
        Some("image") => item["data"].is_string() && item["mimeType"].is_string(),
        _ => false,
    });
    let structured = result.get("structuredContent").filter(|value| !value.is_null());
    if !valid
        || result.get("isError").is_some_and(|value| !value.is_boolean())
        || structured.is_some_and(|value| !value.is_object())
    {
        return None;
    }
    let content: Vec<Value> = content
        .iter()
        .map(|item| {
            let mut item = item.clone();
            if item["type"] == "text" {
                redact(&mut item["text"], token);
            }
            item
        })
        .collect();
    let mut clean = json!({"content":content,"isError":result["isError"].as_bool().unwrap_or(false)});
    if let Some(structured) = structured {
        let mut structured = structured.clone();
        redact(&mut structured, token);
        clean["structuredContent"] = structured;
    }
    Some(clean)
}

impl ToolProvider for ChromeProvider {
    fn guidance(&self, mode: &str) -> Option<String> {
        let mut text = "The person's own browser (their Chrome, Brave or Edge, through the Trex extension) is available through the browser_* tools.".to_owned();
        if mode == "plan" {
            text.push_str(" This session can only look at it.");
        }
        if let Some(instructions) = &self.instructions {
            text.push_str(" Its guidance names the tools without the browser_ prefix: ");
            text.push_str(instructions);
        }
        Some(text)
    }
    fn definitions(&self, mode: &str) -> Vec<Value> {
        self.tools
            .iter()
            .filter(|tool| {
                mode != "plan"
                    || self
                        .mapping
                        .get(tool["function"]["name"].as_str().unwrap_or(""))
                        .is_some_and(|(_, read_only)| *read_only)
            })
            .cloned()
            .collect()
    }
    fn is_mutating(&self, name: &str, _: &Value) -> bool {
        self.mapping.get(name).is_none_or(|(_, read_only)| !*read_only)
    }
    fn execute<'a>(
        &'a self,
        _: &'a Path,
        mode: &'a str,
        name: &'a str,
        input: &'a Value,
        _: &'a str,
        cancel: CancellationToken,
    ) -> ToolFuture<'a> {
        Box::pin(async move {
            let (original, read_only) = self.mapping.get(name).context("unknown browser tool")?;
            ensure!(mode != "plan" || *read_only, "planning mode can only look at the browser");
            ensure!(input.is_object(), "browser tool arguments must be an object");
            ensure!(!cancel.is_cancelled(), "browser call cancelled before dispatch");
            let call = self.request("tools/call", json!({"name":original,"arguments":input}), self.timeout);
            let outcome = tokio::select! {
                outcome = call => outcome,
                _ = cancel.cancelled() => Err(Failure::Unknown("the browser call was cancelled")),
            };
            let failure = match outcome {
                Ok(result) => match tool_result(&result, &self.endpoint.token) {
                    Some(result) => return Ok(result),
                    None => Failure::Unknown("the browser bridge sent an invalid tool result"),
                },
                Err(failure) => failure,
            };
            match failure {
                Failure::Refused(message) => bail!("{message}"),
                // Looking twice is harmless; acting twice is not.
                Failure::Unknown(reason) if *read_only => bail!("{reason}; nothing was changed in the browser"),
                Failure::Unknown(_) => Err(BrowserUncertain.into()),
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};
    use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

    const TOKEN: &str = "chat-token_0123456789-abcdefghijklmnop";

    #[derive(Clone, Debug)]
    struct Seen {
        headers: Vec<(String, String)>,
        body: Value,
    }

    enum Reply {
        Json(Value),
        Status(u16),
        Hang,
        Close,
    }

    /// A loopback bridge: answers like `browser_bridge.rs`, or as `call` says.
    struct Bridge {
        url: String,
        seen: Arc<Mutex<Vec<Seen>>>,
    }

    fn rpc(body: &Value, result: Value) -> Reply {
        Reply::Json(json!({"jsonrpc":"2.0","id":body["id"],"result":result}))
    }

    fn catalog() -> Value {
        let tab = json!({"type":"integer"});
        let tool = |name: &str, read: bool| {
            let mut tool = json!({"name":name,"description":format!("{name} description"),
                "inputSchema":{"type":"object","properties":{"tabId":tab},"additionalProperties":false}});
            if read {
                tool["annotations"] = json!({"readOnlyHint":true});
            }
            tool
        };
        json!({"tools":[tool("tabs_list",true),tool("read_page",true),tool("screenshot",true),tool("navigate",false),tool("click",false),
            // Claims to only read, but is not in the fixed list: still treated as an action.
            tool("evaluate",true),
            // In the fixed list, but the bridge does not say it only reads: an action too.
            tool("wait_for",false),
            // Left out: a name this client cannot use, a schema that is not an object.
            {"name":"Bad Name","inputSchema":{"type":"object"}},{"name":"odd","inputSchema":{"type":"string"}}]})
    }

    impl Bridge {
        async fn start(call: impl Fn(&Value) -> Reply + Send + Sync + 'static) -> Self {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let url = format!("http://{}/mcp", listener.local_addr().unwrap());
            let seen = Arc::new(Mutex::new(Vec::new()));
            let record = seen.clone();
            let call = Arc::new(call);
            tokio::spawn(async move {
                while let Ok((socket, _)) = listener.accept().await {
                    let record = record.clone();
                    let call = call.clone();
                    tokio::spawn(async move {
                        let mut reader = BufReader::new(socket);
                        let mut line = String::new();
                        reader.read_line(&mut line).await.unwrap();
                        let mut headers = Vec::new();
                        loop {
                            line.clear();
                            reader.read_line(&mut line).await.unwrap();
                            if line.trim().is_empty() {
                                break;
                            }
                            let (name, value) = line.split_once(':').unwrap();
                            headers.push((name.to_ascii_lowercase(), value.trim().to_owned()));
                        }
                        let length = headers.iter().find(|(name, _)| name == "content-length").map_or(0, |(_, value)| value.parse().unwrap());
                        let mut bytes = vec![0; length];
                        reader.read_exact(&mut bytes).await.unwrap();
                        let body: Value = serde_json::from_slice(&bytes).unwrap();
                        record.lock().unwrap().push(Seen { headers, body: body.clone() });
                        let reply = match body["method"].as_str() {
                            Some("initialize") => rpc(&body, json!({"protocolVersion":"2025-11-25","capabilities":{"tools":{}},"serverInfo":{"name":"trex-chrome"},
                                "instructions":"Empieza con tabs_list."})),
                            Some("notifications/initialized") => Reply::Status(202),
                            Some("tools/list") => rpc(&body, catalog()),
                            _ => call(&body),
                        };
                        let mut socket = reader.into_inner();
                        let (status, body) = match reply {
                            Reply::Json(value) => (200, value.to_string()),
                            Reply::Status(status) => (status, String::new()),
                            Reply::Hang => {
                                tokio::time::sleep(Duration::from_secs(30)).await;
                                return;
                            }
                            Reply::Close => return,
                        };
                        let head = format!("HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
                        let _ = socket.write_all(head.as_bytes()).await;
                        let _ = socket.write_all(body.as_bytes()).await;
                    });
                }
            });
            Self { url, seen }
        }

        fn endpoint(&self) -> Endpoint {
            Endpoint::parse(Some(self.url.clone()), Some(TOKEN.into())).unwrap().unwrap()
        }

        fn calls(&self) -> Vec<Seen> {
            self.seen.lock().unwrap().iter().filter(|seen| seen.body["method"] == "tools/call").cloned().collect()
        }
    }

    async fn run(provider: &ChromeProvider, mode: &str, name: &str) -> Result<Value> {
        provider.execute(Path::new("."), mode, name, &json!({"tabId":4}), "op", CancellationToken::new()).await
    }

    #[test]
    fn the_endpoint_needs_both_variables_a_loopback_url_and_a_real_token() {
        let parse = |url: Option<&str>, token: Option<&str>| Endpoint::parse(url.map(Into::into), token.map(Into::into));
        assert!(parse(None, None).is_none());
        let good = "http://127.0.0.1:7341/mcp";
        let endpoint = parse(Some(good), Some(TOKEN)).unwrap().unwrap();
        assert_eq!(endpoint.port, 7341);
        assert!(!format!("{endpoint:?}").contains(TOKEN), "Debug must not show the token");
        for (url, token, why) in [
            (Some(good), None, "TREX_CHROME_TOKEN is missing"),
            (None, Some(TOKEN), "TREX_CHROME_URL is missing"),
            (Some("http://evil.example:7341/mcp"), Some(TOKEN), "127.0.0.1"),
            (Some("https://127.0.0.1:7341/mcp"), Some(TOKEN), "127.0.0.1"),
            (Some("http://127.0.0.1:80/mcp"), Some(TOKEN), "127.0.0.1"),
            (Some("http://127.0.0.1:07341/mcp"), Some(TOKEN), "127.0.0.1"),
            (Some("http://127.0.0.1:7341/other"), Some(TOKEN), "127.0.0.1"),
            (Some(good), Some("short"), "not a valid token"),
            (Some(good), Some("has space in the middle of it"), "not a valid token"),
            (Some(good), Some("line\r\nInjected: header-value-x"), "not a valid token"),
        ] {
            let error = parse(url, token).unwrap().unwrap_err().to_string();
            assert!(error.contains(why), "{error}");
            assert!(token.is_none_or(|token| !error.contains(token)), "{error}");
        }
    }

    #[tokio::test]
    async fn tools_are_listed_with_the_browser_prefix_and_the_token_only_travels_in_its_header() {
        let bridge = Bridge::start(|body| rpc(body, json!({"content":[{"type":"text","text":"tabId 4 · Inicio"}],"isError":false}))).await;
        let provider = ChromeProvider::connect(&bridge.endpoint()).await.unwrap();
        let names: Vec<_> = provider.definitions("full").iter().map(|tool| tool["function"]["name"].as_str().unwrap().to_owned()).collect();
        assert_eq!(names, ["browser_tabs_list", "browser_read_page", "browser_screenshot", "browser_navigate", "browser_click", "browser_evaluate", "browser_wait_for"]);
        let planning: Vec<_> = provider.definitions("plan").iter().map(|tool| tool["function"]["name"].as_str().unwrap().to_owned()).collect();
        assert_eq!(planning, ["browser_tabs_list", "browser_read_page", "browser_screenshot"]);
        assert!(!provider.is_mutating("browser_screenshot", &json!({})));
        for action in ["browser_click", "browser_evaluate", "browser_wait_for", "browser_unknown"] {
            assert!(provider.is_mutating(action, &json!({})), "{action}");
        }
        let tool = &provider.definitions("full")[0]["function"];
        assert_eq!(tool["parameters"]["properties"]["tabId"]["type"], "integer");
        assert!(tool["description"].as_str().unwrap().ends_with("tabs_list description"));
        assert!(provider.guidance("plan").unwrap().contains("only look") && provider.guidance("full").unwrap().contains("Empieza con tabs_list."));

        let result = run(&provider, "full", "browser_tabs_list").await.unwrap();
        assert_eq!(result, json!({"content":[{"type":"text","text":"tabId 4 · Inicio"}],"isError":false}));
        let seen = bridge.seen.lock().unwrap().clone();
        let methods: Vec<_> = seen.iter().map(|seen| seen.body["method"].as_str().unwrap()).collect();
        assert_eq!(methods, ["initialize", "notifications/initialized", "tools/list", "tools/call"]);
        assert_eq!(seen[3].body["params"], json!({"name":"tabs_list","arguments":{"tabId":4}}));
        for request in &seen {
            let header = |name: &str| request.headers.iter().find(|(key, _)| key == name).map(|(_, value)| value.as_str());
            assert_eq!(header("authorization"), Some(format!("Bearer {TOKEN}").as_str()));
            assert_eq!(header("host"), Some(bridge.url.trim_start_matches("http://").trim_end_matches("/mcp")));
            assert!(header("origin").is_none(), "an agent is not a web page");
            assert!(header("content-type").unwrap().starts_with("application/json"));
            assert!(!request.body.to_string().contains(TOKEN), "the token never goes in a body");
        }
        assert_eq!(seen[3].headers.iter().find(|(key, _)| key == "mcp-protocol-version").unwrap().1, "2025-11-25");
        // Planning cannot act, even with a forged call; nothing reaches the bridge.
        assert!(run(&provider, "plan", "browser_click").await.unwrap_err().to_string().contains("only look"));
        assert!(run(&provider, "plan", "browser_evaluate").await.is_err());
        assert!(run(&provider, "full", "browser_fill_form").await.is_err());
        assert_eq!(bridge.calls().len(), 1);
    }

    #[tokio::test]
    async fn text_and_image_content_pass_through_and_the_token_never_comes_back() {
        let bridge = Bridge::start(|body| rpc(body, json!({"content":[{"type":"text","text":format!("Captura {TOKEN}")},
            {"type":"image","mimeType":"image/png","data":"iVBORw0KGgo="}],"isError":false}))).await;
        let provider = ChromeProvider::connect(&bridge.endpoint()).await.unwrap();
        let result = run(&provider, "full", "browser_screenshot").await.unwrap();
        assert_eq!(result["content"][0]["text"], "Captura [redacted credential]");
        assert_eq!(result["content"][1], json!({"type":"image","mimeType":"image/png","data":"iVBORw0KGgo="}));
        assert_eq!(result["isError"], false);
    }

    #[tokio::test]
    async fn a_disconnected_extension_is_an_ordinary_tool_error() {
        let bridge = Bridge::start(|body| rpc(body, json!({"content":[{"type":"text","text":"La extensión de trex no está conectada. Abre el navegador y comprueba que la extensión esté activa."}],"isError":true}))).await;
        let provider = ChromeProvider::connect(&bridge.endpoint()).await.unwrap();
        for tool in ["browser_tabs_list", "browser_click"] {
            let result = run(&provider, "full", tool).await.unwrap();
            assert_eq!(result["isError"], true);
            assert!(result["content"][0]["text"].as_str().unwrap().contains("no está conectada"));
        }
    }

    #[tokio::test]
    async fn refusals_are_plain_errors_without_the_token_and_broken_answers_make_actions_uncertain() {
        let bridge = Bridge::start(|body| match body["params"]["arguments"]["tabId"].as_i64() {
            Some(1) => Reply::Status(401),
            Some(2) => Reply::Json(json!({"jsonrpc":"2.0","id":body["id"],"error":{"code":-32602,"message":format!("Herramienta desconocida {TOKEN}")}})),
            Some(3) => Reply::Json(json!({"jsonrpc":"2.0","id":body["id"],"result":{"content":"not an array"}})),
            Some(4) => Reply::Close,
            Some(5) => Reply::Json(json!({"jsonrpc":"2.0","id":999,"result":{"content":[]}})),
            _ => Reply::Hang,
        })
        .await;
        let mut provider = ChromeProvider::connect(&bridge.endpoint()).await.unwrap();
        provider.timeout = Duration::from_millis(300);
        async fn call(provider: &ChromeProvider, name: &str, tab: i64) -> Result<Value> {
            provider.execute(Path::new("."), "full", name, &json!({"tabId":tab}), "op", CancellationToken::new()).await
        }
        let expired = call(&provider, "browser_click", 1).await.unwrap_err().to_string();
        assert!(expired.contains("invalid or expired"), "{expired}");
        let rejected = call(&provider, "browser_click", 2).await.unwrap_err().to_string();
        assert!(rejected.contains("Herramienta desconocida [redacted credential]"), "{rejected}");
        for tab in [3, 4, 5, 6] {
            // Reading again is harmless: a plain error. An action may have happened.
            let read = call(&provider, "browser_read_page", tab).await.unwrap_err();
            assert!(read.downcast_ref::<BrowserUncertain>().is_none(), "{tab}: {read}");
            assert!(read.to_string().contains("nothing was changed"), "{read}");
            let action = call(&provider, "browser_click", tab).await.unwrap_err();
            assert!(action.downcast_ref::<BrowserUncertain>().is_some(), "{tab}: {action}");
            for error in [read.to_string(), action.to_string(), format!("{read:?}"), format!("{action:?}")] {
                assert!(!error.contains(TOKEN));
            }
        }
        assert!(call(&provider, "browser_read_page", 6).await.unwrap_err().to_string().contains("did not answer in time"));
        // A cancelled action is uncertain too; a cancelled read is not.
        let cancel = CancellationToken::new();
        let canceller = cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(50)).await;
            canceller.cancel();
        });
        provider.timeout = Duration::from_secs(20);
        let cancelled = provider.execute(Path::new("."), "full", "browser_click", &json!({"tabId":6}), "op", cancel).await.unwrap_err();
        assert!(cancelled.downcast_ref::<BrowserUncertain>().is_some());
    }

    #[tokio::test]
    async fn a_bridge_that_is_not_listening_is_reported_without_dispatch_or_uncertainty() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/mcp", listener.local_addr().unwrap());
        drop(listener);
        let endpoint = Endpoint::parse(Some(url), Some(TOKEN.into())).unwrap().unwrap();
        let error = ChromeProvider::connect(&endpoint).await.err().unwrap().to_string();
        assert!(error.contains("not answering") && !error.contains(TOKEN), "{error}");

        // Connected first, then trex went away: an action was never sent, so it is not uncertain.
        let bridge = Bridge::start(|body| rpc(body, json!({"content":[]}))).await;
        let mut provider = ChromeProvider::connect(&bridge.endpoint()).await.unwrap();
        provider.endpoint = endpoint;
        let error = run(&provider, "full", "browser_click").await.unwrap_err();
        assert!(error.downcast_ref::<BrowserUncertain>().is_none());
        assert!(error.to_string().contains("not answering"), "{error}");
    }
}
