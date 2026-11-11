// trex — terminal de escritorio con proyectos que lanzan Claude Code.
//
// El backend expone comandos Tauri para gestionar sesiones PTY, detectar
// Claude Code en el sistema y persistir la configuración del usuario.
mod accounts;
mod antigravity;
mod agent;
mod agent_terminal;
mod agent_team;
mod attachments;
mod config;
mod pty;
mod output_flow;
mod cli_updates;
mod clipboard;
mod conversations;
mod coordination;
mod codex_models;
mod files;
mod git;
mod git_panel;
mod handoff;
mod integrations;
mod output_batch;
mod message_queue;
mod queue_mcp;
mod process_lifetime;
mod project_icon;
mod shared_files;
mod terminal_env;
mod trex_cli;
mod trex_browser;
mod window_material;

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
//
// Abrir o cerrar un PTY, lanzar un proceso o leer la versión de un CLI bloquea
// el hilo. Esas tareas van a `blocking` para no frenar las demás llamadas de
// la ventana (escritura en terminales, mensajes del chat…).

async fn blocking<T: Send + 'static>(task: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(task).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn pty_spawn(
    app: AppHandle,
    state: State<'_, PtyState>,
    request: SpawnRequest,
    // Salida de la terminal en binario (ver `pty.rs`).
    on_data: tauri::ipc::Channel<tauri::ipc::InvokeResponseBody>,
) -> Result<SpawnResponse, String> {
    let state = state.inner().clone();
    blocking(move || state.spawn(app, request, on_data)).await
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
    let state = state.inner().clone();
    blocking(move || state.kill(&id)).await
}

#[tauri::command]
async fn pty_list(state: State<'_, PtyState>) -> Result<Vec<SessionInfo>, String> {
    Ok(state.list())
}

#[tauri::command]
async fn pty_kill_all(state: State<'_, PtyState>) -> Result<(), String> {
    let state = state.inner().clone();
    blocking(move || { state.kill_all(); Ok(()) }).await
}

#[tauri::command]
async fn agent_spawn(
    app: AppHandle,
    state: State<'_, AgentState>,
    request: AgentSpawnRequest,
) -> Result<AgentSpawnResponse, String> {
    let emit = agent::tauri_emitter(app, request.id.clone());
    let state = state.inner().clone();
    blocking(move || state.spawn(request, emit)).await
}

#[tauri::command]
async fn agent_write(state: State<'_, AgentState>, id: String, line: String) -> Result<(), String> {
    state.write_line(&id, &line)
}

#[tauri::command]
async fn agent_kill(state: State<'_, AgentState>, id: String) -> Result<(), String> {
    let state = state.inner().clone();
    blocking(move || state.kill(&id)).await
}

#[tauri::command]
async fn agent_terminal_output(state: State<'_, AgentState>, id: String, task_id: String) -> Result<agent_terminal::Output, String> {
    let state = state.inner().clone();
    blocking(move || state.terminal_output(&id, &task_id)).await
}

#[tauri::command]
async fn detect_claude() -> Result<ClaudeInfo, String> {
    blocking(|| Ok(pty::detect_claude())).await
}

#[tauri::command]
async fn detect_codex() -> Result<ClaudeInfo, String> {
    blocking(|| Ok(pty::detect_codex())).await
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
async fn load_config(app: AppHandle) -> Result<AppConfig, config::LoadFailure> {
    // Un fallo de lectura llega al frontend tal cual: no se sustituye por los valores por defecto.
    tauri::async_runtime::spawn_blocking(move || config::load(&app)).await.unwrap_or_else(|error| Err(config::LoadFailure {
        kind: "unreadable", message: format!("No se pudo cargar la configuración: {error}"), backup: None, previous: false,
    }))
}

/// La copia del último arranque correcto, cuando el archivo actual está dañado. No escribe nada.
#[tauri::command]
async fn restore_config_backup(app: AppHandle) -> Result<AppConfig, String> {
    blocking(move || config::restore_previous(&app)).await
}

#[tauri::command]
async fn save_config(app: AppHandle, config: AppConfig) -> Result<AppConfig, String> {
    blocking(move || {
        config::save(&app, &config)?;
        Ok(config)
    })
    .await
}

// --- Arranque ---------------------------------------------------------------

#[tauri::command]
async fn desktop_notification(app: AppHandle, title: String, body: String) -> Result<(),String> {
    use tauri_plugin_notification::NotificationExt;
    tauri::async_runtime::spawn_blocking(move || app.notification().builder().title(title).body(body).show().map_err(|e| format!("No se pudo mostrar el aviso del escritorio: {e}"))).await.map_err(|e| e.to_string())?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    if agent_team::run_if_requested() || queue_mcp::run_if_requested() {
        return;
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_notification::init())
        .manage(PtyState::default())
        .manage(AgentState::default())
        .invoke_handler(tauri::generate_handler![
            agent_team::agent_team_open,
            agent_team::agent_team_poll,
            agent_team::agent_team_snapshot,
            agent_team::agent_team_claim,
            agent_team::agent_team_finish,
            agent_team::agent_team_pause,
            agent_team::agent_team_mcp_config,
            window_material::set_window_material,
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
            agent_terminal_output,
            detect_claude,
            detect_codex,
            antigravity::antigravity_runtime,
            antigravity::antigravity_install,
            integrations::integration_dependencies,
            integrations::github_connection_status,
            trex_cli::trex_cli_status,
            trex_cli::trex_desktop_mcp_config,
            trex_cli::trex_desktop_status,
            trex_cli::trex_a11y_status,
            trex_cli::trex_a11y_mcp_config,
            trex_browser::trex_browser_status,
            trex_browser::trex_browser_spaces,
            trex_browser::trex_browser_list_spaces,
            trex_browser::trex_browser_focus,
            trex_browser::trex_browser_engine,
            trex_browser::trex_browser_theme,
            trex_browser::trex_browser_save_folders,
            trex_browser::trex_browser_mcp_session,
            trex_browser::trex_browser_open,
            trex_browser::trex_browser_mcp_config,
            trex_browser::trex_browser_call,
            trex_browser::trex_browser_open_artifact,
            trex_browser::trex_browser_profiles,
            trex_browser::trex_browser_create_profile,
            trex_cli::trex_cli_profiles,
            trex_cli::trex_cli_models,
            trex_cli::trex_cli_save_profile,
            trex_cli::trex_cli_remove_profile,
            trex_cli::trex_cli_conversations,
            app_info,
            load_config,
            restore_config_backup,
            save_config,
            clipboard::read_clipboard,
            clipboard::write_clipboard,
            clipboard::paste_clipboard_image,
            conversations::list_conversations,
            conversations::read_conversation,
            conversations::claude_rewind_point,
            handoff::prepare_handoff,
            handoff::load_handoff,
            message_queue::message_queue_list,
            message_queue::message_queue_enqueue,
            message_queue::message_queue_update,
            message_queue::message_queue_claim_direct,
            message_queue::message_queue_ack_direct,
            message_queue::message_queue_restore_direct,
            message_queue::message_queue_remove,
            message_queue::message_queue_read,
            message_queue::message_queue_ack,
            queue_mcp::message_queue_mcp_config,
            coordination::coordination_sync,
            coordination::coordination_leave,
            coordination::coordination_record_edits,
            coordination::coordination_ack_notes,
            coordination::coordination_release,
            coordination::coordination_tools,
            coordination::coordination_call,
            attachments::read_image_file,
            attachments::read_clipboard_image,
            attachments::save_attachment,
            shared_files::file_info,
            shared_files::open_file,
            shared_files::reveal_file,
            shared_files::save_file_copy,
            shared_files::save_file_data,
            shared_files::read_file_preview,
            project_icon::project_icon,
            cli_updates::claude_update_channel,
            cli_updates::update_cli,
            git::git_branch,
            git_panel::git_project_status,
            git_panel::git_project_diff,
            git_panel::git_project_action,
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
