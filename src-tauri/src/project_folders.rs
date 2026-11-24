//! Carpetas de proyectos para el lanzador de proyectos.
//!
//! La persona elige en Ajustes una o varias carpetas raíz (por ejemplo
//! `D:\projects`). Cada subcarpeta directa es un proyecto que se puede abrir
//! con un agente sin añadirlo antes a mano. Solo se mira el primer nivel: es
//! instantáneo aunque haya cientos de carpetas y no recorre dependencias.
use std::fs;
use std::path::Path;
use std::time::UNIX_EPOCH;

use serde::Serialize;

/// Tope por carpeta raíz: de sobra para una carpeta de proyectos real.
const LIMIT_PER_ROOT: usize = 2_000;
/// Tope de carpetas raíz por consulta (Ajustes guarda pocas).
const MAX_ROOTS: usize = 32;
/// Carpetas que nunca son un proyecto aunque vivan en la raíz.
const SKIPPED: &[&str] = &["node_modules", "System Volume Information", "lost+found"];

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFolder {
    pub name: String,
    pub path: String,
    /// Carpeta raíz de la que sale, tal como la guardó la persona.
    pub root: String,
    /// Tiene `.git`: suele ser un proyecto de verdad.
    pub git: bool,
    /// Última modificación en milisegundos desde 1970, si el sistema la da.
    pub modified: Option<u64>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFolders {
    pub folders: Vec<ProjectFolder>,
    /// Carpetas raíz que ya no existen o no se pudieron leer.
    pub missing: Vec<String>,
}

/// Carpetas ocultas o del sistema: no se ofrecen como proyectos.
fn hidden(name: &str, path: &Path) -> bool {
    if name.starts_with('.') || name.starts_with('$') || SKIPPED.iter().any(|item| item.eq_ignore_ascii_case(name)) {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const HIDDEN: u32 = 0x2;
        const SYSTEM: u32 = 0x4;
        if let Ok(meta) = fs::symlink_metadata(path) {
            if meta.file_attributes() & (HIDDEN | SYSTEM) != 0 {
                return true;
            }
        }
    }
    #[cfg(not(windows))]
    let _ = path;
    false
}

fn modified_ms(path: &Path) -> Option<u64> {
    let time = fs::metadata(path).ok()?.modified().ok()?;
    time.duration_since(UNIX_EPOCH).ok().map(|value| value.as_millis() as u64)
}

/// Subcarpetas directas de cada raíz, ordenadas por nombre dentro de cada una.
/// Una raíz repetida (misma ruta con otra forma) solo se lee una vez.
pub fn list(roots: &[String]) -> ProjectFolders {
    let mut folders = Vec::new();
    let mut missing = Vec::new();
    let mut seen_roots: Vec<String> = Vec::new();
    for root in roots.iter().take(MAX_ROOTS) {
        let clean = root.trim();
        if clean.is_empty() {
            continue;
        }
        let key = clean.trim_end_matches(['\\', '/']).replace('/', "\\").to_lowercase();
        if seen_roots.contains(&key) {
            continue;
        }
        seen_roots.push(key);
        let dir = Path::new(clean);
        let Ok(entries) = fs::read_dir(dir) else {
            missing.push(clean.to_string());
            continue;
        };
        let mut found = Vec::new();
        for entry in entries.flatten() {
            if found.len() >= LIMIT_PER_ROOT {
                break;
            }
            let path = entry.path();
            // `metadata` sigue enlaces y uniones: una carpeta enlazada también vale.
            if !fs::metadata(&path).is_ok_and(|meta| meta.is_dir()) {
                continue;
            }
            let Some(name) = path.file_name().and_then(|name| name.to_str()).map(str::to_string) else {
                continue;
            };
            if hidden(&name, &path) {
                continue;
            }
            found.push(ProjectFolder {
                git: path.join(".git").exists(),
                modified: modified_ms(&path),
                path: path.to_string_lossy().into_owned(),
                root: clean.to_string(),
                name,
            });
        }
        found.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
        folders.extend(found);
    }
    ProjectFolders { folders, missing }
}

#[tauri::command]
pub async fn list_project_folders(roots: Vec<String>) -> Result<ProjectFolders, String> {
    tauri::async_runtime::spawn_blocking(move || list(&roots))
        .await
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("trex-folders-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("zeta/.git")).unwrap();
        fs::create_dir_all(dir.join("Alpha")).unwrap();
        fs::create_dir_all(dir.join(".oculta")).unwrap();
        fs::create_dir_all(dir.join("node_modules")).unwrap();
        fs::write(dir.join("notas.txt"), "no es carpeta").unwrap();
        dir
    }

    #[test]
    fn lists_direct_subfolders_sorted_and_skips_files_and_hidden_ones() {
        let dir = fixture("list");
        let root = dir.to_string_lossy().into_owned();
        let result = list(&[root.clone()]);
        let names: Vec<_> = result.folders.iter().map(|folder| folder.name.as_str()).collect();
        assert_eq!(names, ["Alpha", "zeta"]);
        assert!(result.folders[1].git && !result.folders[0].git);
        assert!(result.folders.iter().all(|folder| folder.root == root && folder.modified.is_some()));
        assert!(result.missing.is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn several_roots_are_merged_and_missing_or_repeated_ones_are_reported_once() {
        let first = fixture("first");
        let second = std::env::temp_dir().join(format!("trex-folders-second-{}", std::process::id()));
        let _ = fs::remove_dir_all(&second);
        fs::create_dir_all(second.join("beta")).unwrap();
        let gone = first.join("no-existe").to_string_lossy().into_owned();
        let first_root = first.to_string_lossy().into_owned();
        let repeated = format!("{}/", first_root.to_uppercase());
        let roots = vec![first_root, repeated, second.to_string_lossy().into_owned(), gone.clone(), "  ".into()];
        let result = list(&roots);
        let names: Vec<_> = result.folders.iter().map(|folder| folder.name.as_str()).collect();
        assert_eq!(names, ["Alpha", "zeta", "beta"]);
        assert_eq!(result.missing, [gone]);
        let _ = fs::remove_dir_all(&first);
        let _ = fs::remove_dir_all(&second);
    }
}
