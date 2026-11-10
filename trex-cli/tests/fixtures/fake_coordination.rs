//! Standalone stand-in for the app's coordination-only MCP server
//! (`trex --trex-inbox-mcp … --peers-only`). No network or GUI. Each tools/call
//! is appended to coordination-calls.jsonl in the working directory.
use std::io::{BufRead, Write};
fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.get(3).map(String::as_str) != Some("--peers-only") {
        std::process::exit(2);
    }
    let tool = |name: &str, description: &str| format!(r#"{{"name":"{name}","description":"{description}","inputSchema":{{"type":"object","properties":{{"to":{{"type":"string"}},"text":{{"type":"string"}}}},"additionalProperties":false}},"annotations":{{"readOnlyHint":false}}}}"#);
    for line in std::io::stdin().lock().lines() {
        let line = line.unwrap();
        let Some(tail) = line.split("\"id\":").nth(1) else { continue };
        let id: String = tail.chars().take_while(|c| c.is_ascii_digit()).collect();
        if id.is_empty() {
            continue;
        }
        let result = if line.contains("\"method\":\"initialize\"") {
            r#"{"protocolVersion":"2025-11-25","capabilities":{"tools":{}},"serverInfo":{"name":"trex_inbox","version":"1"},"instructions":"Other Trex sessions may work in this project at the same time: check trex_peers."}"#.to_owned()
        } else if line.contains("\"method\":\"tools/list\"") {
            format!(r#"{{"tools":[{},{},{},{}]}}"#,
                tool("trex_peers", "Other sessions in this project."), tool("trex_claim", "Reserve files."),
                tool("trex_release", "Release reservations."), tool("trex_message", "Talk with another session."))
        } else if line.contains("\"method\":\"tools/call\"") {
            let mut calls = std::fs::OpenOptions::new().create(true).append(true).open("coordination-calls.jsonl").unwrap();
            writeln!(calls, "{line}").unwrap();
            r#"{"content":[{"type":"text","text":"Message sent to Codex. Do not wait for the answer."}],"isError":false}"#.to_owned()
        } else {
            "{}".to_owned()
        };
        println!("{{\"jsonrpc\":\"2.0\",\"id\":{id},\"result\":{result}}}");
        std::io::stdout().flush().unwrap();
    }
}
