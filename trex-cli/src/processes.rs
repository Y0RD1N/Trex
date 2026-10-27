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
struct Job {
    id: String,
    command: String,
    cwd: PathBuf,
    started_at: u64,
    data: Mutex<Data>,
    cancel: CancellationToken,
    done: Notify,
}
struct Data {
    status: &'static str,
    output: Vec<u8>,
    truncated: bool,
    exit_code: Option<i32>,
}
impl Job {
    fn summary(&self) -> Value {
        let data = self.data.lock().unwrap_or_else(|e| e.into_inner());
        json!({"id":self.id,"command":self.command,"cwd":self.cwd,"startedAt":self.started_at,"status":data.status,"exitCode":data.exit_code})
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
            let drop = data.output.len() - OUTPUT_LIMIT;
            data.output.drain(..drop);
            data.truncated = true;
        }
    }
}
#[derive(Default)]
pub struct ProcessManager {
    jobs: Mutex<BTreeMap<String, Arc<Job>>>,
    closing: AtomicBool,
}
impl ProcessManager {
    pub fn start(
        &self,
        cwd: &Path,
        input: &Value,
        operation_id: &str,
        cancel: &CancellationToken,
    ) -> Result<Value> {
        ensure!(!cancel.is_cancelled(), "background launch cancelled");
        let object = input.as_object().context("shell input must be an object")?;
        ensure!(object.keys().all(|key| ["command", "background"].contains(&key.as_str())), "background shell accepts only command and background; stop it explicitly instead of a timeout");
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
        let (mut child, mut guard) = crate::tools::spawn_owned_shell(&cwd, command)?;
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
            }),
            cancel: CancellationToken::new(),
            done: Notify::new(),
        });
        jobs.insert(operation_id.into(), job.clone());
        let task = job.clone();
        tokio::spawn(async move {
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
            task.done.notify_waiters();
        });
        Ok(job.summary())
    }
    pub fn list(&self) -> Value {
        json!({"processes":self.jobs.lock().unwrap_or_else(|e| e.into_inner()).values().map(|job| job.summary()).collect::<Vec<_>>()})
    }
    pub fn read(&self, id: &str) -> Result<Value> {
        let job = self
            .jobs
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(id)
            .cloned()
            .context("terminal does not belong to this session")?;
        let data = job.data.lock().unwrap_or_else(|e| e.into_inner());
        Ok(
            json!({"text":String::from_utf8_lossy(&data.output),"truncated":data.truncated,"status":data.status}),
        )
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
        tokio::time::timeout(Duration::from_secs(15), async {
            while manager.read("output").unwrap()["status"] == "running" {
                tokio::time::sleep(Duration::from_millis(30)).await;
            }
        })
        .await
        .unwrap();
        let output = manager.read("output").unwrap();
        assert!(output["text"].as_str().unwrap().len() <= OUTPUT_LIMIT);
        assert_eq!(output["truncated"], true);
        assert!(output["text"].as_str().unwrap().contains("TAIL"));
    }
}
