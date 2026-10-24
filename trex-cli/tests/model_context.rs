//! Offline context/usage contracts. Network fixtures use loopback and no credentials.
#![allow(dead_code)]
use serde_json::{json, Value};
use std::{
    collections::VecDeque,
    fs,
    io::{BufRead, BufReader, Read, Write},
    net::{SocketAddr, TcpListener, TcpStream},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, RecvTimeoutError},
        Arc, Mutex,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};
use tempfile::TempDir;

const TIMEOUT: Duration = Duration::from_secs(12);
const QUIET: Duration = Duration::from_millis(180);

fn command(home: &Path) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_trex-agent"));
    command
        .env("TREX_HOME", home.join("private-home"))
        .env("NO_PROXY", "127.0.0.1,localhost,::1");
    for name in [
        "OPENAI_API_KEY",
        "OPENROUTER_API_KEY",
        "DEEPSEEK_API_KEY",
        "MINIMAX_API_KEY",
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "http_proxy",
        "https_proxy",
        "all_proxy",
    ] {
        command.env_remove(name);
    }
    command
        .env("HTTP_PROXY", "http://127.0.0.1:1")
        .env("HTTPS_PROXY", "http://127.0.0.1:1")
        .env("ALL_PROXY", "http://127.0.0.1:1")
        .env("no_proxy", "127.0.0.1,localhost,::1");
    command
}

fn save_profile(home: &Path, name: &str, provider: &str, endpoint: &str, model: &str) {
    let mut child = command(home)
        .args(["profiles", "save", "--stdin-json"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn profile command");
    serde_json::to_writer(
        child.stdin.take().unwrap(),
        &json!({
            "name":name,"provider":provider,"baseUrl":endpoint,"model":model
        }),
    )
    .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "profile save: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let saved: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(saved["hasApiKey"], false);
}

struct Agent {
    child: Child,
    stdin: Option<ChildStdin>,
    frames: Receiver<Result<Value, String>>,
    pending: VecDeque<Value>,
    seen: Vec<Value>,
    stderr: Arc<Mutex<String>>,
    readers: Vec<JoinHandle<()>>,
    next_id: u64,
}

impl Agent {
    fn spawn(home: &Path, profile: &str) -> Self {
        let mut child = command(home)
            .args(["--profile", profile, "app-server"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn actual trex-agent binary");
        let stdin = child.stdin.take();
        let stdout = child.stdout.take().unwrap();
        let stderr_pipe = child.stderr.take().unwrap();
        let (tx, frames) = mpsc::channel();
        let stdout_reader = thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let value = line.map_err(|e| e.to_string()).and_then(|line| {
                    serde_json::from_str(&line)
                        .map_err(|e| format!("non-JSON stdout {line:?}: {e}"))
                });
                if tx.send(value).is_err() {
                    break;
                }
            }
        });
        let stderr = Arc::new(Mutex::new(String::new()));
        let errors = stderr.clone();
        let stderr_reader = thread::spawn(move || {
            let mut text = String::new();
            let _ = BufReader::new(stderr_pipe).read_to_string(&mut text);
            *errors.lock().unwrap() = text;
        });
        Self {
            child,
            stdin,
            frames,
            pending: VecDeque::new(),
            seen: vec![],
            stderr,
            readers: vec![stdout_reader, stderr_reader],
            next_id: 0,
        }
    }

    fn send(&mut self, value: Value) {
        let stdin = self.stdin.as_mut().unwrap();
        serde_json::to_writer(&mut *stdin, &value).unwrap();
        stdin.write_all(b"\n").unwrap();
        stdin.flush().unwrap();
    }

    fn request(&mut self, method: &str, params: Value) -> u64 {
        self.next_id += 1;
        let id = self.next_id;
        self.send(json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}));
        id
    }

    fn wait_for(&mut self, description: &str, matches: impl Fn(&Value) -> bool) -> Value {
        if let Some(index) = self.pending.iter().position(&matches) {
            return self.pending.remove(index).unwrap();
        }
        let deadline = Instant::now() + TIMEOUT;
        loop {
            let frame = self
                .frames
                .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                .unwrap_or_else(|e| {
                    panic!(
                        "waiting for {description}: {e}; frames={:?}; stderr={}",
                        self.seen,
                        self.stderr.lock().unwrap()
                    )
                })
                .unwrap_or_else(|e| panic!("{e}"));
            assert_eq!(frame["jsonrpc"], "2.0", "{frame}");
            self.seen.push(frame.clone());
            if matches(&frame) {
                return frame;
            }
            self.pending.push_back(frame);
        }
    }

    fn response(&mut self, id: u64) -> Value {
        self.wait_for("RPC response", |v| {
            v["id"] == id && v.get("method").is_none()
        })
    }

    fn result(&mut self, id: u64) -> Value {
        let response = self.response(id);
        assert!(response.get("error").is_none(), "{response}");
        response.get("result").expect("response result").clone()
    }

    fn rpc(&mut self, method: &str, params: Value) -> Value {
        let id = self.request(method, params);
        self.result(id)
    }

    fn event(&mut self, method: &str, message_id: &str) -> Value {
        self.wait_for(method, |v| {
            v["method"] == method && v["params"]["messageId"] == message_id
        })
    }

    fn completed(&mut self, message_id: &str, status: &str) -> Value {
        let event = self.event("turn/completed", message_id);
        assert_eq!(event["params"]["status"], status, "{event}");
        event
    }

    fn start(&mut self, workspace: &Path, mode: &str, conversation: Option<&str>) -> Value {
        self.rpc(
            "session/start",
            json!({"cwd":workspace,"mode":mode,"conversationId":conversation}),
        )
    }

    fn turn(&mut self, session: &str, message_id: &str, text: &str) {
        let accepted = self.rpc(
            "turn/start",
            json!({"sessionId":session,"messageId":message_id,"text":text}),
        );
        assert_eq!(accepted["accepted"], true);
    }

    fn history(&mut self, session: &str) -> Value {
        self.rpc("session/history", json!({"sessionId":session}))
    }

    fn assert_no_event(&self, method: &str) {
        assert!(
            !self.seen.iter().any(|v| v["method"] == method),
            "unexpected {method}: {:?}",
            self.seen
        );
    }
}

impl Drop for Agent {
    fn drop(&mut self) {
        self.stdin.take();
        let _ = self.child.kill();
        let _ = self.child.wait();
        for reader in self.readers.drain(..) {
            let _ = reader.join();
        }
    }
}

struct HttpRequest {
    method: String,
    path: String,
    headers: Vec<(String, String)>,
    body: Value,
    socket: TcpStream,
}

impl HttpRequest {
    fn parse(socket: TcpStream) -> Result<Self, String> {
        // Winsock can inherit FIONBIO from the nonblocking listener.
        socket.set_nonblocking(false).map_err(|e| e.to_string())?;
        socket
            .set_read_timeout(Some(TIMEOUT))
            .map_err(|e| e.to_string())?;
        socket
            .set_write_timeout(Some(TIMEOUT))
            .map_err(|e| e.to_string())?;
        let mut reader = BufReader::new(socket);
        let mut line = String::new();
        reader.read_line(&mut line).map_err(|e| e.to_string())?;
        let mut fields = line.split_whitespace();
        let method = fields.next().ok_or("missing HTTP method")?.to_owned();
        let path = fields.next().ok_or("missing HTTP path")?.to_owned();
        let mut headers = vec![];
        loop {
            line.clear();
            if reader.read_line(&mut line).map_err(|e| e.to_string())? == 0 {
                return Err("EOF in HTTP headers".into());
            }
            if line == "\r\n" || line == "\n" {
                break;
            }
            let (name, value) = line.split_once(':').ok_or("malformed HTTP header")?;
            headers.push((name.to_ascii_lowercase(), value.trim().to_owned()));
        }
        let length = headers
            .iter()
            .find(|(name, _)| name == "content-length")
            .map(|(_, value)| value.parse::<usize>().unwrap())
            .unwrap_or(0);
        assert!(length < 4 * 1024 * 1024, "oversized mock request");
        let mut bytes = vec![0; length];
        reader.read_exact(&mut bytes).map_err(|e| e.to_string())?;
        let body = if bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&bytes).map_err(|e| e.to_string())?
        };
        Ok(Self {
            method,
            path,
            headers,
            body,
            socket: reader.into_inner(),
        })
    }

    fn json(mut self, value: Value) {
        let bytes = serde_json::to_vec(&value).unwrap();
        write!(self.socket, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", bytes.len()).unwrap();
        self.socket.write_all(&bytes).unwrap();
        self.socket.flush().unwrap();
    }

    fn completion(self, message: Value, reason: &str) {
        self.json(
            json!({"choices":[{"index":0,"message":message,"finish_reason":reason}],
            "usage":{"prompt_tokens":11,"completion_tokens":3}}),
        );
    }

    fn final_text(self, text: &str) {
        self.completion(json!({"role":"assistant","content":text}), "stop");
    }

    fn sse(mut self) -> TcpStream {
        self.socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: close\r\n\r\n").unwrap();
        self.socket.flush().unwrap();
        self.socket
    }
}

struct MockApi {
    address: SocketAddr,
    requests: Receiver<Result<HttpRequest, String>>,
    stop: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
}

impl MockApi {
    fn new() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        listener.set_nonblocking(true).unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        let stopping = stop.clone();
        let (tx, requests) = mpsc::channel();
        let worker = thread::spawn(move || {
            while !stopping.load(Ordering::SeqCst) {
                match listener.accept() {
                    Ok((socket, _)) => {
                        if tx.send(HttpRequest::parse(socket)).is_err() {
                            break;
                        }
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(5))
                    }
                    Err(e) => {
                        let _ = tx.send(Err(e.to_string()));
                        break;
                    }
                }
            }
        });
        Self {
            address,
            requests,
            stop,
            worker: Some(worker),
        }
    }

    fn endpoint(&self) -> String {
        format!("http://{}/v1", self.address)
    }

    fn request(&self, method: &str, path: &str) -> HttpRequest {
        let request = self
            .requests
            .recv_timeout(TIMEOUT)
            .expect("local HTTP request")
            .expect("valid HTTP request");
        assert_eq!(request.method, method);
        assert_eq!(request.path, path);
        assert!(
            !request
                .headers
                .iter()
                .any(|(name, _)| name == "authorization"),
            "mock profile must have no key"
        );
        request
    }

    fn chat(&self) -> HttpRequest {
        let request = self.request("POST", "/v1/chat/completions");
        assert_eq!(request.body["stream"], true);
        request
    }

    fn assert_quiet(&self) {
        match self.requests.recv_timeout(QUIET) {
            Err(RecvTimeoutError::Timeout) => (),
            Ok(Ok(request)) => panic!("unexpected HTTP {} {}", request.method, request.path),
            Ok(Err(error)) => panic!("mock HTTP parse: {error}"),
            Err(error) => panic!("mock HTTP channel: {error}"),
        }
    }
}

impl Drop for MockApi {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

fn catalog(agent: &mut Agent, api: &MockApi, models: Value) -> Value {
    let id = agent.request("models/list", json!({}));
    api.request("GET", "/v1/models")
        .json(json!({"data":models}));
    agent.result(id)
}

fn fail_catalog(agent: &mut Agent, api: &MockApi) {
    let id = agent.request("models/list", json!({}));
    let mut request = api.request("GET", "/v1/models");
    request
        .socket
        .write_all(b"HTTP/1.1 500 Error\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
        .unwrap();
    drop(request);
    assert!(agent.response(id).get("error").is_some());
}

fn answer(request: HttpRequest, usage: Option<Value>, tool_id: Option<&str>) {
    let (message, reason) = match tool_id {
        Some(id) => (
            json!({"role":"assistant","content":null,"tool_calls":[{
                "id":id,"type":"function","function":{"name":"list_files","arguments":"{}"}
            }]}),
            "tool_calls",
        ),
        None => (json!({"role":"assistant","content":"done"}), "stop"),
    };
    let mut response = json!({"choices":[{"index":0,"message":message,"finish_reason":reason}]});
    if let Some(usage) = usage {
        response["usage"] = usage;
    }
    request.json(response);
}

fn measured(input: u64, output: u64) -> Value {
    json!({"prompt_tokens":input,"completion_tokens":output,
        "prompt_tokens_details":{"cached_tokens":7},
        "completion_tokens_details":{"reasoning_tokens":2}})
}

#[test]
fn official_minimax_limit_is_available_offline_before_the_first_turn() {
    let home = TempDir::new().unwrap();
    let workspace = TempDir::new().unwrap();
    for (index, endpoint) in ["", "https://API.MINIMAX.IO:443/v1/"]
        .into_iter()
        .enumerate()
    {
        let name = format!("TREX{index}");
        save_profile(
            home.path(),
            &name,
            "minimax",
            endpoint,
            "MiniMax-M3.1-Flash",
        );
        let mut agent = Agent::spawn(home.path(), &name);
        let initialized = agent.rpc("initialize", json!({"protocolVersion":1}));
        assert_eq!(initialized["models"][0]["contextWindow"], 1_000_000);
        assert_eq!(
            initialized["models"][0]["contextWindowSource"],
            "documented"
        );
        let started = agent.start(workspace.path(), "plan", None);
        assert_eq!(started["contextWindow"], 1_000_000);
        assert_eq!(started["contextWindowSource"], "documented");
        assert!(started.get("usage").is_none());
        drop(agent);
        let mut restored = Agent::spawn(home.path(), &name);
        let summary = restored.rpc(
            "session/start",
            json!({"cwd":workspace.path(),"mode":"plan",
            "conversationId":started["sessionId"],"model":"MiniMax-M3"}),
        );
        assert_eq!(summary["contextWindow"], 1_000_000);
        assert!(summary.get("usage").is_none());
        // Every operation above is offline; the process environment also
        // points all non-loopback traffic at a closed loopback proxy.
    }
}

#[test]
fn proxy_custom_and_openrouter_ids_do_not_inherit_minimax_limits() {
    for provider in ["minimax", "custom", "openrouter"] {
        let home = TempDir::new().unwrap();
        let workspace = TempDir::new().unwrap();
        let api = MockApi::new();
        save_profile(
            home.path(),
            "TREX1",
            provider,
            &api.endpoint(),
            "MiniMax-M3.1-Flash",
        );
        let mut agent = Agent::spawn(home.path(), "TREX1");
        let initialized = agent.rpc("initialize", json!({}));
        assert!(initialized["models"][0].get("contextWindow").is_none());
        let started = agent.start(workspace.path(), "plan", None);
        assert!(started["contextWindow"].is_null());
        assert!(started["contextWindowSource"].is_null());
        fail_catalog(&mut agent, &api);
        let summary = agent.history(started["sessionId"].as_str().unwrap());
        assert!(summary["contextWindow"].is_null());
        let result = catalog(
            &mut agent,
            &api,
            json!([
                {"id":"MiniMax-M3.1-Flash"},{"id":"MiniMax-M3"},
                {"id":"MiniMax-M3.1-Flash-preview"},{"id":"minimax/MiniMax-M3.1-Flash"}
            ]),
        );
        assert_eq!(result["models"].as_array().unwrap().len(), 4);
        for model in result["models"].as_array().unwrap() {
            assert!(model.get("contextWindow").is_none(), "{model}");
        }
        api.assert_quiet();
    }
}

#[test]
fn openrouter_effective_context_respects_both_limits_and_ignores_output_budget() {
    let home = TempDir::new().unwrap();
    let workspace = TempDir::new().unwrap();
    let api = MockApi::new();
    save_profile(
        home.path(),
        "TREX1",
        "openrouter",
        &api.endpoint(),
        "lower-endpoint",
    );
    let mut agent = Agent::spawn(home.path(), "TREX1");
    let result = catalog(
        &mut agent,
        &api,
        json!([
            {"id":"lower-endpoint","context_length":1_000_000,"top_provider":{"context_length":200_000,"max_completion_tokens":8192}},
            {"id":"lower-root","context_length":128_000,"top_provider":{"context_length":200_000}},
            {"id":"endpoint-only","top_provider":{"context_length":32_000}},
            {"id":"output-only","top_provider":{"max_completion_tokens":4096}},
            {"id":"root-only","context_length":64_000,"top_provider":{"context_length":0,"max_completion_tokens":4096}}
        ]),
    );
    let models = result["models"].as_array().unwrap();
    assert_eq!(models[0]["contextWindow"], 200_000);
    assert_eq!(models[1]["contextWindow"], 128_000);
    assert_eq!(models[2]["contextWindow"], 32_000);
    assert!(models[3].get("contextWindow").is_none());
    assert_eq!(models[4]["contextWindow"], 64_000);
    let started = agent.start(workspace.path(), "plan", None);
    assert_eq!(started["contextWindow"], 200_000);
    assert_eq!(started["contextWindowSource"], "remote");
    fail_catalog(&mut agent, &api);
    assert_eq!(
        agent.history(started["sessionId"].as_str().unwrap())["contextWindow"],
        200_000
    );
    api.assert_quiet();
}

#[test]
fn cached_remote_limits_follow_the_selected_model_and_failed_refresh_keeps_cache() {
    let home = TempDir::new().unwrap();
    let workspace = TempDir::new().unwrap();
    let api = MockApi::new();
    save_profile(
        home.path(),
        "TREX1",
        "minimax",
        &api.endpoint(),
        "MiniMax-M3.1-Flash",
    );
    let mut agent = Agent::spawn(home.path(), "TREX1");
    catalog(
        &mut agent,
        &api,
        json!([
            {"id":"MiniMax-M3.1-Flash","context_length":64_000},
            {"id":"MiniMax-M3","context_window":32_000}
        ]),
    );
    let started = agent.start(workspace.path(), "plan", None);
    assert_eq!(started["contextWindow"], 64_000);
    fail_catalog(&mut agent, &api);
    let session = started["sessionId"].as_str().unwrap();
    assert_eq!(agent.history(session)["contextWindow"], 64_000);
    let id = agent.request(
        "turn/start",
        json!({"sessionId":session,"messageId":"switch",
        "text":"hello","model":"MiniMax-M3"}),
    );
    assert_eq!(agent.result(id)["accepted"], true);
    let request = api.chat();
    assert_eq!(request.body["model"], "MiniMax-M3");
    answer(request, Some(measured(11, 3)), None);
    let completed = agent.completed("switch", "completed");
    assert_eq!(completed["params"]["usage"]["contextWindow"], 32_000);
    assert_eq!(completed["params"]["usage"]["contextModel"], "MiniMax-M3");
    assert_eq!(agent.history(session)["contextWindow"], 32_000);
    let id = agent.request(
        "turn/start",
        json!({"sessionId":session,"messageId":"unknown",
        "text":"hello","model":"MiniMax-M3-preview"}),
    );
    agent.result(id);
    answer(api.chat(), Some(measured(13, 5)), None);
    let completed = agent.completed("unknown", "completed");
    assert_eq!(
        completed["params"]["usage"]["contextModel"],
        "MiniMax-M3-preview"
    );
    assert!(completed["params"]["usage"].get("contextWindow").is_none());
    let summary = agent.history(session);
    assert!(summary["contextWindow"].is_null());
    assert_eq!(summary["usage"]["totalTokens"], 32);
    api.assert_quiet();
}

#[test]
fn three_request_turn_uses_last_request_context_and_cumulative_processed_tokens() {
    let home = TempDir::new().unwrap();
    let workspace = TempDir::new().unwrap();
    let api = MockApi::new();
    save_profile(home.path(), "TREX1", "custom", &api.endpoint(), "mock");
    let mut agent = Agent::spawn(home.path(), "TREX1");
    catalog(
        &mut agent,
        &api,
        json!([{"id":"mock","context_length":64_000}]),
    );
    let started = agent.start(workspace.path(), "plan", None);
    let session = started["sessionId"].as_str().unwrap();
    agent.turn(session, "z-turn", "inspect");
    answer(api.chat(), Some(measured(11, 3)), Some("first"));
    answer(api.chat(), Some(measured(11, 3)), Some("second"));
    answer(api.chat(), Some(measured(11, 3)), None);
    let completed = agent.completed("z-turn", "completed");
    let usage = &completed["params"]["usage"];
    assert_eq!(usage["inputTokens"], 33);
    assert_eq!(usage["outputTokens"], 9);
    assert_eq!(usage["contextTokens"], 14);
    assert_eq!(usage["contextModel"], "mock");
    assert_eq!(usage["contextWindow"], 64_000);
    let summary = agent.history(session);
    assert_eq!(summary["usage"]["totalTokens"], 42);
    assert_eq!(summary["usage"]["contextTokens"], 14);
    // Terminal deduplication must neither invoke the provider nor count twice.
    agent.turn(session, "z-turn", "inspect");
    agent.completed("z-turn", "completed");
    assert_eq!(agent.history(session)["usage"]["totalTokens"], 42);
    drop(agent);
    let mut restored = Agent::spawn(home.path(), "TREX1");
    // Reuse actual models/list metadata after restart, then restore without
    // issuing any additional authenticated/provider request for the summary.
    catalog(
        &mut restored,
        &api,
        json!([{"id":"mock","context_length":64_000}]),
    );
    let resumed = restored.start(workspace.path(), "plan", Some(session));
    assert_eq!(resumed["contextWindow"], 64_000);
    assert_eq!(resumed["contextWindowSource"], "remote");
    assert_eq!(resumed["usage"]["contextWindow"], 64_000);
    assert_eq!(resumed["usage"]["contextTokens"], 14);
    assert_eq!(resumed["usage"]["contextModel"], "mock");
    assert_eq!(resumed["usage"]["totalTokens"], 42);
    api.assert_quiet();
}

#[test]
fn absent_or_partial_last_usage_clears_measurement_without_fabricating_zero() {
    for final_usage in [
        None,
        Some(json!({"prompt_tokens":50})),
        Some(json!({"completion_tokens":8})),
    ] {
        let home = TempDir::new().unwrap();
        let workspace = TempDir::new().unwrap();
        let api = MockApi::new();
        save_profile(home.path(), "TREX1", "custom", &api.endpoint(), "mock");
        let mut agent = Agent::spawn(home.path(), "TREX1");
        let started = agent.start(workspace.path(), "plan", None);
        let session = started["sessionId"].as_str().unwrap();
        agent.turn(session, "missing", "inspect");
        answer(api.chat(), Some(measured(11, 3)), Some("first"));
        answer(api.chat(), Some(measured(11, 3)), Some("second"));
        answer(api.chat(), final_usage, None);
        let event = agent.completed("missing", "completed");
        let usage = &event["params"]["usage"];
        assert!(usage.get("contextTokens").is_none());
        assert_eq!(usage["inputTokens"], 22);
        assert_eq!(usage["outputTokens"], 6);
        let summary = agent.history(session);
        assert!(summary["usage"].get("contextTokens").is_none());
        assert_eq!(summary["usage"]["totalTokens"], 28);
        api.assert_quiet();
    }
}

fn journal_path(home: &Path, session: &str) -> PathBuf {
    home.join("private-home")
        .join("conversations")
        .join(format!("{session}.json"))
}

#[test]
fn restore_uses_event_chronology_sums_turns_once_and_preserves_measured_model() {
    let home = TempDir::new().unwrap();
    let workspace = TempDir::new().unwrap();
    save_profile(home.path(), "TREX1", "minimax", "", "MiniMax-M3.1-Flash");
    let mut agent = Agent::spawn(home.path(), "TREX1");
    let started = agent.start(workspace.path(), "plan", None);
    let session = started["sessionId"].as_str().unwrap();
    drop(agent);
    let path = journal_path(home.path(), session);
    let mut journal: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    journal["turns"] = json!({
        "z-old":{"request":{"model":null},"status":"completed","started_at":999,
            "usage":{"inputTokens":100,"outputTokens":10,"contextTokens":110,"contextModel":"MiniMax-M3.1-Flash"}},
        "a-new":{"request":{"model":"MiniMax-M3"},"status":"completed","started_at":1,
            "usage":{"inputTokens":200,"outputTokens":20,"contextTokens":220,"contextModel":"MiniMax-M3"}}
    });
    journal["items"] = json!([{"kind":"user","id":"z-old","text":"old"},
        {"kind":"user","id":"a-new","text":"new"}]);
    journal["events"] = json!([
        {"method":"turn/completed","params":{"messageId":"z-old"}},
        {"method":"turn/completed","params":{"messageId":"a-new"}}
    ]);
    fs::write(&path, serde_json::to_vec(&journal).unwrap()).unwrap();
    let mut restored = Agent::spawn(home.path(), "TREX1");
    let summary = restored.rpc(
        "session/start",
        json!({"cwd":workspace.path(),"mode":"plan",
        "conversationId":session,"model":"unknown-selected"}),
    );
    assert!(summary["contextWindow"].is_null());
    assert_eq!(summary["usage"]["contextTokens"], 220);
    assert_eq!(summary["usage"]["contextModel"], "MiniMax-M3");
    assert_eq!(summary["usage"]["contextWindow"], 1_000_000);
    assert_eq!(summary["usage"]["totalTokens"], 330);
    assert_eq!(restored.history(session)["usage"]["totalTokens"], 330);
    assert_eq!(
        serde_json::from_slice::<Value>(&fs::read(path).unwrap()).unwrap()["version"],
        1
    );
}

#[test]
fn legacy_nonempty_history_without_valid_measurement_keeps_used_unknown() {
    for usage in [
        Value::Null,
        json!({"inputTokens":0,"outputTokens":0,"contextTokens":0}),
        json!({"inputTokens":100,"contextTokens":100}),
        json!({"inputTokens":-1,"outputTokens":3,"contextTokens":3}),
    ] {
        let home = TempDir::new().unwrap();
        let workspace = TempDir::new().unwrap();
        save_profile(home.path(), "TREX1", "minimax", "", "MiniMax-M3.1-Flash");
        let mut agent = Agent::spawn(home.path(), "TREX1");
        let started = agent.start(workspace.path(), "plan", None);
        let session = started["sessionId"].as_str().unwrap();
        drop(agent);
        let path = journal_path(home.path(), session);
        let mut journal: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        journal["turns"] = json!({"legacy":{"request":{"model":null},"status":"completed",
            "started_at":1,"usage":usage}});
        journal["items"] = json!([{"kind":"user","id":"legacy","text":"existing history"}]);
        fs::write(&path, serde_json::to_vec(&journal).unwrap()).unwrap();
        let mut restored = Agent::spawn(home.path(), "TREX1");
        let summary = restored.start(workspace.path(), "plan", Some(session));
        assert_eq!(summary["contextWindow"], 1_000_000);
        assert!(summary["usage"].get("contextTokens").is_none(), "{summary}");
        assert_eq!(summary["usage"]["totalTokens"], 0);
    }
}

#[test]
fn restart_does_not_resurrect_measurement_before_a_later_unknown_turn() {
    let home = TempDir::new().unwrap();
    let workspace = TempDir::new().unwrap();
    let api = MockApi::new();
    save_profile(home.path(), "TREX1", "custom", &api.endpoint(), "mock");
    let mut agent = Agent::spawn(home.path(), "TREX1");
    let started = agent.start(workspace.path(), "plan", None);
    let session = started["sessionId"].as_str().unwrap();
    agent.turn(session, "z-measured", "first");
    answer(api.chat(), Some(measured(11, 3)), None);
    agent.completed("z-measured", "completed");
    agent.turn(session, "a-unknown", "second");
    answer(api.chat(), None, None);
    let completed = agent.completed("a-unknown", "completed");
    assert!(completed["params"]["usage"].get("contextTokens").is_none());
    let before = agent.history(session);
    assert!(before["usage"].get("contextTokens").is_none());
    assert_eq!(before["usage"]["totalTokens"], 14);
    drop(agent);
    let mut restored = Agent::spawn(home.path(), "TREX1");
    let summary = restored.start(workspace.path(), "plan", Some(session));
    assert_eq!(summary["usage"], before["usage"]);
    api.assert_quiet();
}

#[test]
fn legacy_measurement_keeps_original_model_across_override_and_repeated_restarts() {
    let home = TempDir::new().unwrap();
    let workspace = TempDir::new().unwrap();
    save_profile(home.path(), "TREX1", "minimax", "", "MiniMax-M3.1-Flash");
    let mut agent = Agent::spawn(home.path(), "TREX1");
    let started = agent.start(workspace.path(), "plan", None);
    let session = started["sessionId"].as_str().unwrap();
    drop(agent);
    let path = journal_path(home.path(), session);
    let mut journal: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    journal["turns"] = json!({"legacy":{"request":{"model":null},"status":"completed",
        "started_at":1,"usage":{"inputTokens":100,"outputTokens":10,"contextTokens":100}}});
    journal["items"] = json!([{"kind":"user","id":"legacy","text":"existing history"}]);
    fs::write(&path, serde_json::to_vec(&journal).unwrap()).unwrap();
    let mut restored = Agent::spawn(home.path(), "TREX1");
    let summary = restored.rpc(
        "session/start",
        json!({"cwd":workspace.path(),"mode":"plan",
        "conversationId":session,"model":"unknown-selected"}),
    );
    assert_eq!(summary["usage"]["contextModel"], "MiniMax-M3.1-Flash");
    assert_eq!(summary["usage"]["contextTokens"], 100);
    assert_eq!(summary["usage"]["totalTokens"], 110);
    assert!(summary["contextWindow"].is_null());
    assert_eq!(restored.history(session)["usage"], summary["usage"]);
    drop(restored);
    let mut again = Agent::spawn(home.path(), "TREX1");
    assert_eq!(
        again.start(workspace.path(), "plan", Some(session))["usage"],
        summary["usage"]
    );
    let saved: Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
    assert_eq!(saved["version"], 1);
    assert!(saved["turns"]["legacy"]["request"]["model"].is_null());
}
