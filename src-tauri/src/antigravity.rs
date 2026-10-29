//! Optional official Google ACP runtime. Downloaded only after an explicit UI action.
//! Credentials stay in the runtime's own account home and never cross the WebView.
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

const VERSION: &str = "1.4.4";
// Linux's self-contained PAR is substantially larger than the Windows build.
const ARCHIVE_LIMIT: u64 = 512 * 1024 * 1024;
const ENTRY_LIMIT: u64 = 1024 * 1024 * 1024;
static INSTALLING: AtomicBool = AtomicBool::new(false);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Runtime {
    pub installed: bool,
    pub version: Option<String>,
    pub command: Option<String>,
    pub flags: Vec<String>,
    pub env: std::collections::HashMap<String, String>,
}
fn names() -> (&'static str, &'static str) {
    if cfg!(windows) {
        ("agy_acp_server.exe", "localharness_external.exe")
    } else {
        ("agy_acp_server.par", "localharness_external")
    }
}
fn release() -> Result<(&'static str, &'static str), String> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("windows", "x86_64") => Ok((
            "windows/agy-acp-server-1.4.4-windows-x86_64.zip",
            "4b68e5936a3d7a60b520aa1ee9479c8be58c43e015f026dc41e7ad17ec54d427",
        )),
        ("windows", "aarch64") => Ok((
            "windows/agy-acp-server-1.4.4-windows-arm64.zip",
            "655835b095e160d726ee894a10e56960a9a81b03503edbd348079336163b28de",
        )),
        ("linux", "x86_64") => Ok((
            "linux/agy-acp-server-1.4.4-linux-x86_64.zip",
            "baf31b7a97602dee359cf2a43f72b6e11c6bf354be874987d80660cd3526bb6a",
        )),
        ("linux", "aarch64") => Ok((
            "linux/agy-acp-server-1.4.4-linux-arm64.zip",
            "b0273227c07cfa1ea5c1d9ff869b64c5b2b39b98862081fcd4c597ec316e0c57",
        )),
        ("macos", "x86_64") => Ok((
            "macos/agy-acp-server-1.4.4-darwin-x86_64.zip",
            "019e6ce30cf906ba94b761d752c7ccd01a324f4701efca31542de04b60be8fd7",
        )),
        ("macos", "aarch64") => Ok((
            "macos/agy-acp-server-1.4.4-darwin-arm64.zip",
            "a3cf324046396380fcd8c055a4a4c83ac4ea74a38ea883ccbfce5ca1e9927ae9",
        )),
        _ => Err("Google no publica un componente ACP para esta plataforma.".into()),
    }
}
fn managed_dir(root: &Path) -> PathBuf {
    root.join(format!(
        "acp-{VERSION}-{}-{}",
        std::env::consts::OS,
        std::env::consts::ARCH
    ))
}
fn regular(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .map(|m| m.file_type().is_file())
        .unwrap_or(false)
}
fn resolve(root: &Path, command: &str, account: &str) -> Result<Runtime, String> {
    let managed = matches!(
        command.trim(),
        "" | "antigravity-acp" | "agy_acp_server" | "agy_acp_server.exe" | "agy_acp_server.par"
    );
    let executable = if managed {
        managed_dir(root).join(names().0)
    } else {
        let path = PathBuf::from(crate::pty::expand_config_dir(command));
        if !path.is_absolute() {
            return Err(
                "Indica una ruta absoluta al servidor ACP oficial, o usa antigravity-acp.".into(),
            );
        }
        path
    };
    let helper = executable
        .parent()
        .ok_or("Ruta ACP no válida.")?
        .join(names().1);
    let installed = regular(&executable) && regular(&helper);
    if !managed && !installed {
        return Err("La ruta ACP debe contener el servidor oficial y su localharness_external de la misma versión. Corrige la ruta o usa antigravity-acp para instalar el componente gestionado.".into());
    }
    let account = if account.trim().is_empty() {
        root.join("accounts").join("default")
    } else {
        PathBuf::from(crate::pty::expand_config_dir(account))
    };
    if !account.is_absolute() {
        return Err("La carpeta de la cuenta ACP necesita una ruta absoluta.".into());
    }
    let mut env = std::collections::HashMap::new();
    env.insert("GEMINI_HOME".into(), account.to_string_lossy().into_owned());
    env.insert(
        "ANTIGRAVITY_HARNESS_PATH".into(),
        helper.to_string_lossy().into_owned(),
    );
    env.insert("AGY_ACP_FORCE_FILE_STORAGE".into(), "1".into());
    env.insert("TREX_AGENT_PROTOCOL".into(), "antigravity-acp".into());
    Ok(Runtime {
        installed,
        version: if installed && managed {
            Some(VERSION.into())
        } else {
            None
        },
        command: installed.then(|| executable.to_string_lossy().into_owned()),
        flags: if cfg!(target_os = "linux") {
            vec!["--uid=".into()]
        } else {
            vec![]
        },
        env,
    })
}
#[tauri::command]
pub async fn antigravity_runtime(
    app: AppHandle,
    command: String,
    config_dir: String,
) -> Result<Runtime, String> {
    let root = app
        .path()
        .app_local_data_dir()
        .map_err(|e| e.to_string())?
        .join("antigravity");
    resolve(&root, &command, &config_dir)
}
fn digest_file(path: &Path) -> Result<String, String> {
    let mut file = File::open(path).map_err(|e| e.to_string())?;
    let mut digest = Sha256::new();
    let mut buffer = [0; 65536];
    loop {
        let n = file.read(&mut buffer).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        digest.update(&buffer[..n]);
    }
    Ok(format!("{:x}", digest.finalize()))
}
fn extract(archive: &Path, destination: &Path) -> Result<(), String> {
    let mut zip = zip::ZipArchive::new(File::open(archive).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    let (executable, helper) = names();
    // Extract only the two expected root files; never follow archive paths or symlinks.
    if zip.len() != 2
        || zip
            .decompressed_size()
            .is_none_or(|size| size > 1536 * 1024 * 1024)
    {
        return Err("El paquete ACP contiene archivos inesperados o excede el límite.".into());
    }
    for name in [executable, helper] {
        let mut entry = zip
            .by_name(name)
            .map_err(|_| "Falta un componente del paquete ACP.")?;
        if entry.size() > ENTRY_LIMIT || entry.unix_mode().is_some_and(|m| m & 0o170000 == 0o120000)
        {
            return Err("El paquete ACP contiene una entrada no válida.".into());
        }
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(destination.join(name))
            .map_err(|e| e.to_string())?;
        let bytes = std::io::copy(&mut entry, &mut file).map_err(|e| e.to_string())?;
        if bytes == 0 || bytes > ENTRY_LIMIT {
            return Err("El componente ACP está vacío o excede el límite.".into());
        }
        file.sync_all().map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(destination.join(name), fs::Permissions::from_mode(0o700))
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}
fn install(root: &Path) -> Result<Runtime, String> {
    if resolve(root, "antigravity-acp", "")?.installed {
        return resolve(root, "antigravity-acp", "");
    }
    let (path, expected) = release()?;
    fs::create_dir_all(root).map_err(|e| e.to_string())?;
    let token = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_nanos();
    let stage = root.join(format!("download-{}-{token}", std::process::id()));
    fs::create_dir(&stage).map_err(|e| e.to_string())?;
    let archive = stage.join("official.zip");
    let client = reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(20))
        .timeout(Duration::from_secs(240))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "No se pudo preparar la descarga ACP.")?;
    let mut response = client
        .get(format!(
            "https://dl.google.com/agy-extensions/releases/{path}"
        ))
        .send()
        .and_then(|r| r.error_for_status())
        .map_err(|_| "No se pudo descargar el componente ACP oficial de Google.")?;
    if response
        .content_length()
        .is_some_and(|size| size > ARCHIVE_LIMIT)
    {
        return Err("El paquete ACP excede el límite de descarga.".into());
    }
    let mut file = File::create(&archive).map_err(|e| e.to_string())?;
    let bytes = std::io::copy(&mut response.by_ref().take(ARCHIVE_LIMIT + 1), &mut file)
        .map_err(|_| "Se interrumpió la descarga ACP.")?;
    file.flush().map_err(|e| e.to_string())?;
    drop(file);
    if bytes > ARCHIVE_LIMIT || digest_file(&archive)? != expected {
        return Err("La verificación SHA-256 del paquete ACP falló; no se instaló.".into());
    }
    let unpacked = stage.join("runtime");
    fs::create_dir(&unpacked).map_err(|e| e.to_string())?;
    extract(&archive, &unpacked)?;
    // A fixed version gets an immutable directory. Preserve an incomplete prior
    // installation before publishing the verified pair; never move a symlink.
    let target = managed_dir(root);
    if target.exists() && !resolve(root, "antigravity-acp", "")?.installed {
        let metadata = fs::symlink_metadata(&target).map_err(|e| e.to_string())?;
        let parent = root.canonicalize().map_err(|e| e.to_string())?;
        let checked = target.canonicalize().map_err(|e| e.to_string())?;
        if !metadata.file_type().is_dir()
            || !checked.starts_with(&parent)
            || checked.parent() != Some(parent.as_path())
        {
            return Err("La carpeta ACP existente no es válida. No se modificó.".into());
        }
        fs::rename(
            &target,
            root.join(format!("incomplete-{}-{token}", std::process::id())),
        )
        .map_err(|_| "No se pudo conservar la instalación ACP incompleta.".to_string())?;
    }
    if !target.exists() {
        fs::rename(&unpacked, &target)
            .map_err(|_| "No se pudo publicar el componente ACP verificado.")?;
    }
    let _ = fs::remove_file(&archive);
    let _ = fs::remove_dir(&stage);
    resolve(root, "antigravity-acp", "")
}
#[tauri::command]
pub async fn antigravity_install(app: AppHandle) -> Result<Runtime, String> {
    if INSTALLING.swap(true, Ordering::SeqCst) {
        return Err("Ya hay una descarga de Antigravity en curso.".into());
    }
    struct Guard;
    impl Drop for Guard {
        fn drop(&mut self) {
            INSTALLING.store(false, Ordering::SeqCst);
        }
    }
    let guard = Guard;
    let root = app
        .path()
        .app_local_data_dir()
        .map_err(|e| e.to_string())?
        .join("antigravity");
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = guard;
        install(&root)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn default_profile_does_not_reuse_another_providers_configuration() {
        let root = std::env::temp_dir().join("trex-acp-resolve-test");
        let status = resolve(&root, "antigravity-acp", "").unwrap();
        assert!(!status.installed);
        assert!(status.env["GEMINI_HOME"]
            .ends_with(&format!("accounts{}default", std::path::MAIN_SEPARATOR)));
        assert!(!status.env.contains_key("CLAUDE_CONFIG_DIR"));
        assert!(resolve(&root, "agy --print", "").is_err());
    }
    #[test]
    fn release_is_a_pinned_google_download() {
        let (path, hash) = release().unwrap();
        assert!(path.contains(VERSION));
        assert_eq!(hash.len(), 64);
    }
    #[test]
    #[ignore = "requires TREX_TEST_ANTIGRAVITY_ARCHIVE pointing to the pinned official archive; no authentication or inference"]
    fn downloaded_official_archive_extracts_the_matched_pair() {
        let archive =
            PathBuf::from(std::env::var_os("TREX_TEST_ANTIGRAVITY_ARCHIVE").expect("set archive"));
        assert_eq!(digest_file(&archive).unwrap(), release().unwrap().1);
        let temp = std::env::temp_dir().canonicalize().unwrap();
        let token = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = temp.join(format!(
            "trex-antigravity-test-{}-{token}",
            std::process::id()
        ));
        fs::create_dir(&root).unwrap();
        extract(&archive, &root).unwrap();
        let runtime = resolve(&root, root.join(names().0).to_str().unwrap(), "").unwrap();
        assert!(runtime.installed);
        assert!(regular(&root.join(names().1)));
        let checked = root.canonicalize().unwrap();
        assert!(checked.starts_with(&temp));
        assert!(checked
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("trex-antigravity-test-"));
        fs::remove_dir_all(checked).unwrap();
    }
}
