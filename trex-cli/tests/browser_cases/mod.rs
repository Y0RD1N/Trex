//! Browser regressions run through copied actual agent and broker executables.
use super::*;
use std::sync::OnceLock;

const SCREENSHOT: &str = "browser_take_screenshot";
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
const PNG: &str =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=";

fn executable(name: &str) -> String {
    format!("{name}{}", std::env::consts::EXE_SUFFIX)
}

fn fake_binary() -> &'static Path {
    static COMPILED: OnceLock<(TempDir, PathBuf)> = OnceLock::new();
    &COMPILED
        .get_or_init(|| {
            let directory = tempfile::tempdir().unwrap();
            let binary = directory.path().join(executable("trex-browser"));
            let output = Command::new("rustc")
                .arg("--edition=2021")
                .arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/fake_browser.rs"))
                .arg("-o")
                .arg(&binary)
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .output()
                .expect("rustc must be available alongside cargo for offline browser fixture");
            assert!(
                output.status.success(),
                "compile fake browser: {}",
                String::from_utf8_lossy(&output.stderr)
            );
            (directory, binary)
        })
        .1
}

struct BrowserFixture {
    base: Fixture,
    bin: TempDir,
}

impl BrowserFixture {
    fn new() -> Self {
        let fixture = Self::without_browser();
        fs::copy(
            fake_binary(),
            fixture.bin.path().join(executable("trex-browser")),
        )
        .unwrap();
        fixture
    }

    fn without_browser() -> Self {
        let fixture = Self {
            base: Fixture::new(),
            bin: tempfile::tempdir().unwrap(),
        };
        fs::copy(
            env!("CARGO_BIN_EXE_trex-agent"),
            fixture.bin.path().join(executable("trex-agent")),
        )
        .unwrap();
        fixture
    }

    fn agent(&self) -> Agent {
        let settings = command(self.base.home.path());
        let mut copied = Command::new(self.bin.path().join(executable("trex-agent")));
        for (name, value) in settings.get_envs() {
            if let Some(value) = value {
                copied.env(name, value);
            } else {
                copied.env_remove(name);
            }
        }
        Agent::spawn_command(copied, "TREX1")
    }

    fn start(
        &self,
        agent: &mut Agent,
        mode: &str,
        browser: Value,
        conversation: Option<&str>,
    ) -> Value {
        agent.rpc("session/start", json!({"cwd":self.base.workspace.path(),"mode":mode,"browser":browser,"conversationId":conversation}))
    }

    fn enabled(&self, agent: &mut Agent, mode: &str) -> String {
        let started = self.start(agent, mode, json!({"enabled":true}), None);
        assert_eq!(started["browser"]["enabled"], true, "{started}");
        assert_eq!(started["browser"]["available"], true, "{started}");
        started["sessionId"].as_str().unwrap().to_owned()
    }

    fn requests(&self) -> Vec<Value> {
        fs::read_to_string(self.base.workspace.path().join("browser-requests.jsonl"))
            .unwrap_or_default()
            .split_inclusive('\n')
            .filter(|line| line.ends_with('\n'))
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    fn wait_calls(&self, count: usize) -> Vec<Value> {
        let deadline = Instant::now() + TIMEOUT;
        loop {
            let requests = self.requests();
            if requests.len() >= count {
                return requests;
            }
            assert!(
                Instant::now() < deadline,
                "waiting for {count} browser calls; got {requests:?}"
            );
            thread::sleep(Duration::from_millis(10));
        }
    }

    fn probes(&self) -> String {
        fs::read_to_string(self.bin.path().join("browser-probes.log")).unwrap_or_default()
    }

    fn dispatch(&self, operation: &Value) -> Value {
        let path = self.base.workspace.path().join(format!(
            "browser-dispatch-{}.json",
            operation.as_str().unwrap()
        ));
        serde_json::from_slice(&fs::read(path).unwrap()).unwrap()
    }

    fn behavior(&self, value: &str) {
        fs::write(self.base.workspace.path().join("browser-behavior"), value).unwrap();
    }

    fn assert_private(&self, agent: &mut Agent, session: &str) {
        let history = agent.history(session);
        for (description, text) in [
            (
                "journal",
                fs::read_to_string(self.base.journal_path(session)).unwrap(),
            ),
            ("history", history.to_string()),
            ("events", json!(agent.seen).to_string()),
            (
                "requests log",
                fs::read_to_string(self.base.workspace.path().join("browser-requests.jsonl"))
                    .unwrap_or_default(),
            ),
        ] {
            assert!(!text.contains(PNG), "image payload leaked to {description}");
            assert!(
                !text.contains("data:image/"),
                "image data URL leaked to {description}"
            );
        }
        for request in self
            .requests()
            .iter()
            .filter(|request| request["name"] != "browser_cancel")
        {
            let snapshot = self.dispatch(&request["operationId"]).to_string();
            assert!(
                !snapshot.contains(PNG),
                "image payload leaked to dispatch snapshot"
            );
            assert!(!snapshot.contains("data:image/"));
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
    if let Some(modalities) = modalities {
        assert_eq!(result["models"][0]["inputModalities"], json!(modalities));
    }
}

fn definitions(request: &HttpRequest) -> Vec<&str> {
    request.body["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|value| value["function"]["name"].as_str().unwrap())
        .collect()
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
    assert!(
        !body.contains(PNG),
        "image payload sent to model without image support"
    );
    assert!(!body.contains("data:image/"));
}

fn assert_image_after_batch(request: &HttpRequest, ids: &[&str]) {
    let messages = messages(request);
    let parts = image_parts(request);
    assert_eq!(parts.len(), 1, "expected one transient image observation");
    let index = parts[0].0;
    assert_eq!(messages[index]["role"], "user");
    assert_eq!(
        parts[0].1["image_url"]["url"],
        format!("data:image/png;base64,{PNG}")
    );
    assert!(messages[index]["content"]
        .as_array()
        .unwrap()
        .iter()
        .any(|part| {
            part["type"] == "text"
                && part["text"].as_str().is_some_and(|text| {
                    text.contains("tool_call_id=") && text.contains("artifact_id=")
                })
        }));
    let start = index
        .checked_sub(ids.len())
        .expect("whole tool batch precedes image");
    let result_ids: Vec<_> = messages[start..index]
        .iter()
        .map(|message| {
            assert_eq!(message["role"], "tool");
            message["tool_call_id"].as_str().unwrap()
        })
        .collect();
    assert_eq!(
        result_ids, ids,
        "image observation must follow the entire tool batch"
    );
    for message in messages.iter().filter(|message| message["role"] == "tool") {
        let text = message["content"]
            .as_str()
            .expect("tool content remains a string");
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
    assert!(
        !stderr.contains("fake-browser-private-diagnostic"),
        "broker stderr escaped adapter"
    );
}

#[test]
fn vision_screenshot_follows_whole_native_browser_batch_and_is_durable_metadata_only() {
    let f = BrowserFixture::new();
    fs::write(
        f.base.workspace.path().join("evidence.txt"),
        "native evidence",
    )
    .unwrap();
    let mut agent = f.agent();
    catalog(&mut agent, &f.base.api, Some(&["text", "image"]));
    let config = json!({"enabled":true,"profile":"offline-profile","clientId":"offline-client"});
    let started = f.start(&mut agent, "full", config.clone(), None);
    assert_eq!(started["browser"]["available"], true, "{started}");
    let session = started["sessionId"].as_str().unwrap();
    let again = f.start(&mut agent, "full", config, Some(session));
    assert_eq!(again["sessionId"], session);
    for browser in [
        Value::Null,
        json!({"enabled":false}),
        json!({"enabled":true,"profile":"other"}),
    ] {
        let id = agent.request("session/start", json!({"cwd":f.base.workspace.path(),"mode":"full","conversationId":session,"browser":browser}));
        assert!(agent.response(id)["error"]["message"]
            .as_str()
            .unwrap()
            .contains("fixed"));
    }
    agent.turn(
        session,
        "vision-batch",
        "Capture evidence and read the file.",
    );
    let initial = f.base.api.chat();
    let names = definitions(&initial);
    assert!(names.contains(&SCREENSHOT));
    assert!(names.contains(&"read_file"));
    assert!(!names.contains(&"browser_injected_escape"));
    initial.completion(
        calls(vec![
            tool("screen", SCREENSHOT, json!({"fullPage":true})),
            tool("native", "read_file", json!({"path":"evidence.txt"})),
            tool("snapshot", "browser_snapshot", json!({})),
        ]),
        "tool_calls",
    );
    let followup = f.base.api.chat();
    assert_image_after_batch(&followup, &["screen", "native", "snapshot"]);
    assert_eq!(
        tool_output(&followup, "native")["content"],
        "native evidence"
    );
    let output = tool_output(&followup, "screen");
    assert!(output["text"]
        .as_str()
        .unwrap()
        .contains("Offline screenshot captured"));
    let artifacts = output["artifacts"].as_array().unwrap();
    let image = artifacts
        .iter()
        .find(|artifact| artifact["storage"] == "local")
        .expect("local image reference");
    assert_eq!(image["mimeType"], "image/png");
    assert_eq!(image["width"], 1);
    assert_eq!(image["height"], 1);
    assert!(image["sizeBytes"].as_u64().unwrap() > 0);
    assert_eq!(image["provenance"]["toolCallId"], "screen");
    assert!(artifacts
        .iter()
        .any(|artifact| artifact["id"] == "offline-video" && artifact["storage"] == "broker"));
    assert!(output["text"].as_str().unwrap().contains("metadata only"));
    followup.final_text("Evidence captured.");
    agent.completed("vision-batch", "completed");
    let requests = f.requests();
    assert_eq!(requests.len(), 2);
    for request in &requests {
        assert_eq!(
            request["cwd"],
            json!(fs::canonicalize(f.base.workspace.path()).unwrap())
        );
        assert_eq!(request["mode"], "full");
        assert_eq!(request["clientId"], "offline-client");
        assert_eq!(request["profile"], "offline-profile");
        assert_eq!(request["timeoutMs"], 90000);
        assert!(!request["operationId"].as_str().unwrap().is_empty());
        let journal = f.base.journal(session);
        let provider_id = if request["name"] == SCREENSHOT {
            "screen"
        } else {
            "snapshot"
        };
        let entry = execution(&journal, provider_id);
        assert_eq!(entry["operation_id"], request["operationId"]);
        let dispatch = f.dispatch(&request["operationId"]);
        let intent = execution(&dispatch, provider_id);
        assert_eq!(intent["state"], "executing");
        assert_eq!(intent["operation_id"], request["operationId"]);
    }
    f.assert_private(&mut agent, session);
    assert!(f.probes().contains("tools --json --mode full"));
    f.base.api.assert_quiet();
    finish_and_check_stderr(&mut agent);
}

#[test]
fn screenshot_projection_obeys_catalog_for_text_unknown_and_model_switches() {
    for modalities in [Some(&["text"][..]), None, Some(&["text", "image"][..])] {
        let f = BrowserFixture::new();
        let mut agent = f.agent();
        catalog(&mut agent, &f.base.api, modalities);
        let session = f.enabled(&mut agent, "full");
        agent.turn(&session, "capture", "Capture one screenshot.");
        f.base.api.chat().completion(
            calls(vec![tool("screen", SCREENSHOT, json!({}))]),
            "tool_calls",
        );
        let request = f.base.api.chat();
        if modalities.is_some_and(|value| value.contains(&"image")) {
            assert_image_after_batch(&request, &["screen"]);
        } else {
            assert_no_image_payload(&request);
            let expected = if modalities.is_some() {
                "text only"
            } else {
                "unknown"
            };
            assert!(tool_output(&request, "screen")["text"]
                .as_str()
                .unwrap()
                .contains(expected));
        }
        request.final_text("Screenshot recorded.");
        agent.completed("capture", "completed");
        let original = execution(&f.base.journal(&session), "screen")["output"].clone();
        for (id, model, expected) in [
            ("text", "text-model", "text only"),
            ("unknown", "unknown-model", "unknown"),
            ("vision", "mock", "image"),
        ] {
            let accepted = agent.rpc("turn/start", json!({"sessionId":session,"messageId":id,"text":"Review the previous evidence.","model":model}));
            assert_eq!(accepted["accepted"], true);
            let request = f.base.api.request("POST", "/v1/chat/completions");
            assert_eq!(request.body["model"], model);
            let image_expected =
                expected == "image" && modalities.is_some_and(|value| value.contains(&"image"));
            assert_eq!(!image_parts(&request).is_empty(), image_expected);
            if !image_expected {
                assert_no_image_payload(&request);
            }
            if expected != "image" {
                assert!(tool_output(&request, "screen")["text"]
                    .as_str()
                    .unwrap()
                    .contains(expected));
            }
            request.final_text("Reviewed without repeating the tool.");
            agent.completed(id, "completed");
            assert_eq!(
                execution(&f.base.journal(&session), "screen")["output"],
                original
            );
        }
        assert_eq!(
            f.requests().len(),
            1,
            "switching models must not rerun browser"
        );
        f.assert_private(&mut agent, &session);
        f.base.api.assert_quiet();
        finish_and_check_stderr(&mut agent);
    }
}

#[test]
fn restored_image_rehydrates_or_reports_missing_without_replay_and_browser_defaults_off() {
    let f = BrowserFixture::new();
    let mut agent = f.agent();
    catalog(&mut agent, &f.base.api, Some(&["text", "image"]));
    let session = f.enabled(&mut agent, "full");
    agent.turn(&session, "capture", "Capture evidence.");
    f.base.api.chat().completion(
        calls(vec![tool("screen", SCREENSHOT, json!({}))]),
        "tool_calls",
    );
    let followup = f.base.api.chat();
    assert_image_after_batch(&followup, &["screen"]);
    followup.final_text("Evidence is saved.");
    agent.completed("capture", "completed");
    let history = agent.history(&session);
    let output = execution(&f.base.journal(&session), "screen")["output"].clone();
    let image = output["artifacts"]
        .as_array()
        .unwrap()
        .iter()
        .find(|artifact| artifact["storage"] == "local")
        .unwrap();
    let artifact_path = f
        .base
        .home
        .path()
        .join("private-home/artifacts")
        .join(format!("{}.bin", image["id"].as_str().unwrap()));
    let probes = f.probes();
    finish_and_check_stderr(&mut agent);
    drop(agent);
    let mut restored = f.agent();
    catalog(&mut restored, &f.base.api, Some(&["text", "image"]));
    let summary = restored.start(f.base.workspace.path(), "full", Some(&session));
    assert_eq!(summary["items"], history["items"]);
    assert_eq!(summary["browser"]["enabled"], false);
    assert_eq!(summary["browser"]["available"], false);
    assert_eq!(
        f.probes(),
        probes,
        "restoring must not implicitly discover browser"
    );
    let duplicate = restored.rpc(
        "turn/start",
        json!({"sessionId":session,"messageId":"capture","text":"Capture evidence."}),
    );
    assert_eq!(duplicate["duplicate"], true);
    restored.completed("capture", "completed");
    f.base.api.assert_quiet();
    restored.turn(&session, "intact-restore", "Review the saved image.");
    let request = f.base.api.chat();
    assert_image_after_batch(&request, &["screen"]);
    assert!(!definitions(&request)
        .iter()
        .any(|name| name.starts_with("browser_")));
    request.final_text("The saved screenshot is available.");
    restored.completed("intact-restore", "completed");
    assert_eq!(f.requests().len(), 1);
    f.assert_private(&mut restored, &session);
    finish_and_check_stderr(&mut restored);
    drop(restored);

    fs::remove_file(artifact_path).unwrap();
    let mut restored = f.agent();
    catalog(&mut restored, &f.base.api, Some(&["text", "image"]));
    let summary = restored.start(f.base.workspace.path(), "full", Some(&session));
    assert_eq!(summary["browser"]["enabled"], false);
    assert_eq!(f.probes(), probes);
    restored.turn(&session, "after-restore", "Review the existing evidence.");
    let request = f.base.api.chat();
    assert_no_image_payload(&request);
    let text = tool_output(&request, "screen")["text"]
        .as_str()
        .unwrap()
        .to_owned();
    assert!(
        text.contains("unavailable") && text.contains("missing") && text.contains("do not repeat"),
        "{text}"
    );
    assert!(!definitions(&request)
        .iter()
        .any(|name| name.starts_with("browser_")));
    request.final_text("The recorded image is unavailable.");
    restored.completed("after-restore", "completed");
    assert_eq!(
        execution(&f.base.journal(&session), "screen")["output"],
        output
    );
    assert_eq!(f.requests().len(), 1);
    f.assert_private(&mut restored, &session);
    finish_and_check_stderr(&mut restored);
}

#[test]
fn restored_hash_correct_png_without_pixel_data_is_never_projected_or_recreated() {
    use base64::Engine;
    use sha2::Digest;

    let f = BrowserFixture::new();
    let mut agent = f.agent();
    catalog(&mut agent, &f.base.api, Some(&["text", "image"]));
    let session = f.enabled(&mut agent, "full");
    agent.turn(&session, "capture", "Capture evidence once.");
    f.base.api.chat().completion(
        calls(vec![tool("screen", SCREENSHOT, json!({}))]),
        "tool_calls",
    );
    let request = f.base.api.chat();
    assert_image_after_batch(&request, &["screen"]);
    request.final_text("The screenshot was captured.");
    agent.completed("capture", "completed");
    finish_and_check_stderr(&mut agent);
    drop(agent);

    let mut journal = f.base.journal(&session);
    let mut output = execution(&journal, "screen")["output"].clone();
    let reference = output["artifacts"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|artifact| artifact["storage"] == "local")
        .unwrap();
    let old_id = reference["id"].as_str().unwrap().to_owned();
    let source = base64::engine::general_purpose::STANDARD
        .decode(PNG)
        .unwrap();
    // Retain a valid signature, IHDR and IEND while removing every IDAT byte.
    let invalid: Vec<u8> = source[..33]
        .iter()
        .chain(&source[source.len() - 12..])
        .copied()
        .collect();
    assert_eq!(invalid.len(), 45);
    let hash = format!("{:x}", sha2::Sha256::digest(&invalid));
    reference["id"] = json!(hash);
    reference["sha256"] = json!(hash);
    reference["sizeBytes"] = json!(invalid.len());
    let directory = f.base.home.path().join("private-home/artifacts");
    let original = directory.join(format!("{old_id}.bin"));
    fs::write(&original, &invalid).unwrap();
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
    fs::write(
        f.base.journal_path(&session),
        serde_json::to_vec(&journal).unwrap(),
    )
    .unwrap();

    let mut restored = f.agent();
    catalog(&mut restored, &f.base.api, Some(&["text", "image"]));
    let summary = restored.start(f.base.workspace.path(), "full", Some(&session));
    assert_eq!(summary["browser"]["enabled"], false);
    restored.turn(&session, "inspect", "Review the saved evidence.");
    let request = f.base.api.chat();
    assert_no_image_payload(&request);
    assert!(!request
        .body
        .to_string()
        .contains(&base64::engine::general_purpose::STANDARD.encode(&invalid)));
    let text = tool_output(&request, "screen")["text"]
        .as_str()
        .unwrap()
        .to_owned();
    assert!(
        text.contains("unavailable") && text.contains("do not repeat"),
        "{text}"
    );
    request.final_text("The saved artifact cannot be decoded; no new screenshot was taken.");
    restored.completed("inspect", "completed");
    assert_eq!(
        execution(&f.base.journal(&session), "screen")["output"],
        output
    );
    assert_eq!(
        f.requests().len(),
        1,
        "invalid saved evidence must not repeat the screenshot tool"
    );
    f.assert_private(&mut restored, &session);
    f.base.api.assert_quiet();
    finish_and_check_stderr(&mut restored);
}

// Locally generated 2x3 RGB controls; the baseline's SOS ends at byte 623.
const BASELINE_JPEG: &[u8] = include_bytes!("../fixtures/jpeg-baseline.jpg");
const PROGRESSIVE_JPEG: &[u8] = include_bytes!("../fixtures/jpeg-progressive.jpg");

fn jpeg_scan_start(bytes: &[u8]) -> usize {
    let sos = bytes
        .windows(2)
        .position(|bytes| bytes == [0xff, 0xda])
        .unwrap();
    sos + 2 + u16::from_be_bytes(bytes[sos + 2..sos + 4].try_into().unwrap()) as usize
}

fn jpeg_without_scan(bytes: &[u8]) -> Vec<u8> {
    let mut truncated = bytes[..jpeg_scan_start(bytes)].to_vec();
    truncated.extend_from_slice(&[0xff, 0xd9]);
    truncated
}

fn assert_no_jpeg_payload_in_history(
    f: &BrowserFixture,
    agent: &mut Agent,
    session: &str,
    payloads: &[String],
) {
    for value in [
        f.base.journal(session).to_string(),
        agent.history(session).to_string(),
        json!(agent.seen).to_string(),
        fs::read_to_string(f.base.workspace.path().join("browser-requests.jsonl"))
            .unwrap_or_default(),
    ] {
        for payload in payloads {
            assert!(
                !value.contains(payload),
                "JPEG bytes escaped transient transport"
            );
        }
        assert!(!value.contains("data:image/jpeg"));
    }
}

fn assert_exact_jpeg_observation(request: &HttpRequest, encoded: &str) {
    let parts = image_parts(request);
    assert_eq!(parts.len(), 1);
    assert_eq!(messages(request)[parts[0].0]["role"], "user");
    assert_eq!(
        parts[0].1["image_url"]["url"],
        format!("data:image/jpeg;base64,{encoded}")
    );
}

#[test]
fn jpeg_missing_or_truncated_scan_never_publishes_an_image() {
    use base64::Engine;
    let baseline_empty = jpeg_without_scan(BASELINE_JPEG);
    assert_eq!(
        baseline_empty.len(),
        625,
        "match the independent review reproduction"
    );
    let mut partial = BASELINE_JPEG[..jpeg_scan_start(BASELINE_JPEG) + 1].to_vec();
    partial.extend_from_slice(&[0xff, 0xd9]);
    for bytes in [baseline_empty, partial, jpeg_without_scan(PROGRESSIVE_JPEG)] {
        let f = BrowserFixture::new();
        let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
        fs::write(
            f.base.workspace.path().join("browser-image-result"),
            format!("image/jpeg\n{encoded}"),
        )
        .unwrap();
        let mut agent = f.agent();
        catalog(&mut agent, &f.base.api, Some(&["text", "image"]));
        let session = f.enabled(&mut agent, "full");
        agent.turn(&session, "malformed-jpeg", "Capture the evidence once.");
        f.base.api.chat().completion(
            calls(vec![tool("screen", SCREENSHOT, json!({}))]),
            "tool_calls",
        );
        let request = f.base.api.chat();
        assert!(image_parts(&request).is_empty());
        assert!(!request.body.to_string().contains(&encoded));
        let result = tool_output(&request, "screen");
        assert!(result["artifacts"].as_array().unwrap().is_empty());
        assert!(result["text"].as_str().unwrap().contains("unavailable"));
        request.final_text("The JPEG evidence is unavailable; no pixel inspection was performed.");
        agent.completed("malformed-jpeg", "completed");
        assert_eq!(f.requests().len(), 1);
        assert_no_jpeg_payload_in_history(&f, &mut agent, &session, &[encoded.clone()]);
        finish_and_check_stderr(&mut agent);
        assert!(!agent.stderr.lock().unwrap().contains(&encoded));
    }
}

#[test]
fn jpeg_baseline_and_progressive_restore_but_hash_correct_empty_scans_do_not() {
    use base64::Engine;
    use sha2::Digest;
    for bytes in [BASELINE_JPEG, PROGRESSIVE_JPEG] {
        let f = BrowserFixture::new();
        let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
        fs::write(
            f.base.workspace.path().join("browser-image-result"),
            format!("image/jpeg\n{encoded}"),
        )
        .unwrap();
        let mut agent = f.agent();
        catalog(&mut agent, &f.base.api, Some(&["text", "image"]));
        let session = f.enabled(&mut agent, "full");
        agent.turn(&session, "capture", "Capture the JPEG once.");
        f.base.api.chat().completion(
            calls(vec![tool("screen", SCREENSHOT, json!({}))]),
            "tool_calls",
        );
        let request = f.base.api.chat();
        assert_exact_jpeg_observation(&request, &encoded);
        request.final_text("The valid JPEG was inspected.");
        agent.completed("capture", "completed");
        assert_no_jpeg_payload_in_history(&f, &mut agent, &session, &[encoded.clone()]);
        finish_and_check_stderr(&mut agent);
        drop(agent);

        let mut restored = f.agent();
        catalog(&mut restored, &f.base.api, Some(&["text", "image"]));
        restored.start(f.base.workspace.path(), "full", Some(&session));
        restored.turn(&session, "valid-restore", "Review the saved JPEG.");
        let request = f.base.api.chat();
        assert_exact_jpeg_observation(&request, &encoded);
        request.final_text("The saved JPEG is valid.");
        restored.completed("valid-restore", "completed");
        finish_and_check_stderr(&mut restored);
        drop(restored);

        let mut journal = f.base.journal(&session);
        let mut output = execution(&journal, "screen")["output"].clone();
        let reference = output["artifacts"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|artifact| artifact["storage"] == "local")
            .unwrap();
        assert_eq!(reference["mimeType"], "image/jpeg");
        assert_eq!(reference["width"], 2);
        assert_eq!(reference["height"], 3);
        let old_id = reference["id"].as_str().unwrap().to_owned();
        let invalid = jpeg_without_scan(bytes);
        let invalid_encoded = base64::engine::general_purpose::STANDARD.encode(&invalid);
        let hash = format!("{:x}", sha2::Sha256::digest(&invalid));
        reference["id"] = json!(hash);
        reference["sha256"] = json!(hash);
        reference["sizeBytes"] = json!(invalid.len());
        let directory = f.base.home.path().join("private-home/artifacts");
        let original = directory.join(format!("{old_id}.bin"));
        fs::write(&original, &invalid).unwrap();
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
        fs::write(
            f.base.journal_path(&session),
            serde_json::to_vec(&journal).unwrap(),
        )
        .unwrap();

        let mut restored = f.agent();
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
        assert_eq!(
            execution(&f.base.journal(&session), "screen")["output"],
            output
        );
        assert_eq!(f.requests().len(), 1);
        assert_no_jpeg_payload_in_history(&f, &mut restored, &session, &[encoded, invalid_encoded]);
        f.base.api.assert_quiet();
        finish_and_check_stderr(&mut restored);
    }
}

#[test]
fn plan_filters_broker_tools_and_rejects_forged_interactions_without_dispatch() {
    let f = BrowserFixture::new();
    let mut agent = f.agent();
    let session = f.enabled(&mut agent, "plan");
    agent.turn(&session, "plan", "Inspect the page.");
    let request = f.base.api.chat();
    let names = definitions(&request);
    for allowed in [
        SCREENSHOT,
        "browser_snapshot",
        "browser_navigate",
        "browser_tabs",
        "browser_console_messages",
        "browser_network_requests",
    ] {
        assert!(names.contains(&allowed), "missing {allowed}");
    }
    for forbidden in [
        "browser_click",
        "browser_evaluate",
        "browser_mouse",
        "browser_injected_escape",
    ] {
        assert!(!names.contains(&forbidden), "advertised {forbidden}");
    }
    request.completion(
        calls(vec![
            tool("click", "browser_click", json!({"ref":"button"})),
            tool("eval", "browser_evaluate", json!({"function":"() => 1"})),
            tool("escape", "browser_injected_escape", json!({})),
            tool("snapshot", "browser_snapshot", json!({})),
        ]),
        "tool_calls",
    );
    let followup = f.base.api.chat();
    for id in ["click", "eval", "escape"] {
        assert!(tool_output(&followup, id)["error"].is_string());
    }
    assert!(tool_output(&followup, "snapshot")["text"]
        .as_str()
        .unwrap()
        .contains("browser_snapshot"));
    followup.final_text("Inspection complete.");
    agent.completed("plan", "completed");
    let requests = f.requests();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0]["name"], "browser_snapshot");
    assert_eq!(requests[0]["mode"], "observe");
    assert_eq!(requests[0]["clientId"], session);
    assert!(requests[0].get("profile").is_none());
    agent.assert_no_event("permission/request");
    finish_and_check_stderr(&mut agent);
}

#[test]
fn ask_uses_argument_policy_and_denied_click_never_reaches_browser() {
    let f = BrowserFixture::new();
    let mut agent = f.agent();
    let session = f.enabled(&mut agent, "ask");
    agent.turn(
        &session,
        "ask",
        "Inspect controls, asking before changing them.",
    );
    let request = f.base.api.chat();
    assert!(definitions(&request).contains(&"browser_click"));
    let safe = [
        ("tabs-list", "browser_tabs", json!({"action":"list"})),
        (
            "tabs-select",
            "browser_tabs",
            json!({"action":"select","tabId":"tab-1"}),
        ),
        (
            "console-read",
            "browser_console_messages",
            json!({"clear":false}),
        ),
        (
            "mouse-move",
            "browser_mouse",
            json!({"action":"move","x":1,"y":2}),
        ),
        (
            "mouse-wheel",
            "browser_mouse",
            json!({"action":"wheel","deltaY":10}),
        ),
    ];
    let denied = [
        ("click", "browser_click", json!({"ref":"button"})),
        (
            "artifact-open",
            "browser_artifact",
            json!({"artifactId":"offline-video","open":true}),
        ),
        (
            "console-clear",
            "browser_console_messages",
            json!({"clear":true}),
        ),
        (
            "mouse-click",
            "browser_mouse",
            json!({"action":"click","x":1,"y":2}),
        ),
    ];
    request.completion(
        calls(
            safe.iter()
                .chain(denied.iter())
                .map(|(id, name, input)| tool(id, name, input.clone()))
                .collect(),
        ),
        "tool_calls",
    );
    for (_, name, _) in &denied {
        let permission = agent.event("permission/request", "ask");
        assert_eq!(permission["params"]["toolName"], *name);
        assert_eq!(f.requests().len(), safe.len());
        agent.rpc(
            "permission/respond",
            json!({"id":permission["params"]["id"],"allowed":false}),
        );
    }
    let followup = f.base.api.chat();
    for (id, _, _) in &denied {
        assert!(tool_output(&followup, id)["error"]
            .as_str()
            .unwrap()
            .contains("permission denied"));
    }
    for (id, _, _) in &safe {
        assert!(tool_output(&followup, id).get("error").is_none());
    }
    followup.final_text("Mutating actions were denied.");
    agent.completed("ask", "completed");
    let requests = f.requests();
    assert_eq!(requests.len(), safe.len());
    for (request, (_, name, input)) in requests.iter().zip(&safe) {
        assert_eq!(request["name"], *name);
        assert_eq!(request["arguments"], *input);
        assert_eq!(request["mode"], "qa");
    }
    finish_and_check_stderr(&mut agent);
}

#[test]
fn cancellation_targets_durable_operation_and_requires_recovery_without_reexecution() {
    let f = BrowserFixture::new();
    fs::write(f.base.workspace.path().join("browser-block"), b"block").unwrap();
    let mut agent = f.agent();
    let session = f.enabled(&mut agent, "full");
    agent.turn(&session, "cancel", "Click once.");
    f.base.api.chat().completion(
        calls(vec![tool(
            "click",
            "browser_click",
            json!({"ref":"button"}),
        )]),
        "tool_calls",
    );
    let calls = f.wait_calls(1);
    let operation = calls[0]["operationId"].as_str().unwrap().to_owned();
    // The broker's dispatch snapshot must already contain this executing
    // operation; inspecting only the final journal would miss late persistence.
    let dispatch = f.dispatch(&calls[0]["operationId"]);
    assert_eq!(execution(&dispatch, "click")["state"], "executing");
    assert_eq!(execution(&dispatch, "click")["operation_id"], operation);
    assert_eq!(
        agent.rpc(
            "turn/interrupt",
            json!({"sessionId":session,"messageId":"cancel"})
        )["interrupted"],
        true
    );
    let completed = agent.completed("cancel", "interrupted");
    assert_eq!(completed["params"]["recoveryRequired"], true);
    let mut measured_usage =
        json!({"contextModel":"mock","inputTokens":11,"outputTokens":3,"contextTokens":14});
    measured_usage["apiUsage"] = expected_api_usage(11, 3, 1, None, false, true);
    assert_eq!(completed["params"]["usage"], measured_usage);
    assert_eq!(dispatch["turns"]["cancel"]["usage"], measured_usage);
    let requests = f.wait_calls(2);
    assert_eq!(requests[1]["name"], "browser_cancel");
    assert_eq!(requests[1]["arguments"]["operationId"], operation);
    assert_eq!(requests[1]["clientId"], session);
    let journal = f.base.journal(&session);
    assert_eq!(journal["turns"]["cancel"]["usage"], measured_usage);
    assert_eq!(agent.history(&session)["usage"]["totalTokens"], 14);
    let settled = execution(&journal, "click");
    assert_eq!(settled["operation_id"], operation);
    assert_eq!(settled["state"], "done");
    assert_eq!(settled["output"]["executionUncertain"], true);
    assert_eq!(settled["output"]["neverAutomaticallyRetry"], true);
    let duplicate = agent.rpc(
        "turn/start",
        json!({"sessionId":session,"messageId":"cancel","text":"Click once."}),
    );
    assert_eq!(duplicate["duplicate"], true);
    agent.completed("cancel", "interrupted");
    assert_eq!(agent.history(&session)["usage"]["totalTokens"], 14);
    let id = agent.request(
        "turn/start",
        json!({"sessionId":session,"messageId":"blocked","text":"Continue."}),
    );
    assert!(agent.response(id).get("error").is_some());
    f.base.api.assert_quiet();
    finish_and_check_stderr(&mut agent);
    drop(agent);
    let mut restored = f.agent();
    assert_eq!(
        f.start(
            &mut restored,
            "full",
            json!({"enabled":true}),
            Some(&session)
        )["recoveryRequired"],
        true
    );
    assert_eq!(f.requests().len(), 2);
    assert_eq!(restored.history(&session)["usage"]["totalTokens"], 14);
    let recovered = restored.rpc(
        "session/recover",
        json!({"sessionId":session,"action":"acknowledge"}),
    );
    assert_eq!(recovered["recoveryRequired"], false);
    assert_eq!(f.base.journal(&session)["recoveryRequired"], false);
    restored.turn(&session, "after-ack", "Continue after manual inspection.");
    let request = f.base.api.chat();
    assert_eq!(
        tool_output(&request, "click")["neverAutomaticallyRetry"],
        true
    );
    request.final_text("Continued without replaying the click.");
    restored.completed("after-ack", "completed");
    assert_eq!(f.requests().len(), 2);
    f.assert_private(&mut restored, &session);
    finish_and_check_stderr(&mut restored);
}

#[test]
fn uncertain_receipts_and_broken_broker_responses_stop_without_provider_continuation() {
    for behavior in [
        "uncertain",
        "cancelled",
        "manual-review",
        "exit",
        "malformed",
        "missing-content",
        "content-not-array",
        "invalid-is-error",
        "invalid-structured",
        "mixed-content",
    ] {
        let f = BrowserFixture::new();
        f.behavior(behavior);
        let mut agent = f.agent();
        let session = f.enabled(&mut agent, "full");
        agent.turn(&session, "uncertain", "Perform this browser action once.");
        f.base.api.chat().completion(
            calls(vec![
                tool("click", "browser_click", json!({"ref":"button"})),
                tool(
                    "never-click",
                    "browser_click",
                    json!({"ref":"must-not-execute"}),
                ),
                tool(
                    "never-write",
                    "write_file",
                    json!({"path":"must-not-exist.txt","content":"forbidden after uncertainty"}),
                ),
            ]),
            "tool_calls",
        );
        let complete = agent.completed("uncertain", "failed");
        assert_eq!(complete["params"]["recoveryRequired"], true, "{behavior}");
        let mut measured_usage =
            json!({"contextModel":"mock","inputTokens":11,"outputTokens":3,"contextTokens":14});
        measured_usage["apiUsage"] = expected_api_usage(11, 3, 1, None, false, true);
        assert_eq!(complete["params"]["usage"], measured_usage, "{behavior}");
        let journal = f.base.journal(&session);
        assert_eq!(
            journal["turns"]["uncertain"]["usage"], measured_usage,
            "{behavior}"
        );
        assert_eq!(
            agent.history(&session)["usage"]["totalTokens"],
            14,
            "{behavior}"
        );
        assert_eq!(
            execution(&journal, "click")["output"]["executionUncertain"],
            true,
            "{behavior}"
        );
        assert_eq!(
            execution(&journal, "click")["output"]["neverAutomaticallyRetry"],
            true
        );
        let requests = f.requests();
        assert_eq!(
            requests
                .iter()
                .filter(|call| call["name"] == "browser_click")
                .count(),
            1
        );
        let original = requests
            .iter()
            .find(|call| call["name"] == "browser_click")
            .unwrap();
        let cancellation = requests
            .iter()
            .find(|call| call["name"] == "browser_cancel")
            .expect("uncertain work is explicitly cancelled");
        assert_eq!(
            cancellation["arguments"]["operationId"], original["operationId"],
            "{behavior}"
        );
        assert_eq!(cancellation["clientId"], original["clientId"]);
        assert!(
            !f.base.workspace.path().join("must-not-exist.txt").exists(),
            "{behavior} continued the tool batch"
        );
        assert!(
            !journal["executions"]
                .as_object()
                .unwrap()
                .values()
                .any(|entry| {
                    entry["provider_id"] == "never-click" || entry["provider_id"] == "never-write"
                }),
            "{behavior} started a later tool"
        );
        f.assert_private(&mut agent, &session);
        f.base.api.assert_quiet();
        finish_and_check_stderr(&mut agent);
    }
}

#[test]
fn uncertain_browser_failure_preserves_accumulated_usage_cost_and_latest_unknown_context() {
    for last_usage in [
        json!({"prompt_tokens":23,"completion_tokens":5,"cost":0.25}),
        Value::Null,
        json!({"cost":0.25}),
    ] {
        let f = BrowserFixture::new();
        f.behavior("uncertain");
        fs::write(
            f.base.workspace.path().join("evidence.txt"),
            "already inspected",
        )
        .unwrap();
        let mut agent = f.agent();
        let session = f.enabled(&mut agent, "full");
        agent.turn(
            &session,
            "measured-failure",
            "Inspect then act exactly once.",
        );
        f.base.api.chat().json(json!({
            "choices":[{"index":0,"message":calls(vec![tool("read","read_file",json!({"path":"evidence.txt"}))]),"finish_reason":"tool_calls"}],
            "usage":{"prompt_tokens":11,"completion_tokens":3,"cost":0.125}
        }));
        let request = f.base.api.chat();
        assert!(tool_output(&request, "read")["content"]
            .as_str()
            .unwrap()
            .contains("already inspected"));
        request.json(json!({
            "choices":[{"index":0,"message":calls(vec![tool("click","browser_click",json!({"ref":"button"}))]),"finish_reason":"tool_calls"}],
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
        let journal = f.base.journal(&session);
        assert_eq!(journal["turns"]["measured-failure"]["usage"], expected);
        let requests = f.requests();
        assert_eq!(
            requests.len(),
            2,
            "only action and targeted cancellation may run"
        );
        assert_eq!(
            f.dispatch(&requests[0]["operationId"])["turns"]["measured-failure"]["usage"],
            expected
        );
        let history = agent.history(&session);
        let total =
            expected["inputTokens"].as_u64().unwrap() + expected["outputTokens"].as_u64().unwrap();
        assert_eq!(history["usage"]["totalTokens"], total);
        assert_eq!(history["usage"]["contextTokens"], expected["contextTokens"]);
        let duplicate = agent.rpc("turn/start", json!({"sessionId":session,"messageId":"measured-failure","text":"Inspect then act exactly once."}));
        assert_eq!(duplicate["duplicate"], true);
        assert_eq!(
            agent.completed("measured-failure", "failed")["params"]["usage"],
            expected
        );
        assert_eq!(agent.history(&session)["usage"]["totalTokens"], total);
        f.base.api.assert_quiet();
        finish_and_check_stderr(&mut agent);
        drop(agent);
        let mut restored = f.agent();
        let summary = restored.start(f.base.workspace.path(), "full", Some(&session));
        assert_eq!(summary["usage"], history["usage"]);
        assert_eq!(
            f.base.journal(&session)["turns"]["measured-failure"]["usage"],
            expected
        );
        assert_eq!(f.requests().len(), 2);
        f.base.api.assert_quiet();
        finish_and_check_stderr(&mut restored);
    }
}

#[test]
fn later_unmeasured_provider_failure_keeps_prior_tokens_without_stale_context() {
    let f = BrowserFixture::new();
    fs::write(f.base.workspace.path().join("evidence.txt"), "readable").unwrap();
    let mut agent = f.agent();
    let session = f.enabled(&mut agent, "full");
    agent.turn(&session, "provider-failure", "Inspect the evidence.");
    f.base.api.chat().json(json!({
        "choices":[{"index":0,"message":calls(vec![tool("read","read_file",json!({"path":"evidence.txt"}))]),"finish_reason":"tool_calls"}],
        "usage":{"prompt_tokens":11,"completion_tokens":3,"cost":0.125}
    }));
    f.base
        .api
        .chat()
        .json(json!({"error":{"message":"offline provider rejection"}}));
    let complete = agent.completed("provider-failure", "failed");
    let mut expected =
        json!({"contextModel":"mock","inputTokens":11,"outputTokens":3,"costUsd":0.125});
    expected["apiUsage"] = expected_api_usage(11, 3, 2, Some(0.125), true, true);
    assert_eq!(complete["params"]["usage"], expected);
    assert_eq!(
        f.base.journal(&session)["turns"]["provider-failure"]["usage"],
        expected
    );
    let history = agent.history(&session);
    assert_eq!(history["usage"]["totalTokens"], 14);
    assert!(history["usage"].get("contextTokens").is_none());
    assert!(f.requests().is_empty());
    f.base.api.assert_quiet();
    finish_and_check_stderr(&mut agent);
}

#[test]
fn ordinary_broker_tool_error_is_recorded_without_uncertain_execution() {
    let f = BrowserFixture::new();
    f.behavior("tool-error");
    let mut agent = f.agent();
    let session = f.enabled(&mut agent, "full");
    agent.turn(&session, "error", "Try the action once.");
    f.base.api.chat().completion(
        calls(vec![tool(
            "click",
            "browser_click",
            json!({"ref":"missing"}),
        )]),
        "tool_calls",
    );
    let request = f.base.api.chat();
    assert_eq!(tool_output(&request, "click")["isError"], true);
    request.final_text("The browser rejected the action.");
    agent.completed("error", "completed");
    assert_eq!(agent.history(&session)["recoveryRequired"], false);
    assert_eq!(
        execution(&f.base.journal(&session), "click")["is_error"],
        true
    );
    assert_eq!(f.requests().len(), 1);
    finish_and_check_stderr(&mut agent);
}

#[test]
fn disabled_browser_leaves_native_tools_available_and_never_probes_installed_browser() {
    let f = BrowserFixture::new();
    for browser in [Value::Null, json!({"enabled":false})] {
        let mut agent = f.agent();
        let started = f.start(&mut agent, "full", browser, None);
        let session = started["sessionId"].as_str().unwrap();
        assert_eq!(started["browser"]["enabled"], false);
        assert_eq!(started["browser"]["available"], false);
        agent.turn(session, "native", "Read the workspace.");
        let request = f.base.api.chat();
        assert!(definitions(&request).contains(&"read_file"));
        assert!(!definitions(&request)
            .iter()
            .any(|name| name.starts_with("browser_")));
        request.completion(
            calls(vec![tool("list", "list_files", json!({"path":"."}))]),
            "tool_calls",
        );
        let followup = f.base.api.chat();
        assert!(tool_output(&followup, "list").get("error").is_none());
        followup.final_text("Native tools are available.");
        agent.completed("native", "completed");
        assert!(f.probes().is_empty());
        assert!(f.requests().is_empty());
        finish_and_check_stderr(&mut agent);
    }
}

#[test]
fn unavailable_sibling_falls_back_to_native_tools_without_discovering_real_install() {
    let f = BrowserFixture::without_browser();
    // Do not discover/start a real installed broker on a developer's machine.
    // An invalid sibling is selected ahead of the registered executable and
    // exercises unavailable-adapter fallback without starting a real broker.
    fs::write(
        f.bin.path().join(executable("trex-browser")),
        b"not an executable",
    )
    .unwrap();
    let mut agent = f.agent();
    let started = f.start(&mut agent, "full", json!({"enabled":true}), None);
    assert_eq!(started["browser"]["enabled"], true);
    assert_eq!(started["browser"]["available"], false);
    let session = started["sessionId"].as_str().unwrap();
    agent.turn(session, "fallback", "Continue with native tools.");
    let request = f.base.api.chat();
    assert!(definitions(&request).contains(&"read_file"));
    assert!(!definitions(&request)
        .iter()
        .any(|name| name.starts_with("browser_")));
    request.final_text("Native fallback is available.");
    agent.completed("fallback", "completed");
    assert!(f.requests().is_empty());
    finish_and_check_stderr(&mut agent);
}
