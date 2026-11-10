//! Optional coordination with the other Trex sessions of the same project
//! (trex_peers, trex_claim, trex_release, trex_message). The app owns the
//! registry: this CLI only starts the app's own MCP server in its
//! coordination-only mode. Models cannot choose the executable, the storage,
//! the session or the project.
use crate::settings::McpServer;
use anyhow::{ensure, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};

/// Name of the connection (startup guidance and `unavailableMcpServers`).
pub const SERVER: &str = "trex_coordination";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CoordinationConfig {
    pub command: PathBuf,
    pub args: Vec<String>,
}

fn identity(value: &str) -> bool {
    !value.is_empty() && value.len() <= 160 && value.bytes().all(|b| b.is_ascii_alphanumeric() || b"_-:.".contains(&b))
}

impl CoordinationConfig {
    /// `{command, args}` with args exactly
    /// `["--trex-inbox-mcp", appDataDir, queueId, "--peers-only", "--peer", sessionId, projectDir]`.
    /// The project must be this session's workspace.
    pub fn parse(raw: Option<&Value>, cwd: &Path) -> Result<Option<Self>> {
        let Some(raw) = raw.filter(|v| !v.is_null()) else {
            return Ok(None);
        };
        let config: Self = serde_json::from_value(raw.clone()).context("invalid coordination binding")?;
        ensure!(config.command.is_absolute(), "coordination server must be absolute");
        let args = &config.args;
        ensure!(
            args.len() == 7 && args[0] == "--trex-inbox-mcp" && args[3] == "--peers-only" && args[4] == "--peer",
            "invalid coordination arguments"
        );
        ensure!(Path::new(&args[1]).is_absolute(), "coordination storage must be absolute");
        ensure!(identity(&args[2]) && identity(&args[5]), "invalid coordination identity");
        let project = std::fs::canonicalize(&args[6]).context("coordination project is unavailable")?;
        ensure!(project == cwd, "coordination project must be this session's workspace");
        crate::team::app_bridge(&config.command, "coordination server")?;
        Ok(Some(config))
    }

    /// The app's MCP server; its tools keep their names and never touch the workspace.
    pub fn server(&self) -> McpServer {
        McpServer {
            name: SERVER.into(),
            command: self.command.clone(),
            args: self.args.clone(),
            env: Vec::new(),
            read_only_tools: Vec::new(),
            enabled: true,
            app_owned: true,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn only_the_app_beside_this_cli_with_its_exact_arguments_is_accepted() {
        let cwd = std::fs::canonicalize(std::env::temp_dir()).unwrap();
        let data = cwd.join("trex-data");
        let args = |project: &Path| json!(["--trex-inbox-mcp", data, "t-tab-1", "--peers-only", "--peer", "t-tab-1", project]);
        assert!(CoordinationConfig::parse(None, &cwd).unwrap().is_none());
        assert!(CoordinationConfig::parse(Some(&Value::Null), &cwd).unwrap().is_none());
        let reject = |value: Value, why: &str| {
            let error = CoordinationConfig::parse(Some(&value), &cwd).unwrap_err().to_string();
            assert!(error.contains(why), "{error}");
        };
        reject(json!({"command":"trex.exe","args":args(&cwd)}), "absolute");
        let absolute = std::env::current_exe().unwrap();
        reject(json!({"command":absolute,"args":["--trex-inbox-mcp"]}), "arguments");
        reject(json!({"command":absolute,"args":["--trex-inbox-mcp", data, "t-1", "--tasks-only", "--peer", "t-1", cwd]}), "arguments");
        reject(json!({"command":absolute,"args":["--trex-inbox-mcp", "relative", "t-1", "--peers-only", "--peer", "t-1", cwd]}), "storage");
        reject(json!({"command":absolute,"args":["--trex-inbox-mcp", data, "../x", "--peers-only", "--peer", "t-1", cwd]}), "identity");
        reject(json!({"command":absolute,"args":args(&cwd.join("missing-project-for-trex"))}), "project");
        reject(json!({"command":absolute,"args":args(Path::new(env!("CARGO_MANIFEST_DIR")))}), "workspace");
        reject(json!({"command":absolute,"args":args(&cwd),"extra":true}), "invalid coordination binding");
        // A real, existing executable that is not the app beside this CLI.
        reject(json!({"command":absolute,"args":args(&cwd)}), "app beside this CLI");
    }

    #[test]
    fn the_server_is_marked_app_owned_and_never_comes_from_settings() {
        let config = CoordinationConfig { command: PathBuf::from("C:/Trex/trex.exe"), args: vec!["--trex-inbox-mcp".into()] };
        let server = config.server();
        assert!(server.app_owned && server.enabled && server.env.is_empty());
        assert_eq!(server.name, SERVER);
        // User settings cannot claim an app-owned server.
        let user: Result<McpServer, _> = serde_json::from_value(json!({"name":"x","command":"C:/x.exe","appOwned":true}));
        assert!(user.is_err());
        let user: McpServer = serde_json::from_value(json!({"name":"x","command":"C:/x.exe"})).unwrap();
        assert!(!user.app_owned);
    }
}
