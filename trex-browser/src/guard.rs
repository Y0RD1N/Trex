//! A broker-owned browser guard. PIDs are discovery hints only: every query,
//! liveness check, and termination uses an already retained process handle.
#![cfg(windows)]

use anyhow::{anyhow, Result};
use std::ffi::OsString;
use std::io::{self, Read, Write};
use std::mem::{size_of, zeroed};
use std::os::windows::ffi::OsStringExt;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::time::{Duration, Instant};
use windows_sys::Win32::Foundation::{
    GetLastError, ERROR_NO_MORE_FILES, FILETIME, HANDLE, INVALID_HANDLE_VALUE, WAIT_OBJECT_0,
    WAIT_TIMEOUT,
};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows_sys::Win32::System::Threading::{
    GetCurrentProcess, GetProcessTimes, OpenProcess, QueryFullProcessImageNameW, TerminateProcess,
    WaitForSingleObject, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_TERMINATE,
};

const SYNCHRONIZE: u32 = 0x0010_0000;
const PROCESS_RIGHTS: u32 = SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE;
const MAX_PROCESSES: usize = 256;
const MAX_DEPTH: usize = 32;
const MAX_SNAPSHOT_ENTRIES: usize = 32_768;
const CAPTURE_BUDGET: Duration = Duration::from_millis(400);
const CAPTURE_INTERVAL: Duration = Duration::from_millis(100);
const STOP_BUDGET: Duration = Duration::from_secs(5);

fn rejected() -> anyhow::Error {
    // Never include PIDs, paths, OS error chains, or command-line payloads.
    anyhow!("browser process guard rejected ownership or could not stop its owned processes")
}

fn stage_failed(stage: &'static str) -> anyhow::Error {
    // Diagnostic stages are compile-time constants, never process payloads.
    anyhow!("browser process guard GUARD_STAGE={stage}")
}

fn normalized_absolute(path: &Path) -> Result<PathBuf> {
    // In particular do not let checked_absolute_path consult the current dir.
    if !path.is_absolute() {
        return Err(rejected());
    }
    crate::security::checked_absolute_path(path).map_err(|_| rejected())
}

fn arguments(args: &[OsString]) -> Result<(u32, PathBuf)> {
    if args.len() != 4 || args[0] != "--pid" || args[2] != "--exe" {
        return Err(rejected());
    }
    let text = args[1].to_str().ok_or_else(rejected)?;
    if text.is_empty() || !text.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(rejected());
    }
    let pid = text.parse::<u32>().map_err(|_| rejected())?;
    if pid == 0 || pid == std::process::id() {
        return Err(rejected());
    }
    // Path verification follows OpenProcess in acquire().
    Ok((pid, PathBuf::from(&args[3])))
}

struct Process {
    pid: u32,
    creation: u64,
    depth: usize,
    handle: OwnedHandle,
}

fn creation_time(handle: HANDLE) -> Result<u64> {
    let mut creation: FILETIME = unsafe { zeroed() };
    let mut exit: FILETIME = unsafe { zeroed() };
    let mut kernel: FILETIME = unsafe { zeroed() };
    let mut user: FILETIME = unsafe { zeroed() };
    if unsafe { GetProcessTimes(handle, &mut creation, &mut exit, &mut kernel, &mut user) } == 0 {
        return Err(rejected());
    }
    Ok((u64::from(creation.dwHighDateTime) << 32) | u64::from(creation.dwLowDateTime))
}

impl Process {
    fn open(pid: u32, depth: usize) -> Result<Self> {
        Self::open_with_rights(pid, depth, PROCESS_RIGHTS)
    }

    fn open_with_rights(pid: u32, depth: usize, rights: u32) -> Result<Self> {
        let raw = unsafe { OpenProcess(rights, 0, pid) };
        if raw.is_null() {
            return Err(rejected());
        }
        let handle = unsafe { OwnedHandle::from_raw_handle(raw) };
        let creation = creation_time(handle.as_raw_handle())?;
        Ok(Self {
            pid,
            creation,
            depth,
            handle,
        })
    }

    fn raw(&self) -> HANDLE {
        self.handle.as_raw_handle()
    }

    fn alive(&self) -> Result<bool> {
        match unsafe { WaitForSingleObject(self.raw(), 0) } {
            WAIT_TIMEOUT => Ok(true),
            WAIT_OBJECT_0 => Ok(false),
            _ => Err(rejected()),
        }
    }

    fn image(&self) -> Result<PathBuf> {
        let mut buffer = vec![0_u16; 32_768];
        let mut length = buffer.len() as u32;
        if unsafe { QueryFullProcessImageNameW(self.raw(), 0, buffer.as_mut_ptr(), &mut length) }
            == 0
            || length == 0
            || length as usize >= buffer.len()
        {
            return Err(rejected());
        }
        normalized_absolute(Path::new(&OsString::from_wide(&buffer[..length as usize])))
    }
}

#[derive(Clone, Copy)]
struct Entry {
    pid: u32,
    parent: u32,
}

fn snapshot(deadline: Instant) -> Result<Vec<Entry>> {
    if Instant::now() >= deadline {
        return Err(stage_failed("SNAPSHOT_START_DEADLINE"));
    }
    let raw = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if raw == INVALID_HANDLE_VALUE || raw.is_null() {
        return Err(stage_failed("SNAPSHOT_CREATE"));
    }
    let handle = unsafe { OwnedHandle::from_raw_handle(raw) };
    let mut entry: PROCESSENTRY32W = unsafe { zeroed() };
    entry.dwSize = size_of::<PROCESSENTRY32W>() as u32;
    let mut entries = Vec::new();
    let mut found = unsafe { Process32FirstW(handle.as_raw_handle(), &mut entry) };
    while found != 0 {
        if entries.len() >= MAX_SNAPSHOT_ENTRIES {
            return Err(stage_failed("SNAPSHOT_ENTRY_LIMIT"));
        }
        if Instant::now() >= deadline {
            return Err(stage_failed("SNAPSHOT_ENUMERATION_DEADLINE"));
        }
        entries.push(Entry {
            pid: entry.th32ProcessID,
            parent: entry.th32ParentProcessID,
        });
        found = unsafe { Process32NextW(handle.as_raw_handle(), &mut entry) };
    }
    if unsafe { GetLastError() } != ERROR_NO_MORE_FILES {
        return Err(stage_failed("SNAPSHOT_ENUMERATION"));
    }
    Ok(entries)
}

struct Guard {
    expected: PathBuf,
    // The root is always element zero, including after it exits.
    processes: Vec<Process>,
    // Retention and creation ordering reject a recycled, stale broker PPID.
    // This handle has no termination right and never enters the kill list.
    _broker: Option<Process>,
}

impl Guard {
    fn acquire(pid: u32, expected: &Path) -> Result<Self> {
        // Retain before doing any ownership or executable checks. This handle
        // is the only authority we will ever use to terminate the root.
        let root = Process::open(pid, 0)?;
        let expected = normalized_absolute(expected)?;
        if !root.alive()? {
            return Err(rejected());
        }
        let entries = snapshot(Instant::now() + CAPTURE_BUDGET)?;
        let parent = entries
            .iter()
            .find(|entry| entry.pid == std::process::id())
            .map(|entry| entry.parent)
            .filter(|parent| *parent != 0)
            .ok_or_else(rejected)?;
        let broker =
            Process::open_with_rights(parent, 0, SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION)?;
        let helper_creation = creation_time(unsafe { GetCurrentProcess() })?;
        if !entries
            .iter()
            .any(|entry| entry.pid == pid && entry.parent == parent)
            || !broker.alive()?
            || broker.creation > root.creation
            || broker.creation > helper_creation
            // PathBuf equality on Windows can use case-insensitive prefix
            // comparison. Compare the normalized native strings instead.
            || root.image()?.as_os_str() != expected.as_os_str()
            || !root.alive()?
            || !broker.alive()?
        {
            return Err(rejected());
        }
        Ok(Self {
            expected,
            processes: vec![root],
            _broker: Some(broker),
        })
    }

    fn capture(&mut self, deadline: Instant) -> Result<()> {
        // Bound simultaneous retained processes rather than the browser's
        // lifetime renderer churn. The root stays pinned even after exit;
        // every previously verified live child remains an independent seed.
        let mut retained = 1;
        while retained < self.processes.len() {
            if self.processes[retained]
                .alive()
                .map_err(|_| stage_failed("CAPTURE_PRUNE_LIVENESS"))?
            {
                retained += 1;
            } else {
                self.processes.remove(retained);
            }
        }
        let entries = snapshot(deadline)?;
        // Iterate the growing retained list: this is a bounded breadth-first
        // walk seeded by the root AND previously verified, still-live parents.
        let mut index = 0;
        while index < self.processes.len() {
            if Instant::now() >= deadline {
                return Err(stage_failed("CAPTURE_PARENT_DEADLINE"));
            }
            if !self.processes[index].alive()? {
                index += 1;
                continue;
            }
            let parent_pid = self.processes[index].pid;
            let depth = self.processes[index].depth + 1;
            for entry in entries.iter().filter(|entry| entry.parent == parent_pid) {
                if self
                    .processes
                    .iter()
                    .any(|process| process.pid == entry.pid)
                {
                    continue;
                }
                if Instant::now() >= deadline {
                    return Err(stage_failed("CAPTURE_CANDIDATE_DEADLINE"));
                }
                // Parent liveness must come from its retained object, never a
                // new lookup of a possibly recycled parent PID.
                if !self.processes[index].alive()? {
                    break;
                }
                let candidate = match Process::open(entry.pid, depth) {
                    Ok(candidate) => candidate,
                    Err(_) => continue,
                };
                if !self.processes[index].alive()?
                    || candidate.creation < self.processes[index].creation
                    || !candidate.alive()?
                    || !candidate
                        .image()
                        .is_ok_and(|image| image.as_os_str() == self.expected.as_os_str())
                {
                    continue;
                }
                // The first snapshot was only a hint. Recheck the candidate's
                // current parent AFTER retaining its handle, closing PID reuse
                // between enumeration and OpenProcess.
                let current = snapshot(deadline)?;
                if !current
                    .iter()
                    .any(|item| item.pid == candidate.pid && item.parent == parent_pid)
                    || !candidate.alive()?
                    || !self.processes[index].alive()?
                {
                    continue;
                }
                if depth > MAX_DEPTH {
                    return Err(stage_failed("CAPTURE_DEPTH_LIMIT"));
                }
                if self.processes.len() >= MAX_PROCESSES {
                    return Err(stage_failed("CAPTURE_PROCESS_LIMIT"));
                }
                self.processes.push(candidate);
            }
            index += 1;
        }
        Ok(())
    }

    fn stop(&mut self) -> Result<()> {
        self.stop_with(|process| {
            if unsafe { TerminateProcess(process.raw(), 1) } == 0 {
                Some(unsafe { GetLastError() })
            } else {
                None
            }
        })
    }

    fn stop_with(&mut self, mut terminate: impl FnMut(&Process) -> Option<u32>) -> Result<()> {
        let deadline = Instant::now() + STOP_BUDGET;
        let mut failure = self
            .capture(Instant::now() + CAPTURE_BUDGET)
            .err()
            .map(|error| error.context("browser process guard GUARD_STAGE=FINAL_CAPTURE"));
        // Terminate the retained root first to prevent further browser spawns.
        // Already exited roots do not prevent cleanup of retained children.
        let mut termination_errors = vec![None; self.processes.len()];
        for (index, process) in self.processes.iter().enumerate() {
            match process.alive() {
                Ok(false) => {}
                Ok(true) => {
                    // ERROR_ACCESS_DENIED can accompany an exit already in
                    // progress. The retained object's final signal decides
                    // success, not an immediate post-TerminateProcess poll.
                    termination_errors[index] = terminate(process);
                }
                Err(_) => {
                    failure.get_or_insert_with(|| stage_failed("STOP_LIVENESS"));
                }
            }
        }
        for (index, process) in self.processes.iter().enumerate() {
            let remaining = deadline.saturating_duration_since(Instant::now());
            let millis = remaining.as_millis().min(u128::from(u32::MAX - 1)) as u32;
            let wait = unsafe { WaitForSingleObject(process.raw(), millis) };
            if wait != WAIT_OBJECT_0 {
                let mut error = stage_failed(if wait == WAIT_TIMEOUT {
                    "WAIT_TIMEOUT"
                } else {
                    "WAIT_FAILED"
                });
                if let Some(code) = termination_errors[index] {
                    error = error.context(
                        if code == windows_sys::Win32::Foundation::ERROR_ACCESS_DENIED {
                            "browser process guard GUARD_STAGE=TERMINATE_ACCESS_DENIED"
                        } else {
                            "browser process guard GUARD_STAGE=TERMINATE_OTHER"
                        },
                    );
                }
                failure.get_or_insert(error);
            }
        }
        match failure {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }
}

fn stop_command(mut reader: impl Read) -> Result<()> {
    let mut line = [0_u8; 5];
    let mut length = 0;
    loop {
        let mut byte = [0_u8; 1];
        match reader.read(&mut byte) {
            Ok(0) => return Ok(()), // Broker crash / closed input.
            Ok(_) if byte[0] == b'\n' => {
                return if &line[..length] == b"stop" {
                    Ok(())
                } else {
                    Err(rejected())
                };
            }
            Ok(_) if length < line.len() => {
                line[length] = byte[0];
                length += 1;
            }
            Ok(_) => return Err(rejected()),
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(_) => return Err(rejected()),
        }
    }
}

fn json_line(output: &mut impl Write, line: &[u8]) -> Result<()> {
    output.write_all(line).map_err(|_| rejected())?;
    output.flush().map_err(|_| rejected())
}

fn supervise(guard: &mut Guard, output: &mut impl Write) -> Result<()> {
    guard
        .capture(Instant::now() + CAPTURE_BUDGET)
        .map_err(|error| error.context("browser process guard GUARD_STAGE=STARTUP_CAPTURE"))?;
    let (sender, receiver) = mpsc::sync_channel(1);
    std::thread::Builder::new()
        .spawn(move || {
            let result = stop_command(io::stdin().lock());
            let _ = sender.send(result);
        })
        .map_err(|_| rejected())?;
    json_line(output, b"{\"ready\":true}\n")?;
    loop {
        // Other browser children can inherit the broker's stdin writer, so EOF
        // is not a reliable crash signal. The retained broker object is.
        if let Some(broker) = &guard._broker {
            if !broker
                .alive()
                .map_err(|_| stage_failed("BROKER_LIVENESS"))?
            {
                return Ok(());
            }
        }
        match receiver.recv_timeout(CAPTURE_INTERVAL) {
            Ok(result) => return result,
            Err(RecvTimeoutError::Timeout) => {
                guard
                    .capture(Instant::now() + CAPTURE_BUDGET)
                    .map_err(|error| {
                        error.context("browser process guard GUARD_STAGE=PERIODIC_CAPTURE")
                    })?;
            }
            Err(RecvTimeoutError::Disconnected) => return Err(rejected()),
        }
    }
}

/// Entry point before home/runtime/environment initialization. Only these two
/// flushed JSON lines may be written to stdout by the production helper.
pub fn run(args: &[OsString]) -> Result<i32> {
    let (pid, expected) = arguments(args)?;
    let mut guard = Guard::acquire(pid, &expected)?;
    let mut output = io::stdout().lock();
    let command_result = supervise(&mut guard, &mut output);
    // Even a malformed command, failed pipe, or capture failure must clean up
    // every process whose ownership has already been established.
    let stop_result = guard.stop();
    command_result?;
    stop_result?;
    json_line(&mut output, b"{\"stopped\":true}\n")?;
    Ok(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader};
    use std::process::{Child, Command, Stdio};
    use std::sync::mpsc::Receiver;
    use windows_sys::Win32::Foundation::{DuplicateHandle, DUPLICATE_SAME_ACCESS};

    const FIXTURE_ROLE: &str = "TREX_GUARD_TEST_ROLE";

    fn executable() -> PathBuf {
        std::env::current_exe().unwrap()
    }

    fn command(role: &str) -> Command {
        let mut command = Command::new(executable());
        command
            .args([
                "--exact",
                "guard::tests::process_fixture",
                "--nocapture",
                "--test-threads=1",
            ])
            .env(FIXTURE_ROLE, role)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        command
    }

    // Every fixture, including rejection fixtures, retains a cleanup handle.
    // Drop never issues a PID-based kill and also cleans known descendants.
    struct Fixture {
        child: Child,
        cleanup: Guard,
        events: Receiver<String>,
    }

    impl Fixture {
        fn spawn(command: &mut Command) -> Self {
            let mut child = command.spawn().unwrap();
            let process = Process::open(child.id(), 0).unwrap();
            let stdout = child.stdout.take().unwrap();
            let (sender, events) = mpsc::channel();
            std::thread::spawn(move || {
                for line in BufReader::new(stdout).lines() {
                    match line {
                        Ok(line) => {
                            if sender.send(line).is_err() {
                                break;
                            }
                        }
                        Err(_) => break,
                    }
                }
            });
            Self {
                child,
                cleanup: Guard {
                    expected: normalized_absolute(&executable()).unwrap(),
                    processes: vec![process],
                    _broker: None,
                },
                events,
            }
        }

        fn event(&self, needle: &str) -> String {
            let deadline = Instant::now() + Duration::from_secs(5);
            loop {
                let line = self
                    .events
                    .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                    .expect("fixture event timed out");
                if line.contains(needle) {
                    return line;
                }
            }
        }

        fn send(&mut self, bytes: &[u8]) {
            let input = self.child.stdin.as_mut().unwrap();
            input.write_all(bytes).unwrap();
            input.flush().unwrap();
        }

        fn spawn_descendant(&mut self) -> u32 {
            self.send(b"spawn\n");
            let line = self.event("fixture-child:");
            let pid = line
                .split_once("fixture-child:")
                .unwrap()
                .1
                .trim()
                .parse()
                .unwrap();
            self.cleanup
                .capture(Instant::now() + CAPTURE_BUDGET)
                .unwrap();
            assert!(self
                .cleanup
                .processes
                .iter()
                .any(|process| process.pid == pid));
            pid
        }

        fn wait(&mut self) -> std::process::ExitStatus {
            let deadline = Instant::now() + Duration::from_secs(8);
            loop {
                if let Some(status) = self.child.try_wait().unwrap() {
                    return status;
                }
                assert!(Instant::now() < deadline, "fixture exit timed out");
                std::thread::sleep(Duration::from_millis(20));
            }
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            self.child.stdin.take();
            let _ = self.cleanup.stop();
            let _ = self.child.try_wait();
        }
    }

    fn helper(pid: u32, expected: &Path) -> Fixture {
        Fixture::spawn(
            command("guard")
                .env("TREX_GUARD_TEST_PID", pid.to_string())
                .env("TREX_GUARD_TEST_EXE", expected),
        )
    }

    // These are ordinary Rust test executables, never Node, Chrome, or a GUI.
    // The outer test process is the broker; its root and helper are siblings.
    #[test]
    fn process_fixture() {
        let Ok(role) = std::env::var(FIXTURE_ROLE) else {
            return;
        };
        match role.as_str() {
            "guard" => {
                let args = [
                    OsString::from("--pid"),
                    std::env::var_os("TREX_GUARD_TEST_PID").unwrap(),
                    OsString::from("--exe"),
                    std::env::var_os("TREX_GUARD_TEST_EXE").unwrap(),
                ];
                std::process::exit(run(&args).unwrap_or(1));
            }
            "root" => {
                println!("fixture-ready");
                io::stdout().flush().unwrap();
                let mut children = Vec::new();
                // EOF lets this fixture finish cleanly during test cleanup.
                for line in io::stdin().lock().lines() {
                    if line.unwrap() == "spawn" {
                        let child = Fixture::spawn(&mut command("leaf"));
                        child.event("fixture-ready");
                        println!("fixture-child:{}", child.child.id());
                        io::stdout().flush().unwrap();
                        children.push(child);
                    }
                }
            }
            "broker" => {
                let mut root = Fixture::spawn(&mut command("root"));
                root.event("fixture-ready");
                let descendant = root.spawn_descendant();
                let mut guard = helper(root.child.id(), &executable());
                guard.event("{\"ready\":true}");
                // These raw values are only transported inside test fixtures.
                // The outer process duplicates them while this broker lives.
                println!(
                    "fixture-broker:{} {} {} {} {}",
                    root.child.id(),
                    descendant,
                    guard.child.id(),
                    guard.child.stdin.as_ref().unwrap().as_raw_handle() as usize,
                    root.child.stdin.as_ref().unwrap().as_raw_handle() as usize,
                );
                io::stdout().flush().unwrap();
                for line in io::stdin().lock().lines() {
                    if line.unwrap() == "release-writers" {
                        guard.child.stdin.take();
                        root.child.stdin.take();
                        println!("fixture-writers-released");
                        io::stdout().flush().unwrap();
                    }
                }
            }
            "leaf" => {
                println!("fixture-ready");
                io::stdout().flush().unwrap();
                // Independent of root stdin/exit so guard ownership is tested.
                // A finite ceiling also bounds cleanup after a harness crash.
                std::thread::sleep(Duration::from_secs(30));
            }
            _ => panic!("unknown fixture role"),
        }
    }

    #[test]
    fn exact_arguments_and_bounded_input() {
        let args = [
            OsString::from("--pid"),
            OsString::from("42"),
            OsString::from("--exe"),
            executable().into_os_string(),
        ];
        assert_eq!(arguments(&args).unwrap().0, 42);
        for value in ["0", "-1", "+1", " 1", "4294967296", ""] {
            let mut invalid = args.clone();
            invalid[1] = value.into();
            assert!(arguments(&invalid).is_err());
        }
        let mut reordered = args.clone();
        reordered.swap(0, 2);
        assert!(arguments(&reordered).is_err());
        assert!(arguments(&args[..3]).is_err());
        assert!(normalized_absolute(Path::new("relative.exe")).is_err());
        assert!(stop_command(&b"stop\n"[..]).is_ok());
        assert!(stop_command(&b""[..]).is_ok());
        assert!(stop_command(&b"partial"[..]).is_err());
        assert!(stop_command(&b"sto"[..]).is_ok()); // EOF still means stop.
        assert!(stop_command(&b"stop\r\n"[..]).is_err());
        assert!(stop_command(&b"no\n"[..]).is_err());
        assert!(stop_command(io::repeat(b'x')).is_err());
    }

    fn retained_descendant_after_root_exit(eof: bool) {
        let mut root = Fixture::spawn(&mut command("root"));
        root.event("fixture-ready");
        let mut guard = helper(root.child.id(), &executable());
        guard.event("{\"ready\":true}");
        // Created after readiness, so only the periodic pass can retain it
        // before its parent exits. Final discovery alone cannot find it.
        let child_pid = root.spawn_descendant();
        let descendant = root
            .cleanup
            .processes
            .iter()
            .find(|process| process.pid == child_pid)
            .unwrap();
        std::thread::sleep(Duration::from_millis(700));
        assert_eq!(
            unsafe { TerminateProcess(root.cleanup.processes[0].raw(), 1) },
            1
        );
        assert_eq!(
            unsafe { WaitForSingleObject(root.cleanup.processes[0].raw(), 1000) },
            WAIT_OBJECT_0
        );
        assert!(descendant.alive().unwrap());
        if eof {
            guard.child.stdin.take();
        } else {
            guard.send(b"stop\n");
        }
        assert!(guard.wait().success());
        guard.event("{\"stopped\":true}");
        assert!(
            !descendant.alive().unwrap(),
            "retained descendant was not reaped"
        );
    }

    #[test]
    fn stop_reaps_periodically_retained_descendant_after_root_exit() {
        retained_descendant_after_root_exit(false);
    }

    #[test]
    fn broker_eof_reaps_periodically_retained_descendant_after_root_exit() {
        retained_descendant_after_root_exit(true);
    }

    #[test]
    fn broker_death_reaps_browser_with_guard_stdin_writer_held_by_another_process() {
        let mut broker = Fixture::spawn(&mut command("broker"));
        let line = broker.event("fixture-broker:");
        let values: Vec<usize> = line
            .split_once("fixture-broker:")
            .unwrap()
            .1
            .split_whitespace()
            .map(|value| value.parse().unwrap())
            .collect();
        assert_eq!(values.len(), 5);
        let [root_pid, descendant_pid, guard_pid, guard_writer, root_writer] =
            <[usize; 5]>::try_from(values).unwrap();

        let duplicate_writer = |source: usize| {
            let mut duplicate: HANDLE = std::ptr::null_mut();
            // Child retains the original CreateProcess handle, including the
            // duplication right; the production guard requests no such right.
            assert_ne!(
                unsafe {
                    DuplicateHandle(
                        broker.child.as_raw_handle(),
                        source as HANDLE,
                        GetCurrentProcess(),
                        &mut duplicate,
                        0,
                        0,
                        DUPLICATE_SAME_ACCESS,
                    )
                },
                0,
            );
            assert!(!duplicate.is_null());
            unsafe { OwnedHandle::from_raw_handle(duplicate) }
        };
        let guard_writer = duplicate_writer(guard_writer);
        // Prevent root's normal stdin-EOF cleanup from masking a guard bug.
        let root_writer = duplicate_writer(root_writer);
        broker
            .cleanup
            .capture(Instant::now() + CAPTURE_BUDGET)
            .unwrap();
        for pid in [root_pid, descendant_pid, guard_pid] {
            assert!(broker
                .cleanup
                .processes
                .iter()
                .any(|process| process.pid as usize == pid));
        }

        broker.send(b"release-writers\n");
        broker.event("fixture-writers-released");
        // The broker has closed its own copies. The external duplicates keep
        // both readers blocked, proving EOF cannot trigger either shutdown.
        std::thread::sleep(CAPTURE_INTERVAL * 3);
        assert!(broker
            .cleanup
            .processes
            .iter()
            .all(|process| process.alive().unwrap()));

        assert_ne!(
            unsafe { TerminateProcess(broker.cleanup.processes[0].raw(), 1) },
            0,
        );
        assert_eq!(
            unsafe { WaitForSingleObject(broker.cleanup.processes[0].raw(), 1000) },
            WAIT_OBJECT_0,
        );
        let retained = |pid: usize| {
            broker
                .cleanup
                .processes
                .iter()
                .find(|process| process.pid as usize == pid)
                .unwrap()
        };
        // Keep both duplicates alive through all exit assertions. In
        // particular no stop command or EOF is supplied to the native guard.
        assert_eq!(
            unsafe { WaitForSingleObject(retained(guard_pid).raw(), 8000) },
            WAIT_OBJECT_0,
            "guard did not exit after its broker died with stdin still open",
        );
        for pid in [root_pid, descendant_pid] {
            assert_eq!(
                unsafe { WaitForSingleObject(retained(pid).raw(), 0) },
                WAIT_OBJECT_0,
                "guard exited before reaping its owned browser process",
            );
        }
        drop((guard_writer, root_writer));
        // The helper's stdout reader died with the broker; a final write may
        // fail. Its exit code is immaterial after successful owned cleanup.
    }

    #[test]
    fn mismatched_image_rejects_and_leaves_target_alive() {
        let root = Fixture::spawn(&mut command("root"));
        root.event("fixture-ready");
        let different = executable().with_file_name("different-image.exe");
        let mut guard = helper(root.child.id(), &different);
        assert!(!guard.wait().success());
        assert!(root.cleanup.processes[0].alive().unwrap());
    }

    #[test]
    fn image_case_mismatch_rejects_and_leaves_target_alive() {
        let root = Fixture::spawn(&mut command("root"));
        root.event("fixture-ready");
        let image = executable();
        let name = image.file_name().unwrap().to_str().unwrap();
        let changed: String = name
            .chars()
            .map(|ch| {
                if ch.is_ascii_lowercase() {
                    ch.to_ascii_uppercase()
                } else if ch.is_ascii_uppercase() {
                    ch.to_ascii_lowercase()
                } else {
                    ch
                }
            })
            .collect();
        assert_ne!(changed, name);
        let mut guard = helper(root.child.id(), &image.with_file_name(changed));
        assert!(!guard.wait().success());
        assert!(root.cleanup.processes[0].alive().unwrap());
    }

    #[test]
    fn mismatched_parent_rejects_and_leaves_unrelated_descendant_alive() {
        let mut root = Fixture::spawn(&mut command("root"));
        root.event("fixture-ready");
        let child_pid = root.spawn_descendant();
        // The helper and grandchild have different actual parents despite
        // using exactly the same executable and sharing an ancestor.
        let mut guard = helper(child_pid, &executable());
        assert!(!guard.wait().success());
        assert!(root
            .cleanup
            .processes
            .iter()
            .all(|process| process.alive().unwrap()));
    }

    #[test]
    fn capture_prunes_exited_children_but_keeps_root_and_live_children() {
        let mut root = Fixture::spawn(&mut command("root"));
        root.event("fixture-ready");
        let first_pid = root.spawn_descendant();
        let second_pid = root.spawn_descendant();
        let first = root
            .cleanup
            .processes
            .iter()
            .find(|process| process.pid == first_pid)
            .unwrap();
        assert_ne!(unsafe { TerminateProcess(first.raw(), 1) }, 0);
        assert_eq!(
            unsafe { WaitForSingleObject(first.raw(), 1000) },
            WAIT_OBJECT_0
        );
        root.cleanup
            .capture(Instant::now() + CAPTURE_BUDGET)
            .unwrap();
        assert_eq!(root.cleanup.processes.len(), 2);
        assert_eq!(root.cleanup.processes[0].pid, root.child.id());
        assert_eq!(root.cleanup.processes[1].pid, second_pid);
        assert!(root.cleanup.processes[1].alive().unwrap());
        assert_ne!(
            unsafe { TerminateProcess(root.cleanup.processes[0].raw(), 1) },
            0
        );
        assert_eq!(
            unsafe { WaitForSingleObject(root.cleanup.processes[0].raw(), 1000) },
            WAIT_OBJECT_0
        );
        root.cleanup
            .capture(Instant::now() + CAPTURE_BUDGET)
            .unwrap();
        assert_eq!(root.cleanup.processes.len(), 2);
        assert_eq!(root.cleanup.processes[0].pid, root.child.id());
        assert_eq!(root.cleanup.processes[1].pid, second_pid);
    }

    #[test]
    fn termination_error_does_not_override_later_retained_handle_completion() {
        let mut root = Fixture::spawn(&mut command("root"));
        root.event("fixture-ready");
        let mut completions = Vec::new();
        let started = Instant::now();
        let result = root.cleanup.stop_with(|process| {
            let handle = process.handle.try_clone().unwrap();
            // Model an access-denied response while exit completion is still
            // asynchronous. Ownership remains tied to the same retained object.
            completions.push(std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(100));
                assert_ne!(unsafe { TerminateProcess(handle.as_raw_handle(), 1) }, 0);
            }));
            Some(windows_sys::Win32::Foundation::ERROR_ACCESS_DENIED)
        });
        result.unwrap();
        assert!(started.elapsed() >= Duration::from_millis(100));
        for completion in completions {
            completion.join().unwrap();
        }
        assert!(!root.cleanup.processes[0].alive().unwrap());
    }
}
