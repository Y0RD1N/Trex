//! Linux trust boundary: private state, pinned runtime, descriptor-based uploads
//! and pidfd supervision. Never search PATH for an installed runtime.
use anyhow::{bail, ensure, Context, Result};
use std::ffi::{CString, OsString};
use std::fs::{self, File};
use std::io::{BufRead, Read, Write};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{DirBuilderExt, MetadataExt};
use std::os::unix::process::CommandExt;
use std::path::{Component, Path, PathBuf};
use std::process::Stdio;
use std::sync::mpsc;
use std::time::{Duration, Instant};

const MAX_UPLOAD: u64 = 64 * 1024 * 1024;
const INHERITED: &[&str] = &[
    "HOME",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_CACHE_HOME",
    "XDG_STATE_HOME",
    "XDG_RUNTIME_DIR",
    "DBUS_SESSION_BUS_ADDRESS",
    "DISPLAY",
    "WAYLAND_DISPLAY",
    "XAUTHORITY",
    "XDG_SESSION_TYPE",
    "XDG_CURRENT_DESKTOP",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TZ",
    "TMPDIR",
    "TERM",
    "COLORTERM",
    "NO_COLOR",
    "FORCE_COLOR",
    "TREX_BROWSER_HEADLESS",
];

fn checked_path(path: &Path, private: bool) -> Result<()> {
    ensure!(path.is_absolute(), "expected an absolute local path");
    ensure!(
        !path
            .components()
            .any(|p| matches!(p, Component::ParentDir | Component::CurDir)),
        "ambiguous path rejected"
    );
    for part in path.ancestors() {
        let meta = fs::symlink_metadata(part).context("could not inspect a trusted path")?;
        ensure!(
            !meta.file_type().is_symlink(),
            "linked paths are not supported"
        );
        ensure!(
            meta.is_dir() || (meta.is_file() && meta.nlink() == 1),
            "expected an ordinary path"
        );
        ensure!(
            meta.uid() == 0 || meta.uid() == unsafe { libc::geteuid() },
            "path owner is not trusted"
        );
        let root_sticky = meta.is_dir() && meta.uid() == 0 && meta.mode() & 0o1000 != 0;
        ensure!(
            meta.mode() & 0o022 == 0 || root_sticky,
            "shared writable paths are not trusted"
        );
    }
    if private {
        let meta = fs::symlink_metadata(path)?;
        ensure!(
            meta.is_dir() && meta.uid() == unsafe { libc::geteuid() } && meta.mode() & 0o077 == 0,
            "browser state requires an existing private user-owned directory (0700)"
        );
    }
    Ok(())
}

fn private_home() -> Result<PathBuf> {
    let home = match std::env::var_os("TREX_BROWSER_HOME") {
        Some(value) => PathBuf::from(value),
        None => {
            let base = std::env::var_os("XDG_STATE_HOME")
                .map(PathBuf::from)
                .filter(|p| p.is_absolute())
                .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/state")))
                .context("HOME or an absolute XDG_STATE_HOME is required")?;
            base.join("trex-browser")
        }
    };
    ensure!(
        home.is_absolute() && home.parent().is_some(),
        "TREX_BROWSER_HOME must be an absolute directory"
    );
    ensure!(
        !home
            .components()
            .any(|p| matches!(p, Component::ParentDir | Component::CurDir)),
        "ambiguous private home rejected"
    );
    let existing = home
        .ancestors()
        .find(|p| p.exists())
        .context("private home has no trusted ancestor")?;
    checked_path(existing, false)?;
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(&home)
        .context("could not create private browser state")?;
    checked_path(&home, true)?;
    Ok(home)
}

fn validate_runtime(runtime: &crate::runtime::Runtime) -> Result<()> {
    checked_path(&runtime.node, false)?;
    checked_path(&runtime.worker, false)?;
    ensure!(
        fs::metadata(&runtime.node)?.mode() & 0o111 != 0,
        "the private Node binary is not executable"
    );
    let root = runtime
        .worker
        .parent()
        .context("runtime directory missing")?;
    let mut pending = vec![(root.to_path_buf(), 0)];
    let mut count = 0;
    while let Some((directory, depth)) = pending.pop() {
        ensure!(depth <= 64, "runtime directory nesting exceeds its limit");
        for item in fs::read_dir(directory)? {
            count += 1;
            ensure!(count <= 20000, "runtime directory exceeds its file limit");
            let path = item?.path();
            checked_path(&path, false)?;
            if fs::symlink_metadata(&path)?.is_dir() {
                pending.push((path, depth + 1));
            }
        }
    }
    Ok(())
}

fn environment(
    runtime: &crate::runtime::Runtime,
    home: Option<&Path>,
) -> Result<crate::environment::ChildEnvironment> {
    let mut values = inherited_environment(std::env::vars_os());
    let directory = runtime
        .node
        .parent()
        .context("private Node directory missing")?;
    values.insert(
        "PATH".into(),
        std::env::join_paths([directory, Path::new("/usr/bin"), Path::new("/bin")])?,
    );
    values.insert(
        "TREX_BROWSER_RUNTIME".into(),
        runtime
            .worker
            .parent()
            .context("runtime directory missing")?
            .as_os_str()
            .to_owned(),
    );
    values.insert(
        "PLAYWRIGHT_BROWSERS_PATH".into(),
        directory.join("ffmpeg").into_os_string(),
    );
    values.insert(
        "TREX_BROWSER_LAUNCHER".into(),
        std::env::current_exe()?.into_os_string(),
    );
    if let Some(home) = home {
        values.insert("TREX_BROWSER_HOME".into(), home.as_os_str().to_owned());
        values.insert("TREX_BROWSER_NATIVE_VERIFIED".into(), "1".into());
    }
    Ok(values)
}

fn inherited_environment(
    values: impl IntoIterator<Item = (OsString, OsString)>,
) -> crate::environment::ChildEnvironment {
    values
        .into_iter()
        .filter(|(name, _)| name.to_str().is_some_and(|name| INHERITED.contains(&name)))
        .collect()
}

pub fn run(args: Vec<OsString>) -> Result<i32> {
    if args.first().is_some_and(|a| a == "__upload-snapshot") {
        let (cwd, path) = crate::upload_snapshot_args(&args[1..])?;
        let bytes = upload_snapshot(&cwd, &path).map_err(|_| anyhow::anyhow!("upload rejected: expected one ordinary bounded workspace file without links or concurrent changes"))?;
        std::io::stdout().lock().write_all(&bytes)?;
        return Ok(0);
    }
    if args.first().is_some_and(|a| a == "__guard-browser") {
        return guard(&args[1..]);
    }
    let daemon = args.first().is_some_and(|a| a == "__spawn-broker");
    ensure!(
        !daemon || args.len() == 1,
        "__spawn-broker accepts no arguments"
    );
    let home = if crate::read_only_command(&args) {
        None
    } else {
        Some(private_home()?)
    };
    let runtime = crate::runtime::Runtime::discover()?;
    validate_runtime(&runtime)?;
    let env = environment(&runtime, home.as_deref())?;
    runtime.verify_node(&env)?;
    let mut command = runtime.command(&env);
    command.arg(&runtime.worker);
    if daemon {
        command
            .arg("daemon")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        // A separate session survives termination of the agent's process group.
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        command
            .spawn()
            .context("could not start the independent browser broker")?;
        Ok(0)
    } else {
        command
            .args(args)
            .stdin(Stdio::inherit())
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit());
        let parent = unsafe { libc::getpid() };
        unsafe {
            command.pre_exec(move || {
                if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM) < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                if libc::getppid() != parent {
                    return Err(std::io::Error::from_raw_os_error(libc::ECHILD));
                }
                Ok(())
            });
        }
        Ok(command
            .status()
            .context("could not start the private browser worker")?
            .code()
            .unwrap_or(1))
    }
}

fn open_at(parent: i32, name: &std::ffi::OsStr, directory: bool) -> Result<OwnedFd> {
    let name = CString::new(name.as_bytes())?;
    let flags = libc::O_RDONLY
        | libc::O_NOFOLLOW
        | libc::O_CLOEXEC
        | libc::O_NONBLOCK
        | if directory { libc::O_DIRECTORY } else { 0 };
    let fd = unsafe { libc::openat(parent, name.as_ptr(), flags) };
    ensure!(fd >= 0, "could not open an ordinary workspace path");
    Ok(unsafe { OwnedFd::from_raw_fd(fd) })
}

fn upload_snapshot(cwd: &Path, path: &Path) -> Result<Vec<u8>> {
    ensure!(
        cwd.is_absolute() && path.is_absolute(),
        "upload paths must be absolute"
    );
    let relative = path.strip_prefix(cwd)?;
    let parts: Vec<_> = relative.components().collect();
    ensure!(
        !parts.is_empty() && parts.iter().all(|p| matches!(p, Component::Normal(_))),
        "upload must be beneath its workspace"
    );
    // Every component is resolved relative to a retained directory descriptor,
    // so a pathname swap cannot redirect a later read through a symlink.
    let mut fd = open_at(libc::AT_FDCWD, std::ffi::OsStr::new("/"), true)?;
    for part in cwd.components() {
        if let Component::Normal(name) = part {
            fd = open_at(fd.as_raw_fd(), name, true)?;
        } else {
            ensure!(
                matches!(part, Component::RootDir),
                "ambiguous workspace path"
            );
        }
    }
    for (index, part) in parts.iter().enumerate() {
        let Component::Normal(name) = part else {
            unreachable!()
        };
        fd = open_at(fd.as_raw_fd(), name, index + 1 != parts.len())?;
    }
    let mut file = File::from(fd);
    let before = file.metadata()?;
    ensure!(
        before.is_file() && before.nlink() == 1 && before.len() <= MAX_UPLOAD,
        "upload is not a bounded single-link file"
    );
    let mut bytes = Vec::new();
    (&mut file).take(MAX_UPLOAD + 1).read_to_end(&mut bytes)?;
    let after = file.metadata()?;
    ensure!(
        bytes.len() as u64 <= MAX_UPLOAD
            && before.len() == after.len()
            && bytes.len() as u64 == after.len()
            && after.nlink() == 1
            && before.mtime() == after.mtime()
            && before.mtime_nsec() == after.mtime_nsec()
            && before.ctime() == after.ctime()
            && before.ctime_nsec() == after.ctime_nsec(),
        "upload changed while being copied"
    );
    Ok(bytes)
}

fn pidfd(pid: i32) -> Result<OwnedFd> {
    let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, pid, 0) } as i32;
    ensure!(fd >= 0, "GUARD_STAGE=PIDFD_OPEN");
    Ok(unsafe { OwnedFd::from_raw_fd(fd) })
}
fn exited(fd: &OwnedFd, milliseconds: i32) -> Result<bool> {
    let mut item = libc::pollfd {
        fd: fd.as_raw_fd(),
        events: libc::POLLIN,
        revents: 0,
    };
    let result = unsafe { libc::poll(&mut item, 1, milliseconds) };
    if result < 0 && std::io::Error::last_os_error().raw_os_error() == Some(libc::EINTR) {
        return Ok(false);
    }
    ensure!(result >= 0, "GUARD_STAGE=PROCESS_WAIT");
    Ok(result > 0)
}
fn stop_owned(fd: &OwnedFd) -> Result<()> {
    for (signal, timeout) in [(libc::SIGTERM, 2000), (libc::SIGKILL, 3000)] {
        if exited(fd, 0)? {
            return Ok(());
        }
        let result = unsafe {
            libc::syscall(
                libc::SYS_pidfd_send_signal,
                fd.as_raw_fd(),
                signal,
                std::ptr::null::<libc::siginfo_t>(),
                0,
            )
        };
        ensure!(
            result == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH),
            "GUARD_STAGE=PROCESS_STOP"
        );
        if exited(fd, timeout)? {
            return Ok(());
        }
    }
    bail!("GUARD_STAGE=PROCESS_STOP_TIMEOUT")
}
fn owned_process(pid: i32, parent: i32, executable: &Path) -> Result<OwnedFd> {
    ensure!(
        pid > 1 && parent > 1 && pid != parent,
        "GUARD_STAGE=PROCESS_ID"
    );
    checked_path(executable, false).context("GUARD_STAGE=EXECUTABLE_TRUST")?;
    let handle = pidfd(pid)?;
    let proc = PathBuf::from(format!("/proc/{pid}"));
    ensure!(
        fs::metadata(&proc)?.uid() == unsafe { libc::geteuid() },
        "GUARD_STAGE=PROCESS_OWNER"
    );
    let stat = fs::read_to_string(proc.join("stat"))?;
    let fields = stat
        .rsplit_once(')')
        .context("GUARD_STAGE=PROCESS_IDENTITY")?
        .1
        .split_whitespace()
        .collect::<Vec<_>>();
    ensure!(
        fields.get(1).and_then(|p| p.parse::<i32>().ok()) == Some(parent),
        "GUARD_STAGE=PROCESS_PARENT"
    );
    ensure!(
        fs::read_link(proc.join("exe"))? == fs::canonicalize(executable)?,
        "GUARD_STAGE=PROCESS_EXECUTABLE"
    );
    ensure!(!exited(&handle, 0)?, "GUARD_STAGE=PROCESS_EXITED");
    Ok(handle)
}
fn guard(args: &[OsString]) -> Result<i32> {
    ensure!(
        args.len() == 4 && args[0] == "--pid" && args[2] == "--exe",
        "GUARD_STAGE=ARGUMENTS"
    );
    let pid = args[1]
        .to_str()
        .and_then(|p| p.parse().ok())
        .context("GUARD_STAGE=ARGUMENTS")?;
    let parent = unsafe { libc::getppid() };
    let broker = pidfd(parent)?;
    let process = owned_process(pid, parent, Path::new(&args[3]))?;
    let (send, receive) = mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let mut command = String::new();
        let _ = std::io::stdin().lock().take(256).read_line(&mut command);
        let _ = send.send(());
    });
    println!("{{\"ready\":true}}");
    std::io::stdout().flush()?;
    loop {
        if exited(&process, 0)? {
            break;
        }
        if exited(&broker, 100)? || receive.try_recv().is_ok() {
            stop_owned(&process)?;
            break;
        }
    }
    println!("{{\"stopped\":true}}");
    std::io::stdout().flush()?;
    Ok(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn desktop_environment_does_not_forward_credentials_or_node_injection() {
        let values = inherited_environment(
            [
                ("HOME", "/home/test"),
                ("DISPLAY", ":77"),
                ("WAYLAND_DISPLAY", "wayland-test"),
                ("DBUS_SESSION_BUS_ADDRESS", "unix:path=/run/user/1000/bus"),
                ("OPENAI_API_KEY", "synthetic-secret"),
                ("NODE_OPTIONS", "--require bad"),
                ("PATH", "untrusted"),
                ("TREX_BROWSER_NATIVE_VERIFIED", "forged"),
            ]
            .map(|(k, v)| (k.into(), v.into())),
        );
        assert_eq!(values.len(), 4);
        assert_eq!(values.get(std::ffi::OsStr::new("DISPLAY")).unwrap(), ":77");
    }
    use std::os::unix::fs::{symlink, PermissionsExt};
    fn fixture() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "trex-linux-native-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::DirBuilder::new().mode(0o700).create(&dir).unwrap();
        dir
    }
    #[test]
    fn private_paths_reject_shared_permissions_and_links() {
        let root = fixture();
        let sub = root.join("private");
        fs::create_dir(&sub).unwrap();
        fs::set_permissions(&sub, fs::Permissions::from_mode(0o700)).unwrap();
        assert!(checked_path(&sub, true).is_ok());
        fs::set_permissions(&sub, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(checked_path(&sub, true).is_err());
        let link = root.join("linked");
        symlink(&sub, &link).unwrap();
        assert!(checked_path(&link, false).is_err());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn uploads_use_regular_workspace_descriptors() {
        let root = fixture();
        let workspace = root.join("workspace");
        fs::create_dir(&workspace).unwrap();
        let file = workspace.join("file.txt");
        fs::write(&file, b"synthetic upload").unwrap();
        assert_eq!(
            upload_snapshot(&workspace, &file).unwrap(),
            b"synthetic upload"
        );
        let linked = workspace.join("symlink");
        symlink(&file, &linked).unwrap();
        assert!(upload_snapshot(&workspace, &linked).is_err());
        fs::hard_link(&file, workspace.join("hardlink")).unwrap();
        assert!(upload_snapshot(&workspace, &file).is_err());
        assert!(upload_snapshot(&workspace, &root.join("outside")).is_err());
        assert!(upload_snapshot(&workspace, &workspace.join("../file")).is_err());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn pidfd_only_controls_verified_direct_child() {
        let mut child = std::process::Command::new("/usr/bin/sleep")
            .arg("20")
            .spawn()
            .unwrap();
        let pid = child.id() as i32;
        let handle =
            owned_process(pid, unsafe { libc::getpid() }, Path::new("/usr/bin/sleep")).unwrap();
        assert!(owned_process(pid, 1, Path::new("/usr/bin/sleep")).is_err());
        assert!(owned_process(pid, unsafe { libc::getpid() }, Path::new("/usr/bin/true")).is_err());
        stop_owned(&handle).unwrap();
        assert!(!child.wait().unwrap().success());
    }
}
