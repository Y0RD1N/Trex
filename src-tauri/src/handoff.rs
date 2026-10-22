//! Paquetes de continuidad entre proveedores, independientes de sus credenciales
//! y de los archivos originales de conversación.
use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

const MAX_SOURCE_CONTENT_BYTES: usize = 64 * 1024;
const MAX_CONTENT_BYTES: usize = 96 * 1024;
const MAX_METADATA_BYTES: usize = 512;
const MAX_CWD_BYTES: usize = 32 * 1024;
// JSON puede expandir cada carácter de control a seis bytes.
const MAX_FILE_BYTES: usize = (MAX_CONTENT_BYTES + MAX_CWD_BYTES) * 6 + 16 * 1024;
const GIT_BUDGET: Duration = Duration::from_secs(8);
const GIT_COMMAND_TIMEOUT: Duration = Duration::from_secs(2);
const TRUNCATED: &str = "\n[Contexto Git truncado por tamaño.]\n";
// Estas convenciones no detectan secretos insertados en archivos de código con
// nombres arbitrarios. Se excluyen antes de producir los diffs, no después.
const EXCLUDED_DIFF_PATHS: &[&str] = &[
    ":(top,exclude,glob,icase)**/.env",
    ":(top,exclude,glob,icase)**/.env.*",
    ":(top,exclude,glob,icase)**/.npmrc",
    ":(top,exclude,glob,icase)**/.pypirc",
    ":(top,exclude,glob,icase)**/*.pem",
    ":(top,exclude,glob,icase)**/*.key",
    ":(top,exclude,glob,icase)**/credentials.json",
    ":(top,exclude,glob,icase)**/.git-credentials",
    ":(top,exclude,glob,icase)**/id_rsa",
    ":(top,exclude,glob,icase)**/id_ed25519",
];
static NEXT_ID: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PreparedHandoff {
    pub id: String,
    pub created_at: u64,
    pub source_label: String,
    pub source_provider: String,
    pub source_session_id: String,
    pub cwd: String,
    pub content: String,
    pub truncated: bool,
}

fn validate_metadata(value: &str, label: &str) -> Result<(), String> {
    if value.trim().is_empty()
        || value.len() > MAX_METADATA_BYTES
        || value.chars().any(char::is_control)
    {
        return Err(format!("{label} no es válido o es demasiado largo."));
    }
    Ok(())
}

fn validate_source(
    cwd: &str,
    session_id: &str,
    provider: &str,
    label: &str,
    content: &str,
) -> Result<(), String> {
    validate_metadata(session_id, "El identificador de la conversación")?;
    validate_metadata(label, "El nombre del perfil")?;
    if !matches!(provider, "claude" | "codex") {
        return Err("El proveedor de origen no es válido.".into());
    }
    if cwd.is_empty() || cwd.len() > MAX_CWD_BYTES || cwd.contains('\0') || !Path::new(cwd).is_dir()
    {
        return Err("La carpeta del proyecto ya no está disponible.".into());
    }
    if content.trim().is_empty() || content.len() > MAX_SOURCE_CONTENT_BYTES {
        return Err("El contexto de la conversación está vacío o supera los 64 KiB.".into());
    }
    Ok(())
}

// El formato cerrado impide rutas relativas, separadores y nombres arbitrarios.
fn valid_id(id: &str) -> bool {
    id.len() == 58
        && id.bytes().enumerate().all(|(index, byte)| {
            if matches!(index, 32 | 41) {
                byte == b'-'
            } else {
                byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)
            }
        })
}

fn utf8_prefix(text: &str, limit: usize) -> &str {
    let mut end = limit.min(text.len());
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

fn bounded_text(text: &str, limit: usize) -> (String, bool) {
    if text.len() <= limit {
        return (text.into(), false);
    }
    let marker = utf8_prefix(TRUNCATED, limit);
    (
        format!(
            "{}{}",
            utf8_prefix(text, limit.saturating_sub(marker.len())),
            marker
        ),
        true,
    )
}

struct CapturedOutput {
    text: String,
    truncated: bool,
}

// Se drena toda la tubería aunque solo se conserve el prefijo. Así un diff
// grande no consume memoria ilimitada ni bloquea a Git por llenar stdout.
fn read_bounded(mut input: impl Read, limit: usize) -> std::io::Result<(Vec<u8>, bool)> {
    let mut bytes = Vec::with_capacity(limit.min(8192));
    let mut truncated = false;
    let mut buffer = [0u8; 8192];
    loop {
        let count = input.read(&mut buffer)?;
        if count == 0 {
            return Ok((bytes, truncated));
        }
        let keep = count.min(limit.saturating_sub(bytes.len()));
        bytes.extend_from_slice(&buffer[..keep]);
        truncated |= count > keep;
    }
}

fn run_command(
    mut command: Command,
    limit: usize,
    timeout: Duration,
) -> Result<CapturedOutput, String> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    let deadline = Instant::now() + timeout;
    let mut child = command
        .spawn()
        .map_err(|_| "Git no está disponible.".to_string())?;
    let stdout = child.stdout.take().ok_or("No se pudo leer Git.")?;
    let stderr = child
        .stderr
        .take()
        .ok_or("No se pudieron leer los errores de Git.")?;
    let (output_sender, output_receiver) = mpsc::channel();
    let (error_sender, error_receiver) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = output_sender.send(read_bounded(stdout, limit));
    });
    std::thread::spawn(move || {
        let _ = error_sender.send(read_bounded(stderr, 2048));
    });
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(10)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("Git tardó demasiado; se omitió esta parte del contexto.".into());
            }
        }
    };
    // No se hace join sin límite: incluso una tubería heredada por otro proceso
    // debe respetar el tiempo máximo de captura.
    let (stdout, clipped) = output_receiver
        .recv_timeout(deadline.saturating_duration_since(Instant::now()))
        .map_err(|_| "La salida de Git tardó demasiado.".to_string())?
        .map_err(|_| "No se pudo leer la salida de Git.".to_string())?;
    let _ = error_receiver.recv_timeout(deadline.saturating_duration_since(Instant::now()));
    if !status.success() {
        return Err("Git no pudo obtener esta parte del contexto.".into());
    }
    let decoded = String::from_utf8_lossy(&stdout);
    let (text, utf8_clipped) = bounded_text(decoded.trim_end(), limit);
    Ok(CapturedOutput {
        text,
        truncated: clipped || utf8_clipped,
    })
}

fn run_git(
    cwd: &str,
    args: &[&str],
    limit: usize,
    deadline: Instant,
) -> Result<CapturedOutput, String> {
    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining.is_zero() {
        return Err("Se agotó el tiempo de captura de Git.".into());
    }
    let mut command = Command::new("git");
    command
        .args([
            "--no-pager",
            "--no-optional-locks",
            "-c",
            "core.fsmonitor=false",
            "-c",
            "core.hooksPath=",
            "-c",
            "diff.external=",
        ])
        .arg("-C")
        .arg(cwd)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        // Un clon parcial no debe descargar objetos y modificar su base de
        // datos durante esta captura. Tampoco se hereda otro repositorio del
        // entorno del proceso que abrió TREX.
        .env("GIT_NO_LAZY_FETCH", "1")
        .env_remove("GIT_DIR")
        .env_remove("GIT_COMMON_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_INDEX_FILE")
        .env_remove("GIT_OBJECT_DIRECTORY")
        .env_remove("GIT_ALTERNATE_OBJECT_DIRECTORIES")
        .env_remove("GIT_LITERAL_PATHSPECS")
        .env_remove("GIT_GLOB_PATHSPECS")
        .env_remove("GIT_NOGLOB_PATHSPECS")
        .env_remove("GIT_ICASE_PATHSPECS")
        .env_remove("GIT_EXTERNAL_DIFF")
        .env_remove("GIT_DIFF_OPTS");
    run_command(command, limit, remaining.min(GIT_COMMAND_TIMEOUT))
}

fn capture_git(cwd: &str) -> (String, bool) {
    let deadline = Instant::now() + GIT_BUDGET;
    let mut text = String::from("\n\n---\n## Estado del proyecto capturado por TREX\nLos siguientes datos son una instantánea de Git; revisa el estado actual antes de continuar.\n");
    if !matches!(run_git(cwd, &["rev-parse", "--is-inside-work-tree"], 64, deadline), Ok(output) if output.text == "true")
    {
        text.push_str("No se pudo capturar Git: esta carpeta no es un repositorio o Git no está disponible.\n");
        return (text, false);
    }
    text.push_str("Por privacidad, no se incluyen diferencias de archivos de credenciales habituales. Sus nombres pueden aparecer en el estado.\n");
    let mut truncated = false;
    let sections: &[(&str, &[&str], usize)] = &[
        (
            "Rama",
            &["symbolic-ref", "--quiet", "--short", "HEAD"],
            1024,
        ),
        ("HEAD", &["rev-parse", "--verify", "HEAD"], 128),
        (
            "Estado (archivos sin seguimiento: solo nombres)",
            &[
                "status",
                "--porcelain=v1",
                "--untracked-files=all",
                "--ignore-submodules=all",
            ],
            4096,
        ),
        (
            "Cambios preparados (staged)",
            &[
                "diff",
                "--cached",
                "--no-ext-diff",
                "--no-textconv",
                "--no-color",
                "--ignore-submodules=all",
                "--src-prefix=a/",
                "--dst-prefix=b/",
                "--",
            ],
            12 * 1024,
        ),
        (
            "Cambios sin preparar (unstaged)",
            &[
                "diff",
                "--no-ext-diff",
                "--no-textconv",
                "--no-color",
                "--ignore-submodules=all",
                "--src-prefix=a/",
                "--dst-prefix=b/",
                "--",
            ],
            12 * 1024,
        ),
    ];
    for (title, args, limit) in sections {
        text.push_str(&format!("\n### {title}\n"));
        let mut args = args.to_vec();
        if args.first() == Some(&"diff") {
            args.extend_from_slice(EXCLUDED_DIFF_PATHS);
        }
        match run_git(cwd, &args, *limit, deadline) {
            Ok(output) => {
                text.push_str(if output.text.is_empty() {
                    "(sin cambios)"
                } else {
                    &output.text
                });
                if output.truncated {
                    text.push_str(TRUNCATED);
                }
                truncated |= output.truncated;
            }
            Err(error) => text.push_str(&format!("(No disponible: {error})")),
        }
        text.push('\n');
    }
    (text, truncated)
}

fn compose_content(source: &str, git: &str, git_truncated: bool) -> (String, bool) {
    // El contexto de conversación va completo primero. Solo se recorta Git,
    // de modo que nunca desaparezcan instrucciones enviadas por el usuario.
    let (git, clipped) = bounded_text(git, MAX_CONTENT_BYTES.saturating_sub(source.len()));
    (format!("{source}{git}"), git_truncated || clipped)
}

fn save_in(
    data_dir: &Path,
    cwd: String,
    source_session_id: String,
    source_provider: String,
    source_label: String,
    content: String,
) -> Result<PreparedHandoff, String> {
    validate_source(
        &cwd,
        &source_session_id,
        &source_provider,
        &source_label,
        &content,
    )?;
    let (git, git_truncated) = capture_git(&cwd);
    let (content, truncated) = compose_content(&content, &git, git_truncated);
    let handoff_dir = data_dir.join("handoffs");
    fs::create_dir_all(&handoff_dir)
        .map_err(|error| format!("No se pudo crear la carpeta de continuaciones: {error}"))?;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?;
    let mut prepared = PreparedHandoff {
        id: String::new(),
        created_at: now.as_millis().try_into().unwrap_or(u64::MAX),
        source_label,
        source_provider,
        source_session_id,
        cwd,
        content,
        truncated,
    };
    for _ in 0..16 {
        prepared.id = format!(
            "{:032x}-{:08x}-{:016x}",
            now.as_nanos(),
            std::process::id(),
            NEXT_ID.fetch_add(1, Ordering::Relaxed)
        );
        let path = handoff_dir.join(format!("{}.json", prepared.id));
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = match options.open(&path) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("No se pudo guardar la continuación: {error}")),
        };
        let result = serde_json::to_vec(&prepared)
            .map_err(|error| error.to_string())
            .and_then(|bytes| {
                file.write_all(&bytes)
                    .and_then(|_| file.sync_all())
                    .map_err(|error| error.to_string())
            });
        drop(file);
        if let Err(error) = result {
            let _ = fs::remove_file(&path);
            return Err(format!("No se pudo guardar la continuación: {error}"));
        }
        return Ok(prepared);
    }
    Err("No se pudo crear un identificador único para la continuación.".into())
}

fn load_from(data_dir: &Path, id: &str) -> Result<PreparedHandoff, String> {
    if !valid_id(id) {
        return Err("El identificador de la continuación no es válido.".into());
    }
    let file = fs::File::open(data_dir.join("handoffs").join(format!("{id}.json")))
        .map_err(|_| "No se encontró el contexto guardado de esta continuación.".to_string())?;
    let mut bytes = Vec::new();
    file.take((MAX_FILE_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("No se pudo leer la continuación: {error}"))?;
    if bytes.len() > MAX_FILE_BYTES {
        return Err("El contexto guardado es demasiado grande.".into());
    }
    let prepared: PreparedHandoff = serde_json::from_slice(&bytes)
        .map_err(|_| "El contexto guardado de la continuación está dañado.".to_string())?;
    validate_metadata(
        &prepared.source_session_id,
        "El identificador de la conversación",
    )?;
    validate_metadata(&prepared.source_label, "El nombre del perfil")?;
    if prepared.id != id
        || !matches!(prepared.source_provider.as_str(), "claude" | "codex")
        || prepared.cwd.is_empty()
        || prepared.cwd.len() > MAX_CWD_BYTES
        || prepared.cwd.contains('\0')
        || prepared.content.trim().is_empty()
        || prepared.content.len() > MAX_CONTENT_BYTES
    {
        return Err("El contexto guardado de la continuación no es válido.".into());
    }
    Ok(prepared)
}

#[tauri::command]
pub async fn prepare_handoff(
    app: AppHandle,
    cwd: String,
    source_session_id: String,
    source_provider: String,
    source_label: String,
    content: String,
) -> Result<PreparedHandoff, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let data_dir = app
            .path()
            .app_data_dir()
            .map_err(|error| error.to_string())?;
        save_in(
            &data_dir,
            cwd,
            source_session_id,
            source_provider,
            source_label,
            content,
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn load_handoff(app: AppHandle, id: String) -> Result<PreparedHandoff, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let data_dir = app
            .path()
            .app_data_dir()
            .map_err(|error| error.to_string())?;
        load_from(&data_dir, &id)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TestDir(std::path::PathBuf);
    impl TestDir {
        fn new() -> Self {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "trex-handoff-{}-{nonce}-{}",
                std::process::id(),
                NEXT_ID.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
        fn cwd(&self) -> &str {
            self.0.to_str().unwrap()
        }
        fn git(&self, args: &[&str]) -> String {
            let mut command = Command::new("git");
            command.arg("-C").arg(&self.0).args(args);
            run_command(command, 64 * 1024, Duration::from_secs(5))
                .unwrap()
                .text
        }
    }
    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn ids_reject_paths_and_arbitrary_names() {
        assert!(valid_id(
            "00000000000000000000000000000001-00000002-0000000000000003"
        ));
        for id in [
            "",
            "../outside",
            "..\\outside",
            "C:\\secret",
            "/tmp/secret",
            "simple-name",
            "00000000000000000000000000000001-00000002-000000000000000g",
        ] {
            assert!(!valid_id(id), "accepted {id}");
            assert!(load_from(Path::new("not-used"), id).is_err());
        }
    }

    #[test]
    fn validation_rejects_invalid_provider_metadata_and_oversized_conversations() {
        let dir = TestDir::new();
        let check = |session: &str, provider: &str, label: &str, content: &str| {
            validate_source(dir.cwd(), session, provider, label, content)
        };
        assert!(check("session", "claude", "Claude 1", "instrucción").is_ok());
        assert!(check(
            "session",
            "codex",
            "Codex",
            &"x".repeat(MAX_SOURCE_CONTENT_BYTES)
        )
        .is_ok());
        assert!(check("session", "other", "Profile", "context").is_err());
        assert!(check("", "claude", "Profile", "context").is_err());
        assert!(check("session", "claude", "bad\nlabel", "context").is_err());
        assert!(check(
            "session",
            "claude",
            &"x".repeat(MAX_METADATA_BYTES + 1),
            "context"
        )
        .is_err());
        assert!(check(
            "session",
            "claude",
            "Profile",
            &"x".repeat(MAX_SOURCE_CONTENT_BYTES + 1)
        )
        .is_err());
        assert!(
            validate_source("missing-folder", "session", "claude", "Profile", "context").is_err()
        );
    }

    #[test]
    fn bounding_preserves_front_context_and_valid_utf8() {
        let source = "é".repeat(MAX_SOURCE_CONTENT_BYTES / 2);
        let git = "🦖".repeat(MAX_CONTENT_BYTES);
        let (content, truncated) = compose_content(&source, &git, false);
        assert!(truncated);
        assert!(content.starts_with(&source));
        assert!(content.ends_with(TRUNCATED));
        assert!(content.len() <= MAX_CONTENT_BYTES);
        let (bytes, clipped) =
            read_bounded(std::io::Cursor::new(vec![b'x'; 200_000]), 512).unwrap();
        assert_eq!(bytes.len(), 512);
        assert!(clipped);
    }

    #[test]
    fn git_snapshot_includes_both_diffs_and_only_names_of_untracked_files() {
        let dir = TestDir::new();
        dir.git(&["init", "-q", "-b", "main"]);
        fs::write(dir.0.join("tracked.txt"), "original\n").unwrap();
        dir.git(&["add", "tracked.txt"]);
        dir.git(&[
            "-c",
            "user.name=TREX test",
            "-c",
            "user.email=trex@example.test",
            "-c",
            "commit.gpgsign=false",
            "-c",
            "core.hooksPath=",
            "commit",
            "-q",
            "-m",
            "fixture",
        ]);
        fs::write(dir.0.join("tracked.txt"), "staged-marker\n").unwrap();
        dir.git(&["add", "tracked.txt"]);
        fs::write(dir.0.join("tracked.txt"), "unstaged-marker\n").unwrap();
        fs::write(
            dir.0.join("untracked-private.txt"),
            "NEVER_READ_UNTRACKED_CONTENT",
        )
        .unwrap();
        let status_before = dir.git(&["status", "--porcelain=v1", "--untracked-files=all"]);
        let (snapshot, truncated) = capture_git(dir.cwd());
        assert!(!truncated);
        assert!(snapshot.contains("main"));
        assert!(snapshot.contains("+staged-marker"));
        assert!(snapshot.contains("+unstaged-marker"));
        assert!(snapshot.contains("?? untracked-private.txt"));
        assert!(!snapshot.contains("NEVER_READ_UNTRACKED_CONTENT"));
        assert_eq!(
            dir.git(&["status", "--porcelain=v1", "--untracked-files=all"]),
            status_before
        );
        assert_eq!(
            fs::read_to_string(dir.0.join("tracked.txt")).unwrap(),
            "unstaged-marker\n"
        );
    }

    #[test]
    fn git_snapshot_excludes_tracked_credential_diffs_but_keeps_normal_changes() {
        let dir = TestDir::new();
        dir.git(&["init", "-q", "-b", "main"]);
        fs::create_dir_all(dir.0.join("nested")).unwrap();
        let sensitive_files = [
            ".env",
            ".env.local",
            "nested/.ENV.production",
            "nested/.npmrc",
            ".pypirc",
            "private.pem",
            "nested/private.KEY",
            "credentials.json",
            ".git-credentials",
            "id_rsa",
            "nested/id_ed25519",
        ];
        for path in sensitive_files {
            fs::write(dir.0.join(path), "PRIVATE_SECRET_OLD\n").unwrap();
        }
        fs::write(dir.0.join("normal.txt"), "normal original\n").unwrap();
        dir.git(&["add", "-f", "--", "."]);
        dir.git(&[
            "-c",
            "user.name=TREX test",
            "-c",
            "user.email=trex@example.test",
            "-c",
            "commit.gpgsign=false",
            "-c",
            "core.hooksPath=",
            "commit",
            "-q",
            "-m",
            "fixture",
        ]);
        for path in sensitive_files {
            fs::write(dir.0.join(path), "PRIVATE_SECRET_STAGED\n").unwrap();
        }
        fs::write(dir.0.join("normal.txt"), "ordinary-staged-change\n").unwrap();
        dir.git(&["add", "-f", "--", "."]);
        for path in sensitive_files {
            fs::write(dir.0.join(path), "PRIVATE_SECRET_UNSTAGED\n").unwrap();
        }
        fs::write(dir.0.join("normal.txt"), "ordinary-unstaged-change\n").unwrap();
        let (snapshot, truncated) = capture_git(dir.cwd());
        assert!(!truncated);
        assert!(!snapshot.contains("PRIVATE_SECRET"));
        assert!(snapshot.contains("+ordinary-staged-change"));
        assert!(snapshot.contains("+ordinary-unstaged-change"));
        assert!(snapshot.contains("no se incluyen diferencias de archivos de credenciales"));
        for path in sensitive_files {
            assert!(snapshot.contains(path), "missing filename {path}");
            assert!(
                !snapshot.contains(&format!("diff --git a/{path}")),
                "leaked diff for {path}"
            );
        }
    }

    #[test]
    fn non_git_folders_still_persist_distinct_immutable_packages() {
        let project = TestDir::new();
        let data = TestDir::new();
        let save = || {
            save_in(
                &data.0,
                project.cwd().into(),
                "session".into(),
                "codex".into(),
                "Codex".into(),
                "Continúa el trabajo pendiente. 🦖".into(),
            )
            .unwrap()
        };
        let first = save();
        let original_file =
            fs::read(data.0.join("handoffs").join(format!("{}.json", first.id))).unwrap();
        let second = save();
        assert_ne!(first.id, second.id);
        assert!(valid_id(&first.id));
        assert!(first.created_at > 0);
        assert!(first.content.contains("no es un repositorio"));
        assert!(!first.truncated);
        assert_eq!(load_from(&data.0, &first.id).unwrap(), first);
        assert_eq!(load_from(&data.0, &second.id).unwrap(), second);
        assert_eq!(
            fs::read(data.0.join("handoffs").join(format!("{}.json", first.id))).unwrap(),
            original_file
        );
        assert_eq!(fs::read_dir(&project.0).unwrap().count(), 0);
    }

    #[test]
    fn utf8_context_survives_reload_and_returned_values_are_independent() {
        let project = TestDir::new();
        let data = TestDir::new();
        let source = format!(
            "{}\nConserva esta última instrucción del usuario.",
            "🦖á汉".repeat(7_000)
        );
        assert!(source.len() <= MAX_SOURCE_CONTENT_BYTES);
        let prepared = save_in(
            &data.0,
            project.cwd().into(),
            "session".into(),
            "claude".into(),
            "Claude 2".into(),
            source.clone(),
        )
        .unwrap();
        let mut loaded = load_from(&data.0, &prepared.id).unwrap();
        assert_eq!(loaded, prepared);
        assert!(loaded.content.starts_with(&source));
        loaded.content.clear();
        loaded.source_label.push_str(" editado");
        assert_eq!(load_from(&data.0, &prepared.id).unwrap(), prepared);
    }

    #[test]
    fn process_capture_obeys_a_real_deadline() {
        #[cfg(windows)]
        let command = {
            let mut command = Command::new("powershell.exe");
            command.args([
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Start-Sleep -Seconds 10",
            ]);
            command
        };
        #[cfg(not(windows))]
        let command = {
            let mut command = Command::new("sleep");
            command.arg("10");
            command
        };
        let started = Instant::now();
        assert!(run_command(command, 64, Duration::from_millis(150)).is_err());
        assert!(started.elapsed() < Duration::from_secs(3));
    }
}
