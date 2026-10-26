use crate::environment::ChildEnvironment;
use crate::runtime::Runtime;
use anyhow::{Context, Result};
use std::ffi::{OsStr, OsString};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use windows_sys::Win32::System::Console::{SetConsoleCtrlHandler, CTRL_BREAK_EVENT, CTRL_C_EVENT};

static INTERRUPTED: AtomicBool = AtomicBool::new(false);

unsafe extern "system" fn console_control(event: u32) -> i32 {
    if event == CTRL_C_EVENT || event == CTRL_BREAK_EVENT {
        // Both processes receive the console event. Give the worker time to
        // close its own RPC request; never target the detached daemon or a name.
        INTERRUPTED.store(true, Ordering::SeqCst);
        1
    } else {
        0
    }
}

struct ConsoleHandler(bool);

impl Drop for ConsoleHandler {
    fn drop(&mut self) {
        if self.0 {
            unsafe {
                SetConsoleCtrlHandler(Some(console_control), 0);
            }
        }
    }
}

pub fn spawn_broker(runtime: &Runtime, environment: &ChildEnvironment) -> Result<()> {
    let _child = crate::detached::spawn(
        &runtime.node,
        &[runtime.worker.as_os_str(), OsStr::new("daemon")],
        environment,
    )?;
    // Closing a process handle does not terminate it. The broker has no console,
    // inherited stdio and outlives this short-lived helper. Windows can retain
    // an ambient ancestor job even after a permitted breakaway; that is not
    // evidence that the broker is still attached to this helper's job.
    Ok(())
}

pub fn run(runtime: &Runtime, environment: &ChildEnvironment, args: &[OsString]) -> Result<i32> {
    INTERRUPTED.store(false, Ordering::SeqCst);
    // A process launched without a console may reject registration. In that
    // case ordinary inherited stdio and OS termination semantics still apply.
    let _handler = ConsoleHandler(unsafe { SetConsoleCtrlHandler(Some(console_control), 1) } != 0);
    let mut child = runtime
        .command(environment)
        .arg(&runtime.worker)
        .args(args)
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .spawn()
        .context("could not start the browser CLI worker")?;
    let mut interrupted_at = None;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Ok(status.code().unwrap_or(1)),
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(error).context("could not wait for the browser CLI worker");
            }
            Ok(None) => {}
        }
        if INTERRUPTED.load(Ordering::SeqCst) {
            let started = interrupted_at.get_or_insert_with(Instant::now);
            if started.elapsed() >= Duration::from_secs(3) {
                // Child::kill targets the retained process handle, not a PID
                // looked up by name. It cannot kill a subsequent PID owner.
                child
                    .kill()
                    .context("could not stop the interrupted CLI worker")?;
                child
                    .wait()
                    .context("could not reap the interrupted CLI worker")?;
                return Ok(130);
            }
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Read, Write};
    use std::mem::{size_of, zeroed};
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use std::os::windows::process::CommandExt;
    use std::process::Command;
    use std::sync::mpsc;
    use windows_sys::Win32::Foundation::{WAIT_OBJECT_0, WAIT_TIMEOUT};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, IsProcessInJob,
        JobObjectExtendedLimitInformation, SetInformationJobObject, TerminateJobObject,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_BREAKAWAY_OK,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::{
        GetCurrentProcess, OpenProcess, TerminateProcess, WaitForSingleObject, CREATE_NO_WINDOW,
        PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE,
    };

    fn fixture(mode: &str) -> Command {
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "--exact",
                "supervisor::tests::job_breakaway_fixture",
                "--nocapture",
            ])
            .env("TREX_BROWSER_NATIVE_JOB_FIXTURE", mode);
        command
    }

    fn spawn_detached_fixture(mode: &str) -> Result<crate::detached::DetachedProcess> {
        let mut environment = ChildEnvironment::new();
        environment.insert("TREX_BROWSER_NATIVE_JOB_FIXTURE".into(), mode.into());
        crate::detached::spawn(
            &std::env::current_exe()?,
            &[
                OsStr::new("--exact"),
                OsStr::new("supervisor::tests::job_breakaway_fixture"),
                OsStr::new("--nocapture"),
            ],
            &environment,
        )
    }

    #[test]
    fn detached_process_accepts_ambient_jobs_but_keeps_required_breakaway() {
        let mut child = match spawn_detached_fixture("wait") {
            Ok(child) => child,
            Err(error) => {
                let mut in_job = 0;
                assert_ne!(
                    unsafe {
                        IsProcessInJob(GetCurrentProcess(), std::ptr::null_mut(), &mut in_job)
                    },
                    0
                );
                assert_eq!(
                    in_job, 1,
                    "unexpected breakaway failure outside a job: {error:#}"
                );
                assert_eq!(
                    error
                        .downcast_ref::<std::io::Error>()
                        .and_then(|error| error.raw_os_error()),
                    Some(5),
                    "{error:#}"
                );
                assert!(error.to_string().contains("job breakaway"));
                return;
            }
        };
        child.kill().unwrap();
        child.wait().unwrap();
    }

    #[test]
    fn detached_process_survives_termination_of_its_launchers_job() {
        unsafe {
            let raw = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            assert!(!raw.is_null());
            let job = OwnedHandle::from_raw_handle(raw);
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = zeroed();
            limits.BasicLimitInformation.LimitFlags =
                JOB_OBJECT_LIMIT_BREAKAWAY_OK | JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            assert_ne!(
                SetInformationJobObject(
                    job.as_raw_handle(),
                    JobObjectExtendedLimitInformation,
                    (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                    size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32
                ),
                0
            );
            let mut launcher = fixture("launch-and-wait")
                .creation_flags(CREATE_NO_WINDOW)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .spawn()
                .unwrap();
            assert_ne!(
                AssignProcessToJobObject(job.as_raw_handle(), launcher.as_raw_handle()),
                0
            );
            let stdout = launcher.stdout.take().unwrap();
            let (sender, receiver) = mpsc::sync_channel(1);
            std::thread::spawn(move || {
                for line in BufReader::new(stdout)
                    .lines()
                    .map_while(std::result::Result::ok)
                {
                    if let Some(pid) = line.strip_prefix("DETACHED_FIXTURE_PID=") {
                        let _ = sender.send(pid.parse::<u32>().unwrap());
                        break;
                    }
                }
            });
            launcher
                .stdin
                .as_mut()
                .unwrap()
                .write_all(b"launch\n")
                .unwrap();
            let pid = receiver.recv_timeout(Duration::from_secs(10)).unwrap();
            let raw = OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE | PROCESS_SYNCHRONIZE,
                0,
                pid,
            );
            assert!(!raw.is_null());
            let detached = OwnedHandle::from_raw_handle(raw);
            let mut in_launch_job = 1;
            assert_ne!(
                IsProcessInJob(
                    detached.as_raw_handle(),
                    job.as_raw_handle(),
                    &mut in_launch_job
                ),
                0
            );
            // Always stop both fixtures before asserting, including a regression
            // that accidentally kept the child in the launcher's kill job.
            assert_ne!(TerminateJobObject(job.as_raw_handle(), 91), 0);
            launcher.wait().unwrap();
            let survived = WaitForSingleObject(detached.as_raw_handle(), 250);
            let _ = TerminateProcess(detached.as_raw_handle(), 0);
            assert_eq!(
                WaitForSingleObject(detached.as_raw_handle(), 5000),
                WAIT_OBJECT_0
            );
            assert_eq!(in_launch_job, 0);
            assert_eq!(survived, WAIT_TIMEOUT);
        }
    }

    #[test]
    fn job_that_forbids_breakaway_fails_without_a_fallback() {
        let mut command = fixture("deny-breakaway");
        command
            .creation_flags(CREATE_NO_WINDOW)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let child = command.spawn().unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[test]
    fn job_breakaway_fixture() {
        match std::env::var("TREX_BROWSER_NATIVE_JOB_FIXTURE").as_deref() {
            Ok("wait") => std::thread::sleep(Duration::from_secs(20)),
            Ok("launch-and-wait") => {
                let mut line = String::new();
                std::io::stdin().read_line(&mut line).unwrap();
                let child = spawn_detached_fixture("wait").unwrap();
                println!("DETACHED_FIXTURE_PID={}", child.id());
                std::io::stdout().flush().unwrap();
                let _ = std::io::stdin().read(&mut [0u8; 1]);
            }
            Ok("deny-breakaway") => {
                let raw = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
                assert!(!raw.is_null());
                let job = unsafe { OwnedHandle::from_raw_handle(raw) };
                assert_ne!(
                    unsafe { AssignProcessToJobObject(job.as_raw_handle(), GetCurrentProcess()) },
                    0
                );
                let error = spawn_detached_fixture("wait")
                    .err()
                    .expect("a job that forbids breakaway must reject broker creation");
                assert!(error.to_string().contains("job breakaway"), "{error:#}");
            }
            _ => {}
        }
    }
}
