//! Adjuntos del chat: imágenes desde el portapapeles o un archivo, y archivos
//! arrastrados o pegados, que se guardan para que el asistente los lea.
//!
//! Las imágenes se devuelven en base64 para enviarlas al CLI como bloques de imagen. El
//! frontend las ajusta al tamaño final; aquí solo se limita lo que cruza la IPC.
use base64::Engine;
use serde::Serialize;
use std::io::Read;
use tauri::{AppHandle, Manager};
use tauri_plugin_clipboard_manager::ClipboardExt;

/// Tamaño máximo de un archivo arrastrado o pegado que se guarda para el asistente.
pub(crate) const SAVED_MAX_BYTES: usize = 100 * 1024 * 1024;

/// Lado más largo de una captura antes de enviarla a la ventana.
const CLIPBOARD_MAX_EDGE: u32 = 1920;
/// Tamaño máximo de un archivo de imagen que se acepta adjuntar.
const FILE_MAX_BYTES: u64 = 20 * 1024 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageData {
    pub media_type: String,
    pub data: String,
    pub name: String,
}

/// Tipo de imagen según su firma, no según la extensión.
pub(crate) fn image_type(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}

pub(crate) fn read_image(path: &std::path::Path) -> Result<ImageData, String> {
    let metadata = std::fs::metadata(path).map_err(|e| format!("No se pudo leer «{}»: {e}", path.display()))?;
    if !metadata.is_file() {
        return Err(format!("«{}» no es un archivo.", path.display()));
    }
    if metadata.len() > FILE_MAX_BYTES {
        return Err("La imagen pesa más de 20 MB.".into());
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    std::fs::File::open(path)
        .and_then(|file| file.take(FILE_MAX_BYTES).read_to_end(&mut bytes))
        .map_err(|e| format!("No se pudo leer «{}»: {e}", path.display()))?;
    let media_type = image_type(&bytes).ok_or("Solo se pueden adjuntar imágenes PNG, JPEG, GIF o WebP.")?;
    Ok(ImageData {
        media_type: media_type.into(),
        data: base64::engine::general_purpose::STANDARD.encode(&bytes),
        name: path.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default(),
    })
}

#[tauri::command]
pub async fn read_image_file(path: String) -> Result<ImageData, String> {
    tauri::async_runtime::spawn_blocking(move || read_image(std::path::Path::new(&path)))
        .await
        .map_err(|e| e.to_string())?
}

/// La captura del portapapeles como PNG, reducida si es enorme.
#[tauri::command]
pub async fn read_clipboard_image(app: AppHandle) -> Result<Option<ImageData>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let Ok(image) = app.clipboard().read_image() else { return Ok(None) };
        let (width, height) = (image.width(), image.height());
        if width == 0 || height == 0 || image.rgba().len() > 128 * 1024 * 1024 {
            return Err("La captura es demasiado grande para adjuntarla.".into());
        }
        let rgba = image::RgbaImage::from_raw(width, height, image.rgba().to_vec())
            .ok_or("No se pudo interpretar la captura.")?;
        let mut picture = image::DynamicImage::ImageRgba8(rgba);
        if width.max(height) > CLIPBOARD_MAX_EDGE {
            picture = picture.resize(CLIPBOARD_MAX_EDGE, CLIPBOARD_MAX_EDGE, image::imageops::FilterType::Lanczos3);
        }
        let mut bytes = std::io::Cursor::new(Vec::new());
        picture
            .write_to(&mut bytes, image::ImageFormat::Png)
            .map_err(|e| format!("No se pudo preparar la captura: {e}"))?;
        Ok(Some(ImageData {
            media_type: "image/png".into(),
            data: base64::engine::general_purpose::STANDARD.encode(bytes.into_inner()),
            name: "captura.png".into(),
        }))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Nombre seguro para guardar: solo el último componente y sin caracteres reservados.
pub(crate) fn safe_name(name: &str) -> String {
    let last = name.rsplit(['/', '\\']).next().unwrap_or_default();
    let clean: String = last
        .chars()
        .map(|c| if c.is_control() || "<>:\"|?*".contains(c) { '_' } else { c })
        .collect();
    let clean = clean.trim().trim_matches('.').to_string();
    if clean.is_empty() { "archivo".into() } else { clean }
}

/// La ventana manda el nombre en una cabecera, codificado con `encodeURIComponent`.
pub(crate) fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let Ok(byte) = u8::from_str_radix(&value[index + 1..index + 3], 16) {
                out.push(byte);
                index += 3;
                continue;
            }
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Un archivo arrastrado o pegado llega sin ruta: se guarda en la carpeta de la
/// app para que el asistente lo lea desde ahí y el historial lo siga encontrando.
#[tauri::command]
pub async fn save_attachment(app: AppHandle, request: tauri::ipc::Request<'_>) -> Result<String, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("El archivo no llegó completo.".into());
    };
    if bytes.len() > SAVED_MAX_BYTES {
        return Err("El archivo pesa más de 100 MB.".into());
    }
    let bytes = bytes.clone();
    let name = request
        .headers()
        .get("x-file-name")
        .and_then(|value| value.to_str().ok())
        .map(percent_decode)
        .unwrap_or_default();
    let root = attachments_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || store_attachment(&root, &name, &bytes).map(|path| path.to_string_lossy().into_owned()))
        .await
        .map_err(|e| e.to_string())?
}

/// Carpeta donde se guardan los adjuntos sin ruta (también los que sube el móvil).
pub(crate) fn attachments_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("No se encontró la carpeta de la app: {e}"))?
        .join("attachments"))
}

/// Guarda un adjunto en su propia subcarpeta (dos archivos con el mismo nombre no se pisan).
pub(crate) fn store_attachment(root: &std::path::Path, name: &str, bytes: &[u8]) -> Result<std::path::PathBuf, String> {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|time| time.as_nanos())
        .unwrap_or_default();
    let dir = root.join(format!("{stamp:x}"));
    std::fs::create_dir_all(&dir).map_err(|e| format!("No se pudo guardar el archivo: {e}"))?;
    let path = dir.join(safe_name(name));
    std::fs::write(&path, bytes).map_err(|e| format!("No se pudo guardar el archivo: {e}"))?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn images_are_recognized_by_their_signature() {
        assert_eq!(image_type(b"\x89PNG\r\n\x1a\nrest"), Some("image/png"));
        assert_eq!(image_type(&[0xFF, 0xD8, 0xFF, 0xE0]), Some("image/jpeg"));
        assert_eq!(image_type(b"GIF89a..."), Some("image/gif"));
        assert_eq!(image_type(b"RIFF\0\0\0\0WEBPVP8 "), Some("image/webp"));
        assert_eq!(image_type(b"<svg xmlns"), None);
        assert_eq!(image_type(b""), None);
    }

    #[test]
    fn saved_names_stay_inside_their_folder() {
        assert_eq!(safe_name("informe.pdf"), "informe.pdf");
        assert_eq!(safe_name("../../secreto.txt"), "secreto.txt");
        assert_eq!(safe_name("C:\\Windows\\win.ini"), "win.ini");
        assert_eq!(safe_name("a<b>:c?.txt"), "a_b__c_.txt");
        assert_eq!(safe_name(".."), "archivo");
        assert_eq!(safe_name(""), "archivo");
        assert_eq!(percent_decode("informe%20final%C3%B1.pdf"), "informe finalñ.pdf");
        assert_eq!(percent_decode("100%"), "100%");
    }

    #[test]
    fn only_real_image_files_are_read() {
        let dir = std::env::temp_dir().join(format!("trex-attach-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let png = dir.join("captura.png");
        std::fs::write(&png, b"\x89PNG\r\n\x1a\n0000").unwrap();
        let fake = dir.join("notas.png");
        std::fs::write(&fake, b"no soy una imagen").unwrap();

        let image = read_image(&png).unwrap();
        assert_eq!((image.media_type.as_str(), image.name.as_str()), ("image/png", "captura.png"));
        assert_eq!(base64::engine::general_purpose::STANDARD.decode(image.data).unwrap(), b"\x89PNG\r\n\x1a\n0000");
        assert!(read_image(&fake).is_err());
        assert!(read_image(&dir).is_err());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
