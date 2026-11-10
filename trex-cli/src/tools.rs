//! Native workspace tools. Shell authorization belongs to the caller.
//!
//! Patch format (a JSON string, not a unified diff):
//! `{"files":[{"path":"src/file.rs","before":"exact old text","after":"new text"}]}`.
//! `before: null` creates a new file in an existing directory. Deletion, directory
//! creation, fuzzy matching and duplicate paths are deliberately unsupported.
//! All preconditions are checked before any destination is replaced. Replacements
//! are atomic per file; an OS failure during a multi-file commit can still leave
//! a partially committed patch, which is reported in the error.
//!
//! These checks protect against supplied paths and existing symlinks/reparse
//! points. They are not an OS sandbox against another process concurrently
//! renaming parent directories. Full shell execution is intentionally unrestricted.

use anyhow::{anyhow, bail, ensure, Context, Result};
use regex::RegexBuilder;
use serde_json::{json, Map, Value};
use std::{
    collections::HashSet,
    fs::{self, File, OpenOptions},
    future::Future,
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    pin::Pin,
    process::Stdio,
    sync::atomic::{AtomicU64, Ordering},
    time::Duration,
};
use tokio::{io::AsyncReadExt, process::Command};
use tokio_util::sync::CancellationToken;
use walkdir::WalkDir;

const MAX_FILE_BYTES: usize = 1024 * 1024;
/// Captured shell/Git output kept in the journal and UI (half per stream).
/// The model receives a smaller head+tail projection (see context.rs).
const MAX_OUTPUT_BYTES: usize = 128 * 1024;
/// read_file/list_files/search results: paged, so the model asks for more.
const MAX_READ_BYTES: usize = 64 * 1024;
const MAX_RESULTS: usize = 1000;
const MAX_VISITED: usize = 10_000;
// Every iterator stays open within the depth budget. A smaller max_open would
// make WalkDir buffer entire wide ancestors when it closes their handles.
const MAX_WALK_DEPTH: usize = 64;
const MAX_SCAN_BYTES: usize = 16 * 1024 * 1024;
const MAX_PATCH_BYTES: usize = 4 * 1024 * 1024;
const MAX_PATCH_FILES: usize = 32;
const SKIP_DIRS: [&str; 3] = [".git", "node_modules", "target"];
static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Debug)]
pub struct ToolExecutionUncertain(pub String);
impl std::fmt::Display for ToolExecutionUncertain {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f,"{}. Changes may have been applied; inspect the workspace before acknowledging recovery. Never automatically retry this operation.",self.0)
    }
}
impl std::error::Error for ToolExecutionUncertain {}

pub type ToolFuture<'a> = Pin<Box<dyn Future<Output = Result<Value>> + Send + 'a>>;

/// A deliberately small registry interface; external providers cannot dispatch
/// arbitrary commands or bypass the session runner's approval journal.
pub trait ToolProvider: Send + Sync {
    fn shutdown<'a>(&'a self) -> ToolFuture<'a> {
        Box::pin(async { Ok(json!({})) })
    }
    fn invalidate_observation(&self) {}
    /// Guía de uso para el prompt de sistema (estable durante la sesión).
    fn guidance(&self, _mode: &str) -> Option<String> {
        None
    }
    fn definitions(&self, mode: &str) -> Vec<Value>;
    fn is_mutating(&self, name: &str, input: &Value) -> bool;
    fn execute<'a>(
        &'a self,
        cwd: &'a Path,
        mode: &'a str,
        name: &'a str,
        input: &'a Value,
        operation_id: &'a str,
        cancel: CancellationToken,
    ) -> ToolFuture<'a>;
}

pub struct NativeToolProvider {
    processes: std::sync::Arc<crate::processes::ProcessManager>,
    settings: std::sync::Arc<crate::settings::Settings>,
}
impl ToolProvider for NativeToolProvider {
    fn definitions(&self, mode: &str) -> Vec<Value> {
        definitions()
            .into_iter()
            .filter(|tool| {
                mode != "plan" || !is_mutating(tool["function"]["name"].as_str().unwrap_or(""))
            })
            .collect()
    }
    fn is_mutating(&self, name: &str, _input: &Value) -> bool {
        is_mutating(name)
    }
    fn execute<'a>(
        &'a self,
        cwd: &'a Path,
        _mode: &'a str,
        name: &'a str,
        input: &'a Value,
        operation_id: &'a str,
        cancel: CancellationToken,
    ) -> ToolFuture<'a> {
        Box::pin(async move {
            check_cancel(&cancel)?;
            match name {
                "shell" if input["background"] == true => self.processes.start_configured(
                    cwd,
                    input,
                    operation_id,
                    &cancel,
                    &self.settings.shell,
                ),
                "process_list" => {
                    fields(input, &[], &[])?;
                    Ok(self.processes.list())
                }
                "process_output" => {
                    let obj = fields(input, &["id", "after"], &["id"])?;
                    self.processes
                        .read_since(string(obj, "id")?, obj.get("after").and_then(Value::as_u64))
                }
                "process_stop" => {
                    let obj = fields(input, &["id"], &["id"])?;
                    self.processes.stop(string(obj, "id")?).await
                }
                "process_write" => {
                    let obj = fields(input, &["id", "text"], &["id", "text"])?;
                    self.processes
                        .write(string(obj, "id")?, string(obj, "text")?)
                        .await
                }
                "process_resize" => {
                    let obj = fields(input, &["id", "rows", "cols"], &["id", "rows", "cols"])?;
                    self.processes.resize(
                        string(obj, "id")?,
                        number(obj, "rows", 24, 10, 500)? as u16,
                        number(obj, "cols", 100, 10, 500)? as u16,
                    )
                }
                "checkpoint_list" => crate::changes::list(cwd),
                "checkpoint_diff" => {
                    let obj = fields(input, &["id"], &["id"])?;
                    crate::changes::diff(cwd, string(obj, "id")?)
                }
                "checkpoint_restore" => {
                    let obj = fields(input, &["id"], &["id"])?;
                    crate::changes::undo(cwd, string(obj, "id")?, &self.settings.privacy)
                }
                _ => {
                    let snapshot = if self.settings.tools.checkpoints {
                        Some(preview_file_changes(
                            cwd,
                            name,
                            input,
                            &self.settings.privacy,
                        )?)
                    } else {
                        None
                    };
                    let checkpoint = snapshot
                        .as_ref()
                        .map(|files| crate::changes::prepare(cwd, files.clone()))
                        .transpose()?
                        .flatten();
                    let result = execute_configured(
                        cwd,
                        name,
                        input,
                        cancel,
                        self.settings.clone(),
                        snapshot,
                    )
                    .await;
                    if let Some(id) = &checkpoint {
                        crate::changes::finish(id,result.is_ok()).map_err(|e|e.context(ToolExecutionUncertain("Cannot finalize the native checkpoint; inspect files before continuing".into())))?;
                    }
                    result.map(|mut value| {
                        if let Some(id) = checkpoint {
                            value["checkpointId"] = json!(id);
                        }
                        value
                    })
                }
            }
        })
    }
}

pub struct ToolRegistry {
    providers: Vec<Box<dyn ToolProvider>>,
    team: Option<crate::team::TeamConfig>,
    role_instructions: Option<String>,
    session_instructions: Option<String>,
    processes: std::sync::Arc<crate::processes::ProcessManager>,
    settings: std::sync::Arc<crate::settings::Settings>,
    workspace: Option<PathBuf>,
}
impl ToolRegistry {
    pub fn new(browser: Option<crate::browser::BrowserToolProvider>) -> Self {
        Self::configured(
            browser,
            std::sync::Arc::new(crate::settings::Settings::default()),
        )
    }
    pub fn configured(
        browser: Option<crate::browser::BrowserToolProvider>,
        settings: std::sync::Arc<crate::settings::Settings>,
    ) -> Self {
        let processes = std::sync::Arc::new(crate::processes::ProcessManager::default());
        let mut providers: Vec<Box<dyn ToolProvider>> = vec![
            Box::new(NativeToolProvider {
                processes: processes.clone(),
                settings: settings.clone(),
            }),
            Box::new(crate::github::GithubProvider),
            Box::new(crate::blender::BlenderProvider),
            Box::new(crate::hyperframes::HyperframesProvider),
        ];
        if let Some(browser) = browser {
            providers.push(Box::new(browser));
        }
        Self {
            providers,
            team: None,
            role_instructions: None,
            session_instructions: None,
            processes,
            settings,
            workspace: None,
        }
    }
    pub fn settings(&self) -> &crate::settings::Settings {
        &self.settings
    }
    pub fn with_workspace(mut self, workspace: PathBuf) -> Self {
        self.workspace = Some(workspace);
        self
    }
    fn enabled(&self, name: &str) -> bool {
        if name.starts_with("github_") {
            self.settings.tools.github && (self.workspace.is_none() || crate::github::available())
        } else if name == "blender_run" {
            self.settings.tools.blender && (self.workspace.is_none() || crate::blender::available())
        } else if name == "hyperframes_run" {
            self.settings.tools.hyperframes
                && self
                    .workspace
                    .as_ref()
                    .is_none_or(|p| crate::hyperframes::available(p))
        } else if name.starts_with("git_") {
            self.workspace.is_none() || find_program("git").is_some()
        } else {
            true
        }
    }
    pub fn with_desktop(mut self, enabled: bool) -> Self {
        if enabled {
            self.providers
                .push(Box::new(crate::desktop::DesktopProvider::default()));
        }
        self
    }
    pub fn with_mcp(mut self, providers: Vec<crate::mcp::McpProvider>) -> Self {
        self.providers.extend(
            providers
                .into_iter()
                .map(|p| Box::new(p) as Box<dyn ToolProvider>),
        );
        self
    }
    pub fn with_team(mut self, config: Option<crate::team::TeamConfig>) -> Self {
        if let Some(config) = config {
            self.providers
                .push(Box::new(crate::team::TeamToolProvider::new(config.clone())));
            self.team = Some(config);
        }
        self
    }
    pub fn with_role_instructions(mut self, instructions: Option<String>) -> Self {
        self.role_instructions = instructions;
        self
    }
    pub fn role_instructions(&self) -> &Option<String> {
        &self.role_instructions
    }
    pub fn with_session_instructions(mut self, instructions: Option<String>) -> Self {
        self.session_instructions = instructions;
        self
    }
    pub fn session_instructions(&self) -> &Option<String> {
        &self.session_instructions
    }
    /// Guía de las integraciones conectadas: el escritorio nativo y las
    /// `instructions` de cada servidor MCP (como las recibe Claude Code).
    pub fn guidance(&self, mode: &str) -> Vec<String> {
        self.providers.iter().filter_map(|provider| provider.guidance(mode)).collect()
    }
    pub fn invalidate_observation(&self) {
        for provider in &self.providers {
            provider.invalidate_observation();
        }
    }
    pub fn processes(&self) -> &crate::processes::ProcessManager {
        &self.processes
    }
    pub async fn shutdown(&self) {
        self.processes.shutdown().await;
        for provider in &self.providers {
            let _ = tokio::time::timeout(Duration::from_secs(5), provider.shutdown()).await;
        }
    }
    pub fn team_config(&self) -> &Option<crate::team::TeamConfig> {
        &self.team
    }
    fn provider(&self, mode: &str, name: &str) -> Option<&dyn ToolProvider> {
        if !self.enabled(name) {
            return None;
        }
        self.providers
            .iter()
            .find(|provider| {
                provider
                    .definitions(mode)
                    .iter()
                    .any(|tool| tool["function"]["name"] == name)
            })
            .map(|provider| provider.as_ref())
    }
    pub fn definitions(&self, mode: &str) -> Vec<Value> {
        self.providers
            .iter()
            .flat_map(|provider| provider.definitions(mode))
            .filter(|tool| self.enabled(tool["function"]["name"].as_str().unwrap_or("")))
            .collect()
    }
    pub fn is_mutating(&self, mode: &str, name: &str, input: &Value) -> bool {
        // Server-handled: it only changes which tools are advertised.
        if name == "enable_tools" {
            return false;
        }
        self.provider(mode, name)
            .is_none_or(|provider| provider.is_mutating(name, input))
    }
    pub async fn execute(
        &self,
        cwd: &Path,
        mode: &str,
        name: &str,
        input: &Value,
        operation_id: &str,
        cancel: CancellationToken,
    ) -> Result<Value> {
        self.provider(mode, name)
            .context("unknown or unavailable tool")?
            .execute(cwd, mode, name, input, operation_id, cancel)
            .await
    }
}

/// OpenAI Chat Completions function-tool definitions.
pub fn definitions() -> Vec<Value> {
    let specs = [
        ("read_file", "Read a UTF-8 workspace file (max 1 MiB) by lines: offset is zero-based, limit defaults to 200 (max 2000). Output is capped at 64 KiB; page with offset.", json!({"path":{"type":"string"},"offset":{"type":"integer","minimum":0},"limit":{"type":"integer","minimum":1,"maximum":2000}}), vec!["path"]),
        ("list_files", "List workspace text files and directories (skips symlinks, binaries, .git, node_modules, target; max 1000 entries). Defaults: path '.', recursive false.", json!({"path":{"type":"string"},"recursive":{"type":"boolean"}}), vec![]),
        ("search", "Search UTF-8 workspace files with a Rust regex, one result per matching line (same skips as list_files). maxResults defaults to 100 (max 1000); output is bounded.", json!({"pattern":{"type":"string"},"path":{"type":"string"},"maxResults":{"type":"integer","minimum":1,"maximum":1000}}), vec!["pattern"]),
        ("write_file", "Atomically create or replace a UTF-8 workspace file (max 1 MiB). The parent directory must exist; links are rejected.", json!({"path":{"type":"string"},"content":{"type":"string"}}), vec!["path","content"]),
        ("edit_file","Replace one exact, unique text fragment in a UTF-8 file, preserving everything else. Optional expectedHash is read_file's sha256.",json!({"path":{"type":"string"},"oldText":{"type":"string"},"newText":{"type":"string"},"expectedHash":{"type":"string"}}),vec!["path","oldText","newText"]),
        ("make_directory","Create one workspace directory; the parent must exist.",json!({"path":{"type":"string"}}),vec!["path"]),
        ("rename_file","Rename a UTF-8 workspace file without overwriting another file.",json!({"path":{"type":"string"},"destination":{"type":"string"}}),vec!["path","destination"]),
        ("remove_file","Remove one UTF-8 workspace file (checkpointed when enabled). Never deletes directories.",json!({"path":{"type":"string"}}),vec!["path"]),
        ("checkpoint_list","List this workspace's native-file checkpoints (shell changes are not included).",json!({}),vec![]),
        ("checkpoint_diff","Review a native-file checkpoint's recorded changes.",json!({"id":{"type":"string"}}),vec!["id"]),
        ("checkpoint_restore","Restore a checkpoint only if every affected file still matches its recorded result; never overwrites newer changes.",json!({"id":{"type":"string"}}),vec!["id"]),
        ("git_status","Show Git status (no locks, no fsmonitor).",json!({}),vec![]),
        ("git_diff","Show tracked Git changes (no external diff/textconv), optionally for one workspace path or staged.",json!({"path":{"type":"string"},"staged":{"type":"boolean"}}),vec![]),
        ("apply_patch", "Apply a strict JSON patch string: {\"files\":[{\"path\":\"relative/path\",\"before\":\"exact entire current text\",\"after\":\"entire replacement text\"}]}. before:null creates a file; no deletes or directories. Preconditions are checked first; max 32 files, 1 MiB/file. Atomic per file: an OS failure may partially apply a multi-file patch.", json!({"patch":{"type":"string"}}), vec!["patch"]),
        ("shell", "Run an authorized shell command. Foreground timeoutMs defaults to 60000 (max 600000); an interrupted command may need recovery. background:true for servers/watches (no timeoutMs); interactive:true to send stdin, pty:true for a terminal. Keep the returned id for process_output/process_write/process_stop. Long output keeps its head and tail.", json!({"command":{"type":"string"},"background":{"type":"boolean"},"interactive":{"type":"boolean"},"pty":{"type":"boolean"},"rows":{"type":"integer","minimum":10,"maximum":500},"cols":{"type":"integer","minimum":10,"maximum":500},"timeoutMs":{"type":"integer","minimum":1,"maximum":600000}}), vec!["command"]),
        ("process_list", "List this session's background terminals and their status.", json!({}), vec![]),
        ("process_output", "Read the latest output (up to 64 KiB). Pass the previous nextOffset as after for new output only; truncated means older bytes were lost.", json!({"id":{"type":"string"},"after":{"type":"integer","minimum":0}}), vec!["id"]),
        ("process_write","Send text to an owned interactive process or PTY. This can execute commands and follows mutation permissions.",json!({"id":{"type":"string"},"text":{"type":"string","maxLength":32768}}),vec!["id","text"]),
        ("process_resize","Resize one owned active PTY.",json!({"id":{"type":"string"},"rows":{"type":"integer","minimum":10,"maximum":500},"cols":{"type":"integer","minimum":10,"maximum":500}}),vec!["id","rows","cols"]),
        ("process_stop", "Stop one owned background terminal and its descendants (never an OS PID).", json!({"id":{"type":"string"}}), vec!["id"]),
        ("trex_read_messages", "Read newly queued user messages.", json!({}), vec![]),
        ("task_state","Read the latest durable task list (also after compaction). offset defaults to 0, limit to 10 (max 64).",json!({"offset":{"type":"integer","minimum":0},"limit":{"type":"integer","minimum":1,"maximum":64}}),vec![]),
        ("history_search","Search this conversation's full retained history, including compacted context and archived tool results (excerpts around the match). With messageIndex (from a match or an archive note) read that message instead, 16 KiB from offset.",json!({"query":{"type":"string","maxLength":1024},"limit":{"type":"integer","minimum":1,"maximum":20},"messageIndex":{"type":"integer","minimum":0},"offset":{"type":"integer","minimum":0}}),vec![]),
        ("update_plan", "Publish or update your visible task list: completed work completed, the current step in_progress, future steps pending. Never mark unverified work complete.", json!({"plan":{"type":"array","minItems":1,"maxItems":64,"items":{"type":"object","properties":{"step":{"type":"string","maxLength":2000},"status":{"type":"string","enum":["pending","in_progress","completed"]}},"required":["step","status"],"additionalProperties":false}}}), vec!["plan"]),
    ];
    specs.into_iter().map(|(name, description, properties, required)| json!({
        "type":"function", "function": {"name":name,"description":description,
        "parameters":{"type":"object","properties":properties,"required":required,"additionalProperties":false}}
    })).collect()
}

/// Deferred tool groups: not advertised until enable_tools turns them on for
/// the session. Order is fixed so the advertised list stays deterministic.
pub const TOOL_GROUPS: &[(&str, &str)] = &[
    ("browser_devtools", "browser_evaluate, request mocking, viewport/color/network emulation, frames, response bodies, hover, drag, raw mouse, file upload"),
    ("browser_capture", "video, Playwright traces, performance/CPU profiles, heap snapshots, reading or opening generated artifacts"),
    ("browser_session", "manual pause, ownership takeover, cancelling one operation"),
];

pub fn tool_group(name: &str) -> Option<&'static str> {
    crate::browser::tool_group(name)
}

fn tool_name(tool: &Value) -> &str {
    tool["function"]["name"].as_str().unwrap_or("")
}

/// The tools sent to the model: the core set, then enable_tools (when a
/// deferred group is available), then each enabled group in the order it was
/// enabled. Enabling only appends, so the earlier prefix stays cacheable.
pub fn advertised(all: &[Value], enabled: &[String]) -> Vec<Value> {
    let mut result: Vec<Value> = all
        .iter()
        .filter(|tool| tool_group(tool_name(tool)).is_none())
        .cloned()
        .collect();
    let available: Vec<_> = TOOL_GROUPS
        .iter()
        .filter(|(group, _)| all.iter().any(|tool| tool_group(tool_name(tool)) == Some(group)))
        .collect();
    if available.is_empty() {
        return result;
    }
    let summary = available
        .iter()
        .map(|(group, description)| format!("{group} ({description})"))
        .collect::<Vec<_>>()
        .join("; ");
    result.push(json!({"type":"function","function":{"name":"enable_tools","description":format!("Advertise an advanced tool group for the rest of this session; its tools appear from your next step. Groups: {summary}."),
        "parameters":{"type":"object","properties":{"group":{"type":"string","enum":available.iter().map(|(group, _)| *group).collect::<Vec<_>>()}},"required":["group"],"additionalProperties":false}}}));
    for group in enabled {
        if available.iter().any(|(name, _)| name == group) {
            result.extend(
                all.iter()
                    .filter(|tool| tool_group(tool_name(tool)) == Some(group.as_str()))
                    .cloned(),
            );
        }
    }
    result
}

/// enable_tools: validates the group against this session's tools and
/// records it once. Returns the group's tool names.
pub fn enable_group(all: &[Value], enabled: &mut Vec<String>, input: &Value) -> Result<Value> {
    let obj = fields(input, &["group"], &["group"])?;
    let group = string(obj, "group")?;
    let tools: Vec<&str> = all
        .iter()
        .map(tool_name)
        .filter(|name| tool_group(name) == Some(group))
        .collect();
    ensure!(
        !tools.is_empty(),
        "unknown tool group or no tools available in this mode"
    );
    let already = enabled.iter().any(|name| name == group);
    if !already {
        enabled.push(group.to_owned());
    }
    Ok(json!({"group":group,"enabled":true,"alreadyEnabled":already,"tools":tools,"note":"These tools are available from your next step."}))
}

/// Unknown tool names fail closed under a caller's read-only policy.
pub fn is_mutating(name: &str) -> bool {
    !matches!(
        name,
        "read_file"
            | "enable_tools"
            | "list_files"
            | "search"
            | "trex_read_messages"
            | "task_state"
            | "history_search"
            | "update_plan"
            | "process_list"
            | "process_output"
            | "checkpoint_list"
            | "checkpoint_diff"
            | "git_status"
            | "git_diff"
            | "github_repos"
            | "github_prs"
            | "github_pr_view"
            | "desktop_screenshot"
            | "desktop_status"
            | "desktop_monitors"
            | "desktop_wait"
    )
}

pub async fn execute(
    cwd: &Path,
    name: &str,
    input: &Value,
    cancel: CancellationToken,
) -> Result<Value> {
    execute_configured(
        cwd,
        name,
        input,
        cancel,
        std::sync::Arc::new(crate::settings::Settings::default()),
        None,
    )
    .await
}
async fn execute_configured(
    cwd: &Path,
    name: &str,
    input: &Value,
    cancel: CancellationToken,
    settings: std::sync::Arc<crate::settings::Settings>,
    snapshot: Option<Vec<crate::changes::FileChange>>,
) -> Result<Value> {
    check_cancel(&cancel)?;
    // Validate tool identity before resolving cwd or touching disk.
    match name {
        "update_plan" => {
            fields(input, &["plan"], &["plan"])?;
            let steps = input["plan"].as_array().context("plan must be an array")?;
            ensure!(
                !steps.is_empty() && steps.len() <= 64,
                "plan needs 1 to 64 steps"
            );
            let mut active = 0;
            for step in steps {
                fields(step, &["step", "status"], &["step", "status"])?;
                let title = step["step"].as_str().context("step must be text")?;
                ensure!(
                    !title.trim().is_empty()
                        && title.len() <= 8000
                        && title.chars().count() <= 2000,
                    "invalid step text"
                );
                let status = step["status"].as_str().unwrap_or("");
                ensure!(
                    ["pending", "in_progress", "completed"].contains(&status),
                    "invalid step status"
                );
                active += usize::from(status == "in_progress");
            }
            ensure!(active <= 1, "only one plan step may be in progress");
            return Ok(json!({"plan": steps}));
        }
        "trex_read_messages" => {
            fields(input, &[], &[])?;
            bail!("trex_read_messages must be handled by the server")
        }
        "read_file" | "list_files" | "search" | "write_file" | "apply_patch" | "shell"
        | "edit_file" | "make_directory" | "rename_file" | "remove_file" | "git_status"
        | "git_diff" => {}
        _ => bail!("unknown tool: {name}"),
    }
    if name == "shell" {
        return shell_configured(cwd, input, cancel, &settings.shell).await;
    }
    if matches!(name, "git_status" | "git_diff") {
        return git_read(cwd, name, input, cancel, &settings).await;
    }
    let cwd = cwd.to_owned();
    let name = name.to_owned();
    let input = input.clone();
    tokio::task::spawn_blocking(move || {
        let mut ws = Workspace::configured(&cwd,settings.privacy.clone())?;
        ws.expected=snapshot;
        match name.as_str() {
            "read_file" => read_file(&ws, &input, &cancel),
            "list_files" => list_files(&ws, &input, &cancel),
            "search" => search(&ws, &input, &cancel),
            "write_file" => write_file(&ws, &input, &cancel),
            "apply_patch" => apply_patch(&ws, &input, &cancel),
            "edit_file"=>edit_file(&ws,&input,&cancel),
            "make_directory"=>{let obj=fields(&input,&["path"],&["path"])?;let path=ws.resolve(string(obj,"path")?,true)?;ws.policy.require(&path)?;fs::create_dir(&path)?;Ok(json!({"created":true,"path":ws.display(&path)}))},
            "rename_file"=>{
                let obj=fields(&input,&["path","destination"],&["path","destination"])?;
                let from=ws.resolve(string(obj,"path")?,false)?;let to=ws.resolve(string(obj,"destination")?,true)?;
                ws.policy.require(&from)?;ws.policy.require(&to)?;ensure!(!to.exists(),"destination already exists");
                let _refresh=ws.refresh_policy_after([from.as_path(),to.as_path()].into_iter());
                let before=ws.before(&from,&cancel)?;ensure!(existing_text(&from,&cancel)?==before,"rename source changed since the checkpoint");
                // Creating a hard link is no-replace on both Windows and Unix.
                // Remove the original only after publishing succeeds.
                fs::hard_link(&from,&to)?;
                fs::remove_file(&from).map_err(|e|anyhow::Error::new(e).context(ToolExecutionUncertain("Rename published its destination but could not remove the original; inspect both files".into())))?;
                Ok(json!({"renamed":true}))
            },
            "remove_file"=>{let obj=fields(&input,&["path"],&["path"])?;let path=ws.resolve(string(obj,"path")?,false)?;ws.policy.require(&path)?;let _refresh=ws.refresh_policy_after(std::iter::once(path.as_path()));let before=ws.before(&path,&cancel)?;ensure!(existing_text(&path,&cancel)?==before,"remove target changed since the checkpoint");fs::remove_file(path)?;Ok(json!({"removed":true}))},
            _ => unreachable!(),
        }
    })
    .await
    .context("native tool worker failed")?
}

fn fields<'a>(
    value: &'a Value,
    allowed: &[&str],
    required: &[&str],
) -> Result<&'a Map<String, Value>> {
    let obj = value.as_object().context("tool input must be an object")?;
    for key in obj.keys() {
        ensure!(allowed.contains(&key.as_str()), "unknown field: {key}");
    }
    for key in required {
        ensure!(obj.contains_key(*key), "missing field: {key}");
    }
    Ok(obj)
}
fn string<'a>(obj: &'a Map<String, Value>, key: &str) -> Result<&'a str> {
    obj.get(key)
        .and_then(Value::as_str)
        .with_context(|| format!("{key} must be a string"))
}
fn optional_path(obj: &Map<String, Value>) -> Result<&str> {
    if obj.contains_key("path") {
        string(obj, "path")
    } else {
        Ok(".")
    }
}
fn number(obj: &Map<String, Value>, key: &str, default: u64, min: u64, max: u64) -> Result<usize> {
    let n = match obj.get(key) {
        None => default,
        Some(v) => v
            .as_u64()
            .with_context(|| format!("{key} must be a nonnegative integer"))?,
    };
    ensure!(
        (min..=max).contains(&n),
        "{key} must be between {min} and {max}"
    );
    Ok(n as usize)
}
fn check_cancel(cancel: &CancellationToken) -> Result<()> {
    ensure!(!cancel.is_cancelled(), "tool execution cancelled");
    Ok(())
}

pub(crate) struct Workspace {
    root: PathBuf,
    policy: crate::project::Policy,
    expected: Option<Vec<crate::changes::FileChange>>,
}
struct PolicyRefresh<'a>(&'a Path);
impl Drop for PolicyRefresh<'_> {
    fn drop(&mut self) {
        crate::project::Policy::invalidate(self.0);
    }
}
impl Workspace {
    fn new(cwd: &Path) -> Result<Self> {
        Self::configured(cwd, crate::settings::PrivacySettings::default())
    }
    pub(crate) fn configured(
        cwd: &Path,
        privacy: crate::settings::PrivacySettings,
    ) -> Result<Self> {
        let root = fs::canonicalize(cwd).context("cannot canonicalize workspace")?;
        ensure!(root.is_dir(), "workspace must be a directory");
        #[cfg(windows)]
        {
            ensure!(
                supported_windows_root(&root),
                "only local drive workspaces are supported; UNC/device workspaces are forbidden"
            );
        }
        // Every tool call builds a Workspace; the cached policy spares each one
        // a walk of the whole tree.
        let policy = crate::project::Policy::cached(&root, privacy)?;
        Ok(Self {
            root,
            policy,
            expected: None,
        })
    }

    /// A file tool about to write, rename or remove an ignore file changes the
    /// privacy rules themselves. The returned guard drops the cached policy
    /// when it goes out of scope, failure included (a failed commit may have
    /// published part of its files), so the next call sees the agent's edit
    /// instead of waiting for the cache to expire.
    fn refresh_policy_after<'p>(
        &self,
        mut paths: impl Iterator<Item = &'p Path>,
    ) -> Option<PolicyRefresh<'_>> {
        paths
            .any(crate::project::is_ignore_file)
            .then(|| PolicyRefresh(&self.root))
    }

    fn before(&self, path: &Path, cancel: &CancellationToken) -> Result<Option<String>> {
        if let Some(files) = &self.expected {
            if let Some(file) = files.iter().find(|f| f.path == self.display(path)) {
                return Ok(file.before.clone());
            }
        }
        existing_text(path, cancel)
    }

    fn input_root(&self) -> PathBuf {
        #[cfg(windows)]
        {
            // Verbatim paths are kept for filesystem APIs and long-path support.
            let text = self.root.to_string_lossy();
            PathBuf::from(text.strip_prefix(r"\\?\").unwrap_or(&text))
        }
        #[cfg(not(windows))]
        {
            self.root.clone()
        }
    }

    /// Existing parents only; every component is checked without following links.
    pub(crate) fn resolve(&self, raw: &str, allow_new: bool) -> Result<PathBuf> {
        ensure!(
            !raw.is_empty() && raw.len() <= 4096,
            "path must contain 1..4096 bytes"
        );
        ensure!(
            !raw.starts_with("\\\\") && !raw.starts_with("//"),
            "UNC and device paths are forbidden"
        );
        let normalized = raw.replace('\\', "/");
        ensure!(
            !normalized.starts_with("//"),
            "UNC and device paths are forbidden"
        );
        let drive = normalized.as_bytes().get(1) == Some(&b':')
            && normalized.as_bytes()[0].is_ascii_alphabetic();
        if drive {
            ensure!(
                normalized.as_bytes().get(2) == Some(&b'/'),
                "drive-relative paths are forbidden"
            );
            #[cfg(not(windows))]
            bail!("Windows drive paths are unsupported on this platform");
        }
        let tail = if drive { &normalized[2..] } else { &normalized };
        for part in tail.split('/') {
            if part.is_empty() || part == "." {
                continue;
            }
            ensure!(part != "..", "parent traversal is forbidden");
            validate_component(part)?;
        }
        #[cfg(windows)]
        ensure!(
            !normalized.starts_with('/') || drive,
            "root-relative Windows paths are forbidden"
        );
        let supplied = Path::new(&normalized);
        let relative = if supplied.is_absolute() {
            // Windows paths compare components without case to accept drive casing.
            let input_root = self.input_root();
            let root_parts: Vec<_> = input_root.components().collect();
            let given: Vec<_> = supplied.components().collect();
            ensure!(given.len() >= root_parts.len(), "path is outside workspace");
            for (a, b) in root_parts.iter().zip(given.iter()) {
                #[cfg(windows)]
                let same = a
                    .as_os_str()
                    .to_string_lossy()
                    .eq_ignore_ascii_case(&b.as_os_str().to_string_lossy());
                #[cfg(not(windows))]
                let same = a == b;
                ensure!(same, "path is outside workspace");
            }
            given[root_parts.len()..]
                .iter()
                .map(|c| c.as_os_str())
                .collect::<PathBuf>()
        } else {
            supplied.to_path_buf()
        };
        let mut current = self.root.clone();
        let parts: Vec<_> = relative
            .components()
            .filter(|c| !matches!(c, Component::CurDir))
            .collect();
        for (index, component) in parts.iter().enumerate() {
            ensure!(
                matches!(component, Component::Normal(_)),
                "invalid path component"
            );
            current.push(component.as_os_str());
            match fs::symlink_metadata(&current) {
                Ok(meta) => {
                    ensure!(
                        !is_link(&meta),
                        "symlinks and reparse points are forbidden: {}",
                        current.display()
                    );
                    if index + 1 != parts.len() {
                        ensure!(meta.is_dir(), "path parent is not a directory");
                    }
                }
                Err(e)
                    if e.kind() == std::io::ErrorKind::NotFound
                        && allow_new
                        && index + 1 == parts.len() => {}
                Err(e) => {
                    return Err(e).with_context(|| format!("cannot access {}", current.display()))
                }
            }
        }
        // Canonical parent containment is an additional check, not a substitute
        // for refusing links in every component.
        let checked = if current.exists() {
            &current
        } else {
            current.parent().context("missing parent")?
        };
        let canonical = fs::canonicalize(checked)?;
        let canonical_root = fs::canonicalize(&self.root)?;
        ensure!(
            canonical.starts_with(&canonical_root),
            "path escapes workspace"
        );
        Ok(current)
    }

    fn display(&self, path: &Path) -> String {
        path.strip_prefix(&self.root)
            .unwrap_or(path)
            .to_string_lossy()
            .replace('\\', "/")
    }
    pub(crate) fn require(&self, path: &Path) -> Result<()> {
        self.policy.require(path)
    }
}

#[cfg(windows)]
fn supported_windows_root(root: &Path) -> bool {
    use std::path::Prefix;
    matches!(root.components().next(), Some(Component::Prefix(p)) if matches!(p.kind(), Prefix::Disk(_) | Prefix::VerbatimDisk(_)))
}

fn validate_component(part: &str) -> Result<()> {
    ensure!(
        !part.ends_with(['.', ' ']),
        "trailing dots/spaces are forbidden in paths"
    );
    ensure!(
        !part
            .chars()
            .any(|c| c.is_control() || matches!(c, ':' | '<' | '>' | '"' | '|' | '?' | '*')),
        "invalid path character or Windows ADS"
    );
    let base = part
        .split('.')
        .next()
        .unwrap_or("")
        .trim_end_matches(' ')
        .to_uppercase();
    let reserved = matches!(
        base.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
    ) || base
        .strip_prefix("COM")
        .or_else(|| base.strip_prefix("LPT"))
        .is_some_and(|suffix| {
            matches!(
                suffix,
                "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
            )
        });
    ensure!(!reserved, "Windows device names are forbidden");
    Ok(())
}
fn is_link(meta: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        meta.file_type().is_symlink() || meta.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        meta.file_type().is_symlink()
    }
}

fn open_read(path: &Path) -> Result<File> {
    let mut opts = OpenOptions::new();
    opts.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        opts.custom_flags(0x0020_0000);
    }
    #[cfg(any(target_os = "linux", target_os = "android"))]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.custom_flags(0x0002_0000); // O_NOFOLLOW
    }
    #[cfg(any(
        target_os = "macos",
        target_os = "ios",
        target_os = "freebsd",
        target_os = "openbsd",
        target_os = "netbsd",
        target_os = "dragonfly"
    ))]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.custom_flags(0x0000_0100); // O_NOFOLLOW
    }
    let file = opts
        .open(path)
        .with_context(|| format!("cannot read {}", path.display()))?;
    let meta = file.metadata()?;
    ensure!(
        meta.is_file() && !is_link(&meta),
        "expected a regular file without symlinks"
    );
    Ok(file)
}
fn read_bytes(path: &Path, limit: usize, cancel: &CancellationToken) -> Result<Vec<u8>> {
    check_cancel(cancel)?;
    let mut file = open_read(path)?;
    ensure!(
        file.metadata()?.len() <= limit as u64,
        "file exceeds {limit} byte limit"
    );
    let mut bytes = Vec::new();
    let mut buffer = [0u8; 8192];
    loop {
        check_cancel(cancel)?;
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        ensure!(
            bytes.len() + read <= limit,
            "file exceeds {limit} byte limit"
        );
        bytes.extend_from_slice(&buffer[..read]);
    }
    Ok(bytes)
}
fn read_text(path: &Path, cancel: &CancellationToken) -> Result<String> {
    let bytes = read_bytes(path, MAX_FILE_BYTES, cancel)?;
    ensure!(!bytes.contains(&0), "binary files are unsupported");
    String::from_utf8(bytes).context("file must be UTF-8 text")
}
fn prefix(text: &str, max: usize) -> &str {
    let mut end = text.len().min(max);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

fn read_file(ws: &Workspace, input: &Value, cancel: &CancellationToken) -> Result<Value> {
    let obj = fields(input, &["path", "offset", "limit"], &["path"])?;
    let offset = number(obj, "offset", 0, 0, usize::MAX as u64)?;
    let limit = number(obj, "limit", 200, 1, 2000)?;
    let path = ws.resolve(string(obj, "path")?, false)?;
    ws.policy.require(&path)?;
    let text = read_text(&path, cancel)?;
    let lines: Vec<_> = text.split_inclusive('\n').collect();
    let mut content = String::new();
    let mut count = 0;
    let mut clipped = false;
    for line in lines.iter().skip(offset).take(limit) {
        check_cancel(cancel)?;
        let chunk = prefix(line, MAX_READ_BYTES - content.len());
        content.push_str(chunk);
        count += 1;
        if chunk.len() < line.len() {
            clipped = true;
            break;
        }
    }
    Ok(
        json!({"path":ws.display(&path),"sha256":crate::changes::hash(&text),"content":content,"offset":offset,"linesRead":count,
        "totalLines":lines.len(),"truncated":clipped || offset.saturating_add(count) < lines.len()}),
    )
}

fn skipped(path: &Path) -> bool {
    path.components().any(|c| {
        SKIP_DIRS
            .iter()
            .any(|skip| c.as_os_str().to_string_lossy().eq_ignore_ascii_case(skip))
    })
}
fn text_sample(path: &Path) -> Result<bool> {
    let mut file = open_read(path)?;
    let mut buffer = [0u8; 8192];
    let n = file.read(&mut buffer)?;
    if buffer[..n].contains(&0) {
        return Ok(false);
    }
    Ok(match std::str::from_utf8(&buffer[..n]) {
        Ok(_) => true,
        Err(e) => e.error_len().is_none() && n == buffer.len(),
    })
}

fn list_files(ws: &Workspace, input: &Value, cancel: &CancellationToken) -> Result<Value> {
    let obj = fields(input, &["path", "recursive"], &[])?;
    let recursive = match obj.get("recursive") {
        None => false,
        Some(v) => v.as_bool().context("recursive must be a boolean")?,
    };
    let path = ws.resolve(optional_path(obj)?, false)?;
    ensure!(path.is_dir(), "list_files path must be a directory");
    let mut entries = Vec::new();
    let mut output_bytes = 0;
    let mut visited = 0;
    let mut truncated = false;
    let mut walker = WalkDir::new(&path)
        .min_depth(1)
        .max_depth(if recursive { MAX_WALK_DEPTH } else { 1 })
        .max_open(MAX_WALK_DEPTH + 1)
        .follow_links(false)
        .into_iter();
    if !skipped(Path::new(&ws.display(&path))) {
        while let Some(entry) = walker.next() {
            check_cancel(cancel)?;
            visited += 1;
            if visited > MAX_VISITED || entries.len() >= MAX_RESULTS {
                truncated = true;
                break;
            }
            let entry = entry.context("cannot list workspace entry")?;
            if is_skipped_entry(ws, entry.path()) {
                if entry.file_type().is_dir() {
                    walker.skip_current_dir();
                }
                continue;
            }
            if recursive && entry.depth() == MAX_WALK_DEPTH && entry.file_type().is_dir() {
                truncated = true;
            }
            let rel = ws.display(entry.path());
            let checked = match ws.resolve(&rel, false) {
                Ok(p) => p,
                Err(_) => continue,
            };
            let meta = fs::symlink_metadata(&checked)?;
            if meta.is_dir() || (meta.is_file() && text_sample(&checked)?) {
                let result = json!({"path":rel,"type":if meta.is_dir(){"directory"}else{"file"}});
                let cost = serde_json::to_vec(&result)?.len();
                if output_bytes + cost > MAX_READ_BYTES {
                    truncated = true;
                    break;
                }
                output_bytes += cost;
                entries.push(result);
            }
        }
    }
    Ok(json!({"path":ws.display(&path),"entries":entries,"truncated":truncated}))
}
fn is_skipped_entry(ws: &Workspace, path: &Path) -> bool {
    if !ws.policy.allowed(path, path.is_dir()) {
        return true;
    }
    if skipped(Path::new(&ws.display(path))) {
        return true;
    }
    fs::symlink_metadata(path)
        .map(|m| is_link(&m))
        .unwrap_or(false)
}

fn search(ws: &Workspace, input: &Value, cancel: &CancellationToken) -> Result<Value> {
    let obj = fields(input, &["pattern", "path", "maxResults"], &["pattern"])?;
    let pattern = string(obj, "pattern")?;
    ensure!(pattern.len() <= 8192, "pattern exceeds 8192 bytes");
    let regex = RegexBuilder::new(pattern)
        .size_limit(2 * 1024 * 1024)
        .dfa_size_limit(2 * 1024 * 1024)
        .build()
        .context("invalid or oversized regex")?;
    let max = number(obj, "maxResults", 100, 1, MAX_RESULTS as u64)?;
    let path = ws.resolve(optional_path(obj)?, false)?;
    let mut matches = Vec::new();
    let mut bytes: usize = 0;
    let mut output = 0;
    let mut visited = 0;
    let mut truncated = false;
    let mut walker = WalkDir::new(&path)
        .follow_links(false)
        .max_depth(MAX_WALK_DEPTH)
        .max_open(MAX_WALK_DEPTH + 1)
        .into_iter();
    'files: while let Some(entry) = walker.next() {
        check_cancel(cancel)?;
        visited += 1;
        if visited > MAX_VISITED {
            truncated = true;
            break;
        }
        let entry = entry.context("cannot search workspace entry")?;
        if is_skipped_entry(ws, entry.path()) {
            if entry.file_type().is_dir() {
                walker.skip_current_dir();
            }
            continue;
        }
        if !entry.file_type().is_file() {
            if entry.depth() == MAX_WALK_DEPTH && entry.file_type().is_dir() {
                truncated = true;
            }
            continue;
        }
        let rel = ws.display(entry.path());
        let checked = match ws.resolve(&rel, false) {
            Ok(p) => p,
            Err(_) => continue,
        };
        let size = fs::symlink_metadata(&checked)?.len() as usize;
        if size > MAX_FILE_BYTES {
            continue;
        }
        if bytes.saturating_add(size) > MAX_SCAN_BYTES {
            truncated = true;
            break;
        }
        let data = read_bytes(&checked, MAX_FILE_BYTES, cancel)?;
        if bytes + data.len() > MAX_SCAN_BYTES {
            truncated = true;
            break;
        }
        bytes += data.len();
        if data.contains(&0) {
            continue;
        }
        let text = match std::str::from_utf8(&data) {
            Ok(t) => t,
            Err(_) => continue,
        };
        for (line_number, line) in text.lines().enumerate() {
            check_cancel(cancel)?;
            if !regex.is_match(line) {
                continue;
            }
            let excerpt = prefix(line, 2048);
            let result = json!({"path":rel,"line":line_number+1,"text":excerpt,"lineTruncated":excerpt.len()<line.len()});
            let cost = serde_json::to_vec(&result)?.len();
            if matches.len() == max || output + cost > MAX_READ_BYTES {
                truncated = true;
                break 'files;
            }
            output += cost;
            matches.push(result);
        }
    }
    Ok(json!({"matches":matches,"truncated":truncated,"scannedBytes":bytes}))
}

struct Change {
    path: PathBuf,
    before: Option<String>,
    after: String,
}
struct Staged {
    path: PathBuf,
    temp: PathBuf,
    committed: bool,
    temp_present: bool,
}
impl Drop for Staged {
    fn drop(&mut self) {
        if self.temp_present {
            // Only remove the unique temporary file created by this invocation.
            let _ = fs::remove_file(&self.temp);
        }
    }
}
fn existing_text(path: &Path, cancel: &CancellationToken) -> Result<Option<String>> {
    match fs::symlink_metadata(path) {
        Ok(meta) => {
            ensure!(
                !is_link(&meta) && meta.is_file(),
                "destination must be a regular file"
            );
            Ok(Some(read_text(path, cancel)?))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}
fn stage(ws: &Workspace, change: &Change, cancel: &CancellationToken) -> Result<Staged> {
    check_cancel(cancel)?;
    let rel = ws.display(&change.path);
    ensure!(
        ws.resolve(&rel, true)? == change.path,
        "destination changed"
    );
    let parent = change.path.parent().context("file must have a parent")?;
    ensure!(parent.is_dir(), "parent must be an existing directory");
    #[cfg(windows)]
    let security = if change.before.is_some() {
        Some(file_dacl(&change.path)?)
    } else {
        None
    };
    for _ in 0..100 {
        let temp = parent.join(format!(
            ".trex-{}-{}.tmp",
            std::process::id(),
            TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        #[cfg(unix)]
        let opened = {
            use std::os::unix::fs::OpenOptionsExt;
            let mut opts = OpenOptions::new();
            opts.write(true).create_new(true);
            opts.mode(0o600);
            opts.open(&temp)
        };
        #[cfg(windows)]
        let opened = create_staging_file(&temp, security.as_deref());
        #[cfg(not(any(unix, windows)))]
        let opened = OpenOptions::new().write(true).create_new(true).open(&temp);
        let mut file = match opened {
            Ok(f) => f,
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e).context("cannot stage replacement"),
        };
        let staged = Staged {
            path: change.path.clone(),
            temp,
            committed: false,
            temp_present: true,
        };
        let staged_result = (|| -> Result<()> {
            for chunk in change.after.as_bytes().chunks(8192) {
                check_cancel(cancel)?;
                file.write_all(chunk)?;
            }
            #[cfg(not(windows))]
            if change.before.is_some() {
                file.set_permissions(fs::metadata(&change.path)?.permissions())?;
            }
            file.sync_all()?;
            Ok(())
        })();
        // Windows staging is exclusive: release the handle before cleanup on
        // cancellation or I/O failure, as well as before publication.
        drop(file);
        staged_result?;
        return Ok(staged);
    }
    bail!("cannot allocate unique staging file")
}
fn replace(staged: &mut Staged, new_file: bool) -> Result<()> {
    #[cfg(windows)]
    {
        publish_windows(&staged.temp, &staged.path, new_file)?;
        staged.committed = true;
        staged.temp_present = false;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        if new_file {
            // A hard link publishes a fully written file without clobbering a file
            // created after validation. Both paths are in the same checked directory.
            fs::hard_link(&staged.temp, &staged.path).context("cannot publish new file")?;
            staged.committed = true;
            fs::remove_file(&staged.temp).context("file created but staging cleanup failed")?;
        } else {
            atomic_replace(&staged.temp, &staged.path)?;
        }
        staged.committed = true;
        staged.temp_present = false;
        Ok(())
    }
}
#[cfg(not(windows))]
fn atomic_replace(from: &Path, to: &Path) -> Result<()> {
    fs::rename(from, to).context("cannot atomically replace file")
}
#[cfg(windows)]
fn publish_windows(from: &Path, to: &Path, new_file: bool) -> Result<()> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn MoveFileExW(existing: *const u16, replacement: *const u16, flags: u32) -> i32;
    }
    let from: Vec<u16> = from.as_os_str().encode_wide().chain(Some(0)).collect();
    let to: Vec<u16> = to.as_os_str().encode_wide().chain(Some(0)).collect();
    // Staging already carries the checked destination DACL. Same-volume rename
    // avoids ReplaceFile's destructive intermediate failure states. No replace
    // flag for new files: a concurrently created destination is never clobbered.
    let result = unsafe {
        MoveFileExW(
            from.as_ptr(),
            to.as_ptr(),
            0x8 | if new_file { 0 } else { 1 },
        )
    };
    ensure!(
        result != 0,
        "cannot atomically replace file: {}",
        std::io::Error::last_os_error()
    );
    Ok(())
}

#[cfg(windows)]
fn file_dacl(existing: &Path) -> Result<Vec<u32>> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "advapi32")]
    unsafe extern "system" {
        fn GetFileSecurityW(
            path: *const u16,
            info: u32,
            descriptor: *mut std::ffi::c_void,
            length: u32,
            needed: *mut u32,
        ) -> i32;
    }
    let existing: Vec<u16> = existing.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut needed = 0;
    unsafe {
        GetFileSecurityW(existing.as_ptr(), 4, std::ptr::null_mut(), 0, &mut needed);
    }
    ensure!(
        needed > 0 && needed <= 1024 * 1024,
        "cannot determine destination security descriptor"
    );
    let mut descriptor = vec![0u32; (needed as usize).div_ceil(4)];
    ensure!(
        unsafe {
            GetFileSecurityW(
                existing.as_ptr(),
                4,
                descriptor.as_mut_ptr().cast(),
                needed,
                &mut needed,
            )
        } != 0,
        "cannot read destination ACL: {}",
        std::io::Error::last_os_error()
    );
    Ok(descriptor)
}

#[cfg(windows)]
fn create_staging_file(path: &Path, descriptor: Option<&[u32]>) -> std::io::Result<File> {
    use std::{
        ffi::c_void,
        os::windows::{ffi::OsStrExt, io::FromRawHandle},
    };
    #[repr(C)]
    struct SecurityAttributes {
        length: u32,
        descriptor: *const c_void,
        inherit_handle: i32,
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn CreateFileW(
            path: *const u16,
            access: u32,
            share: u32,
            security: *const SecurityAttributes,
            disposition: u32,
            flags: u32,
            template: *mut c_void,
        ) -> *mut c_void;
    }
    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let security = SecurityAttributes {
        length: std::mem::size_of::<SecurityAttributes>() as u32,
        descriptor: descriptor.map_or(std::ptr::null(), |d| d.as_ptr().cast()),
        inherit_handle: 0,
    };
    // Security is supplied atomically with CREATE_NEW. Exclusive sharing also
    // prevents any reader from retaining a handle while content is staged.
    let raw = unsafe {
        CreateFileW(
            wide.as_ptr(),
            0x4000_0000,
            0,
            &security,
            1,
            0x80,
            std::ptr::null_mut(),
        )
    };
    if raw == -1isize as *mut c_void {
        return Err(std::io::Error::last_os_error());
    }
    Ok(unsafe { File::from_raw_handle(raw) })
}
fn commit(ws: &Workspace, changes: &[Change], cancel: &CancellationToken) -> Result<()> {
    let _refresh = ws.refresh_policy_after(changes.iter().map(|c| c.path.as_path()));
    for change in changes {
        check_cancel(cancel)?;
        ws.resolve(&ws.display(&change.path), true)?;
        ensure!(
            existing_text(&change.path, cancel)? == change.before,
            "patch precondition failed: {}",
            ws.display(&change.path)
        );
    }
    let mut staged = Vec::new();
    for change in changes {
        staged.push(stage(ws, change, cancel)?);
    }
    // Recheck every precondition after staging, before publishing any file.
    for change in changes {
        check_cancel(cancel)?;
        ws.resolve(&ws.display(&change.path), true)?;
        ensure!(
            existing_text(&change.path, cancel)? == change.before,
            "destination changed while staging: {}",
            ws.display(&change.path)
        );
    }
    check_cancel(cancel)?;
    // Finish a short commit once it starts, so cancellation cannot intentionally
    // stop halfway through. OS errors still report the exact committed prefix.
    for (index, (stage, change)) in staged.iter_mut().zip(changes).enumerate() {
        let result = ws
            .resolve(&ws.display(&change.path), true)
            .and_then(|_| replace(stage, change.before.is_none()));
        if let Err(error) = result {
            let committed: Vec<_> = changes[..index + usize::from(stage.committed)]
                .iter()
                .map(|c| ws.display(&c.path))
                .collect();
            return Err(anyhow!(
                "patch commit failed at {}; already committed {:?}: {error:#}",
                ws.display(&change.path),
                committed
            )
            .context(ToolExecutionUncertain(
                "File replacement stopped during commit".into(),
            )));
        }
    }
    Ok(())
}
fn write_file(ws: &Workspace, input: &Value, cancel: &CancellationToken) -> Result<Value> {
    let obj = fields(input, &["path", "content"], &["path", "content"])?;
    let content = string(obj, "content")?;
    ensure!(
        content.len() <= MAX_FILE_BYTES && !content.contains('\0'),
        "content must be text of at most 1 MiB"
    );
    let path = ws.resolve(string(obj, "path")?, true)?;
    ws.policy.require(&path)?;
    let change = Change {
        before: ws.before(&path, cancel)?,
        path,
        after: content.to_owned(),
    };
    commit(ws, std::slice::from_ref(&change), cancel)?;
    Ok(json!({"path":ws.display(&change.path),"bytesWritten":content.len()}))
}
fn edited_text(before: &str, input: &Value) -> Result<String> {
    fields(
        input,
        &["path", "oldText", "newText", "expectedHash"],
        &["path", "oldText", "newText"],
    )?;
    let old = input["oldText"].as_str().context("oldText must be text")?;
    let new = input["newText"].as_str().context("newText must be text")?;
    ensure!(
        !old.is_empty() && old.len() <= MAX_FILE_BYTES && new.len() <= MAX_FILE_BYTES,
        "invalid edit size"
    );
    ensure!(
        before.match_indices(old).count() == 1,
        "oldText must match exactly once; include more surrounding context"
    );
    if let Some(hash) = input.get("expectedHash") {
        ensure!(
            hash.as_str() == Some(crate::changes::hash(before).as_str()),
            "file changed since it was read"
        );
    }
    let after = before.replacen(old, new, 1);
    ensure!(after.len() <= MAX_FILE_BYTES, "edited file exceeds 1 MiB");
    Ok(after)
}
fn edit_file(ws: &Workspace, input: &Value, cancel: &CancellationToken) -> Result<Value> {
    let path = ws.resolve(input["path"].as_str().context("path is required")?, false)?;
    ws.policy.require(&path)?;
    let before = ws.before(&path, cancel)?.context("edit target missing")?;
    let after = edited_text(&before, input)?;
    commit(
        ws,
        &[Change {
            path: path.clone(),
            before: Some(before),
            after: after.clone(),
        }],
        cancel,
    )?;
    Ok(
        json!({"path":ws.display(&path),"sha256":crate::changes::hash(&after),"bytesWritten":after.len()}),
    )
}
pub(crate) fn execute_sync_restore(
    cwd: &Path,
    path: &str,
    text: &str,
    privacy: &crate::settings::PrivacySettings,
) -> Result<()> {
    let ws = Workspace::configured(cwd, privacy.clone())?;
    write_file(
        &ws,
        &json!({"path":path,"content":text}),
        &CancellationToken::new(),
    )?;
    Ok(())
}
fn preview_file_changes(
    cwd: &Path,
    name: &str,
    input: &Value,
    privacy: &crate::settings::PrivacySettings,
) -> Result<Vec<crate::changes::FileChange>> {
    use crate::changes::FileChange;
    if !matches!(
        name,
        "write_file" | "apply_patch" | "edit_file" | "rename_file" | "remove_file"
    ) {
        return Ok(vec![]);
    }
    let ws = Workspace::configured(cwd, privacy.clone())?;
    let cancel = CancellationToken::new();
    let read = |raw: &str| -> Result<(String, Option<String>)> {
        let path = ws.resolve(raw, true)?;
        ws.require(&path)?;
        let content = existing_text(&path, &cancel)?;
        Ok((ws.display(&path), content))
    };
    match name {
        "apply_patch" => {
            let patch: Value =
                serde_json::from_str(input["patch"].as_str().context("patch required")?)?;
            let files = patch["files"].as_array().context("patch files required")?;
            ensure!(files.len() <= MAX_PATCH_FILES, "too many patch files");
            files
                .iter()
                .map(|file| {
                    let (path, before) =
                        read(file["path"].as_str().context("patch path required")?)?;
                    Ok(FileChange {
                        path,
                        before,
                        after: Some(
                            file["after"]
                                .as_str()
                                .context("patch after text required")?
                                .into(),
                        ),
                    })
                })
                .collect()
        }
        _ => {
            let (path, before) = read(input["path"].as_str().context("path required")?)?;
            if name == "rename_file" {
                let (destination, other) = read(
                    input["destination"]
                        .as_str()
                        .context("destination required")?,
                )?;
                ensure!(other.is_none(), "destination exists");
                Ok(vec![
                    FileChange {
                        path,
                        before: before.clone(),
                        after: None,
                    },
                    FileChange {
                        path: destination,
                        before: None,
                        after: before,
                    },
                ])
            } else {
                let after = match name {
                    "write_file" => Some(
                        input["content"]
                            .as_str()
                            .context("content required")?
                            .into(),
                    ),
                    "edit_file" => Some(edited_text(
                        before.as_deref().context("edit target missing")?,
                        input,
                    )?),
                    _ => None,
                };
                Ok(vec![FileChange {
                    path,
                    before,
                    after,
                }])
            }
        }
    }
}
pub(crate) fn find_program(name: &str) -> Option<PathBuf> {
    let executable = if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.into()
    };
    std::env::var_os("PATH")
        .into_iter()
        .flat_map(|p| std::env::split_paths(&p).collect::<Vec<_>>())
        .filter(|p| p.is_absolute())
        .map(|p| p.join(&executable))
        .find(|p| p.is_file())
}
async fn git_run(
    cwd: &Path,
    args: &[String],
    cancel: &CancellationToken,
    settings: &crate::settings::Settings,
) -> Result<(Vec<u8>, bool)> {
    let mut command = Command::new(find_program("git").context("Git is not installed")?);
    command.args([
        "--no-optional-locks",
        "--literal-pathspecs",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.untrackedCache=false",
    ]);
    command
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    crate::settings::configure_environment(&mut command, &settings.shell);
    let (mut child, mut guard) = spawn_owned_command(command)?;
    let stdout = child.stdout.take().context("Git stdout unavailable")?;
    let result = tokio::select! {_=cancel.cancelled()=>None,result=tokio::time::timeout(Duration::from_secs(20),async{let(status,output)=tokio::join!(child.wait(),capture(stdout));Ok::<_,anyhow::Error>((status?,output?))})=>Some(result)};
    match result {
        Some(Ok(Ok((status, output)))) => {
            ensure!(status.success(), "Git inspection failed");
            Ok(output)
        }
        _ => {
            stop_process(&mut child, &mut guard).await;
            bail!("Git inspection interrupted or timed out")
        }
    }
}
async fn git_read(
    cwd: &Path,
    name: &str,
    input: &Value,
    cancel: CancellationToken,
    settings: &crate::settings::Settings,
) -> Result<Value> {
    let ws = Workspace::configured(cwd, settings.privacy.clone())?;
    if name == "git_status" {
        fields(input, &[], &[])?;
        let (bytes, truncated) = git_run(
            cwd,
            &[
                "status".into(),
                "--porcelain=v1".into(),
                "--untracked-files=normal".into(),
            ],
            &cancel,
            settings,
        )
        .await?;
        return Ok(json!({"output":String::from_utf8_lossy(&bytes),"truncated":truncated}));
    }
    let obj = fields(input, &["path", "staged"], &[])?;
    ensure!(
        obj.get("staged").is_none_or(Value::is_boolean),
        "staged must be a boolean"
    );
    let mut args: Vec<String> = ["diff", "--no-ext-diff", "--no-textconv", "--no-color"]
        .iter()
        .map(|s| (*s).into())
        .collect();
    if obj.get("staged") == Some(&json!(true)) {
        args.push("--cached".into());
    }
    let mut paths = Vec::new();
    if let Some(path) = obj.get("path") {
        let path = ws.resolve(path.as_str().context("path must be text")?, true)?;
        ws.require(&path)?;
        paths.push(ws.display(&path));
    } else {
        let mut names = args.clone();
        names.extend(["--name-only".into(), "-z".into(), "--".into()]);
        let (bytes, truncated) = git_run(cwd, &names, &cancel, settings).await?;
        ensure!(
            !truncated,
            "too many changed files; inspect a specific path"
        );
        for raw in bytes.split(|b| *b == 0).filter(|s| !s.is_empty()) {
            let raw =
                std::str::from_utf8(raw).context("Git path is not UTF-8; inspect it manually")?;
            if let Ok(path) = ws.resolve(raw, true) {
                if ws.require(&path).is_ok() {
                    paths.push(ws.display(&path));
                }
            }
            ensure!(
                paths.len() <= 512,
                "too many changed files; inspect a specific path"
            );
        }
    }
    if paths.is_empty() {
        return Ok(json!({"output":"","truncated":false,"privacyFiltered":true}));
    }
    args.push("--".into());
    args.extend(paths);
    let (bytes, truncated) = git_run(cwd, &args, &cancel, settings).await?;
    Ok(
        json!({"output":String::from_utf8_lossy(&bytes),"truncated":truncated,"privacyFiltered":true}),
    )
}
fn apply_patch(ws: &Workspace, input: &Value, cancel: &CancellationToken) -> Result<Value> {
    let obj = fields(input, &["patch"], &["patch"])?;
    let patch = string(obj, "patch")?;
    ensure!(patch.len() <= MAX_PATCH_BYTES, "patch exceeds 4 MiB limit");
    let parsed: Value = serde_json::from_str(patch)
        .context("patch must use the documented exact-content JSON format")?;
    let patch_obj = fields(&parsed, &["files"], &["files"])?;
    let files = patch_obj["files"]
        .as_array()
        .context("files must be an array")?;
    ensure!(
        !files.is_empty() && files.len() <= MAX_PATCH_FILES,
        "patch must contain 1..32 files"
    );
    let mut changes = Vec::new();
    let mut seen = HashSet::new();
    for file in files {
        check_cancel(cancel)?;
        let obj = fields(
            file,
            &["path", "before", "after"],
            &["path", "before", "after"],
        )?;
        let path = ws.resolve(string(obj, "path")?, true)?;
        ws.policy.require(&path)?;
        let key = if path.exists() {
            fs::canonicalize(&path)?.to_string_lossy().into_owned()
        } else {
            fs::canonicalize(path.parent().context("missing destination parent")?)?
                .join(path.file_name().context("missing destination filename")?)
                .to_string_lossy()
                .into_owned()
        };
        #[cfg(windows)]
        let key = key.to_lowercase();
        ensure!(seen.insert(key), "duplicate patch path");
        let before = if obj["before"].is_null() {
            None
        } else {
            Some(string(obj, "before")?.to_owned())
        };
        let after = string(obj, "after")?;
        ensure!(
            after.len() <= MAX_FILE_BYTES && !after.contains('\0'),
            "replacement must be text of at most 1 MiB"
        );
        if let Some(text) = &before {
            ensure!(
                text.len() <= MAX_FILE_BYTES && !text.contains('\0'),
                "before must be text of at most 1 MiB"
            );
        }
        changes.push(Change {
            path,
            before,
            after: after.to_owned(),
        });
    }
    commit(ws, &changes, cancel)?;
    Ok(
        json!({"files":changes.iter().map(|c| json!({"path":ws.display(&c.path),"bytesWritten":c.after.len()})).collect::<Vec<_>>()}),
    )
}

/// Bounded capture of one stream: the first quarter and the last three
/// quarters of MAX_OUTPUT_BYTES / 2. Build and test failures are usually
/// reported at the end, so the tail is never dropped for the head.
async fn capture(mut pipe: impl tokio::io::AsyncRead + Unpin) -> Result<(Vec<u8>, bool)> {
    const MARKER_RESERVE: usize = 64;
    let limit = MAX_OUTPUT_BYTES / 2;
    let head_limit = limit / 4;
    let tail_limit = limit - head_limit - MARKER_RESERVE;
    let mut head = Vec::new();
    let mut tail = std::collections::VecDeque::<u8>::new();
    let mut total = 0usize;
    let mut buffer = [0u8; 8192];
    loop {
        let n = pipe.read(&mut buffer).await?;
        if n == 0 {
            break;
        }
        total = total.saturating_add(n);
        let take = n.min(head_limit - head.len());
        head.extend_from_slice(&buffer[..take]);
        tail.extend(&buffer[take..n]);
        if tail.len() > tail_limit {
            let excess = tail.len() - tail_limit;
            tail.drain(..excess);
        }
    }
    let omitted = total - head.len() - tail.len();
    if omitted == 0 {
        head.extend(tail);
        return Ok((head, false));
    }
    // Cut both parts at UTF-8 boundaries (text output stays valid text).
    if let Err(error) = std::str::from_utf8(&head) {
        if error.error_len().is_none() {
            head.truncate(error.valid_up_to());
        }
    }
    while tail.front().is_some_and(|byte| byte & 0xc0 == 0x80) {
        tail.pop_front();
    }
    let omitted = total - head.len() - tail.len();
    head.extend_from_slice(format!("\n[... {omitted} bytes omitted ...]\n").as_bytes());
    head.extend(tail);
    Ok((head, true))
}

#[cfg(windows)]
fn system_exe(relative: &str) -> Result<PathBuf> {
    let root = std::env::var_os("SystemRoot").context("SystemRoot is unavailable")?;
    Ok(PathBuf::from(root).join("System32").join(relative))
}

#[cfg(windows)]
mod windows_job {
    use super::*;
    use std::{
        ffi::c_void,
        os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
    };
    #[repr(C)]
    #[derive(Default)]
    struct BasicLimits {
        process_time: i64,
        job_time: i64,
        flags: u32,
        min_working_set: usize,
        max_working_set: usize,
        active_processes: u32,
        affinity: usize,
        priority: u32,
        scheduling: u32,
    }
    #[repr(C)]
    #[derive(Default)]
    struct ExtendedLimits {
        basic: BasicLimits,
        io_counters: [u64; 6],
        process_memory: usize,
        job_memory: usize,
        peak_process_memory: usize,
        peak_job_memory: usize,
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn CreateJobObjectW(attributes: *const c_void, name: *const u16) -> *mut c_void;
        fn SetInformationJobObject(
            job: *mut c_void,
            class: i32,
            info: *const c_void,
            size: u32,
        ) -> i32;
        fn AssignProcessToJobObject(job: *mut c_void, process: *mut c_void) -> i32;
        fn TerminateJobObject(job: *mut c_void, code: u32) -> i32;
    }
    #[link(name = "ntdll")]
    unsafe extern "system" {
        fn NtResumeProcess(process: *mut c_void) -> i32;
    }

    pub(super) struct Job(OwnedHandle);
    impl Job {
        pub(super) fn new() -> Result<Self> {
            let raw = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
            ensure!(
                !raw.is_null(),
                "cannot create shell job: {}",
                std::io::Error::last_os_error()
            );
            let job = Self(unsafe { OwnedHandle::from_raw_handle(raw) });
            let mut limits = ExtendedLimits::default();
            limits.basic.flags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            ensure!(
                unsafe {
                    SetInformationJobObject(
                        raw,
                        9,
                        (&limits as *const ExtendedLimits).cast(),
                        std::mem::size_of::<ExtendedLimits>() as u32,
                    )
                } != 0,
                "cannot configure shell job: {}",
                std::io::Error::last_os_error()
            );
            Ok(job)
        }
        pub(super) fn attach_and_resume(&self, child: &tokio::process::Child) -> Result<()> {
            let process = child.raw_handle().context("missing shell process handle")?;
            ensure!(
                unsafe { AssignProcessToJobObject(self.0.as_raw_handle(), process) } != 0,
                "cannot contain shell process: {}",
                std::io::Error::last_os_error()
            );
            // Spawn suspended so no child can escape before job assignment.
            // Tokio owns the process handle, but does not expose its main thread.
            ensure!(
                unsafe { NtResumeProcess(process) } >= 0,
                "cannot resume contained shell process"
            );
            Ok(())
        }
        pub(super) fn attach_raw(&self, process: std::os::windows::io::RawHandle) -> Result<()> {
            ensure!(
                unsafe { AssignProcessToJobObject(self.0.as_raw_handle(), process) } != 0,
                "cannot contain interactive process"
            );
            Ok(())
        }
        pub(super) fn terminate(&self) {
            unsafe {
                TerminateJobObject(self.0.as_raw_handle(), 1);
            }
        }
    }
}

#[cfg(unix)]
fn kill_group(pid: Option<u32>) {
    unsafe extern "C" {
        fn kill(pid: i32, signal: i32) -> i32;
    }
    if let Some(pid) = pid.filter(|pid| *pid <= i32::MAX as u32) {
        unsafe {
            kill(-(pid as i32), 9);
        }
    }
}

/// Closing the Windows job or killing the Unix group also handles dropped futures.
pub(crate) struct ProcessTreeGuard {
    pid: Option<u32>,
    #[cfg(windows)]
    job: windows_job::Job,
}
impl ProcessTreeGuard {
    pub(crate) fn for_pty(child: &dyn portable_pty::Child) -> Result<Self> {
        #[cfg(windows)]
        {
            let job = windows_job::Job::new()?;
            job.attach_raw(
                child
                    .as_raw_handle()
                    .context("interactive process handle unavailable")?,
            )?;
            Ok(Self {
                pid: child.process_id(),
                job,
            })
        }
        #[cfg(not(windows))]
        {
            Ok(Self {
                pid: child.process_id(),
            })
        }
    }
    pub(crate) fn terminate(&mut self) {
        #[cfg(windows)]
        self.job.terminate();
        #[cfg(unix)]
        kill_group(self.pid);
        self.pid = None;
    }
}
impl Drop for ProcessTreeGuard {
    fn drop(&mut self) {
        #[cfg(unix)]
        kill_group(self.pid);
    }
}
pub(crate) async fn stop_process(child: &mut tokio::process::Child, guard: &mut ProcessTreeGuard) {
    #[cfg(windows)]
    if let Some(pid) = child.id() {
        if let Ok(taskkill) = system_exe("taskkill.exe") {
            let mut command = Command::new(taskkill);
            command
                .args(["/PID", &pid.to_string(), "/T", "/F"])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .kill_on_drop(true)
                .creation_flags(0x0800_0000);
            let _ = tokio::time::timeout(Duration::from_secs(5), command.status()).await;
        }
    }
    #[cfg(windows)]
    guard.job.terminate();
    #[cfg(unix)]
    kill_group(guard.pid);
    let _ = child.start_kill();
    let _ = tokio::time::timeout(Duration::from_secs(5), child.wait()).await;
    guard.pid = None;
}
pub(crate) fn spawn_shell_configured(
    cwd: &Path,
    text: &str,
    settings: &crate::settings::ShellSettings,
    interactive: bool,
) -> Result<(tokio::process::Child, ProcessTreeGuard)> {
    let ws = Workspace::new(cwd)?;
    #[cfg(windows)]
    let mut command = {
        let mut cmd = Command::new(
            settings
                .executable
                .clone()
                .unwrap_or(system_exe("WindowsPowerShell/v1.0/powershell.exe")?),
        );
        let utf8 = format!("[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false); [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [Console]::OutputEncoding; {text}");
        cmd.args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            &utf8,
        ]);
        cmd.creation_flags(0x0800_0000 | 0x4); // CREATE_NO_WINDOW | CREATE_SUSPENDED
        cmd
    };
    #[cfg(not(windows))]
    let mut command = {
        let mut cmd = Command::new(
            settings
                .executable
                .as_deref()
                .unwrap_or(Path::new("/bin/sh")),
        );
        cmd.args(["-c", text]);
        #[cfg(unix)]
        cmd.process_group(0);
        cmd
    };
    command
        .current_dir(&ws.root)
        .stdin(if interactive {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    crate::settings::configure_environment(&mut command, settings);
    #[cfg(windows)]
    let job = windows_job::Job::new()?;
    let child = command.spawn().context("cannot spawn shell")?;
    let guard = ProcessTreeGuard {
        pid: child.id(),
        #[cfg(windows)]
        job,
    };
    #[cfg(windows)]
    guard.job.attach_and_resume(&child)?;
    Ok((child, guard))
}

pub(crate) async fn shell(cwd: &Path, input: &Value, cancel: CancellationToken) -> Result<Value> {
    shell_configured(
        cwd,
        input,
        cancel,
        &crate::settings::ShellSettings::default(),
    )
    .await
}
pub(crate) fn spawn_owned_command(
    mut command: Command,
) -> Result<(tokio::process::Child, ProcessTreeGuard)> {
    command.kill_on_drop(true);
    #[cfg(windows)]
    {
        command.creation_flags(0x0800_0000 | 0x4);
    }
    #[cfg(unix)]
    command.process_group(0);
    #[cfg(windows)]
    let job = windows_job::Job::new()?;
    let child = command.spawn()?;
    let guard = ProcessTreeGuard {
        pid: child.id(),
        #[cfg(windows)]
        job,
    };
    #[cfg(windows)]
    guard.job.attach_and_resume(&child)?;
    Ok((child, guard))
}
pub(crate) async fn shell_configured(
    cwd: &Path,
    input: &Value,
    cancel: CancellationToken,
    settings: &crate::settings::ShellSettings,
) -> Result<Value> {
    let obj = fields(input, &["command", "timeoutMs", "background"], &["command"])?;
    let text = string(obj, "command")?;
    ensure!(
        !text.trim().is_empty() && text.len() <= 32 * 1024 && !text.contains('\0'),
        "command must contain 1..32768 bytes without NUL"
    );
    ensure!(
        obj.get("background").is_none_or(|v| v == false),
        "background execution requires the session tool registry"
    );
    let timeout = number(obj, "timeoutMs", 60_000, 1, 600_000)?;
    check_cancel(&cancel)?;
    let (mut child, mut guard) = spawn_shell_configured(cwd, text, settings, false)?;
    let stdout = child.stdout.take().context("missing stdout pipe")?;
    let stderr = child.stderr.take().context("missing stderr pipe")?;
    let result = {
        let run = async {
            let (status, stdout, stderr) =
                tokio::join!(child.wait(), capture(stdout), capture(stderr));
            Ok::<_, anyhow::Error>((status?, stdout?, stderr?))
        };
        tokio::select! {
            biased;
            _ = cancel.cancelled() => Err(anyhow!("shell execution cancelled")),
            _ = tokio::time::sleep(Duration::from_millis(timeout as u64)) => Err(anyhow!("shell timed out after {timeout} ms")),
            result = run => result,
        }
    };
    match result {
        Ok((status, (stdout, out_truncated), (stderr, err_truncated))) => {
            guard.pid = None;
            let stdout = String::from_utf8_lossy(&stdout);
            let stderr = String::from_utf8_lossy(&stderr);
            // Lossy decoding of binary output can grow; keep head and tail.
            let stdout_text = crate::context::head_tail(&stdout, MAX_OUTPUT_BYTES / 2, 25, "");
            let stderr_text = crate::context::head_tail(&stderr, MAX_OUTPUT_BYTES / 2, 25, "");
            Ok(
                json!({"exitCode":status.code(),"success":status.success(),"isError":!status.success(),
                "stdoutTruncated":out_truncated || stdout_text.len() != stdout.len(),
                "stderrTruncated":err_truncated || stderr_text.len() != stderr.len(),
                "stdout":stdout_text,"stderr":stderr_text}),
            )
        }
        Err(error) => {
            stop_process(&mut child, &mut guard).await;
            let reason = error.to_string();
            Err(error.context(ToolExecutionUncertain(reason)))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;
    #[tokio::test]
    async fn plan_updates_are_read_only_bounded_and_validated_before_acceptance() {
        let input = json!({"plan":[{"step":"Inspect","status":"completed"},{"step":"Validate","status":"in_progress"}]});
        let registry = ToolRegistry::new(None);
        assert!(registry
            .definitions("plan")
            .iter()
            .any(|tool| tool["function"]["name"] == "update_plan"));
        assert!(!is_mutating("update_plan"));
        let result = execute(
            Path::new("nonexistent-plan-workspace"),
            "update_plan",
            &input,
            CancellationToken::new(),
        )
        .await
        .unwrap();
        assert_eq!(result["plan"], input["plan"]);
        for invalid in [
            json!({"plan":[]}),
            json!({"plan":[{"step":"A","status":"in_progress"},{"step":"B","status":"in_progress"}]}),
            json!({"plan":[{"step":"A","status":"completed"},null]}),
            json!({"plan":[{"step":"A","status":"completed","command":"bad"}]}),
            json!({"plan":[{"step":" ","status":"completed"}]}),
        ] {
            assert!(execute(
                Path::new("nonexistent-plan-workspace"),
                "update_plan",
                &invalid,
                CancellationToken::new()
            )
            .await
            .is_err());
        }
    }
    fn workspace() -> (TempDir, Workspace) {
        let dir = tempfile::tempdir().unwrap();
        let ws = Workspace::new(dir.path()).unwrap();
        (dir, ws)
    }
    #[test]
    fn rejects_path_escapes_and_windows_special_paths() {
        let (_dir, ws) = workspace();
        for path in [
            "../escape",
            "a/../escape",
            "..\\escape",
            "x:stream",
            "file::$DATA",
            "C:relative",
            "//server/share",
            "\\\\?\\C:\\x",
            "\\\\.\\NUL",
            "NUL.txt",
            "NUL .txt",
            "\\/server/share",
            "aux",
            "COM1.log",
            "LPT²",
            "x.",
            "x ",
            "x\0y",
        ] {
            assert!(ws.resolve(path, true).is_err(), "accepted {path:?}");
        }
        let outside = tempfile::tempdir().unwrap();
        assert!(ws.resolve(outside.path().to_str().unwrap(), true).is_err());
        assert!(ws.resolve("missing/child", true).is_err());
        assert!(ws.resolve("new.txt", true).is_ok());
        assert!(ws
            .resolve(ws.input_root().join("new.txt").to_str().unwrap(), true)
            .is_ok());
    }
    #[test]
    fn symlinks_and_junctions_are_rejected() {
        let (dir, ws) = workspace();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("secret"), "secret").unwrap();
        let link = dir.path().join("link");
        #[cfg(unix)]
        std::os::unix::fs::symlink(outside.path(), &link).unwrap();
        #[cfg(windows)]
        {
            // Junctions do not require Windows developer-mode symlink privileges.
            let status = std::process::Command::new("cmd.exe")
                .args(["/D", "/C", "mklink", "/J"])
                .arg(&link)
                .arg(outside.path())
                .stdout(Stdio::null())
                .status()
                .unwrap();
            assert!(status.success());
        }
        assert!(ws.resolve("link/secret", false).is_err());
        assert!(ws.resolve("link/new", true).is_err());
        assert!(ws.resolve("link", false).is_err());
    }
    #[test]
    fn patch_validation_is_atomic_and_creation_is_strict() {
        let (dir, ws) = workspace();
        let cancel = CancellationToken::new();
        fs::write(dir.path().join("a"), "old a").unwrap();
        fs::write(dir.path().join("b"), "old b").unwrap();
        let patch = json!({"files":[{"path":"a","before":"old a","after":"new a"},{"path":"b","before":"wrong","after":"new b"}]}).to_string();
        assert!(apply_patch(&ws, &json!({"patch":patch}), &cancel).is_err());
        assert_eq!(fs::read_to_string(dir.path().join("a")).unwrap(), "old a");
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 2);
        let patch = json!({"files":[{"path":"a","before":"old a","after":"new a"},{"path":"new","before":null,"after":"created"}]}).to_string();
        apply_patch(&ws, &json!({"patch":patch}), &cancel).unwrap();
        assert_eq!(fs::read_to_string(dir.path().join("a")).unwrap(), "new a");
        assert_eq!(
            fs::read_to_string(dir.path().join("new")).unwrap(),
            "created"
        );
        assert!(apply_patch(&ws, &json!({"patch":patch}), &cancel).is_err());
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 3);
    }
    #[test]
    fn read_only_limits_and_strict_validation() {
        let (dir, ws) = workspace();
        let cancel = CancellationToken::new();
        fs::write(dir.path().join("text"), "one\ntwo\nthree\n").unwrap();
        fs::write(dir.path().join("binary"), [0, 1, 2]).unwrap();
        fs::create_dir(dir.path().join(".git")).unwrap();
        fs::write(dir.path().join(".git/secret"), "two").unwrap();
        let before = fs::read_dir(dir.path()).unwrap().count();
        let result = read_file(&ws, &json!({"path":"text","offset":1,"limit":1}), &cancel).unwrap();
        assert_eq!(result["content"], "two\n");
        assert_eq!(result["truncated"], true);
        assert!(read_file(&ws, &json!({"path":"text","limit":0}), &cancel).is_err());
        assert!(read_file(&ws, &json!({"path":"text","offset":true}), &cancel).is_err());
        assert!(read_file(&ws, &json!({"path":"text","oops":1}), &cancel).is_err());
        assert!(read_file(&ws, &json!({"path":"binary"}), &cancel).is_err());
        let result = search(&ws, &json!({"pattern":"o","maxResults":1}), &cancel).unwrap();
        assert_eq!(result["matches"].as_array().unwrap().len(), 1);
        assert_eq!(result["truncated"], true);
        let result = list_files(&ws, &json!({"recursive":true}), &cancel).unwrap();
        assert_eq!(result["entries"].as_array().unwrap().len(), 1);
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), before);
        fs::write(dir.path().join("large"), vec![b'x'; MAX_FILE_BYTES + 1]).unwrap();
        assert!(read_file(&ws, &json!({"path":"large"}), &cancel).is_err());
        fs::write(dir.path().join("long"), "é".repeat(MAX_OUTPUT_BYTES)).unwrap();
        let result = read_file(&ws, &json!({"path":"long"}), &cancel).unwrap();
        assert!(result["content"].as_str().unwrap().len() <= MAX_READ_BYTES);
        assert_eq!(result["truncated"], true);
    }
    #[test]
    fn unknown_tools_fail_closed_and_cancelled_writes_do_nothing() {
        assert!(is_mutating("unknown"));
        assert!(is_mutating("shell"));
        assert!(!is_mutating("search"));
        let (dir, ws) = workspace();
        let cancel = CancellationToken::new();
        cancel.cancel();
        assert!(write_file(&ws, &json!({"path":"new","content":"x"}), &cancel).is_err());
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 0);
    }
    #[tokio::test]
    async fn shell_timeout_cancellation_and_bounded_output() {
        let dir = tempfile::tempdir().unwrap();
        #[cfg(windows)]
        let sleep = "Start-Sleep -Seconds 10";
        #[cfg(not(windows))]
        let sleep = "sleep 10";
        let result = execute(
            dir.path(),
            "shell",
            &json!({"command":sleep,"timeoutMs":50}),
            CancellationToken::new(),
        )
        .await;
        assert!(result.unwrap_err().to_string().contains("timed out"));
        let cancel = CancellationToken::new();
        let trigger = cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(50)).await;
            trigger.cancel();
        });
        let result = execute(dir.path(), "shell", &json!({"command":sleep}), cancel).await;
        assert!(result.unwrap_err().to_string().contains("cancelled"));
        #[cfg(windows)]
        let output = "[Console]::Out.Write(('x' * 200000))";
        #[cfg(not(windows))]
        let output = "head -c 200000 /dev/zero | tr '\\000' x";
        let result = execute(
            dir.path(),
            "shell",
            &json!({"command":output}),
            CancellationToken::new(),
        )
        .await
        .unwrap();
        assert_eq!(result["success"], true);
        assert_eq!(result["stdoutTruncated"], true);
        assert!(result["stdout"].as_str().unwrap().len() <= MAX_OUTPUT_BYTES / 2);
        assert!(result["stdout"].as_str().unwrap().contains("bytes omitted"));
    }

    #[tokio::test]
    async fn captured_output_keeps_head_and_tail_where_errors_are() {
        let mut text = String::from("FIRST LINE\n");
        while text.len() < 300 * 1024 {
            text.push_str("progress line ü\n");
        }
        text.push_str("error[E0308]: mismatched types at the very end\n");
        let (bytes, truncated) = capture(text.as_bytes()).await.unwrap();
        let captured = String::from_utf8(bytes).expect("tail starts on a UTF-8 boundary");
        assert!(truncated);
        assert!(captured.len() <= MAX_OUTPUT_BYTES / 2);
        assert!(captured.starts_with("FIRST LINE"));
        assert!(captured.ends_with("mismatched types at the very end\n"));
        assert!(captured.contains("bytes omitted"));
        let (small, truncated) = capture(&b"short output"[..]).await.unwrap();
        assert_eq!((small.as_slice(), truncated), (&b"short output"[..], false));
    }

    #[test]
    fn native_definitions_stay_compact() {
        let tools = definitions();
        let bytes = serde_json::to_vec(&tools).unwrap().len();
        println!("native tool definitions: {} tools, {bytes} bytes", tools.len());
        // Sent with every request; keep descriptions short (9,253 bytes before
        // the descriptions were tightened).
        assert!(bytes < 9 * 1024, "{bytes} bytes");
        let history = tools
            .iter()
            .find(|tool| tool["function"]["name"] == "history_search")
            .unwrap();
        assert!(history["function"]["parameters"]["properties"]["messageIndex"].is_object());
    }

    #[test]
    fn deferred_groups_are_appended_only_after_enable_tools() {
        let browser = |name: &str| {
            json!({"type":"function","function":{"name":name,"description":"fixture","parameters":{"type":"object"}}})
        };
        let mut all = definitions();
        for name in [
            "browser_navigate",
            "browser_snapshot",
            "browser_evaluate",
            "browser_start_video",
            "browser_artifact",
            "browser_pause",
        ] {
            all.push(browser(name));
        }
        let names = |tools: &[Value]| {
            tools
                .iter()
                .map(|tool| tool["function"]["name"].as_str().unwrap().to_owned())
                .collect::<Vec<_>>()
        };
        let initial = advertised(&all, &[]);
        let initial_names = names(&initial);
        assert!(initial_names.contains(&"browser_snapshot".to_owned()));
        assert!(!initial_names.contains(&"browser_evaluate".to_owned()));
        assert_eq!(initial_names.last().unwrap(), "enable_tools");
        println!(
            "enable_tools definition: {} bytes",
            serde_json::to_vec(initial.last().unwrap()).unwrap().len()
        );
        assert_eq!(
            initial.last().unwrap()["function"]["parameters"]["properties"]["group"]["enum"],
            json!(["browser_devtools", "browser_capture", "browser_session"])
        );
        let mut enabled = vec![];
        let result = enable_group(&all, &mut enabled, &json!({"group":"browser_capture"})).unwrap();
        assert_eq!(result["tools"], json!(["browser_start_video", "browser_artifact"]));
        assert!(enable_group(&all, &mut enabled, &json!({"group":"desktop"})).is_err());
        assert!(enable_group(&all, &mut enabled, &json!({"group":"browser_capture","x":1})).is_err());
        let again = enable_group(&all, &mut enabled, &json!({"group":"browser_capture"})).unwrap();
        assert_eq!(again["alreadyEnabled"], true);
        assert_eq!(enabled, vec!["browser_capture".to_owned()]);
        let after = advertised(&all, &enabled);
        // Enabling only appends: the earlier (cached) prefix is unchanged.
        assert_eq!(after[..initial.len()], initial[..]);
        assert_eq!(
            names(&after[initial.len()..]),
            vec!["browser_start_video", "browser_artifact"]
        );
        // Without deferred tools there is no enable_tools at all.
        assert!(!names(&advertised(&definitions(), &[])).contains(&"enable_tools".to_owned()));
        assert!(!is_mutating("enable_tools"));
        assert!(!ToolRegistry::new(None).is_mutating("ask", "enable_tools", &json!({})));
    }

    #[test]
    fn enumeration_is_bounded_and_patch_aliases_are_rejected() {
        let (dir, ws) = workspace();
        let cancel = CancellationToken::new();
        for n in 0..MAX_RESULTS + 2 {
            fs::write(dir.path().join(format!("file-{n}")), "x").unwrap();
        }
        let result = list_files(&ws, &json!({}), &cancel).unwrap();
        assert_eq!(result["entries"].as_array().unwrap().len(), MAX_RESULTS);
        assert_eq!(result["truncated"], true);
        let patch = json!({"files":[{"path":"file-0","before":"x","after":"a"},{"path":"./file-0","before":"x","after":"b"}]}).to_string();
        assert!(apply_patch(&ws, &json!({"patch":patch}), &cancel).is_err());
        assert_eq!(fs::read_to_string(dir.path().join("file-0")).unwrap(), "x");
        let (_deep_dir, deep_ws) = workspace();
        let mut parent = deep_ws.root.clone();
        for _ in 0..MAX_WALK_DEPTH {
            parent.push("d");
        }
        fs::create_dir_all(&parent).unwrap();
        fs::write(parent.join("too-deep.txt"), "needle").unwrap();
        let result = search(&deep_ws, &json!({"pattern":"needle"}), &cancel).unwrap();
        assert!(result["matches"].as_array().unwrap().is_empty());
        assert_eq!(result["truncated"], true);
    }

    #[cfg(windows)]
    #[test]
    fn windows_roots_long_paths_and_short_name_aliases() {
        assert!(!supported_windows_root(Path::new(r"\\?\UNC\server\share")));
        assert!(!supported_windows_root(Path::new(r"\\server\share")));
        assert!(!supported_windows_root(Path::new(r"\\.\C:")));
        let (_dir, ws) = workspace();
        let cancel = CancellationToken::new();
        let mut parent = ws.root.clone();
        for _ in 0..6 {
            parent.push("a-very-long-but-valid-workspace-directory-name");
        }
        fs::create_dir_all(&parent).unwrap();
        let path = parent.join("a-long-file-name-for-short-alias-testing.txt");
        let rel = ws.display(&path);
        write_file(&ws, &json!({"path":rel,"content":"first"}), &cancel).unwrap();
        write_file(&ws, &json!({"path":rel,"content":"second"}), &cancel).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "second");
        use std::os::windows::ffi::{OsStrExt, OsStringExt};
        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn GetShortPathNameW(long: *const u16, short: *mut u16, capacity: u32) -> u32;
        }
        let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        let mut short = vec![0u16; 32768];
        let len =
            unsafe { GetShortPathNameW(wide.as_ptr(), short.as_mut_ptr(), short.len() as u32) };
        if len > 0 && (len as usize) < short.len() {
            let short = PathBuf::from(std::ffi::OsString::from_wide(&short[..len as usize]));
            if short.file_name() != path.file_name() {
                let alias = ws.display(&parent.join(short.file_name().unwrap()));
                let patch = json!({"files":[{"path":rel,"before":"second","after":"a"},{"path":alias,"before":"second","after":"b"}]}).to_string();
                assert!(apply_patch(&ws, &json!({"patch":patch}), &cancel).is_err());
                assert_eq!(fs::read_to_string(&path).unwrap(), "second");
            }
        }
    }

    #[cfg(windows)]
    #[test]
    fn replacement_and_staging_preserve_restricted_windows_acl() {
        let (dir, ws) = workspace();
        let cancel = CancellationToken::new();
        let path = dir.path().join("private.txt");
        fs::write(&path, "private").unwrap();
        let ps = system_exe("WindowsPowerShell/v1.0/powershell.exe").unwrap();
        let setup = "$ErrorActionPreference='Stop'; $acl=[System.IO.File]::GetAccessControl($env:TREX_TEST_FILE); $acl.SetAccessRuleProtection($true,$false); $rule=[System.Security.AccessControl.FileSystemAccessRule]::new([System.Security.Principal.WindowsIdentity]::GetCurrent().User,'FullControl','Allow'); $acl.SetAccessRule($rule); [System.IO.File]::SetAccessControl($env:TREX_TEST_FILE,$acl)";
        let status = std::process::Command::new(&ps)
            .args(["-NoProfile", "-NonInteractive", "-Command", setup])
            .env("TREX_TEST_FILE", &path)
            .status()
            .unwrap();
        assert!(status.success());
        let acl = |path: &Path| {
            let output = std::process::Command::new(&ps).args(["-NoProfile","-NonInteractive","-Command",
                "$ErrorActionPreference='Stop'; ([System.IO.File]::GetAccessControl($env:TREX_TEST_FILE)).GetSecurityDescriptorSddlForm([System.Security.AccessControl.AccessControlSections]::Access)"])
                .env("TREX_TEST_FILE",path).output().unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            String::from_utf8(output.stdout).unwrap().trim().to_owned()
        };
        let before = acl(&path);
        let change = Change {
            path: ws.resolve("private.txt", false).unwrap(),
            before: Some("private".into()),
            after: "secret replacement".into(),
        };
        let staged = stage(&ws, &change, &cancel).unwrap();
        // AUTO_INHERITED is bookkeeping, not an access or protection rule.
        assert_eq!(
            acl(&staged.temp).replace("AI", ""),
            before.replace("AI", "")
        );
        drop(staged);
        write_file(
            &ws,
            &json!({"path":"private.txt","content":"replacement"}),
            &cancel,
        )
        .unwrap();
        assert_eq!(acl(&path).replace("AI", ""), before.replace("AI", ""));
        assert_eq!(fs::read_to_string(&path).unwrap(), "replacement");
    }

    #[cfg(windows)]
    #[test]
    fn failed_replacement_preserves_original_and_cleans_staging() {
        use std::os::windows::fs::OpenOptionsExt;
        let (dir, ws) = workspace();
        let cancel = CancellationToken::new();
        let path = dir.path().join("locked.txt");
        fs::write(&path, "original").unwrap();
        let _lock = OpenOptions::new()
            .read(true)
            .share_mode(1)
            .open(&path)
            .unwrap();
        assert!(write_file(&ws, &json!({"path":"locked.txt","content":"new"}), &cancel).is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "original");
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[cfg(windows)]
    fn windows_process_alive(pid: u32) -> bool {
        use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut std::ffi::c_void;
            fn GetExitCodeProcess(process: *mut std::ffi::c_void, code: *mut u32) -> i32;
        }
        let raw = unsafe { OpenProcess(0x1000, 0, pid) };
        if raw.is_null() {
            return false;
        }
        let handle = unsafe { OwnedHandle::from_raw_handle(raw) };
        let mut code = 0;
        unsafe { GetExitCodeProcess(handle.as_raw_handle(), &mut code) != 0 && code == 259 }
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn descendants_die_after_parent_exit_cancellation_and_future_drop() {
        for mode in ["timeout", "cancel", "drop"] {
            let dir = tempfile::tempdir().unwrap();
            let cwd = dir.path().to_owned();
            let ps = system_exe("WindowsPowerShell/v1.0/powershell.exe").unwrap();
            let tail = if mode == "timeout" {
                "exit"
            } else {
                "Start-Sleep -Seconds 30"
            };
            let command = format!("$p=Start-Process -FilePath '{}' -ArgumentList @('-NoProfile','-NonInteractive','-Command','Start-Sleep -Seconds 30') -NoNewWindow -PassThru; $p.Id | Set-Content child.pid; {tail}", ps.display());
            // The shell must start two PowerShells and write the PID before its
            // timeout: allow a slow, busy machine. Cancel and drop stop it as
            // soon as the PID appears, so their timeout must never fire first.
            // In "timeout" mode the shell waits for its descendant, so the timeout is what ends it
            // (the test needs it to fire, after the PID is written): 15 s covers two cold PowerShell
            // starts on a loaded CI runner, where 5 s was missed by 0.3 s.
            let timeout = if mode == "timeout" { 15_000 } else { 60_000 };
            let cancel = CancellationToken::new();
            let child_cancel = cancel.clone();
            let task = tokio::spawn(async move {
                execute(
                    &cwd,
                    "shell",
                    &json!({"command":command,"timeoutMs":timeout}),
                    child_cancel,
                )
                .await
            });
            let pid_file = dir.path().join("child.pid");
            let started = std::time::Instant::now();
            let mut pid = None;
            for _ in 0..1000 {
                if let Ok(text) = fs::read_to_string(&pid_file) {
                    if let Ok(value) = text.trim().parse::<u32>() {
                        pid = Some(value);
                        break;
                    }
                }
                if task.is_finished() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            let Some(pid) = pid else {
                let shell = if task.is_finished() {
                    format!("{:?}", task.await)
                } else {
                    "still running".to_owned()
                };
                panic!(
                    "descendant did not start ({mode}) after {:?}; shell: {shell}",
                    started.elapsed()
                );
            };
            match mode {
                "cancel" => {
                    cancel.cancel();
                    assert!(task
                        .await
                        .unwrap()
                        .unwrap_err()
                        .to_string()
                        .contains("cancelled"));
                }
                "drop" => {
                    task.abort();
                    assert!(task.await.unwrap_err().is_cancelled());
                }
                _ => {
                    assert!(task
                        .await
                        .unwrap()
                        .unwrap_err()
                        .to_string()
                        .contains("timed out"));
                }
            }
            for _ in 0..100 {
                if !windows_process_alive(pid) {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            assert!(
                !windows_process_alive(pid),
                "descendant {pid} survived {mode}"
            );
        }
    }
}
