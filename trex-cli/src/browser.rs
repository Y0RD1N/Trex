//! Narrow, opt-in Trex Browser subprocess adapter. This is not a general MCP client.
use crate::tools::{ToolFuture, ToolProvider};
use anyhow::{bail, ensure, Context, Result};
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

const OUTPUT_LIMIT: u64 = 8 * 1024 * 1024;
const INPUT_LIMIT: usize = 1024 * 1024;
const PROBE_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrowserConfig {
    pub enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_id: Option<String>,
}
impl BrowserConfig {
    pub fn parse(value: Option<&Value>) -> Result<Self> {
        let config: Self = match value {
            None | Some(Value::Null) => Self::default(),
            Some(value) => {
                serde_json::from_value(value.clone()).context("invalid browser configuration")?
            }
        };
        for value in [&config.profile, &config.client_id].into_iter().flatten() {
            ensure!(
                !value.is_empty() && value.len() <= 128 && !value.chars().any(char::is_control),
                "invalid browser profile or clientId"
            );
        }
        Ok(config)
    }
}

/// A call may have reached the broker. The runner must settle its durable
/// execution as requiring review instead of recording an ordinary retriable error.
#[derive(Debug)]
pub struct ExecutionUncertain;
impl std::fmt::Display for ExecutionUncertain {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Browser operation interrupted or its result is uncertain; inspect browser state before continuing. It will never be automatically replayed.")
    }
}
impl std::error::Error for ExecutionUncertain {}

pub fn broker_mode(mode: &str) -> &'static str {
    match mode {
        "plan" => "observe",
        "full" => "full",
        _ => "qa",
    }
}

pub struct BrowserToolProvider {
    binary: PathBuf,
    config: BrowserConfig,
    client_id: String,
    mode: String,
    definitions: Vec<Value>,
}
impl BrowserToolProvider {
    pub async fn discover(
        config: &BrowserConfig,
        client_id: &str,
        mode: &str,
    ) -> Result<Option<Self>> {
        if !config.enabled {
            return Ok(None);
        }
        let Some(binary) = discover_binary() else {
            return Ok(None);
        };
        let version = subprocess(
            &binary,
            &["--version"],
            None,
            PROBE_TIMEOUT,
            CancellationToken::new(),
            4096,
        )
        .await?;
        ensure!(
            std::str::from_utf8(&version).is_ok_and(|s| s.starts_with("trex-browser ")),
            "incompatible browser executable"
        );
        let doctor = subprocess(
            &binary,
            &["doctor", "--json"],
            None,
            PROBE_TIMEOUT,
            CancellationToken::new(),
            OUTPUT_LIMIT,
        )
        .await?;
        let doctor: Value =
            serde_json::from_slice(&doctor).context("invalid browser doctor response")?;
        ensure!(
            doctor["protocolVersion"] == "2025-11-25",
            "unsupported browser protocol"
        );
        ensure!(
            doctor["capabilities"].is_object(),
            "invalid browser capabilities"
        );
        let mode = broker_mode(mode).to_owned();
        let bytes = subprocess(
            &binary,
            &["tools", "--json", "--mode", &mode],
            None,
            PROBE_TIMEOUT,
            CancellationToken::new(),
            OUTPUT_LIMIT,
        )
        .await?;
        let tools: Value =
            serde_json::from_slice(&bytes).context("invalid browser tools response")?;
        let tools = tools["tools"]
            .as_array()
            .context("browser tools must be an array")?;
        ensure!(tools.len() <= 64, "too many browser tools");
        let mut definitions = vec![];
        let mut names = std::collections::HashSet::new();
        for tool in tools {
            let name = tool["name"].as_str().context("browser tool name missing")?;
            if !allowed_tool(name, &mode) {
                continue;
            }
            ensure!(names.insert(name.to_owned()), "duplicate browser tool name");
            ensure!(
                tool["inputSchema"]["type"] == "object",
                "invalid browser tool schema"
            );
            let description = tool["description"].as_str().unwrap_or("Trex Browser tool");
            ensure!(description.len() <= 8192, "browser description too large");
            definitions.push(json!({"type":"function","function":{"name":name,"description":description,"parameters":tool["inputSchema"]}}));
        }
        Ok(Some(Self {
            binary,
            config: config.clone(),
            client_id: config
                .client_id
                .clone()
                .unwrap_or_else(|| client_id.to_owned()),
            mode,
            definitions,
        }))
    }

    async fn cancel_operation(&self, cwd: &Path, operation_id: &str) {
        let input = self.request(
            cwd,
            "browser_cancel",
            &json!({"operationId":operation_id}),
            &format!("cancel:{operation_id}"),
        );
        let _ = subprocess(
            &self.binary,
            &["call", "--stdin-json"],
            Some(input),
            Duration::from_secs(3),
            CancellationToken::new(),
            OUTPUT_LIMIT,
        )
        .await;
    }
    fn request(&self, cwd: &Path, name: &str, input: &Value, operation_id: &str) -> Value {
        let mut request = json!({"name":name,"arguments":input,"cwd":cwd,"mode":self.mode,"clientId":self.client_id,"operationId":operation_id,"timeoutMs":90000});
        if let Some(profile) = &self.config.profile {
            request["profile"] = json!(profile);
        }
        request
    }
}
impl ToolProvider for BrowserToolProvider {
    fn definitions(&self, mode: &str) -> Vec<Value> {
        if broker_mode(mode) != self.mode {
            return vec![];
        }
        self.definitions.clone()
    }
    fn is_mutating(&self, name: &str, input: &Value) -> bool {
        // Read-only evidence tools never execute caller JavaScript or requests.
        // Interaction bodies (click/fill/keys/drag/etc.) always require ask approval.
        match name {
            "browser_batch" => input["steps"].as_array().is_none_or(|steps| {
                steps.is_empty()
                    || steps.iter().any(|step| {
                        step["tool"] == "browser_batch"
                            || self.is_mutating(
                                step["tool"].as_str().unwrap_or(""),
                                &step["arguments"],
                            )
                    })
            }),
            "browser_tabs" => !matches!(
                input["action"].as_str(),
                None | Some("list") | Some("select")
            ),
            "browser_artifact" => input["open"] == true,
            "browser_console_messages" => input["clear"] == true,
            "browser_mouse" => !matches!(input["action"].as_str(), Some("move" | "wheel")),
            "browser_navigate" | "browser_navigate_back" | "browser_reload" => true,
            _ => !observe_tool(name),
        }
    }
    fn execute<'a>(
        &'a self,
        cwd: &'a Path,
        mode: &'a str,
        name: &'a str,
        input: &'a Value,
        operation_id: &'a str,
        cancel: CancellationToken,
    ) -> ToolFuture<'a> {
        Box::pin(async move {
            ensure!(
                broker_mode(mode) == self.mode && allowed_tool(name, &self.mode),
                "browser policy mismatch"
            );
            ensure!(
                self.definitions
                    .iter()
                    .any(|t| t["function"]["name"] == name),
                "unavailable browser tool"
            );
            ensure!(input.is_object(), "browser arguments must be an object");
            if name == "browser_batch" {
                let steps = input["steps"].as_array().context("batch steps required")?;
                ensure!((1..=16).contains(&steps.len()), "batch step limit");
                for step in steps {
                    let tool = step["tool"].as_str().context("batch tool required")?;
                    ensure!(
                        tool != "browser_batch" && allowed_tool(tool, &self.mode),
                        "batch step denied by policy"
                    );
                    ensure!(step["arguments"].is_object(), "batch arguments required");
                    if self.mode == "observe" {
                        ensure!(
                            tool != "browser_tabs"
                                || matches!(
                                    step["arguments"]["action"].as_str(),
                                    None | Some("list" | "select")
                                ),
                            "plan batch cannot mutate tabs"
                        );
                        ensure!(
                            tool != "browser_console_messages"
                                || step["arguments"]["clear"] != true,
                            "plan batch cannot clear logs"
                        );
                    }
                }
            }
            if self.mode == "observe" {
                ensure!(
                    name != "browser_tabs"
                        || matches!(input["action"].as_str(), None | Some("list" | "select")),
                    "plan mode permits only listing or selecting existing browser tabs"
                );
                ensure!(
                    name != "browser_artifact" || input["open"] != true,
                    "plan mode cannot open browser artifacts"
                );
                ensure!(
                    name != "browser_console_messages" || input["clear"] != true,
                    "plan mode cannot clear browser logs"
                );
            }
            ensure!(
                !cancel.is_cancelled(),
                "browser call cancelled before dispatch"
            );
            let request = self.request(cwd, name, input, operation_id);
            let result = subprocess(
                &self.binary,
                &["call", "--stdin-json"],
                Some(request),
                Duration::from_secs(95),
                cancel.clone(),
                OUTPUT_LIMIT,
            )
            .await;
            match result.and_then(|bytes| decode_result(&bytes)) {
                Ok(result) => Ok(result),
                Err(_) => {
                    self.cancel_operation(cwd, operation_id).await;
                    Err(ExecutionUncertain.into())
                }
            }
        })
    }
}

fn decode_result(bytes: &[u8]) -> Result<Value> {
    let result: Value = serde_json::from_slice(bytes).map_err(|_| ExecutionUncertain)?;
    ensure!(
        result.get("isError").is_none_or(Value::is_boolean)
            && result.get("structuredContent").is_none_or(Value::is_object),
        ExecutionUncertain
    );
    let content = result["content"].as_array().ok_or(ExecutionUncertain)?;
    ensure!(
        content.iter().all(|item| match item["type"].as_str() {
            Some("text") => item["text"].is_string(),
            Some("image") => item["data"].is_string() && item["mimeType"].is_string(),
            _ => false,
        }),
        ExecutionUncertain
    );
    let receipt = &result["structuredContent"]["receipt"];
    ensure!(
        result["structuredContent"]["executionUncertain"] != true
            && receipt["manualReview"] != true
            && !matches!(receipt["status"].as_str(), Some("uncertain" | "cancelled")),
        ExecutionUncertain
    );
    Ok(result)
}

// Frozen protocol allowlist. Discovery may narrow it, never add a capability.
fn observe_tool(name: &str) -> bool {
    matches!(
        name,
        "browser_batch"
            | "browser_navigate"
            | "browser_navigate_back"
            | "browser_reload"
            | "browser_status"
            | "browser_tabs"
            | "browser_frames"
            | "browser_snapshot"
            | "browser_take_screenshot"
            | "browser_console_messages"
            | "browser_network_requests"
            | "browser_network_body"
            | "browser_wait_for"
            | "browser_artifact"
            | "browser_cancel"
    )
}
fn allowed_tool(name: &str, mode: &str) -> bool {
    observe_tool(name)
        || (mode != "observe"
            && matches!(
                name,
                "browser_handle_dialog"
                    | "browser_click"
                    | "browser_hover"
                    | "browser_drag"
                    | "browser_mouse"
                    | "browser_press_key"
                    | "browser_type"
                    | "browser_fill_form"
                    | "browser_select_option"
                    | "browser_evaluate"
                    | "browser_resize"
                    | "browser_emulate"
                    | "browser_route"
                    | "browser_file_upload"
                    | "browser_start_video"
                    | "browser_stop_video"
                    | "browser_start_trace"
                    | "browser_stop_trace"
                    | "browser_perf_start"
                    | "browser_perf_stop"
                    | "browser_cpu_profile_start"
                    | "browser_cpu_profile_stop"
                    | "browser_heap_snapshot"
                    | "browser_pause"
                    | "browser_resume"
                    | "browser_takeover"
                    | "browser_close"
            ))
}

async fn subprocess(
    binary: &Path,
    args: &[&str],
    input: Option<Value>,
    timeout: Duration,
    cancel: CancellationToken,
    limit: u64,
) -> Result<Vec<u8>> {
    validate_binary(binary)?;
    let input = input.map(|input| serde_json::to_vec(&input)).transpose()?;
    ensure!(
        input
            .as_ref()
            .is_none_or(|bytes| bytes.len() <= INPUT_LIMIT),
        "browser input too large"
    );
    let mut command = Command::new(binary);
    command
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x0800_0000);
    let mut child = command.spawn().context("cannot start browser adapter")?;
    let mut stdin = child.stdin.take().context("browser stdin unavailable")?;
    let stdout = child.stdout.take().context("browser stdout unavailable")?;
    let operation = async {
        if let Some(bytes) = input {
            stdin.write_all(&bytes).await?;
        }
        stdin.shutdown().await?;
        drop(stdin);
        let mut bytes = vec![];
        stdout.take(limit + 1).read_to_end(&mut bytes).await?;
        ensure!(bytes.len() as u64 <= limit, "browser response too large");
        ensure!(child.wait().await?.success(), "browser adapter failed");
        Ok(bytes)
    };
    tokio::select! {
        result = tokio::time::timeout(timeout, operation) => result.context("browser deadline exceeded")?,
        _ = cancel.cancelled() => bail!("browser call cancelled"),
    }
}

fn validate_binary(path: &Path) -> Result<PathBuf> {
    ensure!(path.is_absolute(), "browser executable must be absolute");
    validate_local_path(path)?;
    for ancestor in path.ancestors() {
        let metadata = fs::symlink_metadata(ancestor)?;
        ensure!(
            !metadata.file_type().is_symlink(),
            "browser path contains a symlink"
        );
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            ensure!(
                metadata.file_attributes() & 0x400 == 0,
                "browser path contains a reparse point"
            );
        }
        if ancestor == path {
            ensure!(
                metadata.is_file(),
                "browser executable must be a regular file"
            );
        } else {
            ensure!(metadata.is_dir(), "browser ancestor must be a directory");
        }
    }
    let canonical = fs::canonicalize(path)?;
    validate_local_path(&canonical)?;
    Ok(canonical)
}

fn validate_local_path(path: &Path) -> Result<()> {
    use std::path::Component;
    ensure!(
        !path
            .components()
            .any(|part| matches!(part, Component::ParentDir)),
        "browser path cannot contain parent traversal"
    );
    #[cfg(windows)]
    {
        use std::path::Prefix;
        ensure!(
            matches!(path.components().next(), Some(Component::Prefix(prefix))
            if matches!(prefix.kind(), Prefix::Disk(_) | Prefix::VerbatimDisk(_))),
            "browser path must use a local drive; UNC/device paths are forbidden"
        );
        for part in path.components() {
            if let Component::Normal(name) = part {
                let name = name.to_str().context("invalid browser path component")?;
                ensure!(
                    !name.contains(':')
                        && !name.chars().any(char::is_control)
                        && !name.ends_with(['.', ' ']),
                    "invalid browser path component"
                );
            }
        }
    }
    Ok(())
}
fn discover_binary() -> Option<PathBuf> {
    let name = if cfg!(windows) {
        "trex-browser.exe"
    } else {
        "trex-browser"
    };
    let sibling = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|p| p.join(name)));
    sibling
        .into_iter()
        .chain(registered_directory().map(|p| p.join(name)))
        .find_map(|path| validate_binary(&path).ok())
}
#[cfg(target_os = "linux")]
fn registered_directory() -> Option<PathBuf> {
    let base = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .or_else(|| {
            std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".local/share"))
        })?;
    base.is_absolute().then(|| base.join("trex-browser"))
}
#[cfg(not(any(windows, target_os = "linux")))]
fn registered_directory() -> Option<PathBuf> {
    None
}
#[cfg(windows)]
fn registered_directory() -> Option<PathBuf> {
    use std::os::windows::ffi::OsStringExt;
    #[link(name = "advapi32")]
    extern "system" {
        fn RegGetValueW(
            key: isize,
            subkey: *const u16,
            value: *const u16,
            flags: u32,
            kind: *mut u32,
            data: *mut std::ffi::c_void,
            size: *mut u32,
        ) -> i32;
    }
    let subkey: Vec<u16> = "Software\\com.trex.browser\\Install\0"
        .encode_utf16()
        .collect();
    let value: Vec<u16> = "InstallDir\0".encode_utf16().collect();
    let mut buffer = [0u16; 32768];
    let mut size = (buffer.len() * 2) as u32;
    let mut kind = 0;
    let status = unsafe {
        RegGetValueW(
            0x8000_0001u32 as i32 as isize,
            subkey.as_ptr(),
            value.as_ptr(),
            0x2 | 0x0001_0000,
            &mut kind,
            buffer.as_mut_ptr().cast(),
            &mut size,
        )
    };
    if status != 0 || kind != 1 || size < 4 || size as usize > buffer.len() * 2 || size % 2 != 0 {
        return None;
    }
    let units = &buffer[..size as usize / 2];
    if units.last() != Some(&0) || units[..units.len() - 1].contains(&0) {
        return None;
    }
    let path = PathBuf::from(std::ffi::OsString::from_wide(&units[..units.len() - 1]));
    path.is_absolute().then_some(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn policy_and_configuration_fail_closed() {
        assert!(!BrowserConfig::parse(None).unwrap().enabled);
        assert!(BrowserConfig::parse(Some(&json!({"enabled":true,"binary":"bad"}))).is_err());
        for name in ["browser_cdp", "browser_fetch", "shell", "arbitrary_command"] {
            assert!(!allowed_tool(name, "observe"));
            assert!(!allowed_tool(name, "full"));
        }
        assert!(!allowed_tool("browser_click", "observe"));
        assert!(!allowed_tool("browser_evaluate", "observe"));
        assert!(allowed_tool("browser_evaluate", "qa"));
        assert_eq!(broker_mode("plan"), "observe");
        assert_eq!(broker_mode("ask"), "qa");
    }

    #[test]
    fn permission_classification_uses_the_operation_body() {
        let provider = BrowserToolProvider {
            binary: PathBuf::new(),
            config: BrowserConfig::default(),
            client_id: "client".into(),
            mode: "qa".into(),
            definitions: vec![],
        };
        assert!(!provider.is_mutating("browser_tabs", &json!({"action":"list"})));
        assert!(provider.is_mutating("browser_tabs", &json!({"action":"new"})));
        assert!(provider.is_mutating("browser_tabs", &json!({"action":"close"})));
        assert!(!provider.is_mutating("browser_artifact", &json!({"artifactId":"id"})));
        assert!(provider.is_mutating("browser_artifact", &json!({"artifactId":"id","open":true})));
        assert!(!provider.is_mutating("browser_mouse", &json!({"action":"move"})));
        assert!(provider.is_mutating("browser_mouse", &json!({"action":"click"})));
        assert!(provider.is_mutating("browser_evaluate", &json!({"function":"() => 1"})));
        assert!(provider.is_mutating("unknown", &json!({})));
        assert!(!provider.is_mutating(
            "browser_batch",
            &json!({"steps":[{"tool":"browser_snapshot","arguments":{}}]})
        ));
        assert!(provider.is_mutating("browser_batch", &json!({"steps":[{"tool":"browser_snapshot","arguments":{}},{"tool":"browser_click","arguments":{"selector":"button"}}]})));
        assert!(provider.is_mutating(
            "browser_batch",
            &json!({"steps":[{"tool":"browser_batch","arguments":{}}]})
        ));
    }

    #[test]
    fn executable_discovery_rejects_directory_and_relative_collisions() {
        let directory = tempfile::tempdir().unwrap();
        assert!(validate_binary(directory.path()).is_err());
        assert!(validate_binary(Path::new("trex-browser.exe")).is_err());
        assert!(validate_binary(&directory.path().join("missing.exe")).is_err());
        let binary = directory.path().join("trex-browser.exe");
        fs::write(&binary, b"fixture").unwrap();
        assert!(validate_binary(&binary).is_ok());
    }

    #[cfg(windows)]
    #[test]
    fn browser_discovery_rejects_unc_devices_traversal_and_streams_before_io() {
        for path in [
            r"\\server\share\trex-browser.exe",
            r"\\?\UNC\server\share\trex-browser.exe",
            r"\\.\C:\trex-browser.exe",
            r"C:\a\..\trex-browser.exe",
            r"C:\a:stream\trex-browser.exe",
        ] {
            assert!(validate_local_path(Path::new(path)).is_err());
        }
        assert!(validate_local_path(Path::new(r"C:\Apps\Trex Browser\trex-browser.exe")).is_ok());
        assert!(
            validate_local_path(Path::new(r"\\?\C:\Apps\Trex Browser\trex-browser.exe")).is_ok()
        );
    }

    #[test]
    fn broker_receipts_and_invalid_content_never_become_retriable_results() {
        for result in [
            json!({"content":[{"type":"image","data":"secret"}]}),
            json!({"content":[{"data":"secret"}]}),
            json!({"content":[],"isError":"false"}),
            json!({"content":[],"structuredContent":{"receipt":{"status":"uncertain"}}}),
            json!({"content":[],"structuredContent":{"receipt":{"status":"cancelled"}}}),
            json!({"content":[],"structuredContent":{"receipt":{"manualReview":true}}}),
        ] {
            assert!(decode_result(&serde_json::to_vec(&result).unwrap()).is_err());
        }
        assert!(decode_result(
            br#"{"content":[{"type":"text","text":"ordinary error"}],"isError":true}"#
        )
        .is_ok());
    }
}
