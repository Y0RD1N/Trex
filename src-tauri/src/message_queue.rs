//! Durable per-tab inboxes. Reading claims the current FIFO batch; only a
//! matching acknowledgement releases that receipt. Listing never claims data.
//!
//! All storage helpers take the application's data directory, not the queue
//! directory. An OS file lock serializes storage across threads and app instances.
use base64::Engine;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs::{self, File, OpenOptions, TryLockError};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

pub(crate) const MAX_QUEUE_MESSAGES: usize = 50;
pub(crate) const MAX_QUEUE_BYTES: usize = 16 * 1024 * 1024;
// The frontend currently prepares at most 3,700,000 decoded bytes per image.
pub(crate) const MAX_IMAGE_BYTES: usize = 4 * 1024 * 1024;
const MAX_ID_BYTES: usize = 128;
const RECEIPT_ID_BYTES: usize = 60;
// Claiming replaces `null` with a receipt and moves the same message array.
// Reserve this space so a successfully enqueued batch can always be claimed.
const RECEIPT_OVERHEAD_BYTES: usize =
    b"{\"id\":\"\",\"messages\":[]}".len() + RECEIPT_ID_BYTES - b"null".len();
const STORAGE_LOCK_TIMEOUT: Duration = Duration::from_secs(5);
static NEXT_ID: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueImage {
    pub media_type: String,
    /// Bare standard base64, as produced by chatImages.ts.
    pub data: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueMessage {
    pub id: String,
    pub text: String,
    #[serde(default)]
    pub images: Vec<QueueImage>,
    #[serde(default)]
    pub previews: Vec<String>,
    pub created_at: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueReceipt {
    pub id: String,
    pub messages: Vec<QueueMessage>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueSnapshot {
    /// Unread messages, in enqueue order (not timestamp order).
    pub messages: Vec<QueueMessage>,
    /// Claimed messages remain durable until the UI records and acknowledges them.
    pub receipt: Option<QueueReceipt>,
}

fn validate_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || id.len() > MAX_ID_BYTES
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        return Err(
            "El identificador debe tener entre 1 y 128 caracteres alfanuméricos o guiones.".into(),
        );
    }
    Ok(())
}

fn queue_path(data_dir: &Path, queue_id: &str) -> Result<PathBuf, String> {
    validate_id(queue_id)?;
    if !queue_id.starts_with("t-") || queue_id.len() <= 2 {
        return Err("El identificador de la cola debe empezar por «t-» y tener un sufijo.".into());
    }
    Ok(data_dir
        .join("message-queues")
        .join(format!("{queue_id}.json")))
}

fn validate_message(message: &QueueMessage) -> Result<(), String> {
    validate_id(&message.id)?;
    if message.text.trim().is_empty() && message.images.is_empty() {
        return Err("El mensaje debe contener texto o una imagen.".into());
    }
    for image in &message.images {
        if !matches!(
            image.media_type.as_str(),
            "image/png" | "image/jpeg" | "image/gif" | "image/webp"
        ) {
            return Err("Solo se admiten imágenes PNG, JPEG, GIF o WebP.".into());
        }
        // Check the encoded bound before allocating, then the exact decoded
        // length: limit and limit+1 can have the same base64 string length.
        if image.data.len() > MAX_IMAGE_BYTES.div_ceil(3) * 4 {
            return Err("Cada imagen puede ocupar como máximo 4 MiB.".into());
        }
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(&image.data)
            .map_err(|_| "La imagen no contiene base64 válido.".to_string())?;
        if bytes.is_empty() || bytes.len() > MAX_IMAGE_BYTES {
            return Err("La imagen debe contener datos y ocupar como máximo 4 MiB.".into());
        }
    }
    Ok(())
}

fn validate_snapshot(snapshot: &QueueSnapshot) -> Result<(), String> {
    let claimed = snapshot
        .receipt
        .as_ref()
        .map_or(0, |receipt| receipt.messages.len());
    if snapshot.messages.len().saturating_add(claimed) > MAX_QUEUE_MESSAGES {
        return Err(
            "La cola admite como máximo 50 mensajes, incluidos los pendientes de confirmar.".into(),
        );
    }
    if let Some(receipt) = &snapshot.receipt {
        validate_id(&receipt.id)?;
        if receipt.messages.is_empty() {
            return Err("El recibo guardado no contiene mensajes.".into());
        }
    }
    let mut ids = HashSet::new();
    for message in snapshot.messages.iter().chain(
        snapshot
            .receipt
            .iter()
            .flat_map(|receipt| receipt.messages.iter()),
    ) {
        validate_message(message)?;
        if !ids.insert(message.id.as_str()) {
            return Err("La cola contiene identificadores de mensaje repetidos.".into());
        }
    }
    Ok(())
}

#[derive(Default)]
struct BoundedJson(Vec<u8>);

impl Write for BoundedJson {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if bytes.len() > MAX_QUEUE_BYTES.saturating_sub(self.0.len()) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "La cola supera 16 MiB.",
            ));
        }
        self.0.extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

fn encode_snapshot(snapshot: &QueueSnapshot) -> Result<Vec<u8>, String> {
    validate_snapshot(snapshot)?;
    let mut bytes = BoundedJson::default();
    serde_json::to_writer(&mut bytes, snapshot)
        .map_err(|error| format!("No se pudo serializar la cola (máximo 16 MiB): {error}"))?;
    if snapshot.receipt.is_none()
        && !snapshot.messages.is_empty()
        && bytes.0.len() > MAX_QUEUE_BYTES - RECEIPT_OVERHEAD_BYTES
    {
        return Err("La cola supera 16 MiB al reservar espacio para confirmar la lectura.".into());
    }
    Ok(bytes.0)
}

fn load_unlocked(path: &Path) -> Result<QueueSnapshot, String> {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Ok(QueueSnapshot::default())
        }
        Err(error) => return Err(format!("No se pudo abrir la cola: {error}")),
    };
    let mut bytes = Vec::new();
    file.take((MAX_QUEUE_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("No se pudo leer la cola: {error}"))?;
    if bytes.len() > MAX_QUEUE_BYTES {
        return Err("La cola guardada supera 16 MiB.".into());
    }
    let snapshot: QueueSnapshot = serde_json::from_slice(&bytes)
        .map_err(|error| format!("La cola guardada está dañada: {error}"))?;
    // Never turn corrupt storage into an empty queue and overwrite it.
    encode_snapshot(&snapshot)?;
    Ok(snapshot)
}

fn unique_id() -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!(
        "r-{now:032x}-{:08x}-{:016x}",
        std::process::id(),
        NEXT_ID.fetch_add(1, Ordering::Relaxed)
    )
}

#[cfg(windows)]
fn atomic_replace(source: &Path, destination: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "kernel32")]
    extern "system" {
        fn MoveFileExW(existing: *const u16, new: *const u16, flags: u32) -> i32;
    }
    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    // REPLACE_EXISTING | WRITE_THROUGH; same-directory temporary files stay
    // on the same volume. Never delete the previous inbox before replacement.
    let result = unsafe { MoveFileExW(source.as_ptr(), destination.as_ptr(), 0x1 | 0x8) };
    if result == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn atomic_replace(source: &Path, destination: &Path) -> io::Result<()> {
    fs::rename(source, destination)
}

fn save_unlocked(path: &Path, snapshot: &QueueSnapshot) -> Result<(), String> {
    let bytes = encode_snapshot(snapshot)?;
    let parent = path.parent().ok_or("La ruta de la cola no es válida.")?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("No se pudo crear la carpeta de colas: {error}"))?;
    #[cfg(unix)]
    let directory = File::open(parent)
        .map_err(|error| format!("No se pudo abrir la carpeta de colas: {error}"))?;
    let mut temporary = None;
    for _ in 0..16 {
        let candidate = parent.join(format!(".{}.tmp", unique_id()));
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        match options.open(&candidate) {
            Ok(file) => {
                temporary = Some((candidate, file));
                break;
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(format!(
                    "No se pudo crear el archivo temporal de la cola: {error}"
                ))
            }
        }
    }
    let (temporary_path, mut file) =
        temporary.ok_or("No se pudo crear un archivo temporal único para la cola.")?;
    let result = file.write_all(&bytes).and_then(|_| file.sync_all());
    drop(file);
    let result = result.and_then(|_| atomic_replace(&temporary_path, path));
    if let Err(error) = result {
        let _ = fs::remove_file(&temporary_path);
        return Err(format!("No se pudo guardar la cola: {error}"));
    }
    #[cfg(unix)]
    directory
        .sync_all()
        .map_err(|error| format!("No se pudo sincronizar la carpeta de colas: {error}"))?;
    Ok(())
}

fn lock_storage(data_dir: &Path, timeout: Duration) -> Result<File, String> {
    fs::create_dir_all(data_dir)
        .map_err(|error| format!("No se pudo crear la carpeta de datos de las colas: {error}"))?;
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    // Keep this inode for the lifetime of the storage directory: deleting or
    // replacing it could let two processes lock different files. A directory-wide
    // lock also serializes case aliases before the Windows canonicalization check.
    // It lives outside message-queues so listing missing queues creates no inbox.
    let file = options
        .open(data_dir.join(".message-queues.lock"))
        .map_err(|error| format!("No se pudo abrir el bloqueo de las colas: {error}"))?;
    let started = Instant::now();
    loop {
        match file.try_lock() {
            // Closing the handle releases the OS lock, including on errors or
            // process termination. Never lock the JSON file that we replace.
            Ok(()) => return Ok(file),
            Err(TryLockError::WouldBlock) => {
                let remaining = timeout.saturating_sub(started.elapsed());
                if remaining.is_zero() {
                    return Err(
                        "El almacenamiento de colas está ocupado; vuelve a intentarlo.".into(),
                    );
                }
                std::thread::sleep(remaining.min(Duration::from_millis(10)));
            }
            Err(TryLockError::Error(error)) => {
                return Err(format!(
                    "No se pudo bloquear el almacenamiento de colas: {error}"
                ));
            }
        }
    }
}

fn with_queue(
    data_dir: &Path,
    queue_id: &str,
    operation: impl FnOnce(&mut QueueSnapshot) -> Result<bool, String>,
) -> Result<QueueSnapshot, String> {
    let path = queue_path(data_dir, queue_id)?;
    let _guard = lock_storage(data_dir, STORAGE_LOCK_TIMEOUT)?;
    #[cfg(windows)]
    match fs::canonicalize(&path) {
        // Windows normally treats t-A and t-a as the same filename. Refuse
        // alternate casing instead of exposing a different tab's inbox.
        Ok(actual) if actual.file_name() != path.file_name() => {
            return Err(
                "El identificador de la cola difiere en mayúsculas de una cola existente.".into(),
            );
        }
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(format!("No se pudo resolver la ruta de la cola: {error}")),
    }
    let mut snapshot = load_unlocked(&path)?;
    if operation(&mut snapshot)? {
        save_unlocked(&path, &snapshot)?;
    }
    Ok(snapshot)
}

pub(crate) fn list_in(data_dir: &Path, queue_id: &str) -> Result<QueueSnapshot, String> {
    with_queue(data_dir, queue_id, |_| Ok(false))
}

/// Identical retries are idempotent while a message is pending or claimed.
/// Reusing an existing ID with different content is an error.
pub(crate) fn enqueue_in(
    data_dir: &Path,
    queue_id: &str,
    message: QueueMessage,
) -> Result<QueueSnapshot, String> {
    validate_message(&message)?;
    with_queue(data_dir, queue_id, |snapshot| {
        let existing = snapshot
            .messages
            .iter()
            .chain(
                snapshot
                    .receipt
                    .iter()
                    .flat_map(|receipt| receipt.messages.iter()),
            )
            .find(|existing| existing.id == message.id);
        if let Some(existing) = existing {
            return if existing == &message {
                Ok(false)
            } else {
                Err("Ya existe otro mensaje con ese identificador.".into())
            };
        }
        snapshot.messages.push(message);
        Ok(true)
    })
}

/// Missing unread messages are a no-op; claimed messages cannot be removed.
pub(crate) fn remove_in(
    data_dir: &Path,
    queue_id: &str,
    message_id: &str,
) -> Result<QueueSnapshot, String> {
    validate_id(message_id)?;
    with_queue(data_dir, queue_id, |snapshot| {
        if snapshot.receipt.iter().any(|receipt| {
            receipt
                .messages
                .iter()
                .any(|message| message.id == message_id)
        }) {
            return Err(
                "El agente ya ha leído ese mensaje; está pendiente de confirmación.".into(),
            );
        }
        let previous = snapshot.messages.len();
        snapshot.messages.retain(|message| message.id != message_id);
        Ok(previous != snapshot.messages.len())
    })
}

/// Claim every currently unread message in FIFO order, or replay the existing
/// receipt. Receipt IDs are generated here, never supplied/reused by callers.
pub(crate) fn read_in(data_dir: &Path, queue_id: &str) -> Result<QueueSnapshot, String> {
    with_queue(data_dir, queue_id, |snapshot| {
        if snapshot.receipt.is_some() || snapshot.messages.is_empty() {
            return Ok(false);
        }
        snapshot.receipt = Some(QueueReceipt {
            id: unique_id(),
            messages: std::mem::take(&mut snapshot.messages),
        });
        Ok(true)
    })
}

/// Stale and repeated acknowledgements are no-ops, even if another batch has
/// since been claimed. Only the matching receipt is removed, never unread data.
pub(crate) fn ack_in(
    data_dir: &Path,
    queue_id: &str,
    receipt_id: &str,
) -> Result<QueueSnapshot, String> {
    validate_id(receipt_id)?;
    with_queue(data_dir, queue_id, |snapshot| {
        if snapshot
            .receipt
            .as_ref()
            .is_some_and(|receipt| receipt.id == receipt_id)
        {
            snapshot.receipt = None;
            return Ok(true);
        }
        Ok(false)
    })
}

async fn with_app(
    app: AppHandle,
    operation: impl FnOnce(&Path) -> Result<QueueSnapshot, String> + Send + 'static,
) -> Result<QueueSnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let data_dir = app
            .path()
            .app_data_dir()
            .map_err(|error| format!("No se encontró la carpeta de datos de la app: {error}"))?;
        operation(&data_dir)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn message_queue_list(app: AppHandle, queue_id: String) -> Result<QueueSnapshot, String> {
    with_app(app, move |dir| list_in(dir, &queue_id)).await
}

#[tauri::command]
pub async fn message_queue_enqueue(
    app: AppHandle,
    queue_id: String,
    message: QueueMessage,
) -> Result<QueueSnapshot, String> {
    with_app(app, move |dir| enqueue_in(dir, &queue_id, message)).await
}

#[tauri::command]
pub async fn message_queue_remove(
    app: AppHandle,
    queue_id: String,
    message_id: String,
) -> Result<QueueSnapshot, String> {
    with_app(app, move |dir| remove_in(dir, &queue_id, &message_id)).await
}

#[tauri::command]
pub async fn message_queue_read(app: AppHandle, queue_id: String) -> Result<QueueSnapshot, String> {
    with_app(app, move |dir| read_in(dir, &queue_id)).await
}

#[tauri::command]
pub async fn message_queue_ack(
    app: AppHandle,
    queue_id: String,
    receipt_id: String,
) -> Result<QueueSnapshot, String> {
    with_app(app, move |dir| ack_in(dir, &queue_id, &receipt_id)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::{Child, Command, Stdio};
    use std::sync::{Arc, Barrier};
    use std::thread;

    struct TestDir(PathBuf);
    impl TestDir {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("trex-message-queue-{}", unique_id()));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
        fn path(&self, queue_id: &str) -> PathBuf {
            queue_path(&self.0, queue_id).unwrap()
        }
    }
    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn message(id: &str) -> QueueMessage {
        QueueMessage {
            id: id.into(),
            text: format!("Mensaje {id} 🦖\n"),
            images: vec![],
            previews: vec![],
            created_at: 123,
        }
    }
    fn image(bytes: usize) -> QueueImage {
        QueueImage {
            media_type: "image/png".into(),
            data: base64::engine::general_purpose::STANDARD.encode(vec![42; bytes]),
        }
    }
    fn ids(messages: &[QueueMessage]) -> Vec<&str> {
        messages.iter().map(|message| message.id.as_str()).collect()
    }

    struct TestProcess(Child);

    impl TestProcess {
        fn spawn(dir: &Path, action: &str, id: &str) -> Self {
            Self(
                Command::new(std::env::current_exe().unwrap())
                    .args([
                        "--exact",
                        "message_queue::tests::storage_process_worker",
                        "--nocapture",
                    ])
                    .env("TREX_QUEUE_TEST_DIR", dir)
                    .env("TREX_QUEUE_TEST_ACTION", action)
                    .env("TREX_QUEUE_TEST_ID", id)
                    .stdout(Stdio::null())
                    .spawn()
                    .unwrap(),
            )
        }

        fn finish(&mut self) {
            let deadline = Instant::now() + Duration::from_secs(15);
            loop {
                if let Some(status) = self.0.try_wait().unwrap() {
                    assert!(status.success(), "queue child failed: {status}");
                    return;
                }
                assert!(Instant::now() < deadline, "queue child did not finish");
                thread::sleep(Duration::from_millis(10));
            }
        }
    }

    impl Drop for TestProcess {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    fn wait_for_file(path: &Path) {
        let deadline = Instant::now() + Duration::from_secs(10);
        while !path.exists() {
            assert!(Instant::now() < deadline, "missing child marker {path:?}");
            thread::sleep(Duration::from_millis(10));
        }
    }

    // Re-executed by TestProcess so each worker has independent Rust statics and
    // file handles. A thread-only regression cannot detect process-local locks.
    #[test]
    fn storage_process_worker() {
        let Some(dir) = std::env::var_os("TREX_QUEUE_TEST_DIR") else {
            return;
        };
        let dir = PathBuf::from(dir);
        let id = std::env::var("TREX_QUEUE_TEST_ID").unwrap();
        match std::env::var("TREX_QUEUE_TEST_ACTION").unwrap().as_str() {
            "enqueue" => {
                fs::write(dir.join(format!("started-{id}")), b"").unwrap();
                with_queue(&dir, "t-process", |snapshot| {
                    fs::write(dir.join(format!("loaded-{id}")), b"").unwrap();
                    if id == "first" {
                        wait_for_file(&dir.join("release-first"));
                    }
                    snapshot.messages.push(message(&id));
                    Ok(true)
                })
                .unwrap();
            }
            "timeout" => {
                let started = Instant::now();
                let error = lock_storage(&dir, Duration::from_millis(100)).unwrap_err();
                assert!(error.contains("ocupado"), "{error}");
                assert!(started.elapsed() >= Duration::from_millis(100));
                assert!(started.elapsed() < Duration::from_secs(5));
            }
            #[cfg(windows)]
            "failed-unread" => {
                assert!(enqueue_in(&dir, "t-locked", message("later")).is_err());
                assert!(read_in(&dir, "t-locked").is_err());
                assert!(remove_in(&dir, "t-locked", "first").is_err());
            }
            #[cfg(windows)]
            "failed-ack" => {
                let receipt = list_in(&dir, "t-locked").unwrap().receipt.unwrap();
                assert!(ack_in(&dir, "t-locked", &receipt.id).is_err());
            }
            action => panic!("unknown queue child action: {action}"),
        }
    }

    #[test]
    fn separate_processes_serialize_the_entire_load_modify_replace_transaction() {
        let dir = TestDir::new();
        enqueue_in(&dir.0, "t-process", message("seed")).unwrap();
        let mut first = TestProcess::spawn(&dir.0, "enqueue", "first");
        wait_for_file(&dir.0.join("loaded-first"));
        let mut second = TestProcess::spawn(&dir.0, "enqueue", "second");
        wait_for_file(&dir.0.join("started-second"));
        thread::sleep(Duration::from_millis(100));
        assert!(!dir.0.join("loaded-second").exists());
        assert!(second.0.try_wait().unwrap().is_none());
        assert_eq!(
            ids(&load_unlocked(&dir.path("t-process")).unwrap().messages),
            ["seed"]
        );
        fs::write(dir.0.join("release-first"), b"").unwrap();
        first.finish();
        second.finish();
        assert_eq!(
            ids(&list_in(&dir.0, "t-process").unwrap().messages),
            ["seed", "first", "second"]
        );
        assert!(dir.0.join(".message-queues.lock").is_file());
    }

    #[test]
    fn separate_process_lock_contention_has_a_bounded_wait() {
        let dir = TestDir::new();
        let held = lock_storage(&dir.0, STORAGE_LOCK_TIMEOUT).unwrap();
        TestProcess::spawn(&dir.0, "timeout", "unused").finish();
        drop(held);
        assert_eq!(
            list_in(&dir.0, "t-process").unwrap(),
            QueueSnapshot::default()
        );
    }

    #[test]
    fn killed_process_releases_storage_lock_without_saving_partial_changes() {
        let dir = TestDir::new();
        enqueue_in(&dir.0, "t-process", message("seed")).unwrap();
        let mut first = TestProcess::spawn(&dir.0, "enqueue", "first");
        wait_for_file(&dir.0.join("loaded-first"));
        first.0.kill().unwrap();
        first.0.wait().unwrap();
        TestProcess::spawn(&dir.0, "enqueue", "after-crash").finish();
        assert_eq!(
            ids(&list_in(&dir.0, "t-process").unwrap().messages),
            ["seed", "after-crash"]
        );
    }

    #[test]
    fn listing_and_reading_missing_queues_do_not_create_files() {
        let dir = TestDir::new();
        assert_eq!(
            list_in(&dir.0, "t-empty").unwrap(),
            QueueSnapshot::default()
        );
        assert_eq!(
            read_in(&dir.0, "t-empty").unwrap(),
            QueueSnapshot::default()
        );
        assert_eq!(
            ack_in(&dir.0, "t-empty", "old-receipt").unwrap(),
            QueueSnapshot::default()
        );
        assert!(!dir.0.join("message-queues").exists());
    }

    #[test]
    fn fifo_is_enqueue_order_and_claims_survive_reload_and_repeated_reads() {
        let dir = TestDir::new();
        let mut first = message("first");
        first.created_at = 999;
        enqueue_in(&dir.0, "t-fifo", first.clone()).unwrap();
        let pending = enqueue_in(&dir.0, "t-fifo", message("second")).unwrap();
        assert_eq!(ids(&pending.messages), ["first", "second"]);
        assert!(pending.receipt.is_none());
        let claimed = read_in(&dir.0, "t-fifo").unwrap();
        assert!(claimed.messages.is_empty());
        let receipt = claimed.receipt.as_ref().unwrap();
        assert_eq!(receipt.id.len(), RECEIPT_ID_BYTES);
        assert_eq!(ids(&receipt.messages), ["first", "second"]);
        assert_eq!(receipt.messages[0], first);
        assert_eq!(list_in(&dir.0, "t-fifo").unwrap(), claimed);
        let file = fs::read(dir.path("t-fifo")).unwrap();
        assert_eq!(
            serde_json::from_slice::<QueueSnapshot>(&file).unwrap(),
            claimed
        );
        for _ in 0..3 {
            assert_eq!(read_in(&dir.0, "t-fifo").unwrap(), claimed);
        }
        assert_eq!(fs::read(dir.path("t-fifo")).unwrap(), file);
    }

    #[test]
    fn acknowledgement_preserves_arrivals_and_stale_acknowledgements_preserve_new_receipts() {
        let dir = TestDir::new();
        enqueue_in(&dir.0, "t-ack", message("first")).unwrap();
        let first = read_in(&dir.0, "t-ack").unwrap().receipt.unwrap();
        enqueue_in(&dir.0, "t-ack", message("later")).unwrap();
        let replay = read_in(&dir.0, "t-ack").unwrap();
        assert_eq!(replay.receipt, Some(first.clone()));
        assert_eq!(ids(&replay.messages), ["later"]);
        assert_eq!(ack_in(&dir.0, "t-ack", "unknown").unwrap(), replay);
        let acked = ack_in(&dir.0, "t-ack", &first.id).unwrap();
        assert!(acked.receipt.is_none());
        assert_eq!(ids(&acked.messages), ["later"]);
        assert_eq!(ack_in(&dir.0, "t-ack", &first.id).unwrap(), acked);
        let next = read_in(&dir.0, "t-ack").unwrap();
        assert_ne!(next.receipt.as_ref().unwrap().id, first.id);
        assert_eq!(ack_in(&dir.0, "t-ack", &first.id).unwrap(), next);
        let empty = ack_in(&dir.0, "t-ack", &next.receipt.unwrap().id).unwrap();
        assert_eq!(empty, QueueSnapshot::default());
    }

    #[test]
    fn removal_only_changes_unread_messages() {
        let dir = TestDir::new();
        for id in ["a", "b", "c"] {
            enqueue_in(&dir.0, "t-remove", message(id)).unwrap();
        }
        assert_eq!(
            ids(&remove_in(&dir.0, "t-remove", "b").unwrap().messages),
            ["a", "c"]
        );
        read_in(&dir.0, "t-remove").unwrap();
        enqueue_in(&dir.0, "t-remove", message("later")).unwrap();
        let file = fs::read(dir.path("t-remove")).unwrap();
        assert!(remove_in(&dir.0, "t-remove", "a").is_err());
        assert_eq!(fs::read(dir.path("t-remove")).unwrap(), file);
        assert_eq!(
            remove_in(&dir.0, "t-remove", "absent").unwrap(),
            list_in(&dir.0, "t-remove").unwrap()
        );
        let removed = remove_in(&dir.0, "t-remove", "later").unwrap();
        assert!(removed.messages.is_empty());
        assert_eq!(ids(&removed.receipt.unwrap().messages), ["a", "c"]);
    }

    #[test]
    fn queues_and_application_data_directories_are_isolated() {
        let left = TestDir::new();
        let right = TestDir::new();
        enqueue_in(&left.0, "t-one", message("left")).unwrap();
        enqueue_in(&left.0, "t-two", message("other-tab")).unwrap();
        enqueue_in(&right.0, "t-one", message("right")).unwrap();
        read_in(&left.0, "t-one").unwrap();
        assert_eq!(
            ids(&list_in(&left.0, "t-two").unwrap().messages),
            ["other-tab"]
        );
        assert_eq!(
            ids(&list_in(&right.0, "t-one").unwrap().messages),
            ["right"]
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_rejects_queue_ids_that_alias_another_tabs_filename() {
        let dir = TestDir::new();
        let saved = enqueue_in(&dir.0, "t-UpperCase", message("private")).unwrap();
        assert!(list_in(&dir.0, "t-uppercase").is_err());
        assert!(read_in(&dir.0, "t-uppercase").is_err());
        assert!(enqueue_in(&dir.0, "t-uppercase", message("different")).is_err());
        assert_eq!(list_in(&dir.0, "t-UpperCase").unwrap(), saved);
    }

    #[test]
    fn queue_and_message_ids_reject_paths_and_oversized_values() {
        let dir = TestDir::new();
        for id in [
            "",
            "t-",
            "other",
            "t-../outside",
            "t-..\\outside",
            "t-a/b",
            "t-a:b",
            "t-a.b",
            "t-ñ",
            "t-a\0",
            "t-a ",
        ] {
            assert!(list_in(&dir.0, id).is_err(), "accepted {id:?}");
        }
        assert!(list_in(&dir.0, &format!("t-{}", "a".repeat(127))).is_err());
        assert!(list_in(&dir.0, &format!("t-{}", "a".repeat(126))).is_ok());
        assert!(list_in(&dir.0, "t-A0-z").is_ok());
        for id in ["", "../x", "with space", "é", "a\n"] {
            assert!(enqueue_in(&dir.0, "t-valid", message(id)).is_err());
            assert!(remove_in(&dir.0, "t-valid", id).is_err());
            assert!(ack_in(&dir.0, "t-valid", id).is_err());
        }
        assert!(enqueue_in(&dir.0, "t-valid", message(&"a".repeat(129))).is_err());
        assert!(!dir.0.join("message-queues").exists());
    }

    #[test]
    fn duplicate_enqueue_is_idempotent_but_never_overwrites_content() {
        let dir = TestDir::new();
        let original = message("same");
        let pending = enqueue_in(&dir.0, "t-retry", original.clone()).unwrap();
        assert_eq!(
            enqueue_in(&dir.0, "t-retry", original.clone()).unwrap(),
            pending
        );
        let claimed = read_in(&dir.0, "t-retry").unwrap();
        assert_eq!(
            enqueue_in(&dir.0, "t-retry", original.clone()).unwrap(),
            claimed
        );
        let mut changed = original;
        changed.text.push('!');
        assert!(enqueue_in(&dir.0, "t-retry", changed).is_err());
        assert_eq!(list_in(&dir.0, "t-retry").unwrap(), claimed);
    }

    #[test]
    fn fifty_message_limit_includes_unacknowledged_receipts() {
        let dir = TestDir::new();
        for index in 0..MAX_QUEUE_MESSAGES {
            enqueue_in(&dir.0, "t-count", message(&format!("m-{index}"))).unwrap();
        }
        let pending = list_in(&dir.0, "t-count").unwrap();
        assert!(enqueue_in(&dir.0, "t-count", message("overflow")).is_err());
        assert_eq!(list_in(&dir.0, "t-count").unwrap(), pending);
        let claimed = read_in(&dir.0, "t-count").unwrap();
        assert!(enqueue_in(&dir.0, "t-count", message("overflow")).is_err());
        ack_in(&dir.0, "t-count", &claimed.receipt.unwrap().id).unwrap();
        assert!(enqueue_in(&dir.0, "t-count", message("now-fits")).is_ok());
    }

    #[test]
    fn image_validation_and_camel_case_round_trip() {
        let dir = TestDir::new();
        let mut item = message("image");
        item.text = " \n".into();
        assert!(enqueue_in(&dir.0, "t-image", item.clone()).is_err());
        item.images.push(image(4));
        item.previews.push("data:image/png;base64,KioqKg==".into());
        let saved = enqueue_in(&dir.0, "t-image", item.clone()).unwrap();
        assert_eq!(saved.messages, [item.clone()]);
        let json = serde_json::to_value(&saved).unwrap();
        assert_eq!(json["messages"][0]["createdAt"], 123);
        assert_eq!(json["messages"][0]["images"][0]["mediaType"], "image/png");
        assert_eq!(list_in(&dir.0, "t-image").unwrap(), saved);
        for mime in ["image/svg+xml", "text/plain", "image/jpg"] {
            item.images[0].media_type = mime.into();
            assert!(validate_message(&item).is_err());
        }
        for mime in ["image/png", "image/jpeg", "image/gif", "image/webp"] {
            item.images[0] = image(1);
            item.images[0].media_type = mime.into();
            assert!(validate_message(&item).is_ok());
        }
        for data in ["", "not base64!", "data:image/png;base64,KioqKg=="] {
            item.images[0].data = data.into();
            assert!(validate_message(&item).is_err());
        }
    }

    #[test]
    fn exact_decoded_image_limit_is_accepted_and_one_extra_byte_preserves_storage() {
        let dir = TestDir::new();
        let mut item = message("limit");
        item.images.push(image(MAX_IMAGE_BYTES));
        let saved = enqueue_in(&dir.0, "t-image-limit", item).unwrap();
        let before = fs::read(dir.path("t-image-limit")).unwrap();
        let mut extra = message("too-big");
        extra.images.push(image(MAX_IMAGE_BYTES + 1));
        assert_eq!(
            saved.messages[0].images[0].data.len(),
            extra.images[0].data.len()
        );
        assert!(enqueue_in(&dir.0, "t-image-limit", extra).is_err());
        assert_eq!(fs::read(dir.path("t-image-limit")).unwrap(), before);
    }

    #[test]
    fn json_byte_limit_reserves_receipt_space_and_accounts_for_previews_and_escaping() {
        let dir = TestDir::new();
        let mut item = message("large");
        item.text.clear();
        item.text.push('x');
        let base = QueueSnapshot {
            messages: vec![item.clone()],
            receipt: None,
        };
        let overhead = serde_json::to_vec(&base).unwrap().len() - 1;
        item.text = "x".repeat(MAX_QUEUE_BYTES - RECEIPT_OVERHEAD_BYTES - overhead);
        let pending = enqueue_in(&dir.0, "t-bytes", item).unwrap();
        assert_eq!(
            fs::metadata(dir.path("t-bytes")).unwrap().len() as usize,
            MAX_QUEUE_BYTES - RECEIPT_OVERHEAD_BYTES
        );
        let before = fs::read(dir.path("t-bytes")).unwrap();
        let mut one_more = pending.clone();
        one_more.messages[0].text.push('x');
        assert!(encode_snapshot(&one_more).is_err());
        assert!(enqueue_in(&dir.0, "t-bytes", message("overflow")).is_err());
        assert_eq!(fs::read(dir.path("t-bytes")).unwrap(), before);
        let claimed = read_in(&dir.0, "t-bytes").unwrap();
        assert_eq!(
            fs::metadata(dir.path("t-bytes")).unwrap().len() as usize,
            MAX_QUEUE_BYTES
        );
        assert_eq!(list_in(&dir.0, "t-bytes").unwrap(), claimed);
        let mut previews = message("previews");
        previews.previews.push("p".repeat(MAX_QUEUE_BYTES));
        assert!(enqueue_in(&dir.0, "t-previews", previews).is_err());
        let mut escaped = message("escaped");
        escaped.text = "\0".repeat(MAX_QUEUE_BYTES / 6);
        assert!(enqueue_in(&dir.0, "t-escaped", escaped).is_err());
        assert!(!dir.path("t-previews").exists());
        assert!(!dir.path("t-escaped").exists());
    }

    #[test]
    fn corrupt_or_oversized_storage_is_never_replaced() {
        let dir = TestDir::new();
        fs::create_dir_all(dir.0.join("message-queues")).unwrap();
        let mut duplicate = QueueSnapshot {
            messages: vec![message("same")],
            receipt: None,
        };
        duplicate.receipt = Some(QueueReceipt {
            id: "receipt".into(),
            messages: vec![message("same")],
        });
        let invalid = [
            b"broken-json".to_vec(),
            serde_json::to_vec(&duplicate).unwrap(),
            serde_json::to_vec(&QueueSnapshot {
                messages: vec![],
                receipt: Some(QueueReceipt {
                    id: "receipt".into(),
                    messages: vec![],
                }),
            })
            .unwrap(),
            vec![b' '; MAX_QUEUE_BYTES + 1],
        ];
        for bytes in invalid {
            fs::write(dir.path("t-bad"), &bytes).unwrap();
            assert!(list_in(&dir.0, "t-bad").is_err());
            assert!(enqueue_in(&dir.0, "t-bad", message("new")).is_err());
            assert!(read_in(&dir.0, "t-bad").is_err());
            assert!(ack_in(&dir.0, "t-bad", "receipt").is_err());
            assert_eq!(fs::read(dir.path("t-bad")).unwrap(), bytes);
        }
    }

    #[test]
    fn concurrent_enqueues_and_reads_never_lose_or_double_claim_messages() {
        let dir = TestDir::new();
        enqueue_in(&dir.0, "t-race", message("seed")).unwrap();
        let barrier = Arc::new(Barrier::new(17));
        let mut workers = Vec::new();
        for index in 0..16 {
            let path = dir.0.clone();
            let barrier = barrier.clone();
            workers.push(thread::spawn(move || {
                barrier.wait();
                enqueue_in(&path, "t-race", message(&format!("m-{index}"))).unwrap();
                read_in(&path, "t-race").unwrap().receipt.unwrap()
            }));
        }
        barrier.wait();
        let receipts: Vec<_> = workers
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .collect();
        assert!(receipts.iter().all(|receipt| receipt == &receipts[0]));
        let snapshot = list_in(&dir.0, "t-race").unwrap();
        let receipt = snapshot.receipt.as_ref().unwrap();
        assert_eq!(receipt.messages[0].id, "seed");
        let all: HashSet<_> = snapshot
            .messages
            .iter()
            .chain(receipt.messages.iter())
            .map(|message| message.id.clone())
            .collect();
        assert_eq!(all.len(), 17);
        for index in 0..16 {
            assert!(all.contains(&format!("m-{index}")));
        }
        let later = ack_in(&dir.0, "t-race", &receipt.id).unwrap();
        assert_eq!(later.messages, snapshot.messages);
    }

    #[test]
    fn failed_atomic_replacement_leaves_previous_file_and_no_temporary_files() {
        let dir = TestDir::new();
        let path = dir.0.join("target.json");
        fs::write(&path, b"previous durable contents").unwrap();
        assert!(atomic_replace(&dir.0.join("missing.tmp"), &path).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"previous durable contents");
        let blocked = dir.path("t-blocked");
        fs::create_dir_all(&blocked).unwrap();
        let snapshot = QueueSnapshot {
            messages: vec![message("new")],
            receipt: None,
        };
        assert!(save_unlocked(&blocked, &snapshot).is_err());
        assert!(blocked.is_dir());
        assert_eq!(fs::read_dir(blocked.parent().unwrap()).unwrap().count(), 1);
        assert!(fs::read_dir(&blocked).unwrap().next().is_none());
    }

    #[cfg(windows)]
    #[test]
    fn failed_windows_writes_preserve_unread_messages_and_unacknowledged_receipts() {
        use std::os::windows::fs::OpenOptionsExt;

        let dir = TestDir::new();
        enqueue_in(&dir.0, "t-locked", message("first")).unwrap();
        let hold_destination = || {
            OpenOptions::new()
                .read(true)
                // Allow readers/writers but deny replacement/deletion.
                .share_mode(0x1 | 0x2)
                .open(dir.path("t-locked"))
                .unwrap()
        };
        let held = hold_destination();
        let before = fs::read(dir.path("t-locked")).unwrap();
        TestProcess::spawn(&dir.0, "failed-unread", "unused").finish();
        assert!(enqueue_in(&dir.0, "t-locked", message("later")).is_err());
        assert!(read_in(&dir.0, "t-locked").is_err());
        assert!(remove_in(&dir.0, "t-locked", "first").is_err());
        assert_eq!(fs::read(dir.path("t-locked")).unwrap(), before);
        drop(held);

        let receipt = read_in(&dir.0, "t-locked").unwrap().receipt.unwrap();
        let snapshot = enqueue_in(&dir.0, "t-locked", message("later")).unwrap();
        let held = hold_destination();
        TestProcess::spawn(&dir.0, "failed-ack", "unused").finish();
        assert!(ack_in(&dir.0, "t-locked", &receipt.id).is_err());
        assert_eq!(list_in(&dir.0, "t-locked").unwrap(), snapshot);
        assert_eq!(
            fs::read_dir(dir.0.join("message-queues")).unwrap().count(),
            1
        );
        drop(held);
        assert_eq!(
            ids(&ack_in(&dir.0, "t-locked", &receipt.id).unwrap().messages),
            ["later"]
        );
    }
}
