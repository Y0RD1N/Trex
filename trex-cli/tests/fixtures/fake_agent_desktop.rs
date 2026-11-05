//! Standalone, dependency-free stand-in for `agent-desktop mcp`. No network or GUI.
//! It publishes a few upstream tools (including ones the Trex gateway must hide),
//! echoes each call and records the private state folder it was given.
use std::io::{BufRead, Write};
fn main() {
    assert_eq!(std::env::args().nth(1).as_deref(), Some("mcp"), "the gateway must start the MCP server");
    assert!(!std::env::args().any(|arg| arg == "--headed"), "physical input must never be enabled");
    for line in std::io::stdin().lock().lines() {
        let line = line.unwrap();
        let Some(tail) = line.split("\"id\":").nth(1) else { continue };
        let id: String = tail.chars().take_while(|c| c.is_ascii_digit()).collect();
        if id.is_empty() {
            continue;
        }
        let result = if line.contains("\"method\":\"initialize\"") {
            r#"{"protocolVersion":"2025-06-18","capabilities":{"tools":{}},"serverInfo":{"name":"agent-desktop","version":"1.2.0"},"instructions":"upstream instructions"}"#.to_owned()
        } else if line.contains("\"method\":\"tools/list\"") {
            r#"{"tools":[{"name":"desktop_snapshot","description":"Capture accessibility tree","inputSchema":{"type":"object","properties":{"app":{"type":"string"},"interactive_only":{"type":"boolean"},"compact":{"type":"boolean"}}},"outputSchema":{"type":"object"}},{"name":"desktop_click","description":"Click element","inputSchema":{"type":"object","properties":{"ref_id":{"type":"string"},"timeout_ms":{"type":"integer"}}}},{"name":"desktop_mouse_click","description":"Physical click","inputSchema":{"type":"object","properties":{}}},{"name":"desktop_session_end","description":"End session","inputSchema":{"type":"object","properties":{}}}]}"#.to_owned()
        } else {
            let home = std::env::var("AGENT_DESKTOP_HOME").unwrap_or_default();
            std::fs::write("agent-desktop-home.marker", &home).unwrap();
            format!(
                "{{\"_meta\":{{}},\"content\":[{{\"type\":\"text\",\"text\":{:?}}}],\"structuredContent\":{{\"echo\":true}},\"isError\":false}}",
                format!("upstream call {line}")
            )
        };
        println!("{{\"jsonrpc\":\"2.0\",\"id\":{id},\"result\":{result}}}");
        std::io::stdout().flush().unwrap();
    }
}
