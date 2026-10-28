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
const MAX_OUTPUT_BYTES: usize = 128 * 1024;
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

pub type ToolFuture<'a> = Pin<Box<dyn Future<Output = Result<Value>> + Send + 'a>>;

/// A deliberately small registry interface; external providers cannot dispatch
/// arbitrary commands or bypass the session runner's approval journal.
pub trait ToolProvider: Send + Sync {
    fn invalidate_observation(&self) {}
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
                "shell" if input["background"] == true => {
                    self.processes.start(cwd, input, operation_id, &cancel)
                }
                "process_list" => {
                    fields(input, &[], &[])?;
                    Ok(self.processes.list())
                }
                "process_output" => {
                    let obj = fields(input, &["id"], &["id"])?;
                    self.processes.read(string(obj, "id")?)
                }
                "process_stop" => {
                    let obj = fields(input, &["id"], &["id"])?;
                    self.processes.stop(string(obj, "id")?).await
                }
                _ => execute(cwd, name, input, cancel).await,
            }
        })
    }
}

pub struct ToolRegistry {
    providers: Vec<Box<dyn ToolProvider>>,
    team: Option<crate::team::TeamConfig>,
    role_instructions: Option<String>,
    processes: std::sync::Arc<crate::processes::ProcessManager>,
}
impl ToolRegistry {
    pub fn new(browser: Option<crate::browser::BrowserToolProvider>) -> Self {
        let processes = std::sync::Arc::new(crate::processes::ProcessManager::default());
        let mut providers: Vec<Box<dyn ToolProvider>> = vec![
            Box::new(NativeToolProvider {
                processes: processes.clone(),
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
            processes,
        }
    }
    pub fn with_desktop(mut self, enabled: bool) -> Self {
        if enabled {
            self.providers
                .push(Box::new(crate::desktop::DesktopProvider::default()));
        }
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
    pub fn invalidate_observation(&self) {
        for provider in &self.providers {
            provider.invalidate_observation();
        }
    }
    pub fn processes(&self) -> &crate::processes::ProcessManager {
        &self.processes
    }
    pub fn team_config(&self) -> &Option<crate::team::TeamConfig> {
        &self.team
    }
    fn provider(&self, mode: &str, name: &str) -> Option<&dyn ToolProvider> {
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
            .collect()
    }
    pub fn is_mutating(&self, mode: &str, name: &str, input: &Value) -> bool {
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
        ("read_file", "Read a UTF-8 workspace file (max 1 MiB). offset is a zero-based line offset; limit defaults to 200 (max 2000). Output is capped at 128 KiB.", json!({"path":{"type":"string"},"offset":{"type":"integer","minimum":0},"limit":{"type":"integer","minimum":1,"maximum":2000}}), vec!["path"]),
        ("list_files", "List workspace text files and directories, skipping symlinks, binary files, .git, node_modules and target. At most 1000 entries and 10000 visited entries. Defaults: path '.', recursive false.", json!({"path":{"type":"string"},"recursive":{"type":"boolean"}}), vec![]),
        ("search", "Search UTF-8 workspace files with a Rust regex. Skips symlinks, binary/oversized files, .git, node_modules and target. One result per matching line. maxResults defaults to 100 (max 1000); scanned bytes and output are bounded.", json!({"pattern":{"type":"string"},"path":{"type":"string"},"maxResults":{"type":"integer","minimum":1,"maximum":1000}}), vec!["pattern"]),
        ("write_file", "Atomically replace or create a UTF-8 workspace file (max 1 MiB). Parent directory must already exist. Symlinks and reparse points are rejected.", json!({"path":{"type":"string"},"content":{"type":"string"}}), vec!["path","content"]),
        ("apply_patch", "Apply a strict JSON patch string: {\"files\":[{\"path\":\"relative/path\",\"before\":\"exact entire current text\",\"after\":\"entire replacement text\"}]}. before:null creates a file. No deletes or directory creation. All preconditions validated before replacements. Max 32 files, 1 MiB/file, 4 MiB patch. Atomic per file; OS commit failures may partially apply a multi-file patch.", json!({"patch":{"type":"string"}}), vec!["patch"]),
        ("shell", "Run an authorized shell command in the workspace (PowerShell on Windows, /bin/sh elsewhere). Foreground: timeoutMs defaults to 60000, max 600000; cancellation/timeout kills the process tree. Set background:true for servers, watches and monitoring that should continue between turns: omit timeoutMs, retain the returned id, and use process_output/process_stop. Background terminals end when this CLI session closes. stdout/stderr are bounded.", json!({"command":{"type":"string"},"background":{"type":"boolean"},"timeoutMs":{"type":"integer","minimum":1,"maximum":600000}}), vec!["command"]),
        ("process_list", "List this session's background terminals and their current status. Does not launch or restart commands.", json!({}), vec![]),
        ("process_output", "Read up to the last 64 KiB of combined output from an owned background terminal.", json!({"id":{"type":"string"}}), vec!["id"]),
        ("process_stop", "Stop exactly one owned background terminal and its descendants, preserving the chat and other terminals. Never use an OS PID.", json!({"id":{"type":"string"}}), vec!["id"]),
        ("trex_read_messages", "Read newly queued user messages. Handled by the server, not the native tool executor.", json!({}), vec![]),
        ("update_plan", "Publish or update your visible task list. Keep completed work marked completed, the current step in_progress, and future steps pending. Do not mark unverified work complete. This only updates the plan; it does not execute tasks.", json!({"plan":{"type":"array","minItems":1,"maxItems":64,"items":{"type":"object","properties":{"step":{"type":"string","maxLength":2000},"status":{"type":"string","enum":["pending","in_progress","completed"]}},"required":["step","status"],"additionalProperties":false}}}), vec!["plan"]),
    ];
    specs.into_iter().map(|(name, description, properties, required)| json!({
        "type":"function", "function": {"name":name,"description":description,
        "parameters":{"type":"object","properties":properties,"required":required,"additionalProperties":false}}
    })).collect()
}

/// Unknown tool names fail closed under a caller's read-only policy.
pub fn is_mutating(name: &str) -> bool {
    !matches!(
        name,
        "read_file"
            | "list_files"
            | "search"
            | "trex_read_messages"
            | "update_plan"
            | "process_list"
            | "process_output"
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
        "read_file" | "list_files" | "search" | "write_file" | "apply_patch" | "shell" => {}
        _ => bail!("unknown tool: {name}"),
    }
    if name == "shell" {
        return shell(cwd, input, cancel).await;
    }
    let cwd = cwd.to_owned();
    let name = name.to_owned();
    let input = input.clone();
    tokio::task::spawn_blocking(move || {
        let ws = Workspace::new(&cwd)?;
        match name.as_str() {
            "read_file" => read_file(&ws, &input, &cancel),
            "list_files" => list_files(&ws, &input, &cancel),
            "search" => search(&ws, &input, &cancel),
            "write_file" => write_file(&ws, &input, &cancel),
            "apply_patch" => apply_patch(&ws, &input, &cancel),
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

struct Workspace {
    root: PathBuf,
}
impl Workspace {
    fn new(cwd: &Path) -> Result<Self> {
        let root = fs::canonicalize(cwd).context("cannot canonicalize workspace")?;
        ensure!(root.is_dir(), "workspace must be a directory");
        #[cfg(windows)]
        {
            ensure!(
                supported_windows_root(&root),
                "only local drive workspaces are supported; UNC/device workspaces are forbidden"
            );
        }
        Ok(Self { root })
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
    fn resolve(&self, raw: &str, allow_new: bool) -> Result<PathBuf> {
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
    let text = read_text(&path, cancel)?;
    let lines: Vec<_> = text.split_inclusive('\n').collect();
    let mut content = String::new();
    let mut count = 0;
    let mut clipped = false;
    for line in lines.iter().skip(offset).take(limit) {
        check_cancel(cancel)?;
        let chunk = prefix(line, MAX_OUTPUT_BYTES - content.len());
        content.push_str(chunk);
        count += 1;
        if chunk.len() < line.len() {
            clipped = true;
            break;
        }
    }
    Ok(
        json!({"path":ws.display(&path),"content":content,"offset":offset,"linesRead":count,
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
                if output_bytes + cost > MAX_OUTPUT_BYTES {
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
            if matches.len() == max || output + cost > MAX_OUTPUT_BYTES {
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
            bail!(
                "patch commit failed at {}; already committed {:?}: {error:#}",
                ws.display(&change.path),
                committed
            );
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
    let change = Change {
        before: existing_text(&path, cancel)?,
        path,
        after: content.to_owned(),
    };
    commit(ws, std::slice::from_ref(&change), cancel)?;
    Ok(json!({"path":ws.display(&change.path),"bytesWritten":content.len()}))
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

async fn capture(mut pipe: impl tokio::io::AsyncRead + Unpin) -> Result<(Vec<u8>, bool)> {
    let mut result = Vec::new();
    let mut truncated = false;
    let mut buffer = [0u8; 8192];
    loop {
        let n = pipe.read(&mut buffer).await?;
        if n == 0 {
            break;
        }
        let keep = n.min(MAX_OUTPUT_BYTES / 2 - result.len());
        result.extend_from_slice(&buffer[..keep]);
        truncated |= keep < n;
    }
    Ok((result, truncated))
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
pub(crate) fn spawn_owned_shell(
    cwd: &Path,
    text: &str,
) -> Result<(tokio::process::Child, ProcessTreeGuard)> {
    let ws = Workspace::new(cwd)?;
    #[cfg(windows)]
    let mut command = {
        let mut cmd = Command::new(system_exe("WindowsPowerShell/v1.0/powershell.exe")?);
        cmd.args(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", text]);
        cmd.creation_flags(0x0800_0000 | 0x4); // CREATE_NO_WINDOW | CREATE_SUSPENDED
        cmd
    };
    #[cfg(not(windows))]
    let mut command = {
        let mut cmd = Command::new("/bin/sh");
        cmd.args(["-c", text]);
        #[cfg(unix)]
        cmd.process_group(0);
        cmd
    };
    command
        .current_dir(&ws.root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
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
    let (mut child, mut guard) = spawn_owned_shell(cwd, text)?;
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
            let stdout_text = prefix(&stdout, MAX_OUTPUT_BYTES / 2);
            let stderr_text = prefix(&stderr, MAX_OUTPUT_BYTES / 2);
            Ok(json!({"exitCode":status.code(),"success":status.success(),
                "stdout":stdout_text,"stderr":stderr_text,
                "stdoutTruncated":out_truncated || stdout_text.len() < stdout.len(),
                "stderrTruncated":err_truncated || stderr_text.len() < stderr.len()}))
        }
        Err(error) => {
            stop_process(&mut child, &mut guard).await;
            Err(error)
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
        assert!(result["content"].as_str().unwrap().len() <= MAX_OUTPUT_BYTES);
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
            let cancel = CancellationToken::new();
            let child_cancel = cancel.clone();
            let task = tokio::spawn(async move {
                execute(
                    &cwd,
                    "shell",
                    &json!({"command":command,"timeoutMs":2000}),
                    child_cancel,
                )
                .await
            });
            let pid_file = dir.path().join("child.pid");
            let mut pid = None;
            for _ in 0..200 {
                if let Ok(text) = fs::read_to_string(&pid_file) {
                    if let Ok(value) = text.trim().parse::<u32>() {
                        pid = Some(value);
                        break;
                    }
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            let pid = pid.expect("descendant did not start");
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
