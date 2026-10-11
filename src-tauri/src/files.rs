//! Archivos del proyecto, para mencionarlos con `@` en el chat.
//!
//! En un repositorio se usa `git ls-files` (respeta .gitignore e incluye los
//! archivos nuevos sin seguimiento). Fuera de git se recorren las carpetas
//! saltando las de dependencias y compilados. Las rutas son relativas al
//! proyecto y con `/`, también en Windows.
use std::collections::VecDeque;
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// Tope de rutas: basta para buscar y no satura la interfaz en monorepos.
const LIMIT: usize = 30_000;
const MAX_DEPTH: usize = 12;
const SKIPPED_DIRS: &[&str] = &[
    ".git", "node_modules", "target", "dist", "build", "out", ".next", ".nuxt", ".svelte-kit", ".turbo",
    ".venv", "venv", "__pycache__", ".mypy_cache", ".pytest_cache", ".cache", ".gradle", ".idea", "vendor",
];

/// Salida de git con tiempo límite. La salida se lee mientras git trabaja: si
/// no, una lista larga llenaría la tubería y git se quedaría esperando.
fn git_lines(cwd: &Path, args: &[&str], timeout: Duration) -> Option<Vec<u8>> {
    let mut command = Command::new("git");
    command.arg("-C").arg(cwd).args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    let mut child = command.spawn().ok()?;
    let mut stdout = child.stdout.take()?;
    let reader = std::thread::spawn(move || {
        let mut buffer = Vec::new();
        stdout.read_to_end(&mut buffer).map(|_| buffer)
    });
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => break,
            Ok(Some(_)) | Err(_) => return None,
            Ok(None) if start.elapsed() > timeout => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(10)),
        }
    }
    reader.join().ok()?.ok()
}

fn git_files(root: &Path) -> Option<Vec<String>> {
    let output = git_lines(root, &["ls-files", "--cached", "--others", "--exclude-standard", "-z"], Duration::from_secs(5))?;
    let mut files: Vec<String> = output
        .split(|byte| *byte == 0)
        .filter(|entry| !entry.is_empty())
        .map(|entry| String::from_utf8_lossy(entry).replace('\\', "/"))
        // Los archivos borrados siguen en el índice hasta el siguiente commit.
        .filter(|path| root.join(path).exists())
        .take(LIMIT)
        .collect();
    files.sort();
    files.dedup();
    Some(files)
}

fn walk_files(root: &Path) -> Vec<String> {
    let mut files = Vec::new();
    let mut pending = VecDeque::from([(root.to_path_buf(), 0usize)]);
    while let Some((dir, depth)) = pending.pop_front() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        let mut entries: Vec<_> = entries.flatten().collect();
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            let name = entry.file_name().to_string_lossy().into_owned();
            let Ok(kind) = entry.file_type() else { continue };
            if kind.is_dir() {
                if depth < MAX_DEPTH && !SKIPPED_DIRS.contains(&name.as_str()) {
                    pending.push_back((entry.path(), depth + 1));
                }
            } else if let Ok(relative) = entry.path().strip_prefix(root) {
                files.push(relative.to_string_lossy().replace('\\', "/"));
                if files.len() >= LIMIT {
                    return files;
                }
            }
        }
    }
    files.sort();
    files
}

/// Archivos del proyecto, relativos a su carpeta.
pub fn list(cwd: &str) -> Result<Vec<String>, String> {
    let root = Path::new(cwd);
    if !root.is_dir() {
        return Err(format!("La carpeta «{cwd}» no existe."));
    }
    Ok(git_files(root).unwrap_or_else(|| walk_files(root)))
}

#[tauri::command]
pub async fn list_project_files(cwd: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || list(&cwd))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn project(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("trex-files-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("src/components")).unwrap();
        fs::create_dir_all(dir.join("node_modules/pkg")).unwrap();
        fs::write(dir.join("README.md"), "hola").unwrap();
        fs::write(dir.join("src/main.ts"), "").unwrap();
        fs::write(dir.join("src/components/Chat.tsx"), "").unwrap();
        fs::write(dir.join("node_modules/pkg/index.js"), "").unwrap();
        dir
    }

    #[test]
    fn walks_folders_without_git_and_skips_dependencies() {
        let dir = project("walk");
        let files = list(dir.to_str().unwrap()).unwrap();
        assert_eq!(files, vec!["README.md", "src/components/Chat.tsx", "src/main.ts"]);
        assert!(list("/ruta/que/no/existe").is_err());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn uses_git_to_respect_ignored_files() {
        let dir = project("git");
        fs::write(dir.join(".gitignore"), "node_modules\n*.log\n").unwrap();
        fs::write(dir.join("debug.log"), "").unwrap();
        let init = Command::new("git").args(["init", "-q"]).current_dir(&dir).status();
        if init.map(|status| status.success()).unwrap_or(false) {
            let files = list(dir.to_str().unwrap()).unwrap();
            assert_eq!(files, vec![".gitignore", "README.md", "src/components/Chat.tsx", "src/main.ts"]);
        }
        fs::remove_dir_all(&dir).unwrap();
    }
}
