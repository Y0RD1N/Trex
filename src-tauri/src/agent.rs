// Asistentes en modo chat.
//
// El CLI (Claude Code o Codex) se ejecuta sin terminal y habla JSON por líneas:
// trex escribe en su stdin y reenvía cada línea de stdout al frontend, que es
// quien interpreta el protocolo. Este módulo no conoce los mensajes; solo
// lanza el proceso con la cuenta y la carpeta del perfil, y lo termina.
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::pty::{
    enriched_path, expand_config_dir, is_windows, resolve_shell, which_in, windows_path_to_wsl,
    ShellKind,
};

/// Límite de cada línea de stderr reenviada: basta para mostrar el error.
const STDERR_LINE_LIMIT: usize = 4000;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSpawnRequest {
    pub id: String,
    pub cwd: String,
    /// Comando del perfil: un ejecutable, un alias o una función del shell.
    pub command: String,
    /// Argumentos libres del perfil, tal como los escribió el usuario.
    #[serde(default)]
    pub profile_args: Option<String>,
    /// Opciones del protocolo que añade trex, ya separadas.
    #[serde(default)]
    pub flags: Vec<String>,
    #[serde(default)]
    pub shell: Option<String>,
    #[serde(default)]
    pub env: Option<HashMap<String, String>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSpawnResponse {
    pub id: String,
    pub program: String,
    /// El comando no era un ejecutable y se lanzó a través del shell.
    pub via_shell: bool,
}

pub enum AgentEvent {
    Line(String),
    Stderr(String),
    Exit(Option<i32>),
}

struct AgentSession {
    stdin: Arc<Mutex<Option<ChildStdin>>>,
    pid: u32,
    alive: Arc<AtomicBool>,
    terminal_logs: Arc<crate::agent_terminal::TerminalLogs>,
}

/// Estado compartido con Tauri.
#[derive(Clone, Default)]
pub struct AgentState {
    inner: Arc<Mutex<HashMap<String, AgentSession>>>,
}

struct Launch {
    program: String,
    args: Vec<String>,
    via_shell: bool,
}

/// Separa los argumentos libres de un perfil respetando comillas.
/// En Windows la barra invertida es parte de las rutas y no escapa nada.
pub(crate) fn split_args(input: &str, windows: bool) -> Result<Vec<String>, String> {
    let mut args = Vec::new();
    let mut current = String::new();
    let mut started = false;
    let mut chars = input.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\'' => {
                started = true;
                loop {
                    match chars.next() {
                        Some('\'') => break,
                        Some(inner) => current.push(inner),
                        None => return Err("Hay una comilla simple sin cerrar en los argumentos del perfil.".into()),
                    }
                }
            }
            '"' => {
                started = true;
                loop {
                    match chars.next() {
                        Some('"') => break,
                        Some('\\') if !windows && matches!(chars.peek(), Some('"') | Some('\\')) => {
                            current.push(chars.next().unwrap_or('\\'));
                        }
                        Some(inner) => current.push(inner),
                        None => return Err("Hay una comilla doble sin cerrar en los argumentos del perfil.".into()),
                    }
                }
            }
            '\\' if !windows => {
                started = true;
                if let Some(next) = chars.next() {
                    current.push(next);
                }
            }
            c if c.is_whitespace() => {
                if started {
                    args.push(std::mem::take(&mut current));
                    started = false;
                }
            }
            c => {
                started = true;
                current.push(c);
            }
        }
    }
    if started {
        args.push(current);
    }
    Ok(args)
}

fn quote_posix(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn quote_powershell(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn shell_line(command: &str, profile_args: &str, flags: &[String], quote: fn(&str) -> String) -> String {
    let mut parts = vec![command.to_string()];
    if !profile_args.is_empty() {
        parts.push(profile_args.to_string());
    }
    parts.extend(flags.iter().map(|flag| quote(flag)));
    parts.join(" ")
}

/// Decide cómo lanzar el comando: directo si es un ejecutable y, si no, a
/// través del shell del perfil para que funcionen alias y funciones.
fn build_launch(req: &AgentSpawnRequest, search_path: Option<std::ffi::OsString>) -> Result<Launch, String> {
    let command = req.command.trim();
    if command.is_empty() {
        return Err("El perfil no tiene comando.".into());
    }
    let profile_args = req.profile_args.as_deref().unwrap_or("").trim();
    if [command, profile_args].iter().any(|value| value.contains(['\r', '\n', '\0'])) {
        return Err("El comando y los argumentos del perfil deben ocupar una sola línea.".into());
    }
    // Trex is optional and app-owned: never accept an unrelated PATH binary or
    // shell alias. Its API protocol runs directly even if the profile uses WSL.
    if crate::trex_cli::is_trex_command(&req.command) {
        let program = crate::trex_cli::installed_cli_path()?.to_string_lossy().into_owned();
        return direct_trex_launch(req, program);
    }
    let shell = resolve_shell(req.shell.as_deref().unwrap_or("default"))?;

    if shell.kind == ShellKind::Wsl {
        let cwd = windows_path_to_wsl(&req.cwd).unwrap_or_else(|| req.cwd.replace('\\', "/"));
        return Ok(Launch {
            program: shell.program,
            args: vec!["--cd".into(), cwd, "--".into(), "bash".into(), "-lic".into(),
                shell_line(command, profile_args, &req.flags, quote_posix)],
            via_shell: true,
        });
    }

    let found = search_path.and_then(|path| which_in(command, path));
    if let Some(program) = found {
        let mut args = split_args(profile_args, is_windows())?;
        args.extend(req.flags.iter().cloned());
        return Ok(Launch { program, args, via_shell: false });
    }

    let args = match shell.kind {
        ShellKind::PowerShell => vec!["-NoLogo".into(), "-Command".into(),
            format!("& {}", shell_line(command, profile_args, &req.flags, quote_powershell))],
        ShellKind::Cmd => vec!["/D".into(), "/S".into(), "/C".into(),
            shell_line(command, profile_args, &req.flags, |flag| format!("\"{flag}\""))],
        _ => vec!["-i".into(), "-c".into(), shell_line(command, profile_args, &req.flags, quote_posix)],
    };
    Ok(Launch { program: shell.program, args, via_shell: true })
}

fn direct_trex_launch(req: &AgentSpawnRequest, program: String) -> Result<Launch, String> {
    let mut args = split_args(req.profile_args.as_deref().unwrap_or(""), is_windows())?;
    args.extend(req.flags.iter().cloned());
    Ok(Launch { program, args, via_shell: false })
}

#[cfg(unix)]
fn signal_group(pid: u32, signal: i32) {
    // El proceso lidera su propio grupo: la señal llega también a sus hijos.
    unsafe {
        libc::kill(-(pid as i32), signal);
    }
}

/// Cierra el proceso y todo lo que haya lanzado (comandos de las herramientas).
fn terminate(pid: u32, alive: Arc<AtomicBool>) {
    #[cfg(unix)]
    {
        signal_group(pid, libc::SIGTERM);
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(2000));
            if alive.load(Ordering::SeqCst) {
                signal_group(pid, libc::SIGKILL);
            }
        });
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = alive;
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .creation_flags(0x0800_0000)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

impl AgentState {
    pub fn spawn(
        &self,
        req: AgentSpawnRequest,
        emit: Arc<dyn Fn(AgentEvent) + Send + Sync>,
    ) -> Result<AgentSpawnResponse, String> {
        if req.id.trim().is_empty() {
            return Err("La sesión necesita un id.".into());
        }
        if !std::path::Path::new(&req.cwd).is_dir() {
            return Err(format!("La carpeta «{}» no existe.", req.cwd));
        }
        if self.inner.lock().map_err(|e| e.to_string())?.contains_key(&req.id) {
            return Err(format!("Ya existe una sesión con id {}", req.id));
        }

        let path = enriched_path();
        let search_path = path.clone().map(Into::into).or_else(|| std::env::var_os("PATH"));
        let launch = build_launch(&req, search_path)?;

        let mut cmd = Command::new(&launch.program);
        cmd.args(&launch.args)
            .current_dir(&req.cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(path) = path {
            cmd.env("PATH", path);
        }
        // Al abrir trex desde el escritorio puede faltar la locale.
        if !is_windows() && std::env::var_os("LANG").is_none() {
            cmd.env("LANG", "C.UTF-8");
        }
        if let Some(extra) = &req.env {
            for (key, value) in extra {
                let value = if key == "CODEX_HOME" || key == "CLAUDE_CONFIG_DIR" || key == "TREX_HOME" { expand_config_dir(value) } else { value.clone() };
                cmd.env(key, value);
            }
        }
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            cmd.process_group(0);
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            // Sin ventana de consola: la app ya es la interfaz.
            cmd.creation_flags(0x0800_0000);
        }

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("No se pudo iniciar «{}»: {e}", req.command.trim()))?;
        let pid = child.id();
        let stdout = child.stdout.take().ok_or("No se pudo leer la salida del asistente.")?;
        let stderr = child.stderr.take().ok_or("No se pudo leer los errores del asistente.")?;
        let stdin = Arc::new(Mutex::new(child.stdin.take()));
        let alive = Arc::new(AtomicBool::new(true));
        let log_root = req.env.as_ref().and_then(|env| env.get("CLAUDE_CODE_TMPDIR")).map(std::path::PathBuf::from)
            .or_else(|| std::env::var_os("CLAUDE_CODE_TMPDIR").map(Into::into)).unwrap_or_else(std::env::temp_dir);
        let terminal_logs = Arc::new(crate::agent_terminal::TerminalLogs::new(log_root));

        self.inner.lock().map_err(|e| e.to_string())?.insert(
            req.id.clone(),
            AgentSession { stdin, pid, alive: alive.clone(), terminal_logs: terminal_logs.clone() },
        );

        // stdout: una línea JSON por evento.
        let (stdout_done_tx, stdout_done_rx) = std::sync::mpsc::channel();
        {
            let emit = emit.clone();
            thread::spawn(move || {
                let mut reader = BufReader::with_capacity(64 * 1024, stdout);
                let mut buffer = Vec::new();
                loop {
                    buffer.clear();
                    match reader.read_until(b'\n', &mut buffer) {
                        Ok(0) => break,
                        Ok(_) => {
                            let line = String::from_utf8_lossy(&buffer);
                            let line = line.trim_end_matches(['\r', '\n']);
                            if !line.trim().is_empty() {
                                terminal_logs.observe(line);
                                emit(AgentEvent::Line(line.to_string()));
                            }
                        }
                        Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                        Err(_) => break,
                    }
                }
                let _ = stdout_done_tx.send(());
            });
        }

        // stderr: avisos y errores del CLI (sin cuenta, comando no encontrado…).
        {
            let emit = emit.clone();
            thread::spawn(move || {
                let reader = BufReader::new(stderr.take(64 * 1024 * 1024));
                for line in reader.lines() {
                    let Ok(line) = line else { break };
                    if line.trim().is_empty() {
                        continue;
                    }
                    emit(AgentEvent::Stderr(line.chars().take(STDERR_LINE_LIMIT).collect()));
                }
            });
        }

        // Espera el final del proceso y libera la sesión.
        {
            let state = self.clone();
            let id = req.id.clone();
            thread::spawn(move || {
                let code = child.wait().ok().and_then(|status| status.code());
                alive.store(false, Ordering::SeqCst);
                // Entrega las últimas líneas antes de avisar del cierre.
                let _ = stdout_done_rx.recv_timeout(Duration::from_millis(1500));
                if let Ok(mut inner) = state.inner.lock() {
                    if inner.get(&id).map(|session| session.pid) == Some(pid) {
                        inner.remove(&id);
                    }
                }
                emit(AgentEvent::Exit(code));
            });
        }

        Ok(AgentSpawnResponse { id: req.id, program: launch.program, via_shell: launch.via_shell })
    }

    pub fn write_line(&self, id: &str, line: &str) -> Result<(), String> {
        if line.contains(['\n', '\r']) {
            return Err("Cada mensaje debe ocupar una sola línea.".into());
        }
        let stdin = {
            let inner = self.inner.lock().map_err(|e| e.to_string())?;
            inner.get(id).map(|session| session.stdin.clone())
                .ok_or_else(|| format!("La sesión {id} ya no está activa."))?
        };
        let mut guard = stdin.lock().map_err(|e| e.to_string())?;
        let writer = guard.as_mut().ok_or("La sesión ya no acepta mensajes.")?;
        writer.write_all(line.as_bytes())
            .and_then(|_| writer.write_all(b"\n"))
            .and_then(|_| writer.flush())
            .map_err(|e| format!("No se pudo enviar el mensaje: {e}"))
    }

    pub fn terminal_output(&self, id: &str, task_id: &str) -> Result<crate::agent_terminal::Output, String> {
        let logs = self.inner.lock().map_err(|e| e.to_string())?.get(id).map(|session| session.terminal_logs.clone()).ok_or("La sesión ya no está activa.")?;
        logs.read(task_id)
    }

    pub fn kill(&self, id: &str) -> Result<(), String> {
        let session = self.inner.lock().map_err(|e| e.to_string())?.remove(id);
        if let Some(session) = session {
            // Cerrar stdin ya pide al CLI que termine; la señal asegura el resto.
            if let Ok(mut stdin) = session.stdin.lock() {
                stdin.take();
            }
            terminate(session.pid, session.alive);
        }
        Ok(())
    }

    pub fn kill_all(&self) {
        let ids: Vec<String> = match self.inner.lock() {
            Ok(inner) => inner.keys().cloned().collect(),
            Err(_) => return,
        };
        for id in ids {
            let _ = self.kill(&id);
        }
    }
}

/// Reenvía los eventos del proceso a la ventana con nombres por sesión.
pub fn tauri_emitter(app: AppHandle, id: String) -> Arc<dyn Fn(AgentEvent) + Send + Sync> {
    Arc::new(move |event| {
        let _ = match event {
            AgentEvent::Line(line) => app.emit(&format!("agent-line-{id}"), serde_json::json!({ "line": line })),
            AgentEvent::Stderr(line) => app.emit(&format!("agent-stderr-{id}"), serde_json::json!({ "line": line })),
            AgentEvent::Exit(code) => app.emit(&format!("agent-exit-{id}"), serde_json::json!({ "code": code })),
        };
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    use std::sync::mpsc;

    fn request(command: &str, profile_args: &str) -> AgentSpawnRequest {
        AgentSpawnRequest {
            id: format!("agent-test-{}", std::process::id()),
            cwd: std::env::temp_dir().to_string_lossy().into_owned(),
            command: command.into(),
            profile_args: Some(profile_args.into()),
            flags: vec!["--output-format".into(), "stream-json".into()],
            shell: Some("bash".into()),
            env: None,
        }
    }

    #[test]
    fn profile_arguments_keep_quoted_values_together() {
        assert_eq!(
            split_args(r#"--model opus --append-system-prompt "di \"hola\"" 'a b'"#, false).unwrap(),
            vec!["--model", "opus", "--append-system-prompt", "di \"hola\"", "a b"]
        );
        assert_eq!(split_args(r"--add-dir C:\work\app", true).unwrap(), vec!["--add-dir", r"C:\work\app"]);
        assert!(split_args("--name 'sin cerrar", false).is_err());
        assert!(split_args("", false).unwrap().is_empty());
        for windows in [true, false] {
            assert_eq!(
                split_args(r##"--profile 'Work'"'"'s "API"\team'"##, windows).unwrap(),
                vec!["--profile", r#"Work's "API"\team"#]
            );
        }
    }

    #[test]
    fn trex_profiles_keep_arguments_and_run_without_a_shell() {
        let mut req = request("trex-agent", "--profile 'TREX 1'");
        req.shell = Some("wsl".into());
        req.flags = vec!["app-server".into()];
        let launch = direct_trex_launch(&req, "absolute installed path with spaces".into()).unwrap();
        assert!(!launch.via_shell);
        assert_eq!(launch.program, "absolute installed path with spaces");
        assert_eq!(launch.args, ["--profile", "TREX 1", "app-server"]);
        req.profile_args = Some("--profile 'unclosed".into());
        assert!(direct_trex_launch(&req, "known sibling".into()).is_err());
    }

    #[test]
    fn reserved_trex_command_never_uses_a_path_impostor() {
        let directory = std::env::temp_dir().join(format!("trex-path-test-{}-{}", std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        std::fs::create_dir(&directory).unwrap();
        let impostor = directory.join(if is_windows() { "trex-agent.exe" } else { "trex-agent" });
        std::fs::write(&impostor, b"must never execute").unwrap();
        let mut req = request("trex-agent", "--profile TREX1");
        req.shell = Some("invalid-shell-that-must-not-be-resolved".into());
        let result = build_launch(&req, Some(std::env::join_paths([&directory]).unwrap()));
        std::fs::remove_file(&impostor).unwrap();
        std::fs::remove_dir(&directory).unwrap();
        match result {
            Ok(launch) => {
                assert_ne!(std::path::Path::new(&launch.program), impostor);
                assert!(!launch.via_shell);
            }
            Err(error) => assert!(error.contains("Trex CLI no está instalado"), "{error}"),
        }
    }

    #[cfg(unix)]
    #[test]
    fn executables_run_directly_and_aliases_go_through_the_shell() {
        let direct = build_launch(&request("sh", "--x 'a b'"), std::env::var_os("PATH")).unwrap();
        assert!(!direct.via_shell);
        assert!(direct.program.ends_with("/sh"));
        assert_eq!(direct.args, vec!["--x", "a b", "--output-format", "stream-json"]);

        let alias = build_launch(&request("claude-alias-que-no-existe", "--continue"), std::env::var_os("PATH")).unwrap();
        assert!(alias.via_shell);
        assert_eq!(alias.args[..2], ["-i", "-c"]);
        assert_eq!(alias.args[2], "claude-alias-que-no-existe --continue '--output-format' 'stream-json'");
        assert!(build_launch(&request("claude\nrm", ""), None).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn lines_flow_both_ways_and_the_exit_is_reported() {
        let state = AgentState::default();
        let (tx, rx) = mpsc::channel();
        let tx = Mutex::new(tx);
        let emit: Arc<dyn Fn(AgentEvent) + Send + Sync> = Arc::new(move |event| {
            let _ = tx.lock().unwrap().send(match event {
                AgentEvent::Line(line) => format!("line:{line}"),
                AgentEvent::Stderr(line) => format!("stderr:{line}"),
                AgentEvent::Exit(code) => format!("exit:{code:?}"),
            });
        });
        // Un "CLI" mínimo: repite cada línea de stdin y avisa por stderr.
        let mut req = request("sh", "");
        req.flags = vec!["-c".into(), "echo listo >&2; while read l; do echo \"$l\"; done".into()];
        state.spawn(req.clone(), emit).unwrap();
        state.write_line(&req.id, r#"{"type":"user"}"#).unwrap();
        assert!(state.write_line(&req.id, "dos\nlíneas").is_err());

        let mut seen = Vec::new();
        while let Ok(event) = rx.recv_timeout(Duration::from_secs(5)) {
            seen.push(event);
            if seen.iter().any(|e| e.starts_with("line:")) && seen.iter().any(|e| e.starts_with("stderr:")) {
                break;
            }
        }
        assert!(seen.contains(&r#"line:{"type":"user"}"#.to_string()), "{seen:?}");
        assert!(seen.contains(&"stderr:listo".to_string()), "{seen:?}");

        state.kill(&req.id).unwrap();
        let exit = rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(exit.starts_with("exit:"), "{exit}");
        assert!(state.write_line(&req.id, "{}").is_err());
    }
}
