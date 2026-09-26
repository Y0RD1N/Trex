// Configuración persistente de trex.
//
// Se guarda como JSON en el directorio de configuración de la app
// (en Windows: %APPDATA%\com.trex.app\config.json).
// El campo `ui` se mantiene como JSON libre para que el frontend pueda añadir
// estado propio (por ejemplo las pestañas de la última sesión) sin tocar Rust.
use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    pub path: String,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub created_at: u64,
    #[serde(default)]
    pub last_opened_at: Option<u64>,
    #[serde(default)]
    pub default_command: Option<String>,
    #[serde(default)]
    pub default_args: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub shell: String,
    pub claude_command: String,
    pub claude_args: String,
    pub auto_run_claude: bool,
    pub font_size: u32,
    pub font_family: String,
    pub scrollback: u32,
    pub cursor_blink: bool,
    pub copy_on_select: bool,
    pub confirm_close_tab: bool,
    pub restore_on_start: bool,
    pub launch_mode: String,
    /// Color de acento en formato hex ("#e8834a").
    pub theme: String,
    /// Apariencia de la interfaz: "dark" | "light" | "system".
    pub appearance: String,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            shell: "default".into(),
            claude_command: "claude".into(),
            claude_args: String::new(),
            auto_run_claude: true,
            font_size: 14,
            font_family: String::new(),
            scrollback: 10_000,
            cursor_blink: true,
            copy_on_select: false,
            confirm_close_tab: true,
            restore_on_start: true,
            launch_mode: "arg".into(),
            theme: "#e8834a".into(),
            appearance: "dark".into(),
        }
    }
}

fn default_ui() -> serde_json::Value {
    serde_json::json!({
        "lastProjectId": null,
        "activeProjectId": null,
        "sidebarWidth": 268,
        "lastTabs": []
    })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    #[serde(default = "default_version")]
    pub version: u32,
    #[serde(default)]
    pub projects: Vec<Project>,
    #[serde(default)]
    pub settings: Settings,
    #[serde(default = "default_ui")]
    pub ui: serde_json::Value,
}

fn default_version() -> u32 {
    1
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            version: default_version(),
            projects: Vec::new(),
            settings: Settings::default(),
            ui: default_ui(),
        }
    }
}

/// Ruta del archivo de configuración, creando el directorio si hace falta.
pub fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("No se pudo resolver el directorio de configuración: {e}"))?;
    if !dir.exists() {
        fs::create_dir_all(&dir)
            .map_err(|e| format!("No se pudo crear «{}»: {e}", dir.display()))?;
    }
    Ok(dir.join("config.json"))
}

/// Carga la configuración; si no existe o está corrupta devuelve los valores por defecto.
pub fn load(app: &AppHandle) -> AppConfig {
    let path = match config_path(app) {
        Ok(p) => p,
        Err(_) => return AppConfig::default(),
    };
    let raw = match fs::read_to_string(&path) {
        Ok(text) => text,
        Err(_) => return AppConfig::default(),
    };
    serde_json::from_str::<AppConfig>(&raw).unwrap_or_else(|_| {
        // Copia de seguridad del archivo ilegible para no perder datos del usuario.
        let backup = path.with_extension("json.corrupto");
        let _ = fs::copy(&path, backup);
        AppConfig::default()
    })
}

/// Guarda la configuración de forma atómica (archivo temporal + rename).
pub fn save(app: &AppHandle, config: &AppConfig) -> Result<(), String> {
    let path = config_path(app)?;
    let text = serde_json::to_string_pretty(config)
        .map_err(|e| format!("No se pudo serializar la configuración: {e}"))?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, text).map_err(|e| format!("No se pudo escribir la configuración: {e}"))?;
    fs::rename(&tmp, &path).map_err(|e| format!("No se pudo guardar la configuración: {e}"))?;
    Ok(())
}
