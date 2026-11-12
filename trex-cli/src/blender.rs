//! Execute workspace scripts in a new background Blender process.
use crate::tools::{ToolFuture, ToolProvider};
use anyhow::{ensure, Context, Result};
use serde_json::{json, Value};
use std::path::{Component, Path, PathBuf};
use tokio_util::sync::CancellationToken;

pub struct BlenderProvider;
pub(crate) fn available() -> bool {
    locate().is_some()
}
/// A Blender that Trex can start. Flatpak runs through the `flatpak` launcher.
#[derive(Clone, Debug)]
pub(crate) enum Install {
    Binary(PathBuf),
    Flatpak(PathBuf),
}
impl Install {
    pub(crate) fn program(&self) -> &Path {
        match self {
            Install::Binary(path) | Install::Flatpak(path) => path,
        }
    }
    /// Arguments that come before Blender's own (`flatpak run org.blender.Blender`).
    pub(crate) fn prefix(&self) -> &'static [&'static str] {
        match self {
            Install::Binary(_) => &[],
            Install::Flatpak(_) => &["run", "org.blender.Blender"],
        }
    }
}
impl ToolProvider for BlenderProvider {
    fn definitions(&self, mode: &str) -> Vec<Value> {
        if mode == "plan" {
            return vec![];
        }
        vec![
            json!({"type":"function","function":{"name":"blender_run","description":"Run a workspace Python script with Blender's bpy API in a new background Blender process. Optionally open a workspace .blend file first. This can modify files and is governed by the session's permissions. It does not control an existing Blender window. Check exit status and output files. Install Blender from https://www.blender.org/download/ if missing.","parameters":{"type":"object","properties":{"script":{"type":"string"},"blend":{"type":"string"},"timeoutMs":{"type":"integer","minimum":1,"maximum":600000}},"required":["script"],"additionalProperties":false}}}),
        ]
    }
    fn is_mutating(&self, _: &str, _: &Value) -> bool {
        true
    }
    fn execute<'a>(
        &'a self,
        cwd: &'a Path,
        mode: &'a str,
        name: &'a str,
        input: &'a Value,
        _: &'a str,
        cancel: CancellationToken,
    ) -> ToolFuture<'a> {
        Box::pin(async move {
            ensure!(
                mode != "plan" && name == "blender_run",
                "Blender execution is unavailable in planning mode"
            );
            let obj = input.as_object().context("expected an object")?;
            ensure!(
                obj.keys()
                    .all(|key| ["script", "blend", "timeoutMs"].contains(&key.as_str())),
                "unknown field"
            );
            let script = workspace_file(
                cwd,
                obj.get("script")
                    .and_then(Value::as_str)
                    .context("script is required")?,
                "py",
            )?;
            let blend = obj
                .get("blend")
                .map(|value| {
                    workspace_file(cwd, value.as_str().context("blend must be text")?, "blend")
                })
                .transpose()?;
            let timeout = match obj.get("timeoutMs") {
                None => 600000,
                Some(value) => value.as_u64().context("timeoutMs must be an integer")?,
            };
            ensure!((1..=600000).contains(&timeout), "invalid timeout");
            let install = locate()
                .context("Blender not found; install it from https://www.blender.org/download/")?;
            let mut args = vec![quote(install.program())?];
            args.extend(install.prefix().iter().map(|part| (*part).to_owned()));
            args.extend(["--background".to_owned(), "--factory-startup".to_owned()]);
            if let Some(blend) = blend {
                args.push(quote(&blend)?);
            }
            args.extend([
                "--python-exit-code".into(),
                "1".into(),
                "--python".into(),
                quote(&script)?,
            ]);
            let command = if cfg!(windows) {
                format!("& {}", args.join(" "))
            } else {
                args.join(" ")
            };
            match crate::tools::shell(cwd, &json!({"command":command,"timeoutMs":timeout}), cancel)
                .await
            {
                Ok(mut result) => {
                    if result["success"] != true {
                        result["isError"] = json!(true);
                        result["executionMayHaveChangedFiles"] = json!(true);
                    }
                    Ok(result)
                }
                Err(_) => Err(BlenderUncertain.into()),
            }
        })
    }
}
#[derive(Debug)]
pub struct BlenderUncertain;
impl std::fmt::Display for BlenderUncertain {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Blender may have changed files; inspect the workspace before continuing. Do not automatically retry.")
    }
}
impl std::error::Error for BlenderUncertain {}

pub(crate) fn workspace_file(cwd: &Path, raw: &str, extension: &str) -> Result<PathBuf> {
    let path = Path::new(raw);
    ensure!(
        !raw.is_empty()
            && !raw.contains('\0')
            && !path.is_absolute()
            && path.components().all(|c| matches!(c, Component::Normal(_))),
        "path must be relative to the workspace"
    );
    let root = cwd.canonicalize().context("workspace unavailable")?;
    let file = root
        .join(path)
        .canonicalize()
        .context("workspace file unavailable")?;
    ensure!(
        file.starts_with(&root)
            && file.is_file()
            && file
                .extension()
                .and_then(|value| value.to_str())
                .is_some_and(|value| value.eq_ignore_ascii_case(extension)),
        "file must be inside the workspace and have the expected extension"
    );
    Ok(file)
}
pub(crate) fn quote(path: &Path) -> Result<String> {
    let value = path.to_str().context("path must be UTF-8")?;
    ensure!(
        !value.chars().any(char::is_control),
        "path contains control characters"
    );
    if cfg!(windows) {
        Ok(format!("'{}'", value.replace('\'', "''")))
    } else {
        Ok(format!("'{}'", value.replace('\'', "'\\''")))
    }
}
pub(crate) fn is_executable(path: &Path) -> bool {
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    if !meta.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}
/// Directories whose names start with `prefix`, newest name first (so Blender 5.2 beats 4.2).
pub(crate) fn versioned_dirs(base: &Path, prefix: &str) -> Vec<PathBuf> {
    let mut found: Vec<PathBuf> = std::fs::read_dir(base)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|entry| entry.file_name().to_string_lossy().starts_with(prefix))
        .map(|entry| entry.path())
        .collect();
    found.sort();
    found.reverse();
    found
}
/// Every place a Blender executable is commonly found, in priority order. The Microsoft
/// Store build is deliberately absent: its launcher discards stdout/stderr.
fn candidates() -> Vec<PathBuf> {
    let name = if cfg!(windows) { "blender.exe" } else { "blender" };
    let mut found: Vec<PathBuf> = Vec::new();
    if let Some(explicit) = std::env::var_os("BLENDER_PATH").map(PathBuf::from).filter(|p| p.is_absolute()) {
        found.push(explicit);
    }
    if let Some(path) = std::env::var_os("PATH") {
        found.extend(std::env::split_paths(&path).filter(|p| p.is_absolute()).map(|dir| dir.join(name)));
    }
    let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .map(PathBuf::from)
        .filter(|path| path.is_absolute());
    if let Some(home) = &home {
        found.push(home.join(".local/bin").join(name));
    }
    #[cfg(target_os = "linux")]
    {
        found.push(PathBuf::from("/snap/bin/blender"));
        found.push(PathBuf::from("/usr/local/bin/blender"));
        for dir in versioned_dirs(Path::new("/opt"), "blender") {
            found.push(dir.join("blender"));
        }
        if let Some(home) = &home {
            for dir in versioned_dirs(home, "blender-") {
                found.push(dir.join("blender"));
            }
            found.push(home.join(".local/share/Steam/steamapps/common/Blender/blender"));
        }
    }
    #[cfg(target_os = "macos")]
    {
        let mut apps = vec![PathBuf::from("/Applications")];
        if let Some(home) = &home {
            apps.push(home.join("Applications"));
        }
        for base in apps {
            for app in versioned_dirs(&base, "Blender") {
                found.push(app.join("Contents/MacOS/Blender"));
            }
        }
    }
    #[cfg(windows)]
    for var in ["ProgramFiles", "ProgramFiles(x86)"] {
        let Some(programs) = std::env::var_os(var).map(PathBuf::from).filter(|p| p.is_absolute()) else {
            continue;
        };
        for dir in versioned_dirs(&programs.join("Blender Foundation"), "Blender") {
            found.push(dir.join(name));
        }
        found.push(programs.join("Steam/steamapps/common/Blender").join(name));
    }
    found
}
fn flatpak_installed() -> bool {
    #[cfg(target_os = "linux")]
    {
        let user = std::env::var_os("HOME")
            .map(PathBuf::from)
            .filter(|p| p.is_absolute())
            .map(|home| home.join(".local/share/flatpak/app/org.blender.Blender"));
        return user.is_some_and(|p| p.is_dir()) || Path::new("/var/lib/flatpak/app/org.blender.Blender").is_dir();
    }
    #[cfg(not(target_os = "linux"))]
    false
}
fn first_executable(paths: impl IntoIterator<Item = PathBuf>) -> Option<PathBuf> {
    paths.into_iter().find(|path| is_executable(path))
}
pub(crate) fn locate() -> Option<Install> {
    if let Some(path) = first_executable(candidates()) {
        return Some(Install::Binary(path));
    }
    if flatpak_installed() {
        let launcher = std::env::var_os("PATH")
            .map(|value| std::env::split_paths(&value).filter(|p| p.is_absolute()).collect::<Vec<_>>())
            .unwrap_or_default()
            .into_iter()
            .chain([PathBuf::from("/usr/bin")])
            .map(|dir| dir.join("flatpak"))
            .find(|path| is_executable(path));
        return launcher.map(Install::Flatpak);
    }
    None
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn workspace_paths_are_bounded_and_quoted() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("test's script.py"), "print(1)").unwrap();
        let path = workspace_file(dir.path(), "test's script.py", "py").unwrap();
        assert!(quote(&path).unwrap().starts_with('\''));
        for bad in [
            "../outside.py",
            "/tmp/outside.py",
            ".",
            "test's script.blend",
        ] {
            assert!(workspace_file(dir.path(), bad, "py").is_err());
        }
    }
    #[cfg(unix)]
    #[test]
    fn the_first_executable_candidate_wins_and_plain_files_are_skipped() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let plain = dir.path().join("plain");
        let good = dir.path().join("good");
        let later = dir.path().join("later");
        for path in [&plain, &good, &later] {
            std::fs::write(path, b"#!/bin/sh\n").unwrap();
        }
        for path in [&good, &later] {
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        assert_eq!(
            first_executable([dir.path().join("missing"), plain, good.clone(), later]),
            Some(good)
        );
        assert_eq!(first_executable(Vec::new()), None);
    }
    #[test]
    fn versioned_directories_sort_newest_first() {
        let dir = tempfile::tempdir().unwrap();
        for name in ["blender-4.2.0", "blender-5.2.2", "other"] {
            std::fs::create_dir(dir.path().join(name)).unwrap();
        }
        let found = versioned_dirs(dir.path(), "blender-");
        assert_eq!(found.len(), 2);
        assert!(found[0].ends_with("blender-5.2.2"));
    }
    #[test]
    fn planning_cannot_execute_python() {
        assert!(BlenderProvider.definitions("plan").is_empty());
        assert!(BlenderProvider.is_mutating("blender_run", &json!({})));
    }

    #[tokio::test]
    #[ignore = "requires a real Blender installation; uses an isolated temporary project"]
    async fn real_blender_creates_a_scene_in_an_isolated_workspace() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("build.py"), "import bpy\nbpy.ops.mesh.primitive_cube_add()\nbpy.ops.wm.save_as_mainfile(filepath='generated.blend')\n").unwrap();
        let result = BlenderProvider
            .execute(
                dir.path(),
                "full",
                "blender_run",
                &json!({"script":"build.py","timeoutMs":60000}),
                "smoke",
                CancellationToken::new(),
            )
            .await
            .unwrap();
        assert_eq!(result["success"], true, "{result}");
        assert!(dir.path().join("generated.blend").is_file());
    }
}
