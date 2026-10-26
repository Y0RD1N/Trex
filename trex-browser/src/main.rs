//! The worker owns the CLI and daemon. This executable establishes its trust
//! boundary, chooses a runtime, and forwards the original command and streams.

#[cfg(windows)]
mod detached;
mod environment;
#[cfg(windows)]
mod guard;
#[cfg(target_os = "linux")]
mod linux;
mod runtime;
#[cfg(windows)]
mod security;
#[cfg(windows)]
mod supervisor;

use anyhow::Result;
use std::ffi::OsString;

fn main() {
    let args: Vec<OsString> = std::env::args_os().skip(1).collect();
    if args.len() == 1 && (args[0] == "--version" || args[0] == "-V") {
        println!("trex-browser {}", env!("CARGO_PKG_VERSION"));
        return;
    }
    match run(args) {
        Ok(code) => std::process::exit(code),
        Err(error) => {
            // Never print the command line or inherited environment here.
            eprintln!("trex-browser: {error:#}");
            std::process::exit(1);
        }
    }
}

#[cfg(windows)]
fn run(args: Vec<OsString>) -> Result<i32> {
    if args.first().is_some_and(|arg| arg == "__guard-browser") {
        return guard::run(&args[1..]);
    }
    if args.first().is_some_and(|arg| arg == "__upload-snapshot") {
        return upload_snapshot_command(&args[1..]);
    }
    let spawn_broker = args.first().is_some_and(|arg| arg == "__spawn-broker");
    if spawn_broker && args.len() != 1 {
        anyhow::bail!("__spawn-broker accepts no arguments");
    }
    // These worker commands never access private state. In particular installer
    // probes must not create or traverse a user's profile directory.
    let home = if read_only_command(&args) {
        None
    } else {
        Some(security::PrivateHome::prepare()?)
    };
    let runtime = runtime::Runtime::discover()?;
    let environment =
        environment::child_environment(&runtime, home.as_ref().map(|home| home.path()))?;
    runtime.verify_node(&environment)?;
    // Hold the checked root and its ancestors against rename/replacement until
    // the CLI worker exits. The independently detached daemon owns its lifetime.
    if spawn_broker {
        supervisor::spawn_broker(&runtime, &environment)?;
        Ok(0)
    } else {
        supervisor::run(&runtime, &environment, &args)
    }
}

#[cfg(windows)]
fn upload_snapshot_command(args: &[OsString]) -> Result<i32> {
    use std::io::Write;
    let (cwd, path) = upload_snapshot_args(args)?;
    // Never print supplied paths or OS error chains from this data boundary.
    let bytes = security::upload_snapshot(&cwd, &path)
        .map_err(|_| anyhow::anyhow!("upload snapshot rejected: expected a regular workspace file of at most 64 MiB with no links or concurrent writers"))?;
    std::io::stdout()
        .lock()
        .write_all(&bytes)
        .map_err(|_| anyhow::anyhow!("could not write upload snapshot"))?;
    Ok(0)
}

fn upload_snapshot_args(args: &[OsString]) -> Result<(std::path::PathBuf, std::path::PathBuf)> {
    if args.len() != 4 || args[0] != "--cwd" || args[2] != "--path" {
        anyhow::bail!("upload snapshot requires exactly --cwd ABS --path ABS");
    }
    Ok((args[1].clone().into(), args[3].clone().into()))
}

fn read_only_command(args: &[OsString]) -> bool {
    args.first()
        .is_some_and(|arg| arg == "doctor" || arg == "tools" || arg == "version")
        || args.iter().any(|arg| arg == "--version")
}

#[cfg(target_os = "linux")]
fn run(args: Vec<OsString>) -> Result<i32> {
    linux::run(args)
}

#[cfg(not(any(windows, target_os = "linux")))]
fn run(_args: Vec<OsString>) -> Result<i32> {
    anyhow::bail!("this native launcher supports Windows and Linux")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn installer_probes_do_not_initialize_private_state() {
        for args in [
            vec!["doctor", "--json"],
            vec!["tools", "--json"],
            vec!["--version"],
            vec!["version"],
        ] {
            assert!(read_only_command(
                &args.into_iter().map(OsString::from).collect::<Vec<_>>()
            ));
        }
        for command in [
            "__spawn-broker",
            "__guard-browser",
            "__upload-snapshot",
            "daemon",
            "profiles",
            "prepare",
            "call",
            "mcp",
            "stop",
        ] {
            assert!(!read_only_command(&[command.into()]));
        }
    }

    #[test]
    fn upload_helper_accepts_only_its_fixed_argument_contract() {
        let args = ["--cwd", "C:/workspace", "--path", "C:/workspace/file"].map(OsString::from);
        assert!(upload_snapshot_args(&args).is_ok());
        for args in [
            vec!["--cwd", "C:/workspace"],
            vec!["--path", "C:/workspace/file", "--cwd", "C:/workspace"],
            vec![
                "--cwd",
                "C:/workspace",
                "--path",
                "C:/workspace/file",
                "extra",
            ],
        ] {
            assert!(upload_snapshot_args(
                &args.into_iter().map(OsString::from).collect::<Vec<_>>()
            )
            .is_err());
        }
    }
}
