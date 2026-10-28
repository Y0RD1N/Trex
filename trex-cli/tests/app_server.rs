//! Offline, process-level contract tests. Every provider request stays on loopback.
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
        .env("NO_PROXY", "127.0.0.1,localhost");
    for name in [
        "OPENAI_API_KEY",
        "OPENROUTER_API_KEY",
        "DEEPSEEK_API_KEY",
        "MINIMAX_API_KEY",
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
    ] {
        command.env_remove(name);
    }
    command
}

fn save_profile(home: &Path, name: &str, endpoint: &str) {
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
            "name":name,"provider":"custom","baseUrl":endpoint,"model":"mock"
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
        Self::spawn_command(command(home), profile)
    }

    fn spawn_command(mut command: Command, profile: &str) -> Self {
        command
            .args(["--profile", profile, "app-server"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        // Parallel Unix fixtures can briefly inherit another fixture's open
        // executable copy until exec closes its CLOEXEC descriptor. Retry only
        // that transient ETXTBSY condition, never an actual agent failure.
        let spawn_deadline = Instant::now() + Duration::from_secs(1);
        let mut child = loop {
            match command.spawn() {
                Ok(child) => break child,
                Err(error)
                    if cfg!(unix)
                        && error.raw_os_error() == Some(26)
                        && Instant::now() < spawn_deadline =>
                {
                    thread::sleep(Duration::from_millis(10))
                }
                Err(error) => panic!("spawn actual trex-agent binary: {error}"),
            }
        };
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
        assert_eq!(request.body["model"], "mock");
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

struct Fixture {
    home: TempDir,
    workspace: TempDir,
    api: MockApi,
}

impl Fixture {
    fn new() -> Self {
        let fixture = Self {
            home: tempfile::tempdir().unwrap(),
            workspace: tempfile::tempdir().unwrap(),
            api: MockApi::new(),
        };
        save_profile(fixture.home.path(), "TREX1", &fixture.api.endpoint());
        fixture
    }

    fn agent(&self) -> Agent {
        Agent::spawn(self.home.path(), "TREX1")
    }
    fn journal_path(&self, session: &str) -> PathBuf {
        self.home
            .path()
            .join("private-home")
            .join("conversations")
            .join(format!("{session}.json"))
    }
    fn journal(&self, session: &str) -> Value {
        serde_json::from_slice(&fs::read(self.journal_path(session)).unwrap()).unwrap()
    }
}

fn tool(id: &str, name: &str, arguments: Value) -> Value {
    json!({"id":id,"type":"function","function":{"name":name,"arguments":arguments.to_string()}})
}

fn calls(calls: Vec<Value>) -> Value {
    json!({"role":"assistant","content":null,"tool_calls":calls})
}

fn messages(request: &HttpRequest) -> &[Value] {
    request.body["messages"].as_array().unwrap()
}

fn tool_output(request: &HttpRequest, id: &str) -> Value {
    let message = messages(request)
        .iter()
        .rev()
        .find(|m| m["role"] == "tool" && m["tool_call_id"] == id)
        .unwrap_or_else(|| panic!("missing tool result {id}: {}", request.body));
    serde_json::from_str(
        message["content"]
            .as_str()
            .expect("tool result must be a JSON string"),
    )
    .unwrap()
}

fn execution<'a>(journal: &'a Value, provider_id: &str) -> &'a Value {
    journal["executions"]
        .as_object()
        .unwrap()
        .iter()
        .find(|(id, execution)| {
            id.as_str() == provider_id || execution["provider_id"] == provider_id
        })
        .map(|(_, execution)| execution)
        .unwrap_or_else(|| panic!("missing execution {provider_id}: {journal}"))
}

fn assert_text(history: &Value, text: &str) {
    assert!(
        history["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["kind"] == "text" && item["text"] == text && item["final"] == true),
        "{history}"
    );
}

fn sse(socket: &mut TcpStream, value: Value) {
    write!(socket, "data: {value}\n\n").unwrap();
    socket.flush().unwrap();
}

#[test]
fn initialization_is_offline_and_models_have_normalized_capabilities() {
    let f = Fixture::new();
    let mut agent = f.agent();
    let initialized = agent.rpc("initialize", json!({"protocolVersion":1}));
    assert_eq!(initialized["protocolVersion"], 1);
    assert_eq!(initialized["profile"]["name"], "TREX1");
    assert_eq!(initialized["profile"]["hasApiKey"], false);
    assert_eq!(initialized["capabilities"]["interrupt"], true);
    f.api.assert_quiet();

    let id = agent.request("models/list", json!({}));
    f.api.request("GET", "/v1/models").json(json!({"data":[
        {"id":"mock","display_name":"Mock model","context_length":64000,
         "supportedEfforts":["low","high"],"architecture":{"input_modalities":["text","image"]}},
        {"id":"unknown"}
    ]}));
    assert_eq!(
        agent.result(id),
        json!({"models":[
            {"id":"mock","name":"Mock model","contextWindow":64000,"efforts":["low","high"],"inputModalities":["text","image"]},
            {"id":"unknown","name":"unknown"}
        ]})
    );
    let session = agent.start(f.workspace.path(), "plan", None);
    assert!(!session["sessionId"].as_str().unwrap().is_empty());
    assert_eq!(session["conversationId"], session["sessionId"]);
    assert_eq!(session["items"], json!([]));
    f.api.assert_quiet();
}

#[test]
fn plan_rejects_unadvertised_write_and_shell_then_delivers_a_final_plan() {
    let f = Fixture::new();
    fs::write(f.workspace.path().join("sentinel.txt"), "original").unwrap();
    let mut agent = f.agent();
    let started = agent.start(f.workspace.path(), "plan", None);
    let session = started["sessionId"].as_str().unwrap();
    agent.turn(session, "plan-turn", "Inspect and plan the change.");
    let request = f.api.chat();
    for definition in request.body["tools"].as_array().unwrap() {
        assert!(!["write_file", "apply_patch", "shell"]
            .contains(&definition["function"]["name"].as_str().unwrap()));
    }
    let shell = if cfg!(windows) {
        "Set-Content -LiteralPath shell.txt -Value forbidden"
    } else {
        "printf forbidden > shell.txt"
    };
    request.completion(
        calls(vec![
            tool(
                "forbidden-write",
                "write_file",
                json!({"path":"sentinel.txt","content":"forbidden"}),
            ),
            tool("forbidden-shell", "shell", json!({"command":shell})),
        ]),
        "tool_calls",
    );
    let followup = f.api.chat();
    for id in ["forbidden-write", "forbidden-shell"] {
        assert!(tool_output(&followup, id)["error"].is_string());
    }
    assert_eq!(
        fs::read_to_string(f.workspace.path().join("sentinel.txt")).unwrap(),
        "original"
    );
    assert!(!f.workspace.path().join("shell.txt").exists());
    followup.final_text("Plan: inspect the file, update it after approval, then validate.");
    agent.completed("plan-turn", "completed");
    agent.assert_no_event("permission/request");
    assert_text(
        &agent.history(session),
        "Plan: inspect the file, update it after approval, then validate.",
    );
    f.api.assert_quiet();
}

#[test]
fn application_tools_obey_planning_and_approval_modes() {
    for mode in ["plan", "ask"] {
        let f = Fixture::new();
        let mut agent = f.agent();
        let started = agent.start(f.workspace.path(), mode, None);
        let session = started["sessionId"].as_str().unwrap();
        agent.turn(
            session,
            "app-permissions",
            "Inspect the integration permissions.",
        );
        let request = f.api.chat();
        let definitions = request.body["tools"].as_array().unwrap();
        for name in ["github_repos", "github_prs", "github_pr_view"] {
            assert!(definitions
                .iter()
                .any(|tool| tool["function"]["name"] == name));
        }
        for name in [
            "github_pr_create",
            "github_pr_merge",
            "blender_run",
            "hyperframes_run",
        ] {
            assert_eq!(
                definitions
                    .iter()
                    .any(|tool| tool["function"]["name"] == name),
                mode != "plan",
                "{name} in {mode}"
            );
        }
        request.completion(
            calls(vec![tool(
                "write",
                "github_pr_merge",
                json!({"repository":"a/b","number":1,"headSha":"a".repeat(40),"strategy":"squash"}),
            )]),
            "tool_calls",
        );
        if mode == "ask" {
            let permission = agent.event("permission/request", "app-permissions");
            assert_eq!(permission["params"]["toolName"], "github_pr_merge");
            agent.rpc(
                "permission/respond",
                json!({"id":permission["params"]["id"],"allowed":false}),
            );
        }
        let followup = f.api.chat();
        assert!(tool_output(&followup, "write")["error"].is_string());
        followup.final_text("No changes were made.");
        agent.completed("app-permissions", "completed");
        f.api.assert_quiet();
    }
}

#[test]
fn session_guidance_reaches_the_actual_provider_and_is_immutable_only_while_live() {
    let f = Fixture::new();
    let mut agent = f.agent();
    let guidance = "DISCOVERY_GUIDANCE_V1: For computer requests use desktop_status then desktop_screenshot. For applications prefer github_*, blender_run and hyperframes_run when advertised.";
    let start = agent.rpc("session/start",json!({"cwd":f.workspace.path(),"mode":"plan","instructions":guidance,"desktopEnabled":true}));
    assert_eq!(start["instructionsApplied"], true);
    let session = start["sessionId"].as_str().unwrap();
    let duplicate=agent.rpc("session/start",json!({"cwd":f.workspace.path(),"mode":"plan","instructions":guidance,"desktopEnabled":true,"conversationId":session}));
    assert_eq!(duplicate["instructionsApplied"], true);
    let changed=agent.request("session/start",json!({"cwd":f.workspace.path(),"mode":"plan","instructions":"different","desktopEnabled":true,"conversationId":session}));
    assert!(agent.response(changed).get("error").is_some());
    agent.turn(session, "discovery-v1", "What tools can you use?");
    let request = f.api.chat();
    let policy = request.body["messages"][0]["content"].as_str().unwrap();
    assert_eq!(request.body["messages"][0]["role"], "system");
    assert!(policy.contains(guidance));
    assert!(policy.contains("Plan mode is strictly read-only"));
    for name in ["desktop_status", "desktop_screenshot", "github_repos"] {
        assert!(request.body["tools"]
            .as_array()
            .unwrap()
            .iter()
            .any(|tool| tool["function"]["name"] == name));
    }
    assert!(!request.body["tools"]
        .as_array()
        .unwrap()
        .iter()
        .any(|tool| tool["function"]["name"] == "desktop_click"));
    request.completion(
        calls(vec![tool(
            "forbidden",
            "write_file",
            json!({"path":"must-not-exist.txt","content":"forbidden"}),
        )]),
        "tool_calls",
    );
    let next = f.api.chat();
    assert!(tool_output(&next, "forbidden")["error"].is_string());
    assert!(!f.workspace.path().join("must-not-exist.txt").exists());
    next.final_text("Tools are available subject to plan permissions.");
    agent.completed("discovery-v1", "completed");
    assert!(!f
        .journal(session)
        .to_string()
        .contains("DISCOVERY_GUIDANCE_V1"));
    drop(agent);
    let mut restored = f.agent();
    let restarted=restored.rpc("session/start",json!({"cwd":f.workspace.path(),"mode":"plan","instructions":"DISCOVERY_GUIDANCE_V2: restored client instructions","conversationId":session,"desktopEnabled":true}));
    assert_eq!(restarted["instructionsApplied"], true);
    restored.turn(
        session,
        "discovery-v2",
        "Continue with the current guidance.",
    );
    let request = f.api.chat();
    let policy = request.body["messages"][0]["content"].as_str().unwrap();
    assert!(policy.contains("DISCOVERY_GUIDANCE_V2"));
    assert!(!policy.contains("DISCOVERY_GUIDANCE_V1"));
    request.final_text("Current guidance received.");
    restored.completed("discovery-v2", "completed");
    f.api.assert_quiet();
}

#[test]
fn session_guidance_is_bounded_and_standalone_sessions_have_tool_guidance() {
    let f = Fixture::new();
    let mut agent = f.agent();
    for invalid in [
        json!(""),
        json!(" "),
        json!("text\0hidden"),
        json!({"bad":true}),
        json!("x".repeat(32769)),
    ] {
        let id = agent.request(
            "session/start",
            json!({"cwd":f.workspace.path(),"mode":"plan","instructions":invalid}),
        );
        assert!(agent.response(id).get("error").is_some());
    }
    assert_eq!(
        agent.rpc(
            "session/start",
            json!({"cwd":f.workspace.path(),"mode":"plan","instructions":"x".repeat(32768)})
        )["instructionsApplied"],
        true
    );
    let start = agent.start(f.workspace.path(), "plan", None);
    assert_eq!(start["instructionsApplied"], false);
    let session = start["sessionId"].as_str().unwrap();
    agent.turn(
        session,
        "builtin-guidance",
        "Which applications can you use?",
    );
    let request = f.api.chat();
    let policy = request.body["messages"][0]["content"].as_str().unwrap();
    for name in [
        "GitHub",
        "Blender",
        "HyperFrames",
        "desktop_status",
        "desktop_screenshot",
        "browser_navigate",
    ] {
        assert!(policy.contains(name));
    }
    request.final_text("Only advertised capabilities are available.");
    agent.completed("builtin-guidance", "completed");
    f.api.assert_quiet();
}

#[test]
fn desktop_tools_are_opt_in_and_input_respects_permissions() {
    for (enabled, mode) in [(false, "ask"), (true, "plan"), (true, "ask")] {
        let f = Fixture::new();
        let mut agent = f.agent();
        let models = agent.request("models/list", json!({}));
        f.api.request("GET", "/v1/models").json(
            json!({"data":[{"id":"mock","architecture":{"input_modalities":["text","image"]}}]}),
        );
        agent.result(models);
        let started = agent.rpc(
            "session/start",
            json!({"cwd":f.workspace.path(),"mode":mode,"desktopEnabled":enabled}),
        );
        assert_eq!(started["desktopEnabled"], enabled);
        let session = started["sessionId"].as_str().unwrap();
        agent.turn(session, "desktop-policy", "Inspect available tools.");
        let request = f.api.chat();
        let definitions = request.body["tools"].as_array().unwrap();
        assert_eq!(
            definitions
                .iter()
                .any(|t| t["function"]["name"] == "desktop_screenshot"),
            enabled
        );
        assert_eq!(
            definitions
                .iter()
                .any(|t| t["function"]["name"] == "desktop_click"),
            enabled && mode != "plan"
        );
        request.completion(
            calls(vec![tool(
                "click",
                "desktop_click",
                json!({"observation":"invalid","x":0,"y":0}),
            )]),
            "tool_calls",
        );
        if enabled && mode == "ask" {
            let permission = agent.event("permission/request", "desktop-policy");
            assert_eq!(permission["params"]["toolName"], "desktop_click");
            agent.rpc(
                "permission/respond",
                json!({"id":permission["params"]["id"],"allowed":false}),
            );
        }
        let followup = f.api.chat();
        assert!(tool_output(&followup, "click")["error"].is_string());
        followup.final_text("No desktop input was sent.");
        agent.completed("desktop-policy", "completed");
        f.api.assert_quiet();
    }
}

#[test]
fn desktop_input_is_unavailable_without_confirmed_vision() {
    let f = Fixture::new();
    let mut agent = f.agent();
    let started = agent.rpc(
        "session/start",
        json!({"cwd":f.workspace.path(),"mode":"full","desktopEnabled":true}),
    );
    let session = started["sessionId"].as_str().unwrap();
    agent.turn(session, "no-vision", "Inspect available tools.");
    let request = f.api.chat();
    let definitions = request.body["tools"].as_array().unwrap();
    assert!(definitions
        .iter()
        .any(|t| t["function"]["name"] == "desktop_screenshot"));
    assert!(!definitions
        .iter()
        .any(|t| t["function"]["name"] == "desktop_click"));
    request.completion(
        calls(vec![tool(
            "click",
            "desktop_click",
            json!({"observation":"invalid","x":0,"y":0}),
        )]),
        "tool_calls",
    );
    let followup = f.api.chat();
    assert!(tool_output(&followup, "click")["error"].is_string());
    followup.final_text("No desktop input was sent.");
    agent.completed("no-vision", "completed");
    f.api.assert_quiet();
}

#[test]
fn visible_plan_is_durable_and_available_without_write_permissions() {
    for mode in ["plan", "ask", "full"] {
        let f = Fixture::new();
        let mut agent = f.agent();
        let started = agent.start(f.workspace.path(), mode, None);
        assert_eq!(started["mode"], mode);
        let session = started["sessionId"].as_str().unwrap().to_string();
        agent.turn(
            &session,
            "visible-plan",
            "Inspect and maintain a task list.",
        );
        let request = f.api.chat();
        assert!(request.body["tools"]
            .as_array()
            .unwrap()
            .iter()
            .any(|tool| tool["function"]["name"] == "update_plan"));
        let plan = json!({"plan":[{"step":"Inspect files","status":"completed"},{"step":"Validate the approach","status":"in_progress"}]});
        request.completion(
            calls(vec![tool("publish-plan", "update_plan", plan.clone())]),
            "tool_calls",
        );
        let finished = json!({"plan":[{"step":"Inspect files","status":"completed"},{"step":"Validate the approach","status":"completed"}]});
        f.api.chat().completion(
            calls(vec![tool("finish-plan", "update_plan", finished.clone())]),
            "tool_calls",
        );
        f.api
            .chat()
            .final_text("The task list is visible; no files were modified.");
        agent.completed("visible-plan", "completed");
        agent.assert_no_event("permission/request");
        let history = agent.history(&session);
        let updates: Vec<_> = history["items"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|item| item["name"] == "update_plan" && item["status"] == "done")
            .map(|item| item["input"].clone())
            .collect();
        assert_eq!(updates, vec![plan, finished], "mode={mode}");
        assert_eq!(history["mode"], mode);
        drop(agent);
        let mut restored = f.agent();
        let summary = restored.start(f.workspace.path(), mode, Some(&session));
        assert_eq!(summary["items"], history["items"]);
        assert_eq!(summary["mode"], mode);
        f.api.assert_quiet();
    }
}
#[test]
fn ask_defers_mutation_until_permission_and_denial_does_not_write() {
    let f = Fixture::new();
    let file = f.workspace.path().join("approval.txt");
    fs::write(&file, "original").unwrap();
    let mut agent = f.agent();
    let started = agent.start(f.workspace.path(), "ask", None);
    let session = started["sessionId"].as_str().unwrap();
    for (message, call, allow) in [
        ("deny-turn", "call_0", false),
        ("allow-turn", "call_0", true),
    ] {
        agent.turn(session, message, "Update the file.");
        f.api.chat().completion(
            calls(vec![tool(
                call,
                "write_file",
                json!({"path":"approval.txt","content":"approved"}),
            )]),
            "tool_calls",
        );
        let permission = agent.event("permission/request", message);
        assert_eq!(permission["params"]["toolName"], "write_file");
        assert_eq!(permission["params"]["input"]["path"], "approval.txt");
        assert_eq!(fs::read_to_string(&file).unwrap(), "original");
        let pending = agent.history(session);
        assert!(pending["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["kind"] == "permission" && item["state"] == "pending"));
        f.api.assert_quiet();
        agent.rpc(
            "permission/respond",
            json!({"id":permission["params"]["id"],"allowed":allow}),
        );
        let followup = f.api.chat();
        let output = tool_output(&followup, call);
        if allow {
            assert!(output.get("error").is_none(), "{output}");
            assert_eq!(fs::read_to_string(&file).unwrap(), "approved");
        } else {
            assert!(output["error"].is_string());
            assert_eq!(fs::read_to_string(&file).unwrap(), "original");
        }
        followup.final_text(if allow {
            "The approved change is saved."
        } else {
            "The change was denied; the file is unchanged."
        });
        agent.completed(message, "completed");
    }
    let history = agent.history(session);
    let states: Vec<_> = history["items"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|i| i["kind"] == "permission")
        .map(|i| i["state"].clone())
        .collect();
    assert_eq!(states, vec![json!("denied"), json!("allowed")]);
    f.api.assert_quiet();
}

#[test]
fn full_mode_replays_lossless_reasoning_and_tool_results_and_deduplicates_turns() {
    let f = Fixture::new();
    let mut agent = f.agent();
    let started = agent.start(f.workspace.path(), "full", None);
    let session = started["sessionId"].as_str().unwrap();
    let content = format!("héllo 🦖\n{}\n", "long tool argument ".repeat(400));
    let mut write = tool(
        "write-once",
        "write_file",
        json!({"path":"result.txt","content":content}),
    );
    // Whitespace in the arguments string is part of the provider's replay data.
    write["function"]["arguments"] = json!(serde_json::to_string_pretty(
        &json!({"path":"result.txt","content":content})
    )
    .unwrap());
    let assistant = json!({"role":"assistant","content":null,"reasoning_content":"Read before reporting.",
        "reasoning_details":[{"type":"reasoning.encrypted","index":0,"data":"opaque-payload","signature":"signed-verbatim"}],
        "vendor_reasoning":{"state":["keep",{"token":"exact"}]},"tool_calls":[write]});
    agent.turn(session, "write-read", "Write the result and read it back.");
    f.api.chat().completion(assistant.clone(), "tool_calls");
    let read_request = f.api.chat();
    assert_eq!(messages(&read_request)[2], assistant);
    assert!(tool_output(&read_request, "write-once")
        .get("error")
        .is_none());
    assert_eq!(
        fs::read_to_string(f.workspace.path().join("result.txt")).unwrap(),
        content
    );
    let read_assistant = calls(vec![tool(
        "read-back",
        "read_file",
        json!({"path":"result.txt"}),
    )]);
    let first_prefix = messages(&read_request).to_vec();
    read_request.completion(read_assistant.clone(), "tool_calls");
    let final_request = f.api.chat();
    assert_eq!(
        &messages(&final_request)[..first_prefix.len()],
        first_prefix.as_slice()
    );
    assert_eq!(messages(&final_request)[first_prefix.len()], read_assistant);
    assert_eq!(tool_output(&final_request, "read-back")["content"], content);
    final_request.final_text("The file was written and verified by reading it back.");
    agent.completed("write-read", "completed");
    agent.assert_no_event("permission/request");
    let before = agent.history(session);
    assert_text(
        &before,
        "The file was written and verified by reading it back.",
    );
    fs::write(f.workspace.path().join("result.txt"), "later user edit").unwrap();
    let duplicate = agent.rpc("turn/start", json!({"sessionId":session,"messageId":"write-read","text":"Write the result and read it back."}));
    assert_eq!(duplicate["duplicate"], true);
    agent.completed("write-read", "completed");
    assert_eq!(agent.history(session)["items"], before["items"]);
    assert_eq!(
        fs::read_to_string(f.workspace.path().join("result.txt")).unwrap(),
        "later user edit"
    );
    let conflict = agent.request(
        "turn/start",
        json!({"sessionId":session,"messageId":"write-read","text":"Different input"}),
    );
    assert!(agent.response(conflict).get("error").is_some());
    f.api.assert_quiet();
}

#[test]
fn streaming_delta_is_visible_before_finish_and_an_open_stream_is_interruptible() {
    let f = Fixture::new();
    let mut agent = f.agent();
    let started = agent.start(f.workspace.path(), "full", None);
    let session = started["sessionId"].as_str().unwrap();
    agent.turn(session, "stream-success", "Stream a response.");
    let mut socket = f.api.chat().sse();
    sse(
        &mut socket,
        json!({"choices":[{"index":0,"delta":{"role":"assistant","content":"first 🦖 "}}]}),
    );
    let delta = agent.event("message/delta", "stream-success");
    assert_eq!(delta["params"]["text"], "first 🦖 ");
    let partial = agent.history(session);
    assert!(partial["items"]
        .as_array()
        .unwrap()
        .iter()
        .any(|i| i["id"] == delta["params"]["id"] && i["final"] == false));
    assert!(!agent.seen.iter().any(|v| v["method"] == "turn/completed"));
    sse(
        &mut socket,
        json!({"choices":[{"delta":{"content":"last"}}]}),
    );
    sse(
        &mut socket,
        json!({"choices":[{"delta":{},"finish_reason":"stop"}]}),
    );
    socket.write_all(b"data: [DONE]\n\n").unwrap();
    socket.flush().unwrap();
    drop(socket);
    agent.completed("stream-success", "completed");
    assert_text(&agent.history(session), "first 🦖 last");

    agent.turn(
        session,
        "stream-cancel",
        "Keep streaming until interrupted.",
    );
    let mut socket = f.api.chat().sse();
    sse(
        &mut socket,
        json!({"choices":[{"delta":{"role":"assistant","content":"unfinished"}}]}),
    );
    agent.event("message/delta", "stream-cancel");
    let interrupted = agent.rpc(
        "turn/interrupt",
        json!({"sessionId":session,"messageId":"stream-cancel"}),
    );
    assert_eq!(interrupted["interrupted"], true);
    // Deliberately retain the live TCP stream with no finish event or EOF.
    agent.completed("stream-cancel", "interrupted");
    assert_text(&agent.history(session), "unfinished");
    drop(socket);
    agent.turn(session, "after-cancel", "Continue after interruption.");
    f.api.chat().final_text("The session remains usable.");
    agent.completed("after-cancel", "completed");
    f.api.assert_quiet();
}

#[test]
fn immediate_interrupt_after_start_cannot_overtake_start_dispatch() {
    let f = Fixture::new();
    let mut agent = f.agent();
    let started = agent.start(f.workspace.path(), "full", None);
    let session = started["sessionId"].as_str().unwrap();
    let start_id = agent.next_id + 1;
    let interrupt_id = start_id + 1;
    agent.next_id = interrupt_id;
    let frames = format!(
        "{}\n{}\n",
        json!({"jsonrpc":"2.0","id":start_id,"method":"turn/start","params":{"sessionId":session,"messageId":"immediate","text":"Begin work."}}),
        json!({"jsonrpc":"2.0","id":interrupt_id,"method":"turn/interrupt","params":{"sessionId":session,"messageId":"immediate"}})
    );
    agent
        .stdin
        .as_mut()
        .unwrap()
        .write_all(frames.as_bytes())
        .unwrap();
    agent.stdin.as_mut().unwrap().flush().unwrap();
    assert_eq!(agent.result(start_id)["accepted"], true);
    assert_eq!(agent.result(interrupt_id)["interrupted"], true);
    agent.completed("immediate", "interrupted");
    agent.assert_no_event("tool/start");
    // A request may have entered the loopback transport before cancellation.
    match f.api.requests.recv_timeout(QUIET) {
        Ok(Ok(request)) => drop(request),
        Err(RecvTimeoutError::Timeout) => (),
        // Cancellation can close an accepted socket before sending any headers.
        Ok(Err(_)) => (),
        Err(error) => panic!("{error}"),
    }
    agent.turn(session, "after-immediate", "Continue.");
    f.api.chat().final_text("Ready after interruption.");
    agent.completed("after-immediate", "completed");
}

#[test]
fn length_finish_fails_without_executing_even_complete_looking_tool_calls() {
    let f = Fixture::new();
    let mut agent = f.agent();
    let started = agent.start(f.workspace.path(), "ask", None);
    let session = started["sessionId"].as_str().unwrap();
    agent.turn(session, "truncated", "Write a file.");
    let mut truncated = calls(vec![tool(
        "must-not-run",
        "write_file",
        json!({"path":"truncated.txt","content":"unsafe"}),
    )]);
    truncated["content"] = json!("This response was cut off");
    f.api.chat().completion(truncated.clone(), "length");
    let completed = agent.completed("truncated", "failed");
    assert!(completed["params"]["error"].is_string());
    assert!(!f.workspace.path().join("truncated.txt").exists());
    agent.assert_no_event("permission/request");
    agent.assert_no_event("tool/start");
    let rejected = f.journal(session);
    assert_eq!(rejected["rejectedResponses"].as_array().unwrap().len(), 1);
    assert_eq!(rejected["rejectedResponses"][0]["finishReason"], "length");
    assert_eq!(rejected["rejectedResponses"][0]["message"], truncated);
    agent.turn(session, "after-length", "Give a complete answer.");
    let request = f.api.chat();
    assert!(messages(&request)
        .iter()
        .any(|m| m["role"] == "assistant" && m["content"] == "This response was cut off"));
    assert!(!messages(&request).iter().any(|m| m
        .get("tool_calls")
        .is_some_and(|calls| calls.as_array().is_some_and(|c| !c.is_empty()))));
    request.final_text("A complete answer after the failed response.");
    agent.completed("after-length", "completed");
    f.api.assert_quiet();
}

#[test]
fn restart_restores_stable_items_and_duplicate_turns_but_rejects_other_connections() {
    let f = Fixture::new();
    let mut agent = f.agent();
    let started = agent.start(f.workspace.path(), "full", None);
    let session = started["sessionId"].as_str().unwrap().to_owned();
    agent.turn(&session, "persisted", "Remember this conversation.");
    f.api.chat().final_text("This answer survives restart.");
    agent.completed("persisted", "completed");
    let history = agent.history(&session);
    drop(agent);

    let mut restored = f.agent();
    let summary = restored.start(f.workspace.path(), "full", Some(&session));
    assert_eq!(summary["sessionId"], session);
    assert_eq!(summary["items"], history["items"]);
    let duplicate = restored.rpc(
        "turn/start",
        json!({"sessionId":session,"messageId":"persisted","text":"Remember this conversation."}),
    );
    assert_eq!(duplicate["duplicate"], true);
    restored.completed("persisted", "completed");
    f.api.assert_quiet();
    drop(restored);

    let before = fs::read(f.journal_path(&session)).unwrap();
    save_profile(f.home.path(), "TREX2", &f.api.endpoint());
    let mut wrong_profile = Agent::spawn(f.home.path(), "TREX2");
    let id = wrong_profile.request(
        "session/start",
        json!({"cwd":f.workspace.path(),"mode":"full","conversationId":session}),
    );
    assert!(wrong_profile.response(id).get("error").is_some());
    assert_eq!(fs::read(f.journal_path(&session)).unwrap(), before);
    drop(wrong_profile);
    let other_api = MockApi::new();
    save_profile(f.home.path(), "TREX1", &other_api.endpoint());
    let mut wrong_endpoint = f.agent();
    let id = wrong_endpoint.request(
        "session/start",
        json!({"cwd":f.workspace.path(),"mode":"full","conversationId":session}),
    );
    assert!(wrong_endpoint.response(id).get("error").is_some());
    assert_eq!(fs::read(f.journal_path(&session)).unwrap(), before);
    other_api.assert_quiet();
    drop(wrong_endpoint);
    save_profile(f.home.path(), "TREX1", &f.api.endpoint());
    let mut original = f.agent();
    assert_eq!(
        original.start(f.workspace.path(), "full", Some(&session))["items"],
        history["items"]
    );
    f.api.assert_quiet();
}

#[test]
fn uncertain_mutation_is_never_replayed_and_requires_durable_recovery_acknowledgement() {
    let f = Fixture::new();
    let sentinel = f.workspace.path().join("uncertain.txt");
    fs::write(&sentinel, "inspect this existing state").unwrap();
    let mut agent = f.agent();
    let started = agent.start(f.workspace.path(), "full", None);
    let session = started["sessionId"].as_str().unwrap().to_owned();
    drop(agent);
    // Model a crash after the execution intent was synced but before its result.
    let mut journal = f.journal(&session);
    let input = json!({"path":"uncertain.txt","content":"must never be replayed"});
    journal["turns"]["crashed"] = json!({"request":{"text":"Perform the change.","display":"Perform the change.","images":[],"model":null,"effort":null},"status":"running","started_at":1});
    journal["executions"]["uncertain-write"] = json!({"name":"write_file","input":input,"state":"executing","message_id":"crashed","output":null,"is_error":false});
    journal["messages"] = json!([{"role":"user","content":"Perform the change."},calls(vec![tool("uncertain-write", "write_file", input.clone())])]);
    journal["items"] = json!([
        {"kind":"user","id":"crashed","text":"Perform the change.","images":0,"previews":[]},
        {"kind":"tool","id":"uncertain-write","name":"write_file","input":input,"status":"running","output":null,"patch":null}
    ]);
    fs::write(
        f.journal_path(&session),
        serde_json::to_vec(&journal).unwrap(),
    )
    .unwrap();
    let mut restored = f.agent();
    let summary = restored.start(f.workspace.path(), "full", Some(&session));
    assert_eq!(summary["recoveryRequired"], true);
    let recovered = f.journal(&session);
    assert_eq!(recovered["turns"]["crashed"]["status"], "interrupted");
    assert_eq!(recovered["executions"]["uncertain-write"]["state"], "done");
    assert_eq!(
        recovered["executions"]["uncertain-write"]["output"]["executionUncertain"],
        true
    );
    for attempt in ["blocked-one", "blocked-two"] {
        let id = restored.request(
            "turn/start",
            json!({"sessionId":session,"messageId":attempt,"text":"Try to continue."}),
        );
        assert!(restored.response(id).get("error").is_some());
    }
    assert_eq!(
        fs::read_to_string(&sentinel).unwrap(),
        "inspect this existing state"
    );
    f.api.assert_quiet();
    let ack = restored.rpc(
        "session/recover",
        json!({"sessionId":session,"action":"acknowledge"}),
    );
    assert_eq!(ack["recoveryRequired"], false);
    assert_eq!(f.journal(&session)["recoveryRequired"], false);
    drop(restored);
    let mut acknowledged = f.agent();
    assert_eq!(
        acknowledged.start(f.workspace.path(), "full", Some(&session))["recoveryRequired"],
        false
    );
    acknowledged.turn(
        &session,
        "after-ack",
        "Continue after inspecting the workspace.",
    );
    let request = f.api.chat();
    assert_eq!(
        tool_output(&request, "uncertain-write")["neverAutomaticallyRetry"],
        true
    );
    request.final_text("Continuing without retrying the uncertain write.");
    acknowledged.completed("after-ack", "completed");
    assert_eq!(
        fs::read_to_string(&sentinel).unwrap(),
        "inspect this existing state"
    );
    acknowledged.assert_no_event("tool/start");
    f.api.assert_quiet();
}

#[test]
fn inbox_rejects_partial_snapshots_and_commits_receipts_before_ack_without_double_apply() {
    let f = Fixture::new();
    let mut agent = f.agent();
    let started = agent.start(f.workspace.path(), "full", None);
    let session = started["sessionId"].as_str().unwrap();
    agent.turn(session, "inbox-turn", "Read queued instructions.");
    f.api.chat().completion(
        calls(vec![tool("read-invalid", "trex_read_messages", json!({}))]),
        "tool_calls",
    );
    let callback = agent.event("inbox/read", "inbox-turn");
    agent.send(json!({"jsonrpc":"2.0","id":callback["id"],"result":{"receiptId":"rejected-receipt","messages":[
        {"id":"must-not-partially-apply","text":"Rejected first message"},
        {"id":"inbox-turn","text":"Conflicts with an existing user item"}
    ]}}));
    let retry = f.api.chat();
    assert!(tool_output(&retry, "read-invalid")["error"].is_string());
    let rejected = f.journal(session);
    assert!(rejected["receipts"].get("rejected-receipt").is_none());
    assert!(!rejected["items"]
        .as_array()
        .unwrap()
        .iter()
        .any(|i| i["id"] == "must-not-partially-apply"));
    assert_eq!(rejected["pendingInbox"], json!([]));
    assert!(!messages(&retry)
        .iter()
        .any(|m| m["content"] == "Rejected first message"));
    assert!(!agent.seen.iter().any(|v| v["method"] == "inbox/consumed"));

    // Pause at a second callback in the same batch to inspect staged durability.
    retry.completion(
        calls(vec![
            tool("read-valid", "trex_read_messages", json!({})),
            tool("read-before-commit", "trex_read_messages", json!({})),
        ]),
        "tool_calls",
    );
    let receipt = json!({"receiptId":"receipt-once","messages":[{"id":"queued-once","text":"Apply these additional instructions."}]});
    let callback = agent.event("inbox/read", "inbox-turn");
    agent.send(json!({"jsonrpc":"2.0","id":callback["id"],"result":receipt}));
    let second_callback = agent.event("inbox/read", "inbox-turn");
    let staged = f.journal(session);
    assert_eq!(staged["receipts"]["receipt-once"]["committed"], false);
    assert_eq!(
        staged["pendingInbox"],
        json!([{"role":"user","content":"Apply these additional instructions."}])
    );
    assert_eq!(execution(&staged, "read-valid")["state"], "done");
    assert!(!agent.seen.iter().any(|v| v["method"] == "inbox/consumed"));
    agent.send(json!({"jsonrpc":"2.0","id":second_callback["id"],"result":receipt}));
    let consumed = agent.event("inbox/consumed", "inbox-turn");
    assert_eq!(consumed["params"]["receiptId"], "receipt-once");
    let durable = f.journal(session);
    assert_eq!(durable["receipts"]["receipt-once"]["committed"], true);
    assert_eq!(durable["pendingInbox"], json!([]));
    assert_eq!(
        durable["items"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|i| i["id"] == "queued-once")
            .count(),
        1
    );
    assert_eq!(
        execution(&durable, "read-before-commit")["output"]["received"],
        0
    );
    let after_commit = f.api.chat();
    assert_eq!(
        messages(&after_commit)
            .iter()
            .filter(
                |m| m["role"] == "user" && m["content"] == "Apply these additional instructions."
            )
            .count(),
        1
    );
    after_commit.completion(
        calls(vec![tool(
            "read-after-commit",
            "trex_read_messages",
            json!({}),
        )]),
        "tool_calls",
    );
    let callback = agent.event("inbox/read", "inbox-turn");
    agent.send(json!({"jsonrpc":"2.0","id":callback["id"],"result":receipt}));
    agent.event("inbox/consumed", "inbox-turn");
    let final_request = f.api.chat();
    assert_eq!(
        tool_output(&final_request, "read-after-commit")["received"],
        0
    );
    assert_eq!(
        messages(&final_request)
            .iter()
            .filter(
                |m| m["role"] == "user" && m["content"] == "Apply these additional instructions."
            )
            .count(),
        1
    );
    final_request.final_text("The queued instructions were received exactly once.");
    agent.completed("inbox-turn", "completed");
    assert_eq!(
        agent.history(session)["items"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|i| i["id"] == "queued-once")
            .count(),
        1
    );
    assert_eq!(
        execution(&f.journal(session), "read-after-commit")["output"]["received"],
        0
    );
    f.api.assert_quiet();
}

#[test]
fn inbox_delivers_images_and_attached_file_references_as_user_content_once() {
    let f = Fixture::new();
    // TempDir can use an 8.3 alias on Windows. Match the canonical paths that
    // the native session advertises to its tools, without a verbatim prefix.
    let root = fs::canonicalize(f.workspace.path()).unwrap();
    let root = root.to_string_lossy();
    let attachment =
        PathBuf::from(root.strip_prefix(r"\\?\").unwrap_or(&root)).join("informe con ñ.csv");
    let file_content = "producto,total\ncafé,42\n";
    fs::write(&attachment, file_content).unwrap();
    let text = format!("Revisa [Imagen 1] y [Archivo 1]. Última línea: fotografía 🦖\n\nArchivos adjuntos:\n[Archivo 1]: {}", attachment.display());
    let png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    let image = json!({"mediaType":"image/png","data":png});
    let mut agent = f.agent();
    let models = agent.request("models/list", json!({}));
    f.api
        .request("GET", "/v1/models")
        .json(json!({"data":[{"id":"mock","architecture":{"input_modalities":["text","image"]}}]}));
    agent.result(models);
    let summary = agent.start(f.workspace.path(), "full", None);
    let session = summary["sessionId"].as_str().unwrap();
    agent.turn(
        session,
        "queued-attachments",
        "Read the queued user request.",
    );
    f.api.chat().completion(
        calls(vec![tool(
            "inbox-attachments",
            "trex_read_messages",
            json!({}),
        )]),
        "tool_calls",
    );
    let callback = agent.event("inbox/read", "queued-attachments");
    let receipt = json!({"receiptId":"receipt-attachments","messages":[
        {"id":"queued-text-file","text":text,"images":[image]},
        {"id":"queued-image-only","text":"","images":[image]}
    ]});
    agent.send(json!({"jsonrpc":"2.0","id":callback["id"],"result":receipt}));
    agent.event("inbox/consumed", "queued-attachments");
    let delivered = f.api.chat();
    let expected = json!({"role":"user","content":[{"type":"text","text":text},{"type":"image_url","image_url":{"url":format!("data:image/png;base64,{png}")}}]});
    assert_eq!(
        messages(&delivered)
            .iter()
            .filter(|message| **message == expected)
            .count(),
        1,
        "{}",
        delivered.body
    );
    assert!(messages(&delivered).iter().any(|message| *message == json!({"role":"user","content":[{"type":"text","text":""},{"type":"image_url","image_url":{"url":format!("data:image/png;base64,{png}")}}]})));
    delivered.completion(
        calls(vec![tool(
            "read-attachment",
            "read_file",
            json!({"path":attachment}),
        )]),
        "tool_calls",
    );
    let verified = f.api.chat();
    assert_eq!(
        tool_output(&verified, "read-attachment")["content"],
        file_content,
        "{}",
        tool_output(&verified, "read-attachment")
    );
    verified.final_text("The attachment and both queued images were received.");
    agent.completed("queued-attachments", "completed");
    assert_eq!(
        f.journal(session)["receipts"]["receipt-attachments"]["committed"],
        true
    );
    assert_eq!(fs::read_to_string(attachment).unwrap(), file_content);
    f.api.assert_quiet();
}

#[path = "background_cases/mod.rs"]
mod background_cases;
#[path = "browser_cases/mod.rs"]
mod browser_cases;
#[path = "team_cases/mod.rs"]
mod team_cases;
