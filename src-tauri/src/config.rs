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
    pub favorite: bool,
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
#[serde(rename_all = "camelCase")]
pub struct LauncherProfile {
    pub id: String,
    pub name: String,
    pub provider: String,
    pub command: String,
    #[serde(default)]
    pub args: String,
    #[serde(default)]
    pub shell: String,
    #[serde(default)]
    pub launch_mode: String,
    #[serde(default)]
    pub config_dir: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ApplicationIntegrations { pub github: bool, pub blender: bool, pub hyperframes: bool }
impl Default for ApplicationIntegrations { fn default()->Self { Self {github:true,blender:true,hyperframes:true} } }

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub time_format: String,
    pub integrations: ApplicationIntegrations,
    pub desktop_enabled: bool,
    pub browser_enabled: bool,
    pub browser_profile: String,
    pub profiles: Vec<LauncherProfile>,
    pub default_profile_id: String,
    pub shell: String,
    pub claude_command: String,
    pub claude_args: String,
    pub auto_run_claude: bool,
    pub font_size: u32,
    pub font_family: String,
    pub scrollback: u32,
    pub cursor_blink: bool,
    pub cursor_style: String,
    pub cursor_width: u32,
    pub copy_on_select: bool,
    pub paste_shortcut: String,
    pub shortcuts: std::collections::HashMap<String,String>,
    pub image_paste_preview: bool,
    pub desktop_notifications: bool,
    pub notify_when_focused: bool,
    pub confirm_close_tab: bool,
    pub restore_on_start: bool,
    pub launch_mode: String,
    /// Color de acento en formato hex ("#e8834a").
    pub theme: String,
    /// Apariencia de la interfaz: "dark" | "light" | "system".
    pub appearance: String,
    pub color_scheme: String,
    pub terminal_radius: u32,
    pub terminal_margin: u32,
    pub terminal_border: bool,
    pub motion: String,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            time_format: "24h".into(),
            integrations: ApplicationIntegrations::default(),
            desktop_enabled: false,
            browser_enabled: true,
            browser_profile: "BROWSER1".into(),
            // Vacío indica al frontend que debe migrar la instalación anterior.
            profiles: Vec::new(),
            default_profile_id: String::new(),
            shell: "default".into(),
            claude_command: "claude".into(),
            claude_args: String::new(),
            auto_run_claude: true,
            font_size: 14,
            font_family: String::new(),
            scrollback: 10_000,
            cursor_blink: true,
            cursor_style: "auto".into(),
            cursor_width: 1,
            copy_on_select: false,
            paste_shortcut: "Ctrl+V".into(),
            shortcuts: std::collections::HashMap::new(),
            image_paste_preview: true,
            desktop_notifications: true,
            notify_when_focused: false,
            confirm_close_tab: true,
            restore_on_start: true,
            launch_mode: "arg".into(),
            theme: "#e8834a".into(),
            appearance: "dark".into(),
            color_scheme: "trex".into(),
            terminal_radius: 22,
            terminal_margin: 12,
            terminal_border: true,
            motion: "system".into(),
        }
    }
}

#[cfg(test)]
mod browser_preference_tests {
    use super::*;
    #[test]
    fn time_format_migrates_to_24_hours_and_preserves_12_hours() {
        let old: Settings = serde_json::from_str("{}").unwrap();
        assert_eq!(old.time_format, "24h");
        let changed: Settings = serde_json::from_str(r#"{"timeFormat":"12h"}"#).unwrap();
        assert_eq!(serde_json::to_value(changed).unwrap()["timeFormat"], "12h");
    }
    #[test]
    fn browser_permission_and_profile_survive_native_configuration_roundtrip() {
        for enabled in [false,true] {
            let raw=serde_json::json!({"version":1,"projects":[],"settings":{"browserEnabled":enabled,"browserProfile":"BROWSER7"},"ui":{"lastTabs":[]}});
            let config:AppConfig=serde_json::from_value(raw).unwrap();
            assert_eq!(config.settings.browser_enabled,enabled);
            assert_eq!(config.settings.browser_profile,"BROWSER7");
            let saved=serde_json::to_value(&config).unwrap();
            assert_eq!(saved["settings"]["browserEnabled"],enabled);
            assert_eq!(saved["settings"]["browserProfile"],"BROWSER7");
            let restored:AppConfig=serde_json::from_value(saved).unwrap();
            assert_eq!(restored.settings.browser_enabled,enabled);assert_eq!(restored.settings.browser_profile,"BROWSER7");
        }
    }
    #[test]
    fn desktop_access_is_opt_in_and_roundtrips() {
        for enabled in [false, true] {
            let config: AppConfig = serde_json::from_value(serde_json::json!({"settings":{"desktopEnabled":enabled}})).unwrap();
            assert_eq!(config.settings.desktop_enabled, enabled);
            let saved = serde_json::to_value(config).unwrap();
            assert_eq!(saved["settings"]["desktopEnabled"], enabled);
        }
    }
    #[test]
    fn application_integration_preferences_roundtrip_independently() {
        let config:AppConfig=serde_json::from_value(serde_json::json!({"settings":{"integrations":{"github":false,"blender":true,"hyperframes":false}}})).unwrap();
        assert!(!config.settings.integrations.github);assert!(config.settings.integrations.blender);assert!(!config.settings.integrations.hyperframes);
        let saved=serde_json::to_value(config).unwrap();
        assert_eq!(saved["settings"]["integrations"],serde_json::json!({"github":false,"blender":true,"hyperframes":false}));
        let old:AppConfig=serde_json::from_value(serde_json::json!({"settings":{}})).unwrap();
        assert!(old.settings.integrations.github && old.settings.integrations.blender && old.settings.integrations.hyperframes);
    }
    #[test]
    fn older_configuration_uses_the_frontend_browser_defaults() {
        let config:AppConfig=serde_json::from_value(serde_json::json!({"settings":{}})).unwrap();
        assert!(config.settings.browser_enabled);assert_eq!(config.settings.browser_profile,"BROWSER1");
        assert!(!config.settings.desktop_enabled);
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_settings_keep_the_custom_claude_launcher_for_migration() {
        let config: AppConfig = serde_json::from_value(serde_json::json!({
            "settings": { "claudeCommand": "claude1", "claudeArgs": "--continue", "shell": "zsh" }
        })).unwrap();
        assert!(config.settings.profiles.is_empty());
        assert_eq!(config.settings.claude_command, "claude1");
        assert_eq!(config.settings.claude_args, "--continue");
        assert_eq!(config.settings.shell, "zsh");
        assert_eq!(config.settings.paste_shortcut, "Ctrl+V");
        assert_eq!(config.settings.cursor_style, "auto");
        assert_eq!(config.settings.cursor_width, 1);
        assert_eq!(config.settings.color_scheme, "trex");
        assert_eq!(config.settings.terminal_radius, 22);
        assert_eq!(config.settings.terminal_margin, 12);
        assert!(config.settings.terminal_border);
        assert_eq!(config.settings.motion, "system");
        assert!(config.settings.shortcuts.is_empty());
        assert!(config.settings.image_paste_preview);
        assert!(config.settings.desktop_notifications);
    }

    #[test]
    fn visual_preferences_and_favorites_survive_saving_without_changing_launchers() {
        let raw = serde_json::json!({
            "projects": [{ "id": "p", "name": "Proyecto", "path": "/work/project", "favorite": true }],
            "settings": { "colorScheme": "forest", "terminalRadius": 0, "terminalMargin": 6, "terminalBorder": false, "motion": "reduced", "claudeCommand": "claude-work", "shortcuts":{"commandPalette":"Ctrl+Y"}, "imagePastePreview":false,"desktopNotifications":false,"notifyWhenFocused":true }
        });
        let config: AppConfig = serde_json::from_value(raw).unwrap();
        let saved = serde_json::to_value(&config).unwrap();
        assert_eq!(saved["projects"][0]["favorite"], true);
        assert_eq!(saved["settings"]["colorScheme"], "forest");
        assert_eq!(saved["settings"]["terminalRadius"], 0);
        assert_eq!(saved["settings"]["terminalMargin"], 6);
        assert_eq!(saved["settings"]["terminalBorder"], false);
        assert_eq!(saved["settings"]["motion"], "reduced");
        assert_eq!(saved["settings"]["claudeCommand"], "claude-work");
        assert_eq!(saved["settings"]["shortcuts"]["commandPalette"],"Ctrl+Y");
        assert_eq!(saved["settings"]["imagePastePreview"],false);
        assert_eq!(saved["settings"]["desktopNotifications"],false);
        assert_eq!(saved["settings"]["notifyWhenFocused"],true);
        let old_project: Project = serde_json::from_value(serde_json::json!({ "id": "old", "name": "Antes", "path": "/work/old" })).unwrap();
        assert!(!old_project.favorite);
    }

    #[test]
    fn saving_keeps_profiles_and_the_original_launch_of_each_session() {
        let raw = serde_json::json!({
            "settings": { "cursorStyle": "bar", "cursorWidth": 4, "cursorBlink": false, "pasteShortcut": "Ctrl+Alt+V", "defaultProfileId": "c2", "profiles": [
                { "id": "c1", "name": "Claude 1", "provider": "claude", "command": "claude1", "args": "--continue", "shell": "zsh", "launchMode": "arg", "configDir": "~/.claude-1" },
                { "id": "c2", "name": "Claude 2", "provider": "claude", "command": "claude2", "args": "", "shell": "bash", "launchMode": "inject", "configDir": "~/.claude-2" },
                { "id": "cx", "name": "Codex", "provider": "codex", "command": "codex", "args": "resume --last", "shell": "", "launchMode": "arg", "configDir": "~/.codex-work" }
            ] },
            "ui": { "lastTabs": [{ "projectId": "p1", "kind": "codex", "subtitle": "Trabajo", "launch": {
                "profileId": "cx", "profileName": "Codex", "command": "codex", "args": "resume --last", "shell": "zsh", "launchMode": "arg", "env": { "CODEX_HOME": "~/.codex-work" }
            } }] }
        });
        let config: AppConfig = serde_json::from_value(raw.clone()).unwrap();
        let saved = serde_json::to_value(&config).unwrap();
        assert_eq!(saved["settings"]["profiles"], raw["settings"]["profiles"]);
        assert_eq!(saved["settings"]["defaultProfileId"], "c2");
        assert_eq!(saved["settings"]["pasteShortcut"], "Ctrl+Alt+V");
        assert_eq!(saved["settings"]["cursorStyle"], "bar");
        assert_eq!(saved["settings"]["cursorWidth"], 4);
        assert_eq!(saved["settings"]["cursorBlink"], false);
        assert_eq!(saved["ui"], raw["ui"]);
    }
}
