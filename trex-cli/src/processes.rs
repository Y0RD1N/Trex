//! Session-owned background shell processes. No arbitrary OS PID is accepted.
use anyhow::{ensure, Context, Result};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{io::AsyncReadExt, sync::Notify};
use tokio_util::sync::CancellationToken;

const OUTPUT_LIMIT: usize = 64 * 1024;
const ACTIVE_LIMIT: usize = 16;
#[cfg(windows)]
struct PtyGate {
    handle: std::os::windows::io::OwnedHandle,
    name: String,
}
#[cfg(windows)]
impl PtyGate {
    fn new() -> Result<Self> {
        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn CreateEventW(
                attributes: *const std::ffi::c_void,
                manual: i32,
                initial: i32,
                name: *const u16,
            ) -> *mut std::ffi::c_void;
        }
        let name = format!("Local\\TrexPty-{}", uuid::Uuid::new_v4());
        let wide: Vec<u16> = name.encode_utf16().chain(Some(0)).collect();
        use std::os::windows::io::FromRawHandle;
        let handle = unsafe { CreateEventW(std::ptr::null(), 1, 0, wide.as_ptr()) };
        ensure!(!handle.is_null(), "cannot initialize PTY start gate");
        Ok(Self {
            handle: unsafe { std::os::windows::io::OwnedHandle::from_raw_handle(handle) },
            name,
        })
    }
    fn release(&self) -> Result<()> {
        use std::os::windows::io::AsRawHandle;
        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn SetEvent(handle: *mut std::ffi::c_void) -> i32;
        }
        ensure!(
            unsafe { SetEvent(self.handle.as_raw_handle()) } != 0,
            "cannot release PTY start gate"
        );
        Ok(())
    }
}
struct Job {
    id: String,
    command: String,
    cwd: PathBuf,
    started_at: u64,
    data: Mutex<Data>,
    cancel: CancellationToken,
    done: Notify,
    input: Option<tokio::sync::mpsc::Sender<Vec<u8>>>,
    terminal: Mutex<Option<Box<dyn portable_pty::MasterPty + Send>>>,
    notifier: Option<Arc<dyn Fn(Value) + Send + Sync>>,
}
struct Data {
    status: &'static str,
    output: Vec<u8>,
    truncated: bool,
    exit_code: Option<i32>,
    offset: u64,
    last_notified: std::time::Instant,
}
impl Job {
    fn summary(&self) -> Value {
        let data = self.data.lock().unwrap_or_else(|e| e.into_inner());
        json!({"id":self.id,"command":self.command,"cwd":self.cwd,"startedAt":self.started_at,"status":data.status,"exitCode":data.exit_code,"interactive":self.input.is_some(),"pty":self.terminal.lock().unwrap_or_else(|e|e.into_inner()).is_some()})
    }
    fn active(&self) -> bool {
        matches!(
            self.data.lock().unwrap_or_else(|e| e.into_inner()).status,
            "running" | "stopping"
        )
    }
    fn append(&self, bytes: &[u8]) {
        let mut data = self.data.lock().unwrap_or_else(|e| e.into_inner());
        data.output.extend_from_slice(bytes);
        if data.output.len() > OUTPUT_LIMIT {
            let mut drop = data.output.len() - OUTPUT_LIMIT;
            while drop < data.output.len() && data.output[drop] & 0xc0 == 0x80 {
                drop += 1;
            }
            data.output.drain(..drop);
            data.offset = data.offset.saturating_add(drop as u64);
            data.truncated = true;
        }
        let offset = data.offset.saturating_add(data.output.len() as u64);
        let changed = data.last_notified.elapsed() >= Duration::from_millis(100);
        if changed {
            data.last_notified = std::time::Instant::now();
        }
        drop(data);
        if changed {
            if let Some(notify) = &self.notifier {
                notify(json!({"kind":"outputAvailable","processId":self.id,"nextOffset":offset}));
            }
        }
    }
}
#[derive(Default)]
pub struct ProcessManager {
    jobs: Mutex<BTreeMap<String, Arc<Job>>>,
    closing: AtomicBool,
    notifier: Mutex<Option<Arc<dyn Fn(Value) + Send + Sync>>>,
}
impl ProcessManager {
    pub fn set_notifier(&self, notifier: Arc<dyn Fn(Value) + Send + Sync>) {
        *self.notifier.lock().unwrap_or_else(|e| e.into_inner()) = Some(notifier);
    }
    pub fn start(
        &self,
        cwd: &Path,
        input: &Value,
        operation_id: &str,
        cancel: &CancellationToken,
    ) -> Result<Value> {
        self.start_configured(
            cwd,
            input,
            operation_id,
            cancel,
            &crate::settings::ShellSettings::default(),
        )
    }
    pub fn start_configured(
        &self,
        cwd: &Path,
        input: &Value,
        operation_id: &str,
        cancel: &CancellationToken,
        settings: &crate::settings::ShellSettings,
    ) -> Result<Value> {
        ensure!(!cancel.is_cancelled(), "background launch cancelled");
        let object = input.as_object().context("shell input must be an object")?;
        ensure!(object.keys().all(|key| ["command", "background","interactive","pty","rows","cols"].contains(&key.as_str())), "background shell accepts command, background, interactive, pty, rows and cols; stop it explicitly instead of a timeout");
        for key in ["interactive", "pty"] {
            ensure!(
                object.get(key).is_none_or(Value::is_boolean),
                "interactive and pty must be booleans"
            );
        }
        ensure!(input["background"] == true, "background must be true");
        let command = input["command"]
            .as_str()
            .context("command must be a string")?;
        ensure!(
            !command.trim().is_empty() && command.len() <= 32 * 1024 && !command.contains('\0'),
            "command must have 1..32768 bytes without NUL"
        );
        ensure!(
            !operation_id.is_empty() && operation_id.len() <= 256,
            "invalid background operation id"
        );
        let cwd = cwd
            .canonicalize()
            .context("background workspace is unavailable")?;
        let mut jobs = self.jobs.lock().unwrap_or_else(|e| e.into_inner());
        ensure!(
            !self.closing.load(Ordering::SeqCst) && !cancel.is_cancelled(),
            "background session is closing"
        );
        if let Some(existing) = jobs.get(operation_id) {
            ensure!(
                existing.command == command && existing.cwd == cwd,
                "background operation id has different arguments"
            );
            return Ok(existing.summary());
        }
        ensure!(
            jobs.values().filter(|job| job.active()).count() < ACTIVE_LIMIT,
            "at most 16 background terminals can run per session"
        );
        // Finished IDs are retained for this runtime so replay cannot launch the same command twice.
        ensure!(
            jobs.len() < 256,
            "background terminal registry is full; start a new session"
        );
        if input["pty"] == true {
            return self.start_pty(&mut jobs, &cwd, command, operation_id, input, settings);
        }
        let interactive = input["interactive"] == true;
        let (mut child, mut guard) =
            crate::tools::spawn_shell_configured(&cwd, command, settings, interactive)?;
        let stdin = child.stdin.take();
        let (input_tx, mut input_rx) = tokio::sync::mpsc::channel::<Vec<u8>>(16);
        let stdout = child.stdout.take().context("missing background stdout")?;
        let stderr = child.stderr.take().context("missing background stderr")?;
        let job = Arc::new(Job {
            id: operation_id.into(),
            command: command.into(),
            cwd,
            started_at: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64,
            data: Mutex::new(Data {
                status: "running",
                output: Vec::new(),
                truncated: false,
                exit_code: None,
                offset: 0,
                last_notified: std::time::Instant::now(),
            }),
            cancel: CancellationToken::new(),
            done: Notify::new(),
            input: if interactive { Some(input_tx) } else { None },
            terminal: Mutex::new(None),
            notifier: self
                .notifier
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clone(),
        });
        jobs.insert(operation_id.into(), job.clone());
        let task = job.clone();
        tokio::spawn(async move {
            use tokio::io::AsyncWriteExt;
            let writer = tokio::spawn(async move {
                if let Some(mut stdin) = stdin {
                    while let Some(bytes) = input_rx.recv().await {
                        if stdin.write_all(&bytes).await.is_err() {
                            break;
                        }
                        let _ = stdin.flush().await;
                    }
                }
            });
            let out = task.clone();
            let err = task.clone();
            let stdout = tokio::spawn(pump(stdout, out));
            let stderr = tokio::spawn(pump(stderr, err));
            let (status, stopped) = tokio::select! {
                biased;
                _ = task.cancel.cancelled() => { crate::tools::stop_process(&mut child, &mut guard).await; (None, true) },
                result = child.wait() => (result.ok(), false),
            };
            // Closing the containment guard also terminates descendants holding inherited pipes.
            drop(guard);
            writer.abort();
            let mut stdout = stdout;
            let mut stderr = stderr;
            if tokio::time::timeout(Duration::from_secs(2), async {
                let _ = (&mut stdout).await;
                let _ = (&mut stderr).await;
            })
            .await
            .is_err()
            {
                stdout.abort();
                stderr.abort();
            }
            let mut data = task.data.lock().unwrap_or_else(|e| e.into_inner());
            data.exit_code = status.as_ref().and_then(|s| s.code());
            data.status = if stopped {
                "stopped"
            } else if status.is_some_and(|s| s.success()) {
                "completed"
            } else {
                "failed"
            };
            drop(data);
            if let Some(notify) = &task.notifier {
                notify(json!({"kind":"status","process":task.summary()}));
            }
            task.done.notify_waiters();
        });
        Ok(job.summary())
    }
    fn start_pty(
        &self,
        jobs: &mut BTreeMap<String, Arc<Job>>,
        cwd: &Path,
        text: &str,
        id: &str,
        input: &Value,
        settings: &crate::settings::ShellSettings,
    ) -> Result<Value> {
        use std::io::Write;
        let size = |key: &str, default: u64| -> Result<u16> {
            let v = input
                .get(key)
                .map(|v| v.as_u64().context("invalid terminal dimensions"))
                .transpose()?
                .unwrap_or(default);
            ensure!(
                (10..=500).contains(&v),
                "terminal dimensions must be 10..500"
            );
            Ok(v as u16)
        };
        let pair = portable_pty::native_pty_system().openpty(portable_pty::PtySize {
            rows: size("rows", 24)?,
            cols: size("cols", 100)?,
            pixel_width: 0,
            pixel_height: 0,
        })?;
        #[cfg(windows)]
        let shell = settings.executable.clone().unwrap_or_else(|| {
            PathBuf::from(std::env::var_os("SystemRoot").unwrap_or_default())
                .join("System32/WindowsPowerShell/v1.0/powershell.exe")
        });
        #[cfg(not(windows))]
        let shell = settings
            .executable
            .clone()
            .unwrap_or_else(|| PathBuf::from("/bin/sh"));
        let mut command = portable_pty::CommandBuilder::new(&shell);
        command.cwd(cwd);
        #[cfg(windows)]
        let gate = PtyGate::new()?;
        #[cfg(windows)]
        {
            use base64::Engine;
            let encoded = base64::engine::general_purpose::STANDARD.encode(text.as_bytes());
            command.args(["-NoLogo","-NoProfile","-Command",&format!("$gate=[System.Threading.EventWaitHandle]::OpenExisting('{}'); if (-not $gate.WaitOne(10000)) {{ throw 'PTY containment was not established' }}; $gate.Dispose(); [Console]::InputEncoding=[System.Text.UTF8Encoding]::new($false); [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); $OutputEncoding=[Console]::OutputEncoding; & ([scriptblock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{encoded}'))))",gate.name)]);
        }
        #[cfg(not(windows))]
        command.args([
            "-c",
            "IFS= read -r _trex_ready; exec \"$1\" -c \"$2\"",
            "trex-pty",
            shell.to_str().context("invalid shell path")?,
            text,
        ]);
        if settings.environment == "minimal" {
            command.env_clear();
            let mut temporary = tokio::process::Command::new(&shell);
            crate::settings::configure_environment(&mut temporary, settings);
            for (name, value) in temporary.as_std().get_envs() {
                if let Some(value) = value {
                    command.env(name, value);
                }
            }
        }
        let mut child = pair.slave.spawn_command(command)?;
        let mut guard = match crate::tools::ProcessTreeGuard::for_pty(&*child) {
            Ok(g) => g,
            Err(e) => {
                let _ = child.kill();
                return Err(e);
            }
        };
        let mut reader = pair.master.try_clone_reader()?;
        let writer = pair.master.take_writer()?;
        #[cfg(not(windows))]
        let mut writer = writer;
        // The shell cannot execute user commands before containment is attached.
        #[cfg(windows)]
        gate.release()?;
        #[cfg(not(windows))]
        {
            writer.write_all(b"\n")?;
            writer.flush()?;
        }
        drop(pair.slave);
        let (tx, mut rx) = tokio::sync::mpsc::channel::<Vec<u8>>(16);
        let job = Arc::new(Job {
            id: id.into(),
            command: text.into(),
            cwd: cwd.into(),
            started_at: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64,
            data: Mutex::new(Data {
                status: "running",
                output: vec![],
                truncated: false,
                exit_code: None,
                offset: 0,
                last_notified: std::time::Instant::now(),
            }),
            cancel: CancellationToken::new(),
            done: Notify::new(),
            input: Some(tx),
            terminal: Mutex::new(Some(pair.master)),
            notifier: self
                .notifier
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clone(),
        });
        jobs.insert(id.into(), job.clone());
        let output = job.clone();
        std::thread::spawn(move || {
            let mut bytes = [0; 8192];
            let mut pending = Vec::new();
            loop {
                match reader.read(&mut bytes) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        output.append(&bytes[..n]);
                        // ConPTY asks its terminal for a cursor report during startup.
                        // Answer only fixed terminal queries, never commands/newlines.
                        for byte in &bytes[..n] {
                            pending.push(*byte);
                            if pending.len() > 16 {
                                pending.remove(0);
                            }
                            let reply = if pending.ends_with(b"\x1b[6n") {
                                Some(b"\x1b[1;1R".as_slice())
                            } else if pending.ends_with(b"\x1b[c") {
                                Some(b"\x1b[?1;2c".as_slice())
                            } else {
                                None
                            };
                            if let Some(reply) = reply {
                                if let Some(input) = &output.input {
                                    let _ = input.try_send(reply.to_vec());
                                }
                                pending.clear();
                            }
                        }
                    }
                }
            }
        });
        let writer = Arc::new(Mutex::new(writer));
        let task = job.clone();
        tokio::spawn(async move {
            #[cfg(windows)]
            let _gate = gate;
            loop {
                if task.cancel.is_cancelled() {
                    guard.terminate();
                    let _ = child.kill();
                    break;
                }
                match child.try_wait() {
                    Ok(Some(status)) => {
                        let mut data = task.data.lock().unwrap_or_else(|e| e.into_inner());
                        data.exit_code = Some(status.exit_code() as i32);
                        data.status = if status.success() {
                            "completed"
                        } else {
                            "failed"
                        };
                        break;
                    }
                    Err(_) => break,
                    _ => (),
                }
                tokio::select! {_=task.cancel.cancelled()=>{},_=tokio::time::sleep(Duration::from_millis(30))=>{},Some(bytes)=rx.recv()=>{
                    let target=writer.clone();let write=tokio::task::spawn_blocking(move||{let mut target=target.lock().unwrap_or_else(|e|e.into_inner());target.write_all(&bytes)?;target.flush()});
                    let ok=tokio::select!{_=task.cancel.cancelled()=>false,result=write=>matches!(result,Ok(Ok(())))};
                    if !ok{guard.terminate();break;}
                }}
            }
            guard.terminate();
            drop(writer);
            task.terminal
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .take();
            {
                let mut data = task.data.lock().unwrap_or_else(|e| e.into_inner());
                if data.status == "running" || data.status == "stopping" {
                    data.status = if task.cancel.is_cancelled() {
                        "stopped"
                    } else {
                        "failed"
                    };
                }
            }
            if let Some(notify) = &task.notifier {
                notify(json!({"kind":"status","process":task.summary()}));
            }
            task.done.notify_waiters();
        });
        Ok(job.summary())
    }
    pub fn list(&self) -> Value {
        json!({"processes":self.jobs.lock().unwrap_or_else(|e| e.into_inner()).values().map(|job| job.summary()).collect::<Vec<_>>()})
    }
    pub fn read(&self, id: &str) -> Result<Value> {
        self.read_since(id, None)
    }
    pub fn read_since(&self, id: &str, after: Option<u64>) -> Result<Value> {
        let job = self
            .jobs
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(id)
            .cloned()
            .context("terminal does not belong to this session")?;
        let data = job.data.lock().unwrap_or_else(|e| e.into_inner());
        let mut skip = after
            .unwrap_or(data.offset)
            .saturating_sub(data.offset)
            .min(data.output.len() as u64) as usize;
        while skip < data.output.len() && data.output[skip] & 0xc0 == 0x80 {
            skip += 1;
        }
        let bytes = &data.output[skip..];
        let end = if matches!(data.status, "running" | "stopping") {
            match std::str::from_utf8(bytes) {
                Err(e) if e.error_len().is_none() => e.valid_up_to(),
                _ => bytes.len(),
            }
        } else {
            bytes.len()
        };
        Ok(
            json!({"text":String::from_utf8_lossy(&bytes[..end]),"truncated":data.truncated && after.is_none_or(|a|a<data.offset),"status":data.status,"offset":data.offset+skip as u64,"nextOffset":data.offset+(skip+end) as u64,"exitCode":data.exit_code}),
        )
    }
    pub async fn write(&self, id: &str, text: &str) -> Result<Value> {
        ensure!(
            text.len() <= 32 * 1024 && !text.contains('\0'),
            "terminal input must be at most 32 KiB without NUL"
        );
        let job = self
            .jobs
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(id)
            .cloned()
            .context("terminal does not belong to this session")?;
        ensure!(job.active(), "terminal has exited");
        let input = job
            .input
            .as_ref()
            .context("terminal was not started with interactive:true or pty:true")?;
        #[cfg(windows)]
        let text = if job
            .terminal
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_some()
        {
            text.replace("\r\n", "\r").replace('\n', "\r")
        } else {
            text.to_owned()
        };
        tokio::time::timeout(Duration::from_secs(2), input.send(text.as_bytes().to_vec()))
            .await
            .context("terminal input queue is busy")?
            .context("terminal input closed")?;
        Ok(json!({"accepted":true,"bytes":text.len()}))
    }
    pub fn resize(&self, id: &str, rows: u16, cols: u16) -> Result<Value> {
        ensure!(
            (10..=500).contains(&rows) && (10..=500).contains(&cols),
            "terminal dimensions must be 10..500"
        );
        let job = self
            .jobs
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(id)
            .cloned()
            .context("terminal does not belong to this session")?;
        job.terminal
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .context("terminal is not an active PTY")?
            .resize(portable_pty::PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })?;
        Ok(json!({"resized":true}))
    }
    pub async fn stop(&self, id: &str) -> Result<Value> {
        let job = self
            .jobs
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(id)
            .cloned()
            .context("terminal does not belong to this session")?;
        // Subscribe before checking state to avoid missing an exit racing this request.
        let done = job.done.notified();
        tokio::pin!(done);
        done.as_mut().enable();
        {
            let mut data = job.data.lock().unwrap_or_else(|e| e.into_inner());
            if !matches!(data.status, "running" | "stopping") {
                return Ok(json!({"terminated":false}));
            }
            data.status = "stopping";
        }
        job.cancel.cancel();
        tokio::time::timeout(Duration::from_secs(9), done)
            .await
            .context("terminal shutdown is still pending")?;
        Ok(json!({"terminated":true}))
    }
    pub async fn shutdown(&self) {
        let ids: Vec<_> = {
            let jobs = self.jobs.lock().unwrap_or_else(|e| e.into_inner());
            self.closing.store(true, Ordering::SeqCst);
            for job in jobs.values() {
                job.cancel.cancel();
            }
            jobs.values()
                .filter(|job| job.active())
                .map(|job| job.id.clone())
                .collect()
        };
        for id in ids {
            let _ = self.stop(&id).await;
        }
    }
}
impl Drop for ProcessManager {
    fn drop(&mut self) {
        for job in self
            .jobs
            .get_mut()
            .unwrap_or_else(|e| e.into_inner())
            .values()
        {
            job.cancel.cancel();
        }
    }
}
async fn pump(mut stream: impl tokio::io::AsyncRead + Unpin, job: Arc<Job>) {
    let mut bytes = [0u8; 8192];
    loop {
        match stream.read(&mut bytes).await {
            Ok(0) | Err(_) => break,
            Ok(count) => job.append(&bytes[..count]),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn incremental_output_never_splits_a_valid_unicode_sequence() {
        let manager = ProcessManager::default();
        let job = Arc::new(Job {
            id: "unicode".into(),
            command: String::new(),
            cwd: PathBuf::new(),
            started_at: 0,
            data: Mutex::new(Data {
                status: "running",
                output: vec![],
                truncated: false,
                exit_code: None,
                offset: 0,
                last_notified: std::time::Instant::now(),
            }),
            cancel: CancellationToken::new(),
            done: Notify::new(),
            input: None,
            terminal: Mutex::new(None),
            notifier: None,
        });
        manager
            .jobs
            .lock()
            .unwrap()
            .insert("unicode".into(), job.clone());
        job.append(&"🦖".as_bytes()[..2]);
        let first = manager.read("unicode").unwrap();
        assert_eq!(first["text"], "");
        assert_eq!(first["nextOffset"], 0);
        job.append(&"🦖".as_bytes()[2..]);
        let second = manager.read_since("unicode", Some(0)).unwrap();
        assert_eq!(second["text"], "🦖");
        assert_eq!(second["nextOffset"], 4);
        job.append("á🦖".repeat(20000).as_bytes());
        let tail = manager.read("unicode").unwrap();
        assert!(!tail["text"].as_str().unwrap().contains('�'));
        assert_eq!(tail["truncated"], true);
    }
    fn command() -> &'static str {
        if cfg!(windows) {
            "Write-Output 'ready'; Start-Sleep -Seconds 60"
        } else {
            "printf 'ready\\n'; sleep 60"
        }
    }
    #[tokio::test]
    async fn stop_one_owned_terminal_keeps_its_peer_and_replay_never_relaunches() {
        let manager = ProcessManager::default();
        let cwd = std::env::temp_dir();
        let input = json!({"command":command(),"background":true});
        manager
            .start(&cwd, &input, "first", &CancellationToken::new())
            .unwrap();
        manager
            .start(&cwd, &input, "second", &CancellationToken::new())
            .unwrap();
        assert_eq!(manager.list()["processes"].as_array().unwrap().len(), 2);
        manager
            .start(&cwd, &input, "first", &CancellationToken::new())
            .unwrap();
        assert!(manager.stop("foreign").await.is_err());
        assert_eq!(manager.stop("first").await.unwrap()["terminated"], true);
        assert_eq!(manager.read("first").unwrap()["status"], "stopped");
        assert_eq!(manager.read("second").unwrap()["status"], "running");
        assert_eq!(
            manager
                .start(&cwd, &input, "first", &CancellationToken::new())
                .unwrap()["status"],
            "stopped"
        );
        manager.shutdown().await;
        assert_eq!(manager.read("second").unwrap()["status"], "stopped");
    }
    #[tokio::test]
    async fn captures_bounded_output_and_natural_exit() {
        let manager = ProcessManager::default();
        let command = if cfg!(windows) {
            "[Console]::Write(('x' * 100000)); Write-Output 'TAIL'"
        } else {
            "head -c 100000 /dev/zero | tr '\\0' x; printf TAIL"
        };
        manager
            .start(
                &std::env::temp_dir(),
                &json!({"command":command,"background":true}),
                "output",
                &CancellationToken::new(),
            )
            .unwrap();
        let started = std::time::Instant::now();
        let finished = tokio::time::timeout(Duration::from_secs(15), async {
            while manager.read("output").unwrap()["status"] == "running" {
                tokio::time::sleep(Duration::from_millis(30)).await;
            }
        })
        .await;
        let output = manager.read("output").unwrap();
        let text = output["text"].as_str().unwrap();
        assert!(
            finished.is_ok(),
            "still {} after {:?}: offset {}, {} bytes kept, ends with {:?}",
            output["status"],
            started.elapsed(),
            output["offset"],
            text.len(),
            &text[text.len().saturating_sub(40)..]
        );
        assert!(output["text"].as_str().unwrap().len() <= OUTPUT_LIMIT);
        assert_eq!(output["truncated"], true);
        assert!(output["text"].as_str().unwrap().contains("TAIL"));
    }
}
