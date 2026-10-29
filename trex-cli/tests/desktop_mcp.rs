//! Process-level MCP contract. Tests use a private Xvfb display when explicitly enabled.
use serde_json::{json, Value};
use std::{
    io::{BufRead, BufReader, Write},
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
};

#[cfg(target_os = "linux")]
#[test]
fn wayland_diagnostic_rejects_an_unavailable_portal_without_touching_x11() {
    let workspace = tempfile::tempdir().unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_trex-agent"))
        .args(["desktop-doctor", "--json"])
        .env("WAYLAND_DISPLAY", "trex-isolated-missing-display")
        .env(
            "DBUS_SESSION_BUS_ADDRESS",
            format!(
                "unix:path={}",
                workspace.path().join("missing-bus").display()
            ),
        )
        .env("DISPLAY", ":65530")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let value: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(value["backend"], "waylandPortal");
    assert_eq!(value["available"], false);
    assert_eq!(value["portalVerified"], false);
    assert_eq!(value["inputGranted"], false);
}
struct Server {
    child: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
}
impl Server {
    fn start(mode: &str) -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_trex-agent"))
            .args(["desktop-mcp", "--mode", mode])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let input = child.stdin.take().unwrap();
        let output = BufReader::new(child.stdout.take().unwrap());
        Self {
            child,
            input,
            output,
        }
    }
    fn call(&mut self, id: u32, method: &str, params: Value) -> Value {
        writeln!(
            self.input,
            "{}",
            json!({"jsonrpc":"2.0","id":id,"method":method,"params":params})
        )
        .unwrap();
        self.input.flush().unwrap();
        let mut line = String::new();
        self.output.read_line(&mut line).unwrap();
        serde_json::from_str(&line).unwrap()
    }
    fn notify(&mut self, method: &str, params: Value) {
        writeln!(
            self.input,
            "{}",
            json!({"jsonrpc":"2.0","method":method,"params":params})
        )
        .unwrap();
        self.input.flush().unwrap();
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
#[test]
fn planning_is_fixed_and_requests_are_deduplicated() {
    let mut server = Server::start("plan");
    let init=server.call(1,"initialize",json!({"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"test","version":"1"}}));
    assert_eq!(init["result"]["serverInfo"]["name"], "trex-desktop");
    let guidance = init["result"]["instructions"].as_str().unwrap();
    assert!(
        guidance.contains("desktop_status")
            && guidance.contains("desktop_monitors")
            && guidance.contains("read-only")
            && guidance.contains("trex_browser")
    );
    let listing = server.call(2, "tools/list", json!({}));
    let tools = listing["result"]["tools"].as_array().unwrap();
    assert_eq!(tools.len(), 4);
    assert!(tools.iter().any(|t| t["name"] == "desktop_screenshot"));
    assert!(tools
        .iter()
        .all(|t| t["annotations"]["readOnlyHint"] == true));
    let params = json!({"name":"desktop_click","arguments":{"observation":"invalid","x":0,"y":0}});
    let first = server.call(3, "tools/call", params.clone());
    assert_eq!(first["result"]["isError"], true);
    assert_eq!(server.call(3, "tools/call", params), first);
    assert_eq!(
        server.call(3, "tools/call", json!({"name":"desktop_screenshot"}))["error"]["code"],
        -32600
    );
}

#[test]
fn cancellation_and_ping_are_processed_during_a_running_operation() {
    let mut server = Server::start("full");
    let wait = json!({"name":"desktop_wait","arguments":{"milliseconds":10000}});
    writeln!(
        server.input,
        "{}",
        json!({"jsonrpc":"2.0","id":100,"method":"tools/call","params":wait})
    )
    .unwrap();
    server.input.flush().unwrap();
    let started = std::time::Instant::now();
    assert_eq!(server.call(101, "ping", json!({}))["id"], 101);
    let busy=server.call(102,"tools/call",json!({"name":"desktop_type","arguments":{"observation":"missing","text":"must never type"}}));
    assert_eq!(busy["error"]["code"], -32001);
    server.notify("notifications/cancelled", json!({"requestId":100}));
    let mut line = String::new();
    server.output.read_line(&mut line).unwrap();
    let canceled: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(canceled["id"], 100);
    assert_eq!(
        canceled["result"]["structuredContent"]["error"]["code"],
        "CANCELLED"
    );
    assert_eq!(
        canceled["result"]["structuredContent"]["manualReview"],
        false
    );
    assert!(started.elapsed() < std::time::Duration::from_secs(2));
    assert_eq!(server.call(100, "tools/call", wait), canceled);
    assert_eq!(
        server.call(
            103,
            "tools/call",
            json!({"name":"desktop_wait","arguments":{"milliseconds":0}})
        )["result"]["isError"],
        false
    );
}

#[test]
fn eof_cancels_pending_work_and_exits_without_waiting_for_the_tool() {
    let mut child = Command::new(env!("CARGO_BIN_EXE_trex-agent"))
        .args(["desktop-mcp", "--mode", "plan"])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut input = child.stdin.take().unwrap();
    writeln!(input,"{}",json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"desktop_wait","arguments":{"milliseconds":10000}}})).unwrap();
    drop(input);
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
    loop {
        if let Some(status) = child.try_wait().unwrap() {
            assert!(status.success());
            break;
        }
        if std::time::Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            panic!("MCP retained work after owner EOF");
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
}

#[test]
fn invalid_frames_and_waits_do_not_break_the_session() {
    let mut server = Server::start("plan");
    writeln!(server.input, "{}", "x".repeat(65537)).unwrap();
    server.input.flush().unwrap();
    let mut line = String::new();
    server.output.read_line(&mut line).unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&line).unwrap()["error"]["code"],
        -32700
    );
    assert_eq!(
        server.call(
            1,
            "tools/call",
            json!({"name":"desktop_wait","arguments":{"milliseconds":10001}})
        )["result"]["isError"],
        true
    );
    assert_eq!(
        server.call(
            2,
            "tools/call",
            json!({"name":"desktop_move","arguments":{}})
        )["result"]["isError"],
        true
    );
    assert_eq!(server.call(3, "ping", json!({}))["result"], json!({}));
}

#[test]
fn desktop_doctor_is_available_without_a_profile_or_capture() {
    let output = Command::new(env!("CARGO_BIN_EXE_trex-agent"))
        .args(["desktop-doctor", "--json"])
        .output()
        .unwrap();
    assert!(output.status.success());
    let status: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert!(status["available"].is_boolean());
    assert!(status["monitors"].is_array());
    assert_eq!(status["coordinateSpace"], "physicalPixels");
    assert!(status.get("content").is_none());
}
#[test]
#[ignore = "requires a dedicated virtual X11 display"]
fn isolated_x11_screenshot_and_click_are_safe_to_replay() {
    assert_eq!(
        std::env::var("TREX_DESKTOP_TEST").ok().as_deref(),
        Some("isolated-xvfb")
    );
    let mut server = Server::start("full");
    let screenshot = server.call(
        10,
        "tools/call",
        json!({"name":"desktop_screenshot","arguments":{}}),
    );
    assert_eq!(screenshot["result"]["content"][1]["type"], "image");
    let token = screenshot["result"]["structuredContent"]["observation"]
        .as_str()
        .unwrap();
    let params = json!({"name":"desktop_click","arguments":{"observation":token,"x":20,"y":30}});
    let first = server.call(11, "tools/call", params.clone());
    assert_eq!(first["result"]["isError"], false);
    assert_eq!(server.call(11, "tools/call", params), first);
    assert_eq!(
        server.call(
            10,
            "tools/call",
            json!({"name":"desktop_screenshot","arguments":{}})
        )["result"]["isError"],
        true
    );
    let stale = server.call(
        12,
        "tools/call",
        json!({"name":"desktop_click","arguments":{"observation":token,"x":20,"y":30}}),
    );
    assert_eq!(stale["result"]["isError"], true);
}
