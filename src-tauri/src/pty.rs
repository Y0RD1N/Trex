// Motor de terminales (PTY) de trex.
//
// Responsabilidades:
//  - Abrir un PTY real (ConPTY en Windows, openpty en Unix) por cada pestaña.
//  - Lanzar el shell del usuario y, opcionalmente, un comando dentro de él (Claude Code).
//  - Bombear la salida del PTY al frontend en base64 (para no romper UTF-8) y recibir teclas.
//  - Redimensionar, matar procesos y limpiar sesiones.
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::Engine as _;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use crate::output_flow::OutputFlow;
use crate::terminal_env::{configure_claude_display, configure_terminal_colors};

fn default_cols() -> u16 {
    80
}
fn default_rows() -> u16 {
    24
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnRequest {
    pub id: String,
    pub cwd: String,
    #[serde(default)]
    pub command: Option<String>,
    #[serde(default)]
    pub args: Option<String>,
    #[serde(default)]
    pub shell: Option<String>,
    #[serde(default)]
    pub env: Option<HashMap<String, String>>,
    #[serde(default = "default_cols")]
    pub cols: u16,
    #[serde(default = "default_rows")]
    pub rows: u16,
    /// "arg" (pasa el comando como argumento del shell) o "inject" (lo escribe tras arrancar).
    #[serde(default)]
    pub launch_mode: Option<String>,
    /// El frontend devuelve créditos después de procesar cada bloque.
    #[serde(default)]
    pub flow_control: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnResponse {
    pub id: String,
    pub program: String,
    pub args_preview: String,
    pub cwd: String,
    pub shell_name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub id: String,
    pub cwd: String,
    pub program: String,
    pub args_preview: String,
    pub alive: bool,
    pub cols: u16,
    pub rows: u16,
    pub created_at: u64,
}

struct Session {
    id: String,
    cwd: String,
    program: String,
    args_preview: String,
    cols: u16,
    rows: u16,
    created_at: u64,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    master: Box<dyn MasterPty + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    alive: bool,
    output_flow: Arc<OutputFlow>,
}

struct Inner {
    sessions: HashMap<String, Session>,
}

/// Estado compartido con Tauri.
#[derive(Clone, Default)]
pub struct PtyState {
    inner: Arc<Mutex<Inner>>,
}

impl Default for Inner {
    fn default() -> Self {
        Inner {
            sessions: HashMap::new(),
        }
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub(crate) fn is_windows() -> bool {
    cfg!(windows)
}

/// Busca un ejecutable en el PATH (con extensiones en Windows).
fn which(program: &str) -> Option<String> {
    which_in(program, std::env::var_os("PATH")?)
}

/// Busca un ejecutable en una lista de carpetas con el formato de PATH.
pub(crate) fn which_in(program: &str, path: std::ffi::OsString) -> Option<String> {
    let exts: Vec<String> = if is_windows() {
        std::env::var("PATHEXT")
            .unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_string())
            .split(';')
            .map(|s| s.trim().to_ascii_lowercase())
            .collect()
    } else {
        vec![]
    };
    let has_ext = std::path::Path::new(program).extension().is_some();

    for dir in std::env::split_paths(&path) {
        let direct = dir.join(program);
        if direct.is_file() {
            return Some(direct.to_string_lossy().to_string());
        }
        if is_windows() && !has_ext {
            for ext in &exts {
                let cand = dir.join(format!("{program}{ext}"));
                if cand.is_file() {
                    return Some(cand.to_string_lossy().to_string());
                }
            }
        }
    }
    None
}

fn file_exists(p: &str) -> bool {
    std::path::Path::new(p).is_file()
}

/// Carpetas habituales de los CLI, también al abrir trex desde el escritorio.
fn agent_bin_dirs() -> Vec<String> {
    let mut dirs: Vec<String> = Vec::new();

    for program in ["claude", "codex"] {
        if let Some(found) = which(program) {
            if let Some(parent) = std::path::Path::new(&found).parent() {
                dirs.push(parent.to_string_lossy().to_string());
            }
        }
    }

    if let Some(home) = home_dir() {
        let mut candidates: Vec<String> = Vec::new();
        if is_windows() {
            for rel in [
                ".local\\bin",
                ".bun\\bin",
                ".claude\\local",
                "AppData\\Roaming\\npm",
                "AppData\\Local\\pnpm",
                "AppData\\Local\\Programs\\claude",
            ] {
                candidates.push(format!("{home}\\{rel}"));
            }
        } else {
            for rel in [".local/bin", ".bun/bin", ".claude/local", ".npm-global/bin", ".local/share/pnpm", ".local/share/mise/shims", ".volta/bin"] {
                candidates.push(format!("{home}/{rel}"));
            }
            candidates.push("/usr/local/bin".to_string());
            candidates.push("/usr/bin".to_string());
            candidates.push("/opt/homebrew/bin".to_string());
        }
        for candidate in candidates {
            if std::path::Path::new(&candidate).is_dir() {
                dirs.push(candidate);
            }
        }
    }

    dirs.sort();
    dirs.dedup();
    dirs
}

/// Conserva la prioridad del PATH del usuario y añade las carpetas que falten.
pub(crate) fn enriched_path() -> Option<String> {
    let current = std::env::var("PATH").ok().unwrap_or_default();
    let current_dirs: Vec<_> = std::env::split_paths(&current).collect();
    let extra: Vec<String> = agent_bin_dirs()
        .into_iter()
        .filter(|dir| !current_dirs.iter().any(|existing| {
            if is_windows() { existing.to_string_lossy().eq_ignore_ascii_case(dir) }
            else { existing == std::path::Path::new(dir) }
        }))
        .collect();
    if extra.is_empty() {
        return None;
    }

    let mut combined = Vec::new();
    if !current.is_empty() {
        combined.push(current);
    }
    combined.extend(extra);
    Some(combined.join(if is_windows() { ";" } else { ":" }))
}

pub(crate) fn expand_config_dir(value: &str) -> String {
    if value.starts_with("~/") || value.starts_with("~\\") {
        if let Some(home) = home_dir() {
            return std::path::Path::new(&home).join(&value[2..]).to_string_lossy().into_owned();
        }
    }
    value.to_string()
}

pub(crate) fn home_dir() -> Option<String> {
    if is_windows() {
        std::env::var_os("USERPROFILE")
            .map(|v| v.to_string_lossy().to_string())
            .or_else(|| std::env::var_os("HOME").map(|v| v.to_string_lossy().to_string()))
    } else {
        std::env::var_os("HOME").map(|v| v.to_string_lossy().to_string())
    }
}

/// Convierte una ruta de Windows a su equivalente dentro de WSL (C:\a\b -> /mnt/c/a/b).
pub(crate) fn windows_path_to_wsl(p: &str) -> Option<String> {
    let bytes: Vec<char> = p.chars().collect();
    if bytes.len() < 2 || bytes[1] != ':' {
        return None;
    }
    let drive = bytes[0].to_ascii_lowercase();
    let rest: String = p[2..].replace('\\', "/");
    Some(format!("/mnt/{drive}{rest}"))
}

pub(crate) struct ResolvedShell {
    pub(crate) program: String,
    name: String,
    /// Cómo hay que pasar el comando a este shell.
    pub(crate) kind: ShellKind,
}

#[derive(PartialEq)]
pub(crate) enum ShellKind {
    PowerShell,
    Cmd,
    Unix,
    Wsl,
}

pub(crate) fn resolve_shell(shell_id: &str) -> Result<ResolvedShell, String> {
    let id = shell_id.trim().to_ascii_lowercase();
    let id = if id.is_empty() { "default".to_string() } else { id };

    if is_windows() {
        match id.as_str() {
            "cmd" => Ok(ResolvedShell {
                program: "cmd.exe".into(),
                name: "Command Prompt".into(),
                kind: ShellKind::Cmd,
            }),
            "powershell" => Ok(ResolvedShell {
                program: "powershell.exe".into(),
                name: "Windows PowerShell".into(),
                kind: ShellKind::PowerShell,
            }),
            "pwsh" => Ok(ResolvedShell {
                program: which("pwsh").unwrap_or_else(|| "pwsh.exe".into()),
                name: "PowerShell 7".into(),
                kind: ShellKind::PowerShell,
            }),
            "gitbash" => {
                let candidates = [
                    r"C:\Program Files\Git\bin\bash.exe".to_string(),
                    r"C:\Program Files (x86)\Git\bin\bash.exe".to_string(),
                    which("bash").unwrap_or_default(),
                ];
                let program = candidates
                    .iter()
                    .find(|c| !c.is_empty() && file_exists(c))
                    .cloned()
                    .ok_or_else(|| "No se encontró Git Bash en el sistema.".to_string())?;
                Ok(ResolvedShell {
                    program,
                    name: "Git Bash".into(),
                    kind: ShellKind::Unix,
                })
            }
            "wsl" => Ok(ResolvedShell {
                program: "wsl.exe".into(),
                name: "WSL".into(),
                kind: ShellKind::Wsl,
            }),
            _ => {
                // Por defecto: PowerShell 7 si existe, si no Windows PowerShell.
                if let Some(pwsh) = which("pwsh") {
                    Ok(ResolvedShell {
                        program: pwsh,
                        name: "PowerShell 7".into(),
                        kind: ShellKind::PowerShell,
                    })
                } else {
                    Ok(ResolvedShell {
                        program: "powershell.exe".into(),
                        name: "Windows PowerShell".into(),
                        kind: ShellKind::PowerShell,
                    })
                }
            }
        }
    } else {
        let default_shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into());
        let program = match id.as_str() {
            "default" => default_shell,
            "bash" => "/bin/bash".to_string(),
            "zsh" => "/bin/zsh".to_string(),
            "fish" => "/bin/fish".to_string(),
            "sh" => "/bin/sh".to_string(),
            other => other.to_string(),
        };
        let name = std::path::Path::new(&program)
            .file_name()
            .map(|f| f.to_string_lossy().to_string())
            .unwrap_or_else(|| program.clone());
        Ok(ResolvedShell {
            program,
            name,
            kind: ShellKind::Unix,
        })
    }
}

/// Construye (programa, argumentos, nombre del shell) para el spawn.
fn build_command(req: &SpawnRequest) -> Result<(ResolvedShell, Vec<String>, Option<String>), String> {
    let shell = resolve_shell(req.shell.as_deref().unwrap_or("default"))?;

    let command = req
        .command
        .as_deref()
        .map(|c| c.trim())
        .filter(|c| !c.is_empty())
        .map(|c| match req.args.as_deref().map(|a| a.trim()) {
            Some(a) if !a.is_empty() => format!("{c} {a}"),
            _ => c.to_string(),
        });

    let mut args: Vec<String> = Vec::new();

    let inject = req.launch_mode.as_deref()
        .map(|mode| mode.eq_ignore_ascii_case("inject"))
        .unwrap_or(false);
    if let Some(cmd) = command.as_ref().filter(|_| !inject) {
        match shell.kind {
            ShellKind::PowerShell => {
                args.push("-NoLogo".into());
                args.push("-NoExit".into());
                args.push("-Command".into());
                args.push(cmd.clone());
            }
            ShellKind::Cmd => {
                args.push("/K".into());
                args.push(cmd.clone());
            }
            ShellKind::Unix => {
                let base = std::path::Path::new(&shell.program)
                    .file_name()
                    .map(|f| f.to_string_lossy().to_string())
                    .unwrap_or_else(|| "bash".to_string());
                args.push("-i".into());
                args.push("-c".into());
                // Al salir de Claude se vuelve al prompt del shell, en vez de cerrar la pestaña.
                args.push(format!("{cmd}; exec {base} -i"));
            }
            ShellKind::Wsl => {
                args.push("--cd".into());
                args.push(
                    windows_path_to_wsl(&req.cwd)
                        .unwrap_or_else(|| req.cwd.replace('\\', "/")),
                );
                args.push("--".into());
                args.push("bash".into());
                args.push("-i".into());
                args.push("-c".into());
                args.push(format!("{cmd}; exec bash -i"));
            }
        }
    } else {
        match shell.kind {
            ShellKind::PowerShell => args.push("-NoLogo".into()),
            ShellKind::Wsl => {
                args.push("--cd".into());
                args.push(
                    windows_path_to_wsl(&req.cwd)
                        .unwrap_or_else(|| req.cwd.replace('\\', "/")),
                );
            }
            ShellKind::Unix => args.push("-i".into()),
            _ => {}
        }
    }

    Ok((shell, args, command))
}

impl PtyState {
    pub fn spawn(&self, app: AppHandle, req: SpawnRequest) -> Result<SpawnResponse, String> {
        if req.id.trim().is_empty() {
            return Err("La sesión necesita un id.".into());
        }
        if !std::path::Path::new(&req.cwd).is_dir() {
            return Err(format!("La carpeta «{}» no existe.", req.cwd));
        }
        {
            let inner = self.inner.lock().map_err(|e| e.to_string())?;
            if inner.sessions.contains_key(&req.id) {
                return Err(format!("Ya existe una sesión con id {}", req.id));
            }
        }

        let (shell, args, command) = build_command(&req)?;
        let size = PtySize {
            rows: req.rows.max(2),
            cols: req.cols.max(2),
            pixel_width: 0,
            pixel_height: 0,
        };

        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(size)
            .map_err(|e| format!("No se pudo abrir el PTY: {e}"))?;

        let mut cmd = CommandBuilder::new(&shell.program);
        for a in &args {
            cmd.arg(a);
        }
        cmd.cwd(&req.cwd);
        // Encuentra los CLI sin adelantar otra instalación al PATH del usuario.
        if let Some(path) = enriched_path() {
            cmd.env("PATH", path);
        }
        configure_terminal_colors(&mut cmd);
        configure_claude_display(&mut cmd);
        // Claude usa símbolos Unicode en su TUI. El proceso de la app puede
        // arrancar con una locale heredada sin UTF-8, que hace que el shell y
        // algunas librerías sustituyan esos glifos por cuadros. En Unix,
        // fuerza una locale UTF-8 estable para cada PTY.
        if !is_windows() {
            cmd.env("LANG", "C.UTF-8");
            cmd.env("LC_ALL", "C.UTF-8");
        }
        if let Some(extra) = &req.env {
            for (k, v) in extra {
                let value = if k == "CODEX_HOME" || k == "CLAUDE_CONFIG_DIR" { expand_config_dir(v) } else { v.clone() };
                cmd.env(k, value);
            }
        }
        // Algunas herramientas (Claude Code incluido) esperan un ancho de terminal válido.
        cmd.env("COLUMNS", req.cols.max(2).to_string());
        cmd.env("LINES", req.rows.max(2).to_string());

        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("No se pudo iniciar «{} {}»: {e}", shell.program, args.join(" ")))?;
        // El slave debe soltarse para que el PTY detecte el cierre.
        drop(pair.slave);

        let killer = child.clone_killer();
        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| format!("No se pudo leer del PTY: {e}"))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|e| format!("No se pudo escribir en el PTY: {e}"))?;

        let id = req.id.clone();
        let writer = Arc::new(Mutex::new(writer));
        let output_flow = Arc::new(OutputFlow::new(req.flow_control));

        let args_preview = args.join(" ");
        let session = Session {
            id: id.clone(),
            cwd: req.cwd.clone(),
            program: shell.program.clone(),
            args_preview: args_preview.clone(),
            cols: req.cols,
            rows: req.rows,
            created_at: now_ms(),
            writer: writer.clone(),
            master: pair.master,
            killer,
            alive: true,
            output_flow: output_flow.clone(),
        };
        {
            let mut inner = self.inner.lock().map_err(|e| e.to_string())?;
            inner.sessions.insert(id.clone(), session);
        }

        // Hilo lector: PTY -> frontend (base64 para preservar UTF-8).
        let (reader_done_tx, reader_done_rx) = std::sync::mpsc::channel();
        {
            let app = app.clone();
            let id = id.clone();
            let output_flow = output_flow.clone();
            thread::spawn(move || {
                let mut buf = [0u8; 16384];
                let decoder = base64::engine::general_purpose::STANDARD;
                let event = format!("pty-data-{id}");
                loop {
                    match reader.read(&mut buf) {
                        Ok(0) => break,
                        Ok(n) => {
                            if !output_flow.reserve(n) { break; }
                            let payload = serde_json::json!({
                                "data": decoder.encode(&buf[..n]),
                            });
                            if app.emit(&event, payload).is_err() {
                                output_flow.stop();
                                break;
                            }
                        }
                        Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                        Err(_) => break,
                    }
                }
                let _ = reader_done_tx.send(());
            });
        }

        // Hilo de espera: avisa del fin del proceso y libera la sesión.
        {
            let app = app.clone();
            let id = id.clone();
            let state = self.clone();
            let mut child = child;
            thread::spawn(move || {
                let code = match child.wait() {
                    Ok(status) => status.exit_code() as i64,
                    Err(_) => -1,
                };
                // Permite vaciar la cola final antes de avisar. No espera
                // indefinidamente a un descendiente que conserve el PTY abierto
                // ni al cierre de ConPTY (que puede necesitar soltar el master).
                let _ = reader_done_rx.recv_timeout(Duration::from_millis(500));
                let _ = app.emit(
                    &format!("pty-exit-{id}"),
                    serde_json::json!({ "code": code }),
                );
                if let Ok(mut inner) = state.inner.lock() {
                    if let Some(session) = inner.sessions.get_mut(&id) {
                        session.alive = false;
                    }
                }
            });
        }

        // Modo "inject": el shell arranca interactivo y escribimos el comando después.
        let inject = req
            .launch_mode
            .as_deref()
            .map(|m| m.eq_ignore_ascii_case("inject"))
            .unwrap_or(false);

        if inject {
            if let Some(cmd) = command {
                let writer = writer.clone();
                thread::spawn(move || {
                    thread::sleep(Duration::from_millis(700));
                    if let Ok(mut w) = writer.lock() {
                        let _ = w.write_all(format!("{cmd}\r").as_bytes());
                        let _ = w.flush();
                    }
                });
            }
        }

        Ok(SpawnResponse {
            id,
            program: shell.program,
            args_preview,
            cwd: req.cwd,
            shell_name: shell.name,
        })
    }

    pub fn write(&self, id: &str, data: &str) -> Result<(), String> {
        let writer = {
            let inner = self.inner.lock().map_err(|e| e.to_string())?;
            let session = inner
                .sessions
                .get(id)
                .ok_or_else(|| format!("La sesión {id} no existe."))?;
            session.writer.clone()
        };
        let mut w = writer.lock().map_err(|e| e.to_string())?;
        w.write_all(data.as_bytes())
            .map_err(|e| format!("No se pudo escribir en el PTY: {e}"))?;
        w.flush().map_err(|e| format!("No se pudo vaciar el buffer: {e}"))
    }

    pub fn acknowledge(&self, id: &str, bytes: usize) -> Result<(), String> {
        let flow = {
            let inner = self.inner.lock().map_err(|e| e.to_string())?;
            inner.sessions.get(id).map(|s| s.output_flow.clone())
        };
        // Un último callback puede llegar después de cerrar la pestaña.
        if let Some(flow) = flow { flow.acknowledge(bytes); }
        Ok(())
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let mut inner = self.inner.lock().map_err(|e| e.to_string())?;
        let session = inner
            .sessions
            .get_mut(id)
            .ok_or_else(|| format!("La sesión {id} no existe."))?;
        let size = PtySize {
            rows: rows.max(2),
            cols: cols.max(2),
            pixel_width: 0,
            pixel_height: 0,
        };
        session
            .master
            .resize(size)
            .map_err(|e| format!("No se pudo redimensionar: {e}"))?;
        session.cols = cols;
        session.rows = rows;
        Ok(())
    }

    pub fn kill(&self, id: &str) -> Result<Option<i64>, String> {
        let mut session = {
            let mut inner = self.inner.lock().map_err(|e| e.to_string())?;
            inner.sessions.remove(id)
        };
        if let Some(session) = session.as_mut() {
            session.output_flow.stop();
            let _ = session.killer.kill();
            session.alive = false;
            // Al soltar el master (drop) el PTY se cierra y el proceso recibe EOF/HUP.
        }
        Ok(None)
    }

    pub fn list(&self) -> Vec<SessionInfo> {
        let inner = match self.inner.lock() {
            Ok(i) => i,
            Err(_) => return vec![],
        };
        let mut out: Vec<SessionInfo> = inner
            .sessions
            .values()
            .map(|s| SessionInfo {
                id: s.id.clone(),
                cwd: s.cwd.clone(),
                program: s.program.clone(),
                args_preview: s.args_preview.clone(),
                alive: s.alive,
                cols: s.cols,
                rows: s.rows,
                created_at: s.created_at,
            })
            .collect();
        out.sort_by_key(|s| s.created_at);
        out
    }

    pub fn kill_all(&self) {
        let ids: Vec<String> = match self.inner.lock() {
            Ok(inner) => inner.sessions.keys().cloned().collect(),
            Err(_) => return,
        };
        for id in ids {
            let _ = self.kill(&id);
        }
    }
}

/// Detección de Claude Code: PATH + rutas típicas del instalador nativo y de npm.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeCandidate {
    pub path: String,
    pub exists: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeInfo {
    pub found: bool,
    pub path: Option<String>,
    pub version: Option<String>,
    pub source: Option<String>,
    pub hint: Option<String>,
    pub candidates: Vec<ClaudeCandidate>,
}

pub fn detect_claude() -> ClaudeInfo {
    let mut candidates: Vec<ClaudeCandidate> = Vec::new();

    if let Some(from_path) = which("claude") {
        candidates.push(ClaudeCandidate {
            path: from_path,
            exists: true,
        });
    }

    let mut known: Vec<String> = Vec::new();
    if is_windows() {
        if let Some(home) = home_dir() {
            known.push(format!("{home}\\.local\\bin\\claude.exe"));
            known.push(format!("{home}\\.local\\bin\\claude.cmd"));
            known.push(format!("{home}\\.bun\\bin\\claude.exe"));
            known.push(format!("{home}\\.claude\\local\\claude.exe"));
        }
        if let Some(appdata) = std::env::var_os("APPDATA") {
            let p = std::path::PathBuf::from(appdata).join("npm").join("claude.cmd");
            known.push(p.to_string_lossy().to_string());
        }
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            let base = std::path::PathBuf::from(&local);
            known.push(base.join("Programs").join("claude").join("claude.exe").to_string_lossy().to_string());
            known.push(base.join("Microsoft").join("WinGet").join("Links").join("claude.exe").to_string_lossy().to_string());
            known.push(base.join("pnpm").join("claude.cmd").to_string_lossy().to_string());
        }
    } else {
        if let Some(home) = home_dir() {
            known.push(format!("{home}/.local/bin/claude"));
            known.push(format!("{home}/.claude/local/claude"));
            known.push(format!("{home}/.bun/bin/claude"));
            known.push(format!("{home}/.npm-global/bin/claude"));
        }
        known.push("/usr/local/bin/claude".into());
        known.push("/usr/bin/claude".into());
        known.push("/opt/homebrew/bin/claude".into());
        known.push("/snap/bin/claude".into());
    }

    for path in known {
        let exists = file_exists(&path) || std::path::Path::new(&path).is_dir();
        if exists && !candidates.iter().any(|c| c.path == path) {
            candidates.push(ClaudeCandidate { path, exists: true });
        } else if !exists {
            candidates.push(ClaudeCandidate { path, exists: false });
        }
    }

    let found = candidates.iter().find(|c| c.exists).cloned();
    let (path, version, source) = match found {
        Some(c) => {
            let is_path = which("claude").map(|p| p == c.path).unwrap_or(false);
            let version = read_claude_version(&c.path);
            (
                Some(c.path),
                version,
                Some(if is_path { "PATH".to_string() } else { "instalación local".to_string() }),
            )
        }
        None => (None, None, None),
    };

    let hint = if path.is_none() {
        Some(if is_windows() {
            "Instálalo con PowerShell: irm https://claude.ai/install.ps1 | iex  (o winget install Anthropic.ClaudeCode)".to_string()
        } else {
            "Instálalo con: curl -fsSL https://claude.ai/install.sh | bash  (o npm install -g @anthropic-ai/claude-code)".to_string()
        })
    } else {
        None
    };

    ClaudeInfo {
        found: path.is_some(),
        path,
        version,
        source,
        hint,
        candidates,
    }
}

pub fn detect_codex() -> ClaudeInfo {
    let mut candidates = Vec::new();
    if let Some(path) = which("codex") { candidates.push(ClaudeCandidate { path, exists: true }); }
    for dir in agent_bin_dirs() {
        let names: &[&str] = if is_windows() { &["codex.exe", "codex.cmd", "codex"] } else { &["codex"] };
        for name in names {
            let path = std::path::Path::new(&dir).join(name).to_string_lossy().into_owned();
            if !candidates.iter().any(|candidate| candidate.path == path) {
                candidates.push(ClaudeCandidate { exists: file_exists(&path), path });
            }
        }
    }
    let path = candidates.iter().find(|candidate| candidate.exists).map(|candidate| candidate.path.clone());
    let version = path.as_deref().and_then(read_cli_version);
    let source = path.as_ref().map(|path| if which("codex").as_ref() == Some(path) { "PATH".into() } else { "instalación local".into() });
    ClaudeInfo { found: path.is_some(), path, version, source,
        hint: Some("Usa el comando codex instalado en tu equipo o configura su ruta en Asistentes.".into()), candidates }
}

fn read_claude_version(path: &str) -> Option<String> { read_cli_version(path) }

fn read_cli_version(path: &str) -> Option<String> {
    use std::process::{Command, Stdio};

    let mut cmd = if is_windows() && path.to_ascii_lowercase().ends_with(".cmd") {
        let mut c = Command::new("cmd.exe");
        c.arg("/C").arg(path).arg("--version");
        c
    } else {
        let mut c = Command::new(path);
        c.arg("--version");
        c
    };
    cmd.stdout(Stdio::piped()).stderr(Stdio::null()).stdin(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // Estas comprobaciones no son terminales interactivas. También evita
        // el parpadeo al ejecutar los lanzadores .cmd instalados con npm.
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }

    let mut child = cmd.spawn().ok()?;
    let start = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if start.elapsed() > Duration::from_secs(5) {
                    let _ = child.kill();
                    return None;
                }
                thread::sleep(Duration::from_millis(60));
            }
            Err(_) => return None,
        }
    }
    let out = child.wait_with_output().ok()?;
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if text.is_empty() {
        None
    } else {
        Some(text.lines().next().unwrap_or("").to_string())
    }
}

#[cfg(test)]
mod launcher_tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn version_probe_child() {
        let mode = std::env::var("TREX_VERSION_PROBE_CHILD");
        if mode.as_deref() == Ok("console") {
            #[link(name = "kernel32")]
            extern "system" {
                fn GetConsoleWindow() -> *mut std::ffi::c_void;
            }
            assert!(unsafe { GetConsoleWindow() }.is_null(), "La comprobación abrió una consola");
            return;
        }
        if mode.as_deref() != Ok("probe") { return; }
        let dir = std::env::temp_dir().join(format!("trex-version-probe-{}-{}", std::process::id(), now_ms()));
        std::fs::create_dir_all(&dir).unwrap();
        struct Cleanup(std::path::PathBuf);
        impl Drop for Cleanup {
            fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); }
        }
        let _cleanup = Cleanup(dir.clone());
        let script = dir.join("version probe.cmd");
        let test_exe = std::env::current_exe().unwrap();
        std::fs::write(&script, format!(
            "@echo off\r\nset TREX_VERSION_PROBE_CHILD=console\r\n\"{}\" --exact pty::launcher_tests::version_probe_child --quiet >nul 2>nul\r\nif errorlevel 1 (echo console-visible) else (echo test-cli 1.2.3)\r\n",
            test_exe.display()
        )).unwrap();
        assert_eq!(read_cli_version(script.to_str().unwrap()).as_deref(), Some("test-cli 1.2.3"));
    }

    #[cfg(windows)]
    #[test]
    fn cli_version_checks_do_not_open_console_windows() {
        use std::os::windows::process::CommandExt;
        // Simula una app de escritorio sin consola, aunque cargo tenga una.
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "pty::launcher_tests::version_probe_child", "--nocapture"])
            .env("TREX_VERSION_PROBE_CHILD", "probe")
            .creation_flags(0x0000_0008) // DETACHED_PROCESS
            .output().unwrap();
        assert!(output.status.success(), "{}\n{}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
    }

    fn request(command: &str, mode: &str) -> SpawnRequest {
        serde_json::from_value(serde_json::json!({
            "id": "test-profile", "cwd": std::env::temp_dir().to_string_lossy(),
            "command": command, "args": "--continue", "shell": "bash", "launchMode": mode
        })).unwrap()
    }

    #[test]
    fn compatible_mode_leaves_the_command_for_injection_instead_of_running_it_twice() {
        let (_, args, command) = build_command(&request("claude2", "inject")).unwrap();
        assert_eq!(command.as_deref(), Some("claude2 --continue"));
        assert!(!args.iter().any(|arg| arg.contains("claude2")));
        if !is_windows() { assert_eq!(args, vec!["-i"]); }
    }

    #[test]
    fn config_directories_expand_home_and_preserve_spaces() {
        let home = home_dir().unwrap();
        assert_eq!(expand_config_dir("~/.codex work"), std::path::Path::new(&home).join(".codex work").to_string_lossy());
        assert_eq!(expand_config_dir("/tmp/claude account 2"), "/tmp/claude account 2");
    }

    #[cfg(unix)]
    #[test]
    fn real_pty_resolves_separate_aliases_and_account_directories() {
        let root = std::env::temp_dir().join(format!("trex-profile-test-{}-{}", std::process::id(), now_ms()));
        std::fs::create_dir_all(&root).unwrap();
        struct Cleanup(std::path::PathBuf);
        impl Drop for Cleanup { fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); } }
        let _cleanup = Cleanup(root.clone());
        std::fs::write(root.join(".bashrc"), "alias claude1='printf \"claude1|%s|%s\\n\" \"$CLAUDE_CONFIG_DIR\"'\nalias claude2='printf \"claude2|%s|%s\\n\" \"$CLAUDE_CONFIG_DIR\"'\ncodex() { printf 'codex|%s|%s\\n' \"$CODEX_HOME\" \"$*\"; }\n").unwrap();
        for (program, key, folder, flags) in [
            ("claude1", "CLAUDE_CONFIG_DIR", "account one", "--continue"),
            ("claude2", "CLAUDE_CONFIG_DIR", "account two", "--resume"),
            ("codex", "CODEX_HOME", "codex work", "resume --last"),
        ] {
            let mut req = request(program, "arg");
            req.args = Some(format!("{flags}; exit"));
            let (shell, args, _) = build_command(&req).unwrap();
            let pair = native_pty_system().openpty(PtySize { rows: 24, cols: 120, pixel_width: 0, pixel_height: 0 }).unwrap();
            let mut cmd = CommandBuilder::new(shell.program);
            cmd.args(args);
            cmd.cwd(&root);
            cmd.env("HOME", &root);
            cmd.env(key, folder);
            let mut child = pair.slave.spawn_command(cmd).unwrap();
            drop(pair.slave);
            let mut reader = pair.master.try_clone_reader().unwrap();
            let mut output = Vec::new();
            let mut buffer = [0u8; 1024];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) | Err(_) => break,
                    Ok(count) => output.extend_from_slice(&buffer[..count]),
                }
            }
            assert!(child.wait().unwrap().success());
            let text = String::from_utf8_lossy(&output);
            assert!(text.contains(&format!("{program}|{folder}|{flags}")), "{text}");
            assert!(!text.contains("command not found"), "{text}");
        }
    }
}
