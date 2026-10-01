//! Backpressure for PTY output. Credits are returned only after xterm parses
//! the bytes, so a fast producer cannot grow the WebView's queue indefinitely.
use std::sync::{Condvar, Mutex};

pub const OUTPUT_WINDOW_BYTES: usize = 256 * 1024;

#[derive(Default)]
struct Progress {
    pending: usize,
    stopped: bool,
}

pub struct OutputFlow {
    enabled: bool,
    progress: Mutex<Progress>,
    ready: Condvar,
}

impl OutputFlow {
    pub fn new(enabled: bool) -> Self {
        Self {
            enabled,
            progress: Mutex::new(Progress::default()),
            ready: Condvar::new(),
        }
    }

    // Called by the reader thread, never while holding the session map lock.
    pub fn reserve(&self, bytes: usize) -> bool {
        let Ok(progress) = self.progress.lock() else {
            return false;
        };
        let Ok(mut progress) = self.ready.wait_while(progress, |p| {
            self.enabled && !p.stopped && p.pending + bytes > OUTPUT_WINDOW_BYTES
        }) else {
            return false;
        };
        if progress.stopped {
            return false;
        }
        if self.enabled {
            progress.pending += bytes;
        }
        true
    }

    pub fn acknowledge(&self, bytes: usize) {
        if let Ok(mut progress) = self.progress.lock() {
            progress.pending = progress.pending.saturating_sub(bytes);
            self.ready.notify_one();
        }
    }

    // Closing a tab must also release a reader waiting for credits.
    pub fn stop(&self) {
        if let Ok(mut progress) = self.progress.lock() {
            progress.stopped = true;
            self.ready.notify_all();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{mpsc, Arc};
    use std::thread;
    use std::time::Duration;

    #[test]
    fn pauses_until_parsed_bytes_are_acknowledged() {
        let flow = Arc::new(OutputFlow::new(true));
        assert!(flow.reserve(OUTPUT_WINDOW_BYTES));
        let (tx, rx) = mpsc::channel();
        let reader = flow.clone();
        let handle = thread::spawn(move || {
            tx.send(reader.reserve(16_384)).unwrap();
        });
        assert!(rx.recv_timeout(Duration::from_millis(30)).is_err());
        flow.acknowledge(8192);
        assert!(rx.recv_timeout(Duration::from_millis(30)).is_err());
        flow.acknowledge(8192);
        assert!(rx.recv_timeout(Duration::from_secs(1)).unwrap());
        handle.join().unwrap();
        assert_eq!(flow.progress.lock().unwrap().pending, OUTPUT_WINDOW_BYTES);
    }

    #[test]
    fn closing_releases_a_blocked_reader() {
        let flow = Arc::new(OutputFlow::new(true));
        assert!(flow.reserve(OUTPUT_WINDOW_BYTES));
        let (tx, rx) = mpsc::channel();
        let reader = flow.clone();
        let handle = thread::spawn(move || {
            tx.send(reader.reserve(1)).unwrap();
        });
        assert!(rx.recv_timeout(Duration::from_millis(30)).is_err());
        flow.stop();
        assert!(!rx.recv_timeout(Duration::from_secs(1)).unwrap());
        handle.join().unwrap();
        assert!(!flow.reserve(1));
    }

    #[test]
    fn late_or_duplicate_acknowledgments_do_not_underflow() {
        let flow = OutputFlow::new(true);
        assert!(flow.reserve(42));
        flow.acknowledge(100);
        flow.acknowledge(100);
        assert_eq!(flow.progress.lock().unwrap().pending, 0);
        assert!(flow.reserve(OUTPUT_WINDOW_BYTES));
    }

    #[test]
    fn old_clients_can_opt_out_of_flow_control() {
        let flow = OutputFlow::new(false);
        for _ in 0..100 {
            assert!(flow.reserve(16_384));
        }
        assert_eq!(flow.progress.lock().unwrap().pending, 0);
        flow.stop();
        assert!(!flow.reserve(1));
    }

    #[cfg(unix)]
    #[test]
    fn real_pty_preserves_unicode_and_order_with_a_slow_consumer() {
        use portable_pty::{native_pty_system, CommandBuilder, PtySize};
        use std::io::Read;

        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        let line = "\x1b[32má✓漢字🚀\x1b[0m\n";
        let mut command = CommandBuilder::new("/bin/sh");
        command.arg("-c");
        command.arg(r#"stty -onlcr; i=0; while [ "$i" -lt 20000 ]; do printf '\033[32má✓漢字🚀\033[0m\n'; i=$((i+1)); done"#);
        command.env("LC_ALL", "C.UTF-8");
        let mut child = pair.slave.spawn_command(command).unwrap();
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().unwrap();
        let flow = Arc::new(OutputFlow::new(true));
        let reader_flow = flow.clone();
        let (tx, rx) = mpsc::channel();
        let producer = thread::spawn(move || {
            let mut buf = [0; 16384];
            loop {
                let n = match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => n,
                    Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(_) => break, // Unix PTYs may signal EOF with EIO.
                };
                assert!(reader_flow.reserve(n));
                assert!(reader_flow.progress.lock().unwrap().pending <= OUTPUT_WINDOW_BYTES);
                tx.send(buf[..n].to_vec()).unwrap();
            }
        });
        let mut received = Vec::new();
        while let Ok(chunk) = rx.recv_timeout(Duration::from_secs(5)) {
            thread::sleep(Duration::from_micros(100));
            received.extend_from_slice(&chunk);
            flow.acknowledge(chunk.len());
        }
        producer.join().unwrap();
        assert!(child.wait().unwrap().success());
        assert_eq!(received, line.repeat(20000).into_bytes());
        assert_eq!(flow.progress.lock().unwrap().pending, 0);
    }
}
