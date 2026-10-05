use serde::Serialize;
use tauri::AppHandle;
use tauri_plugin_clipboard_manager::ClipboardExt;

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum ClipboardContent {
    Image,
    Text { text: String },
}

/// Leer fuera del hilo de la ventana evita bloqueos al pegar desde el propio
/// WebView en Linux. Una captura puede ofrecer imagen y texto: prima la imagen.
#[tauri::command]
pub async fn read_clipboard(app: AppHandle) -> Result<ClipboardContent, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let clipboard = app.clipboard();
        if clipboard.read_image().is_ok() {
            return Ok(ClipboardContent::Image);
        }
        clipboard
            .read_text()
            .map(|text| ClipboardContent::Text { text })
            .map_err(|e| format!("No se pudo leer texto o una imagen del portapapeles: {e}"))
    })
    .await
    .map_err(|e| format!("No se pudo acceder al portapapeles: {e}"))?
}
