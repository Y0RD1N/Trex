//! Ramas del proyecto: consulta y cambios solicitados desde la bandeja del chat.
use std::io::Read;
use std::process::{Command, Output, Stdio};
use std::time::{Duration, Instant};
use serde::Serialize;

fn run_git(cwd: &str, args: &[&str], timeout: Duration) -> Result<String, String> {
    let mut command = Command::new("git");
    command.arg("-C").arg(cwd).args(args).env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    let mut child = command.spawn().map_err(|error| format!("No se pudo ejecutar Git: {error}"))?;
    // Una lista de ramas grande no debe llenar la tubería antes de que Git salga.
    let mut stdout = child.stdout.take().ok_or("No se pudo leer la salida de Git.")?;
    let mut stderr = child.stderr.take().ok_or("No se pudieron leer los errores de Git.")?;
    let output_reader = std::thread::spawn(move || { let mut bytes = Vec::new(); stdout.read_to_end(&mut bytes).map(|_| bytes) });
    let error_reader = std::thread::spawn(move || { let mut bytes = Vec::new(); stderr.read_to_end(&mut bytes).map(|_| bytes) });
    let start = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if start.elapsed() < timeout => std::thread::sleep(Duration::from_millis(20)),
            result => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(match result {
                    Err(error) => format!("No se pudo esperar a Git: {error}"),
                    _ => "Git tardó demasiado. Comprueba el repositorio y vuelve a intentarlo.".into(),
                });
            }
        }
    };
    let stdout = output_reader.join().map_err(|_| "No se pudo leer la salida de Git.")?.map_err(|error| error.to_string())?;
    let stderr = error_reader.join().map_err(|_| "No se pudieron leer los errores de Git.")?.map_err(|error| error.to_string())?;
    let output = Output { status, stdout, stderr };
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if output.status.success() { Ok(text) }
    else {
        let error = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(if error.is_empty() { "Git no pudo completar la operación.".into() } else { error })
    }
}

fn git(cwd: &str, args: &[&str]) -> Option<String> {
    run_git(cwd, args, Duration::from_secs(3)).ok().filter(|text| !text.is_empty())
}

/// Commits de las últimas `hours` horas («asunto (hace cuánto)»), los más recientes
/// primero. Vacío si la carpeta no es un repositorio. Lo usa el resumen del modo llamada.
pub fn recent_commits(cwd: &str, hours: u32) -> Vec<String> {
    if !std::path::Path::new(cwd).is_dir() {
        return Vec::new();
    }
    let since = format!("--since={hours} hours ago");
    git(cwd, &["log", &since, "--max-count=40", "--no-merges", "--pretty=format:%s (%cr)"])
        .map(|text| text.lines().map(str::to_string).collect())
        .unwrap_or_default()
}

/// Nombre de la rama actual; con HEAD separado, el commit abreviado.
pub fn branch(cwd: &str) -> Option<String> {
    if !std::path::Path::new(cwd).is_dir() {
        return None;
    }
    git(cwd, &["branch", "--show-current"]).or_else(|| git(cwd, &["rev-parse", "--short", "HEAD"]))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitBranch {
    pub name: String,
    pub reference: String,
    pub remote: bool,
    pub current: bool,
    pub upstream: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitBranches {
    pub current: Option<String>,
    pub detached: bool,
    pub branches: Vec<GitBranch>,
}

pub(crate) fn branches(cwd: &str) -> Result<GitBranches, String> {
    if git(cwd, &["rev-parse", "--is-inside-work-tree"]).as_deref() != Some("true") {
        return Err("Esta carpeta no es un repositorio de Git o Git no está disponible.".into());
    }
    let current_name = git(cwd, &["symbolic-ref", "--quiet", "--short", "HEAD"]);
    let current = current_name.clone().or_else(|| branch(cwd));
    let output = run_git(cwd, &["for-each-ref", "--sort=refname", "--format=%(refname)%00%(symref)%00%(upstream)", "refs/heads", "refs/remotes"], Duration::from_secs(5))?;
    let mut items = Vec::new();
    for line in output.lines() {
        let mut fields = line.split('\0');
        let reference = fields.next().unwrap_or_default();
        if !fields.next().unwrap_or_default().is_empty() { continue; } // origin/HEAD no es una rama.
        let upstream = fields.next().filter(|value| !value.is_empty()).map(str::to_owned);
        let (name, remote) = if let Some(name) = reference.strip_prefix("refs/heads/") { (name, false) }
            else if let Some(name) = reference.strip_prefix("refs/remotes/") { (name, true) }
            else { continue; };
        items.push(GitBranch { name: name.into(), reference: reference.into(), remote,
            current: !remote && current_name.as_deref() == Some(name), upstream });
    }
    // Un repositorio sin su primer commit también tiene una rama actual.
    if let Some(name) = current_name.as_ref() {
        if !items.iter().any(|item| item.current) {
            items.push(GitBranch { name: name.clone(), reference: format!("refs/heads/{name}"), remote: false, current: true, upstream: None });
        }
    }
    items.sort_by(|a, b| a.remote.cmp(&b.remote).then(b.current.cmp(&a.current)).then(a.name.cmp(&b.name)));
    Ok(GitBranches { current, detached: current_name.is_none(), branches: items })
}

fn switch_branch(cwd: &str, reference: &str) -> Result<GitBranches, String> {
    let snapshot = branches(cwd)?;
    let chosen = snapshot.branches.iter().find(|item| item.reference == reference)
        .ok_or("La rama ya no está disponible. Actualiza la lista y vuelve a intentarlo.")?;
    if chosen.current { return Ok(snapshot); }
    let tracking = snapshot.branches.iter().find(|item| !item.remote && item.upstream.as_deref() == Some(reference));
    if chosen.remote && tracking.is_none() {
        run_git(cwd, &["switch", "--no-recurse-submodules", "--track", "--", reference], Duration::from_secs(30))?;
    } else {
        let name = tracking.filter(|_| chosen.remote).map(|item| item.name.as_str()).unwrap_or(&chosen.name);
        run_git(cwd, &["switch", "--no-recurse-submodules", "--no-guess", "--", name], Duration::from_secs(30))?;
    }
    branches(cwd)
}

fn create_branch(cwd: &str, name: &str) -> Result<GitBranches, String> {
    let name = name.trim();
    // Validar la referencia literal evita interpretar @{-1} y opciones de Git.
    if name.is_empty() || name.starts_with('-') || name == "HEAD"
        || run_git(cwd, &["check-ref-format", &format!("refs/heads/{name}")], Duration::from_secs(3)).is_err() {
        return Err("Nombre de rama inválido. Usa, por ejemplo, feature/nueva-idea, sin espacios.".into());
    }
    branches(cwd)?;
    run_git(cwd, &["switch", "--no-recurse-submodules", "--create", name], Duration::from_secs(30))?;
    branches(cwd)
}

#[tauri::command]
pub async fn git_branch(cwd: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || branch(&cwd))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn git_branches(cwd: String) -> Result<GitBranches, String> {
    tauri::async_runtime::spawn_blocking(move || branches(&cwd)).await.map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn git_switch_branch(cwd: String, reference: String) -> Result<GitBranches, String> {
    tauri::async_runtime::spawn_blocking(move || crate::git_panel::with_repo_lock(&cwd, || switch_branch(&cwd, &reference))).await.map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn git_create_branch(cwd: String, name: String) -> Result<GitBranches, String> {
    tauri::async_runtime::spawn_blocking(move || crate::git_panel::with_repo_lock(&cwd, || create_branch(&cwd, &name))).await.map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Repo(std::path::PathBuf);
    impl Repo {
        fn new(commit: bool) -> Self {
            use std::sync::atomic::{AtomicU32, Ordering};
            static NEXT: AtomicU32 = AtomicU32::new(0);
            let path = std::env::temp_dir().join(format!("trex-branches-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::SeqCst)));
            std::fs::create_dir_all(&path).unwrap();
            let repo = Self(path);
            repo.git(&["init", "-q", "-b", "main"]);
            if commit {
                std::fs::write(repo.0.join("file.txt"), "base\n").unwrap();
                repo.commit();
            }
            repo
        }
        fn cwd(&self) -> &str { self.0.to_str().unwrap() }
        fn git(&self, args: &[&str]) -> String { run_git(self.cwd(), args, Duration::from_secs(5)).unwrap() }
        fn commit(&self) {
            self.git(&["add", "."]);
            self.git(&["-c", "user.name=TREX test", "-c", "user.email=trex@example.test", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "fixture"]);
        }
    }
    impl Drop for Repo { fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); } }

    #[test]
    fn lists_local_and_remote_branches_without_the_remote_head_alias() {
        let repo = Repo::new(true);
        repo.git(&["branch", "feature/chat"]);
        repo.git(&["update-ref", "refs/remotes/origin/main", "HEAD"]);
        repo.git(&["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
        let state = branches(repo.cwd()).unwrap();
        assert_eq!(state.current.as_deref(), Some("main"));
        assert!(!state.detached);
        assert_eq!(state.branches.iter().map(|item| item.name.as_str()).collect::<Vec<_>>(), ["main", "feature/chat", "origin/main"]);
        assert!(state.branches[0].current);
        assert!(state.branches[2].remote);
        assert_eq!(state.branches[2].reference, "refs/remotes/origin/main");
    }

    #[test]
    fn creates_and_switches_branches_while_preserving_pending_files() {
        let repo = Repo::new(true);
        std::fs::write(repo.0.join("file.txt"), "pending edit\n").unwrap();
        std::fs::write(repo.0.join("untracked.txt"), "pending file\n").unwrap();
        let created = create_branch(repo.cwd(), "feature/mañana").unwrap();
        assert_eq!(created.current.as_deref(), Some("feature/mañana"));
        assert_eq!(switch_branch(repo.cwd(), "refs/heads/main").unwrap().current.as_deref(), Some("main"));
        assert_eq!(std::fs::read_to_string(repo.0.join("file.txt")).unwrap(), "pending edit\n");
        assert_eq!(std::fs::read_to_string(repo.0.join("untracked.txt")).unwrap(), "pending file\n");
        let before = repo.git(&["rev-parse", "HEAD"]);
        for name in ["main", "", "--orphan", "HEAD", "bad name", "../outside", "@{-1}"] {
            assert!(create_branch(repo.cwd(), name).is_err(), "accepted {name}");
        }
        assert_eq!(repo.git(&["rev-parse", "HEAD"]), before);
        assert_eq!(branch(repo.cwd()).as_deref(), Some("main"));
        // Se pasa como un argumento literal; nunca a cmd, PowerShell o un shell.
        assert_eq!(create_branch(repo.cwd(), "feature;echo-owned").unwrap().current.as_deref(), Some("feature;echo-owned"));
        assert!(!repo.0.join("owned").exists());
    }

    #[test]
    fn conflicting_changes_and_unknown_references_do_not_change_the_branch() {
        let repo = Repo::new(true);
        create_branch(repo.cwd(), "different").unwrap();
        std::fs::write(repo.0.join("file.txt"), "other branch\n").unwrap();
        repo.commit();
        switch_branch(repo.cwd(), "refs/heads/main").unwrap();
        std::fs::write(repo.0.join("file.txt"), "keep my edit\n").unwrap();
        assert!(switch_branch(repo.cwd(), "refs/heads/different").is_err());
        assert!(switch_branch(repo.cwd(), "--discard-changes").is_err());
        assert_eq!(branch(repo.cwd()).as_deref(), Some("main"));
        assert_eq!(std::fs::read_to_string(repo.0.join("file.txt")).unwrap(), "keep my edit\n");
        assert!(repo.git(&["stash", "list"]).is_empty());
    }

    #[test]
    fn remote_selection_creates_a_tracking_branch_and_then_reuses_it() {
        let repo = Repo::new(true);
        repo.git(&["remote", "add", "origin", repo.cwd()]);
        repo.git(&["update-ref", "refs/remotes/origin/feature/remote", "HEAD"]);
        let reference = "refs/remotes/origin/feature/remote";
        let selected = switch_branch(repo.cwd(), reference).unwrap();
        assert_eq!(selected.current.as_deref(), Some("feature/remote"));
        assert_eq!(selected.branches.iter().find(|item| item.current).unwrap().upstream.as_deref(), Some(reference));
        switch_branch(repo.cwd(), "refs/heads/main").unwrap();
        assert_eq!(switch_branch(repo.cwd(), reference).unwrap().current.as_deref(), Some("feature/remote"));
    }

    #[test]
    fn detached_and_unborn_repositories_can_create_a_branch() {
        let repo = Repo::new(true);
        repo.git(&["switch", "--detach"]);
        let detached = branches(repo.cwd()).unwrap();
        assert!(detached.detached);
        assert!(!detached.branches.iter().any(|item| item.current));
        assert_eq!(create_branch(repo.cwd(), "from-detached").unwrap().current.as_deref(), Some("from-detached"));
        let unborn = Repo::new(false);
        let state = branches(unborn.cwd()).unwrap();
        assert_eq!(state.current.as_deref(), Some("main"));
        assert!(state.branches[0].current);
        assert_eq!(create_branch(unborn.cwd(), "first-work").unwrap().current.as_deref(), Some("first-work"));
    }

    #[test]
    fn branches_in_another_worktree_are_not_forced_or_reset() {
        let repo = Repo::new(true);
        let worktree = repo.0.join("other-worktree");
        repo.git(&["worktree", "add", "-b", "occupied", worktree.to_str().unwrap()]);
        let before = repo.git(&["rev-parse", "occupied"]);
        assert!(switch_branch(repo.cwd(), "refs/heads/occupied").is_err());
        assert!(create_branch(repo.cwd(), "occupied").is_err());
        assert_eq!(branch(repo.cwd()).as_deref(), Some("main"));
        assert_eq!(repo.git(&["rev-parse", "occupied"]), before);
    }

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
