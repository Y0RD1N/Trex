//! Versioned JSON-RPC stdio transport and durable, single-turn session runner.
use crate::usage::UsageTotals;
use crate::{
    artifacts,
    browser::{BrowserConfig, BrowserToolProvider, ExecutionUncertain},
    profile::{self, Profile},
    provider::{self, ProviderDelta},
    tools,
};
use anyhow::{bail, ensure, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{
    io::{AsyncBufRead, AsyncBufReadExt, AsyncWriteExt, BufReader},
    sync::{mpsc, oneshot, Mutex},
};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

const MAX_FRAME: usize = 32 * 1024 * 1024;
type CallbackResult = std::result::Result<Value, String>;

struct CachedRequest {
    request: Value,
    response: Option<Value>,
    waiters: Vec<oneshot::Sender<Value>>,
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn uid() -> String {
    Uuid::new_v4().to_string()
}
fn required<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    let result = value
        .get(key)
        .and_then(Value::as_str)
        .with_context(|| format!("{key} must be a string"))?;
    ensure!(
        !result.is_empty() && result.len() <= 4096,
        "{key} must have 1..4096 bytes"
    );
    Ok(result)
}
fn optional(value: &Value, key: &str) -> Result<Option<String>> {
    match value.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) if !s.is_empty() && s.len() <= 4096 => Ok(Some(s.clone())),
        _ => bail!("{key} must be a nonempty string or null"),
    }
}
fn mode(value: &str) -> Result<String> {
    match value {
        "plan" | "ask" | "full" => Ok(value.into()),
        "auto" | "default" => Ok("ask".into()),
        _ => bail!("mode must be plan, ask, or full (auto aliases ask)"),
    }
}

// Null and omission retain a resumed choice. An actual model change clears its
// previous model's effort unless the caller supplies a new non-null effort.
fn select_model(model: &mut String, effort: &mut Option<String>, params: &Value) -> Result<()> {
    let selected_model = optional(params, "model")?;
    let selected_effort = optional(params, "effort")?;
    if let Some(selected) = selected_model {
        if selected != *model {
            *model = selected;
            *effort = None;
        }
    }
    if let Some(selected) = selected_effort {
        *effort = Some(selected);
    }
    Ok(())
}

#[derive(Clone, Serialize, Deserialize)]
struct Turn {
    request: Value,
    status: String,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    error_details: Option<Value>,
    #[serde(default)]
    usage: Option<Value>,
    #[serde(default)]
    context_cutoff: usize,
    started_at: u64,
}

#[derive(Clone, Serialize, Deserialize)]
struct Execution {
    name: String,
    input: Value,
    state: String,
    message_id: String,
    #[serde(default)]
    provider_id: Option<String>,
    #[serde(default)]
    output: Option<Value>,
    #[serde(default)]
    is_error: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    operation_id: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Journal {
    version: u32,
    #[serde(default)]
    stream_sequence: u64,
    #[serde(default)]
    context_cutoff: usize,
    #[serde(default)]
    context_summary: String,
    #[serde(default)]
    compactions: Vec<Value>,
    #[serde(default)]
    budget_reserved_estimate_usd: f64,
    #[serde(default)]
    budget_reserved_estimate_tokens: u64,
    id: String,
    profile_name: String,
    provider: String,
    base_url: String,
    cwd: PathBuf,
    mode: String,
    model: String,
    effort: Option<String>,
    updated_at: u64,
    messages: Vec<Value>,
    items: Vec<Value>,
    events: Vec<Value>,
    turns: BTreeMap<String, Turn>,
    executions: BTreeMap<String, Execution>,
    receipts: BTreeMap<String, Value>,
    pending_inbox: Vec<Value>,
    recovery_required: bool,
    #[serde(default)]
    rejected_responses: Vec<Value>,
    // Browser access is an explicit live-session choice, never restored authority.
    #[serde(skip)]
    browser: BrowserConfig,
    #[serde(skip)]
    browser_available: bool,
    #[serde(skip)]
    desktop_enabled: bool,
}

struct Active {
    message_id: String,
    cancel: CancellationToken,
}
struct Session {
    path: PathBuf,
    _lock: File,
    _storage_lock: Option<File>,
    data: Mutex<Journal>,
    active: Mutex<Option<Active>>,
    tools: tools::ToolRegistry,
}

impl Session {
    fn persist(&self, data: &mut Journal) -> Result<()> {
        data.updated_at = now();
        atomic_json(&self.path, data)?;
        // A checkpoint includes stream_sequence. A crash before truncation is
        // harmless: recovery ignores records already represented in this file.
        let wal = self.path.with_extension("stream");
        profile::validate_storage_path(&wal)?;
        if wal.exists() {
            let file = OpenOptions::new().write(true).open(wal)?;
            file.set_len(0)?;
            file.sync_data()?;
        }
        Ok(())
    }
}

fn load_journal(path: &Path) -> Result<Journal> {
    profile::validate_storage_path(path)?;
    let mut data: Journal = serde_json::from_slice(&fs::read(path)?)
        .context("invalid conversation journal; original file was preserved")?;
    let wal = path.with_extension("stream");
    profile::validate_storage_path(&wal)?;
    if wal.exists() {
        use std::io::{BufRead, BufReader, Read};
        let file = File::open(wal)?;
        ensure!(
            file.metadata()?.len() <= 128 * 1024 * 1024,
            "stream journal exceeds recovery limit"
        );
        let mut reader = BufReader::new(file.take(128 * 1024 * 1024));
        let mut line = Vec::new();
        while reader.read_until(b'\n', &mut line)? != 0 {
            // A killed write can leave an incomplete last frame, never an
            // executable tool: this WAL contains text/thinking deltas only.
            if line.last() != Some(&b'\n') {
                break;
            }
            let event: Value = serde_json::from_slice(&line)
                .context("invalid stream journal; original preserved")?;
            let sequence = event["sequence"]
                .as_u64()
                .context("missing stream sequence")?;
            if sequence > data.stream_sequence {
                ensure!(
                    sequence == data.stream_sequence + 1 && event["method"] == "message/delta",
                    "invalid stream journal sequence"
                );
                project(&mut data.items, "message/delta", &event["params"]);
                data.events
                    .push(json!({"method":"message/delta","params":event["params"]}));
                data.stream_sequence = sequence;
            }
            line.clear();
        }
    }
    Ok(data)
}

fn atomic_json(path: &Path, data: &impl Serialize) -> Result<()> {
    profile::validate_storage_path(path)?;
    let temporary = path.with_extension(format!("{}.tmp", uid()));
    let result = (|| -> Result<()> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            file.set_permissions(fs::Permissions::from_mode(0o600))?;
        }
        serde_json::to_writer(&mut file, data)?;
        file.write_all(b"\n")?;
        file.sync_all()?;
        drop(file);
        #[cfg(windows)]
        {
            use std::os::windows::ffi::OsStrExt;
            #[link(name = "kernel32")]
            extern "system" {
                fn MoveFileExW(old: *const u16, new: *const u16, flags: u32) -> i32;
            }
            let old: Vec<u16> = temporary.as_os_str().encode_wide().chain(Some(0)).collect();
            let new: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
            // Replace existing file and do not return until disk publication completes.
            ensure!(
                unsafe { MoveFileExW(old.as_ptr(), new.as_ptr(), 0x1 | 0x8) } != 0,
                "cannot atomically save conversation: {}",
                std::io::Error::last_os_error()
            );
        }
        #[cfg(not(windows))]
        {
            fs::rename(&temporary, path)?;
            File::open(path.parent().context("missing journal directory")?)?.sync_all()?;
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result.context("saving durable conversation")
}

fn conversation_dir() -> Result<PathBuf> {
    let path = profile::home()?.join("conversations");
    profile::validate_storage_path(&path)?;
    fs::create_dir_all(&path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700))?;
    }
    Ok(path)
}

pub fn list_sessions(profile_name: Option<&str>) -> Result<Vec<Value>> {
    let mut result = Vec::new();
    for entry in fs::read_dir(conversation_dir()?)? {
        let path = entry?.path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        let data = match load_journal(&path) {
            Ok(data) => data,
            Err(_) => continue,
        };
        if profile_name.is_some_and(|name| name != data.profile_name) {
            continue;
        }
        let title = data
            .items
            .iter()
            .find(|item| item["kind"] == "user")
            .and_then(|item| item["text"].as_str())
            .unwrap_or("New conversation")
            .chars()
            .take(120)
            .collect::<String>();
        result.push(json!({"id":data.id,"title":title,"cwd":data.cwd,"updatedAt":data.updated_at,"provider":"trex","messageCount":data.turns.len(),"profile":data.profile_name}));
    }
    result.sort_by_key(|item| std::cmp::Reverse(item["updatedAt"].as_u64().unwrap_or(0)));
    Ok(result)
}

fn locked_conversation(id: &str) -> Result<(PathBuf, Vec<File>, Journal)> {
    ensure!(
        Uuid::parse_str(id).is_ok_and(|u| u.to_string() == id),
        "conversation ID must be a canonical UUID"
    );
    let storage = profile::lock_user_file("artifact-gc.lock", false)?;
    let dir = conversation_dir()?;
    profile::validate_storage_path(&dir.join(format!("{id}.lock")))?;
    let lock = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(dir.join(format!("{id}.lock")))?;
    lock.try_lock_exclusive()
        .context("close the conversation before managing its history")?;
    let path = dir.join(format!("{id}.json"));
    let data = load_journal(&path)?;
    ensure!(data.id == id, "conversation identity mismatch");
    Ok((path, vec![storage, lock], data))
}
pub fn export_session(id: &str, markdown: bool) -> Result<String> {
    let (_path, _lock, data) = locked_conversation(id)?;
    if !markdown {
        return Ok(serde_json::to_string_pretty(&data)?);
    }
    let mut text = format!("# Trex conversation {id}\n\n");
    for item in &data.items {
        if let Some(content) = item["text"].as_str() {
            text.push_str(&format!(
                "## {}\n\n{content}\n\n",
                item["kind"].as_str().unwrap_or("message")
            ));
        } else if item["kind"] == "tool" {
            text.push_str(&format!(
                "Tool `{}`: {}\n\n",
                item["name"].as_str().unwrap_or("unknown"),
                item["status"].as_str().unwrap_or("unknown")
            ));
        }
    }
    Ok(text)
}
pub fn fork_session(id: &str) -> Result<Value> {
    let (path, _lock, mut data) = locked_conversation(id)?;
    recover(&mut data);
    let new_id = uid();
    data.id = new_id.clone();
    data.updated_at = now();
    for event in &mut data.events {
        if let Some(params) = event.get_mut("params").and_then(Value::as_object_mut) {
            params.insert("sessionId".into(), json!(new_id));
        }
    }
    atomic_json(&path.with_file_name(format!("{new_id}.json")), &data)?;
    Ok(json!({"conversationId":new_id,"forkedFrom":id,"recoveryRequired":data.recovery_required}))
}
pub fn remove_session(id: &str) -> Result<Value> {
    let (path, _lock, mut data) = locked_conversation(id)?;
    recover(&mut data);
    let trash = profile::home()?.join("conversation-trash");
    profile::validate_storage_path(&trash)?;
    fs::create_dir_all(&trash)?;
    let destination = trash.join(format!("{id}.json"));
    ensure!(!destination.exists(), "conversation is already in trash");
    atomic_json(&destination, &data)?;
    fs::remove_file(&path)?;
    let wal = path.with_extension("stream");
    if wal.exists() {
        fs::remove_file(wal)?;
    }
    Ok(json!({"removed":true,"recoverable":true,"conversationId":id}))
}
pub fn restore_session(id: &str) -> Result<Value> {
    ensure!(
        Uuid::parse_str(id).is_ok_and(|u| u.to_string() == id),
        "invalid conversation ID"
    );
    let _storage = profile::lock_user_file("artifact-gc.lock", false)?;
    let lock_path = conversation_dir()?.join(format!("{id}.lock"));
    profile::validate_storage_path(&lock_path)?;
    let lock = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(lock_path)?;
    lock.try_lock_exclusive()
        .context("conversation is in use")?;
    let source = profile::home()?
        .join("conversation-trash")
        .join(format!("{id}.json"));
    let destination = conversation_dir()?.join(format!("{id}.json"));
    ensure!(!destination.exists(), "conversation already exists");
    let data = load_journal(&source)?;
    ensure!(data.id == id, "conversation identity mismatch");
    atomic_json(&destination, &data)?;
    fs::remove_file(source)?;
    Ok(json!({"restored":true,"conversationId":id}))
}
pub fn artifact_gc(apply: bool) -> Result<Value> {
    let _storage_lock = profile::lock_user_file("artifact-gc.lock", true)?;
    let home = profile::home()?;
    let mut locks = Vec::new();
    let mut hashes = std::collections::HashSet::new();
    fn references(value: &Value, hashes: &mut std::collections::HashSet<String>) {
        match value {
            Value::Object(object) => {
                if object.get("storage") == Some(&json!("local")) {
                    if let Some(id) = object.get("sha256").and_then(Value::as_str) {
                        hashes.insert(id.to_owned());
                    }
                }
                for value in object.values() {
                    references(value, hashes);
                }
            }
            Value::Array(array) => {
                for value in array {
                    references(value, hashes);
                }
            }
            _ => (),
        }
    }
    for dir in [conversation_dir()?, home.join("conversation-trash")] {
        profile::validate_storage_path(&dir)?;
        if !dir.exists() {
            continue;
        }
        for entry in fs::read_dir(dir)? {
            let path = entry?.path();
            if path.extension().and_then(|s| s.to_str()) != Some("json") {
                continue;
            }
            let id = path
                .file_stem()
                .and_then(|s| s.to_str())
                .context("invalid conversation filename")?;
            ensure!(
                Uuid::parse_str(id).is_ok_and(|u| u.to_string() == id),
                "invalid conversation filename"
            );
            profile::validate_storage_path(&conversation_dir()?.join(format!("{id}.lock")))?;
            let lock = OpenOptions::new()
                .create(true)
                .truncate(false)
                .read(true)
                .write(true)
                .open(conversation_dir()?.join(format!("{id}.lock")))?;
            lock.try_lock_exclusive()
                .context("close all conversations before artifact cleanup")?;
            locks.push(lock);
            let data = load_journal(&path)?;
            references(&serde_json::to_value(data)?, &mut hashes);
        }
    }
    let directory = home.join("artifacts");
    let mut candidates = Vec::new();
    let mut bytes = 0u64;
    profile::validate_storage_path(&directory)?;
    if directory.is_dir() {
        for entry in fs::read_dir(&directory)? {
            let entry = entry?;
            let path = entry.path();
            let meta = fs::symlink_metadata(&path)?;
            if !meta.is_file() || meta.file_type().is_symlink() {
                continue;
            }
            let id = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
            if path.extension().and_then(|s| s.to_str()) == Some("bin")
                && id.len() == 64
                && id.bytes().all(|c| c.is_ascii_hexdigit())
                && !hashes.contains(id)
            {
                bytes = bytes.saturating_add(meta.len());
                candidates.push(id.to_owned());
                if apply {
                    fs::remove_file(path)?;
                }
            }
        }
    }
    Ok(
        json!({"applied":apply,"artifacts":candidates,"bytes":bytes,"trashedConversationsPreserved":true}),
    )
}

pub struct Server {
    profile: Profile,
    models: Mutex<Vec<Value>>,
    output: mpsc::UnboundedSender<Value>,
    sessions: Mutex<HashMap<String, Arc<Session>>>,
    permissions: Mutex<HashMap<String, oneshot::Sender<bool>>>,
    callbacks: Mutex<HashMap<String, oneshot::Sender<CallbackResult>>>,
    requests: Mutex<HashMap<String, CachedRequest>>,
}

impl Server {
    pub fn new(profile: Profile, output: mpsc::UnboundedSender<Value>) -> Arc<Self> {
        Arc::new(Self {
            profile,
            models: Mutex::new(Vec::new()),
            output,
            sessions: Mutex::new(HashMap::new()),
            permissions: Mutex::new(HashMap::new()),
            callbacks: Mutex::new(HashMap::new()),
            requests: Mutex::new(HashMap::new()),
        })
    }
    fn send(&self, value: Value) {
        let _ = self.output.send(value);
    }
    fn notification(&self, method: &str, params: Value) {
        self.send(json!({"jsonrpc":"2.0","method":method,"params":params}));
    }

    async fn context_window(&self, model: &str) -> Option<(u64, &'static str)> {
        let models = self.models.lock().await;
        if let Some(metadata) = models.iter().find(|entry| entry["id"] == model) {
            if let Some(window) = metadata["contextWindow"].as_u64().filter(|n| *n > 0) {
                let source = if metadata["contextWindowSource"] == "documented" {
                    "documented"
                } else {
                    "remote"
                };
                return Some((window, source));
            }
        }
        provider::documented_context_window(&self.profile, model)
            .map(|window| (window, "documented"))
    }

    async fn image_support(&self, model: &str) -> Option<bool> {
        if let Some(metadata) = self
            .models
            .lock()
            .await
            .iter()
            .find(|entry| entry["id"] == model)
        {
            if let Some(modalities) = metadata["inputModalities"].as_array() {
                if modalities.is_empty() {
                    return None;
                }
                return Some(modalities.iter().any(|value| value == "image"));
            }
        }
        provider::documented_image_support(&self.profile, model)
    }

    async fn session_summary(&self, data: &Journal) -> Value {
        let context = self.context_window(&data.model).await;
        let mut summary = json!({"sessionId":data.id,"conversationId":data.id,"model":data.model,"effort":data.effort,"mode":data.mode,"items":data.items,"recoveryRequired":data.recovery_required,"contextWindow":context.map(|(window, _)| window),"contextWindowSource":context.map(|(_, source)| source)});
        summary["browser"] = json!({"enabled":data.browser.enabled,"available":data.browser_available,"profile":data.browser.profile,"clientId":data.browser.client_id.as_deref().unwrap_or(&data.id)});
        summary["desktopEnabled"] = json!(data.desktop_enabled);
        summary["imageSupport"] = json!(self.image_support(&data.model).await);
        summary["contextManagement"] = json!({"compactions":data.compactions,"archivedMessages":data.context_cutoff,"fullHistoryPreserved":true,"estimateOnly":true});
        summary["budget"] = json!({"reservedEstimateUsd":data.budget_reserved_estimate_usd,"reservedEstimateTokens":data.budget_reserved_estimate_tokens,"notProviderBill":true});
        if !data.turns.is_empty() || !data.items.is_empty() || !data.messages.is_empty() {
            let (mut usage, _) = restored_usage(data);
            // A measurement belongs to its recorded model, which can differ
            // from an explicitly selected model on restore.
            if usage.get("contextTokens").is_some() {
                if let Some(model) = usage["contextModel"].as_str() {
                    if let Some((window, source)) = self.context_window(model).await {
                        if source == "remote" || usage.get("contextWindow").is_none() {
                            usage["contextWindow"] = json!(window);
                        }
                    }
                }
            }
            summary["usage"] = usage;
        }
        summary
    }

    async fn session(&self, params: &Value) -> Result<Arc<Session>> {
        self.sessions
            .lock()
            .await
            .get(required(params, "sessionId")?)
            .cloned()
            .context("unknown sessionId; call session/start first")
    }

    async fn emit(&self, session: &Session, method: &str, params: Value) -> Result<()> {
        if method == "message/delta" {
            let mut data = session.data.lock().await;
            let sequence = data
                .stream_sequence
                .checked_add(1)
                .context("stream sequence exhausted")?;
            let mut options = OpenOptions::new();
            profile::validate_storage_path(&session.path.with_extension("stream"))?;
            options.create(true).append(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut file = options.open(session.path.with_extension("stream"))?;
            serde_json::to_writer(
                &mut file,
                &json!({"sequence":sequence,"method":method,"params":params}),
            )?;
            file.write_all(b"\n")?;
            // Flush to the OS, without syncing/replacing the complete history
            // for every network fragment. Tool boundaries checkpoint durably.
            file.flush()?;
            data.stream_sequence = sequence;
            project(&mut data.items, method, &params);
            data.events.push(json!({"method":method,"params":params}));
            drop(data);
            self.notification(method, params);
            return Ok(());
        }
        {
            let mut data = session.data.lock().await;
            let before = data.clone();
            project(&mut data.items, method, &params);
            data.events.push(json!({"method":method,"params":params}));
            if let Err(error) = session.persist(&mut data) {
                *data = before;
                return Err(error);
            }
        }
        self.notification(method, params);
        Ok(())
    }

    async fn start_session(&self, params: &Value) -> Result<Value> {
        let requested_mode = mode(required(params, "mode")?)?;
        let team = crate::team::TeamConfig::parse(params.get("team"))?;
        ensure!(
            team.is_none() || requested_mode == "plan",
            "a team coordinator must use read-only plan mode"
        );
        let role_instructions = optional(params, "roleInstructions")?;
        let instructions = match params.get("instructions") {
            None | Some(Value::Null) => None,
            Some(Value::String(text))
                if !text.trim().is_empty() && text.len() <= 32 * 1024 && !text.contains('\0') =>
            {
                Some(text.clone())
            }
            _ => bail!("instructions must be nonempty text of at most 32 KiB"),
        };
        ensure!(
            role_instructions
                .as_ref()
                .is_none_or(|value| value.len() <= 8192),
            "roleInstructions exceeds 8 KiB"
        );
        let browser = BrowserConfig::parse(params.get("browser"))?;
        let desktop_enabled = match params.get("desktopEnabled") {
            None | Some(Value::Null) => false,
            Some(Value::Bool(value)) => *value,
            _ => bail!("desktopEnabled must be a boolean"),
        };
        let cwd = fs::canonicalize(required(params, "cwd")?)
            .context("cwd must be an existing directory")?;
        ensure!(cwd.is_dir(), "cwd must be a directory");
        let conversation = optional(params, "conversationId")?;
        let id = match conversation {
            Some(id) => {
                Uuid::parse_str(&id).context("conversationId must be a UUID")?;
                id
            }
            None => uid(),
        };
        let mut sessions = self.sessions.lock().await;
        if let Some(session) = sessions.get(&id) {
            let data = session.data.lock().await;
            ensure!(data.cwd == cwd, "conversation workspace differs from cwd");
            ensure!(
                data.mode == requested_mode,
                "mode is fixed for this live session; restart the process to change mode"
            );
            ensure!(data.desktop_enabled == desktop_enabled, "desktop configuration is fixed for this live session; restart the process to change it");
            ensure!(data.browser == browser, "browser configuration is fixed for this live session; restart the process to change it");
            ensure!(
                session.tools.team_config() == &team,
                "team binding is immutable for this live session; restart the process to change it"
            );
            ensure!(
                session.tools.role_instructions() == &role_instructions,
                "role instructions are immutable for this live session"
            );
            ensure!(session.tools.session_instructions() == &instructions,
                "session instructions are immutable for this live session; restart the process to change them");
            let mut summary = self.session_summary(&data).await;
            summary["instructionsApplied"] = json!(instructions.is_some());
            if team.is_some() {
                summary["teamEnabled"] = json!(true);
            }
            if role_instructions.is_some() {
                summary["rolePolicyApplied"] = json!(true);
            }
            return Ok(summary);
        }
        let directory = conversation_dir()?;
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(directory.join(format!("{id}.lock")))?;
        lock.try_lock_exclusive()
            .context("conversation already open in another process")?;
        let path = directory.join(format!("{id}.json"));
        let mut data = if path.exists() {
            let mut data = load_journal(&path)?;
            ensure!(
                data.version == 1 && data.id == id,
                "unsupported or mismatched conversation journal"
            );
            ensure!(data.profile_name == self.profile.name && data.provider == self.profile.provider && data.base_url == self.profile.base_url,"conversation is bound to a different profile/provider/baseURL; restore the original connection to resume");
            ensure!(data.cwd == cwd, "conversation workspace differs from cwd");
            // A mode change requires a new process and an explicit session/start mode.
            data.mode = requested_mode;
            // Preserve a legacy measurement's inferred model before a new
            // selection is saved. Usage is extensible JSON in version 1; the
            // request fingerprint and journal schema remain unchanged.
            let (usage, measured_turn) = restored_usage(&data);
            if let Some(turn) = measured_turn.and_then(|id| data.turns.get_mut(&id)) {
                if let Some(recorded) = turn.usage.as_mut() {
                    if recorded.get("contextModel").is_none() {
                        recorded["contextModel"] = usage["contextModel"].clone();
                    }
                }
            }
            select_model(&mut data.model, &mut data.effort, params)?;
            recover(&mut data);
            data
        } else {
            ensure!(
                params.get("conversationId").is_none() || params["conversationId"].is_null(),
                "conversationId does not exist"
            );
            Journal {
                version: 1,
                stream_sequence: 0,
                context_cutoff: 0,
                context_summary: String::new(),
                compactions: vec![],
                budget_reserved_estimate_usd: 0.0,
                budget_reserved_estimate_tokens: 0,
                id: id.clone(),
                profile_name: self.profile.name.clone(),
                provider: self.profile.provider.clone(),
                base_url: self.profile.base_url.clone(),
                cwd,
                mode: requested_mode,
                model: optional(params, "model")?.unwrap_or_else(|| self.profile.model.clone()),
                effort: optional(params, "effort")?.or_else(|| {
                    if optional(params, "model")
                        .ok()
                        .flatten()
                        .is_none_or(|model| model == self.profile.model)
                    {
                        self.profile.effort.clone()
                    } else {
                        None
                    }
                }),
                updated_at: now(),
                messages: vec![],
                items: vec![],
                events: vec![],
                turns: BTreeMap::new(),
                executions: BTreeMap::new(),
                receipts: BTreeMap::new(),
                pending_inbox: vec![],
                recovery_required: false,
                rejected_responses: vec![],
                browser: BrowserConfig::default(),
                browser_available: false,
                desktop_enabled: false,
            }
        };
        let browser_provider = BrowserToolProvider::discover(&browser, &id, &data.mode)
            .await
            .ok()
            .flatten();
        data.desktop_enabled = desktop_enabled;
        data.browser = browser;
        data.browser_available = browser_provider.is_some();
        let settings = Arc::new(crate::settings::overlay(
            crate::settings::Settings::load(Some(&self.profile.name))?,
            params.get("settings"),
        )?);
        let mut mcp = Vec::new();
        let mut unavailable = Vec::new();
        for config in settings.mcp_servers.iter().filter(|s| s.enabled) {
            match crate::mcp::McpProvider::connect(config, &data.cwd, &settings.shell).await {
                Ok(provider) => mcp.push(provider),
                Err(_) => unavailable.push(config.name.clone()),
            }
        }
        let session = Arc::new(Session {
            path,
            _lock: lock,
            _storage_lock: Some(profile::lock_user_file("artifact-gc.lock", false)?),
            data: Mutex::new(Journal {
                version: 1,
                stream_sequence: 0,
                context_cutoff: 0,
                context_summary: String::new(),
                compactions: vec![],
                budget_reserved_estimate_usd: 0.0,
                budget_reserved_estimate_tokens: 0,
                id: String::new(),
                profile_name: String::new(),
                provider: String::new(),
                base_url: String::new(),
                cwd: PathBuf::new(),
                mode: String::new(),
                model: String::new(),
                effort: None,
                updated_at: 0,
                messages: vec![],
                items: vec![],
                events: vec![],
                turns: BTreeMap::new(),
                executions: BTreeMap::new(),
                receipts: BTreeMap::new(),
                pending_inbox: vec![],
                recovery_required: false,
                rejected_responses: vec![],
                browser: BrowserConfig::default(),
                browser_available: false,
                desktop_enabled: false,
            }),
            active: Mutex::new(None),
            tools: tools::ToolRegistry::configured(browser_provider, settings)
                .with_mcp(mcp)
                .with_workspace(data.cwd.clone())
                .with_desktop(desktop_enabled)
                .with_team(team.clone())
                .with_session_instructions(instructions.clone())
                .with_role_instructions(role_instructions.clone()),
        });
        session.persist(&mut data)?;
        let notifications = self.output.clone();
        let process_session = id.clone();
        session.tools.processes().set_notifier(Arc::new(move|event|{let _=notifications.send(json!({"jsonrpc":"2.0","method":"process/updated","params":{"sessionId":process_session,"event":event}}));}));
        let mut summary = self.session_summary(&data).await;
        summary["unavailableMcpServers"] = json!(unavailable);
        summary["instructionsApplied"] = json!(instructions.is_some());
        if team.is_some() {
            summary["teamEnabled"] = json!(true);
        }
        if role_instructions.is_some() {
            summary["rolePolicyApplied"] = json!(true);
        }
        *session.data.lock().await = data;
        sessions.insert(id, session);
        Ok(summary)
    }

    async fn start_turn(self: &Arc<Self>, params: &Value) -> Result<Value> {
        let session = self.session(params).await?;
        let message_id = required(params, "messageId")?.to_string();
        let text = params
            .get("text")
            .and_then(Value::as_str)
            .context("text must be a string")?;
        ensure!(text.len() <= 8 * 1024 * 1024, "text exceeds 8 MiB");
        let images = validate_images(params.get("images"))?;
        let display = match params.get("display") {
            None | Some(Value::Null) => text,
            Some(Value::String(s)) if s.len() <= 8 * 1024 * 1024 => s,
            _ => bail!("display must be a string of at most 8 MiB"),
        };
        ensure!(
            !text.trim().is_empty() || !images.is_empty(),
            "turn must include text or images"
        );
        let request = json!({"text":text,"display":display,"images":images,"model":params.get("model"),"effort":params.get("effort")});
        let mut active = session.active.lock().await;
        let mut data = session.data.lock().await;
        if let Some(turn) = data.turns.get(&message_id) {
            ensure!(
                turn.request == request,
                "messageId already exists with different input; use a new messageId"
            );
            let summary = json!({"accepted":true,"duplicate":true,"sessionId":data.id,"messageId":message_id,"status":turn.status});
            if turn.status != "running" {
                let mut completed = json!({"sessionId":data.id,"messageId":message_id,"status":turn.status,"error":turn.error,"usage":turn.usage});
                if let Some(details) = &turn.error_details {
                    completed["errorDetails"] = details.clone();
                }
                self.notification("turn/completed", completed);
            }
            return Ok(summary);
        }
        ensure!(
            active.is_none(),
            "a turn is already running in this session"
        );
        ensure!(!data.recovery_required,"restored tool execution is uncertain; inspect the workspace then call session/recover with action acknowledge");
        let before = data.clone();
        {
            let data = &mut *data;
            select_model(&mut data.model, &mut data.effort, params)?;
        }
        data.messages.push(user_message(text, &images));
        data.items.push(json!({"kind":"user","id":message_id,"text":display,"images":images.len(),"previews":previews(&images)}));
        let context_cutoff = data.context_cutoff;
        data.turns.insert(
            message_id.clone(),
            Turn {
                request,
                status: "running".into(),
                error: None,
                error_details: None,
                usage: None,
                context_cutoff,
                started_at: now(),
            },
        );
        if let Err(error) = session.persist(&mut data) {
            *data = before;
            return Err(error);
        }
        let session_id = data.id.clone();
        let cancel = CancellationToken::new();
        *active = Some(Active {
            message_id: message_id.clone(),
            cancel: cancel.clone(),
        });
        drop(data);
        drop(active);
        let server = self.clone();
        let failure_session_id = session_id.clone();
        tokio::spawn(async move {
            let drive = server
                .clone()
                .drive(session.clone(), &message_id, cancel.clone());
            tokio::pin!(drive);
            let (result, timed_out) = tokio::select! {
                result=&mut drive=>(result,false),
                _=tokio::time::sleep(Duration::from_millis(session.tools.settings().limits.max_turn_ms))=>{
                    // Signal first: browser/MCP/desktop adapters must finish
                    // their cancellation protocol before their futures drop.
                    cancel.cancel();let _=tokio::time::timeout(Duration::from_secs(10),&mut drive).await;
                    (Err(anyhow::anyhow!("turn duration budget reached; inspect any unfinished operation")),true)
                }
            };
            let status = if cancel.is_cancelled() && !timed_out {
                "interrupted"
            } else if result.is_ok() {
                "completed"
            } else {
                "failed"
            };
            let error_details = result.as_ref().err().map(|error| {
                if let Some(api) = error.downcast_ref::<provider::ApiError>() {
                    serde_json::to_value(api).unwrap_or(json!({"code":"api_error"}))
                } else if let Some(incomplete)=error.downcast_ref::<provider::IncompleteCompletion>() {
                    json!({"code":if incomplete.cancelled{"cancelled"}else{match incomplete.finish_reason.as_deref(){Some("length")=>"output_limit_exceeded",Some("content_filter")=>"content_filter",_=>"incomplete_response"}},"retryable":false,"requestId":incomplete.request_id,"attempts":incomplete.usage.as_ref().and_then(|v|v["trex_request_attempts"].as_u64()).unwrap_or(1)})
                } else if error.to_string().contains("budget") {
                    json!({"code":"budget_exceeded","retryable":false})
                } else {
                    json!({"code":"turn_failed","retryable":false})
                }
            });
            let (usage, error) = match result {
                Ok(usage) => (usage, None),
                Err(error) => (None, Some(error.to_string())),
            };
            if let Err(error) = server
                .finish(&session, &message_id, status, error, usage, error_details)
                .await
            {
                // The caller must never receive a success when journal durability failed.
                server.notification("turn/completed",json!({"sessionId":failure_session_id,"messageId":message_id,"status":"failed","error":format!("durable history failure: {error}")}));
                *session.active.lock().await = None;
            }
        });
        Ok(
            json!({"accepted":true,"sessionId":session_id,"messageId":required(params,"messageId")?}),
        )
    }

    async fn finish(
        &self,
        session: &Session,
        message_id: &str,
        status: &str,
        error: Option<String>,
        usage: Option<Value>,
        error_details: Option<Value>,
    ) -> Result<()> {
        let mut params;
        let receipts;
        {
            let mut data = session.data.lock().await;
            // Provider responses are measured before their tools run. A later
            // tool failure/cancellation must retain those durable measurements.
            let usage = usage.or_else(|| {
                data.turns
                    .get(message_id)
                    .and_then(|turn| turn.usage.clone())
            });
            settle_unfinished(
                &mut data,
                message_id,
                "Turn stopped before a durable tool result was recorded.",
            );
            receipts = flush_inbox(&mut data);
            let started = data
                .turns
                .get(message_id)
                .map(|t| t.started_at)
                .unwrap_or_else(now);
            if let Some(turn) = data.turns.get_mut(message_id) {
                turn.status = status.into();
                turn.error = error.clone();
                turn.error_details = error_details.clone();
                turn.usage = usage.clone();
            }
            for item in &mut data.items {
                if item["messageId"] == message_id
                    && matches!(item["kind"].as_str(), Some("text" | "thinking"))
                {
                    item["final"] = json!(true);
                }
            }
            data.items.push(json!({"kind":"turn","id":format!("{message_id}:turn"),"durationMs":now().saturating_sub(started)}));
            params = json!({"sessionId":data.id,"messageId":message_id,"status":status,"error":error,"usage":usage,"apiUsage":restored_usage(&data).0["apiUsage"],"recoveryRequired":data.recovery_required});
            if let Some(details) = error_details {
                params["errorDetails"] = details;
            }
            data.events
                .push(json!({"method":"turn/completed","params":params}));
            session.persist(&mut data)?;
        }
        *session.active.lock().await = None;
        for receipt_id in receipts {
            self.notification("inbox/consumed",json!({"sessionId":params["sessionId"],"messageId":message_id,"receiptId":receipt_id}));
        }
        self.notification("turn/completed", params);
        Ok(())
    }

    async fn record_usage(
        &self,
        session: &Session,
        message_id: &str,
        model: &str,
        totals: &UsageTotals,
        context: Option<u64>,
    ) -> Result<Value> {
        let mut usage = json!({"contextModel":model,"apiUsage":totals.value()});
        if let (Some(input), Some(output)) = (totals.input_tokens, totals.output_tokens) {
            usage["inputTokens"] = json!(input);
            usage["outputTokens"] = json!(output);
        }
        if let Some(context) = context {
            usage["contextTokens"] = json!(context);
        }
        if let Some((window, _)) = self.context_window(model).await {
            usage["contextWindow"] = json!(window);
        }
        if let Some(cost) = totals.cost_usd {
            usage["costUsd"] = json!(cost);
        }
        let (session_id, api_usage) = {
            let mut data = session.data.lock().await;
            let cutoff = data.context_cutoff;
            if let Some(turn) = data.turns.get_mut(message_id) {
                turn.context_cutoff = cutoff;
                turn.usage = Some(usage.clone());
            }
            session.persist(&mut data)?;
            (data.id.clone(), restored_usage(&data).0["apiUsage"].clone())
        };
        self.notification("usage/updated",json!({"sessionId":session_id,"messageId":message_id,"usage":usage,"apiUsage":api_usage}));
        Ok(usage)
    }

    async fn drive(
        self: Arc<Self>,
        session: Arc<Session>,
        message_id: &str,
        cancel: CancellationToken,
    ) -> Result<Option<Value>> {
        let session_id = session.data.lock().await.id.clone();
        self.emit(
            &session,
            "turn/started",
            json!({"sessionId":session_id,"messageId":message_id}),
        )
        .await?;
        let mut api_usage = UsageTotals::default();
        {
            let mut data = session.data.lock().await;
            let model = data.model.clone();
            if let Some(turn) = data.turns.get_mut(message_id) {
                turn.usage = Some(json!({"contextModel":model,"apiUsage":api_usage.value()}));
            }
            session.persist(&mut data)?;
        }
        let settings = session.tools.settings().clone();
        let workspace = session.data.lock().await.cwd.clone();
        let privacy = settings.privacy.clone();
        let guidance =
            tokio::task::spawn_blocking(move || crate::project::guidance(&workspace, &privacy))
                .await??;
        let mut repeated = HashMap::<String, usize>::new();
        let mut estimated_processed = 0u64;
        let mut tool_count = 0usize;
        for step in 0..settings.limits.max_rounds {
            ensure!(!cancel.is_cancelled(), "turn interrupted");
            let attempted = api_usage.value()["requests"]
                .as_u64()
                .unwrap_or(step as u64);
            ensure!(
                attempted < settings.limits.max_requests_per_turn,
                "turn API request budget reached"
            );
            let (cwd, mode, model, effort, mut messages) = {
                let data = session.data.lock().await;
                (
                    data.cwd.clone(),
                    data.mode.clone(),
                    data.model.clone(),
                    data.effort.clone(),
                    crate::context::projection(
                        &data.messages,
                        data.context_cutoff,
                        &data.context_summary,
                    ),
                )
            };
            let image_support = self.image_support(&model).await;
            messages = provider::project_history(&messages, image_support);
            let mut policy = system_prompt(&mode);
            policy.push_str(&guidance);
            if let Some(instructions) = session.tools.session_instructions() {
                policy.push_str("\n\nClient session guidance (the session's tool permission policy still applies):\n");
                policy.push_str(instructions);
            }
            if let Some(instructions) = session.tools.role_instructions() {
                policy.push_str(
                    "\n\nSession role instructions (the read-only tool policy still applies):\n",
                );
                policy.push_str(instructions);
            }
            messages.insert(0, json!({"role":"system","content":policy}));
            let mut definitions = session.tools.definitions(&mode);
            let metadata = self
                .models
                .lock()
                .await
                .iter()
                .find(|m| m["id"] == model)
                .cloned();
            ensure!(
                metadata
                    .as_ref()
                    .is_none_or(|m| m["supportsTools"] != false),
                "selected model explicitly does not support tools; choose a tool-capable model"
            );
            // A model must be able to inspect a screenshot before it can act on it.
            if image_support != Some(true) {
                definitions.retain(|tool| {
                    !tool["function"]["name"].as_str().is_some_and(|name| {
                        name.starts_with("desktop_") && !crate::desktop::read_only(name)
                    })
                });
            }
            let window = self
                .context_window(&model)
                .await
                .map(|v| v.0)
                .or(settings.context.fallback_window);
            let mut output_limit = settings.provider.max_output_tokens;
            if let Some(max) = metadata
                .as_ref()
                .and_then(|m| m["maxOutputTokens"].as_u64())
                .filter(|n| *n > 0)
            {
                output_limit = output_limit.min(max);
            }
            if let Some(window) = window {
                output_limit = output_limit.min((window / 4).max(1));
            }
            let overhead = crate::context::estimate(&json!(definitions));
            let estimate = crate::context::estimate(&json!(messages)).saturating_add(overhead);
            if let Some(window) = window {
                let reserve = settings.context.reserve_tokens.min(window / 8);
                let desired = window.saturating_sub(output_limit).saturating_sub(reserve);
                if estimate > desired.min(window * settings.context.threshold_percent / 100)
                    && settings.context.auto_compact
                {
                    let mut data = session.data.lock().await;
                    if let Some((cutoff, summary)) = crate::context::compact(
                        &data.messages,
                        data.context_cutoff,
                        &data.context_summary,
                        &settings.context,
                        estimate > desired,
                    ) {
                        data.context_cutoff = cutoff;
                        data.context_summary = summary;
                        let record = json!({"at":now(),"cutoff":cutoff,"automatic":true,"method":"extractive","estimatedBefore":estimate});
                        data.compactions.push(record.clone());
                        session.persist(&mut data)?;
                        messages = provider::project_history(
                            &crate::context::projection(
                                &data.messages,
                                cutoff,
                                &data.context_summary,
                            ),
                            image_support,
                        );
                        messages.insert(0, json!({"role":"system","content":policy}));
                        drop(data);
                        self.notification("context/compacted",json!({"sessionId":session_id,"messageId":message_id,"compaction":record}));
                    }
                }
                let projected = crate::context::estimate(&json!(messages)).saturating_add(overhead);
                ensure!(projected.saturating_add(output_limit).saturating_add(reserve)<=window,"estimated request exceeds context budget; compact, shorten input, or select a larger context window (estimates are not provider token counts)");
            }
            let request_estimate =
                crate::context::estimate(&json!(messages)).saturating_add(overhead);
            let totals = api_usage.value();
            if let Some(limit) = settings.limits.max_turn_tokens {
                ensure!(
                    (if totals["partial"] == true {
                        totals["totalTokens"]
                            .as_u64()
                            .unwrap_or(0)
                            .max(estimated_processed)
                    } else {
                        totals["totalTokens"]
                            .as_u64()
                            .unwrap_or(estimated_processed)
                    })
                    .saturating_add(request_estimate)
                    .saturating_add(output_limit)
                        <= limit,
                    "turn token budget would be exceeded"
                );
            }
            let conversation_usage = {
                let data = session.data.lock().await;
                restored_usage(&data).0["apiUsage"].clone()
            };
            if let Some(limit) = settings.limits.max_conversation_tokens {
                let data = session.data.lock().await;
                ensure!(!(data.budget_reserved_estimate_tokens==0 && data.turns.keys().any(|id|id!=message_id) && (conversation_usage["partial"]==true || conversation_usage["totalTokens"].is_null())),"conversation token budget cannot account for unmeasured legacy history; use a new conversation or a per-turn budget");
                ensure!(
                    conversation_usage["totalTokens"]
                        .as_u64()
                        .unwrap_or(0)
                        .max(data.budget_reserved_estimate_tokens)
                        .saturating_add(request_estimate)
                        .saturating_add(output_limit)
                        <= limit,
                    "conversation token budget would be exceeded"
                );
            }
            if let Some(limit) = settings.limits.max_cost_usd {
                let configured = settings
                    .provider
                    .pricing
                    .as_ref()
                    .map(serde_json::to_value)
                    .transpose()?;
                let pricing=configured.as_ref().or_else(||metadata.as_ref().and_then(|m|m.get("pricing"))).context("a USD budget requires model pricing; configure provider.pricing, token limits or a provider-enforced budget")?;
                let input = pricing["inputUsdPerMillion"]
                    .as_f64()
                    .context("input price unavailable")?;
                let output = pricing["outputUsdPerMillion"]
                    .as_f64()
                    .context("output price unavailable")?;
                let reserve =
                    (request_estimate as f64 * input + output_limit as f64 * output) / 1_000_000.0;
                let mut data = session.data.lock().await;
                ensure!(!(data.budget_reserved_estimate_usd==0.0 && data.turns.keys().any(|id|id!=message_id) && conversation_usage["costPartial"]==true),"USD budget cannot account for unpriced prior requests; use a new conversation or token limits");
                let spent = data
                    .budget_reserved_estimate_usd
                    .max(conversation_usage["costUsd"].as_f64().unwrap_or(0.0));
                ensure!(spent+reserve<=limit,"estimated generation reservation exceeds USD budget; estimates cannot guarantee the provider's final charge");
                data.budget_reserved_estimate_usd = spent + reserve;
                session.persist(&mut data)?;
            }
            {
                let mut data = session.data.lock().await;
                data.budget_reserved_estimate_tokens = data
                    .budget_reserved_estimate_tokens
                    .max(conversation_usage["totalTokens"].as_u64().unwrap_or(0))
                    .saturating_add(request_estimate)
                    .saturating_add(output_limit);
                session.persist(&mut data)?;
            }
            estimated_processed = estimated_processed
                .saturating_add(request_estimate)
                .saturating_add(output_limit);
            {
                let mut data = session.data.lock().await;
                let cleared = data
                    .turns
                    .get_mut(message_id)
                    .and_then(|turn| turn.usage.as_mut())
                    .and_then(Value::as_object_mut)
                    .is_some_and(|usage| usage.remove("contextTokens").is_some());
                if cleared {
                    // Earlier measured requests still count, but a new request
                    // has no context measurement until its response supplies one.
                    session.persist(&mut data)?;
                }
            }
            let (tx, mut rx) = mpsc::unbounded_channel();
            let mut provider_options = settings.provider.clone();
            provider_options.retries = provider_options
                .retries
                .min((settings.limits.max_requests_per_turn - attempted - 1) as usize);
            let completion = provider::complete_configured(
                &self.profile,
                &model,
                effort.as_deref(),
                &messages,
                &definitions,
                tx,
                cancel.clone(),
                &provider_options,
                output_limit,
            );
            tokio::pin!(completion);
            let mut channel_open = true;
            let completed = loop {
                tokio::select! {
                    result=&mut completion => {
                        while let Ok(delta)=rx.try_recv(){self.delta(&session,&session_id,message_id,step,delta).await?;}
                        match result {
                            Ok(completed)=>break completed,
                            Err(error)=>{
                                let rejected_usage=error.downcast_ref::<provider::ApiError>().map(|e|json!({"trex_request_attempts":e.attempts}));
                                api_usage.observe(error.downcast_ref::<provider::IncompleteCompletion>().and_then(|v|v.usage.as_ref()).or(rejected_usage.as_ref()));
                                self.record_usage(&session, message_id, &model, &api_usage, None).await?;
                                if let Some(incomplete)=error.downcast_ref::<provider::IncompleteCompletion>() {
                                    let mut data=session.data.lock().await;
                                    data.rejected_responses.push(json!({"messageId":message_id,"step":step,"message":incomplete.message,"rawDeltas":incomplete.raw_deltas,"usage":incomplete.usage,"finishReason":incomplete.finish_reason,"cancelled":incomplete.cancelled}));
                                    // Keep incomplete text/reasoning available to a later
                                    // "continue" request, but never replay truncated calls.
                                    let mut safe=incomplete.message.clone();
                                    if let Some(fields)=safe.as_object_mut() {
                                        fields.insert("role".into(),json!("assistant"));
                                        fields.remove("tool_calls");
                                        fields.remove("function_call");
                                        if fields.get("content").is_none_or(Value::is_null) {fields.insert("content".into(),json!(""));}
                                        if fields["content"]!="" || fields.keys().any(|key|key.starts_with("reasoning")) {data.messages.push(safe);}
                                    }
                                    session.persist(&mut data)?;
                                }
                                return Err(error);
                            }
                        }
                    }
                    delta=rx.recv(), if channel_open => match delta {Some(delta)=>self.delta(&session,&session_id,message_id,step,delta).await?,None=>channel_open=false},
                }
            };
            ensure!(
                matches!(
                    completed.finish_reason.as_str(),
                    "stop" | "tool_calls" | "function_call"
                ),
                "provider response incomplete: {}",
                completed.finish_reason
            );
            // Missing counters do not represent a measured zero. Prompt totals
            // already include cache hits, and completion totals include thinking.
            let context = completed
                .usage
                .as_ref()
                .and_then(provider_token_counts)
                .map(|(input, output)| input.saturating_add(output));
            api_usage.observe(completed.usage.as_ref());
            let usage = self
                .record_usage(&session, message_id, &model, &api_usage, context)
                .await?;
            let calls = completed
                .message
                .get("tool_calls")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            tool_count = tool_count.saturating_add(calls.len());
            ensure!(
                calls.len() <= 128 && tool_count <= settings.limits.max_tool_calls_per_turn,
                "tool call budget exceeded; no remaining tools were executed"
            );
            let has_final_text = completed.message["content"]
                .as_str()
                .is_some_and(|text| !text.trim().is_empty())
                || completed.message["content"]
                    .as_array()
                    .is_some_and(|parts| {
                        parts.iter().any(|part| {
                            part["text"]
                                .as_str()
                                .is_some_and(|text| !text.trim().is_empty())
                        })
                    });
            {
                let mut data = session.data.lock().await;
                if let Some(turn) = data.turns.get_mut(message_id) {
                    turn.usage = Some(usage.clone());
                }
                data.messages.push(completed.message);
                for item in &mut data.items {
                    if item["id"] == format!("{message_id}:assistant:{step}:text")
                        || item["id"] == format!("{message_id}:assistant:{step}:thinking")
                    {
                        item["final"] = json!(true);
                    }
                }
                session.persist(&mut data)?;
            }
            if calls.is_empty() {
                ensure!(
                    has_final_text,
                    "provider completed without a visible final answer"
                );
                return Ok(Some(usage));
            }
            for call in &calls {
                let name = call["function"]["name"].as_str().unwrap_or("");
                let arguments: Value =
                    serde_json::from_str(call["function"]["arguments"].as_str().unwrap_or("{}"))?;
                if !session.tools.is_mutating(&mode, name, &arguments) {
                    continue;
                }
                let execution_id =
                    format!("{message_id}:tool:{}", call["id"].as_str().unwrap_or(""));
                if session
                    .data
                    .lock()
                    .await
                    .executions
                    .contains_key(&execution_id)
                {
                    continue;
                }
                let fingerprint = format!(
                    "{name}:{}",
                    call["function"]["arguments"].as_str().unwrap_or("")
                );
                repeated.retain(|key, _| key == &fingerprint);
                let count = repeated.entry(fingerprint).or_default();
                *count += 1;
                ensure!(*count<=settings.limits.repeated_tool_limit,"repeated identical tool loop detected; inspect existing results before continuing");
            }
            if calls.len() > 1
                && calls.iter().all(|call| {
                    matches!(
                        call["function"]["name"].as_str(),
                        Some("read_file" | "list_files" | "search")
                    )
                })
            {
                let fresh = {
                    let data = session.data.lock().await;
                    calls.iter().all(|call| {
                        !data.executions.contains_key(&format!(
                            "{message_id}:tool:{}",
                            call["id"].as_str().unwrap_or("")
                        ))
                    })
                };
                if fresh {
                    self.parallel_reads(
                        &session,
                        &session_id,
                        message_id,
                        &cwd,
                        &mode,
                        &calls,
                        cancel.clone(),
                        settings.tools.parallel_reads,
                    )
                    .await?;
                    continue;
                }
            }
            let mut ids = BTreeSet::new();
            for call in calls {
                ensure!(!cancel.is_cancelled(), "turn interrupted");
                let provider_id = required(&call, "id")?.to_string();
                let id = format!("{message_id}:tool:{provider_id}");
                ensure!(
                    ids.insert(id.clone()),
                    "provider repeated a tool id within one assistant message"
                );
                let name = required(&call["function"], "name")?.to_string();
                let arguments = call["function"]["arguments"]
                    .as_str()
                    .context("tool arguments must be a JSON string")?;
                ensure!(
                    arguments.len() <= 8 * 1024 * 1024,
                    "tool arguments exceed 8 MiB"
                );
                let input: Value = match serde_json::from_str(arguments) {
                    Ok(input) => input,
                    Err(_) => {
                        self.tool_error(
                            &session,
                            &session_id,
                            message_id,
                            &id,
                            &provider_id,
                            &name,
                            json!({}),
                            "tool arguments must be valid JSON",
                        )
                        .await?;
                        continue;
                    }
                };
                let old = { session.data.lock().await.executions.get(&id).cloned() };
                if let Some(old) = old {
                    ensure!(
                        old.name == name && old.input == input,
                        "provider reused tool id with different arguments"
                    );
                    ensure!(
                        old.state == "done",
                        "tool execution is uncertain and cannot be retried"
                    );
                    // A repeated tool-call id may be replayed by a provider. Reuse its durable result.
                    let mut data = session.data.lock().await;
                    data.messages.push(json!({"role":"tool","tool_call_id":provider_id,"content":serde_json::to_string(&old.output)?}));
                    session.persist(&mut data)?;
                    continue;
                }
                let known = definitions
                    .iter()
                    .any(|tool| tool["function"]["name"] == name);
                if !known {
                    self.tool_error(
                        &session,
                        &session_id,
                        message_id,
                        &id,
                        &provider_id,
                        &name,
                        input,
                        if mode == "plan" && tools::is_mutating(&name) {
                            "plan mode forbids mutations and shell execution"
                        } else {
                            "unknown or unavailable tool"
                        },
                    )
                    .await?;
                    continue;
                }
                {
                    let mut data = session.data.lock().await;
                    data.executions.insert(
                        id.clone(),
                        Execution {
                            name: name.clone(),
                            input: input.clone(),
                            state: "awaiting".into(),
                            message_id: message_id.into(),
                            provider_id: Some(provider_id.clone()),
                            output: None,
                            is_error: false,
                            operation_id: Some(uid()),
                        },
                    );
                    session.persist(&mut data)?;
                }
                self.emit(&session,"tool/start",json!({"sessionId":session_id,"messageId":message_id,"id":id,"toolName":name,"input":input})).await?;
                if mode == "ask"
                    && session.tools.is_mutating(&mode, &name, &input)
                    && !self
                        .approval(
                            &session,
                            &session_id,
                            message_id,
                            &id,
                            &name,
                            &input,
                            cancel.clone(),
                        )
                        .await?
                {
                    self.tool_result(
                        &session,
                        &session_id,
                        message_id,
                        &id,
                        json!({"error":"permission denied; no tool was executed"}),
                        true,
                    )
                    .await?;
                    continue;
                }
                ensure!(!cancel.is_cancelled(), "turn interrupted");
                {
                    let mut data = session.data.lock().await;
                    data.executions
                        .get_mut(&id)
                        .context("tool journal missing")?
                        .state = "executing".into();
                    session.persist(&mut data)?;
                }
                if name == "task_state" || name == "history_search" {
                    let output = {
                        let data = session.data.lock().await;
                        conversation_read(&data, &name, &input)
                    };
                    let (output, error) = match output {
                        Ok(v) => (v, false),
                        Err(e) => (json!({"error":e.to_string()}), true),
                    };
                    self.tool_result(&session, &session_id, message_id, &id, output, error)
                        .await?;
                } else if name == "trex_read_messages" {
                    ensure!(
                        input.as_object().is_some_and(|m| m.is_empty()),
                        "trex_read_messages arguments must be an empty object"
                    );
                    match self
                        .inbox(&session, &session_id, message_id, &id, cancel.clone())
                        .await
                    {
                        Ok(()) => (),
                        Err(error) => {
                            self.tool_result(
                                &session,
                                &session_id,
                                message_id,
                                &id,
                                json!({"error":error.to_string()}),
                                true,
                            )
                            .await?
                        }
                    }
                } else {
                    let operation_id = session.data.lock().await.executions[&id]
                        .operation_id
                        .clone()
                        .context("tool operation id missing")?;
                    let result = session
                        .tools
                        .execute(&cwd, &mode, &name, &input, &operation_id, cancel.clone())
                        .await;
                    let (output, is_error) = match result {
                        Ok(output) => {
                            let output = if name.starts_with("browser_")
                                || name.starts_with("mcp_")
                                || name == "desktop_screenshot"
                            {
                                let client_id = session
                                    .data
                                    .lock()
                                    .await
                                    .browser
                                    .client_id
                                    .clone()
                                    .unwrap_or_else(|| session_id.clone());
                                let normalized = artifacts::normalize_tool_result(
                                    output,
                                    json!({"toolName":name,"toolCallId":provider_id,"operationId":operation_id,"clientId":client_id}),
                                )?;
                                if name == "desktop_screenshot"
                                    && normalized["artifacts"]
                                        .as_array()
                                        .is_none_or(|items| items.is_empty())
                                {
                                    // Never accept input for a capture the model could not receive.
                                    session.tools.invalidate_observation();
                                }
                                normalized
                            } else {
                                output
                            };
                            let is_error = output["isError"] == true;
                            (output, is_error)
                        }
                        Err(error)
                            if error.downcast_ref::<ExecutionUncertain>().is_some()
                                || error.downcast_ref::<crate::mcp::McpUncertain>().is_some()
                                || error
                                    .downcast_ref::<tools::ToolExecutionUncertain>()
                                    .is_some()
                                || error
                                    .downcast_ref::<crate::desktop::DesktopUncertain>()
                                    .is_some()
                                || error
                                    .downcast_ref::<crate::github::GithubUncertain>()
                                    .is_some()
                                || error
                                    .downcast_ref::<crate::blender::BlenderUncertain>()
                                    .is_some()
                                || error
                                    .downcast_ref::<crate::hyperframes::HyperframesUncertain>()
                                    .is_some()
                                || error
                                    .downcast_ref::<crate::team::DelegationUncertain>()
                                    .is_some() =>
                        {
                            return Err(error)
                        }
                        Err(error) => (json!({"error":error.to_string()}), true),
                    };
                    self.tool_result(&session, &session_id, message_id, &id, output, is_error)
                        .await?;
                }
            }
            let receipts = {
                let mut data = session.data.lock().await;
                let receipts = flush_inbox(&mut data);
                session.persist(&mut data)?;
                receipts
            };
            for receipt_id in receipts {
                self.notification(
                    "inbox/consumed",
                    json!({"sessionId":session_id,"messageId":message_id,"receiptId":receipt_id}),
                );
            }
        }
        bail!(
            "turn exceeded {} provider rounds; no work was retried",
            settings.limits.max_rounds
        )
    }

    async fn parallel_reads(
        &self,
        session: &Session,
        session_id: &str,
        message_id: &str,
        cwd: &Path,
        mode: &str,
        calls: &[Value],
        cancel: CancellationToken,
        concurrency: usize,
    ) -> Result<()> {
        use futures_util::StreamExt;
        let mut jobs = Vec::new();
        let mut notifications = Vec::new();
        let mut seen = BTreeSet::new();
        {
            let mut data = session.data.lock().await;
            for call in calls {
                let provider_id = required(call, "id")?.to_owned();
                let id = format!("{message_id}:tool:{provider_id}");
                ensure!(
                    seen.insert(id.clone()),
                    "duplicate tool ID in parallel read batch"
                );
                let name = required(&call["function"], "name")?.to_owned();
                let input: Value = serde_json::from_str(
                    call["function"]["arguments"]
                        .as_str()
                        .context("tool arguments missing")?,
                )?;
                let operation = uid();
                data.executions.insert(
                    id.clone(),
                    Execution {
                        name: name.clone(),
                        input: input.clone(),
                        state: "executing".into(),
                        message_id: message_id.into(),
                        provider_id: Some(provider_id),
                        output: None,
                        is_error: false,
                        operation_id: Some(operation.clone()),
                    },
                );
                let params = json!({"sessionId":session_id,"messageId":message_id,"id":id,"toolName":name,"input":input});
                project(&mut data.items, "tool/start", &params);
                data.events
                    .push(json!({"method":"tool/start","params":params}));
                notifications.push(params);
                jobs.push((id, name, input, operation));
            }
            session.persist(&mut data)?;
        }
        for params in notifications {
            self.notification("tool/start", params);
        }
        let mut reads =
            futures_util::stream::iter(jobs.into_iter().map(|(id, name, input, operation)| {
                let cancel = cancel.clone();
                async move {
                    let result = session
                        .tools
                        .execute(cwd, mode, &name, &input, &operation, cancel)
                        .await;
                    (id, result)
                }
            }))
            .buffered(concurrency);
        while let Some((id, result)) = reads.next().await {
            let (output, error) = match result {
                Ok(value) => (value, false),
                Err(error) => (json!({"error":error.to_string()}), true),
            };
            self.tool_result(session, session_id, message_id, &id, output, error)
                .await?;
        }
        ensure!(!cancel.is_cancelled(), "turn interrupted");
        Ok(())
    }

    async fn delta(
        &self,
        session: &Session,
        session_id: &str,
        message_id: &str,
        step: usize,
        delta: ProviderDelta,
    ) -> Result<()> {
        let (kind, text) = match delta {
            ProviderDelta::Text(text) => ("text", text),
            ProviderDelta::Thinking(text) => ("thinking", text),
            ProviderDelta::Retry { attempt, delay_ms } => {
                self.notification("provider/retry",json!({"sessionId":session_id,"messageId":message_id,"attempt":attempt,"delayMs":delay_ms}));
                return Ok(());
            }
        };
        if text.is_empty() {
            return Ok(());
        }
        self.emit(session,"message/delta",json!({"sessionId":session_id,"messageId":message_id,"id":format!("{message_id}:assistant:{step}:{kind}"),"text":text,"kind":kind})).await
    }

    async fn tool_error(
        &self,
        session: &Session,
        session_id: &str,
        message_id: &str,
        id: &str,
        provider_id: &str,
        name: &str,
        input: Value,
        error: &str,
    ) -> Result<()> {
        {
            let mut data = session.data.lock().await;
            data.executions.insert(
                id.into(),
                Execution {
                    name: name.into(),
                    input: input.clone(),
                    state: "awaiting".into(),
                    message_id: message_id.into(),
                    provider_id: Some(provider_id.into()),
                    output: None,
                    is_error: true,
                    operation_id: None,
                },
            );
            session.persist(&mut data)?;
        }
        self.emit(session,"tool/start",json!({"sessionId":session_id,"messageId":message_id,"id":id,"toolName":name,"input":input})).await?;
        self.tool_result(
            session,
            session_id,
            message_id,
            id,
            json!({"error":error}),
            true,
        )
        .await
    }

    async fn tool_result(
        &self,
        session: &Session,
        session_id: &str,
        message_id: &str,
        id: &str,
        output: Value,
        is_error: bool,
    ) -> Result<()> {
        let params = json!({"sessionId":session_id,"messageId":message_id,"id":id,"output":output,"isError":is_error,"artifacts":output.get("artifacts").cloned().unwrap_or_else(||json!([]))});
        {
            let mut data = session.data.lock().await;
            let before = data.clone();
            record_result(&mut data, id, &output, is_error)?;
            project(&mut data.items, "tool/result", &params);
            data.events
                .push(json!({"method":"tool/result","params":params}));
            if let Err(error) = session.persist(&mut data) {
                *data = before;
                return Err(error);
            }
        }
        self.notification("tool/result", params);
        Ok(())
    }

    async fn approval(
        &self,
        session: &Session,
        session_id: &str,
        message_id: &str,
        tool_id: &str,
        name: &str,
        input: &Value,
        cancel: CancellationToken,
    ) -> Result<bool> {
        let id = format!("permission:{}", uid());
        let (tx, rx) = oneshot::channel();
        self.permissions.lock().await.insert(id.clone(), tx);
        if let Err(error)=self.emit(session,"permission/request",json!({"sessionId":session_id,"messageId":message_id,"id":id,"toolName":name,"toolUseId":tool_id,"input":input,"description":format!("Allow {name} in this workspace?")})).await{self.permissions.lock().await.remove(&id);return Err(error);}
        let result = tokio::select! {reply=rx=>reply.context("permission response channel closed"),_=cancel.cancelled()=>Err(anyhow::anyhow!("turn interrupted"))};
        self.permissions.lock().await.remove(&id);
        if let Ok(allowed) = result {
            let mut data = session.data.lock().await;
            for item in &mut data.items {
                if item["kind"] == "permission" && item["id"] == id {
                    item["state"] = json!(if allowed { "allowed" } else { "denied" });
                }
            }
            session.persist(&mut data)?;
        }
        result
    }

    async fn inbox(
        &self,
        session: &Session,
        session_id: &str,
        message_id: &str,
        tool_id: &str,
        cancel: CancellationToken,
    ) -> Result<()> {
        let id = format!("inbox:{}", uid());
        let (tx, rx) = oneshot::channel();
        self.callbacks.lock().await.insert(id.clone(), tx);
        self.send(json!({"jsonrpc":"2.0","id":id,"method":"inbox/read","params":{"sessionId":session_id,"messageId":message_id}}));
        let reply = tokio::select! {reply=rx=>reply.context("inbox response channel closed")?,_=cancel.cancelled()=>{self.callbacks.lock().await.remove(&id);bail!("turn interrupted");},_=tokio::time::sleep(Duration::from_secs(60))=>{self.callbacks.lock().await.remove(&id);bail!("inbox callback timed out");}};
        self.callbacks.lock().await.remove(&id);
        let reply = reply.map_err(anyhow::Error::msg)?;
        let messages = reply
            .get("messages")
            .and_then(Value::as_array)
            .context("inbox/read result must contain messages array")?;
        ensure!(
            messages.len() <= 1000,
            "inbox callback returned too many messages"
        );
        let receipt = optional(&reply, "receiptId")?;
        ensure!(
            messages.is_empty()
                || receipt.is_some()
                || messages.iter().all(|m| m["receiptId"].is_string()),
            "nonempty inbox snapshot requires receiptId"
        );
        let mut queued = Vec::new();
        let mut receipts = BTreeMap::<String, Vec<Value>>::new();
        for message in messages {
            let rid = receipt
                .clone()
                .or(optional(message, "receiptId")?)
                .context("missing receiptId")?;
            required(message, "id")?;
            let text = message["text"]
                .as_str()
                .context("inbox text must be a string")?;
            let images = validate_images(message.get("images"))?;
            ensure!(text.len() <= 8 * 1024 * 1024, "inbox text exceeds 8 MiB");
            receipts.entry(rid).or_default().push(json!({"id":message["id"],"text":text,"images":images,"previews":message.get("previews").cloned().unwrap_or_else(||json!(previews(&images)))}));
        }
        if let Some(receipt) = receipt {
            receipts.entry(receipt).or_default();
        }
        let output;
        {
            let mut data = session.data.lock().await;
            // Validate the whole snapshot before applying any row or receipt.
            let mut new_ids = BTreeSet::new();
            for (receipt_id, messages) in &receipts {
                if let Some(old) = data.receipts.get(receipt_id) {
                    ensure!(
                        old["messages"] == json!(messages),
                        "receiptId was reused with different messages"
                    );
                    continue;
                }
                for message in messages {
                    let msg_id = required(message, "id")?;
                    ensure!(
                        new_ids.insert(msg_id.to_string())
                            && !data.items.iter().any(|item| item["id"] == msg_id),
                        "inbox message id already exists in conversation or snapshot"
                    );
                }
            }
            let before = data.clone();
            let mut count = 0usize;
            for (receipt_id, messages) in &receipts {
                if let Some(old) = data.receipts.get(receipt_id) {
                    ensure!(
                        old["messages"] == json!(messages),
                        "receiptId was reused with different messages"
                    );
                    queued.push(receipt_id.clone());
                    continue;
                }
                for message in messages {
                    let msg_id = required(message, "id")?;
                    ensure!(
                        !data.items.iter().any(|item| item["id"] == msg_id),
                        "inbox message id already exists in conversation"
                    );
                    data.items.push(json!({"kind":"user","id":msg_id,"text":message["text"],"images":message["images"].as_array().map(Vec::len).unwrap_or(0),"previews":message["previews"],"fromQueue":true}));
                    let images = message["images"].as_array().cloned().unwrap_or_default();
                    data.pending_inbox.push(user_message(
                        message["text"].as_str().unwrap_or(""),
                        &images,
                    ));
                    count += 1;
                }
                data.receipts.insert(
                    receipt_id.clone(),
                    json!({"messages":messages,"committed":false}),
                );
            }
            output = json!({"received":count,"messageIds":messages.iter().map(|m|m["id"].clone()).collect::<Vec<_>>(),"note":"Inbox messages are appended as user messages after this tool batch."});
            record_result(&mut data, tool_id, &output, false)?;
            if let Err(error) = session.persist(&mut data) {
                *data = before;
                return Err(error);
            }
        }
        self.emit(session,"tool/result",json!({"sessionId":session_id,"messageId":message_id,"id":tool_id,"output":output,"isError":false})).await?;
        // Previously committed receipts can be acknowledged again after a lost frontend ack.
        for receipt_id in queued {
            let committed = session.data.lock().await.receipts[&receipt_id]["committed"] == true;
            if committed {
                self.notification(
                    "inbox/consumed",
                    json!({"sessionId":session_id,"messageId":message_id,"receiptId":receipt_id}),
                );
            }
        }
        Ok(())
    }

    async fn method(self: &Arc<Self>, method: &str, params: &Value) -> Result<Value> {
        match method {
            "initialize" => {
                if let Some(version) = params.get("protocolVersion") {
                    ensure!(version == 1, "unsupported protocolVersion; expected 1");
                }
                let mut model = json!({"id":self.profile.model,"name":self.profile.model});
                if let Some((window, source)) = self.context_window(&self.profile.model).await {
                    model["contextWindow"] = json!(window);
                    model["contextWindowSource"] = json!(source);
                }
                Ok(
                    json!({"protocolVersion":1,"profile":{"name":self.profile.name,"provider":self.profile.provider,"baseUrl":self.profile.base_url,"model":self.profile.model,"effort":self.profile.effort,"hasApiKey":profile::api_key(&self.profile)?.is_some()},"models":[model],"capabilities":{"streaming":true,"tools":true,"permissions":true,"interrupt":true,"history":true,"inbox":true,"images":true,"modes":["plan","ask","full"],"sessionRecovery":true,"contextCompaction":true,"sessionConfiguration":true,"processInput":true,"processResize":true,"incrementalProcessOutput":true,"mcpClient":true,"nativeCheckpoints":true,"budgets":true,"structuredErrors":true}}),
                )
            }
            "models/list" => {
                let models = provider::models(&self.profile).await?;
                *self.models.lock().await = models.clone();
                Ok(json!({"models":models}))
            }
            "session/start" => self.start_session(params).await,
            "session/history" => {
                let session = self.session(params).await?;
                let data = session.data.lock().await;
                Ok(self.session_summary(&data).await)
            }
            "session/compact" => {
                let session = self.session(params).await?;
                ensure!(
                    session.active.lock().await.is_none(),
                    "cannot compact an active turn"
                );
                let mut data = session.data.lock().await;
                if let Some((cutoff, summary)) = crate::context::compact(
                    &data.messages,
                    data.context_cutoff,
                    &data.context_summary,
                    &session.tools.settings().context,
                    true,
                ) {
                    data.context_cutoff = cutoff;
                    data.context_summary = summary;
                    data.compactions.push(
                        json!({"at":now(),"cutoff":cutoff,"automatic":false,"method":"extractive"}),
                    );
                    session.persist(&mut data)?;
                }
                Ok(self.session_summary(&data).await)
            }
            "session/configure" => {
                let session = self.session(params).await?;
                ensure!(
                    session.active.lock().await.is_none(),
                    "cannot configure an active turn"
                );
                let mut data = session.data.lock().await;
                let data_mut = &mut *data;
                select_model(&mut data_mut.model, &mut data_mut.effort, params)?;
                session.tools.invalidate_observation();
                session.persist(&mut data)?;
                Ok(self.session_summary(&data).await)
            }
            "session/close" => {
                let session = self.session(params).await?;
                ensure!(
                    session.active.lock().await.is_none(),
                    "cannot close an active turn; interrupt it first"
                );
                session.tools.shutdown().await;
                self.sessions
                    .lock()
                    .await
                    .remove(required(params, "sessionId")?);
                Ok(json!({"closed":true}))
            }
            "session/usage" => {
                let session = self.session(params).await?;
                let data = session.data.lock().await;
                let summary = self.session_summary(&data).await;
                Ok(
                    json!({"sessionId":data.id,"model":data.model,"contextWindow":summary["contextWindow"],"usage":summary["usage"]}),
                )
            }
            "process/list" => {
                let session = self.session(params).await?;
                Ok(session.tools.processes().list())
            }
            "process/read" => {
                let session = self.session(params).await?;
                session.tools.processes().read_since(
                    required(params, "processId")?,
                    params.get("after").and_then(Value::as_u64),
                )
            }
            "process/write" => {
                let session = self.session(params).await?;
                session
                    .tools
                    .processes()
                    .write(
                        required(params, "processId")?,
                        params["text"].as_str().context("text must be a string")?,
                    )
                    .await
            }
            "process/resize" => {
                let session = self.session(params).await?;
                let rows = params["rows"]
                    .as_u64()
                    .and_then(|n| u16::try_from(n).ok())
                    .context("invalid rows")?;
                let cols = params["cols"]
                    .as_u64()
                    .and_then(|n| u16::try_from(n).ok())
                    .context("invalid cols")?;
                session
                    .tools
                    .processes()
                    .resize(required(params, "processId")?, rows, cols)
            }
            "process/stop" => {
                let session = self.session(params).await?;
                session
                    .tools
                    .processes()
                    .stop(required(params, "processId")?)
                    .await
            }
            "sessions/list" => {
                Ok(json!({"conversations":list_sessions(Some(&self.profile.name))?}))
            }
            "session/recover" => {
                ensure!(
                    required(params, "action")? == "acknowledge",
                    "action must be acknowledge"
                );
                let session = self.session(params).await?;
                ensure!(
                    session.active.lock().await.is_none(),
                    "cannot recover an active turn"
                );
                let mut data = session.data.lock().await;
                data.recovery_required = false;
                data.items.push(json!({"kind":"notice","id":uid(),"tone":"info","text":"Restored tool state acknowledged. Uncertain tools will not be replayed."}));
                session.persist(&mut data)?;
                Ok(self.session_summary(&data).await)
            }
            "turn/start" => self.start_turn(params).await,
            "turn/interrupt" => {
                let session = self.session(params).await?;
                let active = session.active.lock().await;
                if let Some(active) = active.as_ref() {
                    if let Some(id) = optional(params, "messageId")? {
                        ensure!(active.message_id == id, "messageId is not the active turn");
                    }
                    active.cancel.cancel();
                    Ok(json!({"interrupted":true,"messageId":active.message_id}))
                } else {
                    Ok(json!({"interrupted":false}))
                }
            }
            "permission/respond" => {
                let id = required(params, "id")?;
                let allowed = params
                    .get("allowed")
                    .and_then(Value::as_bool)
                    .or_else(|| match params["decision"].as_str() {
                        Some("allow") => Some(true),
                        Some("deny") => Some(false),
                        _ => None,
                    })
                    .context("allowed must be a boolean")?;
                let tx = self
                    .permissions
                    .lock()
                    .await
                    .remove(id)
                    .context("permission is no longer pending")?;
                tx.send(allowed)
                    .map_err(|_| anyhow::anyhow!("permission is no longer pending"))?;
                Ok(json!({"accepted":true}))
            }
            "shutdown" => {
                self.cancel_all().await;
                Ok(json!({"accepted":true}))
            }
            _ => bail!("method not found: {method}"),
        }
    }

    pub async fn handle(self: &Arc<Self>, request: Value) {
        if request.get("method").is_none() {
            if let Some(id) = request["id"].as_str() {
                if let Some(tx) = self.callbacks.lock().await.remove(id) {
                    let result = if request.get("error").is_some() {
                        Err(request["error"]["message"]
                            .as_str()
                            .unwrap_or("inbox callback failed")
                            .to_string())
                    } else {
                        Ok(request["result"].clone())
                    };
                    let _ = tx.send(result);
                }
            }
            return;
        }
        let id = request.get("id").cloned();
        if request["jsonrpc"] != "2.0"
            || !request["method"].is_string()
            || id
                .as_ref()
                .is_some_and(|id| !id.is_string() && !id.is_number() && !id.is_null())
        {
            self.send(json!({"jsonrpc":"2.0","id":id.unwrap_or(Value::Null),"error":{"code":-32600,"message":"invalid JSON-RPC 2.0 request"}}));
            return;
        }
        let mut cache_key = id.as_ref().map(Value::to_string);
        if let Some(key) = cache_key.clone() {
            let mut cache = self.requests.lock().await;
            if let Some(cached) = cache.get_mut(&key) {
                if cached.request != request {
                    self.send(json!({"jsonrpc":"2.0","id":id,"error":{"code":-32600,"message":"request id already used with different input"}}));
                    return;
                }
                if let Some(response) = &cached.response {
                    self.send(response.clone());
                    return;
                }
                let (tx, rx) = oneshot::channel();
                cached.waiters.push(tx);
                drop(cache);
                if let Ok(response) = rx.await {
                    self.send(response);
                }
                return;
            }
            if cache.len() >= 16384 {
                if let Some(finished) = cache
                    .iter()
                    .find(|(_, entry)| entry.response.is_some())
                    .map(|(key, _)| key.clone())
                {
                    cache.remove(&finished);
                } else {
                    cache_key = None;
                }
            }
            if cache_key.is_some() {
                cache.insert(
                    key.clone(),
                    CachedRequest {
                        request: request.clone(),
                        response: None,
                        waiters: vec![],
                    },
                );
            }
        }
        let method = request["method"].as_str().unwrap_or("");
        let params = request.get("params").cloned().unwrap_or_else(|| json!({}));
        let result = if !params.is_object() {
            Err(anyhow::anyhow!("params must be an object"))
        } else {
            self.method(method, &params).await
        };
        if let Some(id) = id {
            let response = match result {
                Ok(result) => json!({"jsonrpc":"2.0","id":id,"result":result}),
                Err(error) => {
                    let message = error.to_string();
                    json!({"jsonrpc":"2.0","id":id,"error":{"code":if message.starts_with("method not found:"){-32601}else{-32000},"message":message}})
                }
            };
            if let Some(key) = cache_key {
                if let Some(cached) = self.requests.lock().await.get_mut(&key) {
                    cached.response = Some(response.clone());
                    for waiter in cached.waiters.drain(..) {
                        let _ = waiter.send(response.clone());
                    }
                }
            }
            self.send(response);
        }
    }

    async fn cancel_all(&self) {
        let sessions: Vec<_> = self.sessions.lock().await.values().cloned().collect();
        for session in sessions {
            if let Some(active) = session.active.lock().await.as_ref() {
                active.cancel.cancel();
            }
            session.tools.shutdown().await;
        }
    }
    pub async fn shutdown(&self) {
        self.cancel_all().await;
        self.wait_idle().await;
    }

    async fn wait_idle(&self) {
        for _ in 0..100 {
            let sessions = self
                .sessions
                .lock()
                .await
                .values()
                .cloned()
                .collect::<Vec<_>>();
            let mut active = false;
            for session in sessions {
                active |= session.active.lock().await.is_some();
            }
            if !active {
                return;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }
}

fn provider_token_counts(usage: &Value) -> Option<(u64, u64)> {
    crate::usage::token_counts(usage)
}

fn conversation_read(data: &Journal, name: &str, input: &Value) -> Result<Value> {
    let input = input
        .as_object()
        .context("conversation query must be an object")?;
    if name == "task_state" {
        ensure!(
            input
                .keys()
                .all(|k| ["offset", "limit"].contains(&k.as_str())),
            "unknown task query field"
        );
        let offset = input
            .get("offset")
            .map(|v| v.as_u64().context("invalid offset"))
            .transpose()?
            .unwrap_or(0) as usize;
        let limit = input
            .get("limit")
            .map(|v| v.as_u64().context("invalid limit"))
            .transpose()?
            .unwrap_or(10);
        ensure!((1..=64).contains(&limit), "task limit must be 1..64");
        let plan = data
            .events
            .iter()
            .rev()
            .filter(|e| e["method"] == "tool/result")
            .find_map(|event| {
                let id = event["params"]["id"].as_str()?;
                let execution = data.executions.get(id)?;
                (execution.name == "update_plan"
                    && execution.state == "done"
                    && !execution.is_error)
                    .then(|| execution.output.as_ref()?.get("plan")?.as_array())
                    .flatten()
            })
            .cloned()
            .unwrap_or_default();
        return Ok(
            json!({"plan":plan.iter().skip(offset).take(limit as usize).collect::<Vec<_>>(),"total":plan.len(),"offset":offset}),
        );
    }
    ensure!(
        input
            .keys()
            .all(|k| ["query", "limit"].contains(&k.as_str())),
        "unknown history query field"
    );
    let query = input
        .get("query")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty() && s.len() <= 1024)
        .context("query must be 1..1024 bytes")?
        .to_lowercase();
    let limit = input
        .get("limit")
        .map(|v| v.as_u64().context("invalid limit"))
        .transpose()?
        .unwrap_or(10);
    ensure!((1..=20).contains(&limit), "history limit must be 1..20");
    let mut results = Vec::new();
    for (index, message) in data.messages.iter().enumerate().rev() {
        let text = match &message["content"] {
            Value::String(s) => {
                if message["role"] == "tool" {
                    serde_json::from_str::<Value>(s)
                        .map(|mut v| {
                            omit_binary_history(&mut v);
                            v.to_string()
                        })
                        .unwrap_or_else(|_| s.clone())
                } else {
                    s.clone()
                }
            }
            Value::Array(a) => a
                .iter()
                .filter_map(|v| v["text"].as_str())
                .collect::<Vec<_>>()
                .join("\n"),
            _ => continue,
        };
        if text.to_lowercase().contains(&query) {
            results.push(json!({"messageIndex":index,"role":message["role"],"excerpt":crate::context::clip(&text,2000),"truncated":text.len()>2000}));
            if results.len() >= limit as usize {
                break;
            }
        }
    }
    Ok(json!({"matches":results,"fullHistoryPreserved":true}))
}

fn omit_binary_history(value: &mut Value) {
    match value {
        Value::Object(o) => {
            o.retain(|k, _| !matches!(k.as_str(), "data" | "base64" | "image_url" | "imageUrl"));
            for v in o.values_mut() {
                omit_binary_history(v);
            }
        }
        Value::Array(a) => {
            for v in a {
                omit_binary_history(v)
            }
        }
        Value::String(s) if s.starts_with("data:image/") => {
            *s = "[image retained as an artifact]".into()
        }
        _ => (),
    }
}

fn restored_usage(data: &Journal) -> (Value, Option<String>) {
    let item_order = data
        .items
        .iter()
        .enumerate()
        .filter(|(_, item)| item["kind"] == "user")
        .filter_map(|(index, item)| item["id"].as_str().map(|id| (id, index)))
        .collect::<HashMap<_, _>>();
    let event_order = data
        .events
        .iter()
        .enumerate()
        .filter(|(_, event)| event["method"] == "turn/completed")
        .filter_map(|(index, event)| event["params"]["messageId"].as_str().map(|id| (id, index)))
        .collect::<HashMap<_, _>>();
    let mut turns = data.turns.iter().collect::<Vec<_>>();
    turns.sort_by_key(|(id, turn)| {
        (
            event_order.get(id.as_str()).copied(),
            turn.started_at,
            item_order.get(id.as_str()).copied(),
        )
    });
    let mut total = 0u64;
    let mut api_usage = UsageTotals::default();
    let mut latest = None;
    let mut latest_model = data.model.as_str();
    let mut inherited_model = None;
    for (index, (id, turn)) in turns.iter().enumerate() {
        // A later unknown request/turn invalidates an earlier measurement,
        // just as it does in the live client before a process restart.
        latest = None;
        if let Some(model) = turn.request["model"].as_str().filter(|id| !id.is_empty()) {
            inherited_model = Some(model);
            latest_model = model;
        }
        let Some(usage) = turn.usage.as_ref() else {
            api_usage.merge(&UsageTotals::recorded(&Value::Null));
            continue;
        };
        api_usage.merge(&UsageTotals::recorded(usage));
        let recorded_model = usage["contextModel"].as_str().filter(|id| !id.is_empty());
        if let Some(model) = recorded_model {
            inherited_model = Some(model);
            latest_model = model;
        }
        // Validate the pair before addition: a missing/invalid counter must not
        // silently become zero and make an unknown usage look measured.
        let (Some(input), Some(output)) = (
            usage["inputTokens"].as_u64(),
            usage["outputTokens"].as_u64(),
        ) else {
            continue;
        };
        total = total.saturating_add(input.saturating_add(output));
        if turn.context_cutoff != data.context_cutoff {
            continue;
        }
        let Some(context) = usage["contextTokens"].as_u64() else {
            continue;
        };
        // Older runtimes emitted all-zero usage even without provider counters.
        if context == 0 && input == 0 && output == 0 && recorded_model.is_none() {
            continue;
        }
        let model = recorded_model.or(inherited_model).or_else(|| {
            // Legacy journals have no measured model. The persisted selection
            // is safe only when no later explicit model boundary intervenes.
            turns[index + 1..]
                .iter()
                .all(|(_, later)| {
                    later.request["model"].as_str().is_none()
                        && later
                            .usage
                            .as_ref()
                            .is_none_or(|usage| usage["contextModel"].as_str().is_none())
                })
                .then_some(data.model.as_str())
        });
        if let Some(model) = model {
            latest = Some((
                context,
                model,
                usage["contextWindow"].as_u64().filter(|n| *n > 0),
                id.as_str(),
            ));
        }
    }
    if data.turns.values().any(|turn| turn.status == "running") {
        latest = None;
        latest_model = data.model.as_str();
    }
    let mut result =
        json!({"contextModel":latest_model,"totalTokens":total,"apiUsage":api_usage.value()});
    let mut measured_turn = None;
    if let Some((context, model, window, id)) = latest {
        measured_turn = Some(id.to_owned());
        result["contextTokens"] = json!(context);
        result["contextModel"] = json!(model);
        if let Some(window) = window {
            result["contextWindow"] = json!(window);
        }
    }
    (result, measured_turn)
}

fn system_prompt(mode: &str) -> String {
    let task_policy = "For multi-step work, publish and maintain your task list with update_plan. Use task_state to recover actual task statuses after compaction and history_search to retrieve earlier instructions or results without rerunning tools. Team coordinators publish assignments with trex_team_plan before delegating instead. Never mark unverified work complete. Prefer edit_file for precise changes; native checkpoints can review or restore file-tool changes when the user requests it. Shell changes are not included in native checkpoints.";
    let integration_policy = "For GitHub, Blender and HyperFrames requests, prefer advertised github_*, blender_run and hyperframes_run tools. Check installed dependencies, honor the session permissions and inspect the actual results; do not silently install missing programs. Blender scripts run in a new background process, not an existing window. For computer or Windows control use advertised desktop_* tools: desktop_status, desktop_monitors and a fresh desktop_screenshot before each input. If input tools are absent, explain the required opt-in, permissions or vision capability instead of claiming access. For websites prefer advertised browser_* tools, starting with browser_navigate; they are separate from desktop control. Use only the tools actually advertised for this turn.";
    format!("You are Trex, a coding agent working in the user's workspace. Use available tools to inspect files and make precise changes. Follow project instructions. Never claim a tool succeeded without its result. {task_policy} {integration_policy} Your session mode is {mode}. Plan mode is strictly read-only: inspect and deliver a concrete plan; do not mutate files or execute shell commands. Ask mode requires user approval for each mutation or shell command. Full mode allows approved autonomous work. Browser tools, when explicitly enabled, enforce the session policy in the broker. Browser artifact metadata alone does not establish pixel inspection: only inspect pixels when an actual image observation is present. Missing artifacts are unavailable evidence; do not repeat a tool automatically to recreate them. Uncertain operations require user review and must never be automatically replayed. Use trex_read_messages to retrieve durable user or collaborator inbox messages during a long task. Finish with a clear final response describing results and relevant validation. Do not expose secrets.")
}

fn validate_images(value: Option<&Value>) -> Result<Vec<Value>> {
    let images = match value {
        None | Some(Value::Null) => return Ok(vec![]),
        Some(Value::Array(images)) => images,
        _ => bail!("images must be an array"),
    };
    ensure!(images.len() <= 16, "at most 16 images per message");
    let mut total = 0usize;
    for image in images {
        ensure!(
            matches!(
                required(image, "mediaType")?,
                "image/png" | "image/jpeg" | "image/webp" | "image/gif"
            ),
            "unsupported image mediaType"
        );
        let data = image["data"]
            .as_str()
            .context("image data must be base64 string")?;
        total = total
            .checked_add(data.len())
            .context("image size overflow")?;
        ensure!(total <= 24 * 1024 * 1024, "images exceed 24 MiB base64");
        STANDARD
            .decode(data)
            .context("image data must be valid base64 without data URL prefix")?;
    }
    Ok(images.clone())
}

fn previews(images: &[Value]) -> Vec<String> {
    images
        .iter()
        .map(|image| {
            format!(
                "data:{};base64,{}",
                image["mediaType"].as_str().unwrap_or("image/png"),
                image["data"].as_str().unwrap_or("")
            )
        })
        .collect()
}

fn user_message(text: &str, images: &[Value]) -> Value {
    if images.is_empty() {
        json!({"role":"user","content":text})
    } else {
        let mut content = vec![json!({"type":"text","text":text})];
        for image in images {
            content.push(json!({"type":"image_url","image_url":{"url":format!("data:{};base64,{}",image["mediaType"].as_str().unwrap_or(""),image["data"].as_str().unwrap_or(""))}}));
        }
        json!({"role":"user","content":content})
    }
}

fn record_result(data: &mut Journal, id: &str, output: &Value, is_error: bool) -> Result<()> {
    let execution = data
        .executions
        .get_mut(id)
        .context("tool execution missing from durable journal")?;
    ensure!(execution.state != "done", "tool result already recorded");
    execution.state = "done".into();
    execution.output = Some(output.clone());
    execution.is_error = is_error;
    data.messages
        .push(json!({"role":"tool","tool_call_id":execution.provider_id.as_deref().unwrap_or(id),"content":serde_json::to_string(output)?}));
    Ok(())
}

fn flush_inbox(data: &mut Journal) -> Vec<String> {
    data.messages.append(&mut data.pending_inbox);
    let mut receipts = vec![];
    for (id, receipt) in &mut data.receipts {
        if receipt["committed"] != true {
            receipt["committed"] = json!(true);
            receipts.push(id.clone());
        }
    }
    receipts
}

fn settle_unfinished(data: &mut Journal, message_id: &str, description: &str) {
    let unfinished = data
        .executions
        .iter()
        .filter(|(_, execution)| execution.message_id == message_id && execution.state != "done")
        .map(|(id, _)| id.clone())
        .collect::<Vec<_>>();
    for id in unfinished {
        let uncertain = data.executions.get(&id).is_some_and(|execution| {
            execution.state == "executing" && tools::is_mutating(&execution.name)
        });
        if uncertain {
            data.recovery_required = true;
        }
        let output = json!({"error":description,"executionUncertain":uncertain,"neverAutomaticallyRetry":true});
        let _ = record_result(data, &id, &output, true);
        for item in &mut data.items {
            if item["kind"] == "tool" && item["id"] == id {
                item["status"] = json!("error");
                item["output"] = json!(output.to_string());
            }
        }
    }
    // A crash can happen immediately after storing an assistant tool batch, before
    // the per-tool journal is created. Close every unmatched call without running it.
    let mut pending = BTreeMap::<String, String>::new();
    for message in &data.messages {
        if message["role"] == "assistant" {
            if let Some(calls) = message["tool_calls"].as_array() {
                for call in calls {
                    if let Some(id) = call["id"].as_str() {
                        pending.insert(
                            id.into(),
                            call["function"]["name"]
                                .as_str()
                                .unwrap_or("unknown")
                                .into(),
                        );
                    }
                }
            }
        }
        if message["role"] == "tool" {
            if let Some(id) = message["tool_call_id"].as_str() {
                pending.remove(id);
            }
        }
    }
    for (id, _) in pending {
        data.messages.push(json!({"role":"tool","tool_call_id":id,"content":json!({"error":"Interrupted before this tool was executed; it will not be automatically retried."}).to_string()}));
    }
    for item in &mut data.items {
        if item["kind"] == "permission" && item["state"] == "pending" {
            item["state"] = json!("denied");
        }
    }
}

fn recover(data: &mut Journal) {
    // Native completion and UI publication may straddle a process crash.
    // Reconcile every durable result, retaining the original stable tool id.
    for (id, execution) in &data.executions {
        if execution.state != "done" {
            continue;
        }
        if !data
            .items
            .iter()
            .any(|item| item["kind"] == "tool" && item["id"] == *id)
        {
            data.items.push(json!({"kind":"tool","id":id,"name":execution.name,"input":execution.input,"status":"running","output":null,"patch":null}));
        }
        project(
            &mut data.items,
            "tool/result",
            &json!({"id":id,"output":execution.output,"isError":execution.is_error}),
        );
    }
    let running = data
        .turns
        .iter()
        .filter(|(_, turn)| turn.status == "running")
        .map(|(id, _)| id.clone())
        .collect::<Vec<_>>();
    for id in running {
        settle_unfinished(data,&id,"Previous process stopped during tool execution. Inspect workspace state; do not replay this tool.");
        let error = if data.recovery_required {
            "Process stopped during a possibly mutating tool. Inspect the workspace and acknowledge recovery."
        } else {
            "Previous process stopped before turn completion."
        };
        if let Some(turn) = data.turns.get_mut(&id) {
            turn.status = "interrupted".into();
            turn.error = Some(error.into());
        }
        for item in &mut data.items {
            if item["messageId"] == id && matches!(item["kind"].as_str(), Some("text" | "thinking"))
            {
                item["final"] = json!(true);
            }
        }
        data.items.push(
            json!({"kind":"notice","id":format!("{id}:recovery"),"tone":"warn","text":error}),
        );
        data.events.push(json!({"method":"turn/completed","params":{"sessionId":data.id,"messageId":id,"status":"interrupted","error":error}}));
    }
    flush_inbox(data);
}

fn project(items: &mut Vec<Value>, method: &str, params: &Value) {
    match method {
        "message/delta"=>{
            if let Some(item)=items.iter_mut().find(|item|item["id"]==params["id"]){if let Some(Value::String(text))=item.get_mut("text"){text.push_str(params["text"].as_str().unwrap_or(""));}}
            else{items.push(json!({"kind":params["kind"],"id":params["id"],"messageId":params["messageId"],"text":params["text"],"final":false}));}
        }
        "tool/start"=>items.push(json!({"kind":"tool","id":params["id"],"name":params["toolName"],"input":params["input"],"status":"running","output":null,"patch":null})),
        "tool/result"=>{if let Some(item)=items.iter_mut().find(|item|item["kind"]=="tool"&&item["id"]==params["id"]){item["status"]=json!(if params["isError"]==true{"error"}else{"done"});item["output"]=json!(match &params["output"]{Value::String(s)=>s.clone(),value=>value.to_string()});item["artifacts"]=params.get("artifacts").cloned().or_else(||params["output"].get("artifacts").cloned()).unwrap_or_else(||json!([]));}}
        "permission/request"=>items.push(json!({"kind":"permission","id":params["id"],"toolName":params["toolName"],"toolUseId":params["toolUseId"],"input":params["input"],"description":params["description"],"suggestions":[],"state":"pending","request":{"id":params["id"],"method":"permission/respond"}})),
        _=>(),
    }
}

async fn frame(reader: &mut (impl AsyncBufRead + Unpin)) -> Result<Option<Vec<u8>>> {
    let mut result = Vec::new();
    let mut oversized = false;
    loop {
        let buffer = reader.fill_buf().await?;
        if buffer.is_empty() {
            return if result.is_empty() && !oversized {
                Ok(None)
            } else if oversized {
                bail!("JSON-RPC frame exceeds 32 MiB")
            } else {
                Ok(Some(result))
            };
        }
        let count = buffer
            .iter()
            .position(|byte| *byte == b'\n')
            .map(|n| n + 1)
            .unwrap_or(buffer.len());
        let ended = buffer[count - 1] == b'\n';
        if result.len().saturating_add(count) > MAX_FRAME {
            oversized = true;
            result.clear();
        }
        if !oversized {
            result.extend_from_slice(&buffer[..count]);
        }
        reader.consume(count);
        if ended {
            if oversized {
                bail!("JSON-RPC frame exceeds 32 MiB");
            }
            return Ok(Some(result));
        }
    }
}

pub async fn run(profile: Profile) -> Result<()> {
    let (tx, mut rx) = mpsc::unbounded_channel::<Value>();
    let server = Server::new(profile, tx);
    let writer = tokio::spawn(async move {
        let mut stdout = tokio::io::stdout();
        while let Some(value) = rx.recv().await {
            let mut bytes = serde_json::to_vec(&value)?;
            bytes.push(b'\n');
            stdout.write_all(&bytes).await?;
            stdout.flush().await?;
        }
        Ok::<_, anyhow::Error>(())
    });
    let mut stdin = BufReader::new(tokio::io::stdin());
    let mut requests = tokio::task::JoinSet::new();
    #[cfg(unix)]
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    loop {
        #[cfg(unix)]
        let input = tokio::select! { input=frame(&mut stdin)=>input, _=tokio::signal::ctrl_c()=>break, _=terminate.recv()=>break };
        #[cfg(not(unix))]
        let input =
            tokio::select! {input=frame(&mut stdin)=>input,_=tokio::signal::ctrl_c()=>break};
        match input {
            Ok(None)=>break,
            Ok(Some(bytes))=>{
                if bytes.iter().all(u8::is_ascii_whitespace){continue;}
                match serde_json::from_slice::<Value>(&bytes){
                    Ok(request)=>{
                        if matches!(request["method"].as_str(), Some("models/list" | "process/list" | "process/read" | "process/stop")) {
                            let server=server.clone();requests.spawn(async move{server.handle(request).await;});
                        } else {
                            // Ordered control dispatch prevents Stop from overtaking its
                            // preceding turn/start. Provider/tool work runs separately.
                            server.handle(request).await;
                        }
                    },
                    Err(_)=>server.send(json!({"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"invalid JSON"}}))
                }
            }
            Err(error)=>server.send(json!({"jsonrpc":"2.0","id":null,"error":{"code":-32600,"message":error.to_string()}})),
        }
        while requests.try_join_next().is_some() {}
    }
    // Stop dispatchers before cancellation so EOF cannot race a not-yet-started
    // turn into beginning after cancel_all has already run.
    requests.abort_all();
    while requests.join_next().await.is_some() {}
    server.cancel_all().await;
    server.wait_idle().await;
    drop(requests);
    drop(server);
    match tokio::time::timeout(Duration::from_secs(2), writer).await {
        Ok(result) => result??,
        Err(_) => bail!("stdout writer did not finish"),
    };
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn journal() -> Journal {
        serde_json::from_value(json!({
            "version":1,"id":"a1e9f41e-e315-4f50-8378-52a3195c2802","profileName":"TREX1",
            "provider":"custom","baseUrl":"http://127.0.0.1:1/v1","cwd":".","mode":"full",
            "model":"model-a","effort":"high","updatedAt":0,"messages":[],"items":[],"events":[],
            "turns":{},"executions":{},"receipts":{},"pendingInbox":[],"recoveryRequired":false
        }))
        .unwrap()
    }

    fn profile() -> Profile {
        Profile {
            name: "TREX1".into(),
            provider: "custom".into(),
            base_url: "http://127.0.0.1:1/v1".into(),
            model: "model-a".into(),
            effort: None,
        }
    }

    #[test]
    fn model_switch_clears_incompatible_effort_but_null_restore_retains_it() {
        let mut model = "MiniMax-M3.1-Flash".to_string();
        let mut effort = Some("max".to_string());
        select_model(
            &mut model,
            &mut effort,
            &json!({"model":null,"effort":null}),
        )
        .unwrap();
        assert_eq!(effort.as_deref(), Some("max"));
        select_model(
            &mut model,
            &mut effort,
            &json!({"model":"MiniMax-M3","effort":null}),
        )
        .unwrap();
        assert_eq!(model, "MiniMax-M3");
        assert_eq!(effort, None);
        select_model(
            &mut model,
            &mut effort,
            &json!({"model":"MiniMax-M3.1-Flash","effort":"low"}),
        )
        .unwrap();
        assert_eq!(effort.as_deref(), Some("low"));
        select_model(&mut model, &mut effort, &json!({})).unwrap();
        assert_eq!(effort.as_deref(), Some("low"));
        assert!(select_model(
            &mut model,
            &mut effort,
            &json!({"model":"rejected-model","effort":true})
        )
        .is_err());
        assert_eq!(model, "MiniMax-M3.1-Flash");
        assert_eq!(effort.as_deref(), Some("low"));
    }

    #[tokio::test]
    async fn failed_turn_commit_does_not_create_phantom_running_turn() {
        let directory = tempfile::tempdir().unwrap();
        let data = journal();
        let id = data.id.clone();
        let session = Arc::new(Session {
            path: directory.path().join("missing").join("journal.json"),
            _lock: File::create(directory.path().join("lock")).unwrap(),
            _storage_lock: None,
            data: Mutex::new(data),
            active: Mutex::new(None),
            tools: tools::ToolRegistry::new(None),
        });
        let (tx, _rx) = mpsc::unbounded_channel();
        let server = Server::new(profile(), tx);
        server
            .sessions
            .lock()
            .await
            .insert(id.clone(), session.clone());
        let request = json!({"sessionId":id,"messageId":"user-1","text":"write a file"});
        assert!(server.start_turn(&request).await.is_err());
        assert!(server.start_turn(&request).await.is_err());
        let data = session.data.lock().await;
        assert!(data.turns.is_empty());
        assert!(data.messages.is_empty());
        assert!(data.items.is_empty());
        assert!(session.active.lock().await.is_none());
    }

    #[test]
    fn crash_recovery_pauses_uncertain_mutation_and_projects_known_results() {
        let mut data = journal();
        data.turns.insert(
            "user-1".into(),
            Turn {
                request: json!({}),
                status: "running".into(),
                error: None,
                error_details: None,
                usage: None,
                context_cutoff: 0,
                started_at: 0,
            },
        );
        data.messages.push(json!({"role":"assistant","content":null,"tool_calls":[
            {"id":"done","type":"function","function":{"name":"read_file","arguments":"{}"}},
            {"id":"uncertain","type":"function","function":{"name":"write_file","arguments":"{}"}}
        ]}));
        data.messages
            .push(json!({"role":"tool","tool_call_id":"done","content":"known result"}));
        data.executions.insert(
            "done".into(),
            Execution {
                name: "read_file".into(),
                input: json!({}),
                state: "done".into(),
                message_id: "user-1".into(),
                provider_id: None,
                output: Some(json!({"content":"known result"})),
                is_error: false,
                operation_id: None,
            },
        );
        data.executions.insert(
            "uncertain".into(),
            Execution {
                name: "write_file".into(),
                input: json!({}),
                state: "executing".into(),
                message_id: "user-1".into(),
                provider_id: None,
                output: None,
                is_error: false,
                operation_id: None,
            },
        );
        data.items.push(json!({"kind":"tool","id":"done","name":"read_file","input":{},"status":"running","output":null,"patch":null}));
        recover(&mut data);
        assert!(data.recovery_required);
        assert_eq!(data.turns["user-1"].status, "interrupted");
        assert_eq!(
            data.items.iter().find(|item| item["id"] == "done").unwrap()["status"],
            "done"
        );
        assert!(
            data.items.iter().find(|item| item["id"] == "done").unwrap()["output"]
                .as_str()
                .unwrap()
                .contains("known result")
        );
        assert_eq!(data.executions["uncertain"].state, "done");
        let previous = data.messages.clone();
        recover(&mut data);
        assert_eq!(previous, data.messages);
    }

    #[tokio::test]
    async fn full_request_cache_never_blocks_interrupt() {
        let directory = tempfile::tempdir().unwrap();
        let data = journal();
        let id = data.id.clone();
        let cancel = CancellationToken::new();
        let session = Arc::new(Session {
            path: directory.path().join("journal.json"),
            _lock: File::create(directory.path().join("lock")).unwrap(),
            _storage_lock: None,
            data: Mutex::new(data),
            active: Mutex::new(Some(Active {
                message_id: "user-1".into(),
                cancel: cancel.clone(),
            })),
            tools: tools::ToolRegistry::new(None),
        });
        let (tx, mut rx) = mpsc::unbounded_channel();
        let server = Server::new(profile(), tx);
        server.sessions.lock().await.insert(id.clone(), session);
        for n in 0..16384 {
            server.requests.lock().await.insert(
                n.to_string(),
                CachedRequest {
                    request: json!({}),
                    response: Some(json!({})),
                    waiters: vec![],
                },
            );
        }
        server.handle(json!({"jsonrpc":"2.0","id":"stop","method":"turn/interrupt","params":{"sessionId":id,"messageId":"user-1"}})).await;
        assert!(cancel.is_cancelled());
        assert_eq!(rx.recv().await.unwrap()["result"]["interrupted"], true);
    }

    #[tokio::test]
    async fn frames_are_incremental_and_oversized_frames_do_not_consume_next_request() {
        let input = b"{\"id\":1}\n{\"id\":2}\n";
        let mut reader = BufReader::with_capacity(3, &input[..]);
        assert_eq!(frame(&mut reader).await.unwrap().unwrap(), b"{\"id\":1}\n");
        assert_eq!(frame(&mut reader).await.unwrap().unwrap(), b"{\"id\":2}\n");
        assert!(frame(&mut reader).await.unwrap().is_none());
        let mut bytes = vec![b'x'; MAX_FRAME + 1];
        bytes.extend_from_slice(b"\n{}\n");
        let mut reader = BufReader::with_capacity(4096, bytes.as_slice());
        assert!(frame(&mut reader).await.is_err());
        assert_eq!(frame(&mut reader).await.unwrap().unwrap(), b"{}\n");
    }
}
