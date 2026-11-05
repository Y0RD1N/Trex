//! Archivos que el asistente comparte en el chat: datos para su tarjeta,
//! abrirlos con la aplicación del sistema, mostrarlos en su carpeta y
//! guardarlos (o una imagen del chat) donde elija el usuario.
//!
//! Las rutas llegan ya resueltas por la ventana (absolutas); `~/` se expande
//! aquí. Guardar solo escribe en el destino que el usuario eligió en el diálogo.
use base64::Engine;
use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileInfo {
    pub path: String,
    pub name: String,
    pub exists: bool,
    pub is_dir: bool,
    pub size: u64,
}

fn expand(path: &str) -> PathBuf {
    if let Some(rest) = path.strip_prefix("~/") {
        if let Some(home) = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")) {
            return PathBuf::from(home).join(rest);
        }
    }
    PathBuf::from(path)
}

pub(crate) fn info(path: &Path) -> FileInfo {
    let metadata = std::fs::metadata(path).ok();
    FileInfo {
        path: path.to_string_lossy().into_owned(),
        name: path.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default(),
        exists: metadata.is_some(),
        is_dir: metadata.as_ref().is_some_and(|m| m.is_dir()),
        size: metadata.as_ref().filter(|m| m.is_file()).map_or(0, |m| m.len()),
    }
}

/// Datos de varias rutas a la vez (una respuesta puede adjuntar varios archivos).
#[tauri::command]
pub async fn file_info(paths: Vec<String>) -> Vec<FileInfo> {
    tauri::async_runtime::spawn_blocking(move || paths.iter().map(|path| info(&expand(path))).collect())
        .await
        .unwrap_or_default()
}

// Un comando síncrono corre en el hilo de la ventana: abrir con el sistema
// puede tardar, así que estos van aparte.
#[tauri::command]
pub async fn open_file(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = expand(&path);
        if !path.exists() {
            return Err(format!("«{}» ya no existe.", path.display()));
        }
        tauri_plugin_opener::open_path(&path, None::<&str>).map_err(|e| format!("No se pudo abrir «{}»: {e}", path.display()))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn reveal_file(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = expand(&path);
        tauri_plugin_opener::reveal_item_in_dir(&path).map_err(|e| format!("No se pudo mostrar «{}»: {e}", path.display()))
    })
    .await
    .map_err(|e| e.to_string())?
}

pub(crate) fn copy_to(from: &Path, to: &Path) -> Result<(), String> {
    if !from.is_file() {
        return Err(format!("«{}» no es un archivo.", from.display()));
    }
    if from.canonicalize().ok() == to.canonicalize().ok() {
        return Ok(());
    }
    std::fs::copy(from, to).map(|_| ()).map_err(|e| format!("No se pudo guardar en «{}»: {e}", to.display()))
}

/// Copia un archivo compartido al destino elegido en el diálogo de guardar.
#[tauri::command]
pub async fn save_file_copy(from: String, to: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || copy_to(&expand(&from), Path::new(&to)))
        .await
        .map_err(|e| e.to_string())?
}

/// Lo más que cruza la IPC para una vista previa (un PDF grande, por ejemplo).
const PREVIEW_MAX_BYTES: u64 = 64 * 1024 * 1024;

/// Los primeros `limit` bytes de un archivo (todo, si es más pequeño).
pub(crate) fn read_prefix(path: &Path, limit: u64) -> Result<Vec<u8>, String> {
    use std::io::Read;
    let metadata = std::fs::metadata(path).map_err(|e| format!("No se pudo leer «{}»: {e}", path.display()))?;
    if !metadata.is_file() {
        return Err(format!("«{}» no es un archivo.", path.display()));
    }
    let limit = limit.min(PREVIEW_MAX_BYTES);
    let mut bytes = Vec::with_capacity(metadata.len().min(limit) as usize);
    std::fs::File::open(path)
        .and_then(|file| file.take(limit).read_to_end(&mut bytes))
        .map_err(|e| format!("No se pudo leer «{}»: {e}", path.display()))?;
    Ok(bytes)
}

/// Contenido de un archivo compartido para verlo en la app (texto, código o PDF).
/// Viaja en binario, sin base64: la ventana sabe por el tamaño si se cortó.
#[tauri::command]
pub async fn read_file_preview(path: String, limit: u64) -> Result<tauri::ipc::Response, String> {
    tauri::async_runtime::spawn_blocking(move || read_prefix(&expand(&path), limit).map(tauri::ipc::Response::new))
        .await
        .map_err(|e| e.to_string())?
}

/// Guarda una imagen del chat (por ejemplo, una captura pegada) que no tiene archivo.
#[tauri::command]
pub async fn save_file_data(to: String, data: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = base64::engine::general_purpose::STANDARD.decode(data.as_bytes()).map_err(|e| e.to_string())?;
        std::fs::write(&to, bytes).map_err(|e| format!("No se pudo guardar en «{to}»: {e}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn files_are_described_and_copied() {
        let dir = std::env::temp_dir().join(format!("trex-shared-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("informe.pdf");
        std::fs::write(&file, b"%PDF-1.7 hola").unwrap();

        let described = info(&file);
        assert_eq!((described.name.as_str(), described.exists, described.is_dir, described.size), ("informe.pdf", true, false, 13));
        let folder = info(&dir);
        assert_eq!((folder.exists, folder.is_dir, folder.size), (true, true, 0));
        assert!(!info(&dir.join("no-existe.txt")).exists);

        let copy = dir.join("copia.pdf");
        copy_to(&file, &copy).unwrap();
        assert_eq!(std::fs::read(&copy).unwrap(), b"%PDF-1.7 hola");
        copy_to(&file, &file).unwrap();
        assert_eq!(std::fs::read(&file).unwrap(), b"%PDF-1.7 hola", "guardar encima de sí mismo no lo vacía");
        assert!(copy_to(&dir, &copy).is_err());

        // La vista previa lee como mucho lo pedido, y nunca una carpeta.
        assert_eq!(read_prefix(&file, 4).unwrap(), b"%PDF");
        assert_eq!(read_prefix(&file, 1024).unwrap(), b"%PDF-1.7 hola");
        assert!(read_prefix(&dir, 10).is_err());
        assert!(read_prefix(&dir.join("no-existe.txt"), 10).is_err());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn home_is_expanded() {
        if let Some(home) = std::env::var_os("HOME") {
            assert_eq!(expand("~/a.txt"), PathBuf::from(home).join("a.txt"));
        }
        assert_eq!(expand("/tmp/a.txt"), PathBuf::from("/tmp/a.txt"));
    }
}
