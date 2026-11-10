// Configuración persistente de trex.
//
// Se guarda como JSON en el directorio de configuración de la app
// (en Windows: %APPDATA%\com.trex.app\config.json).
// El campo `ui` se mantiene como JSON libre para que el frontend pueda añadir
// estado propio (por ejemplo las pestañas de la última sesión) sin tocar Rust.
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

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

/// Resumen automático del contexto de un asistente. Apagado salvo que la
/// persona lo active; `tokens` a 0 deja que el frontend proponga el umbral.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AutoCompactRule { pub enabled: bool, pub tokens: u64 }
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AutoCompactSettings { pub claude: AutoCompactRule, pub codex: AutoCompactRule, pub trex: AutoCompactRule }

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub time_format: String,
    pub integrations: ApplicationIntegrations,
    pub auto_compact: AutoCompactSettings,
    pub desktop_enabled: bool,
    /// Control por accesibilidad (experimental, desactivado por defecto).
    pub a11y_enabled: bool,
    /// Atajos de teclado reales en el control por accesibilidad (desactivado por defecto).
    pub a11y_keyboard: bool,
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
    /// Transparencias: Mica en Windows 11 y cristal en lo que flota sobre el chat.
    pub glass: bool,
    /// Fondo de la ventana: "solid" | "mica" | "mica-alt" | "acrylic" (Windows 11).
    pub window_backdrop: String,
    /// Opacidad (20–90 %) del gris grafito sobre el material.
    pub material_tint: u32,
    /// Matiz (0–360°) del tono de la interfaz; 40 es el marrón «sedimento».
    pub surface_hue: u32,
    /// Intensidad (0–100 %) del tono de la interfaz; 0 es un gris puro.
    pub surface_tint: u32,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            time_format: "24h".into(),
            integrations: ApplicationIntegrations::default(),
            auto_compact: AutoCompactSettings::default(),
            desktop_enabled: false,
            a11y_enabled: false,
            a11y_keyboard: false,
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
            glass: true,
            window_backdrop: "solid".into(),
            material_tint: 60,
            surface_hue: 40,
            surface_tint: 100,
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
    fn accessibility_control_is_opt_in_and_roundtrips() {
        let old: AppConfig = serde_json::from_value(serde_json::json!({"settings":{}})).unwrap();
        assert!(!old.settings.a11y_enabled);
        // Un motor guardado de versiones anteriores ("agent-desktop") se ignora: solo hay el propio.
        let legacy: AppConfig = serde_json::from_value(serde_json::json!({"settings":{"a11yEngine":"agent-desktop","a11yEnabled":true}})).unwrap();
        assert!(legacy.settings.a11y_enabled);
        assert!(serde_json::to_value(legacy).unwrap()["settings"].get("a11yEngine").is_none());
        assert!(!old.settings.a11y_keyboard, "keyboard shortcuts need explicit permission");
        for enabled in [false, true] {
            let config: AppConfig = serde_json::from_value(serde_json::json!({"settings":{"a11yEnabled":enabled}})).unwrap();
            assert_eq!(config.settings.a11y_enabled, enabled);
            assert_eq!(serde_json::to_value(config).unwrap()["settings"]["a11yEnabled"], enabled);
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
    fn automatic_context_summary_is_opt_in_and_roundtrips_per_assistant() {
        let old: AppConfig = serde_json::from_value(serde_json::json!({"settings":{}})).unwrap();
        assert!(!old.settings.auto_compact.claude.enabled && !old.settings.auto_compact.codex.enabled && !old.settings.auto_compact.trex.enabled);
        let config: AppConfig = serde_json::from_value(serde_json::json!({"settings":{"autoCompact":{"claude":{"enabled":true,"tokens":400000},"codex":{"tokens":250000}}}})).unwrap();
        assert!(config.settings.auto_compact.claude.enabled);
        assert!(!config.settings.auto_compact.codex.enabled, "a saved threshold alone does not turn the option on");
        let saved = serde_json::to_value(config).unwrap();
        assert_eq!(saved["settings"]["autoCompact"]["claude"], serde_json::json!({"enabled":true,"tokens":400000}));
        assert_eq!(saved["settings"]["autoCompact"]["codex"], serde_json::json!({"enabled":false,"tokens":250000}));
        assert_eq!(saved["settings"]["autoCompact"]["trex"], serde_json::json!({"enabled":false,"tokens":0}));
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

/// Por qué no se pudo cargar la configuración. Nunca se sustituye por los
/// valores por defecto en silencio: quien llama decide, y mientras tanto no
/// debe guardar nada encima.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LoadFailure {
    /// "unreadable": el archivo existe pero no se pudo leer (bloqueado, sin permiso).
    /// "corrupt": se leyó y no es una configuración válida.
    pub kind: &'static str,
    pub message: String,
    /// Copia que se hizo del archivo dañado.
    pub backup: Option<String>,
    /// Hay una copia válida del último arranque correcto que se puede restaurar.
    pub previous: bool,
}

/// Copia de la configuración tal como estaba en el último arranque correcto.
fn previous_path(path: &Path) -> PathBuf {
    path.with_extension("json.bak")
}

fn read_previous(path: &Path) -> Option<AppConfig> {
    serde_json::from_slice(&fs::read(previous_path(path)).ok()?).ok()
}

fn unix_seconds() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|elapsed| elapsed.as_secs()).unwrap_or(0)
}

/// Lee la configuración de `path`. Solo un archivo que no existe (primer
/// arranque) da los valores por defecto; cualquier otro fallo se devuelve.
pub fn load_from(path: &Path) -> Result<AppConfig, LoadFailure> {
    let raw = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(AppConfig::default()),
        Err(error) => {
            return Err(LoadFailure {
                kind: "unreadable",
                message: format!("No se pudo leer «{}»: {error}", path.display()),
                backup: None,
                previous: read_previous(path).is_some(),
            })
        }
    };
    serde_json::from_slice::<AppConfig>(&raw).map_err(|error| {
        // El archivo dañado se conserva aparte: guardar después no lo destruye.
        let backup = path.with_extension(format!("json.corrupto-{}", unix_seconds()));
        let copied = fs::write(&backup, &raw).is_ok();
        LoadFailure {
            kind: "corrupt",
            message: format!("«{}» no es una configuración válida: {error}", path.display()),
            backup: copied.then(|| backup.to_string_lossy().into_owned()),
            previous: read_previous(path).is_some(),
        }
    })
}

/// Tras un arranque correcto guarda una copia para poder volver a ella. Una
/// configuración sin proyectos no sustituye a una copia que sí los tiene: así
/// un vaciado accidental no borra también la copia.
fn remember_previous(path: &Path, config: &AppConfig) {
    if !path.exists() {
        return;
    }
    if config.projects.is_empty() && read_previous(path).is_some_and(|previous| !previous.projects.is_empty()) {
        return;
    }
    if let Ok(bytes) = fs::read(path) {
        let _ = write_atomic(&previous_path(path), &bytes);
    }
}

/// Temporales que dejó un cierre brusco; los recientes pueden ser de otra ventana que está guardando.
fn sweep_temporaries(path: &Path) {
    let (Some(dir), Some(name)) = (path.parent(), path.file_name().and_then(|name| name.to_str())) else { return };
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let file = entry.file_name();
        let Some(file) = file.to_str() else { continue };
        let stale = entry.metadata().and_then(|meta| meta.modified()).ok()
            .and_then(|modified| modified.elapsed().ok())
            .is_some_and(|age| age.as_secs() > 60);
        if stale && file.starts_with(name) && file.ends_with(".tmp") {
            let _ = fs::remove_file(entry.path());
        }
    }
}

/// Carga la configuración de la app y recuerda la copia del arranque correcto.
pub fn load(app: &AppHandle) -> Result<AppConfig, LoadFailure> {
    let path = config_path(app).map_err(|message| LoadFailure { kind: "unreadable", message, backup: None, previous: false })?;
    sweep_temporaries(&path);
    let config = load_from(&path)?;
    remember_previous(&path, &config);
    Ok(config)
}

/// Ajustes para el propio backend; si no se pueden leer, los de por defecto (nada se escribe).
pub fn load_settings(app: &AppHandle) -> Settings {
    config_path(app).ok().and_then(|path| load_from(&path).ok()).map(|config| config.settings).unwrap_or_default()
}

/// La copia del último arranque correcto, para restaurarla cuando el archivo actual está dañado.
pub fn restore_previous(app: &AppHandle) -> Result<AppConfig, String> {
    read_previous(&config_path(app)?).ok_or_else(|| "No hay una copia anterior de la configuración que se pueda restaurar.".to_string())
}

/// Dos guardados a la vez no deben pisarse el temporal ni dejar el archivo a medias.
static SAVE_LOCK: Mutex<()> = Mutex::new(());
static TEMPORARY_SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// Escribe `bytes` en `path` sin dejarlo nunca a medias: temporal propio,
/// volcado a disco y sustitución. Otra instancia que guarde a la vez usa otro
/// temporal, así que gana la última entera.
fn write_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let _guard = SAVE_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let name = path.file_name().and_then(|name| name.to_str()).unwrap_or("config.json");
    let temporary = path.with_file_name(format!("{name}.{}-{}.tmp", std::process::id(), TEMPORARY_SEQUENCE.fetch_add(1, Ordering::Relaxed)));
    let written = (|| {
        let mut file = fs::File::create(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        // En Windows un antivirus o un indexador pueden tener abierto el destino un instante.
        let mut attempt = 0;
        loop {
            match fs::rename(&temporary, path) {
                Ok(()) => return Ok(()),
                Err(error) if error.kind() == io::ErrorKind::PermissionDenied && attempt < 5 => {
                    attempt += 1;
                    std::thread::sleep(std::time::Duration::from_millis(40 * attempt));
                }
                Err(error) => return Err(error),
            }
        }
    })();
    if written.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    written
}

pub fn save_to(path: &Path, config: &AppConfig) -> Result<(), String> {
    let text = serde_json::to_string_pretty(config)
        .map_err(|e| format!("No se pudo serializar la configuración: {e}"))?;
    write_atomic(path, text.as_bytes()).map_err(|e| format!("No se pudo guardar la configuración: {e}"))
}

/// Guarda la configuración de forma atómica (temporal propio, volcado a disco y sustitución).
pub fn save(app: &AppHandle, config: &AppConfig) -> Result<(), String> {
    save_to(&config_path(app)?, config)
}

#[cfg(test)]
mod persistence_tests {
    use super::*;

    /// Carpeta propia de cada prueba; se borra al terminar.
    struct Folder(PathBuf);
    impl Folder {
        fn new(name: &str) -> Self {
            let path = std::env::temp_dir().join(format!("trex-config-{name}-{}-{}", std::process::id(), TEMPORARY_SEQUENCE.fetch_add(1, Ordering::Relaxed)));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
        fn config(&self) -> PathBuf { self.0.join("config.json") }
        fn names(&self) -> Vec<String> {
            let mut names: Vec<_> = fs::read_dir(&self.0).unwrap().map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned()).collect();
            names.sort();
            names
        }
    }
    impl Drop for Folder { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }

    fn with_project(name: &str) -> AppConfig {
        serde_json::from_value(serde_json::json!({"projects":[{"id":name,"name":name,"path":"/work/project"}]})).unwrap()
    }

    #[test]
    fn only_a_missing_file_starts_from_defaults() {
        let folder = Folder::new("missing");
        let config = load_from(&folder.config()).unwrap();
        assert!(config.projects.is_empty());
        assert!(folder.names().is_empty(), "loading a first run writes nothing");
    }

    #[test]
    fn a_damaged_file_is_reported_and_kept_instead_of_becoming_defaults() {
        let folder = Folder::new("corrupt");
        for damaged in [&b"{\"projects\": [{\"id\""[..], &b""[..], &[0xff, 0xfe, 0x00][..]] {
            fs::write(folder.config(), damaged).unwrap();
            let failure = load_from(&folder.config()).unwrap_err();
            assert_eq!(failure.kind, "corrupt");
            assert!(!failure.previous);
            assert_eq!(fs::read(failure.backup.as_deref().unwrap()).unwrap(), damaged, "the damaged bytes are kept aside");
            assert_eq!(fs::read(folder.config()).unwrap(), damaged, "the original is left as it was");
        }
    }

    #[test]
    fn a_file_that_cannot_be_read_is_not_treated_as_a_first_run() {
        let folder = Folder::new("unreadable");
        // A directory in the file's place fails to read on every platform without being "not found".
        fs::create_dir(folder.config()).unwrap();
        let failure = load_from(&folder.config()).unwrap_err();
        assert_eq!(failure.kind, "unreadable");
        assert_eq!(failure.backup, None);
    }

    #[test]
    fn saving_replaces_the_file_whole_and_leaves_no_temporary_behind() {
        let folder = Folder::new("save");
        save_to(&folder.config(), &with_project("uno")).unwrap();
        save_to(&folder.config(), &with_project("dos")).unwrap();
        assert_eq!(load_from(&folder.config()).unwrap().projects[0].id, "dos");
        assert_eq!(folder.names(), ["config.json"]);
        // Many writers at once: every save lands whole and the file always parses.
        let path = folder.config();
        let writers: Vec<_> = (0..8).map(|index| { let path = path.clone(); std::thread::spawn(move || {
            for round in 0..10 { save_to(&path, &with_project(&format!("p{index}-{round}"))).unwrap(); }
        }) }).collect();
        for writer in writers { writer.join().unwrap(); }
        assert_eq!(load_from(&path).unwrap().projects.len(), 1);
        assert_eq!(folder.names(), ["config.json"]);
    }

    #[test]
    fn the_copy_of_the_last_good_start_can_be_restored_after_damage() {
        let folder = Folder::new("previous");
        let path = folder.config();
        save_to(&path, &with_project("bueno")).unwrap();
        remember_previous(&path, &load_from(&path).unwrap());
        fs::write(&path, b"{ roto").unwrap();
        let failure = load_from(&path).unwrap_err();
        assert_eq!(failure.kind, "corrupt");
        assert!(failure.previous, "the frontend can offer the earlier copy");
        assert_eq!(read_previous(&path).unwrap().projects[0].id, "bueno");
    }

    #[test]
    fn an_emptied_configuration_does_not_replace_a_copy_that_has_projects() {
        let folder = Folder::new("emptied");
        let path = folder.config();
        save_to(&path, &with_project("bueno")).unwrap();
        remember_previous(&path, &load_from(&path).unwrap());
        save_to(&path, &AppConfig::default()).unwrap();
        remember_previous(&path, &load_from(&path).unwrap());
        assert_eq!(read_previous(&path).unwrap().projects[0].id, "bueno");
        // A later configuration with projects does move the copy forward.
        save_to(&path, &with_project("nuevo")).unwrap();
        remember_previous(&path, &load_from(&path).unwrap());
        assert_eq!(read_previous(&path).unwrap().projects[0].id, "nuevo");
    }

    #[test]
    fn only_old_temporaries_of_the_configuration_are_swept() {
        let folder = Folder::new("sweep");
        let (old, recent, other) = (folder.0.join("config.json.1-1.tmp"), folder.0.join("config.json.2-2.tmp"), folder.0.join("notas.tmp"));
        for file in [&old, &recent, &other] { fs::write(file, b"x").unwrap(); }
        let past = SystemTime::now() - std::time::Duration::from_secs(600);
        fs::File::options().write(true).open(&old).unwrap().set_modified(past).unwrap();
        fs::File::options().write(true).open(&other).unwrap().set_modified(past).unwrap();
        sweep_temporaries(&folder.config());
        assert_eq!(folder.names(), ["config.json.2-2.tmp", "notas.tmp"]);
    }

    #[test]
    fn a_load_failure_reaches_the_frontend_with_its_fields() {
        let failure = LoadFailure { kind: "corrupt", message: "m".into(), backup: Some("b".into()), previous: true };
        assert_eq!(serde_json::to_value(failure).unwrap(), serde_json::json!({"kind":"corrupt","message":"m","backup":"b","previous":true}));
    }
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
        assert!(config.settings.glass, "transparencies are on until the user turns them off");
        assert_eq!(config.settings.window_backdrop, "solid");
        assert_eq!(config.settings.material_tint, 60);
        assert_eq!(config.settings.surface_hue, 40, "the interface keeps the brown «sedimento» tone until the user changes it");
        assert_eq!(config.settings.surface_tint, 100);
        assert!(config.settings.shortcuts.is_empty());
        assert!(config.settings.image_paste_preview);
        assert!(config.settings.desktop_notifications);
    }

    #[test]
    fn visual_preferences_and_favorites_survive_saving_without_changing_launchers() {
        let raw = serde_json::json!({
            "projects": [{ "id": "p", "name": "Proyecto", "path": "/work/project", "favorite": true }],
            "settings": { "colorScheme": "forest", "terminalRadius": 0, "terminalMargin": 6, "terminalBorder": false, "motion": "reduced", "glass": false, "windowBackdrop": "acrylic", "materialTint": 35, "surfaceHue": 215, "surfaceTint": 70, "claudeCommand": "claude-work", "shortcuts":{"commandPalette":"Ctrl+Y"}, "imagePastePreview":false,"desktopNotifications":false,"notifyWhenFocused":true }
        });
        let config: AppConfig = serde_json::from_value(raw).unwrap();
        let saved = serde_json::to_value(&config).unwrap();
        assert_eq!(saved["projects"][0]["favorite"], true);
        assert_eq!(saved["settings"]["colorScheme"], "forest");
        assert_eq!(saved["settings"]["terminalRadius"], 0);
        assert_eq!(saved["settings"]["terminalMargin"], 6);
        assert_eq!(saved["settings"]["terminalBorder"], false);
        assert_eq!(saved["settings"]["motion"], "reduced");
        assert_eq!(saved["settings"]["glass"], false);
        assert_eq!(saved["settings"]["windowBackdrop"], "acrylic");
        assert_eq!(saved["settings"]["materialTint"], 35);
        assert_eq!(saved["settings"]["surfaceHue"], 215);
        assert_eq!(saved["settings"]["surfaceTint"], 70);
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
