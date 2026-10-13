//! Ventana de contexto de cada modelo de Codex, leída de la caché de modelos
//! que guarda el propio CLI. Permite mostrar el contexto antes del primer
//! mensaje; si el archivo no existe o cambia de forma, no se devuelve nada.
use serde_json::Value;
use std::{collections::HashMap, fs};

/// Parte de la ventana que Codex usa de verdad cuando el modelo no lo indica.
const DEFAULT_EFFECTIVE_PERCENT: u64 = 95;

/// Tokens utilizables por modelo: la ventana por su porcentaje efectivo, como hace Codex.
fn parse(text: &str) -> HashMap<String, u64> {
    let Ok(value) = serde_json::from_str::<Value>(text) else {
        return HashMap::new();
    };
    let Some(models) = value.get("models").and_then(Value::as_array) else {
        return HashMap::new();
    };
    models
        .iter()
        .filter_map(|model| {
            let slug = model.get("slug")?.as_str()?;
            let window = model.get("context_window")?.as_u64().filter(|w| *w > 0)?;
            let percent = model
                .get("effective_context_window_percent")
                .and_then(Value::as_u64)
                .filter(|p| (1..=100).contains(p))
                .unwrap_or(DEFAULT_EFFECTIVE_PERCENT);
            Some((slug.to_string(), window * percent / 100))
        })
        .collect()
}

#[tauri::command]
pub async fn codex_context_windows(config_dir: String) -> Result<HashMap<String, u64>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = crate::conversations::root("codex", &config_dir).join("models_cache.json");
        fs::read_to_string(path).map(|text| parse(&text)).unwrap_or_default()
    })
    .await
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_use_the_effective_share_and_skip_broken_entries() {
        let cache = r#"{"fetched_at":"x","models":[
            {"slug":"gpt-6.1-sol","context_window":500000,"effective_context_window_percent":95},
            {"slug":"gpt-6-luna","context_window":272000},
            {"slug":"sin-ventana"},
            {"context_window":1000}
        ]}"#;
        let windows = parse(cache);
        assert_eq!(windows.get("gpt-6.1-sol"), Some(&475000));
        assert_eq!(windows.get("gpt-6-luna"), Some(&258400));
        assert_eq!(windows.len(), 2);
        assert!(parse("no es json").is_empty());
        assert!(parse(r#"{"models":{}}"#).is_empty());
    }
}
