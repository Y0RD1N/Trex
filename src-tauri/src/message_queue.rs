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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueDispatch {
    pub id: String,
    pub message: QueueMessage,
    /// Original unread predecessors, including IDs since removed or read.
    pub predecessors: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueSnapshot {
    /// Unread messages, in enqueue order (not timestamp order).
    pub messages: Vec<QueueMessage>,
    /// Claimed messages remain durable until the UI records and acknowledges them.
    pub receipt: Option<QueueReceipt>,
    /// Direct sends require explicit acknowledgement or user-reviewed restoration.
    /// Omitting an empty outbox preserves the legacy disk and command wire format.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub outbox: Vec<QueueDispatch>,
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
    if snapshot
        .messages
        .len()
        .saturating_add(claimed)
        .saturating_add(snapshot.outbox.len())
        > MAX_QUEUE_MESSAGES
    {
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
    if snapshot.outbox.len() > 1 {
        return Err("La cola ya contiene una reserva de envío directo.".into());
    }
    for dispatch in &snapshot.outbox {
        validate_id(&dispatch.id)?;
        if dispatch.predecessors.len() >= MAX_QUEUE_MESSAGES {
            return Err("La reserva contiene demasiados predecesores.".into());
        }
        let mut predecessors = HashSet::new();
        for id in &dispatch.predecessors {
            validate_id(id)?;
            if id == &dispatch.message.id || !predecessors.insert(id) {
                return Err("La reserva contiene predecesores no válidos o repetidos.".into());
            }
        }
    }
    let mut ids = HashSet::new();
    for message in snapshot
        .messages
        .iter()
        .chain(
            snapshot
                .receipt
                .iter()
                .flat_map(|receipt| receipt.messages.iter()),
        )
        .chain(snapshot.outbox.iter().map(|dispatch| &dispatch.message))
    {
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
pub(crate) fn atomic_replace(source: &Path, destination: &Path) -> io::Result<()> {
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
pub(crate) fn atomic_replace(source: &Path, destination: &Path) -> io::Result<()> {
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

/// Identical retries are idempotent while pending, read, or reserved for sending.
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
            .chain(snapshot.outbox.iter().map(|dispatch| &dispatch.message))
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

/// Edit only unread text. The compare-and-set and write share the inbox read lock.
/// Repeating the same result is a no-op, including after a lost success response.
pub(crate) fn update_in(
    data_dir: &Path,
    queue_id: &str,
    message_id: &str,
    text: &str,
    expected_text: &str,
) -> Result<QueueSnapshot, String> {
    validate_id(message_id)?;
    with_queue(data_dir, queue_id, |snapshot| {
        let message = snapshot
            .messages
            .iter_mut()
            .find(|message| message.id == message_id)
            .ok_or("El mensaje ya no está disponible para editar en la cola.")?;
        if message.text == text {
            return Ok(false);
        }
        if message.text != expected_text {
            return Err("El texto del mensaje ha cambiado; revisa la versión actual.".into());
        }
        message.text = text.into();
        // The complete snapshot is validated and bounded before atomic replacement.
        Ok(true)
    })
}

/// Reserve exactly the reviewed unread message, never one already read by MCP.
/// An existing reservation must be resolved explicitly, even for the same message:
/// a retry must not authorize an uncertain send a second time.
pub(crate) fn claim_direct_in(
    data_dir: &Path,
    queue_id: &str,
    message_id: &str,
    expected: &QueueMessage,
) -> Result<QueueSnapshot, String> {
    validate_id(message_id)?;
    with_queue(data_dir, queue_id, |snapshot| {
        if !snapshot.outbox.is_empty() {
            return Err("Revisa el envío directo pendiente antes de reservar otro mensaje.".into());
        }
        let index = snapshot
            .messages
            .iter()
            .position(|message| message.id == message_id)
            .ok_or("El mensaje ya no está disponible para envío directo en la cola.")?;
        if &snapshot.messages[index] != expected {
            return Err(
                "El mensaje ha cambiado; revisa la versión actual antes de enviarlo.".into(),
            );
        }
        let predecessors = snapshot.messages[..index]
            .iter()
            .map(|message| message.id.clone())
            .collect();
        let message = snapshot.messages.remove(index);
        snapshot.outbox.push(QueueDispatch {
            id: unique_id(),
            message,
            predecessors,
        });
        // Dispatch/predecessor bytes count toward the atomic file bound. If this
        // does not fit, save_unlocked fails before replacing the original inbox.
        Ok(true)
    })
}

/// Call only after the frontend has accepted the direct send. Stale/repeated IDs
/// cannot clear a later reservation or an inbox receipt.
pub(crate) fn ack_direct_in(
    data_dir: &Path,
    queue_id: &str,
    dispatch_id: &str,
) -> Result<QueueSnapshot, String> {
    validate_id(dispatch_id)?;
    with_queue(data_dir, queue_id, |snapshot| {
        let previous = snapshot.outbox.len();
        snapshot
            .outbox
            .retain(|dispatch| dispatch.id != dispatch_id);
        Ok(previous != snapshot.outbox.len())
    })
}

/// Explicit user review only: uncertain sends are never automatically replayed.
/// Restore relative to surviving unread predecessors, not creation timestamps.
pub(crate) fn restore_direct_in(
    data_dir: &Path,
    queue_id: &str,
    dispatch_id: &str,
) -> Result<QueueSnapshot, String> {
    validate_id(dispatch_id)?;
    with_queue(data_dir, queue_id, |snapshot| {
        let Some(index) = snapshot
            .outbox
            .iter()
            .position(|dispatch| dispatch.id == dispatch_id)
        else {
            return Ok(false);
        };
        let dispatch = snapshot.outbox.remove(index);
        let position = snapshot
            .messages
            .iter()
            .rposition(|message| dispatch.predecessors.contains(&message.id))
            .map_or(0, |index| index + 1);
        snapshot.messages.insert(position, dispatch.message);
        Ok(true)
    })
}

/// Missing unread messages are a no-op; read/reserved messages cannot be removed.
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
        if snapshot
            .outbox
            .iter()
            .any(|dispatch| dispatch.message.id == message_id)
        {
            return Err("El mensaje está reservado para envío directo; revisa ese envío.".into());
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
pub async fn message_queue_update(
    app: AppHandle,
    queue_id: String,
    message_id: String,
    text: String,
    expected_text: String,
) -> Result<QueueSnapshot, String> {
    with_app(app, move |dir| {
        update_in(dir, &queue_id, &message_id, &text, &expected_text)
    })
    .await
}

#[tauri::command]
pub async fn message_queue_claim_direct(
    app: AppHandle,
    queue_id: String,
    message_id: String,
    expected: QueueMessage,
) -> Result<QueueSnapshot, String> {
    with_app(app, move |dir| {
        claim_direct_in(dir, &queue_id, &message_id, &expected)
    })
    .await
}

#[tauri::command]
pub async fn message_queue_ack_direct(
    app: AppHandle,
    queue_id: String,
    dispatch_id: String,
) -> Result<QueueSnapshot, String> {
    with_app(app, move |dir| ack_direct_in(dir, &queue_id, &dispatch_id)).await
}

#[tauri::command]
pub async fn message_queue_restore_direct(
    app: AppHandle,
    queue_id: String,
    dispatch_id: String,
) -> Result<QueueSnapshot, String> {
    with_app(app, move |dir| {
        restore_direct_in(dir, &queue_id, &dispatch_id)
    })
    .await
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
            action @ ("race-read" | "race-edit" | "race-direct") => {
                fs::write(dir.join(format!("ready-{action}")), b"").unwrap();
                wait_for_file(&dir.join("release-race"));
                let result = match action {
                    "race-read" => read_in(&dir, "t-race-process"),
                    "race-edit" => update_in(
                        &dir,
                        "t-race-process",
                        "target",
                        "edited",
                        &message("target").text,
                    ),
                    "race-direct" => {
                        claim_direct_in(&dir, "t-race-process", "target", &message("target"))
                    }
                    _ => unreachable!(),
                };
                fs::write(
                    dir.join(format!("result-{action}")),
                    serde_json::to_vec(&result).unwrap(),
                )
                .unwrap();
            }
            #[cfg(windows)]
            "failed-unread" => {
                assert!(enqueue_in(&dir, "t-locked", message("later")).is_err());
                assert!(read_in(&dir, "t-locked").is_err());
                assert!(remove_in(&dir, "t-locked", "first").is_err());
                assert!(
                    update_in(&dir, "t-locked", "first", "edited", &message("first").text).is_err()
                );
                assert!(claim_direct_in(&dir, "t-locked", "first", &message("first")).is_err());
            }
            #[cfg(windows)]
            "failed-ack" => {
                let receipt = list_in(&dir, "t-locked").unwrap().receipt.unwrap();
                assert!(ack_in(&dir, "t-locked", &receipt.id).is_err());
            }
            #[cfg(windows)]
            "failed-direct" => {
                let dispatch = list_in(&dir, "t-locked").unwrap().outbox.remove(0);
                assert!(ack_direct_in(&dir, "t-locked", &dispatch.id).is_err());
                assert!(restore_direct_in(&dir, "t-locked", &dispatch.id).is_err());
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
            outbox: vec![],
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
            outbox: vec![],
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
                outbox: vec![],
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
    fn editing_preserves_fifo_metadata_images_and_identical_retries() {
        let dir = TestDir::new();
        let mut original = message("image");
        original.images.push(image(4));
        original
            .previews
            .push("data:image/png;base64,KioqKg==".into());
        original.created_at = 999;
        enqueue_in(&dir.0, "t-edit", message("before")).unwrap();
        enqueue_in(&dir.0, "t-edit", original.clone()).unwrap();
        enqueue_in(&dir.0, "t-edit", message("after")).unwrap();
        let updated = update_in(&dir.0, "t-edit", "image", "edited 🦖\n", &original.text).unwrap();
        let mut expected = original.clone();
        expected.text = "edited 🦖\n".into();
        assert_eq!(ids(&updated.messages), ["before", "image", "after"]);
        assert_eq!(updated.messages[1], expected);
        assert_eq!(list_in(&dir.0, "t-edit").unwrap(), updated);
        let bytes = fs::read(dir.path("t-edit")).unwrap();
        assert_eq!(
            update_in(&dir.0, "t-edit", "image", &expected.text, &original.text).unwrap(),
            updated
        );
        assert!(update_in(&dir.0, "t-edit", "image", "stale edit", &original.text).is_err());
        assert_eq!(fs::read(dir.path("t-edit")).unwrap(), bytes);
        let image_only = update_in(&dir.0, "t-edit", "image", " \n", &expected.text).unwrap();
        expected.text = " \n".into();
        assert_eq!(image_only.messages[1], expected);
    }

    #[test]
    fn editing_rejects_missing_read_reserved_and_empty_text_without_images() {
        let dir = TestDir::new();
        assert!(update_in(&dir.0, "t-missing", "absent", "new", "old").is_err());
        assert!(!dir.path("t-missing").exists());
        let original = message("target");
        enqueue_in(&dir.0, "t-edit", original.clone()).unwrap();
        let bytes = fs::read(dir.path("t-edit")).unwrap();
        assert!(update_in(&dir.0, "t-edit", "target", " \t\n", &original.text).is_err());
        assert_eq!(fs::read(dir.path("t-edit")).unwrap(), bytes);
        let read = read_in(&dir.0, "t-edit").unwrap();
        assert!(update_in(&dir.0, "t-edit", "target", "new", &original.text).is_err());
        assert!(update_in(&dir.0, "t-edit", "target", &original.text, &original.text).is_err());
        assert_eq!(list_in(&dir.0, "t-edit").unwrap(), read);
        ack_in(&dir.0, "t-edit", &read.receipt.unwrap().id).unwrap();
        enqueue_in(&dir.0, "t-edit", original.clone()).unwrap();
        let reserved = claim_direct_in(&dir.0, "t-edit", "target", &original).unwrap();
        assert!(update_in(&dir.0, "t-edit", "target", "new", &original.text).is_err());
        assert!(update_in(&dir.0, "t-edit", "target", &original.text, &original.text).is_err());
        assert_eq!(list_in(&dir.0, "t-edit").unwrap(), reserved);
    }

    #[test]
    fn direct_claim_checks_every_expected_field_and_refuses_replays_or_another_reservation() {
        let dir = TestDir::new();
        let mut original = message("target");
        original.images.push(image(4));
        original.previews.push("preview".into());
        enqueue_in(&dir.0, "t-direct", original.clone()).unwrap();
        enqueue_in(&dir.0, "t-direct", message("other")).unwrap();
        let bytes = fs::read(dir.path("t-direct")).unwrap();
        for field in 0..6 {
            let mut stale = original.clone();
            match field {
                0 => stale.id = "different".into(),
                1 => stale.text.push('!'),
                2 => stale.images[0].data = image(3).data,
                3 => stale.images[0].media_type = "image/jpeg".into(),
                4 => stale.previews.push("extra".into()),
                5 => stale.created_at += 1,
                _ => unreachable!(),
            }
            assert!(claim_direct_in(&dir.0, "t-direct", "target", &stale).is_err());
            assert_eq!(fs::read(dir.path("t-direct")).unwrap(), bytes);
        }
        assert!(claim_direct_in(&dir.0, "t-direct", "missing", &original).is_err());
        let reserved = claim_direct_in(&dir.0, "t-direct", "target", &original).unwrap();
        assert_eq!(reserved.outbox[0].message, original);
        assert_eq!(reserved.outbox[0].id.len(), RECEIPT_ID_BYTES);
        assert!(claim_direct_in(&dir.0, "t-direct", "target", &original).is_err());
        assert!(claim_direct_in(&dir.0, "t-direct", "other", &message("other")).is_err());
        assert_eq!(list_in(&dir.0, "t-direct").unwrap(), reserved);
        ack_direct_in(&dir.0, "t-direct", &reserved.outbox[0].id).unwrap();
        let read = read_in(&dir.0, "t-direct").unwrap();
        assert!(claim_direct_in(&dir.0, "t-direct", "other", &message("other")).is_err());
        assert_eq!(list_in(&dir.0, "t-direct").unwrap(), read);
    }

    #[test]
    fn outbox_is_backwards_compatible_durable_excluded_from_reads_and_enqueue_idempotent() {
        let dir = TestDir::new();
        let path = dir.path("t-direct");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let legacy = br#"{"messages":[],"receipt":null}"#;
        fs::write(&path, legacy).unwrap();
        assert_eq!(
            list_in(&dir.0, "t-direct").unwrap(),
            QueueSnapshot::default()
        );
        assert_eq!(encode_snapshot(&QueueSnapshot::default()).unwrap(), legacy);
        assert!(serde_json::to_value(QueueSnapshot::default())
            .unwrap()
            .get("outbox")
            .is_none());
        let mut target = message("target");
        target.images.push(image(4));
        target.previews.push("preview".into());
        enqueue_in(&dir.0, "t-direct", message("before")).unwrap();
        enqueue_in(&dir.0, "t-direct", target.clone()).unwrap();
        enqueue_in(&dir.0, "t-direct", message("after")).unwrap();
        let reserved = claim_direct_in(&dir.0, "t-direct", "target", &target).unwrap();
        assert_eq!(reserved.outbox[0].predecessors, ["before"]);
        assert_eq!(reserved.outbox[0].message, target);
        let disk = fs::read(&path).unwrap();
        assert_eq!(
            serde_json::from_slice::<QueueSnapshot>(&disk).unwrap(),
            reserved
        );
        assert_eq!(list_in(&dir.0, "t-direct").unwrap(), reserved);
        assert_eq!(
            enqueue_in(&dir.0, "t-direct", target.clone()).unwrap(),
            reserved
        );
        let mut duplicate = target;
        duplicate.text.push('!');
        assert!(enqueue_in(&dir.0, "t-direct", duplicate).is_err());
        assert!(remove_in(&dir.0, "t-direct", "target").is_err());
        assert_eq!(fs::read(&path).unwrap(), disk);
        let read = read_in(&dir.0, "t-direct").unwrap();
        assert_eq!(
            ids(&read.receipt.as_ref().unwrap().messages),
            ["before", "after"]
        );
        assert_eq!(read.outbox, reserved.outbox);
        assert_eq!(read_in(&dir.0, "t-direct").unwrap(), read);
        let acked = ack_in(&dir.0, "t-direct", &read.receipt.unwrap().id).unwrap();
        assert_eq!(acked.outbox, reserved.outbox);
        assert!(acked.messages.is_empty());
        assert!(acked.receipt.is_none());
        for _ in 0..3 {
            assert_eq!(read_in(&dir.0, "t-direct").unwrap(), acked);
        }
        assert_eq!(list_in(&dir.0, "t-direct").unwrap(), acked);
    }

    #[test]
    fn direct_acknowledgements_only_clear_the_matching_reservation() {
        let dir = TestDir::new();
        enqueue_in(&dir.0, "t-direct-ack", message("first")).unwrap();
        enqueue_in(&dir.0, "t-direct-ack", message("inbox")).unwrap();
        let first = claim_direct_in(&dir.0, "t-direct-ack", "first", &message("first"))
            .unwrap()
            .outbox
            .remove(0);
        let receipt = read_in(&dir.0, "t-direct-ack").unwrap().receipt.unwrap();
        let pending = enqueue_in(&dir.0, "t-direct-ack", message("later")).unwrap();
        assert_eq!(ack_in(&dir.0, "t-direct-ack", &first.id).unwrap(), pending);
        assert_eq!(
            ack_direct_in(&dir.0, "t-direct-ack", &receipt.id).unwrap(),
            pending
        );
        assert_eq!(
            restore_direct_in(&dir.0, "t-direct-ack", "stale").unwrap(),
            pending
        );
        let acked = ack_direct_in(&dir.0, "t-direct-ack", &first.id).unwrap();
        assert!(acked.outbox.is_empty());
        assert_eq!(acked.receipt, Some(receipt.clone()));
        assert_eq!(ids(&acked.messages), ["later"]);
        assert_eq!(
            ack_direct_in(&dir.0, "t-direct-ack", &first.id).unwrap(),
            acked
        );
        let next = claim_direct_in(&dir.0, "t-direct-ack", "later", &message("later")).unwrap();
        assert_ne!(next.outbox[0].id, first.id);
        assert_eq!(
            ack_direct_in(&dir.0, "t-direct-ack", &first.id).unwrap(),
            next
        );
        assert_eq!(
            restore_direct_in(&dir.0, "t-direct-ack", &first.id).unwrap(),
            next
        );
        let inbox_acked = ack_in(&dir.0, "t-direct-ack", &receipt.id).unwrap();
        assert_eq!(inbox_acked.outbox, next.outbox);
        assert_eq!(
            ack_direct_in(&dir.0, "t-direct-ack", &next.outbox[0].id).unwrap(),
            QueueSnapshot::default()
        );
    }

    #[test]
    fn explicit_restoration_preserves_original_fifo_relative_to_surviving_unread_predecessors() {
        let dir = TestDir::new();
        let mut target = message("c");
        target.images.push(image(4));
        target.previews.push("preview".into());
        target.created_at = 1;
        for item in [message("a"), message("b"), target.clone(), message("d")] {
            enqueue_in(&dir.0, "t-restore", item).unwrap();
        }
        let reserved = claim_direct_in(&dir.0, "t-restore", "c", &target).unwrap();
        let dispatch = &reserved.outbox[0];
        assert_eq!(dispatch.predecessors, ["a", "b"]);
        remove_in(&dir.0, "t-restore", "b").unwrap();
        enqueue_in(&dir.0, "t-restore", message("e")).unwrap();
        let restored = restore_direct_in(&dir.0, "t-restore", &dispatch.id).unwrap();
        assert_eq!(ids(&restored.messages), ["a", "c", "d", "e"]);
        assert_eq!(restored.messages[1], target);
        assert!(restored.outbox.is_empty());
        assert_eq!(
            restore_direct_in(&dir.0, "t-restore", &dispatch.id).unwrap(),
            restored
        );
        let reserved = claim_direct_in(&dir.0, "t-restore", "c", &target).unwrap();
        let receipt = read_in(&dir.0, "t-restore").unwrap().receipt.unwrap();
        enqueue_in(&dir.0, "t-restore", message("new-arrival")).unwrap();
        let restored = restore_direct_in(&dir.0, "t-restore", &reserved.outbox[0].id).unwrap();
        assert_eq!(ids(&restored.messages), ["c", "new-arrival"]);
        assert_eq!(restored.messages[0], target);
        assert_eq!(restored.receipt, Some(receipt));
        assert_eq!(enqueue_in(&dir.0, "t-restore", target).unwrap(), restored);
    }

    #[test]
    fn fifty_message_limit_includes_outbox_receipts_and_unread_together() {
        let dir = TestDir::new();
        for index in 0..MAX_QUEUE_MESSAGES {
            enqueue_in(&dir.0, "t-count-direct", message(&format!("m-{index}"))).unwrap();
        }
        let target = message("m-25");
        claim_direct_in(&dir.0, "t-count-direct", &target.id, &target).unwrap();
        let read = read_in(&dir.0, "t-count-direct").unwrap();
        let before = fs::read(dir.path("t-count-direct")).unwrap();
        assert!(enqueue_in(&dir.0, "t-count-direct", message("overflow")).is_err());
        assert_eq!(
            enqueue_in(&dir.0, "t-count-direct", target.clone()).unwrap(),
            read
        );
        assert_eq!(fs::read(dir.path("t-count-direct")).unwrap(), before);
        ack_in(&dir.0, "t-count-direct", &read.receipt.unwrap().id).unwrap();
        for index in 0..MAX_QUEUE_MESSAGES - 1 {
            enqueue_in(&dir.0, "t-count-direct", message(&format!("new-{index}"))).unwrap();
        }
        let full = list_in(&dir.0, "t-count-direct").unwrap();
        assert_eq!(full.messages.len(), MAX_QUEUE_MESSAGES - 1);
        assert_eq!(full.outbox.len(), 1);
        assert!(enqueue_in(&dir.0, "t-count-direct", message("overflow")).is_err());
        assert_eq!(list_in(&dir.0, "t-count-direct").unwrap(), full);
        let restored = restore_direct_in(&dir.0, "t-count-direct", &full.outbox[0].id).unwrap();
        assert_eq!(restored.messages.len(), MAX_QUEUE_MESSAGES);
        assert_eq!(restored.messages[0], target);
    }

    #[test]
    fn outbox_validation_rejects_invalid_images_duplicate_ids_and_invalid_reservations() {
        let dir = TestDir::new();
        let valid = QueueSnapshot {
            outbox: vec![QueueDispatch {
                id: "dispatch".into(),
                message: message("target"),
                predecessors: vec!["historical".into()],
            }],
            ..QueueSnapshot::default()
        };
        assert!(encode_snapshot(&valid).is_ok());
        fs::create_dir_all(dir.0.join("message-queues")).unwrap();
        for case in 0..13 {
            let mut invalid = valid.clone();
            match case {
                0 => invalid.outbox.push(valid.outbox[0].clone()),
                1 => invalid.messages.push(message("target")),
                2 => {
                    invalid.receipt = Some(QueueReceipt {
                        id: "receipt".into(),
                        messages: vec![message("target")],
                    })
                }
                3 => invalid.outbox[0].id = "../bad".into(),
                4 => invalid.outbox[0].predecessors = vec!["bad/id".into()],
                5 => invalid.outbox[0].predecessors = vec!["target".into()],
                6 => invalid.outbox[0].predecessors = vec!["same".into(), "same".into()],
                7 => {
                    invalid.outbox[0].predecessors = (0..MAX_QUEUE_MESSAGES)
                        .map(|index| format!("m-{index}"))
                        .collect()
                }
                8 => invalid.outbox[0].message.images.push(QueueImage {
                    media_type: "text/plain".into(),
                    data: "AQID".into(),
                }),
                9 => invalid.outbox[0].message.images.push(QueueImage {
                    media_type: "image/png".into(),
                    data: "not base64!".into(),
                }),
                10 => invalid.outbox[0]
                    .message
                    .images
                    .push(image(MAX_IMAGE_BYTES + 1)),
                11 => {
                    invalid.messages = (0..MAX_QUEUE_MESSAGES)
                        .map(|index| message(&format!("m-{index}")))
                        .collect()
                }
                12 => invalid.outbox[0]
                    .message
                    .previews
                    .push("p".repeat(MAX_QUEUE_BYTES)),
                _ => unreachable!(),
            }
            assert!(
                encode_snapshot(&invalid).is_err(),
                "accepted invalid case {case}"
            );
            let bytes = serde_json::to_vec(&invalid).unwrap();
            fs::write(dir.path("t-bad-outbox"), &bytes).unwrap();
            assert!(list_in(&dir.0, "t-bad-outbox").is_err());
            assert!(ack_direct_in(&dir.0, "t-bad-outbox", "dispatch").is_err());
            assert!(restore_direct_in(&dir.0, "t-bad-outbox", "dispatch").is_err());
            assert_eq!(fs::read(dir.path("t-bad-outbox")).unwrap(), bytes);
        }
    }

    #[test]
    fn direct_claim_bound_includes_all_predecessors_and_preserves_storage_on_overflow() {
        let dir = TestDir::new();
        let predecessors: Vec<_> = (0..MAX_QUEUE_MESSAGES - 1)
            .map(|index| message(&format!("m-{index:03}-{}", "p".repeat(122))))
            .collect();
        let mut target = message("target");
        target.text = "x".into();
        let mut candidate = QueueSnapshot {
            messages: predecessors.clone(),
            receipt: None,
            outbox: vec![QueueDispatch {
                id: unique_id(),
                message: target.clone(),
                predecessors: predecessors
                    .iter()
                    .map(|message| message.id.clone())
                    .collect(),
            }],
        };
        let extra = MAX_QUEUE_BYTES
            - RECEIPT_OVERHEAD_BYTES
            - serde_json::to_vec(&candidate).unwrap().len();
        target.text.push_str(&"x".repeat(extra));
        candidate.outbox[0].message = target.clone();
        assert_eq!(
            encode_snapshot(&candidate).unwrap().len(),
            MAX_QUEUE_BYTES - RECEIPT_OVERHEAD_BYTES
        );
        let mut original = QueueSnapshot {
            messages: predecessors,
            ..QueueSnapshot::default()
        };
        original.messages.push(target.clone());
        save_unlocked(&dir.path("t-exact-direct"), &original).unwrap();
        let claimed = claim_direct_in(&dir.0, "t-exact-direct", "target", &target).unwrap();
        assert_eq!(claimed.outbox[0].message, target);
        assert_eq!(
            claimed.outbox[0].predecessors,
            candidate.outbox[0].predecessors
        );
        assert_eq!(
            fs::metadata(dir.path("t-exact-direct")).unwrap().len() as usize,
            MAX_QUEUE_BYTES - RECEIPT_OVERHEAD_BYTES
        );
        let read = read_in(&dir.0, "t-exact-direct").unwrap();
        assert_eq!(
            read.receipt.as_ref().unwrap().messages.len(),
            MAX_QUEUE_MESSAGES - 1
        );
        assert_eq!(read.outbox, claimed.outbox);
        assert_eq!(
            fs::metadata(dir.path("t-exact-direct")).unwrap().len() as usize,
            MAX_QUEUE_BYTES
        );
        assert_eq!(list_in(&dir.0, "t-exact-direct").unwrap(), read);

        // Existing legacy queues at their original receipt-reserved bound stay
        // readable; a larger direct reservation is refused without mutation.
        let extra =
            MAX_QUEUE_BYTES - RECEIPT_OVERHEAD_BYTES - serde_json::to_vec(&original).unwrap().len();
        original
            .messages
            .last_mut()
            .unwrap()
            .text
            .push_str(&"x".repeat(extra));
        save_unlocked(&dir.path("t-full-direct"), &original).unwrap();
        let expected = original.messages.last().unwrap();
        let before = fs::read(dir.path("t-full-direct")).unwrap();
        assert!(claim_direct_in(&dir.0, "t-full-direct", "target", expected).is_err());
        assert!(update_in(
            &dir.0,
            "t-full-direct",
            "target",
            &format!("{}x", expected.text),
            &expected.text
        )
        .is_err());
        assert_eq!(fs::read(dir.path("t-full-direct")).unwrap(), before);
        assert_eq!(list_in(&dir.0, "t-full-direct").unwrap(), original);
        let receipt = read_in(&dir.0, "t-full-direct").unwrap().receipt.unwrap();
        assert_eq!(receipt.messages, original.messages);
        assert_eq!(
            fs::metadata(dir.path("t-full-direct")).unwrap().len() as usize,
            MAX_QUEUE_BYTES
        );
    }

    #[test]
    fn concurrent_read_edit_and_direct_claim_never_lose_duplicate_or_mutate_claimed_messages() {
        let dir = TestDir::new();
        for iteration in 0..16 {
            let queue = format!("t-race-thread-{iteration}");
            let mut target = message("target");
            target.images.push(image(4));
            target.previews.push("preview".into());
            enqueue_in(&dir.0, &queue, target.clone()).unwrap();
            let barrier = Arc::new(Barrier::new(4));
            let spawn = |operation| {
                let path = dir.0.clone();
                let queue = queue.clone();
                let barrier = barrier.clone();
                let target = target.clone();
                thread::spawn(move || {
                    barrier.wait();
                    match operation {
                        0 => read_in(&path, &queue),
                        1 => update_in(&path, &queue, "target", "edited", &target.text),
                        2 => claim_direct_in(&path, &queue, "target", &target),
                        _ => unreachable!(),
                    }
                })
            };
            let read = spawn(0);
            let edit = spawn(1);
            let claim = spawn(2);
            barrier.wait();
            read.join().unwrap().unwrap();
            let edited = edit.join().unwrap().is_ok();
            let direct = claim.join().unwrap().is_ok();
            let final_state = list_in(&dir.0, &queue).unwrap();
            assert!(final_state.messages.is_empty());
            assert_eq!(final_state.outbox.len(), usize::from(direct));
            let stored: Vec<_> = final_state
                .receipt
                .iter()
                .flat_map(|receipt| &receipt.messages)
                .chain(final_state.outbox.iter().map(|dispatch| &dispatch.message))
                .collect();
            assert_eq!(stored.len(), 1);
            if edited {
                target.text = "edited".into();
                assert!(!direct);
            }
            assert_eq!(stored[0], &target);
        }
    }

    #[test]
    fn concurrent_edits_compare_and_set_instead_of_overwriting_each_other() {
        let dir = TestDir::new();
        let target = message("target");
        enqueue_in(&dir.0, "t-edit-race", target.clone()).unwrap();
        let barrier = Arc::new(Barrier::new(3));
        let mut workers = Vec::new();
        for text in ["first edit", "second edit"] {
            let path = dir.0.clone();
            let original = target.text.clone();
            let barrier = barrier.clone();
            workers.push(thread::spawn(move || {
                barrier.wait();
                (
                    text,
                    update_in(&path, "t-edit-race", "target", text, &original),
                )
            }));
        }
        barrier.wait();
        let results: Vec<_> = workers
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .collect();
        assert_eq!(
            results.iter().filter(|(_, result)| result.is_ok()).count(),
            1
        );
        let winner = results.iter().find(|(_, result)| result.is_ok()).unwrap().0;
        assert_eq!(
            list_in(&dir.0, "t-edit-race").unwrap().messages[0].text,
            winner
        );
    }

    #[test]
    fn separate_process_read_edit_and_direct_claim_share_the_same_storage_lock() {
        for _ in 0..4 {
            let dir = TestDir::new();
            let mut target = message("target");
            enqueue_in(&dir.0, "t-race-process", target.clone()).unwrap();
            let actions = ["race-read", "race-edit", "race-direct"];
            let mut workers: Vec<_> = actions
                .iter()
                .map(|action| TestProcess::spawn(&dir.0, action, "unused"))
                .collect();
            for action in actions {
                wait_for_file(&dir.0.join(format!("ready-{action}")));
            }
            fs::write(dir.0.join("release-race"), b"").unwrap();
            for worker in &mut workers {
                worker.finish();
            }
            let results: Vec<Result<QueueSnapshot, String>> = actions
                .iter()
                .map(|action| {
                    serde_json::from_slice(
                        &fs::read(dir.0.join(format!("result-{action}"))).unwrap(),
                    )
                    .unwrap()
                })
                .collect();
            assert!(results[0].is_ok());
            let final_state = list_in(&dir.0, "t-race-process").unwrap();
            assert!(final_state.messages.is_empty());
            assert_eq!(final_state.outbox.len(), usize::from(results[2].is_ok()));
            let stored: Vec<_> = final_state
                .receipt
                .iter()
                .flat_map(|receipt| &receipt.messages)
                .chain(final_state.outbox.iter().map(|dispatch| &dispatch.message))
                .collect();
            assert_eq!(stored.len(), 1);
            if results[1].is_ok() {
                target.text = "edited".into();
                assert!(results[2].is_err());
            }
            assert_eq!(stored[0], &target);
        }
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
            outbox: vec![],
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
        assert!(update_in(
            &dir.0,
            "t-locked",
            "first",
            "edited",
            &message("first").text
        )
        .is_err());
        assert!(claim_direct_in(&dir.0, "t-locked", "first", &message("first")).is_err());
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
        let reserved = claim_direct_in(&dir.0, "t-locked", "later", &message("later")).unwrap();
        let held = hold_destination();
        let before = fs::read(dir.path("t-locked")).unwrap();
        TestProcess::spawn(&dir.0, "failed-direct", "unused").finish();
        assert!(ack_direct_in(&dir.0, "t-locked", &reserved.outbox[0].id).is_err());
        assert!(restore_direct_in(&dir.0, "t-locked", &reserved.outbox[0].id).is_err());
        assert_eq!(fs::read(dir.path("t-locked")).unwrap(), before);
        assert_eq!(list_in(&dir.0, "t-locked").unwrap(), reserved);
        assert_eq!(
            fs::read_dir(dir.0.join("message-queues")).unwrap().count(),
            1
        );
        drop(held);
        let restored = restore_direct_in(&dir.0, "t-locked", &reserved.outbox[0].id).unwrap();
        assert_eq!(ids(&restored.messages), ["later"]);
        assert!(restored.outbox.is_empty());
    }
}
