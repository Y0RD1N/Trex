use base64::Engine;
use serde::Serialize;
use std::hash::{Hash, Hasher};
use tauri::AppHandle;
use tauri_plugin_clipboard_manager::ClipboardExt;

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum ClipboardContent {
    Image {
        preview: String,
        width: u32,
        height: u32,
        fingerprint: String,
    },
    Text {
        text: String,
    },
}

/// Leer fuera del hilo de la ventana evita bloqueos al pegar desde el propio
/// WebView en Linux. Una captura puede ofrecer imagen y texto: prima la imagen.
#[tauri::command]
pub async fn read_clipboard(app: AppHandle) -> Result<ClipboardContent, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let clipboard = app.clipboard();
        if let Ok(image) = clipboard.read_image() {
            let width = image.width();
            let height = image.height();
            if width == 0 || height == 0 || image.rgba().len() > 128 * 1024 * 1024 {
                return Err("La captura es demasiado grande para mostrarla.".into());
            }
            let fingerprint = image_fingerprint(width, height, image.rgba());
            let rgba = image::RgbaImage::from_raw(width, height, image.rgba().to_vec())
                .ok_or("No se pudo interpretar la captura.")?;
            let preview_image = image::DynamicImage::ImageRgba8(rgba).thumbnail(960, 640);
            let mut bytes = std::io::Cursor::new(Vec::new());
            preview_image
                .write_to(&mut bytes, image::ImageFormat::Png)
                .map_err(|e| format!("No se pudo mostrar la captura: {e}"))?;
            let preview = format!(
                "data:image/png;base64,{}",
                base64::engine::general_purpose::STANDARD.encode(bytes.into_inner())
            );
            return Ok(ClipboardContent::Image {
                preview,
                width,
                height,
                fingerprint,
            });
        }
        clipboard
            .read_text()
            .map(|text| ClipboardContent::Text { text })
            .map_err(|e| format!("No se pudo leer texto o una imagen del portapapeles: {e}"))
    })
    .await
    .map_err(|e| format!("No se pudo acceder al portapapeles: {e}"))?
}

fn image_fingerprint(width: u32, height: u32, rgba: &[u8]) -> String {
    let mut hash = std::collections::hash_map::DefaultHasher::new();
    width.hash(&mut hash);
    height.hash(&mut hash);
    rgba.hash(&mut hash);
    format!("{:016x}", hash.finish())
}
/// Comprueba la misma imagen antes de enviar al CLI su tecla nativa de adjuntar.
#[tauri::command]
pub async fn paste_clipboard_image(
    app: AppHandle,
    state: tauri::State<'_, crate::pty::PtyState>,
    id: String,
    provider: String,
    fingerprint: String,
) -> Result<(), String> {
    if !["claude", "codex"].contains(&provider.as_str()) {
        return Err("Las imágenes necesitan una sesión de Claude Code o Codex.".into());
    }
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let image = app.clipboard().read_image().map_err(|_| "La captura ya no está en el portapapeles. Vuelve a copiarla.".to_string())?;
        if image_fingerprint(image.width(),image.height(),image.rgba()) != fingerprint { return Err("La imagen del portapapeles cambió. Vuelve a pegarla para revisar la nueva captura.".into()); }
        state.write(&id,if cfg!(windows) && provider == "claude" { "\x1bv" } else { "\x16" })
    }).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn image_identity_includes_dimensions_and_pixels() {
        assert_eq!(
            image_fingerprint(1, 1, &[1, 2, 3, 4]),
            image_fingerprint(1, 1, &[1, 2, 3, 4])
        );
        assert_ne!(
            image_fingerprint(1, 1, &[1, 2, 3, 4]),
            image_fingerprint(1, 1, &[1, 2, 3, 5])
        );
        assert_ne!(
            image_fingerprint(1, 1, &[1, 2, 3, 4]),
            image_fingerprint(2, 1, &[1, 2, 3, 4])
        );
    }
}
