//! «Tu navegador» through a loopback fake of the app's bridge (MCP over HTTP with JSON
//! responses, like src-tauri/src/browser_bridge.rs), driving the actual agent binary.
use super::*;
use std::collections::HashMap;

const TOKEN: &str = "chat-token_0123456789-abcdefghijklmnop";
const SCREENSHOT: &str = "browser_screenshot";
const OFFLINE: &str = "La extensión de trex no está conectada. Abre el navegador y comprueba que la extensión esté activa.";
const PNG: &str =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=";

fn expected_api_usage(
    input: u64,
    output: u64,
    requests: u64,
    cost: Option<f64>,
    partial: bool,
    cost_partial: bool,
) -> Value {
    json!({"inputTokens":input,"outputTokens":output,"totalTokens":input+output,"requests":requests,"costUsd":cost,
        "cachedReadTokens":null,"cachedWriteTokens":null,"reasoningTokens":null,"partial":partial,"costPartial":cost_partial})
}

/// How the fake bridge answers a `tools/call` for one tool.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Answer {
    Done,
    /// The bridge's own answer when the extension is not connected.
    Offline,
    /// The chat's token was revoked or expired (HTTP 401).
    Expired,
    Malformed,
    NotArray,
    Close,
    Hang,
}

struct BridgeState {
    /// Every request: its headers and JSON body.
    requests: Vec<(Vec<(String, String)>, Value)>,
    answers: HashMap<String, Answer>,
    image: (String, String),
}

struct FakeBridge {
    address: SocketAddr,
    state: Arc<Mutex<BridgeState>>,
    stop: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
}

fn reply(mut socket: TcpStream, status: &str, body: &[u8]) {
    let _ = write!(socket, "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
    let _ = socket.write_all(body);
    let _ = socket.flush();
}

fn bridge_tools() -> Value {
    let tab = json!({"type":"integer","description":"Id de la pestaña, de tabs_list."});
    let reference = json!({"type":"string","description":"Referencia ref_N de un elemento, de read_page."});
    let tool = |name: &str, properties: Value, required: Value, read: bool| {
        let mut tool = json!({"name":name,"description":format!("{name} en el grupo «trex»."),
            "inputSchema":{"type":"object","properties":properties,"required":required,"additionalProperties":false}});
        if read {
            tool["annotations"] = json!({"readOnlyHint":true});
        }
        tool
    };
    json!([
        tool("tabs_list", json!({}), json!([]), true),
        tool("read_page", json!({"tabId":tab}), json!(["tabId"]), true),
        tool("screenshot", json!({"tabId":tab}), json!(["tabId"]), true),
        tool("wait_for", json!({"tabId":tab,"text":{"type":"string"}}), json!(["tabId"]), true),
        tool("tab_open", json!({"url":{"type":"string"}}), json!(["url"]), false),
        tool("navigate", json!({"tabId":tab,"url":{"type":"string"}}), json!(["tabId","url"]), false),
        tool("click", json!({"tabId":tab,"ref":reference}), json!(["tabId","ref"]), false),
        tool("type", json!({"tabId":tab,"ref":reference,"text":{"type":"string"}}), json!(["tabId","text"]), false),
        tool("key", json!({"tabId":tab,"key":{"type":"string"}}), json!(["tabId","key"]), false),
        tool("scroll", json!({"tabId":tab,"direction":{"type":"string"}}), json!(["tabId"]), false),
        tool("tab_close", json!({"tabId":tab}), json!(["tabId"]), false),
    ])
}

const BRIDGE_TOOLS: [&str; 11] = ["tabs_list", "read_page", "screenshot", "wait_for", "tab_open", "navigate", "click", "type", "key", "scroll", "tab_close"];

impl FakeBridge {
    fn new() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        listener.set_nonblocking(true).unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        let state = Arc::new(Mutex::new(BridgeState {
            requests: Vec::new(),
            answers: HashMap::new(),
            image: ("image/png".into(), PNG.into()),
        }));
        let (stopping, shared) = (stop.clone(), state.clone());
        let worker = thread::spawn(move || {
            while !stopping.load(Ordering::SeqCst) {
                match listener.accept() {
                    Ok((socket, _)) => {
                        let (stopping, shared) = (stopping.clone(), shared.clone());
                        thread::spawn(move || Self::handle(socket, &shared, &stopping));
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => thread::sleep(Duration::from_millis(5)),
                    Err(_) => break,
                }
            }
        });
        Self { address, state, stop, worker: Some(worker) }
    }

    fn handle(socket: TcpStream, state: &Mutex<BridgeState>, stop: &AtomicBool) {
        let Ok(request) = HttpRequest::parse(socket) else { return };
        let header = |name: &str| request.headers.iter().find(|(key, _)| key == name).map(|(_, value)| value.clone());
        let body = request.body.clone();
        state.lock().unwrap().requests.push((request.headers.clone(), body.clone()));
        // The same gates as the bridge: an agent is not a web page, and needs its token.
        if request.method != "POST" || request.path != "/mcp" || header("origin").is_some() {
            return reply(request.socket, "403 Forbidden", br#"{"error":"Forbidden"}"#);
        }
        if header("authorization") != Some(format!("Bearer {TOKEN}")) {
            return reply(request.socket, "401 Unauthorized", br#"{"error":"invalid session"}"#);
        }
        let result = |result: Value| json!({"jsonrpc":"2.0","id":body["id"],"result":result}).to_string();
        let answer = match body["method"].as_str() {
            Some("initialize") => result(json!({"protocolVersion":"2025-11-25","capabilities":{"tools":{"listChanged":false}},
                "serverInfo":{"name":"trex-chrome","version":"test"},"instructions":"Empieza con tabs_list; lee con read_page antes de actuar."})),
            Some("notifications/initialized") => return reply(request.socket, "202 Accepted", b""),
            Some("tools/list") => result(json!({"tools":bridge_tools()})),
            Some("tools/call") => {
                let name = body["params"]["name"].as_str().unwrap_or("").to_owned();
                let (answer, image) = {
                    let state = state.lock().unwrap();
                    (state.answers.get(&name).copied().unwrap_or(Answer::Done), state.image.clone())
                };
                match answer {
                    Answer::Done => {
                        let mut content = vec![json!({"type":"text","text":match name.as_str() {
                            "tabs_list" => "tabId 4 · Inicio · http://localhost:5173/ (activa)",
                            "read_page" => "Inicio\nref_1 botón «Comprar»",
                            "screenshot" => "Captura de la pestaña 4.",
                            _ => "Hecho.",
                        }})];
                        if name == "screenshot" {
                            content.push(json!({"type":"image","mimeType":image.0,"data":image.1}));
                        }
                        result(json!({"content":content,"isError":false}))
                    }
                    Answer::Offline => result(json!({"content":[{"type":"text","text":OFFLINE}],"isError":true})),
                    Answer::Expired => return reply(request.socket, "401 Unauthorized", br#"{"error":"expired session"}"#),
                    Answer::Malformed => "{\"jsonrpc\":\"2.0\",".to_owned(),
                    Answer::NotArray => result(json!({"content":"Hecho."})),
                    Answer::Close => return,
                    Answer::Hang => {
                        let deadline = Instant::now() + Duration::from_secs(60);
                        while !stop.load(Ordering::SeqCst) && Instant::now() < deadline {
                            thread::sleep(Duration::from_millis(10));
                        }
                        return;
                    }
                }
            }
            _ => json!({"jsonrpc":"2.0","id":body["id"],"error":{"code":-32601,"message":"Método no encontrado"}}).to_string(),
        };
        reply(request.socket, "200 OK", answer.as_bytes());
    }

    fn url(&self) -> String {
        format!("http://{}/mcp", self.address)
    }

    fn answer(&self, tool: &str, answer: Answer) {
        self.state.lock().unwrap().answers.insert(tool.into(), answer);
    }

    fn image(&self, mime: &str, data: &str) {
        self.state.lock().unwrap().image = (mime.into(), data.into());
    }

    fn requests(&self) -> Vec<(Vec<(String, String)>, Value)> {
        self.state.lock().unwrap().requests.clone()
    }

    /// `tools/call` params, in order.
    fn calls(&self) -> Vec<Value> {
        self.requests().into_iter().filter(|(_, body)| body["method"] == "tools/call").map(|(_, body)| body["params"].clone()).collect()
    }

    fn wait_calls(&self, count: usize) -> Vec<Value> {
        let deadline = Instant::now() + TIMEOUT;
        loop {
            let calls = self.calls();
            if calls.len() >= count {
                return calls;
            }
            assert!(Instant::now() < deadline, "waiting for {count} browser calls; got {calls:?}");
            thread::sleep(Duration::from_millis(10));
        }
    }
}

impl Drop for FakeBridge {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

struct ChromeFixture {
    base: Fixture,
    bridge: FakeBridge,
}

impl ChromeFixture {
    fn new() -> Self {
        Self { base: Fixture::new(), bridge: FakeBridge::new() }
    }

    /// An agent whose chat has the person's browser, as trex starts it.
    fn agent(&self) -> Agent {
        self.agent_with(Some(&self.bridge.url()), Some(TOKEN))
    }

    fn agent_with(&self, url: Option<&str>, token: Option<&str>) -> Agent {
        let mut command = command(self.base.home.path());
        if let Some(url) = url {
            command.env("TREX_CHROME_URL", url);
        }
        if let Some(token) = token {
            command.env("TREX_CHROME_TOKEN", token);
        }
        Agent::spawn_command(command, "TREX1")
    }

    fn enabled(&self, agent: &mut Agent, mode: &str) -> String {
        let started = agent.start(self.base.workspace.path(), mode, None);
        assert_eq!(started["chromeEnabled"], true, "{started}");
        assert_eq!(started["unavailableMcpServers"], json!([]), "{started}");
        started["sessionId"].as_str().unwrap().to_owned()
    }

    /// Neither image bytes nor the token reach durable history, events or the model.
    fn assert_private(&self, agent: &mut Agent, session: &str) {
        let history = agent.history(session);
        for (description, text) in [
            ("journal", fs::read_to_string(self.base.journal_path(session)).unwrap()),
            ("history", history.to_string()),
            ("events", json!(agent.seen).to_string()),
        ] {
            assert!(!text.contains(PNG), "image payload leaked to {description}");
            assert!(!text.contains("data:image/"), "image data URL leaked to {description}");
            assert!(!text.contains(TOKEN), "token leaked to {description}");
        }
    }
}

fn catalog(agent: &mut Agent, api: &MockApi, modalities: Option<&[&str]>) {
    let mut selected = json!({"id":"mock"});
    if let Some(modalities) = modalities {
        selected["inputModalities"] = json!(modalities);
    }
    let id = agent.request("models/list", json!({}));
    api.request("GET", "/v1/models")
        .json(json!({"data":[selected,
        {"id":"text-model","inputModalities":["text"]}, {"id":"unknown-model"}]}));
    let result = agent.result(id);
    assert_eq!(result["models"][0]["id"], "mock");
}

fn definitions(request: &HttpRequest) -> Vec<&str> {
    request.body["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|value| value["function"]["name"].as_str().unwrap())
        .collect()
}

fn browser_tools(request: &HttpRequest) -> Vec<&str> {
    definitions(request).into_iter().filter(|name| name.starts_with("browser_")).collect()
}

fn image_parts(request: &HttpRequest) -> Vec<(usize, &Value)> {
    messages(request)
        .iter()
        .enumerate()
        .flat_map(|(index, message)| {
            message["content"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|part| part["type"] == "image_url")
                .map(move |part| (index, part))
        })
        .collect()
}

fn assert_no_image_payload(request: &HttpRequest) {
    assert!(image_parts(request).is_empty());
    let body = request.body.to_string();
    assert!(!body.contains(PNG), "image payload sent to model without image support");
    assert!(!body.contains("data:image/"));
}

fn assert_image_after_batch(request: &HttpRequest, ids: &[&str]) {
    let messages = messages(request);
    let parts = image_parts(request);
    assert_eq!(parts.len(), 1, "expected one transient image observation");
    let index = parts[0].0;
    assert_eq!(messages[index]["role"], "user");
    assert_eq!(parts[0].1["image_url"]["url"], format!("data:image/png;base64,{PNG}"));
    assert!(messages[index]["content"].as_array().unwrap().iter().any(|part| {
        part["type"] == "text"
            && part["text"].as_str().is_some_and(|text| text.contains("tool_call_id=") && text.contains("artifact_id="))
    }));
    let start = index.checked_sub(ids.len()).expect("whole tool batch precedes image");
    let result_ids: Vec<_> = messages[start..index]
        .iter()
        .map(|message| {
            assert_eq!(message["role"], "tool");
            message["tool_call_id"].as_str().unwrap()
        })
        .collect();
    assert_eq!(result_ids, ids, "image observation must follow the entire tool batch");
    for message in messages.iter().filter(|message| message["role"] == "tool") {
        let text = message["content"].as_str().expect("tool content remains a string");
        assert!(!text.contains(PNG));
        assert!(!text.contains("data:image/"));
    }
}

fn finish_and_check_stderr(agent: &mut Agent) {
    // Join the shared stderr reader before inspecting it: while the process is
    // alive its read_to_string intentionally keeps diagnostics in its buffer.
    agent.stdin.take();
    let _ = agent.child.kill();
    let _ = agent.child.wait();
    for reader in agent.readers.drain(..) {
        reader.join().unwrap();
    }
    let stderr = agent.stderr.lock().unwrap();
    assert!(!stderr.contains(PNG), "image payload leaked to stderr");
    assert!(!stderr.contains("data:image/"));
    assert!(!stderr.contains(TOKEN), "token leaked to stderr");
}

#[test]
fn without_both_variables_there_are_no_browser_tools_and_no_requests() {
    let f = ChromeFixture::new();
    let url = f.bridge.url();
    for (url, token, reported) in [
        (None, None, false),
        (Some(url.as_str()), None, true),
        (None, Some(TOKEN), true),
        (Some("http://example.com:7341/mcp"), Some(TOKEN), true),
        (Some(url.as_str()), Some("short"), true),
    ] {
        let mut agent = f.agent_with(url, token);
        let started = agent.start(f.base.workspace.path(), "full", None);
        let session = started["sessionId"].as_str().unwrap();
        if reported {
            assert_eq!(started["chromeEnabled"], false, "{started}");
            assert_eq!(started["unavailableMcpServers"], json!(["trex_chrome"]));
        } else {
            assert!(started.get("chromeEnabled").is_none(), "{started}");
            assert_eq!(started["unavailableMcpServers"], json!([]));
        }
        assert!(!started.to_string().contains(TOKEN));
        agent.turn(session, "native", "Read the workspace.");
        let request = f.base.api.chat();
        assert!(definitions(&request).contains(&"read_file"));
        assert!(browser_tools(&request).is_empty());
        assert!(!request.body.to_string().contains("browser_* tools"));
        request.final_text("Native tools only.");
        agent.completed("native", "completed");
        assert!(f.bridge.requests().is_empty(), "no variables, no requests");
        finish_and_check_stderr(&mut agent);
    }
}

#[test]
fn no_child_process_inherits_the_browser_variables() {
    let f = ChromeFixture::new();
    // Inherited as is, or forwarded by name: neither way reaches a child.
    for settings in [
        json!({"shell":{"environment":"inherit"}}),
        json!({"shell":{"environment":"minimal","forwardEnv":["TREX_CHROME_URL","TREX_CHROME_TOKEN","TREX_TEST_INHERITED"]}}),
    ] {
        let mut command = command(f.base.home.path());
        command.env("TREX_CHROME_URL", f.bridge.url()).env("TREX_CHROME_TOKEN", TOKEN).env("TREX_TEST_INHERITED", "visible");
        let mut agent = Agent::spawn_command(command, "TREX1");
        let started = agent.rpc("session/start", json!({"cwd":f.base.workspace.path(),"mode":"full","settings":settings}));
        assert_eq!(started["chromeEnabled"], true, "the CLI itself keeps the browser: {started}");
        let session = started["sessionId"].as_str().unwrap();
        agent.turn(session, "env", "Print the environment.");
        let shell = if cfg!(windows) {
            "Write-Output ('url=' + $env:TREX_CHROME_URL + ';token=' + $env:TREX_CHROME_TOKEN + ';control=' + $env:TREX_TEST_INHERITED)"
        } else {
            "printf 'url=%s;token=%s;control=%s' \"$TREX_CHROME_URL\" \"$TREX_CHROME_TOKEN\" \"$TREX_TEST_INHERITED\""
        };
        f.base.api.chat().completion(calls(vec![tool("env", "shell", json!({"command":shell}))]), "tool_calls");
        let request = f.base.api.chat();
        let stdout = tool_output(&request, "env")["stdout"].as_str().unwrap().to_owned();
        assert!(stdout.contains("url=;token=;control=visible"), "{settings}: {stdout}");
        assert!(!stdout.contains(TOKEN));
        request.final_text("Checked.");
        agent.completed("env", "completed");
        finish_and_check_stderr(&mut agent);
    }
    assert!(f.bridge.requests().iter().all(|(headers, _)| headers.iter().any(|(name, value)| name == "authorization" && value == &format!("Bearer {TOKEN}"))));
}

#[test]
fn tools_are_listed_with_the_browser_prefix_and_the_token_only_travels_in_its_header() {
    let f = ChromeFixture::new();
    let mut agent = f.agent();
    let session = f.enabled(&mut agent, "full");
    // Reattaching keeps the answer.
    assert_eq!(agent.start(f.base.workspace.path(), "full", Some(&session))["chromeEnabled"], true);
    agent.turn(&session, "list", "Which tabs are open?");
    let request = f.base.api.chat();
    let expected: Vec<String> = BRIDGE_TOOLS.iter().map(|name| format!("browser_{name}")).collect();
    assert_eq!(browser_tools(&request), expected);
    assert!(definitions(&request).contains(&"read_file"));
    let click = request.body["tools"].as_array().unwrap().iter().find(|tool| tool["function"]["name"] == "browser_click").unwrap();
    assert_eq!(click["function"]["parameters"]["required"], json!(["tabId", "ref"]));
    assert!(click["function"]["description"].as_str().unwrap().contains("click en el grupo"));
    let system = messages(&request)[0]["content"].as_str().unwrap();
    assert!(system.contains("browser_* tools") && system.contains("Empieza con tabs_list"), "{system}");
    assert!(!request.body.to_string().contains(TOKEN), "the token never reaches the model");
    request.completion(calls(vec![tool("tabs", "browser_tabs_list", json!({}))]), "tool_calls");
    let followup = f.base.api.chat();
    let output = tool_output(&followup, "tabs");
    assert!(output["text"].as_str().unwrap().contains("tabId 4 · Inicio"), "{output}");
    assert!(output.get("isError").is_none_or(|error| error == false));
    followup.final_text("One tab is open.");
    agent.completed("list", "completed");

    let requests = f.bridge.requests();
    let methods: Vec<_> = requests.iter().map(|(_, body)| body["method"].as_str().unwrap()).collect();
    assert_eq!(methods, ["initialize", "notifications/initialized", "tools/list", "tools/call"]);
    assert_eq!(requests[3].1["params"], json!({"name":"tabs_list","arguments":{}}));
    for (headers, body) in &requests {
        let header = |name: &str| headers.iter().find(|(key, _)| key == name).map(|(_, value)| value.as_str());
        assert_eq!(header("authorization"), Some(format!("Bearer {TOKEN}").as_str()));
        assert_eq!(header("host"), Some(f.bridge.address.to_string().as_str()));
        assert!(header("origin").is_none());
        assert!(!body.to_string().contains(TOKEN));
    }
    f.assert_private(&mut agent, &session);
    f.base.api.assert_quiet();
    finish_and_check_stderr(&mut agent);
}

#[test]
fn vision_screenshot_follows_the_whole_batch_and_stays_out_of_durable_history() {
    let f = ChromeFixture::new();
    fs::write(f.base.workspace.path().join("evidence.txt"), "native evidence").unwrap();
    let mut agent = f.agent();
    catalog(&mut agent, &f.base.api, Some(&["text", "image"]));
    let session = f.enabled(&mut agent, "full");
    agent.turn(&session, "vision-batch", "Capture evidence and read the file.");
    let initial = f.base.api.chat();
    assert!(definitions(&initial).contains(&SCREENSHOT));
    initial.completion(
        calls(vec![
            tool("screen", SCREENSHOT, json!({"tabId":4})),
            tool("native", "read_file", json!({"path":"evidence.txt"})),
            tool("page", "browser_read_page", json!({"tabId":4})),
        ]),
        "tool_calls",
    );
    let followup = f.base.api.chat();
    assert_image_after_batch(&followup, &["screen", "native", "page"]);
    assert_eq!(tool_output(&followup, "native")["content"], "native evidence");
    assert!(tool_output(&followup, "page")["text"].as_str().unwrap().contains("ref_1"));
    let output = tool_output(&followup, "screen");
    assert!(output["text"].as_str().unwrap().contains("Captura de la pestaña 4"));
    // The model reads compact references; hashes and provenance stay in the journal.
    let image = &output["artifacts"].as_array().unwrap()[0];
    assert_eq!(image["kind"], "image");
    assert_eq!(image["mimeType"], "image/png");
    assert_eq!((image["width"].as_u64(), image["height"].as_u64()), (Some(1), Some(1)));
    assert!(image.get("provenance").is_none() && image.get("sha256").is_none());
    let stored = execution(&f.base.journal(&session), "screen")["output"].clone();
    let local = &stored["artifacts"][0];
    assert_eq!(local["storage"], "local");
    assert!(local["sizeBytes"].as_u64().unwrap() > 0);
    assert_eq!(local["provenance"]["toolCallId"], "screen");
    assert_eq!(local["provenance"]["toolName"], SCREENSHOT);
    followup.final_text("Evidence captured.");
    agent.completed("vision-batch", "completed");
    let calls = f.bridge.calls();
    assert_eq!(calls, [json!({"name":"screenshot","arguments":{"tabId":4}}), json!({"name":"read_page","arguments":{"tabId":4}})]);
    f.assert_private(&mut agent, &session);
    f.base.api.assert_quiet();
    finish_and_check_stderr(&mut agent);
}

#[test]
fn screenshot_projection_obeys_catalog_for_text_unknown_and_model_switches() {
    for modalities in [Some(&["text"][..]), None, Some(&["text", "image"][..])] {
        let f = ChromeFixture::new();
        let mut agent = f.agent();
        catalog(&mut agent, &f.base.api, modalities);
        let session = f.enabled(&mut agent, "full");
        agent.turn(&session, "capture", "Capture one screenshot.");
        f.base.api.chat().completion(calls(vec![tool("screen", SCREENSHOT, json!({"tabId":4}))]), "tool_calls");
        let request = f.base.api.chat();
        if modalities.is_some_and(|value| value.contains(&"image")) {
            assert_image_after_batch(&request, &["screen"]);
        } else {
            assert_no_image_payload(&request);
            let expected = if modalities.is_some() { "text only" } else { "unknown" };
            assert!(tool_output(&request, "screen")["text"].as_str().unwrap().contains(expected));
        }
        request.final_text("Screenshot recorded.");
        agent.completed("capture", "completed");
        let original = execution(&f.base.journal(&session), "screen")["output"].clone();
        for (id, model, expected) in [("text", "text-model", "text only"), ("unknown", "unknown-model", "unknown"), ("vision", "mock", "image")] {
            let accepted = agent.rpc("turn/start", json!({"sessionId":session,"messageId":id,"text":"Review the previous evidence.","model":model}));
            assert_eq!(accepted["accepted"], true);
            let request = f.base.api.request("POST", "/v1/chat/completions");
            assert_eq!(request.body["model"], model);
            let image_expected = expected == "image" && modalities.is_some_and(|value| value.contains(&"image"));
            assert_eq!(!image_parts(&request).is_empty(), image_expected);
            if !image_expected {
                assert_no_image_payload(&request);
            }
            if expected != "image" {
                assert!(tool_output(&request, "screen")["text"].as_str().unwrap().contains(expected));
            }
            request.final_text("Reviewed without repeating the tool.");
            agent.completed(id, "completed");
            assert_eq!(execution(&f.base.journal(&session), "screen")["output"], original);
        }
        assert_eq!(f.bridge.calls().len(), 1, "switching models must not rerun the browser");
        f.assert_private(&mut agent, &session);
        f.base.api.assert_quiet();
        finish_and_check_stderr(&mut agent);
    }
}

#[test]
fn restored_image_rehydrates_or_reports_missing_without_replay_or_a_browser() {
    let f = ChromeFixture::new();
    let mut agent = f.agent();
    catalog(&mut agent, &f.base.api, Some(&["text", "image"]));
    let session = f.enabled(&mut agent, "full");
    agent.turn(&session, "capture", "Capture evidence.");
    f.base.api.chat().completion(calls(vec![tool("screen", SCREENSHOT, json!({"tabId":4}))]), "tool_calls");
    let followup = f.base.api.chat();
    assert_image_after_batch(&followup, &["screen"]);
    followup.final_text("Evidence is saved.");
    agent.completed("capture", "completed");
    let history = agent.history(&session);
    let output = execution(&f.base.journal(&session), "screen")["output"].clone();
    let artifact_path = f.base.home.path().join("private-home/artifacts").join(format!("{}.bin", output["artifacts"][0]["id"].as_str().unwrap()));
    finish_and_check_stderr(&mut agent);
    drop(agent);
    let requests = f.bridge.requests().len();

    // Restored by a process started without the browser.
    let mut restored = f.base.agent();
    catalog(&mut restored, &f.base.api, Some(&["text", "image"]));
    let summary = restored.start(f.base.workspace.path(), "full", Some(&session));
    assert_eq!(summary["items"], history["items"]);
    assert!(summary.get("chromeEnabled").is_none());
    let duplicate = restored.rpc("turn/start", json!({"sessionId":session,"messageId":"capture","text":"Capture evidence."}));
    assert_eq!(duplicate["duplicate"], true);
    restored.completed("capture", "completed");
    f.base.api.assert_quiet();
    restored.turn(&session, "intact-restore", "Review the saved image.");
    let request = f.base.api.chat();
    assert_image_after_batch(&request, &["screen"]);
    assert!(browser_tools(&request).is_empty());
    request.final_text("The saved screenshot is available.");
    restored.completed("intact-restore", "completed");
    f.assert_private(&mut restored, &session);
    finish_and_check_stderr(&mut restored);
    drop(restored);

    fs::remove_file(artifact_path).unwrap();
    let mut restored = f.base.agent();
    catalog(&mut restored, &f.base.api, Some(&["text", "image"]));
    restored.start(f.base.workspace.path(), "full", Some(&session));
    restored.turn(&session, "after-restore", "Review the existing evidence.");
    let request = f.base.api.chat();
    assert_no_image_payload(&request);
    let text = tool_output(&request, "screen")["text"].as_str().unwrap().to_owned();
    assert!(text.contains("unavailable") && text.contains("missing") && text.contains("do not repeat"), "{text}");
    request.final_text("The recorded image is unavailable.");
    restored.completed("after-restore", "completed");
    assert_eq!(execution(&f.base.journal(&session), "screen")["output"], output);
    assert_eq!(f.bridge.requests().len(), requests, "restoring never reaches the browser");
    f.assert_private(&mut restored, &session);
    finish_and_check_stderr(&mut restored);
}

/// Swaps the saved screenshot for `invalid` bytes under a matching hash, as a corrupt store would.
fn replace_saved_image(f: &ChromeFixture, session: &str, invalid: &[u8]) -> Value {
    use sha2::Digest;
    let mut journal = f.base.journal(session);
    let mut output = execution(&journal, "screen")["output"].clone();
    let reference = &mut output["artifacts"][0];
    let old_id = reference["id"].as_str().unwrap().to_owned();
    let hash = format!("{:x}", sha2::Sha256::digest(invalid));
    reference["id"] = json!(hash);
    reference["sha256"] = json!(hash);
    reference["sizeBytes"] = json!(invalid.len());
    let directory = f.base.home.path().join("private-home/artifacts");
    let original = directory.join(format!("{old_id}.bin"));
    fs::write(&original, invalid).unwrap();
    fs::rename(original, directory.join(format!("{hash}.bin"))).unwrap();
    for execution in journal["executions"].as_object_mut().unwrap().values_mut() {
        if execution["provider_id"] == "screen" {
            execution["output"] = output.clone();
        }
    }
    for message in journal["messages"].as_array_mut().unwrap() {
        if message["role"] == "tool" && message["tool_call_id"] == "screen" {
            message["content"] = json!(output.to_string());
        }
    }
    fs::write(f.base.journal_path(session), serde_json::to_vec(&journal).unwrap()).unwrap();
    output
}

#[test]
fn restored_hash_correct_png_without_pixel_data_is_never_projected_or_recreated() {
    use base64::Engine;
    let f = ChromeFixture::new();
    let mut agent = f.agent();
    catalog(&mut agent, &f.base.api, Some(&["text", "image"]));
    let session = f.enabled(&mut agent, "full");
    agent.turn(&session, "capture", "Capture evidence once.");
    f.base.api.chat().completion(calls(vec![tool("screen", SCREENSHOT, json!({"tabId":4}))]), "tool_calls");
    let request = f.base.api.chat();
    assert_image_after_batch(&request, &["screen"]);
    request.final_text("The screenshot was captured.");
    agent.completed("capture", "completed");
    finish_and_check_stderr(&mut agent);
    drop(agent);

    let source = base64::engine::general_purpose::STANDARD.decode(PNG).unwrap();
    // Retain a valid signature, IHDR and IEND while removing every IDAT byte.
    let invalid: Vec<u8> = source[..33].iter().chain(&source[source.len() - 12..]).copied().collect();
    assert_eq!(invalid.len(), 45);
    let output = replace_saved_image(&f, &session, &invalid);

    let mut restored = f.agent();
    catalog(&mut restored, &f.base.api, Some(&["text", "image"]));
    restored.start(f.base.workspace.path(), "full", Some(&session));
    restored.turn(&session, "inspect", "Review the saved evidence.");
    let request = f.base.api.chat();
    assert_no_image_payload(&request);
    assert!(!request.body.to_string().contains(&base64::engine::general_purpose::STANDARD.encode(&invalid)));
    let text = tool_output(&request, "screen")["text"].as_str().unwrap().to_owned();
    assert!(text.contains("unavailable") && text.contains("do not repeat"), "{text}");
    request.final_text("The saved artifact cannot be decoded; no new screenshot was taken.");
    restored.completed("inspect", "completed");
    assert_eq!(execution(&f.base.journal(&session), "screen")["output"], output);
    assert_eq!(f.bridge.calls().len(), 1, "invalid saved evidence must not repeat the screenshot");
    f.assert_private(&mut restored, &session);
    f.base.api.assert_quiet();
    finish_and_check_stderr(&mut restored);
}

// Locally generated 2x3 RGB controls; the baseline's SOS ends at byte 623.
const BASELINE_JPEG: &[u8] = include_bytes!("../fixtures/jpeg-baseline.jpg");
const PROGRESSIVE_JPEG: &[u8] = include_bytes!("../fixtures/jpeg-progressive.jpg");

fn jpeg_scan_start(bytes: &[u8]) -> usize {
    let sos = bytes.windows(2).position(|bytes| bytes == [0xff, 0xda]).unwrap();
    sos + 2 + u16::from_be_bytes(bytes[sos + 2..sos + 4].try_into().unwrap()) as usize
}

fn jpeg_without_scan(bytes: &[u8]) -> Vec<u8> {
    let mut truncated = bytes[..jpeg_scan_start(bytes)].to_vec();
    truncated.extend_from_slice(&[0xff, 0xd9]);
    truncated
}

fn assert_no_jpeg_payload_in_history(f: &ChromeFixture, agent: &mut Agent, session: &str, payloads: &[String]) {
    for value in [f.base.journal(session).to_string(), agent.history(session).to_string(), json!(agent.seen).to_string()] {
        for payload in payloads {
            assert!(!value.contains(payload), "JPEG bytes escaped transient transport");
        }
        assert!(!value.contains("data:image/jpeg"));
    }
}

fn assert_exact_jpeg_observation(request: &HttpRequest, encoded: &str) {
    let parts = image_parts(request);
    assert_eq!(parts.len(), 1);
    assert_eq!(messages(request)[parts[0].0]["role"], "user");
    assert_eq!(parts[0].1["image_url"]["url"], format!("data:image/jpeg;base64,{encoded}"));
}

#[test]
fn jpeg_missing_or_truncated_scan_never_publishes_an_image() {
    use base64::Engine;
    let baseline_empty = jpeg_without_scan(BASELINE_JPEG);
    assert_eq!(baseline_empty.len(), 625, "match the independent review reproduction");
    let mut partial = BASELINE_JPEG[..jpeg_scan_start(BASELINE_JPEG) + 1].to_vec();
    partial.extend_from_slice(&[0xff, 0xd9]);
    for bytes in [baseline_empty, partial, jpeg_without_scan(PROGRESSIVE_JPEG)] {
        let f = ChromeFixture::new();
        let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
        f.bridge.image("image/jpeg", &encoded);
        let mut agent = f.agent();
        catalog(&mut agent, &f.base.api, Some(&["text", "image"]));
        let session = f.enabled(&mut agent, "full");
        agent.turn(&session, "malformed-jpeg", "Capture the evidence once.");
        f.base.api.chat().completion(calls(vec![tool("screen", SCREENSHOT, json!({"tabId":4}))]), "tool_calls");
        let request = f.base.api.chat();
        assert!(image_parts(&request).is_empty());
        assert!(!request.body.to_string().contains(&encoded));
        let result = tool_output(&request, "screen");
        assert!(result["artifacts"].as_array().is_none_or(Vec::is_empty));
        assert!(result["text"].as_str().unwrap().contains("unavailable"));
        request.final_text("The JPEG evidence is unavailable; no pixel inspection was performed.");
        agent.completed("malformed-jpeg", "completed");
        assert_eq!(f.bridge.calls().len(), 1);
        assert_no_jpeg_payload_in_history(&f, &mut agent, &session, &[encoded.clone()]);
        finish_and_check_stderr(&mut agent);
        assert!(!agent.stderr.lock().unwrap().contains(&encoded));
    }
}

#[test]
fn jpeg_baseline_and_progressive_restore_but_hash_correct_empty_scans_do_not() {
    use base64::Engine;
    for bytes in [BASELINE_JPEG, PROGRESSIVE_JPEG] {
        let f = ChromeFixture::new();
        let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
        f.bridge.image("image/jpeg", &encoded);
        let mut agent = f.agent();
        catalog(&mut agent, &f.base.api, Some(&["text", "image"]));
        let session = f.enabled(&mut agent, "full");
        agent.turn(&session, "capture", "Capture the JPEG once.");
        f.base.api.chat().completion(calls(vec![tool("screen", SCREENSHOT, json!({"tabId":4}))]), "tool_calls");
        let request = f.base.api.chat();
        assert_exact_jpeg_observation(&request, &encoded);
        request.final_text("The valid JPEG was inspected.");
        agent.completed("capture", "completed");
        assert_no_jpeg_payload_in_history(&f, &mut agent, &session, &[encoded.clone()]);
        finish_and_check_stderr(&mut agent);
        drop(agent);

        let mut restored = f.base.agent();
        catalog(&mut restored, &f.base.api, Some(&["text", "image"]));
        restored.start(f.base.workspace.path(), "full", Some(&session));
        restored.turn(&session, "valid-restore", "Review the saved JPEG.");
        let request = f.base.api.chat();
        assert_exact_jpeg_observation(&request, &encoded);
        request.final_text("The saved JPEG is valid.");
        restored.completed("valid-restore", "completed");
        finish_and_check_stderr(&mut restored);
        drop(restored);

        let saved = execution(&f.base.journal(&session), "screen")["output"]["artifacts"][0].clone();
        assert_eq!((saved["mimeType"].as_str(), saved["width"].as_u64(), saved["height"].as_u64()), (Some("image/jpeg"), Some(2), Some(3)));
        let invalid = jpeg_without_scan(bytes);
        let invalid_encoded = base64::engine::general_purpose::STANDARD.encode(&invalid);
        let output = replace_saved_image(&f, &session, &invalid);

        let mut restored = f.base.agent();
        catalog(&mut restored, &f.base.api, Some(&["text", "image"]));
        restored.start(f.base.workspace.path(), "full", Some(&session));
        restored.turn(&session, "invalid-restore", "Review the recorded evidence.");
        let request = f.base.api.chat();
        assert!(image_parts(&request).is_empty());
        assert!(!request.body.to_string().contains(&invalid_encoded));
        assert!(!request.body.to_string().contains(&encoded));
        let result = tool_output(&request, "screen");
        assert!(result["text"].as_str().unwrap().contains("unavailable"));
        assert!(result["text"].as_str().unwrap().contains("do not repeat"));
        request.final_text("The JPEG scan is missing; no tool was repeated.");
        restored.completed("invalid-restore", "completed");
        assert_eq!(execution(&f.base.journal(&session), "screen")["output"], output);
        assert_eq!(f.bridge.calls().len(), 1);
        assert_no_jpeg_payload_in_history(&f, &mut restored, &session, &[encoded, invalid_encoded]);
        f.base.api.assert_quiet();
        finish_and_check_stderr(&mut restored);
    }
}

#[test]
fn plan_only_looks_and_forged_actions_never_reach_the_bridge() {
    let f = ChromeFixture::new();
    let mut agent = f.agent();
    let session = f.enabled(&mut agent, "plan");
    agent.turn(&session, "plan", "Inspect the page.");
    let request = f.base.api.chat();
    assert_eq!(browser_tools(&request), ["browser_tabs_list", "browser_read_page", "browser_screenshot", "browser_wait_for"]);
    request.completion(
        calls(vec![
            tool("click", "browser_click", json!({"tabId":4,"ref":"ref_1"})),
            tool("type", "browser_type", json!({"tabId":4,"text":"hola"})),
            tool("escape", "browser_evaluate", json!({})),
            tool("page", "browser_read_page", json!({"tabId":4})),
        ]),
        "tool_calls",
    );
    let followup = f.base.api.chat();
    for id in ["click", "type", "escape"] {
        assert!(tool_output(&followup, id)["error"].is_string(), "{id}");
    }
    assert!(tool_output(&followup, "page")["text"].as_str().unwrap().contains("ref_1"));
    followup.final_text("Inspection complete.");
    agent.completed("plan", "completed");
    assert_eq!(f.bridge.calls(), [json!({"name":"read_page","arguments":{"tabId":4}})]);
    agent.assert_no_event("permission/request");
    finish_and_check_stderr(&mut agent);
}

#[test]
fn ask_mode_asks_before_acting_and_a_denied_action_never_reaches_the_bridge() {
    let f = ChromeFixture::new();
    let mut agent = f.agent();
    let session = f.enabled(&mut agent, "ask");
    agent.turn(&session, "ask", "Look, and ask before changing anything.");
    let request = f.base.api.chat();
    assert_eq!(browser_tools(&request).len(), BRIDGE_TOOLS.len());
    let safe = [("tabs", "browser_tabs_list", json!({})), ("page", "browser_read_page", json!({"tabId":4}))];
    let denied = [("click", "browser_click", json!({"tabId":4,"ref":"ref_1"})), ("go", "browser_navigate", json!({"tabId":4,"url":"https://example.com/"}))];
    request.completion(
        calls(safe.iter().chain(denied.iter()).map(|(id, name, input)| tool(id, name, input.clone())).collect()),
        "tool_calls",
    );
    for (_, name, _) in &denied {
        let permission = agent.event("permission/request", "ask");
        assert_eq!(permission["params"]["toolName"], *name);
        assert_eq!(f.bridge.calls().len(), safe.len());
        agent.rpc("permission/respond", json!({"id":permission["params"]["id"],"allowed":false}));
    }
    let followup = f.base.api.chat();
    for (id, _, _) in &denied {
        assert!(tool_output(&followup, id)["error"].as_str().unwrap().contains("permission denied"));
    }
    for (id, _, _) in &safe {
        assert!(tool_output(&followup, id).get("error").is_none());
    }
    followup.final_text("Actions were denied.");
    agent.completed("ask", "completed");
    let names: Vec<_> = f.bridge.calls().iter().map(|call| call["name"].as_str().unwrap().to_owned()).collect();
    assert_eq!(names, ["tabs_list", "read_page"]);
    finish_and_check_stderr(&mut agent);
}

#[test]
fn a_disconnected_extension_or_an_expired_session_is_an_ordinary_error() {
    let f = ChromeFixture::new();
    f.bridge.answer("click", Answer::Offline);
    f.bridge.answer("tabs_list", Answer::Expired);
    let mut agent = f.agent();
    let session = f.enabled(&mut agent, "full");
    agent.turn(&session, "error", "Try once.");
    f.base.api.chat().completion(
        calls(vec![
            tool("click", "browser_click", json!({"tabId":4,"ref":"ref_1"})),
            tool("tabs", "browser_tabs_list", json!({})),
            tool("list", "list_files", json!({"path":"."})),
        ]),
        "tool_calls",
    );
    let request = f.base.api.chat();
    let offline = tool_output(&request, "click");
    assert_eq!(offline["isError"], true);
    assert!(offline["text"].as_str().unwrap().contains("no está conectada"), "{offline}");
    let expired = tool_output(&request, "tabs")["error"].as_str().unwrap().to_owned();
    assert!(expired.contains("invalid or expired"), "{expired}");
    assert!(tool_output(&request, "list").get("error").is_none(), "the batch continues");
    request.final_text("The browser is not available right now.");
    agent.completed("error", "completed");
    assert_eq!(agent.history(&session)["recoveryRequired"], false);
    assert_eq!(execution(&f.base.journal(&session), "click")["is_error"], true);
    assert_eq!(f.bridge.calls().len(), 2);
    f.assert_private(&mut agent, &session);
    finish_and_check_stderr(&mut agent);
}

#[test]
fn a_bridge_that_is_not_listening_leaves_native_tools() {
    let f = ChromeFixture::new();
    let closed = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}/mcp", closed.local_addr().unwrap());
    drop(closed);
    let mut agent = f.agent_with(Some(&url), Some(TOKEN));
    let started = agent.start(f.base.workspace.path(), "full", None);
    assert_eq!(started["chromeEnabled"], false, "{started}");
    assert_eq!(started["unavailableMcpServers"], json!(["trex_chrome"]));
    let session = started["sessionId"].as_str().unwrap();
    agent.turn(session, "fallback", "Continue with native tools.");
    let request = f.base.api.chat();
    assert!(definitions(&request).contains(&"read_file"));
    assert!(browser_tools(&request).is_empty());
    request.final_text("Native fallback is available.");
    agent.completed("fallback", "completed");
    finish_and_check_stderr(&mut agent);
}

#[test]
fn cancelling_an_action_requires_recovery_and_never_replays_it() {
    let f = ChromeFixture::new();
    f.bridge.answer("click", Answer::Hang);
    let mut agent = f.agent();
    let session = f.enabled(&mut agent, "full");
    agent.turn(&session, "cancel", "Click once.");
    f.base.api.chat().completion(calls(vec![tool("click", "browser_click", json!({"tabId":4,"ref":"ref_1"}))]), "tool_calls");
    f.bridge.wait_calls(1);
    assert_eq!(agent.rpc("turn/interrupt", json!({"sessionId":session,"messageId":"cancel"}))["interrupted"], true);
    let completed = agent.completed("cancel", "interrupted");
    assert_eq!(completed["params"]["recoveryRequired"], true);
    let mut measured_usage = json!({"contextModel":"mock","inputTokens":11,"outputTokens":3,"contextTokens":14});
    measured_usage["apiUsage"] = expected_api_usage(11, 3, 1, None, false, true);
    assert_eq!(completed["params"]["usage"], measured_usage);
    let settled = execution(&f.base.journal(&session), "click").clone();
    assert_eq!(settled["state"], "done");
    assert_eq!(settled["output"]["executionUncertain"], true);
    assert_eq!(settled["output"]["neverAutomaticallyRetry"], true);
    let duplicate = agent.rpc("turn/start", json!({"sessionId":session,"messageId":"cancel","text":"Click once."}));
    assert_eq!(duplicate["duplicate"], true);
    agent.completed("cancel", "interrupted");
    let id = agent.request("turn/start", json!({"sessionId":session,"messageId":"blocked","text":"Continue."}));
    assert!(agent.response(id).get("error").is_some());
    f.base.api.assert_quiet();
    finish_and_check_stderr(&mut agent);
    drop(agent);

    let mut restored = f.agent();
    assert_eq!(restored.start(f.base.workspace.path(), "full", Some(&session))["recoveryRequired"], true);
    let recovered = restored.rpc("session/recover", json!({"sessionId":session,"action":"acknowledge"}));
    assert_eq!(recovered["recoveryRequired"], false);
    restored.turn(&session, "after-ack", "Continue after manual inspection.");
    let request = f.base.api.chat();
    assert_eq!(tool_output(&request, "click")["neverAutomaticallyRetry"], true);
    request.final_text("Continued without replaying the click.");
    restored.completed("after-ack", "completed");
    assert_eq!(f.bridge.calls().len(), 1, "the click is never replayed");
    f.assert_private(&mut restored, &session);
    finish_and_check_stderr(&mut restored);
}

#[test]
fn broken_answers_stop_an_action_for_review_but_a_read_just_fails() {
    for answer in [Answer::Malformed, Answer::NotArray, Answer::Close] {
        let f = ChromeFixture::new();
        f.bridge.answer("click", answer);
        f.bridge.answer("read_page", answer);
        let mut agent = f.agent();
        let session = f.enabled(&mut agent, "full");

        agent.turn(&session, "read", "Read the page once.");
        f.base.api.chat().completion(calls(vec![tool("page", "browser_read_page", json!({"tabId":4}))]), "tool_calls");
        let request = f.base.api.chat();
        let error = tool_output(&request, "page")["error"].as_str().unwrap().to_owned();
        assert!(error.contains("nothing was changed"), "{answer:?}: {error}");
        request.final_text("The page could not be read.");
        agent.completed("read", "completed");
        assert_eq!(agent.history(&session)["recoveryRequired"], false);

        agent.turn(&session, "uncertain", "Perform this browser action once.");
        f.base.api.chat().completion(
            calls(vec![
                tool("click", "browser_click", json!({"tabId":4,"ref":"ref_1"})),
                tool("never-click", "browser_click", json!({"tabId":4,"ref":"must-not-execute"})),
                tool("never-write", "write_file", json!({"path":"must-not-exist.txt","content":"forbidden after uncertainty"})),
            ]),
            "tool_calls",
        );
        let complete = agent.completed("uncertain", "failed");
        assert_eq!(complete["params"]["recoveryRequired"], true, "{answer:?}");
        let journal = f.base.journal(&session);
        assert_eq!(execution(&journal, "click")["output"]["executionUncertain"], true, "{answer:?}");
        assert_eq!(execution(&journal, "click")["output"]["neverAutomaticallyRetry"], true);
        let names: Vec<_> = f.bridge.calls().iter().map(|call| call["name"].as_str().unwrap().to_owned()).collect();
        assert_eq!(names, ["read_page", "click"], "{answer:?}");
        assert!(!f.base.workspace.path().join("must-not-exist.txt").exists(), "{answer:?} continued the tool batch");
        assert!(
            !journal["executions"].as_object().unwrap().values().any(|entry| entry["provider_id"] == "never-click" || entry["provider_id"] == "never-write"),
            "{answer:?} started a later tool"
        );
        f.assert_private(&mut agent, &session);
        f.base.api.assert_quiet();
        finish_and_check_stderr(&mut agent);
    }
}

#[test]
fn uncertain_browser_failure_preserves_accumulated_usage_cost_and_latest_unknown_context() {
    for last_usage in [json!({"prompt_tokens":23,"completion_tokens":5,"cost":0.25}), Value::Null, json!({"cost":0.25})] {
        let f = ChromeFixture::new();
        f.bridge.answer("click", Answer::Malformed);
        fs::write(f.base.workspace.path().join("evidence.txt"), "already inspected").unwrap();
        let mut agent = f.agent();
        let session = f.enabled(&mut agent, "full");
        agent.turn(&session, "measured-failure", "Inspect then act exactly once.");
        f.base.api.chat().json(json!({
            "choices":[{"index":0,"message":calls(vec![tool("read","read_file",json!({"path":"evidence.txt"}))]),"finish_reason":"tool_calls"}],
            "usage":{"prompt_tokens":11,"completion_tokens":3,"cost":0.125}
        }));
        let request = f.base.api.chat();
        assert!(tool_output(&request, "read")["content"].as_str().unwrap().contains("already inspected"));
        request.json(json!({
            "choices":[{"index":0,"message":calls(vec![tool("click","browser_click",json!({"tabId":4,"ref":"ref_1"}))]),"finish_reason":"tool_calls"}],
            "usage":last_usage
        }));
        let completed = agent.completed("measured-failure", "failed");
        assert_eq!(completed["params"]["recoveryRequired"], true);
        let mut expected = if last_usage["prompt_tokens"].is_u64() {
            json!({"contextModel":"mock","inputTokens":34,"outputTokens":8,"contextTokens":28,"costUsd":0.375})
        } else {
            json!({"contextModel":"mock","inputTokens":11,"outputTokens":3,"costUsd":if last_usage["cost"].is_number() {0.375} else {0.125}})
        };
        expected["apiUsage"] = expected_api_usage(
            expected["inputTokens"].as_u64().unwrap(),
            expected["outputTokens"].as_u64().unwrap(),
            2,
            expected["costUsd"].as_f64(),
            !last_usage["prompt_tokens"].is_u64(),
            !last_usage["cost"].is_number(),
        );
        assert_eq!(completed["params"]["usage"], expected);
        assert_eq!(f.base.journal(&session)["turns"]["measured-failure"]["usage"], expected);
        assert_eq!(f.bridge.calls().len(), 1, "only the action ran");
        let history = agent.history(&session);
        let total = expected["inputTokens"].as_u64().unwrap() + expected["outputTokens"].as_u64().unwrap();
        assert_eq!(history["usage"]["totalTokens"], total);
        assert_eq!(history["usage"]["contextTokens"], expected["contextTokens"]);
        let duplicate = agent.rpc("turn/start", json!({"sessionId":session,"messageId":"measured-failure","text":"Inspect then act exactly once."}));
        assert_eq!(duplicate["duplicate"], true);
        assert_eq!(agent.completed("measured-failure", "failed")["params"]["usage"], expected);
        f.base.api.assert_quiet();
        finish_and_check_stderr(&mut agent);
        drop(agent);
        let mut restored = f.base.agent();
        let summary = restored.start(f.base.workspace.path(), "full", Some(&session));
        assert_eq!(summary["usage"], history["usage"]);
        assert_eq!(f.bridge.calls().len(), 1);
        f.base.api.assert_quiet();
        finish_and_check_stderr(&mut restored);
    }
}

#[test]
fn later_unmeasured_provider_failure_keeps_prior_tokens_without_stale_context() {
    let f = ChromeFixture::new();
    fs::write(f.base.workspace.path().join("evidence.txt"), "readable").unwrap();
    let mut agent = f.agent();
    let session = f.enabled(&mut agent, "full");
    agent.turn(&session, "provider-failure", "Inspect the evidence.");
    f.base.api.chat().json(json!({
        "choices":[{"index":0,"message":calls(vec![tool("read","read_file",json!({"path":"evidence.txt"}))]),"finish_reason":"tool_calls"}],
        "usage":{"prompt_tokens":11,"completion_tokens":3,"cost":0.125}
    }));
    f.base.api.chat().json(json!({"error":{"message":"offline provider rejection"}}));
    let complete = agent.completed("provider-failure", "failed");
    let mut expected = json!({"contextModel":"mock","inputTokens":11,"outputTokens":3,"costUsd":0.125});
    expected["apiUsage"] = expected_api_usage(11, 3, 2, Some(0.125), true, true);
    assert_eq!(complete["params"]["usage"], expected);
    assert_eq!(f.base.journal(&session)["turns"]["provider-failure"]["usage"], expected);
    let history = agent.history(&session);
    assert_eq!(history["usage"]["totalTokens"], 14);
    assert!(history["usage"].get("contextTokens").is_none());
    assert!(f.bridge.calls().is_empty());
    f.base.api.assert_quiet();
    finish_and_check_stderr(&mut agent);
}
