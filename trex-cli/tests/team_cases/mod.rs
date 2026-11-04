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
                .arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/fake_team.rs"))
                .arg("-o")
                .arg(&binary)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            (dir, binary)
        })
        .1
}
struct TeamFixture {
    base: Fixture,
    bin: TempDir,
}
impl TeamFixture {
    fn new() -> Self {
        let f = Self {
            base: Fixture::new(),
            bin: tempfile::tempdir().unwrap(),
        };
        fs::copy(
            env!("CARGO_BIN_EXE_trex-agent"),
            f.bin
                .path()
                .join(format!("trex-agent{}", std::env::consts::EXE_SUFFIX)),
        )
        .unwrap();
        fs::copy(fixture_binary(), f.bin.path().join(app_name())).unwrap();
        f
    }
    fn binding(&self) -> Value {
        json!({"command":self.bin.path().join(app_name()),"args":["--trex-team-call",self.base.workspace.path(),"team-id","epoch"]})
    }
    fn agent(&self) -> Agent {
        let original = command(self.base.home.path());
        let mut cmd = Command::new(
            self.bin
                .path()
                .join(format!("trex-agent{}", std::env::consts::EXE_SUFFIX)),
        );
        for (k, v) in original.get_envs() {
            if let Some(v) = v {
                cmd.env(k, v);
            } else {
                cmd.env_remove(k);
            }
        }
        cmd.env("OPENAI_API_KEY", "FAKE_MUST_NOT_BE_INHERITED");
        Agent::spawn_command(cmd, "TREX1")
    }
    fn start(&self, agent: &mut Agent) -> String {
        let result=agent.rpc("session/start",json!({"cwd":self.base.workspace.path(),"mode":"plan","team":self.binding(),"roleInstructions":"Coordinate through configured team tools; never edit directly."}));
        assert_eq!(result["teamEnabled"], true);
        assert_eq!(result["rolePolicyApplied"], true);
        result["sessionId"].as_str().unwrap().into()
    }
    fn dispatches(&self) -> String {
        fs::read_to_string(self.base.workspace.path().join("team-calls.jsonl")).unwrap_or_default()
    }
}
#[test]
fn delegated_plan_uses_bound_bridge_returns_report_and_deduplicates_native_call() {
    let f = TeamFixture::new();
    let mut agent = f.agent();
    let session = f.start(&mut agent);
    agent.turn(&session, "main", "Coordinate the task");
    let request = f.base.api.request("POST", "/v1/chat/completions");
    let tools = request.body["tools"].as_array().unwrap();
    assert!(tools
        .iter()
        .any(|t| t["function"]["name"] == "trex_delegate_task"));
    assert!(!tools.iter().any(|t| t["function"]["name"] == "write_file"));
    assert!(messages(&request)[0]["content"]
        .as_str()
        .unwrap()
        .contains("Coordinate through configured team tools"));
    let call = tool(
        "delegate-once",
        "trex_delegate_task",
        json!({"memberId":"worker","taskKey":"stable","task":"Implement and test"}),
    );
    request.completion(calls(vec![call.clone()]), "tool_calls");
    let next = f.base.api.request("POST", "/v1/chat/completions");
    // One compact copy: the bridge's structuredContent, without its MCP
    // wrapper or the text pointer (the journal keeps the full response).
    let delegated = tool_output(&next, "delegate-once");
    assert_eq!(delegated["task"]["report"], "Worker report: tests passed");
    assert!(delegated.get("content").is_none() && delegated.get("structuredContent").is_none());
    assert_eq!(
        f.base.journal(&session)["executions"]
            .as_object()
            .unwrap()
            .values()
            .find(|e| e["name"] == "trex_delegate_task")
            .unwrap()["output"]["structuredContent"]["task"]["status"],
        "completed"
    );
    next.completion(calls(vec![call]), "tool_calls");
    f.base
        .api
        .request("POST", "/v1/chat/completions")
        .completion(
            json!({"role":"assistant","content":"Verified final result"}),
            "stop",
        );
    agent.completed("main", "completed");
    assert_eq!(f.dispatches().lines().count(), 1);
    f.base.api.assert_quiet();
}
#[test]
fn ordinary_plan_has_no_delegation_tools_and_invalid_binding_never_starts_a_turn() {
    let f = TeamFixture::new();
    let mut agent = f.agent();
    let session = agent.start(f.base.workspace.path(), "plan", None)["sessionId"]
        .as_str()
        .unwrap()
        .to_string();
    let id=agent.request("session/start",json!({"cwd":f.base.workspace.path(),"mode":"plan","team":{"command":"relative-executable","args":[]}}));
    assert!(agent.response(id).get("error").is_some());
    agent.turn(&session, "ordinary", "Read the project");
    let request = f.base.api.request("POST", "/v1/chat/completions");
    assert!(!request.body["tools"]
        .as_array()
        .unwrap()
        .iter()
        .any(|t| t["function"]["name"] == "trex_delegate_task"));
    request.completion(
        json!({"role":"assistant","content":"Read-only response"}),
        "stop",
    );
    agent.completed("ordinary", "completed");
    assert!(f.dispatches().is_empty());
}
#[test]
fn team_binding_and_role_policy_are_immutable_for_a_live_session() {
    let f = TeamFixture::new();
    let mut agent = f.agent();
    let session = f.start(&mut agent);
    for patch in [
        json!({"team":null}),
        json!({"team":f.binding(),"roleInstructions":"different policy"}),
    ] {
        let mut params =
            json!({"cwd":f.base.workspace.path(),"mode":"plan","conversationId":session});
        params
            .as_object_mut()
            .unwrap()
            .extend(patch.as_object().unwrap().clone());
        let id = agent.request("session/start", params);
        assert!(agent.response(id).get("error").is_some());
    }
    f.base.api.assert_quiet();
}
#[test]
fn uncertain_delegation_preserves_usage_and_requires_review_instead_of_continuing() {
    let f = TeamFixture::new();
    let mut agent = f.agent();
    let session = f.start(&mut agent);
    agent.turn(&session, "uncertain", "Delegate work");
    f.base
        .api
        .request("POST", "/v1/chat/completions")
        .completion(
            calls(vec![tool(
                "uncertain-task",
                "trex_delegate_task",
                json!({"memberId":"worker","taskKey":"uncertain-task","task":"Check changes"}),
            )]),
            "tool_calls",
        );
    let terminal = agent.completed("uncertain", "failed");
    assert_eq!(terminal["params"]["recoveryRequired"], true);
    assert_eq!(agent.history(&session)["recoveryRequired"], true);
    assert_eq!(f.dispatches().lines().count(), 1);
    f.base.api.assert_quiet();
}
#[test]
fn stop_cancels_waiting_delegation_without_second_provider_request() {
    let f = TeamFixture::new();
    let mut agent = f.agent();
    let session = f.start(&mut agent);
    agent.turn(&session, "stop", "Delegate work");
    f.base
        .api
        .request("POST", "/v1/chat/completions")
        .completion(
            calls(vec![tool(
                "hold-task",
                "trex_delegate_task",
                json!({"memberId":"worker","taskKey":"hold-task","task":"Wait for report"}),
            )]),
            "tool_calls",
        );
    let deadline = Instant::now() + Duration::from_secs(5);
    while f.dispatches().is_empty() {
        assert!(Instant::now() < deadline);
        thread::sleep(Duration::from_millis(10));
    }
    let start = Instant::now();
    agent.rpc("turn/interrupt", json!({"sessionId":session}));
    let terminal = agent.completed("stop", "interrupted");
    assert!(start.elapsed() < Duration::from_secs(4));
    assert_eq!(terminal["params"]["recoveryRequired"], true);
    f.base.api.assert_quiet();
}
