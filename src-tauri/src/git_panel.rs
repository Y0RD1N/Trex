//! Project Git controls. Commands use literal arguments and selected paths;
//! tests use temporary repositories and local remotes only.
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs,
    io::Read,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{mpsc, Arc, Mutex, OnceLock},
    time::{Duration, Instant},
};

const LIMIT: usize = 8 * 1024 * 1024;
fn capture(mut input: impl Read, limit: usize) -> std::io::Result<(Vec<u8>, bool)> {
    let mut result = Vec::new();
    let mut clipped = false;
    let mut buffer = [0; 8192];
    loop {
        let n = input.read(&mut buffer)?;
        if n == 0 {
            return Ok((result, clipped));
        }
        let keep = n.min(limit.saturating_sub(result.len()));
        result.extend_from_slice(&buffer[..keep]);
        clipped |= keep < n;
    }
}
fn run(cwd: &str, args: &[&str], limit: usize, seconds: u64) -> Result<(Vec<u8>, bool), String> {
    let mut cmd = Command::new("git");
    cmd.args([
        "--literal-pathspecs",
        "-C",
        cwd,
        "-c",
        "core.quotePath=false",
        "-c",
        "submodule.recurse=false",
    ])
    .args(args)
    .env("GIT_TERMINAL_PROMPT", "0")
    .env("GCM_INTERACTIVE", "Never")
    .env("GIT_OPTIONAL_LOCKS", "0")
    .stdin(Stdio::null())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("No se pudo ejecutar Git: {e}"))?;
    let out = child.stdout.take().ok_or("No se pudo leer Git.")?;
    let err = child.stderr.take().ok_or("No se pudo leer Git.")?;
    let (tx, rx) = mpsc::channel();
    let (etx, erx) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(capture(out, limit));
    });
    std::thread::spawn(move || {
        let _ = etx.send(capture(err, 8192));
    });
    let deadline = Instant::now() + Duration::from_secs(seconds);
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(15)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(
                    "Git tardó demasiado. Actualiza el estado antes de volver a intentarlo.".into(),
                );
            }
        }
    };
    let (bytes, clipped) = rx
        .recv_timeout(deadline.saturating_duration_since(Instant::now()))
        .map_err(|_| "La salida de Git tardó demasiado.")?
        .map_err(|e| e.to_string())?;
    let error = erx
        .recv_timeout(deadline.saturating_duration_since(Instant::now()))
        .map_err(|_| "La salida de Git tardó demasiado.")?
        .map_err(|e| e.to_string())?
        .0;
    if !status.success() {
        let message = String::from_utf8_lossy(&error).trim().to_owned();
        return Err(if message.is_empty() {
            "Git no pudo completar la operación.".into()
        } else {
            message
        });
    }
    Ok((bytes, clipped))
}
fn text(cwd: &str, args: &[&str]) -> Result<String, String> {
    let (bytes, clipped) = run(cwd, args, LIMIT, 10)?;
    if clipped {
        return Err("La respuesta de Git es demasiado grande.".into());
    }
    String::from_utf8(bytes)
        .map(|s| s.trim().to_owned())
        .map_err(|_| "Git devolvió una ruta que no se puede mostrar en UTF-8.".into())
}
fn root(cwd: &str) -> Result<String, String> {
    text(cwd, &["rev-parse", "--show-toplevel"])
        .map_err(|_| "Esta carpeta no es un repositorio de Git o Git no está disponible.".into())
}
pub(crate) fn with_repo_lock<T>(
    cwd: &str,
    f: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    type Locks = Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>;
    static LOCKS: OnceLock<Locks> = OnceLock::new();
    let common = text(cwd, &["rev-parse", "--git-common-dir"])?;
    let key = fs::canonicalize(Path::new(cwd).join(common)).map_err(|e| e.to_string())?;
    let lock = LOCKS
        .get_or_init(Default::default)
        .lock()
        .map_err(|_| "Git está ocupado.")?
        .entry(key)
        .or_default()
        .clone();
    let _guard = lock.lock().map_err(|_| "Git está ocupado.")?;
    f()
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFile {
    path: String,
    original_path: Option<String>,
    status: String,
    staged: bool,
    untracked: bool,
    conflicted: bool,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    root: String,
    branch: Option<String>,
    head: Option<String>,
    detached: bool,
    upstream: Option<String>,
    remote: Option<String>,
    remotes: Vec<String>,
    ahead: u64,
    behind: u64,
    files: Vec<GitFile>,
    total_files: usize,
    token: String,
    operation: Option<String>,
    remote_error: Option<String>,
    warning: Option<String>,
}
fn fields(bytes: &[u8]) -> Result<Vec<&str>, String> {
    std::str::from_utf8(bytes)
        .map(|s| s.split('\0').filter(|s| !s.is_empty()).collect())
        .map_err(|_| "Git contiene rutas que no se pueden mostrar en UTF-8.".into())
}
fn parse_status(bytes: &[u8]) -> Result<Vec<GitFile>, String> {
    let parts = fields(bytes)?;
    let mut result = Vec::new();
    let mut i = 0;
    while i < parts.len() {
        let row = parts[i];
        i += 1;
        if row.len() < 4 || !row.is_char_boundary(3) {
            return Err("Estado de Git inválido.".into());
        }
        let code = &row[..2];
        let renamed = code.contains('R') || code.contains('C');
        let original_path = if renamed {
            let old = parts.get(i).ok_or("Renombrado de Git incompleto.")?;
            i += 1;
            Some((*old).to_owned())
        } else {
            None
        };
        result.push(GitFile {
            path: row[3..].into(),
            original_path,
            status: code.into(),
            staged: !matches!(&code[..1], " " | "?"),
            untracked: code == "??",
            conflicted: code.contains('U') || matches!(code, "AA" | "DD"),
        });
    }
    Ok(result)
}
fn digest_path(hash: &mut Sha256, path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_symlink() => {
            hash.update(
                fs::read_link(path)
                    .map_err(|e| e.to_string())?
                    .to_string_lossy()
                    .as_bytes(),
            );
        }
        Ok(meta) if meta.is_file() => {
            let mut file = fs::File::open(path).map_err(|e| e.to_string())?;
            let mut buf = [0; 65536];
            loop {
                let n = file.read(&mut buf).map_err(|e| e.to_string())?;
                if n == 0 {
                    break;
                }
                hash.update(&buf[..n]);
            }
        }
        Ok(_) => {
            hash.update(b"directory");
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            hash.update(b"deleted");
        }
        Err(e) => return Err(e.to_string()),
    }
    Ok(())
}
fn status(cwd: &str, fetch: bool, selected_remote: Option<&str>) -> Result<GitStatus, String> {
    let cwd = root(cwd)?;
    let branch = text(&cwd, &["symbolic-ref", "--quiet", "--short", "HEAD"]).ok();
    let head = text(&cwd, &["rev-parse", "--verify", "HEAD"]).ok();
    let remotes: Vec<_> = text(&cwd, &["remote"])?
        .lines()
        .map(str::to_owned)
        .collect();
    let configured = branch
        .as_ref()
        .and_then(|b| text(&cwd, &["config", "--get", &format!("branch.{b}.remote")]).ok());
    let remote = selected_remote
        .map(str::to_owned)
        .or(configured.clone().filter(|r| remotes.contains(r)))
        .or_else(|| remotes.iter().find(|r| *r == "origin").cloned())
        .or_else(|| remotes.first().cloned());
    if remote
        .as_ref()
        .is_some_and(|r| !remotes.contains(r) || r.starts_with('-'))
    {
        return Err("El remoto seleccionado ya no existe.".into());
    }
    let remote_error = if fetch {
        remote.as_ref().and_then(|r| {
            run(
                &cwd,
                &["fetch", "--no-tags", "--no-recurse-submodules", "--", r],
                16384,
                45,
            )
            .err()
        })
    } else {
        None
    };
    let upstream = if configured.as_ref() == remote.as_ref() {
        text(&cwd, &["rev-parse", "--symbolic-full-name", "@{upstream}"]).ok()
    } else {
        None
    }
    .or_else(|| {
        let reference = format!("refs/remotes/{}/{}", remote.as_ref()?, branch.as_ref()?);
        text(&cwd, &["show-ref", "--verify", &reference])
            .ok()
            .map(|_| reference)
    });
    let (ahead, behind) = if let Some(upstream) = upstream.as_deref() {
        let counts = text(
            &cwd,
            &[
                "rev-list",
                "--left-right",
                "--count",
                &format!("HEAD...{upstream}"),
            ],
        )
        .unwrap_or_default();
        let mut fields = counts
            .split_whitespace()
            .filter_map(|n| n.parse::<u64>().ok());
        (fields.next().unwrap_or(0), fields.next().unwrap_or(0))
    } else {
        (
            head.as_ref()
                .and_then(|_| text(&cwd, &["rev-list", "--count", "HEAD"]).ok())
                .and_then(|n| n.parse().ok())
                .unwrap_or(0),
            0,
        )
    };
    let (raw, clipped) = run(
        &cwd,
        &["status", "--porcelain=v1", "-z", "--untracked-files=all"],
        LIMIT,
        15,
    )?;
    if clipped {
        return Err("Hay demasiados archivos para mostrar el estado de Git.".into());
    }
    let all = parse_status(&raw)?;
    let total_files = all.len();
    let files: Vec<_> = all.into_iter().take(2000).collect();
    let mut hash = Sha256::new();
    hash.update(cwd.as_bytes());
    hash.update(remote.as_deref().unwrap_or_default().as_bytes());
    if let Some(remote) = remote.as_deref() {
        hash.update(text(&cwd, &["remote", "get-url", "--push", remote])?.as_bytes());
    }
    hash.update([0]);
    hash.update(head.as_deref().unwrap_or("unborn"));
    hash.update(branch.as_deref().unwrap_or("detached"));
    hash.update(&raw);
    let index = text(&cwd, &["rev-parse", "--git-path", "index"])?;
    digest_path(&mut hash, &Path::new(&cwd).join(index))?;
    for file in &files {
        hash.update(file.path.as_bytes());
        digest_path(&mut hash, &Path::new(&cwd).join(&file.path))?;
    }
    let operation = [
        "MERGE_HEAD",
        "CHERRY_PICK_HEAD",
        "REVERT_HEAD",
        "rebase-merge",
        "rebase-apply",
    ]
    .iter()
    .find_map(|name| {
        let path = text(&cwd, &["rev-parse", "--git-path", name]).ok()?;
        Path::new(&cwd)
            .join(path)
            .exists()
            .then(|| (*name).to_owned())
    });
    Ok(GitStatus {
        root: cwd,
        detached: branch.is_none(),
        branch,
        head,
        upstream,
        remote,
        remotes,
        ahead,
        behind,
        files,
        total_files,
        token: format!("{:x}", hash.finalize()),
        operation,
        remote_error,
        warning: None,
    })
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitDiff {
    files: Vec<GitFile>,
    patch: String,
    truncated: bool,
}
fn comparison(cwd: &str, base: &str, state: &GitStatus) -> Result<String, String> {
    if state.head.is_none() {
        return Err("Crea el primer commit para comparar ramas.".into());
    }
    if base == "incoming" {
        return state
            .upstream
            .as_ref()
            .map(|r| format!("HEAD...{r}"))
            .ok_or_else(|| "Esta rama no tiene una rama remota para comparar.".into());
    }
    let refs = crate::git::branches(cwd)?;
    if !refs.branches.iter().any(|b| b.reference == base) {
        return Err("La rama de comparación ya no existe.".into());
    }
    Ok(format!("{base}...HEAD"))
}
fn diff(
    cwd: &str,
    path: Option<&str>,
    base: Option<&str>,
    remote: Option<&str>,
) -> Result<GitDiff, String> {
    let state = status(cwd, false, remote)?;
    let cwd = &state.root;
    let range = base.map(|base| comparison(cwd, base, &state)).transpose()?;
    let files = if let Some(range) = range.as_deref() {
        let (bytes, clipped) = run(
            cwd,
            &[
                "diff",
                "--no-ext-diff",
                "--no-textconv",
                "--no-renames",
                "--name-status",
                "-z",
                range,
                "--",
            ],
            LIMIT,
            15,
        )?;
        if clipped {
            return Err("La comparación contiene demasiados archivos.".into());
        }
        let fields = fields(&bytes)?;
        fields
            .chunks_exact(2)
            .take(2000)
            .map(|r| GitFile {
                path: r[1].into(),
                original_path: None,
                status: r[0].into(),
                staged: false,
                untracked: false,
                conflicted: false,
            })
            .collect()
    } else {
        state.files.clone()
    };
    let Some(path) = path else {
        return Ok(GitDiff {
            files,
            patch: String::new(),
            truncated: false,
        });
    };
    let chosen = files
        .iter()
        .find(|f| f.path == path)
        .ok_or("El archivo ya no forma parte de estos cambios. Actualiza la lista.")?;
    if chosen.untracked || (state.head.is_none() && Path::new(cwd).join(path).is_file()) {
        let file_path = Path::new(cwd).join(path);
        let meta = fs::symlink_metadata(&file_path).map_err(|e| e.to_string())?;
        if meta.file_type().is_symlink() {
            return Ok(GitDiff {
                files,
                patch: format!(
                    "Enlace simbólico: {}",
                    fs::read_link(file_path)
                        .map_err(|e| e.to_string())?
                        .display()
                ),
                truncated: false,
            });
        }
        let (bytes, truncated) = capture(
            fs::File::open(file_path)
                .map_err(|e| e.to_string())?
                .take(262145),
            262144,
        )
        .map_err(|e| e.to_string())?;
        let patch = if bytes.contains(&0) {
            "Archivo binario nuevo".into()
        } else {
            String::from_utf8_lossy(&bytes)
                .lines()
                .take(3000)
                .map(|line| format!("+{line}\n"))
                .collect()
        };
        return Ok(GitDiff {
            files,
            patch,
            truncated: truncated || bytes.split(|b| *b == b'\n').count() > 3000,
        });
    }
    let mut args = vec![
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        "--no-renames",
        "--unified=3",
    ];
    if let Some(range) = range.as_deref() {
        args.push(range);
    } else if state.head.is_some() {
        args.push("HEAD");
    } else {
        args.push("--cached");
    }
    args.extend(["--", path]);
    if let Some(old) = chosen.original_path.as_deref() {
        args.push(old);
    }
    let (bytes, truncated) = run(cwd, &args, 262144, 15)?;
    Ok(GitDiff {
        files,
        patch: String::from_utf8_lossy(&bytes).into_owned(),
        truncated,
    })
}
fn mutate(
    cwd: &str,
    token: &str,
    action: &str,
    paths: &[String],
    message: &str,
    remote: Option<&str>,
) -> Result<GitStatus, String> {
    with_repo_lock(cwd, || {
        let state = status(cwd, false, remote)?;
        let cwd = state.root.as_str();
        if state.token != token {
            return Err("El repositorio cambió desde la última revisión. Actualiza y revisa los cambios antes de continuar.".into());
        }
        if state.operation.is_some() || state.files.iter().any(|f| f.conflicted) {
            return Err("Resuelve primero la operación o los conflictos pendientes de Git.".into());
        }
        let branch = state
            .branch
            .as_deref()
            .ok_or("HEAD está separado. Elige una rama antes de continuar.")?;
        let mut warning = None;
        match action {
            "commit" => {
                if message.trim().is_empty() || message.len() > 8192 || message.contains('\0') {
                    return Err(
                        "Escribe un mensaje de commit válido (hasta 8192 caracteres).".into(),
                    );
                }
                if paths.is_empty() || paths.len() > 2000 {
                    return Err("Elige los archivos que quieres incluir en el commit.".into());
                }
                let mut selected = Vec::new();
                let mut untracked = Vec::new();
                for path in paths {
                    let file = state
                        .files
                        .iter()
                        .find(|f| &f.path == path)
                        .ok_or("La selección de archivos cambió. Actualiza la lista.")?;
                    if Path::new(cwd).join(path).is_dir() {
                        return Err("Confirma primero los cambios dentro del submódulo.".into());
                    }
                    if file.untracked {
                        untracked.push(path.as_str());
                    }
                    selected.push(path.as_str());
                    if let Some(old) = file.original_path.as_deref() {
                        selected.push(old);
                    }
                }
                if !untracked.is_empty() {
                    let mut args = vec!["add", "--intent-to-add", "--"];
                    args.extend(untracked);
                    run(cwd, &args, 8192, 30)?;
                }
                let mut args = vec!["commit", "--only", "-m", message.trim(), "--"];
                args.extend(selected);
                run(cwd, &args, 16384, 90)?;
            }
            "push" => {
                let remote = state
                    .remote
                    .as_deref()
                    .ok_or("Configura un remoto para subir esta rama.")?;
                let head = state
                    .head
                    .as_deref()
                    .ok_or("Crea el primer commit antes de subir la rama.")?;
                run(
                    cwd,
                    &[
                        "push",
                        "--porcelain",
                        "--no-force",
                        "--no-follow-tags",
                        "--recurse-submodules=no",
                        "--",
                        remote,
                        &format!("{head}:refs/heads/{branch}"),
                    ],
                    16384,
                    90,
                )?;
                // Push the reviewed object, then establish tracking for this branch.
                let tracking = (|| -> Result<(), String> {
                    text(cwd, &["config", &format!("branch.{branch}.remote"), remote])?;
                    text(
                        cwd,
                        &[
                            "config",
                            &format!("branch.{branch}.merge"),
                            &format!("refs/heads/{branch}"),
                        ],
                    )?;
                    text(
                        cwd,
                        &[
                            "update-ref",
                            &format!("refs/remotes/{remote}/{branch}"),
                            head,
                        ],
                    )?;
                    Ok(())
                })();
                if let Err(error) = tracking {
                    warning = Some(format!(
                        "El push terminó, pero no se pudo guardar el seguimiento local: {error}"
                    ));
                }
            }
            "pull" => {
                if state.total_files > 0 {
                    return Err(
                        "Guarda o confirma los cambios locales antes de traer los cambios remotos."
                            .into(),
                    );
                }
                let remote = state
                    .remote
                    .as_deref()
                    .ok_or("Configura un remoto antes de traer cambios.")?;
                run(
                    cwd,
                    &[
                        "fetch",
                        "--no-tags",
                        "--no-recurse-submodules",
                        "--",
                        remote,
                    ],
                    16384,
                    60,
                )?;
                let fresh = status(cwd, false, Some(remote))?;
                if fresh.token != state.token {
                    return Err("Los archivos o la rama cambiaron durante la consulta remota. Actualiza y vuelve a revisar.".into());
                }
                let upstream = fresh
                    .upstream
                    .as_deref()
                    .ok_or("Esta rama no tiene una rama remota para traer cambios.")?;
                let target = text(cwd, &["rev-parse", "--verify", upstream])?;
                run(
                    cwd,
                    &["merge", "--ff-only", "--no-edit", "--no-autostash", &target],
                    16384,
                    60,
                )?;
            }
            _ => return Err("Operación de Git no válida.".into()),
        }
        let mut next = status(cwd, false, remote).map_err(|error| format!("La operación terminó, pero no se pudo leer el estado final: {error}. Actualiza antes de volver a ejecutar la operación."))?;
        next.warning = warning;
        Ok(next)
    })
}
#[tauri::command]
pub async fn git_project_status(
    cwd: String,
    fetch: bool,
    remote: Option<String>,
) -> Result<GitStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        with_repo_lock(&cwd, || status(&cwd, fetch, remote.as_deref()))
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn git_project_diff(
    cwd: String,
    path: Option<String>,
    base: Option<String>,
    remote: Option<String>,
) -> Result<GitDiff, String> {
    tauri::async_runtime::spawn_blocking(move || {
        diff(&cwd, path.as_deref(), base.as_deref(), remote.as_deref())
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn git_project_action(
    cwd: String,
    token: String,
    action: String,
    paths: Vec<String>,
    message: String,
    remote: Option<String>,
) -> Result<GitStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        mutate(&cwd, &token, &action, &paths, &message, remote.as_deref())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Repo(PathBuf);
    impl Repo {
        fn new(commit: bool) -> Self {
            static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
            let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let path =
                std::env::temp_dir().join(format!("trex-git-panel-{}-{n}", std::process::id()));
            fs::create_dir_all(&path).unwrap();
            let repo = Self(path);
            repo.git(&["init", "-q", "-b", "main"]);
            repo.git(&["config", "user.name", "Trex fixture"]);
            repo.git(&["config", "user.email", "trex@example.test"]);
            repo.git(&["config", "commit.gpgsign", "false"]);
            repo.git(&[
                "config",
                "core.hooksPath",
                repo.0.join("empty-hooks").to_str().unwrap(),
            ]);
            if commit {
                repo.write("a.txt", "base a\n");
                repo.write("b.txt", "base b\n");
                repo.commit();
            }
            repo
        }
        fn cwd(&self) -> &str {
            self.0.to_str().unwrap()
        }
        fn git(&self, args: &[&str]) -> String {
            text(self.cwd(), args).unwrap()
        }
        fn write(&self, path: &str, contents: &str) {
            fs::write(self.0.join(path), contents).unwrap();
        }
        fn commit(&self) {
            self.git(&["add", "--all"]);
            self.git(&["commit", "-q", "-m", "fixture"]);
        }
        fn state(&self) -> GitStatus {
            status(self.cwd(), false, None).unwrap()
        }
    }
    impl Drop for Repo {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn commit_selected(repo: &Repo, paths: &[&str]) -> GitStatus {
        let state = repo.state();
        mutate(
            repo.cwd(),
            &state.token,
            "commit",
            &paths.iter().map(|s| (*s).into()).collect::<Vec<_>>(),
            "Selected changes",
            None,
        )
        .unwrap()
    }
    #[test]
    fn commit_includes_only_selected_files_and_preserves_other_staging() {
        let repo = Repo::new(true);
        repo.write("a.txt", "changed a\n");
        repo.write("b.txt", "staged b\n");
        repo.git(&["add", "--", "b.txt"]);
        repo.write("nuevo español con espacios.txt", "new\n");
        let state = commit_selected(&repo, &["a.txt", "nuevo español con espacios.txt"]);
        assert_eq!(state.files.len(), 1);
        assert_eq!(state.files[0].path, "b.txt");
        assert!(state.files[0].staged);
        assert_eq!(repo.git(&["diff", "--cached", "--name-only"]), "b.txt");
        let included = repo.git(&["show", "--format=", "--name-only", "HEAD"]);
        assert!(included.contains("a.txt") && included.contains("nuevo español"));
        assert!(!included.contains("b.txt"));
    }
    #[test]
    fn initial_commit_and_literal_paths_work_without_changing_unselected_files() {
        let repo = Repo::new(false);
        repo.write("-literal.txt", "one\n");
        repo.write("other.txt", "leave\n");
        let preview = diff(repo.cwd(), Some("-literal.txt"), None, None).unwrap();
        assert!(preview.patch.contains("+one"));
        let state = commit_selected(&repo, &["-literal.txt"]);
        assert!(state.head.is_some());
        assert_eq!(state.files[0].path, "other.txt");
        assert_eq!(repo.git(&["ls-files"]), "-literal.txt");
    }
    #[test]
    fn changed_content_and_unknown_paths_cannot_use_an_old_review_token() {
        let repo = Repo::new(true);
        repo.write("a.txt", "version one\n");
        let old = repo.state();
        let head = repo.git(&["rev-parse", "HEAD"]);
        repo.write("a.txt", "version two\n");
        assert!(mutate(
            repo.cwd(),
            &old.token,
            "commit",
            &["a.txt".into()],
            "reviewed",
            None
        )
        .unwrap_err()
        .contains("cambió"));
        let state = repo.state();
        assert!(mutate(
            repo.cwd(),
            &state.token,
            "commit",
            &["../outside".into()],
            "invalid",
            None
        )
        .is_err());
        assert_eq!(repo.git(&["rev-parse", "HEAD"]), head);
        assert_eq!(
            fs::read_to_string(repo.0.join("a.txt")).unwrap(),
            "version two\n"
        );
    }
    #[test]
    fn staged_renames_commit_the_new_and_original_paths() {
        let repo = Repo::new(true);
        repo.git(&["mv", "a.txt", "renamed.txt"]);
        let files = repo.state().files;
        assert_eq!(files[0].original_path.as_deref(), Some("a.txt"));
        commit_selected(&repo, &["renamed.txt"]);
        assert!(repo.state().files.is_empty());
        assert_eq!(repo.git(&["ls-files"]), "b.txt\nrenamed.txt");
    }
    #[test]
    fn comparison_uses_the_selected_branch_and_refuses_arbitrary_revisions() {
        let repo = Repo::new(true);
        repo.git(&["branch", "base"]);
        repo.write("a.txt", "different\n");
        repo.commit();
        let data = diff(repo.cwd(), Some("a.txt"), Some("refs/heads/base"), None).unwrap();
        assert_eq!(data.files.len(), 1);
        assert!(data.patch.contains("+different"));
        assert!(diff(repo.cwd(), None, Some("--output=outside"), None).is_err());
        fs::create_dir(repo.0.join("nested")).unwrap();
        assert_eq!(
            status(repo.0.join("nested").to_str().unwrap(), false, None)
                .unwrap()
                .root,
            root(repo.cwd()).unwrap()
        );
    }
    #[test]
    fn push_and_fast_forward_pull_use_a_local_remote_and_reject_divergence() {
        let source = Repo::new(true);
        let remote = Repo::new(false);
        let bare = remote.0.join("remote.git");
        remote.git(&["init", "--bare", "-q", bare.to_str().unwrap()]);
        source.git(&["remote", "add", "origin", bare.to_str().unwrap()]);
        let state = source.state();
        mutate(source.cwd(), &state.token, "push", &[], "", None).unwrap();
        assert_eq!(
            source.git(&["rev-parse", "@{upstream}"]),
            source.git(&["rev-parse", "HEAD"])
        );
        let peer = Repo::new(false);
        peer.git(&["remote", "add", "origin", bare.to_str().unwrap()]);
        peer.git(&["fetch", "origin"]);
        peer.git(&["reset", "--hard", "origin/main"]);
        peer.write("remote.txt", "remote\n");
        peer.commit();
        peer.git(&["push", "origin", "main"]);
        let state = status(source.cwd(), true, None).unwrap();
        assert_eq!((state.ahead, state.behind), (0, 1));
        let incoming = diff(source.cwd(), Some("remote.txt"), Some("incoming"), None).unwrap();
        assert!(incoming.patch.contains("+remote"));
        let after = mutate(source.cwd(), &state.token, "pull", &[], "", None).unwrap();
        assert_eq!(after.behind, 0);
        assert!(source.0.join("remote.txt").is_file());
        source.write("local.txt", "local\n");
        source.commit();
        peer.write("other-remote.txt", "other\n");
        peer.commit();
        peer.git(&["push", "origin", "main"]);
        let state = status(source.cwd(), true, None).unwrap();
        assert_eq!((state.ahead, state.behind), (1, 1));
        let head = state.head.clone();
        assert!(mutate(source.cwd(), &state.token, "pull", &[], "", None).is_err());
        assert!(mutate(source.cwd(), &state.token, "push", &[], "", None).is_err());
        assert_eq!(source.state().head, head);
        assert!(!source.0.join("other-remote.txt").exists());
    }
    #[test]
    fn pull_with_local_files_and_detached_writes_are_refused() {
        let repo = Repo::new(true);
        repo.write("untracked.txt", "keep\n");
        let state = repo.state();
        assert!(mutate(repo.cwd(), &state.token, "pull", &[], "", None)
            .unwrap_err()
            .contains("locales"));
        repo.git(&["checkout", "--detach", "HEAD"]);
        let state = repo.state();
        assert!(mutate(
            repo.cwd(),
            &state.token,
            "commit",
            &["untracked.txt".into()],
            "no",
            None
        )
        .unwrap_err()
        .contains("separado"));
        assert!(repo.0.join("untracked.txt").is_file());
    }
    #[test]
    fn selected_remote_controls_comparison_and_changed_destinations_require_review() {
        let repo = Repo::new(true);
        repo.git(&[
            "remote",
            "add",
            "origin",
            repo.0.join("origin.git").to_str().unwrap(),
        ]);
        repo.git(&[
            "remote",
            "add",
            "secondary",
            repo.0.join("secondary.git").to_str().unwrap(),
        ]);
        repo.git(&["update-ref", "refs/remotes/origin/main", "HEAD"]);
        repo.git(&["config", "branch.main.remote", "origin"]);
        repo.git(&["config", "branch.main.merge", "refs/heads/main"]);
        repo.git(&["checkout", "-b", "remote-work"]);
        repo.write("incoming.txt", "incoming\n");
        repo.commit();
        repo.git(&["update-ref", "refs/remotes/secondary/main", "HEAD"]);
        repo.git(&["checkout", "main"]);
        let selected = status(repo.cwd(), false, Some("secondary")).unwrap();
        assert_eq!(
            selected.upstream.as_deref(),
            Some("refs/remotes/secondary/main")
        );
        assert_eq!(selected.behind, 1);
        assert!(diff(
            repo.cwd(),
            Some("incoming.txt"),
            Some("incoming"),
            Some("secondary")
        )
        .unwrap()
        .patch
        .contains("+incoming"));
        let reviewed = repo.state();
        repo.git(&[
            "remote",
            "set-url",
            "origin",
            repo.0.join("different.git").to_str().unwrap(),
        ]);
        assert!(mutate(repo.cwd(), &reviewed.token, "push", &[], "", None)
            .unwrap_err()
            .contains("cambió"));
    }
    #[test]
    fn successful_push_is_reported_even_if_tracking_configuration_is_locked() {
        let repo = Repo::new(true);
        let remote = Repo::new(false);
        let bare = remote.0.join("remote.git");
        remote.git(&["init", "--bare", "-q", bare.to_str().unwrap()]);
        repo.git(&["remote", "add", "origin", bare.to_str().unwrap()]);
        fs::write(repo.0.join(".git/config.lock"), "fixture lock").unwrap();
        let state = repo.state();
        let next = mutate(repo.cwd(), &state.token, "push", &[], "", None).unwrap();
        assert!(next.warning.as_deref().unwrap().contains("push terminó"));
        assert_eq!(
            text(bare.to_str().unwrap(), &["rev-parse", "refs/heads/main"]).unwrap(),
            state.head.unwrap()
        );
    }
}
