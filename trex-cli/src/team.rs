//! Optional app-owned delegation. Models cannot select an executable, profile,
//! workspace or another team's binding.
use crate::tools::{ToolFuture, ToolProvider};
use anyhow::{ensure, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::Command,
};
use tokio_util::sync::CancellationToken;

const NAMES: [&str; 4] = [
    "trex_team_members",
    "trex_delegate_task",
    "trex_task_status",
    "trex_team_plan",
];
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TeamConfig {
    pub command: PathBuf,
    pub args: Vec<String>,
}
impl TeamConfig {
    pub fn parse(raw: Option<&Value>) -> Result<Option<Self>> {
        let Some(raw) = raw.filter(|v| !v.is_null()) else {
            return Ok(None);
        };
        let config: Self = serde_json::from_value(raw.clone()).context("invalid team binding")?;
        ensure!(config.command.is_absolute(), "team bridge must be absolute");
        ensure!(
            config.args.len() == 4 && config.args[0] == "--trex-team-call",
            "invalid team bridge arguments"
        );
        ensure!(
            Path::new(&config.args[1]).is_absolute(),
            "team storage must be absolute"
        );
        for id in &config.args[2..] {
            ensure!(
                !id.is_empty()
                    && id.len() <= 100
                    && id
                        .bytes()
                        .all(|v| v.is_ascii_alphanumeric() || b"_-".contains(&v)),
                "invalid team identity"
            );
        }
        app_bridge(&config.command, "team bridge")?;
        Ok(Some(config))
    }
}

/// The app executable beside this CLI (or the debug build of the app while
/// developing), without links or reparse points. `what` names it in errors.
pub(crate) fn app_bridge(command: &Path, what: &str) -> Result<()> {
    let binary = fs::canonicalize(command).with_context(|| format!("{what} is unavailable"))?;
    let sibling = std::env::current_exe()?
        .parent()
        .context("missing CLI directory")?
        .join(if cfg!(windows) { "trex.exe" } else { "trex" });
    let mut candidates = vec![sibling];
    #[cfg(debug_assertions)]
    candidates.push(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("src-tauri/target/debug/trex.exe"),
    );
    ensure!(
        candidates
            .iter()
            .any(|p| fs::canonicalize(p).is_ok_and(|p| p == binary)),
        "{what} must be the app beside this CLI"
    );
    for path in command.ancestors() {
        let meta = fs::symlink_metadata(path)?;
        ensure!(
            !meta.file_type().is_symlink(),
            "{what} cannot contain links"
        );
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            ensure!(
                meta.file_attributes() & 0x400 == 0,
                "{what} cannot contain reparse points"
            );
        }
    }
    ensure!(binary.is_file(), "{what} is not a regular file");
    Ok(())
}
#[derive(Debug)]
pub struct DelegationUncertain;
impl std::fmt::Display for DelegationUncertain {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Delegation was interrupted or its result is uncertain. Review the team before continuing; no task will be replayed automatically.")
    }
}
impl std::error::Error for DelegationUncertain {}
pub struct TeamToolProvider {
    config: TeamConfig,
}
impl TeamToolProvider {
    pub fn new(config: TeamConfig) -> Self {
        Self { config }
    }
}
impl ToolProvider for TeamToolProvider {
    fn definitions(&self, _mode: &str) -> Vec<Value> {
        // Mirrors the app's coordinator protocol (src-tauri agent_team.rs).
        vec![
            json!({"type":"function","function":{"name":NAMES[0],"description":"List the configured members: role, permissions, browser access, new-token usage, remaining budget, context use and account quota (5h/week) when known. Prefer members whose accounts have headroom; members may share an account. Cannot create agents or change models.","parameters":{"type":"object","properties":{},"additionalProperties":false}}}),
            json!({"type":"function","function":{"name":NAMES[1],"description":"Delegate a task to a configured member; returns {taskId, status, member}. Use wait:false to enqueue independent work, then end your turn: Trex opens a new turn when delegations finish. With awaitCoordinatorTurnEnd:true, end your turn so the member can start. The plan's dependsOn defines dependencies; workspace writers are exclusive, up to four readers run at once. Use a unique, stable taskKey; reuse it only to retrieve the same task, never to repeat uncertain or cancelled work.","parameters":{"type":"object","properties":{"memberId":{"type":"string"},"taskKey":{"type":"string","maxLength":100},"task":{"type":"string","maxLength":16384},"wait":{"type":"boolean","default":true}},"required":["memberId","taskKey","task"],"additionalProperties":false}}}),
            json!({"type":"function","function":{"name":NAMES[2],"description":"Compact task status. Without taskId: every task plus new reports, each delivered once. With taskId: that task; an already delivered report returns as reportPreview. detail:\"full\" adds the instruction and full report. Do not poll: Trex opens a new turn when delegations finish, then call this once without taskId. waitMs is for short waits only. Never reruns work.","parameters":{"type":"object","properties":{"taskId":{"type":"string"},"waitMs":{"type":"integer","minimum":0,"maximum":30000},"detail":{"type":"string","enum":["compact","full"]}},"additionalProperties":false}}}),
            json!({"type":"function","function":{"name":NAMES[3],"description":"Publish the team's task list before delegating; executes nothing and returns a compact confirmation (keys and status). Use the same taskKey, memberId and task when delegating; progress comes from actual results, never mark unverified work complete. Unsent steps may be revised; issued tasks stay. Keep the request under 48 KiB.","parameters":{"type":"object","properties":{"steps":{"type":"array","minItems":1,"maxItems":32,"items":{"type":"object","properties":{"taskKey":{"type":"string","maxLength":100},"memberId":{"type":"string"},"task":{"type":"string","maxLength":16384},"dependsOn":{"type":"array","maxItems":8,"items":{"type":"string"}}},"required":["taskKey","memberId","task"],"additionalProperties":false}}},"required":["steps"],"additionalProperties":false}}}),
        ]
    }
    fn is_mutating(&self, _name: &str, _input: &Value) -> bool {
        false
    }
    fn execute<'a>(
        &'a self,
        _cwd: &'a Path,
        _mode: &'a str,
        name: &'a str,
        input: &'a Value,
        operation_id: &'a str,
        cancel: CancellationToken,
    ) -> ToolFuture<'a> {
        Box::pin(async move {
            ensure!(NAMES.contains(&name), "unknown team tool");
            let bytes = serde_json::to_vec(
                &json!({"name":name,"arguments":input,"operationId":operation_id}),
            )?;
            ensure!(bytes.len() <= 64 * 1024, "team request too large");
            let mut command = Command::new(&self.config.command);
            command.env_clear();
            for key in [
                "SystemRoot",
                "WINDIR",
                "APPDATA",
                "LOCALAPPDATA",
                "USERPROFILE",
                "TEMP",
                "TMP",
                "LANG",
                "TZ",
            ] {
                if let Some(value) = std::env::var_os(key) {
                    command.env(key, value);
                }
            }
            command
                .args(&self.config.args)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .kill_on_drop(true);
            #[cfg(windows)]
            command.creation_flags(0x0800_0000);
            ensure!(
                !cancel.is_cancelled(),
                "delegation cancelled before dispatch"
            );
            let mut child = command.spawn().context("could not start the team bridge")?;
            let mut stdin = child.stdin.take().context("team stdin unavailable")?;
            let stdout = child.stdout.take().context("team stdout unavailable")?;
            let operation = async {
                stdin.write_all(&bytes).await?;
                stdin.shutdown().await?;
                drop(stdin);
                let mut bytes = vec![];
                stdout.take(1024 * 1024 + 1).read_to_end(&mut bytes).await?;
                ensure!(bytes.len() <= 1024 * 1024, "team result too large");
                ensure!(child.wait().await?.success(), "team bridge failed");
                let output: Value = serde_json::from_slice(&bytes)?;
                ensure!(output["content"].is_array(), "invalid team response");
                if name == "trex_delegate_task"
                    && ["uncertain", "cancelled"].contains(
                        &output["structuredContent"]["task"]["status"]
                            .as_str()
                            .unwrap_or(""),
                    )
                {
                    return Err(DelegationUncertain.into());
                }
                Ok(output)
            };
            tokio::select! {
                result=tokio::time::timeout(Duration::from_secs(1900),operation)=>match result {
                    Ok(Ok(output))=>Ok(output),
                    _=>Err(DelegationUncertain.into()),
                },
                _=cancel.cancelled()=>Err(DelegationUncertain.into()),
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn definitions_follow_the_app_coordinator_protocol() {
        let provider = TeamToolProvider::new(TeamConfig {
            command: PathBuf::new(),
            args: vec![],
        });
        let tools = provider.definitions("plan");
        let names: Vec<_> = tools.iter().map(|t| t["function"]["name"].as_str().unwrap()).collect();
        assert_eq!(names, NAMES);
        let status = &tools[2]["function"];
        assert_eq!(
            status["parameters"]["properties"]["detail"]["enum"],
            json!(["compact", "full"])
        );
        let description = status["description"].as_str().unwrap();
        assert!(description.contains("Do not poll") && description.contains("short waits"));
        assert!(tools[1]["function"]["description"]
            .as_str()
            .unwrap()
            .contains("awaitCoordinatorTurnEnd"));
    }
}
