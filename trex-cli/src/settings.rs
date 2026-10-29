//! User-owned configuration. Project files never grant executable or desktop authority.
use anyhow::{ensure, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::BTreeMap, path::PathBuf};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct Limits {
    pub max_rounds: usize,
    pub max_requests_per_turn: u64,
    pub max_tool_calls_per_turn: usize,
    pub max_turn_tokens: Option<u64>,
    pub max_conversation_tokens: Option<u64>,
    pub max_cost_usd: Option<f64>,
    pub max_turn_ms: u64,
    pub repeated_tool_limit: usize,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            max_rounds: 64,
            max_requests_per_turn: 64,
            max_tool_calls_per_turn: 256,
            max_turn_tokens: Some(1_000_000),
            max_conversation_tokens: None,
            max_cost_usd: None,
            max_turn_ms: 3_600_000,
            repeated_tool_limit: 3,
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct ContextSettings {
    pub auto_compact: bool,
    pub threshold_percent: u64,
    pub reserve_tokens: u64,
    pub fallback_window: Option<u64>,
    pub keep_recent_turns: usize,
    pub summary_max_chars: usize,
}
impl Default for ContextSettings {
    fn default() -> Self {
        Self {
            auto_compact: true,
            threshold_percent: 80,
            reserve_tokens: 2048,
            fallback_window: None,
            keep_recent_turns: 4,
            summary_max_chars: 24000,
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderSettings {
    pub pricing: Option<Pricing>,
    pub max_output_tokens: u64,
    pub temperature: Option<f64>,
    pub top_p: Option<f64>,
    pub custom_output_parameter: String,
    /// Explicit compatibility mapping; no field is guessed for a custom API.
    pub custom_effort_parameter: Option<String>,
    pub custom_stream_usage: bool,
    pub request_timeout_ms: u64,
    pub retries: usize,
    pub max_retry_delay_ms: u64,
}
impl Default for ProviderSettings {
    fn default() -> Self {
        Self {
            pricing: None,
            max_output_tokens: 16384,
            temperature: None,
            top_p: None,
            custom_output_parameter: "max_tokens".into(),
            custom_effort_parameter: None,
            custom_stream_usage: false,
            request_timeout_ms: 900_000,
            retries: 2,
            max_retry_delay_ms: 30_000,
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Pricing {
    pub input_usd_per_million: f64,
    pub output_usd_per_million: f64,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct PrivacySettings {
    pub respect_gitignore: bool,
    pub allow_sensitive_files: bool,
    pub allow_paths: Vec<String>,
}
impl Default for PrivacySettings {
    fn default() -> Self {
        Self {
            respect_gitignore: true,
            allow_sensitive_files: false,
            allow_paths: vec![],
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct ShellSettings {
    pub executable: Option<PathBuf>,
    pub environment: String,
    pub forward_env: Vec<String>,
}
impl Default for ShellSettings {
    fn default() -> Self {
        Self {
            executable: None,
            environment: "minimal".into(),
            forward_env: vec![],
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct ToolSettings {
    pub checkpoints: bool,
    pub parallel_reads: usize,
    pub github: bool,
    pub blender: bool,
    pub hyperframes: bool,
}
impl Default for ToolSettings {
    fn default() -> Self {
        Self {
            checkpoints: true,
            parallel_reads: 4,
            github: true,
            blender: true,
            hyperframes: true,
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct McpServer {
    pub name: String,
    pub command: PathBuf,
    #[serde(default)]
    pub args: Vec<String>,
    /// Names only. Values stay in the user's process environment.
    #[serde(default)]
    pub env: Vec<String>,
    #[serde(default)]
    pub read_only_tools: Vec<String>,
    #[serde(default = "yes")]
    pub enabled: bool,
}
fn yes() -> bool {
    true
}
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct Settings {
    pub limits: Limits,
    pub context: ContextSettings,
    pub provider: ProviderSettings,
    pub privacy: PrivacySettings,
    pub shell: ShellSettings,
    pub tools: ToolSettings,
    pub mcp_servers: Vec<McpServer>,
    pub diagnostics: bool,
}
#[derive(Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
struct Document {
    defaults: Settings,
    profiles: BTreeMap<String, Value>,
}
fn merge(target: &mut Value, source: &Value) {
    if let (Some(target), Some(source)) = (target.as_object_mut(), source.as_object()) {
        for (k, v) in source {
            if v.is_object() && target.get(k).is_some_and(Value::is_object) {
                merge(target.get_mut(k).unwrap(), v);
            } else {
                target.insert(k.clone(), v.clone());
            }
        }
    }
}
impl Settings {
    pub fn validate(&self) -> Result<()> {
        ensure!(
            (1..=1024).contains(&self.limits.max_rounds),
            "maxRounds must be 1..1024"
        );
        ensure!(
            (1..=1024).contains(&self.limits.max_requests_per_turn),
            "maxRequestsPerTurn must be 1..1024"
        );
        ensure!(
            (1..=4096).contains(&self.limits.max_tool_calls_per_turn),
            "maxToolCallsPerTurn must be 1..4096"
        );
        ensure!(
            (1000..=86_400_000).contains(&self.limits.max_turn_ms),
            "maxTurnMs must be 1000..86400000"
        );
        ensure!(
            (1..=100).contains(&self.limits.repeated_tool_limit),
            "repeatedToolLimit must be 1..100"
        );
        ensure!(
            self.limits.max_turn_tokens.is_none_or(|v| v > 0)
                && self.limits.max_conversation_tokens.is_none_or(|v| v > 0),
            "token limits must be positive"
        );
        ensure!(
            self.limits
                .max_cost_usd
                .is_none_or(|v| v.is_finite() && v > 0.0),
            "maxCostUsd must be positive and finite"
        );
        ensure!(
            (25..=95).contains(&self.context.threshold_percent),
            "thresholdPercent must be 25..95"
        );
        ensure!(
            (1..=64).contains(&self.context.keep_recent_turns),
            "keepRecentTurns must be 1..64"
        );
        ensure!(
            (1024..=128000).contains(&self.context.summary_max_chars),
            "summaryMaxChars must be 1024..128000"
        );
        ensure!(
            self.context
                .fallback_window
                .is_none_or(|v| (256..=16_000_000).contains(&v)),
            "fallbackWindow must be 256..16000000"
        );
        ensure!(
            self.context.reserve_tokens <= 1_000_000,
            "reserveTokens exceeds 1000000"
        );
        ensure!(
            (1..=1_000_000).contains(&self.provider.max_output_tokens),
            "maxOutputTokens must be 1..1000000"
        );
        if let Some(p) = &self.provider.pricing {
            ensure!(
                [p.input_usd_per_million, p.output_usd_per_million]
                    .iter()
                    .all(|v| v.is_finite() && *v >= 0.0 && *v <= 1_000_000_000.0),
                "invalid configured token prices"
            );
        }
        ensure!(
            self.provider
                .temperature
                .is_none_or(|v| v.is_finite() && (0.0..=2.0).contains(&v)),
            "temperature must be 0..2"
        );
        ensure!(
            self.provider
                .top_p
                .is_none_or(|v| v.is_finite() && v > 0.0 && v <= 1.0),
            "topP must be greater than zero and at most 1"
        );
        ensure!(
            ["max_tokens", "max_completion_tokens"]
                .contains(&self.provider.custom_output_parameter.as_str()),
            "unsupported customOutputParameter"
        );
        ensure!(
            self.provider
                .custom_effort_parameter
                .as_deref()
                .is_none_or(|v| ["reasoning_effort", "reasoning.effort"].contains(&v)),
            "customEffortParameter must be reasoning_effort or reasoning.effort"
        );
        ensure!(
            (1000..=3_600_000).contains(&self.provider.request_timeout_ms),
            "requestTimeoutMs must be 1000..3600000"
        );
        ensure!(
            self.provider.retries <= 5 && self.provider.max_retry_delay_ms <= 120_000,
            "retry configuration exceeds bounds"
        );
        ensure!(
            (1..=16).contains(&self.tools.parallel_reads),
            "parallelReads must be 1..16"
        );
        ensure!(
            ["minimal", "inherit"].contains(&self.shell.environment.as_str()),
            "shell environment must be minimal or inherit"
        );
        if let Some(path) = &self.shell.executable {
            ensure!(
                path.is_absolute() && path.is_file(),
                "shell executable must be an existing absolute file"
            );
        }
        ensure!(
            self.mcp_servers.len() <= 16,
            "at most 16 MCP servers are allowed"
        );
        let mut names = std::collections::HashSet::new();
        for server in &self.mcp_servers {
            ensure!(
                !server.name.is_empty()
                    && server.name.len() <= 24
                    && server
                        .name
                        .bytes()
                        .all(|c| c.is_ascii_alphanumeric() || c == b'_'),
                "MCP name must use 1..24 ASCII letters, numbers or underscores"
            );
            ensure!(
                names.insert(server.name.to_lowercase()),
                "duplicate MCP server name"
            );
            ensure!(
                server.command.is_absolute(),
                "MCP executable must be absolute"
            );
            ensure!(
                server.args.len() <= 64
                    && server
                        .args
                        .iter()
                        .all(|a| a.len() <= 8192 && !a.contains('\0')),
                "invalid MCP arguments"
            );
            ensure!(
                server.env.len() <= 32 && server.env.iter().all(|s| env_name(s)),
                "invalid MCP environment names"
            );
            ensure!(
                server.read_only_tools.len() <= 128
                    && server
                        .read_only_tools
                        .iter()
                        .all(|s| s.len() <= 128 && !s.contains('\0')),
                "invalid MCP read-only tools"
            );
        }
        ensure!(
            self.shell.forward_env.len() <= 128
                && self.shell.forward_env.iter().all(|s| env_name(s)),
            "invalid forwarded environment names"
        );
        ensure!(
            self.privacy.allow_paths.len() <= 128
                && self
                    .privacy
                    .allow_paths
                    .iter()
                    .all(|s| !s.is_empty() && s.len() <= 4096 && !s.contains('\0')),
            "invalid allowed file paths"
        );
        Ok(())
    }
    pub fn load(profile: Option<&str>) -> Result<Self> {
        let Some(raw) = crate::profile::read_user_file("settings.json")? else {
            return Ok(Self::default());
        };
        let doc: Document = serde_json::from_slice(&raw).context("invalid settings.json")?;
        let mut value = serde_json::to_value(doc.defaults)?;
        if let Some(p) = profile.and_then(|p| doc.profiles.get(p)) {
            ensure!(p.is_object(), "profile settings must be an object");
            merge(&mut value, p);
        }
        let settings: Self = serde_json::from_value(value).context("invalid profile settings")?;
        settings.validate()?;
        Ok(settings)
    }
}
fn env_name(s: &str) -> bool {
    !s.is_empty() && s.len() <= 128 && s.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_')
}
pub fn show() -> Result<Value> {
    match crate::profile::read_user_file("settings.json")? {
        Some(raw) => Ok(serde_json::from_slice(&raw)?),
        None => Ok(json!({"defaults":Settings::default(),"profiles":{}})),
    }
}
pub fn save(raw: Value) -> Result<Value> {
    let doc: Document =
        serde_json::from_value(raw).context("expected defaults and profiles settings objects")?;
    doc.defaults.validate()?;
    for (name, overrides) in &doc.profiles {
        ensure!(
            !name.trim().is_empty() && name.len() <= 256 && overrides.is_object(),
            "invalid profile override"
        );
        let mut value = serde_json::to_value(&doc.defaults)?;
        merge(&mut value, overrides);
        serde_json::from_value::<Settings>(value)?.validate()?;
    }
    let value = serde_json::to_value(doc)?;
    crate::profile::write_user_file("settings.json", &serde_json::to_vec_pretty(&value)?)?;
    Ok(value)
}
pub fn overlay(base: Settings, overrides: Option<&Value>) -> Result<Settings> {
    let Some(overrides) = overrides.filter(|v| !v.is_null()) else {
        return Ok(base);
    };
    ensure!(
        overrides.is_object() && serde_json::to_vec(overrides)?.len() <= 64 * 1024,
        "session settings must be an object of at most 64 KiB"
    );
    let mut value = serde_json::to_value(base)?;
    merge(&mut value, overrides);
    let value: Settings = serde_json::from_value(value)?;
    value.validate()?;
    Ok(value)
}
pub fn configure_environment(command: &mut tokio::process::Command, settings: &ShellSettings) {
    if settings.environment == "inherit" {
        return;
    }
    command.env_clear();
    for (name, value) in std::env::vars_os() {
        let key = name.to_string_lossy().to_ascii_uppercase();
        let allowed = matches!(
            key.as_str(),
            "SYSTEMROOT"
                | "WINDIR"
                | "PATH"
                | "PATHEXT"
                | "COMSPEC"
                | "PROGRAMFILES"
                | "PROGRAMFILES(X86)"
                | "PROGRAMDATA"
                | "USERPROFILE"
                | "HOME"
                | "HOMEDRIVE"
                | "HOMEPATH"
                | "APPDATA"
                | "LOCALAPPDATA"
                | "TEMP"
                | "TMP"
                | "TMPDIR"
                | "LANG"
                | "LANGUAGE"
                | "TZ"
                | "TERM"
                | "COLORTERM"
                | "DISPLAY"
                | "WAYLAND_DISPLAY"
                | "XDG_RUNTIME_DIR"
                | "XDG_SESSION_TYPE"
                | "XDG_DATA_HOME"
                | "XDG_CONFIG_HOME"
                | "DBUS_SESSION_BUS_ADDRESS"
                | "SSH_AUTH_SOCK"
                | "CARGO_HOME"
                | "RUSTUP_HOME"
                | "GIT_SSH"
                | "GIT_SSH_COMMAND"
                | "GIT_CONFIG_GLOBAL"
                | "VIRTUAL_ENV"
                | "JAVA_HOME"
                | "DOTNET_ROOT"
                | "NVM_HOME"
                | "NVM_SYMLINK"
        ) || key.starts_with("LC_")
            || settings
                .forward_env
                .iter()
                .any(|v| v.eq_ignore_ascii_case(&key));
        if allowed {
            command.env(name, value);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validates_limits_and_rejects_unknown_authority() {
        Settings::default().validate().unwrap();
        assert!(serde_json::from_value::<Settings>(json!({"apiKey":"never-stored-here"})).is_err());
        let mut s = Settings::default();
        s.limits.max_cost_usd = Some(-1.0);
        assert!(s.validate().is_err());
        s = Settings::default();
        s.tools.parallel_reads = 0;
        assert!(s.validate().is_err());
    }
    #[test]
    fn profile_merge_preserves_other_limits() {
        let mut v = serde_json::to_value(Settings::default()).unwrap();
        merge(&mut v, &json!({"limits":{"maxRounds":7}}));
        let s: Settings = serde_json::from_value(v).unwrap();
        assert_eq!(s.limits.max_rounds, 7);
        assert_eq!(s.limits.max_requests_per_turn, 64);
    }
}
