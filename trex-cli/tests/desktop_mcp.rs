//! Process-level MCP contract. Tests use a private Xvfb display when explicitly enabled.
use serde_json::{json, Value};
use std::{
    io::{BufRead, BufReader, Write},
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
};
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
    let listing = server.call(2, "tools/list", json!({}));
    let tools = listing["result"]["tools"].as_array().unwrap();
    assert_eq!(tools.len(), 1);
    assert_eq!(tools[0]["name"], "desktop_screenshot");
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
