use crate::environment::ChildEnvironment;
use anyhow::{bail, Context, Result};
use std::ffi::OsStr;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

pub struct Runtime {
    pub node: PathBuf,
    pub worker: PathBuf,
    pub development: bool,
}

impl Runtime {
    pub fn discover() -> Result<Self> {
        let executable =
            std::env::current_exe().context("could not locate the native executable")?;
        let explicit = std::env::var_os("TREX_BROWSER_RUNTIME");
        resolve(
            &executable,
            explicit.as_deref(),
            cfg!(debug_assertions)
                .then(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("worker/worker.mjs")),
            std::env::var_os("PATH").as_deref(),
        )
    }

    pub fn command(&self, environment: &ChildEnvironment) -> Command {
        let mut command = Command::new(&self.node);
        command.env_clear().envs(environment);
        command
    }

    pub fn verify_node(&self, environment: &ChildEnvironment) -> Result<()> {
        let mut command = self.command(environment);
        command
            .arg("--version")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW);
        }
        let mut child = command
            .spawn()
            .context("could not start the selected Node runtime")?;
        let deadline = Instant::now() + Duration::from_secs(5);
        let stdout = child
            .stdout
            .take()
            .context("the Node version probe has no output stream")?;
        let (sender, receiver) = mpsc::sync_channel(1);
        if let Err(error) = std::thread::Builder::new()
            .name("node-version".into())
            .spawn(move || {
                let mut bytes = Vec::new();
                let result = stdout.take(128).read_to_end(&mut bytes).map(|_| bytes);
                let _ = sender.send(result);
            })
        {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error).context("could not start the bounded Node version reader");
        }
        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break status,
                Ok(None) if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(25))
                }
                result => {
                    // Only the process we created is ever terminated.
                    let _ = child.kill();
                    let _ = child.wait();
                    match result {
                        Err(error) => {
                            return Err(error).context("could not wait for the Node version probe")
                        }
                        _ => bail!("the Node version probe exceeded its five-second limit"),
                    }
                }
            }
        };
        let bytes = receiver
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .context("the Node version output exceeded its five-second limit")?
            .context("could not read the Node version")?;
        if !status.success() || !supported_version(&bytes, self.development) {
            bail!("Trex Browser requires packaged Node.js 24.22.1 LTS; debug-only development discovery requires major version 24");
        }
        Ok(())
    }
}

fn supported_version(bytes: &[u8], development: bool) -> bool {
    let Ok(value) = std::str::from_utf8(bytes) else {
        return false;
    };
    let Some(version) = value.trim().strip_prefix('v') else {
        return false;
    };
    let parts: Vec<_> = version.split('.').collect();
    (development || version == "24.22.1")
        && parts.len() == 3
        && parts[0] == "24"
        && parts
            .iter()
            .all(|part| !part.is_empty() && part.bytes().all(|c| c.is_ascii_digit()))
}

fn resolve(
    executable: &Path,
    explicit: Option<&OsStr>,
    source: Option<PathBuf>,
    path: Option<&OsStr>,
) -> Result<Runtime> {
    if let Some(directory) = explicit {
        if directory.is_empty() {
            bail!("TREX_BROWSER_RUNTIME must name a runtime directory");
        }
        let directory =
            std::path::absolute(directory).context("could not resolve TREX_BROWSER_RUNTIME")?;
        let worker = directory.join("worker.mjs");
        require_file(
            &worker,
            "the explicit runtime worker.mjs is missing or is not a regular file",
        )?;
        let bundled_node = directory.join(node_name());
        let (node, development) = match fs::symlink_metadata(&bundled_node) {
            Ok(_) => {
                require_file(
                    &bundled_node,
                    "the explicit runtime Node executable is not a regular file",
                )?;
                (bundled_node, false)
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound && cfg!(debug_assertions) => (development_node(path)?, true),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => bail!("TREX_BROWSER_RUNTIME must contain node.exe and worker.mjs in release builds; PATH discovery is disabled"),
            Err(error) => return Err(error).context("could not inspect the explicit Node runtime"),
        };
        return Ok(Runtime {
            node,
            worker,
            development,
        });
    }
    let package = executable
        .parent()
        .context("the native executable has no parent directory")?
        .join("trex-browser-runtime");
    #[cfg(target_os = "linux")]
    let package = if executable.parent() == Some(Path::new("/usr/bin")) && !package.exists() {
        PathBuf::from("/usr/lib/trex/trex-browser-runtime")
    } else {
        package
    };
    match fs::symlink_metadata(&package) {
        Ok(metadata) => {
            if !metadata.is_dir() || metadata.file_type().is_symlink() {
                bail!("the packaged runtime must be a regular directory");
            }
            let node = package.join(node_name());
            let worker = package.join("worker.mjs");
            require_file(
                &node,
                "the packaged node.exe is missing or is not a regular file",
            )?;
            require_file(
                &worker,
                "the packaged worker.mjs is missing or is not a regular file",
            )?;
            Ok(Runtime {
                node,
                worker,
                development: false,
            })
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            if let Some(worker) = source.filter(|_| cfg!(debug_assertions)) {
                require_file(&worker, "the development worker source is missing; build the runtime or set TREX_BROWSER_RUNTIME")?;
                Ok(Runtime {
                    node: development_node(path)?,
                    worker,
                    development: true,
                })
            } else {
                bail!("the packaged trex-browser-runtime directory is missing; set TREX_BROWSER_RUNTIME explicitly for development")
            }
        }
        Err(error) => Err(error).context("could not inspect the packaged runtime"),
    }
}

fn require_file(path: &Path, message: &'static str) -> Result<()> {
    let metadata = fs::symlink_metadata(path).context(message)?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        bail!("{message}");
    }
    Ok(())
}

fn development_node(path: Option<&OsStr>) -> Result<PathBuf> {
    if let Some(path) = path {
        for directory in std::env::split_paths(path).filter(|entry| entry.is_absolute()) {
            let candidate = directory.join(node_name());
            if require_file(&candidate, "not a regular Node executable").is_ok() {
                return Ok(candidate);
            }
        }
    }
    bail!("development runtime requires node.exe in an absolute PATH entry, or node.exe inside TREX_BROWSER_RUNTIME")
}

fn node_name() -> &'static str {
    if cfg!(windows) {
        "node.exe"
    } else {
        "node"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn node_major_is_pinned() {
        assert!(supported_version(b"v24.22.1\r\n", false));
        assert!(supported_version(b"v24.19.0\r\n", true));
        assert!(!supported_version(b"v24.19.0\r\n", false));
        for version in [
            b"v22.1.0".as_slice(),
            b"v25.0.0",
            b"v24.0.0-nightly",
            b"v24.1",
            b"v24.1.0\nextra",
            b"24.0.0",
        ] {
            assert!(!supported_version(version, false));
            assert!(!supported_version(version, true));
        }
    }

    #[test]
    fn production_never_falls_back_to_path() {
        let result = resolve(
            Path::new("C:/nonexistent-trex-browser-native-test/trex-browser.exe"),
            None,
            None,
            Some(OsStr::new("C:/Program Files/nodejs")),
        );
        assert!(result.is_err());
    }
}
