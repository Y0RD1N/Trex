use super::*;

fn launch(f: &Fixture, name: &str) -> String {
    if cfg!(windows) {
        fs::write(f.workspace.path().join(format!("{name}.ps1")), format!("for ($i=0; $i -lt 500; $i++) {{ [IO.File]::AppendAllText((Join-Path (Get-Location) '{name}.marker'), '.'); Write-Output '{name}-alive'; Start-Sleep -Milliseconds 80 }}")).unwrap();
        format!("& powershell.exe -NoProfile -NonInteractive -File .\\{name}.ps1")
    } else {
        fs::write(f.workspace.path().join(format!("{name}.sh")), format!("i=0; while [ \"$i\" -lt 500 ]; do i=$((i+1)); printf . >> {name}.marker; printf '{name}-alive\\n'; sleep 0.08; done")).unwrap();
        format!("/bin/sh ./{name}.sh")
    }
}
fn wait_marker(path: &Path) -> u64 {
    let start = Instant::now();
    loop {
        if let Ok(meta) = fs::metadata(path) {
            if meta.len() > 0 {
                return meta.len();
            }
        }
        assert!(
            start.elapsed() < TIMEOUT,
            "background terminal did not start"
        );
        thread::sleep(Duration::from_millis(30));
    }
}
fn start_two(f: &Fixture, agent: &mut Agent) -> (String, Vec<Value>) {
    let session = agent.start(f.workspace.path(), "full", None)["sessionId"]
        .as_str()
        .unwrap()
        .to_owned();
    let first = launch(f, "first");
    let second = launch(f, "second");
    agent.turn(
        &session,
        "start-servers",
        "Keep two servers in the background.",
    );
    f.api.chat().completion(
        calls(vec![
            tool(
                "start-first",
                "shell",
                json!({"command":first,"background":true}),
            ),
            tool(
                "start-second",
                "shell",
                json!({"command":second,"background":true}),
            ),
        ]),
        "tool_calls",
    );
    f.api
        .chat()
        .final_text("Both terminals stay available between turns.");
    agent.completed("start-servers", "completed");
    let rows = agent.rpc("process/list", json!({"sessionId":session}))["processes"]
        .as_array()
        .unwrap()
        .clone();
    assert_eq!(rows.len(), 2);
    assert!(rows.iter().all(|row| row["status"] == "running"));
    wait_marker(&f.workspace.path().join("first.marker"));
    wait_marker(&f.workspace.path().join("second.marker"));
    (session, rows)
}

#[test]
fn background_terminals_survive_turn_completion_stop_one_tree_and_preserve_peer_and_chat() {
    let f = Fixture::new();
    let mut agent = f.agent();
    let (session, rows) = start_two(&f, &mut agent);
    let first = rows
        .iter()
        .find(|row| row["command"].as_str().unwrap().contains("first"))
        .unwrap()["id"]
        .as_str()
        .unwrap();
    let second = rows
        .iter()
        .find(|row| row["command"].as_str().unwrap().contains("second"))
        .unwrap()["id"]
        .as_str()
        .unwrap();
    let deadline = Instant::now() + TIMEOUT;
    loop {
        let output = agent.rpc(
            "process/read",
            json!({"sessionId":session,"processId":first}),
        );
        if output["text"].as_str().unwrap().contains("first-alive") {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "background output did not reach the live buffer"
        );
        thread::sleep(Duration::from_millis(40));
    }
    let foreign = agent.request(
        "process/stop",
        json!({"sessionId":session,"processId":"unowned-os-pid"}),
    );
    assert!(agent.response(foreign).get("error").is_some());
    assert_eq!(
        agent.rpc(
            "process/stop",
            json!({"sessionId":session,"processId":first})
        )["terminated"],
        true
    );
    let stopped = fs::metadata(f.workspace.path().join("first.marker"))
        .unwrap()
        .len();
    let peer = fs::metadata(f.workspace.path().join("second.marker"))
        .unwrap()
        .len();
    thread::sleep(Duration::from_millis(350));
    assert_eq!(
        fs::metadata(f.workspace.path().join("first.marker"))
            .unwrap()
            .len(),
        stopped
    );
    assert!(
        fs::metadata(f.workspace.path().join("second.marker"))
            .unwrap()
            .len()
            > peer
    );
    let foreign_session = agent.start(f.workspace.path(), "full", None)["sessionId"]
        .as_str()
        .unwrap()
        .to_owned();
    let attempt = agent.request(
        "process/stop",
        json!({"sessionId":foreign_session,"processId":second}),
    );
    assert!(agent.response(attempt).get("error").is_some());
    // The original chat remains usable, and stopping a terminal did not issue a model request.
    f.api.assert_quiet();
    agent.turn(&session, "still-chatting", "Continue reviewing.");
    f.api.chat().final_text("The chat remains available.");
    agent.completed("still-chatting", "completed");
    agent.rpc(
        "process/stop",
        json!({"sessionId":session,"processId":second}),
    );
    agent.turn(
        &session,
        "start-servers",
        "Keep two servers in the background.",
    );
    agent.completed("start-servers", "completed");
    assert!(
        agent.rpc("process/list", json!({"sessionId":session}))["processes"]
            .as_array()
            .unwrap()
            .iter()
            .all(|row| row["status"] == "stopped")
    );
    f.api.assert_quiet();
}

#[test]
fn stdin_eof_closes_background_descendants_and_restore_does_not_restart_them() {
    let f = Fixture::new();
    let mut agent = f.agent();
    let (session, _) = start_two(&f, &mut agent);
    agent.stdin.take();
    let start = Instant::now();
    while agent.child.try_wait().unwrap().is_none() {
        assert!(
            start.elapsed() < TIMEOUT,
            "EOF did not finish background cleanup"
        );
        thread::sleep(Duration::from_millis(30));
    }
    let before = fs::metadata(f.workspace.path().join("first.marker"))
        .unwrap()
        .len();
    thread::sleep(Duration::from_millis(250));
    assert_eq!(
        fs::metadata(f.workspace.path().join("first.marker"))
            .unwrap()
            .len(),
        before
    );
    drop(agent);
    let mut restored = f.agent();
    restored.start(f.workspace.path(), "full", Some(&session));
    assert_eq!(
        restored.rpc("process/list", json!({"sessionId":session}))["processes"],
        json!([])
    );
    f.api.assert_quiet();
}
