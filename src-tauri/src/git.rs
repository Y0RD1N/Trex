//! Rama de git del proyecto, para mostrarla junto a la caja del chat.
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

fn git(cwd: &str, args: &[&str]) -> Option<String> {
    let mut command = Command::new("git");
    command.arg("-C").arg(cwd).args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    let mut child = command.spawn().ok()?;
    let start = Instant::now();
    // Un repositorio en red o bloqueado no debe dejar la petición colgada.
    while child.try_wait().ok()?.is_none() {
        if start.elapsed() > Duration::from_secs(3) {
            let _ = child.kill();
            return None;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    let output = child.wait_with_output().ok()?;
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (output.status.success() && !text.is_empty()).then_some(text)
}

/// Nombre de la rama actual; con HEAD separado, el commit abreviado.
pub fn branch(cwd: &str) -> Option<String> {
    if !std::path::Path::new(cwd).is_dir() {
        return None;
    }
    git(cwd, &["branch", "--show-current"]).or_else(|| git(cwd, &["rev-parse", "--short", "HEAD"]))
}

#[tauri::command]
pub async fn git_branch(cwd: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || branch(&cwd))
        .await
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_branch_and_ignores_folders_without_git() {
        let dir = std::env::temp_dir().join(format!("trex-git-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.to_string_lossy().into_owned();
        assert_eq!(branch(&path), None);
        let init = Command::new("git").args(["init", "-q", "-b", "feature/chat"]).current_dir(&dir).status();
        if init.map(|status| status.success()).unwrap_or(false) {
            assert_eq!(branch(&path).as_deref(), Some("feature/chat"));
        }
        assert_eq!(branch("/ruta/que/no/existe"), None);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
