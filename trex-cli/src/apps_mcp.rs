//! Application control as one MCP server (`trex-agent apps-mcp`): Blender today, and the
//! other apps the integrations page lists as they get real tools. One process per session,
//! with the permission mode and workspace fixed at start. Claude Code, Codex and Antigravity
//! connect to it; Trex CLI uses the same providers natively, so every agent gets the same tools.
use crate::{
    blender::BlenderProvider,
    blender_live::{BlenderLiveProvider, BlenderLiveUncertain},
    github::{GithubProvider, GithubUncertain},
    hyperframes::{HyperframesProvider, HyperframesUncertain},
    mcp_server::{self, Spec},
    tools::{ToolFuture, ToolProvider},
};
use anyhow::{ensure, Result};
use serde_json::Value;
use std::{
    path::{Path, PathBuf},
    sync::Arc,
};
use tokio_util::sync::CancellationToken;

/// The worker died mid-operation: whether it took effect is unknown.
#[derive(Debug)]
pub struct AppsUncertain;
impl std::fmt::Display for AppsUncertain {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("The tool stopped unexpectedly and its effect is unknown. Inspect the application (for Blender, call blender_scene) before continuing, and never repeat the operation automatically.")
    }
}
impl std::error::Error for AppsUncertain {}

/// The applications a session can be given, chosen when its server starts (`--apps blender,hyperframes`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum App {
    Blender,
    Hyperframes,
    Github,
}
impl App {
    pub fn parse_list(list: &str) -> Result<Vec<App>> {
        let mut apps = Vec::new();
        for name in list.split(',').map(str::trim) {
            let app = match name {
                "blender" => App::Blender,
                "hyperframes" => App::Hyperframes,
                "github" => App::Github,
                other => anyhow::bail!("unknown application {other:?}; expected blender, hyperframes and/or github"),
            };
            ensure!(!apps.contains(&app), "application listed twice");
            apps.push(app);
        }
        ensure!(!apps.is_empty(), "--apps needs at least one application");
        Ok(apps)
    }
}

pub fn read_only(name: &str) -> bool {
    crate::blender_live::read_only(name) || crate::hyperframes::read_only(name) || crate::github::read_only(name)
}

fn is_uncertain(error: &anyhow::Error) -> bool {
    error.downcast_ref::<AppsUncertain>().is_some()
        || error.downcast_ref::<BlenderLiveUncertain>().is_some()
        || error.downcast_ref::<crate::blender::BlenderUncertain>().is_some()
        || error.downcast_ref::<HyperframesUncertain>().is_some()
        || error.downcast_ref::<GithubUncertain>().is_some()
}

/// Several providers behind one catalog; a call goes to whichever one defines the tool.
pub struct AppsProvider {
    providers: Vec<Box<dyn ToolProvider>>,
}
impl AppsProvider {
    pub fn new(apps: &[App]) -> Self {
        let mut providers: Vec<Box<dyn ToolProvider>> = Vec::new();
        for app in apps {
            match app {
                App::Blender => {
                    providers.push(Box::new(BlenderLiveProvider::default()));
                    // The headless runner stays available for batch scripts when no Blender is open.
                    if crate::blender::available() {
                        providers.push(Box::new(BlenderProvider));
                    }
                }
                // Always in the catalog (a stable inventory); a missing CLI is reported when a tool is called.
                App::Hyperframes => providers.push(Box::new(HyperframesProvider)),
                // Same: always in the catalog; a missing or logged-out gh is explained when a tool is called.
                App::Github => providers.push(Box::new(GithubProvider::default())),
            }
        }
        Self { providers }
    }
    pub fn with_providers(providers: Vec<Box<dyn ToolProvider>>) -> Self {
        Self { providers }
    }
    fn owner(&self, mode: &str, name: &str) -> Option<&dyn ToolProvider> {
        self.providers
            .iter()
            .map(|p| p.as_ref())
            .find(|p| p.definitions(mode).iter().any(|tool| tool["function"]["name"] == name))
    }
}
impl ToolProvider for AppsProvider {
    fn guidance(&self, mode: &str) -> Option<String> {
        let parts: Vec<String> = self.providers.iter().filter_map(|p| p.guidance(mode)).collect();
        (!parts.is_empty()).then(|| parts.join("\n\n"))
    }
    fn definitions(&self, mode: &str) -> Vec<Value> {
        self.providers.iter().flat_map(|p| p.definitions(mode)).collect()
    }
    fn is_mutating(&self, name: &str, input: &Value) -> bool {
        // A tool nobody defines fails closed.
        self.owner("full", name).is_none_or(|p| p.is_mutating(name, input))
    }
    fn execute<'a>(&'a self, cwd: &'a Path, mode: &'a str, name: &'a str, input: &'a Value, operation_id: &'a str, cancel: CancellationToken) -> ToolFuture<'a> {
        Box::pin(async move {
            let Some(provider) = self.owner(mode, name) else {
                anyhow::bail!("Tool unavailable in this permission mode.");
            };
            provider.execute(cwd, mode, name, input, operation_id, cancel).await
        })
    }
}

pub fn spec(mode: &str, cwd: PathBuf, instructions: String) -> Spec {
    Spec {
        server_name: "trex-apps",
        label: "Apps",
        instructions,
        read_only,
        is_uncertain,
        uncertain_error: || AppsUncertain.into(),
        cwd,
        no_replay: &[],
        // Blender calls are quick and ordered (look, act, look): run them in sequence instead of rejecting.
        queue: mode == "plan" || mode == "full",
    }
}

pub async fn serve(mode: &str, cwd: PathBuf, apps: &[App]) -> Result<()> {
    ensure!(matches!(mode, "plan" | "full"), "apps MCP mode must be plan or full");
    ensure!(cwd.is_absolute() && cwd.is_dir(), "--cwd must be an existing absolute directory");
    let provider = Arc::new(AppsProvider::new(apps));
    let instructions = provider.guidance(mode).unwrap_or_default();
    mcp_server::serve(provider, spec(mode, cwd, instructions), mode).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    struct Echo(&'static str, bool);
    impl ToolProvider for Echo {
        fn definitions(&self, _: &str) -> Vec<Value> {
            vec![json!({"type":"function","function":{"name":self.0,"description":"d","parameters":{"type":"object"}}})]
        }
        fn is_mutating(&self, _: &str, _: &Value) -> bool {
            self.1
        }
        fn execute<'a>(&'a self, _: &'a Path, _: &'a str, name: &'a str, _: &'a Value, _: &'a str, _: CancellationToken) -> ToolFuture<'a> {
            Box::pin(async move { Ok(json!({"ran": name})) })
        }
    }

    #[tokio::test]
    async fn calls_reach_the_provider_that_defines_the_tool() {
        let apps = AppsProvider::with_providers(vec![Box::new(Echo("one", false)), Box::new(Echo("two", true))]);
        assert_eq!(apps.definitions("full").len(), 2);
        let ran = apps.execute(Path::new("."), "full", "two", &json!({}), "o", CancellationToken::new()).await.unwrap();
        assert_eq!(ran["ran"], "two");
        assert!(apps.execute(Path::new("."), "full", "missing", &json!({}), "o", CancellationToken::new()).await.is_err());
        assert!(!apps.is_mutating("one", &json!({})) && apps.is_mutating("two", &json!({})));
        assert!(apps.is_mutating("missing", &json!({})), "unknown tools fail closed");
    }

    #[test]
    fn planning_exposes_no_write_tool_from_any_app() {
        let apps = AppsProvider::new(&[App::Blender, App::Hyperframes, App::Github]);
        for tool in apps.definitions("plan") {
            let name = tool["function"]["name"].as_str().unwrap();
            assert!(read_only(name), "{name} must not be offered in plan mode");
        }
        let full: Vec<String> = apps.definitions("full").iter().map(|t| t["function"]["name"].as_str().unwrap().to_owned()).collect();
        for expected in ["blender_exec", "hyperframes_render", "hyperframes_snapshot", "github_pr_merge", "github_comment"] {
            assert!(full.contains(&expected.to_owned()), "{expected}");
        }
    }

    #[test]
    fn a_session_only_gets_the_applications_it_asked_for() {
        let names = |apps: &[App]| AppsProvider::new(apps).definitions("full").iter().map(|t| t["function"]["name"].as_str().unwrap().to_owned()).collect::<Vec<_>>();
        assert!(names(&[App::Blender]).iter().all(|n| n.starts_with("blender_")));
        assert!(names(&[App::Hyperframes]).iter().all(|n| n.starts_with("hyperframes_")));
        assert!(names(&[App::Github]).iter().all(|n| n.starts_with("github_")));
        assert_eq!(names(&[App::Hyperframes]).len(), 8);
        assert_eq!(names(&[App::Github]).len(), 10);
        let all = AppsProvider::new(&[App::Blender, App::Hyperframes, App::Github]);
        let guidance = all.guidance("full").unwrap();
        assert!(guidance.contains("Live Blender") && guidance.contains("HyperFrames renders HTML") && guidance.contains("GitHub uses the user's own gh login"));
        assert!(guidance.len() < 4000, "Claude Code cuts server instructions at 4096 characters ({} for all three apps)", guidance.len());
    }

    #[test]
    fn the_applications_list_is_validated() {
        assert_eq!(App::parse_list("blender").unwrap(), vec![App::Blender]);
        assert_eq!(App::parse_list("hyperframes, blender").unwrap(), vec![App::Hyperframes, App::Blender]);
        assert_eq!(App::parse_list("github,blender,hyperframes").unwrap(), vec![App::Github, App::Blender, App::Hyperframes]);
        for bad in ["", "blender,blender", "gimp", "blender,,hyperframes"] {
            assert!(App::parse_list(bad).is_err(), "{bad:?}");
        }
    }
}
