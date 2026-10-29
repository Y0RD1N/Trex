//! Standalone, dependency-free MCP fixture. No network or GUI.
use std::io::{BufRead,Write};
fn main(){
    for line in std::io::stdin().lock().lines(){
        let line=line.unwrap();
        let Some(tail)=line.split("\"id\":").nth(1) else{continue;};
        let id:String=tail.chars().take_while(|c|c.is_ascii_digit()).collect();if id.is_empty(){continue;}
        let result=if line.contains("\"method\":\"initialize\""){r#"{"protocolVersion":"2025-11-25","capabilities":{"tools":{}},"serverInfo":{"name":"fixture","version":"1"}}"#.to_owned()}
        else if line.contains("\"method\":\"tools/list\""){r#"{"tools":[{"name":"read_fixture","description":"Read local fixture data","inputSchema":{"type":"object","properties":{},"additionalProperties":false},"annotations":{"readOnlyHint":true}},{"name":"write_fixture","description":"Write an owned marker","inputSchema":{"type":"object","properties":{},"additionalProperties":false}},{"name":"stall_fixture","description":"Wait for cancellation","inputSchema":{"type":"object","properties":{},"additionalProperties":false}}]}"#.to_owned()}
        else if line.contains("\"name\":\"stall_fixture\""){std::fs::write("mcp-stall.marker","received").unwrap();std::thread::sleep(std::time::Duration::from_secs(30));r#"{"content":[{"type":"text","text":"finished"}]}"#.into()}
        else if line.contains("\"name\":\"write_fixture\""){std::fs::write("mcp-write.marker","owned fixture").unwrap();r#"{"content":[{"type":"text","text":"written"}]}"#.into()}
        else{let secret=std::env::var("TREX_FAKE_MCP_SECRET").unwrap_or_else(|_|"not forwarded".into());format!("{{\"content\":[{{\"type\":\"text\",\"text\":{:?}}}]}}",format!("fixture data {secret}"))};
        println!("{{\"jsonrpc\":\"2.0\",\"id\":{id},\"result\":{result}}}");std::io::stdout().flush().unwrap();
    }
}
