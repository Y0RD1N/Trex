use super::*;

#[test]
fn disabled_application_integrations_are_not_advertised_or_executable() {
    let f = Fixture::new();
    let (_installed, mut agent) = agent_with_github_fixture(&f);
    let session=agent.rpc("session/start",json!({"cwd":f.workspace.path(),"mode":"full","settings":{"tools":{"github":false,"blender":false,"hyperframes":false}}}));
    assert_eq!(
        session["applicationIntegrations"],
        json!({"github":false,"blender":false,"hyperframes":false})
    );
    let id = session["sessionId"].as_str().unwrap();
    agent.turn(
        id,
        "disabled-integrations",
        "Inspect the enabled capabilities",
    );
    let request = f.api.chat();
    for name in ["github_", "blender_run", "hyperframes_run"] {
        assert!(!request.body["tools"]
            .as_array()
            .unwrap()
            .iter()
            .any(|t| t["function"]["name"].as_str().unwrap().starts_with(name)));
    }
    let policy = messages(&request)[0]["content"].as_str().unwrap();
    for name in ["GitHub", "Blender", "HyperFrames"] {
        assert!(!policy.contains(name));
    }
    request.completion(
        calls(vec![tool("forged", "github_repos", json!({}))]),
        "tool_calls",
    );
    let next = f.api.chat();
    assert!(tool_output(&next, "forged")["error"].is_string());
    next.final_text("Disabled capabilities were refused");
    agent.completed("disabled-integrations", "completed");
}

fn start(f: &Fixture, agent: &mut Agent, mode: &str, settings: Value) -> String {
    agent.rpc(
        "session/start",
        json!({"cwd":f.workspace.path(),"mode":mode,"settings":settings}),
    )["sessionId"]
        .as_str()
        .unwrap()
        .into()
}
#[test]
fn privacy_guidance_and_parallel_reads_reach_actual_provider_without_secret_files() {
    let f = Fixture::new();
    fs::write(
        f.workspace.path().join("AGENTS.md"),
        "PROJECT_AUDIT_GUIDANCE: validate changes.",
    )
    .unwrap();
    fs::write(
        f.workspace.path().join(".env"),
        "AUDIT_FAKE_MARKER=not-real",
    )
    .unwrap();
    fs::write(f.workspace.path().join(".gitignore"), "cache/\n").unwrap();
    fs::create_dir(f.workspace.path().join("cache")).unwrap();
    fs::write(
        f.workspace.path().join("cache/generated"),
        "AUDIT_FAKE_MARKER",
    )
    .unwrap();
    fs::write(f.workspace.path().join("visible"), "AUDIT_FAKE_MARKER").unwrap();
    let mut agent = f.agent();
    let session = start(&f, &mut agent, "plan", json!({}));
    agent.turn(&session, "privacy", "Inspect this project");
    let request = f.api.chat();
    assert!(messages(&request)[0]["content"]
        .as_str()
        .unwrap()
        .contains("PROJECT_AUDIT_GUIDANCE"));
    request.completion(
        calls(vec![
            tool("search", "search", json!({"pattern":"AUDIT_FAKE_MARKER"})),
            tool("read", "read_file", json!({"path":"visible"})),
        ]),
        "tool_calls",
    );
    let next = f.api.chat();
    let results = tool_output(&next, "search")["matches"]
        .as_array()
        .unwrap()
        .clone();
    assert_eq!(results.len(), 1);
    assert_eq!(results[0]["path"], "visible");
    assert_eq!(tool_output(&next, "read")["content"], "AUDIT_FAKE_MARKER");
    next.final_text("Verified");
    agent.completed("privacy", "completed");
    assert!(f.journal(&session)["executions"]
        .as_object()
        .unwrap()
        .values()
        .all(|e| e["state"] == "done"));
}
#[test]
fn context_and_request_budgets_fail_before_http_dispatch() {
    for settings in [
        json!({"context":{"fallbackWindow":256}}),
        json!({"limits":{"maxTurnTokens":1}}),
    ] {
        let f = Fixture::new();
        let mut agent = f.agent();
        let session = start(&f, &mut agent, "plan", settings);
        agent.turn(&session, "bounded", "Respect configured limits");
        let event = agent.completed("bounded", "failed");
        assert!(event["params"]["error"]
            .as_str()
            .unwrap()
            .contains("budget"));
        f.api.assert_quiet();
    }
}
#[test]
fn manual_compaction_retains_full_history_and_invalidates_old_context_measurements() {
    let f = Fixture::new();
    let mut agent = f.agent();
    let session = start(
        &f,
        &mut agent,
        "plan",
        json!({"context":{"keepRecentTurns":1}}),
    );
    for n in 0..4 {
        let id = format!("turn-{n}");
        agent.turn(&session, &id, &format!("Remember request {n}"));
        f.api.chat().final_text(&format!("Answer {n}"));
        agent.completed(&id, "completed");
    }
    let original = f.journal(&session)["messages"].clone();
    let compact = agent.rpc("session/compact", json!({"sessionId":session}));
    assert!(
        compact["contextManagement"]["archivedMessages"]
            .as_u64()
            .unwrap()
            > 0
    );
    assert!(compact["usage"].get("contextTokens").is_none());
    assert_eq!(f.journal(&session)["messages"], original);
    agent.turn(&session, "after-compact", "Continue");
    let next = f.api.chat();
    assert!(messages(&next).iter().any(|m| m["content"]
        .as_str()
        .is_some_and(|s| s.contains("Earlier conversation reference"))));
    next.final_text("Continued");
    agent.completed("after-compact", "completed");
    assert!(
        agent.rpc("session/usage", json!({"sessionId":session}))["usage"]["contextTokens"]
            .is_number()
    );
}
#[test]
fn stream_wal_recovers_a_killed_partial_response_without_replaying_a_request() {
    let f = Fixture::new();
    let mut agent = f.agent();
    let session = agent.start(f.workspace.path(), "plan", None)["sessionId"]
        .as_str()
        .unwrap()
        .to_owned();
    agent.turn(&session, "crashed-stream", "Stream safely");
    let mut socket = f.api.chat().sse();
    sse(
        &mut socket,
        json!({"choices":[{"index":0,"delta":{"role":"assistant","content":"PRESERVED_PARTIAL_🦖"},"finish_reason":null}]}),
    );
    agent.event("message/delta", "crashed-stream");
    assert!(
        f.journal_path(&session)
            .with_extension("stream")
            .metadata()
            .unwrap()
            .len()
            > 0
    );
    drop(agent);
    drop(socket);
    let mut restored = f.agent();
    let summary = restored.start(f.workspace.path(), "plan", Some(&session));
    assert_text(&summary, "PRESERVED_PARTIAL_🦖");
    f.api.assert_quiet();
    assert_eq!(
        f.journal_path(&session)
            .with_extension("stream")
            .metadata()
            .unwrap()
            .len(),
        0
    );
}
#[test]
fn fragmented_stream_checkpoints_once_and_keeps_all_text() {
    let f = Fixture::new();
    let mut agent = f.agent();
    let session = start(&f, &mut agent, "plan", json!({}));
    agent.turn(&session, "many-fragments", "Stream");
    let before = Instant::now();
    let mut socket = f.api.chat().sse();
    for _ in 0..512 {
        sse(
            &mut socket,
            json!({"choices":[{"index":0,"delta":{"content":"x".repeat(64)},"finish_reason":null}]}),
        );
    }
    sse(
        &mut socket,
        json!({"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":8192}}),
    );
    write!(socket, "data: [DONE]\n\n").unwrap();
    socket.flush().unwrap();
    drop(socket);
    agent.completed("many-fragments", "completed");
    assert!(before.elapsed() < TIMEOUT);
    let journal = f.journal(&session);
    let text = journal["messages"].as_array().unwrap().last().unwrap()["content"]
        .as_str()
        .unwrap();
    assert_eq!(text.len(), 32768);
    assert_eq!(
        f.journal_path(&session)
            .with_extension("stream")
            .metadata()
            .unwrap()
            .len(),
        0
    );
}
#[test]
fn timed_out_native_mutation_stops_before_another_completion_and_requires_review() {
    let f = Fixture::new();
    let mut agent = f.agent();
    let session = start(&f, &mut agent, "full", json!({}));
    agent.turn(&session, "timeout", "Exercise temporary fixture");
    let command = if cfg!(windows) {
        "Set-Content -LiteralPath 'timeout-proof' -Value 'changed'; Start-Sleep -Seconds 20"
    } else {
        "printf changed > timeout-proof; sleep 20"
    };
    f.api.chat().completion(
        calls(vec![tool(
            "timeout",
            "shell",
            json!({"command":command,"timeoutMs":3000}),
        )]),
        "tool_calls",
    );
    let end = agent.completed("timeout", "failed");
    assert_eq!(end["params"]["recoveryRequired"], true);
    assert!(f.workspace.path().join("timeout-proof").exists());
    f.api.assert_quiet();
    agent.rpc(
        "session/recover",
        json!({"sessionId":session,"action":"acknowledge"}),
    );
}
#[test]
fn native_utf8_and_guarded_checkpoints_preserve_newer_work() {
    let f = Fixture::new();
    fs::write(f.workspace.path().join("file.txt"), "one\r\ntwo\r\n").unwrap();
    let mut agent = f.agent();
    let session = start(&f, &mut agent, "full", json!({}));
    agent.turn(&session, "edit", "Edit precisely");
    f.api.chat().completion(
        calls(vec![tool(
            "edit",
            "edit_file",
            json!({"path":"file.txt","oldText":"two","newText":"áé 🦖"}),
        )]),
        "tool_calls",
    );
    let next = f.api.chat();
    let checkpoint = tool_output(&next, "edit")["checkpointId"]
        .as_str()
        .unwrap()
        .to_owned();
    next.final_text("Edited");
    agent.completed("edit", "completed");
    assert_eq!(
        fs::read_to_string(f.workspace.path().join("file.txt")).unwrap(),
        "one\r\náé 🦖\r\n"
    );
    fs::write(f.workspace.path().join("file.txt"), "NEWER USER WORK").unwrap();
    agent.turn(&session, "restore", "Try guarded restore");
    f.api.chat().completion(
        calls(vec![tool(
            "restore",
            "checkpoint_restore",
            json!({"id":checkpoint}),
        )]),
        "tool_calls",
    );
    let next = f.api.chat();
    assert!(tool_output(&next, "restore")["error"]
        .as_str()
        .unwrap()
        .contains("newer work"));
    next.final_text("Preserved");
    agent.completed("restore", "completed");
    assert_eq!(
        fs::read_to_string(f.workspace.path().join("file.txt")).unwrap(),
        "NEWER USER WORK"
    );
    agent.turn(&session, "unicode", "Check output encoding");
    let command = if cfg!(windows) {
        "Write-Output 'áé 中文 🦖'"
    } else {
        "printf 'áé 中文 🦖'"
    };
    f.api.chat().completion(
        calls(vec![tool("utf8", "shell", json!({"command":command}))]),
        "tool_calls",
    );
    let next = f.api.chat();
    assert!(tool_output(&next, "utf8")["stdout"]
        .as_str()
        .unwrap()
        .contains("áé 中文 🦖"));
    next.final_text("Verified");
    agent.completed("unicode", "completed");
}
#[test]
fn owned_pty_accepts_unicode_input_resize_and_stop_without_restarting_chat() {
    let f = Fixture::new();
    let mut agent = f.agent();
    let session = start(&f, &mut agent, "full", json!({}));
    agent.turn(&session, "pty", "Open an owned PTY");
    let command = if cfg!(windows) {
        "Write-Output 'READY'; $answer=[Console]::ReadLine(); Write-Output ('GOT:'+$answer); Start-Sleep -Seconds 30"
    } else {
        "printf 'READY\\n'; IFS= read -r answer; printf 'GOT:%s\\n' \"$answer\"; sleep 30"
    };
    f.api.chat().completion(
        calls(vec![tool(
            "pty",
            "shell",
            json!({"command":command,"background":true,"pty":true}),
        )]),
        "tool_calls",
    );
    let next = f.api.chat();
    let id = tool_output(&next, "pty")["id"].as_str().unwrap().to_owned();
    next.final_text("Started");
    agent.completed("pty", "completed");
    let deadline = Instant::now() + TIMEOUT;
    loop {
        let out = agent.rpc("process/read", json!({"sessionId":session,"processId":id}));
        if out["text"].as_str().unwrap().contains("READY") {
            break;
        }
        assert!(Instant::now() < deadline);
        thread::sleep(Duration::from_millis(30));
    }
    assert_eq!(
        agent.rpc(
            "process/resize",
            json!({"sessionId":session,"processId":id,"rows":30,"cols":120})
        )["resized"],
        true
    );
    agent.rpc(
        "process/write",
        json!({"sessionId":session,"processId":id,"text":"áé🦖\n"}),
    );
    let deadline = Instant::now() + TIMEOUT;
    loop {
        let out = agent.rpc("process/read", json!({"sessionId":session,"processId":id}));
        if out["text"].as_str().unwrap().contains("GOT:áé🦖") {
            break;
        }
        assert!(Instant::now() < deadline, "{out}");
        thread::sleep(Duration::from_millis(30));
    }
    agent.rpc("process/stop", json!({"sessionId":session,"processId":id}));
    let foreign = agent.request(
        "process/write",
        json!({"sessionId":session,"processId":"unowned","text":"do not send"}),
    );
    assert!(agent.response(foreign).get("error").is_some());
}
#[test]
fn bounded_retry_preserves_request_identity_and_reports_actual_attempt_count() {
    let f = Fixture::new();
    let mut agent = f.agent();
    let session = start(
        &f,
        &mut agent,
        "plan",
        json!({"limits":{"maxRequestsPerTurn":2}}),
    );
    agent.turn(&session, "retry", "Handle explicit rate limiting");
    let mut first = f.api.chat();
    let request_id = first
        .headers
        .iter()
        .find(|(k, _)| k == "x-request-id")
        .unwrap()
        .1
        .clone();
    write!(first.socket,"HTTP/1.1 429 Too Many Requests\r\nRetry-After: 0\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap();
    first.socket.flush().unwrap();
    drop(first);
    let second = f.api.chat();
    assert_eq!(
        second
            .headers
            .iter()
            .find(|(k, _)| k == "x-request-id")
            .unwrap()
            .1,
        request_id
    );
    assert!(second.body["max_tokens"].is_number());
    second.final_text("Recovered");
    let end = agent.completed("retry", "completed");
    assert_eq!(end["params"]["apiUsage"]["requests"], 2);
    f.api.assert_quiet();
}
#[test]
fn history_management_keeps_recoverable_trash_and_forks_without_model_calls() {
    let f = Fixture::new();
    let mut agent = f.agent();
    let session = start(&f, &mut agent, "plan", json!({}));
    agent.turn(&session, "original", "Keep this request");
    f.api.chat().final_text("Preserved answer");
    agent.completed("original", "completed");
    drop(agent);
    let run = |args: &[&str]| {
        let output = command(f.home.path()).args(args).output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        serde_json::from_slice::<Value>(&output.stdout).unwrap()
    };
    let fork = run(&["sessions", "fork", &session]);
    let fork_id = fork["conversationId"].as_str().unwrap();
    assert_ne!(fork_id, session);
    assert!(run(&["sessions", "export", fork_id])["messages"]
        .as_array()
        .unwrap()
        .iter()
        .any(|m| m["content"] == "Preserved answer"));
    assert_eq!(run(&["sessions", "remove", fork_id])["recoverable"], true);
    assert_eq!(run(&["sessions", "restore", fork_id])["restored"], true);
    f.api.assert_quiet();
}

pub(super) fn mcp_binary() -> &'static Path {
    static BINARY: std::sync::OnceLock<(TempDir, PathBuf)> = std::sync::OnceLock::new();
    &BINARY
        .get_or_init(|| {
            let directory = tempfile::tempdir().unwrap();
            let binary = directory
                .path()
                .join(format!("fixture-mcp{}", std::env::consts::EXE_SUFFIX));
            let output = Command::new("rustc")
                .arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/fake_mcp.rs"))
                .arg("-o")
                .arg(&binary)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            (directory, binary)
        })
        .1
}

#[test]
fn accessibility_sessions_publish_reads_in_plan_and_accept_old_settings() {
    for mode in ["plan", "ask"] {
        let f = Fixture::new();
        let mut agent = Agent::spawn_command(command(f.home.path()), "TREX1");
        // Configuraciones guardadas que pedían agent-desktop: arrancan con el motor propio.
        let started = agent.rpc("session/start", json!({"cwd":f.workspace.path(),"mode":mode,"accessibility":"agent-desktop"}));
        if !cfg!(windows) {
            assert_eq!(started["accessibilityEnabled"], false, "only Windows has the built-in engine");
            assert!(started["unavailableMcpServers"].as_array().unwrap().contains(&json!("trex_a11y")));
            continue;
        }
        assert_eq!(started["accessibilityEnabled"], true, "{mode}");
        let session = started["sessionId"].as_str().unwrap().to_owned();
        agent.turn(&session, "a11y", "Read the open window");
        let request = f.api.chat();
        let names: Vec<String> = request.body["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|tool| tool["function"]["name"].as_str().unwrap().to_owned())
            .collect();
        assert!(names.iter().any(|name| name.contains("a11y_snapshot")), "{names:?}");
        // Plan solo observa; las acciones semánticas piden permiso fuera de plan.
        assert_eq!(names.iter().any(|name| name.contains("a11y_click")), mode == "ask", "{mode}");
        request.final_text("Read through accessibility");
        agent.completed("a11y", "completed");
        f.api.assert_quiet();
    }
    let f = Fixture::new();
    let mut agent = Agent::spawn_command(command(f.home.path()), "TREX1");
    let plain = agent.rpc("session/start", json!({"cwd":f.workspace.path(),"mode":"plan"}));
    assert!(plain.get("accessibilityEnabled").is_none());
    let unknown = agent.request("session/start", json!({"cwd":f.workspace.path(),"mode":"plan","accessibility":"other"}));
    assert!(agent.response(unknown).get("error").is_some());
}

#[test]
fn the_builtin_accessibility_engine_needs_no_external_tool() {
    let f = Fixture::new();
    let mut agent = Agent::spawn_command(command(f.home.path()), "TREX1");
    let started = agent.rpc("session/start", json!({"cwd":f.workspace.path(),"mode":"ask","accessibility":{"keyboard":true}}));
    if !cfg!(windows) {
        assert_eq!(started["accessibilityEnabled"], false, "only Windows has the built-in engine");
        return;
    }
    assert_eq!(started["accessibilityEnabled"], true);
    let session = started["sessionId"].as_str().unwrap().to_owned();
    agent.turn(&session, "native", "Which windows are open?");
    let request = f.api.chat();
    let names: Vec<String> = request.body["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|tool| tool["function"]["name"].as_str().unwrap().to_owned())
        .collect();
    let status = names.iter().find(|name| name.contains("a11y_status")).expect("status tool").clone();
    // La guía del servidor (sus instructions) llega al prompt de sistema, como en Claude Code.
    let system = request.body["messages"][0]["content"].as_str().unwrap();
    assert!(system.contains("Integration guidance") && system.contains("trex_a11y (MCP server): Trex accessibility engine"), "{system}");
    assert!(names.iter().any(|name| name.contains("a11y_set_value")));
    assert!(names.iter().any(|name| name.contains("a11y_press")), "shortcuts were allowed for this session");
    assert!(!names.iter().any(|name| name.contains("a11y_focus_window")), "the built-in engine has no plain focus tool");
    request.completion(calls(vec![tool("native-status", &status, json!({}))]), "tool_calls");
    let next = f.api.chat();
    let output = tool_output(&next, "native-status").to_string();
    assert!(output.contains("engine: trex (Windows UI Automation)"), "{output}");
    next.final_text("The built-in engine answered");
    agent.completed("native", "completed");
    f.api.assert_quiet();
}

#[test]
fn conversation_token_reservations_survive_missing_usage_and_process_restart() {
    let f = Fixture::new();
    let mut agent = f.agent();
    let session = start(
        &f,
        &mut agent,
        "plan",
        json!({"provider":{"maxOutputTokens":100},"limits":{"maxConversationTokens":100000}}),
    );
    agent.turn(
        &session,
        "unknown-usage",
        "First request without provider counters",
    );
    f.api.chat().json(json!({"choices":[{"index":0,"message":{"role":"assistant","content":"Preserved without counters"},"finish_reason":"stop"}]}));
    agent.completed("unknown-usage", "completed");
    let reserved = f.journal(&session)["budgetReservedEstimateTokens"]
        .as_u64()
        .unwrap();
    assert!(reserved > 100);
    drop(agent);
    let mut restored = f.agent();
    restored.rpc("session/start",json!({"cwd":f.workspace.path(),"conversationId":session,"mode":"plan","settings":{"provider":{"maxOutputTokens":100},"limits":{"maxConversationTokens":reserved*2-1}}}));
    restored.turn(&session, "bounded-after-restart", "Second request");
    let end = restored.completed("bounded-after-restart", "failed");
    assert_eq!(end["params"]["errorDetails"]["code"], "budget_exceeded");
    f.api.assert_quiet();
}
#[test]
fn mcp_whitelist_and_credentials_are_scoped_and_mutations_need_approval() {
    for mode in ["plan", "ask"] {
        let f = Fixture::new();
        let mut command = command(f.home.path());
        command.env("TREX_FAKE_MCP_SECRET", "fake-credential-for-redaction");
        let mut agent = Agent::spawn_command(command, "TREX1");
        let settings = json!({"mcpServers":[{"name":"fixture","command":mcp_binary(),"env":["TREX_FAKE_MCP_SECRET"],"readOnlyTools":["read_fixture"]}]});
        let session = start(&f, &mut agent, mode, settings);
        agent.turn(&session, "mcp", "Use the configured integration");
        let request = f.api.chat();
        let defs = request.body["tools"].as_array().unwrap();
        let read = defs
            .iter()
            .find(|t| {
                t["function"]["name"]
                    .as_str()
                    .unwrap()
                    .contains("read_fixture")
            })
            .expect("configured read tool")["function"]["name"]
            .as_str()
            .unwrap()
            .to_owned();
        let write = defs
            .iter()
            .find(|t| {
                t["function"]["name"]
                    .as_str()
                    .unwrap()
                    .contains("write_fixture")
            })
            .map(|t| t["function"]["name"].as_str().unwrap().to_owned());
        assert_eq!(write.is_some(), mode == "ask");
        request.completion(
            calls(vec![tool("mcp-read", &read, json!({}))]),
            "tool_calls",
        );
        let next = f.api.chat();
        let output = tool_output(&next, "mcp-read").to_string();
        assert!(output.contains("redacted credential"));
        assert!(!output.contains("fake-credential-for-redaction"));
        if let Some(write) = write {
            next.completion(
                calls(vec![tool("mcp-write", &write, json!({}))]),
                "tool_calls",
            );
            let permission = agent.event("permission/request", "mcp");
            assert!(!f.workspace.path().join("mcp-write.marker").exists());
            agent.rpc(
                "permission/respond",
                json!({"id":permission["params"]["id"],"allowed":true}),
            );
            f.api.chat().final_text("Verified approved write");
            assert!(f.workspace.path().join("mcp-write.marker").exists());
        } else {
            next.final_text("Read only verified");
        }
        agent.completed("mcp", "completed");
        assert!(!f
            .journal(&session)
            .to_string()
            .contains("fake-credential-for-redaction"));
    }
}
#[test]
fn exec_json_fails_with_nonzero_exit_and_never_replays_a_rejected_completion() {
    let f = Fixture::new();
    let child = command(f.home.path())
        .args([
            "--profile",
            "TREX1",
            "exec",
            "--cwd",
            f.workspace.path().to_str().unwrap(),
            "--mode",
            "plan",
            "--json",
            "Fixture API failure",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    f.api
        .request("GET", "/v1/models")
        .json(json!({"data":[{"id":"mock","context_length":32768}]}));
    let mut request = f.api.chat();
    write!(
        request.socket,
        "HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
    )
    .unwrap();
    request.socket.flush().unwrap();
    drop(request);
    let output = child.wait_with_output().unwrap();
    assert_eq!(output.status.code(), Some(2));
    let frames: Vec<Value> = String::from_utf8(output.stdout)
        .unwrap()
        .lines()
        .map(|s| serde_json::from_str(s).unwrap())
        .collect();
    assert!(frames
        .iter()
        .any(|v| v["method"] == "turn/completed" && v["params"]["status"] == "failed"));
    f.api.assert_quiet();
}

#[test]
fn api_errors_are_structured_redacted_and_replayed_without_another_request() {
    let f = Fixture::new();
    let mut agent = f.agent();
    let session = start(&f, &mut agent, "plan", json!({}));
    agent.turn(&session, "rejected", "Fixture request");
    let mut request = f.api.chat();
    let body = r#"{"error":{"code":"context_length_exceeded","message":"SYNTHETIC_PRIVATE_BODY"}}"#;
    write!(
        request.socket,
        "HTTP/1.1 400 Bad Request\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    )
    .unwrap();
    request.socket.flush().unwrap();
    drop(request);
    let end = agent.completed("rejected", "failed");
    assert_eq!(
        end["params"]["errorDetails"]["code"],
        "context_length_exceeded"
    );
    assert!(!end.to_string().contains("SYNTHETIC_PRIVATE_BODY"));
    assert_eq!(
        f.journal(&session)["turns"]["rejected"]["error_details"]["code"],
        "context_length_exceeded"
    );
    agent.turn(&session, "rejected", "Fixture request");
    let replay = agent.event("turn/completed", "rejected");
    assert_eq!(
        replay["params"]["errorDetails"],
        end["params"]["errorDetails"]
    );
    f.api.assert_quiet();
}
#[test]
fn configured_custom_effort_and_usd_reservations_reach_preflight_and_transport() {
    let f = Fixture::new();
    let mut agent = f.agent();
    let session=agent.rpc("session/start",json!({"cwd":f.workspace.path(),"mode":"plan","effort":"high","settings":{"provider":{"customEffortParameter":"reasoning.effort","maxOutputTokens":100,"pricing":{"inputUsdPerMillion":1.0,"outputUsdPerMillion":2.0}},"limits":{"maxCostUsd":0.03}}}))["sessionId"].as_str().unwrap().to_owned();
    agent.turn(&session, "priced", "Respect pricing");
    let request = f.api.chat();
    assert_eq!(request.body["reasoning"]["effort"], "high");
    assert_eq!(request.body["max_tokens"], 100);
    request.final_text("Priced response");
    agent.completed("priced", "completed");
    assert!(
        f.journal(&session)["budgetReservedEstimateUsd"]
            .as_f64()
            .unwrap()
            > 0.0
    );
    let f = Fixture::new();
    let mut agent = f.agent();
    let session = start(
        &f,
        &mut agent,
        "plan",
        json!({"provider":{"pricing":{"inputUsdPerMillion":10.0,"outputUsdPerMillion":10.0}},"limits":{"maxCostUsd":0.000001}}),
    );
    agent.turn(&session, "too-expensive", "Reject before dispatch");
    let end = agent.completed("too-expensive", "failed");
    assert_eq!(end["params"]["errorDetails"]["code"], "budget_exceeded");
    f.api.assert_quiet();
}
#[test]
fn turn_deadline_cancels_the_inflight_provider_and_returns_a_budget_failure() {
    let f = Fixture::new();
    let mut agent = f.agent();
    let session = start(&f, &mut agent, "plan", json!({"limits":{"maxTurnMs":1000}}));
    agent.turn(&session, "deadline", "Bound this wait");
    let request = f.api.chat();
    let end = agent.completed("deadline", "failed");
    assert_eq!(end["params"]["errorDetails"]["code"], "budget_exceeded");
    assert_ne!(end["params"]["status"], "interrupted");
    drop(request);
    f.api.assert_quiet();
}
#[test]
fn mcp_interruption_stops_the_connection_and_requires_review_without_replay() {
    let f = Fixture::new();
    let mut agent = f.agent();
    let session = start(
        &f,
        &mut agent,
        "full",
        json!({"mcpServers":[{"name":"fixture","command":mcp_binary()}]}),
    );
    agent.turn(&session, "mcp-cancel", "Exercise cancellation");
    let request = f.api.chat();
    let name = request.body["tools"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| {
            v["function"]["name"]
                .as_str()
                .unwrap()
                .contains("stall_fixture")
        })
        .unwrap()["function"]["name"]
        .as_str()
        .unwrap()
        .to_owned();
    request.completion(calls(vec![tool("stall", &name, json!({}))]), "tool_calls");
    let marker = f.workspace.path().join("mcp-stall.marker");
    let deadline = Instant::now() + TIMEOUT;
    while !marker.exists() {
        assert!(Instant::now() < deadline, "MCP did not receive call");
        thread::sleep(Duration::from_millis(10));
    }
    agent.rpc(
        "turn/interrupt",
        json!({"sessionId":session,"messageId":"mcp-cancel"}),
    );
    agent.completed("mcp-cancel", "interrupted");
    assert_eq!(
        agent.rpc("session/history", json!({"sessionId":session}))["recoveryRequired"],
        true
    );
    f.api.assert_quiet();
}
#[test]
fn evaluation_runs_actual_provider_tools_in_a_disposable_workspace_and_reports_assertions() {
    let f = Fixture::new();
    let suite = f.workspace.path().join("suite.json");
    fs::write(&suite,json!({"version":1,"cases":[{"id":"edit","prompt":"Replace OLD in note.txt with NEW, then say VERIFIED","files":{"note.txt":"OLD\n"},"expectedFiles":{"note.txt":"NEW\n"},"expectedTextContains":["VERIFIED"]}]}).to_string()).unwrap();
    let child = command(f.home.path())
        .args([
            "--profile",
            "TREX1",
            "eval",
            "--suite",
            suite.to_str().unwrap(),
            "--mode",
            "full",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    f.api
        .request("GET", "/v1/models")
        .json(json!({"data":[{"id":"mock","context_length":32768}]}));
    f.api.chat().completion(
        calls(vec![tool(
            "edit",
            "edit_file",
            json!({"path":"note.txt","oldText":"OLD","newText":"NEW"}),
        )]),
        "tool_calls",
    );
    let next = f.api.chat();
    assert_eq!(tool_output(&next, "edit")["isError"], Value::Null);
    next.final_text("VERIFIED");
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["passed"], true);
    assert_eq!(report["cases"][0]["checks"].as_array().unwrap().len(), 2);
    assert!(!f.workspace.path().join("note.txt").exists());
    f.api.assert_quiet();
}
#[test]
fn git_diff_respects_private_file_policy_including_tracked_environment_files() {
    let f = Fixture::new();
    for args in [
        vec!["init"],
        vec!["config", "user.email", "fixture@example.invalid"],
        vec!["config", "user.name", "Fixture"],
    ] {
        assert!(Command::new("git")
            .args(args)
            .current_dir(f.workspace.path())
            .output()
            .unwrap()
            .status
            .success());
    }
    fs::write(f.workspace.path().join(".env"), "PRIVATE_FIXTURE=OLD\n").unwrap();
    fs::write(f.workspace.path().join("visible.txt"), "OLD\n").unwrap();
    assert!(Command::new("git")
        .args(["add", "."])
        .current_dir(f.workspace.path())
        .output()
        .unwrap()
        .status
        .success());
    fs::write(
        f.workspace.path().join(".env"),
        "PRIVATE_FIXTURE=SHOULD_NOT_BE_SENT\n",
    )
    .unwrap();
    fs::write(f.workspace.path().join("visible.txt"), "NEW\n").unwrap();
    let mut agent = f.agent();
    let session = start(&f, &mut agent, "plan", json!({}));
    agent.turn(&session, "git-privacy", "Review differences");
    f.api.chat().completion(
        calls(vec![tool("diff", "git_diff", json!({}))]),
        "tool_calls",
    );
    let next = f.api.chat();
    let output = tool_output(&next, "diff").to_string();
    assert!(output.contains("NEW"));
    assert!(!output.contains("PRIVATE_FIXTURE"));
    assert!(!next.body.to_string().contains("SHOULD_NOT_BE_SENT"));
    next.final_text("Private file excluded");
    agent.completed("git-privacy", "completed");
}

#[test]
fn oversized_completed_tool_batch_is_compacted_without_losing_original_history_or_tasks() {
    let f = Fixture::new();
    fs::write(
        f.workspace.path().join("large.txt"),
        "ARCHIVED_LINE\n".repeat(10000),
    )
    .unwrap();
    let mut agent = f.agent();
    let session = start(
        &f,
        &mut agent,
        "plan",
        json!({"provider":{"maxOutputTokens":100},"context":{"fallbackWindow":14000,"summaryMaxChars":1024,"reserveTokens":128}}),
    );
    agent.turn(&session, "long-task", "Read large.txt and keep task state");
    f.api.chat().completion(
        calls(vec![
            tool(
                "plan",
                "update_plan",
                json!({"plan":[{"step":"Read large.txt","status":"in_progress"}]}),
            ),
            tool(
                "large",
                "read_file",
                json!({"path":"large.txt","limit":2000}),
            ),
        ]),
        "tool_calls",
    );
    let next = f.api.chat();
    assert!(messages(&next).iter().any(|m| m["content"]
        .as_str()
        .is_some_and(|s| s.contains("Earlier conversation reference"))));
    assert!(!messages(&next).iter().any(|m| m["role"] == "tool"));
    next.completion(
        calls(vec![tool("task", "task_state", json!({}))]),
        "tool_calls",
    );
    let final_request = f.api.chat();
    assert_eq!(
        tool_output(&final_request, "task")["plan"][0]["step"],
        "Read large.txt"
    );
    final_request.final_text("Kept tasks and history");
    agent.completed("long-task", "completed");
    let journal = f.journal(&session);
    assert!(!journal["compactions"].as_array().unwrap().is_empty());
    assert!(
        journal["messages"]
            .to_string()
            .matches("ARCHIVED_LINE")
            .count()
            >= 2000
    );
}

#[test]
fn old_tool_results_are_archived_at_turn_boundaries_and_stay_searchable() {
    let f = Fixture::new();
    let body = format!("ARCHIVE_ME_HEAD\n{}", "padding line\n".repeat(400));
    fs::write(f.workspace.path().join("big.txt"), &body).unwrap();
    let mut agent = f.agent();
    let session = start(&f, &mut agent, "plan", json!({}));
    agent.turn(&session, "one", "Read big.txt");
    f.api.chat().completion(
        calls(vec![tool("read", "read_file", json!({"path":"big.txt","limit":2000}))]),
        "tool_calls",
    );
    let next = f.api.chat();
    assert!(tool_output(&next, "read")["content"].as_str().unwrap().starts_with("ARCHIVE_ME_HEAD"));
    next.final_text("Read it");
    agent.completed("one", "completed");
    // The previous turn's results stay verbatim.
    agent.turn(&session, "two", "Anything else?");
    let second = f.api.chat();
    assert!(tool_output(&second, "read")["content"].is_string());
    second.final_text("No");
    agent.completed("two", "completed");
    // Two user turns later the large result is a short placeholder, and it
    // stays identical for every request of this turn's tool loop.
    agent.turn(&session, "three", "Recall the first line of big.txt");
    let third = f.api.chat();
    let archived = |request: &HttpRequest| {
        messages(request)
            .iter()
            .find(|m| m["role"] == "tool" && m["tool_call_id"] == "read")
            .unwrap()["content"]
            .as_str()
            .unwrap()
            .to_owned()
    };
    let placeholder = archived(&third);
    assert!(placeholder.starts_with("[Archived read_file result ("), "{placeholder}");
    assert!(placeholder.contains("history_search {\"messageIndex\":2}"));
    assert!(placeholder.len() < 600);
    third.completion(
        calls(vec![tool("recall", "history_search", json!({"messageIndex":2}))]),
        "tool_calls",
    );
    let fourth = f.api.chat();
    assert_eq!(archived(&fourth), placeholder);
    assert!(tool_output(&fourth, "recall")["text"]
        .as_str()
        .unwrap()
        .contains("ARCHIVE_ME_HEAD"));
    fourth.final_text("The first line is ARCHIVE_ME_HEAD");
    agent.completed("three", "completed");
    // Only the provider projection changed: the journal keeps the result.
    let journal = f.journal(&session);
    assert!(journal["messages"][2]["content"]
        .as_str()
        .unwrap()
        .contains("ARCHIVE_ME_HEAD"));
}

#[test]
fn absolute_active_token_cap_compacts_even_without_a_known_window() {
    let f = Fixture::new();
    let mut agent = f.agent();
    let session = start(
        &f,
        &mut agent,
        "plan",
        json!({"context":{"fallbackWindow":null,"maxActiveTokens":4096,"keepRecentTurns":1}}),
    );
    for (id, text) in [("first", "ORIGINAL_REQUEST_MARKER explain"), ("second", "continue")] {
        agent.turn(&session, id, text);
        let request = f.api.chat();
        if id == "second" {
            assert!(messages(&request).iter().any(|m| m["content"]
                .as_str()
                .is_some_and(|s| s.contains("Earlier conversation reference")
                    && s.contains("ORIGINAL_REQUEST_MARKER"))));
            assert!(!messages(&request)
                .iter()
                .any(|m| m["content"] == "ORIGINAL_REQUEST_MARKER explain"));
        }
        request.final_text(&"answer ".repeat(1000));
        agent.completed(id, "completed");
    }
    let journal = f.journal(&session);
    assert_eq!(journal["compactions"].as_array().unwrap().len(), 1);
    assert_eq!(journal["messages"][0]["content"], "ORIGINAL_REQUEST_MARKER explain");
}

#[test]
fn turn_token_budget_counts_uncached_input_and_output() {
    let f = Fixture::new();
    let mut agent = f.agent();
    let session = start(
        &f,
        &mut agent,
        "plan",
        json!({"limits":{"maxTurnTokens":12000},"provider":{"maxOutputTokens":100}}),
    );
    agent.turn(&session, "cached", "Plan with a warm prompt cache");
    // 20,010 total tokens, but 19,990 were prompt-cache hits: 20 new tokens.
    f.api.chat().json(json!({"choices":[{"index":0,"message":calls(vec![tool(
        "plan",
        "update_plan",
        json!({"plan":[{"step":"Inspect","status":"in_progress"}]}),
    )]),"finish_reason":"tool_calls"}],
        "usage":{"prompt_tokens":20000,"completion_tokens":10,"prompt_tokens_details":{"cached_tokens":19990}}}));
    let next = f.api.chat();
    next.final_text("Planned");
    let end = agent.completed("cached", "completed");
    assert_eq!(end["params"]["usage"]["apiUsage"]["cachedReadTokens"], 19990);
    assert_eq!(end["params"]["usage"]["apiUsage"]["totalTokens"], 20024);
}
