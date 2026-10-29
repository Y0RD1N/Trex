//! Opt-in provider evaluations, one fresh temporary workspace per case.
use crate::{profile::Profile, server::Server};
use anyhow::{bail, ensure, Context, Result};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    path::{Component, Path},
    sync::Arc,
    time::Instant,
};
use tokio::sync::mpsc;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Suite {
    version: u32,
    cases: Vec<Case>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Case {
    id: String,
    prompt: String,
    #[serde(default)]
    files: BTreeMap<String, String>,
    #[serde(default)]
    expected_files: BTreeMap<String, Option<String>>,
    #[serde(default)]
    expected_text_contains: Vec<String>,
}
fn relative(path: &str) -> bool {
    !path.is_empty()
        && path.len() <= 1024
        && !path.contains(['\\', ':', '\0'])
        && Path::new(path)
            .components()
            .all(|c| matches!(c, Component::Normal(_)))
}
async fn rpc(
    server: &Arc<Server>,
    rx: &mut mpsc::UnboundedReceiver<Value>,
    id: u64,
    method: &str,
    params: Value,
) -> Result<Value> {
    server
        .handle(json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}))
        .await;
    while let Some(value) = rx.recv().await {
        if value["id"] == id && value.get("method").is_none() {
            if value.get("error").is_some() {
                bail!(
                    "{}",
                    value["error"]["message"]
                        .as_str()
                        .unwrap_or("evaluation request failed")
                );
            }
            return Ok(value["result"].clone());
        }
    }
    bail!("evaluation connection closed")
}
pub async fn run(profile: Profile, input: &str, mode: &str) -> Result<Value> {
    ensure!(
        matches!(mode, "plan" | "full"),
        "evaluations require plan or explicitly selected full mode"
    );
    ensure!(
        input.len() <= 4 * 1024 * 1024,
        "evaluation suite exceeds 4 MiB"
    );
    let suite: Suite = serde_json::from_str(input).context("invalid evaluation suite")?;
    ensure!(
        suite.version == 1 && (1..=64).contains(&suite.cases.len()),
        "expected version 1 and 1..64 cases"
    );
    let mut ids = std::collections::HashSet::new();
    for case in &suite.cases {
        ensure!(
            !case.id.is_empty() && case.id.len() <= 128 && ids.insert(case.id.clone()),
            "invalid or duplicate case ID"
        );
        ensure!(
            !case.prompt.trim().is_empty() && case.prompt.len() <= 1024 * 1024,
            "invalid evaluation prompt"
        );
        ensure!(
            case.files.len() <= 64
                && case.expected_files.len() <= 64
                && case.expected_text_contains.len() <= 64,
            "too many evaluation assertions or files"
        );
        ensure!(
            case.files
                .iter()
                .all(|(p, c)| relative(p) && c.len() <= 1024 * 1024)
                && case
                    .expected_files
                    .iter()
                    .all(|(p, c)| relative(p) && c.as_ref().is_none_or(|s| s.len() <= 1024 * 1024)),
            "invalid fixture path or content"
        );
        ensure!(
            case.expected_text_contains
                .iter()
                .all(|s| !s.is_empty() && s.len() <= 65536),
            "invalid text assertion"
        );
    }
    let mut results = Vec::new();
    for case in suite.cases {
        let workspace = tempfile::Builder::new().prefix("trex-eval-").tempdir()?;
        for (path, content) in &case.files {
            let path = workspace.path().join(path);
            std::fs::create_dir_all(path.parent().context("fixture parent missing")?)?;
            std::fs::write(path, content)?;
        }
        let (tx, mut rx) = mpsc::unbounded_channel();
        let server = Server::new(profile.clone(), tx);
        let started = Instant::now();
        // Never inherit optional external tools or desktop/browser grants into a suite.
        let outcome=async {
            let _=rpc(&server,&mut rx,1,"models/list",json!({})).await;
            let session=rpc(&server,&mut rx,2,"session/start",json!({"cwd":workspace.path(),"mode":mode,"settings":{"mcpServers":[],"tools":{"github":false,"blender":false,"hyperframes":false}}})).await?;
            let id=session["sessionId"].as_str().context("evaluation session missing")?.to_owned();
            let message=uuid::Uuid::new_v4().to_string();
            rpc(&server,&mut rx,3,"turn/start",json!({"sessionId":id,"messageId":message,"text":case.prompt})).await?;
            let mut answer=String::new();
            let terminal=loop {
                let event=rx.recv().await.context("evaluation stream closed")?;
                if event["params"]["messageId"]!=message {continue;}
                if event["method"]=="message/delta" && event["params"]["kind"]=="text" {answer.push_str(event["params"]["text"].as_str().unwrap_or(""));}
                if event["method"]=="turn/completed" {break event["params"].clone();}
            };
            let mut checks=Vec::new();
            for(path,expected) in &case.expected_files {
                let actual=std::fs::read_to_string(workspace.path().join(path));
                let passed=match expected {Some(text)=>actual.as_ref().is_ok_and(|s|s==text),None=>!workspace.path().join(path).exists()};
                checks.push(json!({"kind":"file","path":path,"passed":passed}));
            }
            for text in &case.expected_text_contains {checks.push(json!({"kind":"text","expected":text,"passed":answer.contains(text)}));}
            let passed=terminal["status"]=="completed" && checks.iter().all(|v|v["passed"]==true);
            Ok::<_,anyhow::Error>(json!({"id":case.id,"passed":passed,"status":terminal["status"],"checks":checks,"usage":terminal["apiUsage"],"error":terminal["error"],"errorDetails":terminal["errorDetails"],"conversationId":id}))
        }.await;
        // Revoke owned processes before the workspace is removed, including failures.
        server.shutdown().await;
        let mut result=outcome.unwrap_or_else(|error|json!({"id":case.id,"passed":false,"status":"failed","error":error.to_string()}));
        result["elapsedMs"] = json!(started.elapsed().as_millis() as u64);
        results.push(result);
    }
    Ok(
        json!({"version":1,"profile":profile.name,"provider":profile.provider,"model":profile.model,"mode":mode,"passed":results.iter().all(|v|v["passed"]==true),"cases":results,"localReport":true,"providerBill":false}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn suite_paths_cannot_escape() {
        for path in ["../private", "/root", "C:/private", "a\\b", "a/../b", ""] {
            assert!(!relative(path));
        }
        assert!(relative("src/a.rs"));
    }
}
