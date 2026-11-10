use super::*;
use std::sync::OnceLock;
fn app_name() -> String {
    format!("trex{}", std::env::consts::EXE_SUFFIX)
}
fn fixture_binary() -> &'static Path {
    static BINARY: OnceLock<(TempDir, PathBuf)> = OnceLock::new();
    &BINARY
        .get_or_init(|| {
            let dir = tempfile::tempdir().unwrap();
            let binary = dir.path().join(app_name());
            let output = Command::new("rustc")
                .arg("--edition=2021")
                .arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/fake_coordination.rs"))
                .arg("-o")
                .arg(&binary)
                .output()
                .unwrap();
            assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
            (dir, binary)
        })
        .1
}
/// The CLI with a stand-in for the app beside it, as installed.
struct PeersFixture {
    base: Fixture,
    bin: TempDir,
}
impl PeersFixture {
    fn new() -> Self {
        let f = Self { base: Fixture::new(), bin: tempfile::tempdir().unwrap() };
        let agent = format!("trex-agent{}", std::env::consts::EXE_SUFFIX);
        fs::copy(env!("CARGO_BIN_EXE_trex-agent"), f.bin.path().join(agent)).unwrap();
        fs::copy(fixture_binary(), f.bin.path().join(app_name())).unwrap();
        f
    }
    fn binding(&self) -> Value {
        json!({"command":self.bin.path().join(app_name()),"args":["--trex-inbox-mcp",self.base.home.path(),"t-tab-1","--peers-only","--peer","t-tab-1",self.base.workspace.path()]})
    }
    fn agent(&self) -> Agent {
        let original = command(self.base.home.path());
        let mut cmd = Command::new(self.bin.path().join(format!("trex-agent{}", std::env::consts::EXE_SUFFIX)));
        for (k, v) in original.get_envs() {
            if let Some(v) = v {
                cmd.env(k, v);
            } else {
                cmd.env_remove(k);
            }
        }
        Agent::spawn_command(cmd, "TREX1")
    }
    fn calls(&self) -> String {
        fs::read_to_string(self.base.workspace.path().join("coordination-calls.jsonl")).unwrap_or_default()
    }
}
fn tool_names(request: &HttpRequest) -> Vec<String> {
    request.body["tools"].as_array().unwrap().iter().map(|t| t["function"]["name"].as_str().unwrap().to_owned()).collect()
}

#[test]
fn coordination_tools_keep_their_names_and_talk_without_approval() {
    let f = PeersFixture::new();
    let mut agent = f.agent();
    let start = agent.rpc("session/start", json!({"cwd":f.base.workspace.path(),"mode":"ask","coordination":f.binding()}));
    assert_eq!(start["coordinationEnabled"], true, "{start}");
    let session = start["sessionId"].as_str().unwrap().to_string();
    // A live session keeps its binding: the same one is accepted, any other change is refused.
    let again = agent.rpc("session/start", json!({"cwd":f.base.workspace.path(),"mode":"ask","coordination":f.binding(),"conversationId":session}));
    assert_eq!(again["coordinationEnabled"], true);
    let dropped = agent.request("session/start", json!({"cwd":f.base.workspace.path(),"mode":"ask","conversationId":session}));
    assert!(agent.response(dropped).get("error").is_some());

    agent.turn(&session, "talk", "Agree with Codex before touching src/api.ts");
    let request = f.base.api.request("POST", "/v1/chat/completions");
    let names = tool_names(&request);
    for name in ["trex_peers", "trex_claim", "trex_release", "trex_message"] {
        assert!(names.iter().any(|n| n == name), "{name} missing from {names:?}");
    }
    assert!(!names.iter().any(|n| n.starts_with("mcp_trex_coordination")), "app tools are not renamed");
    assert!(messages(&request)[0]["content"].as_str().unwrap().contains("Other Trex sessions may work in this project"));
    // In ask mode a message to another session needs no approval: it never touches the workspace.
    request.completion(calls(vec![tool("msg-1", "trex_message", json!({"to":"Codex","text":"Can I edit src/api.ts?"}))]), "tool_calls");
    let next = f.base.api.request("POST", "/v1/chat/completions");
    assert!(tool_output(&next, "msg-1").to_string().contains("Message sent to Codex"));
    next.completion(json!({"role":"assistant","content":"Asked Codex; continuing."}), "stop");
    agent.completed("talk", "completed");
    let calls = f.calls();
    assert_eq!(calls.lines().count(), 1);
    assert!(calls.contains("\"name\":\"trex_message\"") && calls.contains("Can I edit src/api.ts?"), "{calls}");
    f.base.api.assert_quiet();
}

#[test]
fn planning_sessions_coordinate_too_and_foreign_servers_are_refused() {
    let f = PeersFixture::new();
    let mut agent = f.agent();
    let start = agent.rpc("session/start", json!({"cwd":f.base.workspace.path(),"mode":"plan","coordination":f.binding()}));
    assert_eq!(start["coordinationEnabled"], true);
    let session = start["sessionId"].as_str().unwrap().to_string();
    agent.turn(&session, "plan", "Plan the change with the other sessions");
    let request = f.base.api.request("POST", "/v1/chat/completions");
    let names = tool_names(&request);
    assert!(names.iter().any(|n| n == "trex_message") && names.iter().any(|n| n == "trex_claim"), "{names:?}");
    assert!(!names.iter().any(|n| n == "write_file"));
    request.completion(json!({"role":"assistant","content":"Plan ready."}), "stop");
    agent.completed("plan", "completed");
    // Only the app beside this CLI, for this workspace.
    let mut binding = f.binding();
    binding["command"] = json!(env!("CARGO_BIN_EXE_trex-agent"));
    let foreign = agent.request("session/start", json!({"cwd":f.base.workspace.path(),"mode":"plan","coordination":binding}));
    let error = agent.response(foreign)["error"]["message"].as_str().unwrap_or_default().to_owned();
    assert!(error.contains("app beside this CLI"), "{error}");
    let other = tempfile::tempdir().unwrap();
    let mut binding = f.binding();
    binding["args"][6] = json!(other.path());
    let elsewhere = agent.request("session/start", json!({"cwd":f.base.workspace.path(),"mode":"plan","coordination":binding}));
    let error = agent.response(elsewhere)["error"]["message"].as_str().unwrap_or_default().to_owned();
    assert!(error.contains("workspace"), "{error}");
    f.base.api.assert_quiet();
}
