// trex — terminal de escritorio con proyectos que lanzan Claude Code.
//
// El backend expone comandos Tauri para gestionar sesiones PTY, detectar
// Claude Code en el sistema y persistir la configuración del usuario.
mod accounts;
mod agent;
mod attachments;
mod config;
mod pty;
mod output_flow;
mod clipboard;
mod conversations;
mod codex_models;
mod files;
mod git;
mod shared_files;
mod terminal_env;

use agent::{AgentSpawnRequest, AgentSpawnResponse, AgentState};
use config::AppConfig;
use pty::{ClaudeInfo, PtyState, SessionInfo, SpawnRequest, SpawnResponse};
use serde::Serialize;
use tauri::{AppHandle, Manager, State, WindowEvent};

// --- Utilidades -------------------------------------------------------------

fn is_windows() -> bool {
    cfg!(windows)
}

/// Comprueba si un ejecutable existe en el PATH (con extensiones en Windows).
fn exists_in_path(program: &str) -> bool {
    let path = match std::env::var_os("PATH") {
        Some(p) => p,
        None => return false,
    };
    let exts: Vec<String> = if is_windows() {
        std::env::var("PATHEXT")
            .unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into())
            .split(';')
            .map(|s| s.trim().to_ascii_lowercase())
            .collect()
    } else {
        vec![]
    };
    for dir in std::env::split_paths(&path) {
        if dir.join(program).is_file() {
            return true;
        }
        if is_windows() {
            for ext in &exts {
                if dir.join(format!("{program}{ext}")).is_file() {
                    return true;
                }
            }
        }
    }
    false
}

fn file_exists(p: &str) -> bool {
    std::path::Path::new(p).is_file()
}

fn home_dir() -> String {
    let var = if is_windows() { "USERPROFILE" } else { "HOME" };
    std::env::var(var)
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_default()
}

// --- Información de la aplicación -------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ShellOption {
    id: String,
    label: String,
    available: bool,
    program: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AppInfo {
    platform: String,
    home_dir: String,
    config_path: String,
    default_shell_name: String,
    shell_options: Vec<ShellOption>,
    version: String,
}

fn shell_options() -> (String, Vec<ShellOption>) {
    let mut options: Vec<ShellOption> = Vec::new();

    if is_windows() {
        let pwsh7 = r"C:\Program Files\PowerShell\7\pwsh.exe";
        let has_pwsh = exists_in_path("pwsh") || file_exists(pwsh7);
        let git_bash = [r"C:\Program Files\Git\bin\bash.exe", r"C:\Program Files (x86)\Git\bin\bash.exe"]
            .iter()
            .find(|p| file_exists(p))
            .map(|p| p.to_string())
            .unwrap_or_default();
        let wsl = r"C:\Windows\System32\wsl.exe";

        let default_label = if has_pwsh {
            "Predeterminado (PowerShell 7)".to_string()
        } else {
            "Predeterminado (Windows PowerShell)".to_string()
        };
        options.push(ShellOption {
            id: "default".into(),
            label: default_label.clone(),
            available: true,
            program: if has_pwsh {
                "pwsh.exe".into()
            } else {
                "powershell.exe".into()
            },
        });
        options.push(ShellOption {
            id: "powershell".into(),
            label: "Windows PowerShell".into(),
            available: true,
            program: "powershell.exe".into(),
        });
        options.push(ShellOption {
            id: "pwsh".into(),
            label: "PowerShell 7".into(),
            available: has_pwsh,
            program: if has_pwsh { "pwsh.exe".into() } else { String::new() },
        });
        options.push(ShellOption {
            id: "cmd".into(),
            label: "Símbolo del sistema (cmd)".into(),
            available: true,
            program: "cmd.exe".into(),
        });
        options.push(ShellOption {
            id: "gitbash".into(),
            label: "Git Bash".into(),
            available: !git_bash.is_empty(),
            program: git_bash,
        });
        options.push(ShellOption {
            id: "wsl".into(),
            label: "WSL".into(),
            available: file_exists(wsl),
            program: if file_exists(wsl) { wsl.into() } else { String::new() },
        });

        (default_label, options)
    } else {
        let shell_env = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into());
        let base = std::path::Path::new(&shell_env)
            .file_name()
            .map(|f| f.to_string_lossy().to_string())
            .unwrap_or_else(|| "shell".into());

        options.push(ShellOption {
            id: "default".into(),
            label: format!("Predeterminado ({base})"),
            available: true,
            program: shell_env.clone(),
        });
        for (id, label, program) in [
            ("bash", "Bash", "/bin/bash"),
            ("zsh", "Zsh", "/bin/zsh"),
            ("fish", "Fish", "/bin/fish"),
            ("sh", "sh", "/bin/sh"),
        ] {
            let available = file_exists(program) || exists_in_path(id);
            options.push(ShellOption {
                id: id.into(),
                label: label.into(),
                available,
                program: if available { program.into() } else { String::new() },
            });
        }

        (format!("Predeterminado ({base})"), options)
    }
}

// --- Comandos ---------------------------------------------------------------

#[tauri::command]
async fn pty_spawn(
    app: AppHandle,
    state: State<'_, PtyState>,
    request: SpawnRequest,
) -> Result<SpawnResponse, String> {
    state.spawn(app, request)
}

#[tauri::command]
async fn pty_write(state: State<'_, PtyState>, id: String, data: String) -> Result<(), String> {
    state.write(&id, &data)
}

#[tauri::command]
async fn pty_ack(state: State<'_, PtyState>, id: String, bytes: usize) -> Result<(), String> {
    state.acknowledge(&id, bytes)
}

#[tauri::command]
async fn pty_resize(
    state: State<'_, PtyState>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    state.resize(&id, cols, rows)
}

#[tauri::command]
async fn pty_kill(state: State<'_, PtyState>, id: String) -> Result<Option<i64>, String> {
    state.kill(&id)
}

#[tauri::command]
async fn pty_list(state: State<'_, PtyState>) -> Result<Vec<SessionInfo>, String> {
    Ok(state.list())
}

#[tauri::command]
async fn pty_kill_all(state: State<'_, PtyState>) -> Result<(), String> {
    state.kill_all();
    Ok(())
}

#[tauri::command]
async fn agent_spawn(
    app: AppHandle,
    state: State<'_, AgentState>,
    request: AgentSpawnRequest,
) -> Result<AgentSpawnResponse, String> {
    let emit = agent::tauri_emitter(app, request.id.clone());
    state.spawn(request, emit)
}

#[tauri::command]
async fn agent_write(state: State<'_, AgentState>, id: String, line: String) -> Result<(), String> {
    state.write_line(&id, &line)
}

#[tauri::command]
async fn agent_kill(state: State<'_, AgentState>, id: String) -> Result<(), String> {
    state.kill(&id)
}

#[tauri::command]
async fn detect_claude() -> Result<ClaudeInfo, String> {
    Ok(pty::detect_claude())
}

#[tauri::command]
async fn detect_codex() -> Result<ClaudeInfo, String> {
    Ok(pty::detect_codex())
}

#[tauri::command]
async fn app_info(app: AppHandle) -> Result<AppInfo, String> {
    let (default_shell_name, options) = shell_options();
    Ok(AppInfo {
        platform: if is_windows() {
            "windows".into()
        } else if cfg!(target_os = "macos") {
            "macos".into()
        } else {
            "linux".into()
        },
        home_dir: home_dir(),
        config_path: config::config_path(&app)?.to_string_lossy().to_string(),
        default_shell_name,
        shell_options: options,
        version: app.package_info().version.to_string(),
    })
}

#[tauri::command]
async fn load_config(app: AppHandle) -> Result<AppConfig, String> {
    Ok(config::load(&app))
}

#[tauri::command]
async fn save_config(app: AppHandle, config: AppConfig) -> Result<AppConfig, String> {
    config::save(&app, &config)?;
    Ok(config)
}

// --- Arranque ---------------------------------------------------------------

#[tauri::command]
async fn desktop_notification(app: AppHandle, title: String, body: String) -> Result<(),String> {
    use tauri_plugin_notification::NotificationExt;
    tauri::async_runtime::spawn_blocking(move || app.notification().builder().title(title).body(body).show().map_err(|e| format!("No se pudo mostrar el aviso del escritorio: {e}"))).await.map_err(|e| e.to_string())?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_notification::init())
        .manage(PtyState::default())
        .manage(AgentState::default())
        .invoke_handler(tauri::generate_handler![
            pty_spawn,
            pty_write,
            pty_ack,
            pty_resize,
            pty_kill,
            pty_list,
            pty_kill_all,
            agent_spawn,
            agent_write,
            agent_kill,
            detect_claude,
            detect_codex,
            app_info,
            load_config,
            save_config,
            clipboard::read_clipboard,
            clipboard::write_clipboard,
            clipboard::paste_clipboard_image,
            conversations::list_conversations,
            conversations::read_conversation,
            conversations::claude_rewind_point,
            attachments::read_image_file,
            attachments::read_clipboard_image,
            shared_files::file_info,
            shared_files::open_file,
            shared_files::reveal_file,
            shared_files::save_file_copy,
            shared_files::save_file_data,
            git::git_branch,
            git::git_branches,
            git::git_switch_branch,
            git::git_create_branch,
            files::list_project_files,
            codex_models::codex_context_windows,
            accounts::detect_account_dir,
            desktop_notification,
        ])
        .on_window_event(|window, event| {
            // Al cerrarse la ventana principal se terminan todas las sesiones.
            if matches!(event, WindowEvent::CloseRequested { .. }) {
                if let Some(state) = window.try_state::<PtyState>() {
                    state.kill_all();
                }
                if let Some(state) = window.try_state::<AgentState>() {
                    state.kill_all();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
