//! Execute workspace scripts in a new background Blender process.
use crate::tools::{ToolFuture, ToolProvider};
use anyhow::{ensure, Context, Result};
use serde_json::{json, Value};
use std::path::{Component, Path, PathBuf};
use tokio_util::sync::CancellationToken;

pub struct BlenderProvider;
pub(crate) fn available() -> bool {
    find_blender().is_some()
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
            let executable = find_blender()
                .context("Blender not found; install it from https://www.blender.org/download/")?;
            let mut args = vec![
                quote(&executable)?,
                "--background".to_owned(),
                "--factory-startup".to_owned(),
            ];
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

fn workspace_file(cwd: &Path, raw: &str, extension: &str) -> Result<PathBuf> {
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
fn quote(path: &Path) -> Result<String> {
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
fn find_blender() -> Option<PathBuf> {
    let name = if cfg!(windows) {
        "blender.exe"
    } else {
        "blender"
    };
    let mut directories: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|value| {
            std::env::split_paths(&value)
                .filter(|path| path.is_absolute())
                .collect()
        })
        .unwrap_or_default();
    if let Some(home) = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
    {
        directories.push(home.join(".local/bin"));
    }
    #[cfg(windows)]
    if let Some(base) = std::env::var_os("ProgramFiles")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
    {
        if let Ok(entries) = std::fs::read_dir(base.join("Blender Foundation")) {
            let mut installed: Vec<_> = entries
                .flatten()
                .filter(|entry| entry.file_name().to_string_lossy().starts_with("Blender "))
                .map(|entry| entry.path())
                .collect();
            installed.sort();
            installed.reverse();
            directories.extend(installed);
        }
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
