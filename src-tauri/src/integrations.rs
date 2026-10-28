//! Read-only dependency discovery. No application, model or authentication flow is started.
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegrationStatus {
    blender: bool,
    hyperframes: bool,
    hyperframes_local: bool,
    github_cli: bool,
    node: bool,
    ffmpeg: bool,
}

fn file_in(dir: &Path, names: &[&str]) -> bool {
    names.iter().any(|name| {
        let Ok(metadata) = std::fs::metadata(dir.join(name)) else { return false };
        if !metadata.is_file() { return false }
        #[cfg(unix)]
        { use std::os::unix::fs::PermissionsExt; metadata.permissions().mode() & 0o111 != 0 }
        #[cfg(not(unix))]
        { true }
    })
}

fn in_path(names: &[&str]) -> bool {
    find_in_path(names).is_some()
}

fn find_in_path(names: &[&str]) -> Option<PathBuf> {
    let Some(path) = std::env::var_os("PATH") else { return None };
    std::env::split_paths(&path).filter(|dir| dir.is_absolute())
        .find_map(|dir| names.iter().find(|name| file_in(&dir, &[name])).map(|name| dir.join(name)))
}

fn home_bin(names: &[&str]) -> bool {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .map(PathBuf::from).filter(|p| p.is_absolute())
        .is_some_and(|home| file_in(&home.join(".local").join("bin"), names))
}

fn find_github() -> Option<PathBuf> {
    let name = if cfg!(windows) { "gh.exe" } else { "gh" };
    let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .map(PathBuf::from).filter(|path| path.is_absolute()).map(|path| path.join(".local/bin"));
    let found = find_in_path(&[name]).or_else(|| home.filter(|dir| file_in(dir, &[name])).map(|dir| dir.join(name)));
    #[cfg(windows)]
    let found = found.or_else(|| std::env::var_os("ProgramFiles").map(PathBuf::from)
        .filter(|path| path.is_absolute()).map(|path| path.join("GitHub CLI"))
        .filter(|dir| file_in(dir, &[name])).map(|dir| dir.join(name)));
    found
}

#[cfg(windows)]
fn installed_blender() -> bool {
    let Some(programs) = std::env::var_os("ProgramFiles").map(PathBuf::from).filter(|p| p.is_absolute()) else { return false };
    let base = programs.join("Blender Foundation");
    std::fs::read_dir(base).ok().into_iter().flatten().flatten()
        .any(|entry| entry.file_name().to_string_lossy().starts_with("Blender ") && entry.path().join("blender.exe").is_file())
}
#[cfg(not(windows))]
fn installed_blender() -> bool { false }

fn local_hyperframes(cwd: Option<&str>) -> bool {
    let Some(path) = cwd.map(Path::new).filter(|path| path.is_absolute()) else { return false };
    let bin = path.join("node_modules").join(".bin");
    file_in(&bin, if cfg!(windows) { &["hyperframes.cmd", "hyperframes.exe"] } else { &["hyperframes"] })
}

fn discover(cwd: Option<&str>) -> IntegrationStatus {
    let local = local_hyperframes(cwd);
    let blender = if cfg!(windows) { &["blender.exe"][..] } else { &["blender"][..] };
    let hyperframes = if cfg!(windows) { &["hyperframes.cmd", "hyperframes.exe"][..] } else { &["hyperframes"][..] };
    let node = if cfg!(windows) { &["node.exe"][..] } else { &["node"][..] };
    let ffmpeg = if cfg!(windows) { &["ffmpeg.exe"][..] } else { &["ffmpeg"][..] };
    let npm_global = std::env::var_os("APPDATA").map(PathBuf::from).filter(|p| p.is_absolute())
        .is_some_and(|base| file_in(&base.join("npm"), hyperframes));
    IntegrationStatus {
        blender: in_path(blender) || home_bin(blender) || installed_blender(),
        hyperframes: local || in_path(hyperframes) || home_bin(hyperframes) || (cfg!(windows) && npm_global),
        hyperframes_local: local,
        github_cli: find_github().is_some(),
        node: in_path(node) || home_bin(node),
        ffmpeg: in_path(ffmpeg) || home_bin(ffmpeg),
    }
}

#[tauri::command]
pub async fn integration_dependencies(cwd: Option<String>) -> Result<IntegrationStatus, String> {
    tauri::async_runtime::spawn_blocking(move || discover(cwd.as_deref()))
        .await.map_err(|_| "No se pudieron comprobar las aplicaciones.".to_owned())
}

/// Only a status code leaves this boundary; `gh` output may contain account
/// information and must never include credentials in application logs.
fn github_status(binary: &Path, timeout: Duration) -> &'static str {
    let mut command = std::process::Command::new(binary);
    command.args(["auth", "status"]).env("GH_PROMPT_DISABLED", "1")
        .stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    #[cfg(windows)]
    { use std::os::windows::process::CommandExt; command.creation_flags(0x0800_0000); }
    let Ok(mut child) = command.spawn() else { return "unavailable" };
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return if status.success() { "connected" } else { "unavailable" },
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(25)),
            _ => { let _ = child.kill(); let _ = child.wait(); return "timeout"; }
        }
    }
}

#[tauri::command]
pub async fn github_connection_status() -> Result<&'static str, String> {
    tauri::async_runtime::spawn_blocking(|| {
        find_github().map(|path| github_status(&path, Duration::from_secs(5))).unwrap_or("notFound")
    }).await.map_err(|_| "No se pudo comprobar GitHub.".to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn local_detection_rejects_relative_paths_and_missing_projects() {
        assert!(!local_hyperframes(None));
        assert!(!local_hyperframes(Some("relative/project")));
        assert!(!local_hyperframes(Some("/a/nonexistent/trex-test-project")));
    }
    #[test]
    fn detects_a_project_binary_without_executing_it() {
        let dir=std::env::temp_dir().join(format!("trex-integrations-{}",std::process::id()));
        let bin=dir.join("node_modules/.bin");
        std::fs::create_dir_all(&bin).unwrap();
        let name=if cfg!(windows) { "hyperframes.cmd" } else { "hyperframes" };
        std::fs::write(bin.join(name), b"not an executable").unwrap();
        #[cfg(unix)] {
            use std::os::unix::fs::PermissionsExt;
            assert!(!local_hyperframes(dir.to_str()));
            std::fs::set_permissions(bin.join(name), std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        assert!(local_hyperframes(dir.to_str()));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn github_probe_bounds_time_and_does_not_expose_output() {
        use std::os::unix::fs::PermissionsExt;
        let dir=std::env::temp_dir().join(format!("trex-github-probe-{}",std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let binary=dir.join("gh");
        std::fs::write(&binary, b"#!/bin/sh\necho private-credential >&2\nexit 0\n").unwrap();
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o700)).unwrap();
        assert_eq!(github_status(&binary, Duration::from_secs(2)), "connected");
        std::fs::write(&binary, b"#!/bin/sh\nexit 1\n").unwrap();
        assert_eq!(github_status(&binary, Duration::from_secs(2)), "unavailable");
        std::fs::write(&binary, b"#!/bin/sh\nwhile :; do :; done\n").unwrap();
        assert_eq!(github_status(&binary, Duration::from_millis(50)), "timeout");
        std::fs::remove_dir_all(dir).unwrap();
    }
}
