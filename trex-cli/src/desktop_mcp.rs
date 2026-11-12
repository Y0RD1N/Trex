//! Desktop control as an MCP server (`trex-agent desktop-mcp`), one process per session.
use crate::{
    desktop::{DesktopProvider, DesktopUncertain},
    mcp_server::{self, Spec},
    tools::ToolProvider,
};
use anyhow::{ensure, Result};
use std::{path::PathBuf, sync::Arc};

pub async fn serve(mode: &str) -> Result<()> {
    ensure!(
        matches!(mode, "plan" | "full"),
        "desktop MCP mode must be plan or full"
    );
    let provider = Arc::new(DesktopProvider::default());
    let spec = Spec {
        server_name: "trex-desktop",
        label: "Desktop",
        instructions: crate::desktop::guidance(mode == "plan"),
        read_only: crate::desktop::read_only,
        is_uncertain: |error| error.downcast_ref::<DesktopUncertain>().is_some(),
        uncertain_error: || DesktopUncertain.into(),
        cwd: PathBuf::from("."),
        no_replay: &["desktop_screenshot"],
        queue: false,
    };
    let shared: Arc<dyn ToolProvider> = provider.clone();
    let outcome = mcp_server::serve(shared, spec, mode).await;
    provider.invalidate_observation();
    outcome
}
