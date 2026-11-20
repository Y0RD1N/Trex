//! Optional access to the person's own browser through the Trex extension
//! (tabs_list, read_page, click…). The app owns the bridge: this CLI only starts
//! the app's stdio adapter, which forwards to a loopback endpoint with this
//! session's token. Models cannot choose the executable or the address.
use crate::settings::McpServer;
use anyhow::{ensure, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;

/// Name of the connection (startup guidance and `unavailableMcpServers`).
pub const SERVER: &str = "trex_chrome";
/// The session token lives in this CLI's environment; only its name is configured.
pub const TOKEN_ENV: &str = "TREX_CHROME_TOKEN";
/// Tools that only look. Must match OBSERVE_TOOLS in src-tauri/src/browser_bridge.rs.
pub const READ_TOOLS: [&str; 3] = ["tabs_list", "read_page", "screenshot"];

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ChromeConfig {
    pub command: PathBuf,
    pub args: Vec<String>,
}

/// `http://127.0.0.1:<port>/mcp`, with a plain unprivileged port.
fn local_endpoint(url: &str) -> bool {
    url.strip_prefix("http://127.0.0.1:")
        .and_then(|rest| rest.strip_suffix("/mcp"))
        .is_some_and(|port| port.parse::<u16>().is_ok_and(|value| value >= 1024 && value.to_string() == port))
}

impl ChromeConfig {
    /// `{command, args}` with args exactly `["--trex-chrome-mcp", "http://127.0.0.1:<port>/mcp"]`.
    pub fn parse(raw: Option<&Value>) -> Result<Option<Self>> {
        let Some(raw) = raw.filter(|v| !v.is_null()) else {
            return Ok(None);
        };
        let config: Self = serde_json::from_value(raw.clone()).context("invalid browser extension binding")?;
        ensure!(config.command.is_absolute(), "browser extension adapter must be absolute");
        ensure!(
            config.args.len() == 2 && config.args[0] == "--trex-chrome-mcp" && local_endpoint(&config.args[1]),
            "invalid browser extension arguments"
        );
        crate::team::app_bridge(&config.command, "browser extension adapter")?;
        Ok(Some(config))
    }

    /// The app's adapter. Not app-owned in the MCP sense: its tools keep the usual
    /// prefix and only the reading ones are available while planning.
    pub fn server(&self) -> McpServer {
        McpServer {
            name: SERVER.into(),
            command: self.command.clone(),
            args: self.args.clone(),
            env: vec![TOKEN_ENV.into()],
            read_only_tools: READ_TOOLS.iter().map(|tool| tool.to_string()).collect(),
            enabled: true,
            app_owned: false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn only_the_app_beside_this_cli_with_a_loopback_address_is_accepted() {
        assert!(ChromeConfig::parse(None).unwrap().is_none());
        assert!(ChromeConfig::parse(Some(&Value::Null)).unwrap().is_none());
        let reject = |value: Value, why: &str| {
            let error = ChromeConfig::parse(Some(&value)).unwrap_err().to_string();
            assert!(error.contains(why), "{error}");
        };
        let good = json!(["--trex-chrome-mcp", "http://127.0.0.1:7341/mcp"]);
        reject(json!({"command":"trex.exe","args":good}), "absolute");
        let absolute = std::env::current_exe().unwrap();
        for bad in [json!(["--trex-chrome-mcp"]), json!(["--trex-inbox-mcp", "http://127.0.0.1:7341/mcp"]),
            json!(["--trex-chrome-mcp", "http://evil.example:7341/mcp"]), json!(["--trex-chrome-mcp", "https://127.0.0.1:7341/mcp"]),
            json!(["--trex-chrome-mcp", "http://127.0.0.1:80/mcp"]), json!(["--trex-chrome-mcp", "http://127.0.0.1:07341/mcp"]),
            json!(["--trex-chrome-mcp", "http://127.0.0.1:7341/mcp", "--extra"])] {
            reject(json!({"command":absolute,"args":bad}), "arguments");
        }
        reject(json!({"command":absolute,"args":good,"env":{"X":"1"}}), "invalid browser extension binding");
        // A real, existing executable that is not the app beside this CLI.
        reject(json!({"command":absolute,"args":good}), "app beside this CLI");
    }

    #[test]
    fn the_server_reads_its_token_from_the_environment_and_only_reading_is_safe_while_planning() {
        let config = ChromeConfig { command: PathBuf::from("C:/Trex/trex.exe"), args: vec!["--trex-chrome-mcp".into(), "http://127.0.0.1:7341/mcp".into()] };
        let server = config.server();
        assert_eq!(server.name, SERVER);
        assert_eq!(server.env, [TOKEN_ENV]);
        assert_eq!(server.read_only_tools, READ_TOOLS);
        assert!(server.enabled && !server.app_owned);
    }
}
