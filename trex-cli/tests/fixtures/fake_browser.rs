//! Standalone, std-only browser CLI double. Compiled with rustc by browser_cases.
//! Image bytes are emitted only on the broker stdout, never in fixture logs.
use std::{
    env, fs,
    fs::OpenOptions,
    io::{self, Read, Write},
    path::{Path, PathBuf},
    thread,
    time::{Duration, Instant},
};

const PNG: &str =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=";

// Only extracts JSON strings written by serde_json in the parent test. This is
// deliberately not a second JSON implementation or a broker protocol library.
fn string_field(input: &str, field: &str) -> Option<String> {
    let needle = format!("\"{field}\"");
    let (_, tail) = input.split_once(&needle)?;
    let tail = tail.trim_start().strip_prefix(':')?.trim_start();
    let mut chars = tail.strip_prefix('"')?.chars();
    let mut result = String::new();
    while let Some(ch) = chars.next() {
        match ch {
            '"' => return Some(result),
            '\\' => result.push(match chars.next()? {
                'n' => '\n',
                'r' => '\r',
                't' => '\t',
                '"' => '"',
                '\\' => '\\',
                '/' => '/',
                _ => return None,
            }),
            ch => result.push(ch),
        }
    }
    None
}

fn append(path: &Path, line: &str) {
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .unwrap();
    writeln!(file, "{line}").unwrap();
    file.sync_all().unwrap();
}

fn definitions() -> String {
    // Advertise extra capabilities even in observe: the CLI must independently
    // narrow the broker's response against its own frozen protocol allowlist.
    let names = [
        "browser_take_screenshot",
        "browser_snapshot",
        "browser_click",
        "browser_evaluate",
        "browser_tabs",
        "browser_artifact",
        "browser_console_messages",
        "browser_network_requests",
        "browser_mouse",
        "browser_navigate",
        "browser_wait_for",
        "browser_cancel",
        "browser_injected_escape",
    ];
    let tools = names.iter().map(|name| format!(
        "{{\"name\":\"{name}\",\"description\":\"Offline fixture {name}\",\"inputSchema\":{{\"type\":\"object\",\"properties\":{{}}}}}}"
    )).collect::<Vec<_>>().join(",");
    format!("{{\"tools\":[{tools}]}}")
}

fn snapshot_intent(workspace: &Path, operation: &str) {
    let Some(home) = env::var_os("TREX_HOME") else {
        return;
    };
    let Ok(entries) = fs::read_dir(PathBuf::from(home).join("conversations")) else {
        return;
    };
    for entry in entries.flatten() {
        if entry.path().extension().is_none_or(|ext| ext != "json") {
            continue;
        }
        let Ok(journal) = fs::read_to_string(entry.path()) else {
            continue;
        };
        if journal.contains(operation) {
            assert!(operation
                .bytes()
                .all(|ch| ch.is_ascii_alphanumeric() || ch == b'-'));
            fs::write(
                workspace.join(format!("browser-dispatch-{operation}.json")),
                journal,
            )
            .unwrap();
            return;
        }
    }
}

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    let bin = env::current_exe().unwrap().parent().unwrap().to_owned();
    if args.first().is_some_and(|arg| arg != "call") {
        append(&bin.join("browser-probes.log"), &args.join(" "));
    }
    match args.first().map(String::as_str) {
        Some("--version") => println!("trex-browser 0.1.0-offline-fixture"),
        Some("doctor") => println!("{{\"protocolVersion\":\"2025-11-25\",\"capabilities\":{{\"tools\":true,\"cancellation\":true}},\"tools\":[]}}"),
        Some("tools") => println!("{}", definitions()),
        Some("call") => {
            assert_eq!(args.get(1).map(String::as_str), Some("--stdin-json"));
            let mut request = String::new();
            io::stdin().read_to_string(&mut request).unwrap();
            let workspace = PathBuf::from(string_field(&request, "cwd").unwrap());
            let name = string_field(&request, "name").unwrap();
            let operation = string_field(&request, "operationId").unwrap();
            if name == "browser_cancel" {
                append(&workspace.join("browser-requests.jsonl"), &request);
                fs::write(workspace.join("browser-cancelled"), b"cancel received").unwrap();
                println!("{{\"content\":[{{\"type\":\"text\",\"text\":\"Cancelled matching operation\"}}]}}");
                return;
            }
            snapshot_intent(&workspace, &operation);
            // Publish the request only after the dispatch snapshot is complete.
            // These requests contain arguments and identities, never responses.
            append(&workspace.join("browser-requests.jsonl"), &request);
            if workspace.join("browser-block").exists() {
                let deadline = Instant::now() + Duration::from_secs(30);
                while !workspace.join("browser-cancelled").exists() && Instant::now() < deadline {
                    thread::sleep(Duration::from_millis(10));
                }
            }
            let behavior = fs::read_to_string(workspace.join("browser-behavior")).unwrap_or_default();
            match behavior.trim() {
                "exit" => std::process::exit(23),
                "malformed" => { println!("not JSON"); return; }
                "missing-content" => { println!("{{\"structuredContent\":{{}}}}"); return; }
                "content-not-array" => { println!("{{\"content\":{{}}}}"); return; }
                "invalid-is-error" => { println!("{{\"content\":[],\"isError\":\"false\"}}"); return; }
                "invalid-structured" => { println!("{{\"content\":[],\"structuredContent\":[]}}"); return; }
                "mixed-content" => {
                    println!("{{\"content\":[{{\"type\":\"image\",\"mimeType\":\"image/png\",\"data\":\"{PNG}\"}},{{}}]}}");
                    return;
                }
                "uncertain" | "cancelled" | "manual-review" => {
                    let status = if behavior.trim() == "manual-review" { "completed" } else { behavior.trim() };
                    println!("{{\"content\":[{{\"type\":\"text\",\"text\":\"Receipt requires inspection\"}}],\"structuredContent\":{{\"receipt\":{{\"status\":\"{status}\",\"manualReview\":{}}}}}}}", behavior.trim() == "manual-review");
                    return;
                }
                "tool-error" => {
                    println!("{{\"content\":[{{\"type\":\"text\",\"text\":\"Page operation rejected\"}}],\"isError\":true,\"structuredContent\":{{\"receipt\":{{\"status\":\"rejected\",\"manualReview\":false}}}}}}");
                    return;
                }
                _ => ()
            }
            // A private diagnostic must not escape the production adapter.
            eprintln!("fake-browser-private-diagnostic");
            if name == "browser_take_screenshot" {
                if let Ok(payload) = fs::read_to_string(workspace.join("browser-image-result")) {
                    let (mime, data) = payload.split_once('\n').unwrap();
                    assert_eq!(mime, "image/jpeg");
                    assert!(data.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"+/=".contains(&byte)));
                    println!("{{\"content\":[{{\"type\":\"text\",\"text\":\"Offline JPEG evidence\"}},{{\"type\":\"image\",\"mimeType\":\"image/jpeg\",\"data\":\"{data}\"}}],\"structuredContent\":{{\"receipt\":{{\"status\":\"completed\",\"manualReview\":false}}}}}}");
                    return;
                }
                println!("{{\"content\":[{{\"type\":\"text\",\"text\":\"Offline screenshot captured\"}},{{\"type\":\"image\",\"mimeType\":\"image/png\",\"data\":\"{PNG}\"}}],\"structuredContent\":{{\"receipt\":{{\"status\":\"completed\",\"manualReview\":false}},\"echo\":\"{PNG}\",\"nested\":{{\"dataUrl\":\"data:image/png;base64,{PNG}\"}},\"artifacts\":[{{\"artifactId\":\"offline-video\",\"mimeType\":\"video/webm\",\"bytes\":321,\"profile\":\"fixture\"}}]}},\"isError\":false}}");
            } else {
                println!("{{\"content\":[{{\"type\":\"text\",\"text\":\"Offline {name} result\"}}],\"structuredContent\":{{\"receipt\":{{\"status\":\"completed\",\"manualReview\":false}}}},\"isError\":false}}");
            }
        }
        _ => std::process::exit(2),
    }
}
