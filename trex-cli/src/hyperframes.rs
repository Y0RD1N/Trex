//! Explicit HyperFrames commands, using the already-installed CLI.
use crate::tools::{ToolFuture, ToolProvider};
use anyhow::{bail, ensure, Context, Result};
use serde_json::{json, Value};
use std::path::{Component, Path, PathBuf};
use tokio_util::sync::CancellationToken;

pub struct HyperframesProvider;
impl ToolProvider for HyperframesProvider {
    fn definitions(&self, mode: &str) -> Vec<Value> {
        if mode == "plan" {
            return vec![];
        }
        vec![
            json!({"type":"function","function":{"name":"hyperframes_run","description":"Run the installed HyperFrames CLI in the current project: lint, snapshot or render. Never downloads or installs the CLI. Snapshot and render write files and may start a browser; session permissions apply. Output paths must be inside the project. Check success and generated files. Installation guide: https://hyperframes.app/docs/5-packages/cli","parameters":{"type":"object","properties":{"action":{"type":"string","enum":["lint","snapshot","render"]},"output":{"type":"string"},"frames":{"type":"integer","minimum":1,"maximum":20},"timeoutMs":{"type":"integer","minimum":1,"maximum":600000}},"required":["action"],"additionalProperties":false}}}),
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
                mode != "plan" && name == "hyperframes_run",
                "HyperFrames execution is unavailable in planning mode"
            );
            let obj = input.as_object().context("expected an object")?;
            ensure!(
                obj.keys()
                    .all(|key| ["action", "output", "frames", "timeoutMs"].contains(&key.as_str())),
                "unknown field"
            );
            let action = obj
                .get("action")
                .and_then(Value::as_str)
                .context("action is required")?;
            let timeout = match obj.get("timeoutMs") {
                None => 600000,
                Some(value) => value.as_u64().context("timeoutMs must be an integer")?,
            };
            ensure!((1..=600000).contains(&timeout), "invalid timeout");
            let root = cwd.canonicalize().context("workspace unavailable")?;
            let executable = find_cli(&root).context(
                "HyperFrames not found; see https://hyperframes.app/docs/5-packages/cli",
            )?;
            let mut args = vec![quote(&executable)?, action.to_owned()];
            match action {
                "lint" => {
                    ensure!(
                        !obj.contains_key("output") && !obj.contains_key("frames"),
                        "invalid lint options"
                    );
                    args.push("--json".into());
                }
                "snapshot" => {
                    ensure!(
                        !obj.contains_key("output"),
                        "snapshot does not accept output"
                    );
                    let frames = match obj.get("frames") {
                        None => 5,
                        Some(value) => value.as_u64().context("frames must be an integer")?,
                    };
                    ensure!((1..=20).contains(&frames), "invalid frame count");
                    safe_destination(&root, "snapshots")?;
                    args.extend(["--frames".into(), frames.to_string()]);
                }
                "render" => {
                    ensure!(!obj.contains_key("frames"), "render does not accept frames");
                    let output = obj
                        .get("output")
                        .and_then(Value::as_str)
                        .context("render requires an output path")?;
                    let path = safe_destination(&root, output)?;
                    args.extend(["--output".into(), quote(&path)?]);
                }
                _ => bail!("unknown HyperFrames action"),
            }
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
                        result["executionMayHaveChangedFiles"] = json!(true)
                    }
                    Ok(result)
                }
                Err(_) => Err(HyperframesUncertain.into()),
            }
        })
    }
}
#[derive(Debug)]
pub struct HyperframesUncertain;
impl std::fmt::Display for HyperframesUncertain {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("HyperFrames may have changed files; inspect the workspace before continuing. Do not automatically retry.")
    }
}
impl std::error::Error for HyperframesUncertain {}

fn safe_destination(root: &Path, raw: &str) -> Result<PathBuf> {
    let path = Path::new(raw);
    ensure!(
        !raw.is_empty()
            && !raw.contains('\0')
            && !path.is_absolute()
            && path.components().all(|c| matches!(c, Component::Normal(_))),
        "output must be a relative project path"
    );
    let dest = root.join(path);
    let parent = dest
        .parent()
        .context("output parent unavailable")?
        .canonicalize()
        .context("output parent must exist")?;
    ensure!(parent.starts_with(root), "output parent leaves the project");
    match std::fs::symlink_metadata(&dest) {
        Ok(metadata) => {
            ensure!(
                !metadata.file_type().is_symlink(),
                "linked output is not supported"
            );
            ensure!(
                dest.canonicalize()?.starts_with(root),
                "output leaves the project"
            );
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
        Err(error) => return Err(error.into()),
    }
    Ok(dest)
}
fn quote(path: &Path) -> Result<String> {
    let value = path.to_str().context("path must be UTF-8")?;
    ensure!(
        !value.chars().any(char::is_control),
        "path contains control characters"
    );
    if cfg!(windows) {
        ensure!(
            !value.chars().any(|c| "&|<>^%!".contains(c)),
            "Windows command path contains unsupported shell characters"
        );
    }
    if cfg!(windows) {
        Ok(format!("'{}'", value.replace('\'', "''")))
    } else {
        Ok(format!("'{}'", value.replace('\'', "'\\''")))
    }
}
fn find_cli(root: &Path) -> Option<PathBuf> {
    let name = if cfg!(windows) {
        "hyperframes.cmd"
    } else {
        "hyperframes"
    };
    let mut directories = vec![root.join("node_modules/.bin")];
    if let Some(path) = std::env::var_os("PATH") {
        directories.extend(std::env::split_paths(&path).filter(|path| path.is_absolute()));
    }
    if let Some(home) = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
    {
        directories.push(home.join(".local/bin"));
    }
    #[cfg(windows)]
    if let Some(appdata) = std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
    {
        directories.push(appdata.join("npm"));
    }
    directories
        .into_iter()
        .map(|dir| dir.join(name))
        .find(|path| {
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
        })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validates_output_paths_without_overwriting_anything() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        assert!(safe_destination(&root, "movie.mp4").is_ok());
        for path in ["../outside", "/tmp/outside", ".", "missing/output.mp4"] {
            assert!(safe_destination(&root, path).is_err());
        }
    }
    #[test]
    fn planning_does_not_launch_the_cli() {
        assert!(HyperframesProvider.definitions("plan").is_empty());
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn project_local_cli_runs_fixed_commands_without_a_download() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("node_modules/.bin");
        std::fs::create_dir_all(&bin).unwrap();
        let program = bin.join("hyperframes");
        std::fs::write(&program,b"#!/bin/sh\ncase \"$1\" in lint) echo ok;; snapshot) mkdir snapshots; printf '%s' \"$3\" > snapshots/count;; render) printf video > \"$3\";; esac\n").unwrap();
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o700)).unwrap();
        for input in [
            json!({"action":"lint"}),
            json!({"action":"snapshot","frames":3}),
            json!({"action":"render","output":"movie.mp4"}),
        ] {
            let result = HyperframesProvider
                .execute(
                    dir.path(),
                    "full",
                    "hyperframes_run",
                    &input,
                    "test",
                    CancellationToken::new(),
                )
                .await
                .unwrap();
            assert_eq!(result["success"], true, "{result}");
        }
        assert_eq!(
            std::fs::read_to_string(dir.path().join("snapshots/count")).unwrap(),
            "3"
        );
        assert_eq!(
            std::fs::read_to_string(dir.path().join("movie.mp4")).unwrap(),
            "video"
        );
    }

    #[tokio::test]
    #[ignore = "requires an isolated project with the real HyperFrames CLI installed"]
    async fn real_hyperframes_lints_an_isolated_project() {
        let path = std::env::var("TREX_TEST_HYPERFRAMES_ROOT").expect("test project path required");
        let input = json!({"action":"lint","timeoutMs":60000});
        let result = HyperframesProvider
            .execute(
                Path::new(&path),
                "full",
                "hyperframes_run",
                &input,
                "test",
                CancellationToken::new(),
            )
            .await
            .unwrap();
        assert_eq!(result["success"], true, "{result}");
        assert!(result["stdout"]
            .as_str()
            .unwrap()
            .contains("\"errorCount\""));
    }
}
