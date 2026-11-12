//! Managing the Blender bridge from outside an agent session (`trex-agent blender-bridge`, used by
//! Settings): what is installed and running, installing the add-on into Blender, removing it, and
//! opening Blender with the bridge. Installing runs Blender itself in the background with
//! `assets/blender/trex_install.py`, so the add-on folder, the preferences file and the add-on
//! registry are Blender's own on every platform, and the user's other preferences are kept.
use crate::{
    blender::{locate, Install},
    blender_live::{data_dir, install_bridge_file, live_sessions, open_session},
};
use anyhow::{bail, ensure, Context, Result};
use serde_json::{json, Value};
use std::{path::{Path, PathBuf}, process::Stdio, time::Duration};
use tokio_util::sync::CancellationToken;

const INSTALLER_PY: &str = include_str!("../assets/blender/trex_install.py");
const MARKER: &str = "TREX_INSTALL ";

fn installer_file() -> Result<PathBuf> {
    let path = data_dir()?.join("trex_install.py");
    if std::fs::read_to_string(&path).map(|existing| existing != INSTALLER_PY).unwrap_or(true) {
        std::fs::write(&path, INSTALLER_PY)?;
    }
    Ok(path)
}

/// Run Blender without a window and return what it printed. Never inherits stdin; bounded in time.
async fn run_blender(install: &Install, args: &[&std::ffi::OsStr], limit: Duration) -> Result<String> {
    let mut command = tokio::process::Command::new(install.program());
    command.args(install.prefix()).args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    #[cfg(windows)]
    {
        command.creation_flags(0x0800_0000);
    }
    let output = tokio::time::timeout(limit, command.output())
        .await
        .map_err(|_| anyhow::anyhow!("Blender did not finish within {} seconds", limit.as_secs()))?
        .context("could not start Blender")?;
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// `Blender 5.2.2 LTS`, from `--version` (no scene is loaded).
pub(crate) async fn blender_version(install: &Install) -> Option<String> {
    let text = run_blender(install, &["--version".as_ref()], Duration::from_secs(20)).await.ok()?;
    text.lines().next().map(|line| line.trim().trim_start_matches("Blender ").to_owned()).filter(|v| !v.is_empty())
}

fn parse_report(stdout: &str) -> Result<Value> {
    let line = stdout.lines().rev().find_map(|line| line.strip_prefix(MARKER)).context("Blender did not report back (is the add-on folder writable?)")?;
    let report: Value = serde_json::from_str(line).context("unreadable report from Blender")?;
    if let Some(error) = report["error"].as_str() {
        bail!("{error}");
    }
    Ok(report)
}

async fn addon(install: &Install, action: &str) -> Result<Value> {
    ensure!(matches!(action, "status" | "install" | "uninstall"), "unknown add-on action");
    let bridge = install_bridge_file()?;
    let installer = installer_file()?;
    let stdout = run_blender(
        install,
        &["--background".as_ref(), "--python".as_ref(), installer.as_os_str(), "--".as_ref(), action.as_ref(), bridge.as_os_str()],
        Duration::from_secs(90),
    )
    .await?;
    let report = parse_report(&stdout)?;
    Ok(json!({"installed": report["installed"], "enabled": report["enabled"], "upToDate": report["up_to_date"], "path": report["path"], "blender": report["blender"]}))
}

fn describe(install: &Install, version: Option<String>) -> Value {
    json!({"found": true, "version": version, "kind": match install { Install::Binary(_) => "binary", Install::Flatpak(_) => "flatpak" }, "path": install.program()})
}

/// What Settings shows: Blender found, the add-on state and every running bridge session.
pub async fn status(dir: &Path, cancel: &CancellationToken) -> Result<Value> {
    let sessions = live_sessions(dir, cancel).await;
    let Some(install) = locate() else {
        return Ok(json!({"blender": {"found": false}, "addon": null, "sessions": sessions}));
    };
    let version = blender_version(&install).await;
    let addon = addon(&install, "status").await.ok();
    Ok(json!({"blender": describe(&install, version), "addon": addon, "sessions": sessions}))
}

pub async fn change(action: &str, dir: &Path, cancel: &CancellationToken) -> Result<Value> {
    let install = locate().context("Blender not found; install it from https://www.blender.org/download/")?;
    let addon_state = addon(&install, action).await?;
    let version = blender_version(&install).await;
    Ok(json!({"blender": describe(&install, version), "addon": addon_state, "sessions": live_sessions(dir, cancel).await}))
}

pub async fn open(dir: &Path, file: Option<PathBuf>, cancel: &CancellationToken) -> Result<Value> {
    if let Some(file) = &file {
        ensure!(file.is_absolute() && file.is_file() && file.extension().is_some_and(|e| e.eq_ignore_ascii_case("blend")), "file must be an existing absolute .blend path");
    }
    open_session(dir, file.as_deref(), cancel).await?;
    status(dir, cancel).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_report_is_read_from_the_last_marker_line_and_errors_surface() {
        let ok = "Blender 5.2\nnoise\nTREX_INSTALL {\"installed\":true,\"enabled\":true,\"up_to_date\":true,\"error\":null}\n";
        assert_eq!(parse_report(ok).unwrap()["installed"], true);
        let failed = "TREX_INSTALL {\"error\":\"PermissionError: no\"}\n";
        assert!(parse_report(failed).unwrap_err().to_string().contains("PermissionError"));
        assert!(parse_report("nothing useful").is_err());
        assert!(parse_report("TREX_INSTALL not json").is_err());
    }

    #[test]
    fn the_installer_keeps_the_users_preferences_by_not_using_factory_startup() {
        assert!(INSTALLER_PY.contains("WITHOUT --factory-startup"));
        assert!(INSTALLER_PY.contains("save_userpref"));
        assert!(INSTALLER_PY.starts_with("# SPDX-License-Identifier: GPL-3.0-or-later"));
    }

    #[tokio::test]
    async fn open_rejects_files_that_are_not_blend_files() {
        let dir = tempfile::tempdir().unwrap();
        let cancel = CancellationToken::new();
        assert!(open(dir.path(), Some(PathBuf::from("relative.blend")), &cancel).await.is_err());
        let wrong = dir.path().join("x.txt");
        std::fs::write(&wrong, "x").unwrap();
        assert!(open(dir.path(), Some(wrong), &cancel).await.is_err());
    }
}
