//! Carpeta de la cuenta (CLAUDE_CONFIG_DIR o CODEX_HOME) que usa un lanzador.
//!
//! Un perfil puede apuntar a un script o a un alias que elige la cuenta por
//! dentro (por ejemplo, `claude2` exporta CLAUDE_CONFIG_DIR=~/.claude2). Para
//! saber dónde guarda sus conversaciones, el lanzador se ejecuta con un
//! `claude` o `codex` de prueba delante en el PATH que solo imprime la
//! variable: el asistente real no llega a arrancar. Si el lanzador no pasa por
//! el PATH, no se sabe nada y se usa la carpeta por defecto.
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

/// Prefijo de la línea que imprime el binario de prueba.
const MARK: &str = "trex-account:";

type Key = (String, String, String);
static CACHE: OnceLock<Mutex<HashMap<Key, Option<String>>>> = OnceLock::new();

fn variable(provider: &str) -> Option<&'static str> {
    match provider {
        "claude" => Some("CLAUDE_CONFIG_DIR"),
        "codex" => Some("CODEX_HOME"),
        _ => None,
    }
}

/// Carpeta impresa por el binario de prueba; vacía es la carpeta por defecto.
fn parse(output: &str) -> Option<String> {
    let dir = output.lines().rev().find_map(|line| line.trim().strip_prefix(MARK))?.trim();
    (!dir.is_empty()).then(|| crate::pty::expand_config_dir(dir))
}

#[cfg(unix)]
fn probe(provider: &str, command: &str, shell: &str) -> Option<String> {
    use crate::pty::{enriched_path, resolve_shell, which_in, ShellKind};
    use std::io::Read;
    use std::os::unix::fs::PermissionsExt;
    use std::os::unix::process::CommandExt;
    use std::process::{Command, Stdio};
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::time::{Duration, Instant};

    static COUNTER: AtomicU32 = AtomicU32::new(0);
    let var = variable(provider)?;
    let command = command.trim();
    if command.is_empty() || command.contains(['\r', '\n', '\0', '\'']) {
        return None;
    }
    let dir = std::env::temp_dir().join(format!(
        "trex-account-{}-{}",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::SeqCst)
    ));
    std::fs::create_dir_all(&dir).ok()?;
    let fake = dir.join(provider);
    let written = std::fs::write(&fake, format!("#!/bin/sh\nprintf '\\n{MARK}%s\\n' \"${{{var}:-}}\"\n"))
        .and_then(|_| std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)));
    if written.is_err() {
        let _ = std::fs::remove_dir_all(&dir);
        return None;
    }

    let base = enriched_path().or_else(|| std::env::var("PATH").ok()).unwrap_or_default();
    let mut cmd = match which_in(command, base.clone().into()) {
        // Un script: hereda el PATH con el binario de prueba delante.
        Some(program) => {
            let mut cmd = Command::new(program);
            cmd.arg("--version");
            cmd
        }
        // Un alias o una función: solo los conoce el shell interactivo, que puede
        // rehacer el PATH al leer su configuración; por eso se antepone otra vez.
        None => {
            let shell = resolve_shell(if shell.trim().is_empty() { "default" } else { shell }).ok()?;
            if shell.kind != ShellKind::Unix {
                let _ = std::fs::remove_dir_all(&dir);
                return None;
            }
            let mut cmd = Command::new(shell.program);
            cmd.args(["-i", "-c", &format!("PATH='{}':\"$PATH\"; {command} --version", dir.display())]);
            cmd
        }
    };
    cmd.env("PATH", format!("{}:{base}", dir.display()))
        .env_remove(var)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .process_group(0);
    let Ok(mut child) = cmd.spawn() else {
        let _ = std::fs::remove_dir_all(&dir);
        return None;
    };
    let mut stdout = child.stdout.take()?;
    let reader = std::thread::spawn(move || {
        let mut output = String::new();
        let _ = stdout.read_to_string(&mut output);
        output
    });
    // Si el lanzador arranca el asistente real o se queda esperando, se corta.
    let deadline = Instant::now() + Duration::from_secs(6);
    while matches!(child.try_wait(), Ok(None)) {
        if Instant::now() >= deadline {
            unsafe {
                libc::kill(-(child.id() as i32), libc::SIGKILL);
            }
            break;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    let _ = child.wait();
    let output = reader.join().unwrap_or_default();
    let _ = std::fs::remove_dir_all(&dir);
    parse(&output)
}

#[cfg(not(unix))]
fn probe(_provider: &str, _command: &str, _shell: &str) -> Option<String> {
    None
}

/// Carpeta de la cuenta del lanzador, si la elige él mismo (se calcula una vez).
pub fn account_dir(provider: &str, command: &str, shell: &str) -> Option<String> {
    let key = (provider.to_string(), command.trim().to_string(), shell.trim().to_string());
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some(found) = cache.lock().ok().and_then(|cache| cache.get(&key).cloned()) {
        return found;
    }
    let found = probe(provider, command, shell);
    if let Ok(mut cache) = cache.lock() {
        cache.insert(key, found.clone());
    }
    found
}

#[tauri::command]
pub async fn detect_account_dir(provider: String, command: String, shell: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || account_dir(&provider, &command, &shell))
        .await
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_printed_folder_wins_and_an_empty_one_means_the_default() {
        assert_eq!(parse("Bienvenido\ntrex-account:/home/a/.claude2\n"), Some("/home/a/.claude2".into()));
        assert_eq!(parse("trex-account:\n"), None);
        assert_eq!(parse("2.1.296 (Claude Code)\n"), None, "el asistente real arrancó: no se sabe");
    }

    #[cfg(unix)]
    #[test]
    fn a_launcher_script_reveals_its_account_folder() {
        use std::os::unix::fs::PermissionsExt;
        let bin = std::env::temp_dir().join(format!("trex-account-test-{}", std::process::id()));
        std::fs::create_dir_all(&bin).unwrap();
        let write = |name: &str, body: &str| {
            let path = bin.join(name);
            std::fs::write(&path, body).unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
            path.to_string_lossy().into_owned()
        };
        let second = write("claude-second", "#!/bin/sh\nexport CLAUDE_CONFIG_DIR=\"/tmp/cuenta dos\"\nexec claude \"$@\"\n");
        let main = write("claude-main", "#!/bin/sh\nunset CLAUDE_CONFIG_DIR\nexec claude \"$@\"\n");
        let codex = write("codex-work", "#!/bin/sh\nCODEX_HOME=/tmp/codex-work exec codex \"$@\"\n");
        assert_eq!(probe("claude", &second, "sh"), Some("/tmp/cuenta dos".into()));
        assert_eq!(probe("claude", &main, "sh"), None);
        assert_eq!(probe("codex", &codex, "sh"), Some("/tmp/codex-work".into()));
        let _ = std::fs::remove_dir_all(&bin);
    }
}
