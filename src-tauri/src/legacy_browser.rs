//! Limpieza de lo que dejó el Trex Browser antiguo.
//!
//! Trex Browser (el navegador Electron propio de los agentes) ya no existe: los
//! agentes usan «Tu navegador» (la extensión y `browser_bridge.rs`). El
//! instalador de Windows quita el runtime que había junto a trex, pero los
//! perfiles guardan sesiones iniciadas de los agentes y solo se borran cuando
//! la persona lo pide desde la app.
//!
//! Dónde guardaba cada cosa la versión 0.11.0 (código en el historial de git):
//! - Hogar privado: perfiles de los agentes (`projects/<id>/BROWSER<n>/user-data`),
//!   el personal (`personal/user-data`), la ventana compartida
//!   (`browser-window/user-data`), `artifacts`, `receipts`, `broker.json`,
//!   `broker.token`, `engine.json`, `theme.json` y `save-folders.json`.
//!   Windows: `%LOCALAPPDATA%\TrexBrowser` (`trex-browser/src/security.rs`).
//!   Linux: `$XDG_STATE_HOME/trex-browser` o `~/.local/state/trex-browser`
//!   (`trex-browser/src/linux.rs`, `worker/security.mjs`). `TREX_BROWSER_HOME`
//!   solo lo usaban las pruebas: aquí no se sigue una ruta tomada del entorno.
//! - userData por defecto de su ventana Electron (productName «Trex Browser»):
//!   `%APPDATA%\Trex Browser` o `~/.config/Trex Browser`. El shell lo cambiaba
//!   al perfil personal (`shell/main.mjs`), así que solo existe si eso falló.
//! - Runtime junto a trex: `trex-browser(.exe)` y `trex-browser-runtime/`, más
//!   los `.payload`/`.previous` de una instalación a medias (`installer/trex-cli.nsh`)
//!   y los `.new`/`.old` de `scripts/install-local-linux.sh`. El del RPM
//!   (`/usr/bin`, `/usr/lib/trex`) lo quita el gestor de paquetes.
//! - Instalación independiente: en Windows, `HKCU\Software\com.trex.browser\Install`,
//!   valor `InstallDir` (por defecto `%LOCALAPPDATA%\Programs\Trex Browser`), con
//!   `uninstall-trex-browser.exe` (`installer/browser-installer.nsi`); en Linux,
//!   la carpeta `~/.local/share/trex-browser`. No se borra desde aquí.
//! - Procesos: el broker (`node(.exe)` del runtime), su ventana
//!   (`trex-browser-runtime/shell/trex-browser-shell(.exe)`) y el lanzador. Solo se
//!   paran si su ejecutable está dentro de esas carpetas, nunca por el nombre.
use serde::Serialize;
use std::fs;
use std::path::{Component, Path, PathBuf};

const RUNTIME: &str = "trex-browser-runtime";
const LAUNCHER: &str = if cfg!(windows) { "trex-browser.exe" } else { "trex-browser" };
const UNINSTALLER: &str = "uninstall-trex-browser.exe";
/// Restos de una instalación o actualización que no terminó.
const LEFTOVERS: &[&str] = &["trex-browser.payload", "trex-browser-runtime.payload", "trex-browser.exe.previous",
    "trex-browser-runtime.previous", ".trex-browser-runtime.new", ".trex-browser-runtime.old"];
/// Más hondo que cualquier perfil de Chromium: lo que pase de aquí se deja.
const MAX_DEPTH: usize = 64;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LegacyItem {
    pub label: String,
    pub path: String,
    pub bytes: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LegacyBrowser {
    /// Queda algo que `legacy_browser_remove` puede borrar (los `items`).
    pub found: bool,
    pub bytes: u64,
    /// Hay procesos del runtime viejo en marcha.
    pub running: bool,
    pub items: Vec<LegacyItem>,
    /// Desinstalador de la instalación independiente, si sigue instalada.
    pub standalone_uninstaller: Option<String>,
}

/// Dónde buscar: el entorno real o, en las pruebas, carpetas temporales.
#[derive(Default)]
struct Places {
    home: Option<PathBuf>,
    electron: Option<PathBuf>,
    /// Carpeta del ejecutable de trex, donde el instalador ponía el runtime.
    app_dir: Option<PathBuf>,
    standalone: Option<PathBuf>,
    /// Runtime del paquete del sistema: sus procesos cuentan, sus archivos no se tocan.
    system: Vec<PathBuf>,
}

impl Places {
    fn current() -> Self {
        let var = |name: &str| std::env::var_os(name).map(PathBuf::from).filter(|path| path.is_absolute());
        let app_dir = std::env::current_exe().ok().and_then(|exe| exe.parent().map(Path::to_path_buf));
        #[cfg(windows)]
        {
            Self { home: var("LOCALAPPDATA").map(|dir| dir.join("TrexBrowser")),
                electron: var("APPDATA").map(|dir| dir.join("Trex Browser")),
                app_dir, standalone: registered_directory(), system: Vec::new() }
        }
        #[cfg(target_os = "linux")]
        {
            let home = var("HOME");
            let xdg = |name: &str, fallback: &str| var(name).or_else(|| home.as_ref().map(|home| home.join(fallback)));
            Self { home: xdg("XDG_STATE_HOME", ".local/state").map(|dir| dir.join("trex-browser")),
                electron: xdg("XDG_CONFIG_HOME", ".config").map(|dir| dir.join("Trex Browser")),
                // En /usr el RPM es el dueño de lo que haya junto a trex.
                app_dir: app_dir.filter(|dir| !dir.starts_with("/usr")),
                standalone: xdg("XDG_DATA_HOME", ".local/share").map(|dir| dir.join("trex-browser")),
                system: vec![PathBuf::from("/usr/lib/trex/trex-browser-runtime"), PathBuf::from("/usr/bin/trex-browser")] }
        }
        #[cfg(not(any(windows, target_os = "linux")))]
        {
            // Trex Browser nunca se publicó para macOS.
            let _ = (var, app_dir);
            Self::default()
        }
    }

    /// Lo que se puede borrar, con su etiqueta para la interfaz.
    fn candidates(&self) -> Vec<(&'static str, PathBuf)> {
        let mut list = Vec::new();
        if let Some(home) = &self.home { list.push(("Perfiles y sesiones de los agentes", home.clone())); }
        if let Some(dir) = &self.electron { list.push(("Datos de la ventana de Trex Browser", dir.clone())); }
        if let Some(app) = &self.app_dir {
            list.push(("Runtime junto a trex", app.join(RUNTIME)));
            list.push(("Lanzador junto a trex", app.join(LAUNCHER)));
            list.extend(LEFTOVERS.iter().map(|name| ("Restos de una instalación anterior", app.join(name))));
        }
        list
    }

    /// Carpetas (y lanzadores) de cuyo ejecutable sale un proceso del runtime viejo.
    fn process_roots(&self) -> Vec<PathBuf> {
        let named = self.app_dir.iter().chain(self.standalone.iter()).flat_map(|dir| [dir.join(RUNTIME), dir.join(LAUNCHER)]);
        named.chain(self.system.iter().cloned()).flat_map(|path| with_resolved(&path)).collect()
    }
}

/// La ruta y, si su carpeta pasa por un enlace o un nombre corto (`MIPC~1`), la
/// misma con la carpeta resuelta, que es como llegan las rutas de los procesos.
/// El último componente nunca se resuelve: un enlace en el sitio del runtime no
/// lleva a parar lo que haya en su destino.
fn with_resolved(path: &Path) -> Vec<PathBuf> {
    let resolved = path.parent().zip(path.file_name())
        .and_then(|(dir, name)| fs::canonicalize(dir).ok().map(|dir| dir.join(name)))
        .filter(|resolved| comparable(resolved) != comparable(path));
    std::iter::once(path.to_path_buf()).chain(resolved).collect()
}

#[cfg(windows)]
fn registered_directory() -> Option<PathBuf> {
    use std::ffi::c_void;
    #[link(name = "advapi32")]
    extern "system" {
        fn RegGetValueW(key: isize, subkey: *const u16, value: *const u16,
            flags: u32, kind: *mut u32, data: *mut c_void, bytes: *mut u32) -> i32;
    }
    let wide = |text: &str| text.encode_utf16().chain(Some(0)).collect::<Vec<_>>();
    let (subkey, name) = (wide(r"Software\com.trex.browser\Install"), wide("InstallDir"));
    let mut buffer = vec![0u16; 32768];
    let mut bytes = (buffer.len() * 2) as u32;
    // HKCU, solo REG_SZ y vista de 64 bits, como lo escribía su instalador.
    let result = unsafe { RegGetValueW(0x8000_0001u32 as i32 as isize, subkey.as_ptr(), name.as_ptr(),
        0x0001_0002, std::ptr::null_mut(), buffer.as_mut_ptr().cast(), &mut bytes) };
    if result != 0 || bytes < 4 || bytes as usize > buffer.len() * 2 || bytes % 2 != 0 { return None; }
    buffer.truncate(bytes as usize / 2);
    if buffer.pop() != Some(0) || buffer.contains(&0) { return None; }
    let text = String::from_utf16(&buffer).ok()?;
    let path = PathBuf::from(text);
    (path.is_absolute() && !path.components().any(|part| matches!(part, Component::ParentDir | Component::CurDir))).then_some(path)
}

/// Un enlace simbólico, un junction o cualquier otro punto de reanálisis: nunca se entra en él.
fn link(meta: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if meta.file_attributes() & 0x400 != 0 { return true; }
    }
    meta.file_type().is_symlink()
}

/// Quita el enlace en sí, no su destino.
fn remove_link(path: &Path, meta: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if meta.file_attributes() & 0x10 != 0 { return fs::remove_dir(path).is_ok(); }
    }
    let _ = meta;
    fs::remove_file(path).is_ok()
}

fn size(path: &Path, meta: &fs::Metadata, depth: usize) -> u64 {
    if link(meta) { return 0; }
    if !meta.is_dir() { return meta.len(); }
    if depth >= MAX_DEPTH { return 0; }
    let Ok(entries) = fs::read_dir(path) else { return 0 };
    entries.flatten().map(|entry| {
        let path = entry.path();
        fs::symlink_metadata(&path).map(|meta| size(&path, &meta, depth + 1)).unwrap_or(0)
    }).sum()
}

/// Borra sin seguir enlaces. Si algo falla (un archivo en uso) sigue con lo
/// demás y devuelve false: lo que quede vuelve a salir en el estado.
fn remove_tree(path: &Path, meta: &fs::Metadata, depth: usize) -> bool {
    if link(meta) { return remove_link(path, meta); }
    if !meta.is_dir() {
        if fs::remove_file(path).is_ok() { return true; }
        // Un archivo de solo lectura (algunos perfiles los tienen) se borra al quitarle la marca.
        let mut permissions = meta.permissions();
        if !permissions.readonly() { return false; }
        #[allow(clippy::permissions_set_readonly_false)]
        permissions.set_readonly(false);
        return fs::set_permissions(path, permissions).is_ok() && fs::remove_file(path).is_ok();
    }
    if depth >= MAX_DEPTH { return false; }
    let Ok(entries) = fs::read_dir(path) else { return false };
    let mut clean = true;
    for entry in entries {
        let Ok(entry) = entry else { clean = false; continue };
        let child = entry.path();
        clean &= match fs::symlink_metadata(&child) {
            Ok(meta) => remove_tree(&child, &meta, depth + 1),
            Err(error) => error.kind() == std::io::ErrorKind::NotFound,
        };
    }
    clean && fs::remove_dir(path).is_ok()
}

#[cfg(windows)]
fn comparable(path: &Path) -> PathBuf {
    // NTFS no distingue mayúsculas, y `\\?\C:\…` es la misma ruta que `C:\…`.
    let text = path.to_string_lossy();
    PathBuf::from(text.strip_prefix(r"\\?\").unwrap_or(&text).to_lowercase())
}
#[cfg(not(windows))]
fn comparable(path: &Path) -> PathBuf {
    path.to_path_buf()
}

/// El ejecutable está dentro de una de las carpetas, comparando por componentes:
/// `trex-browser-runtime2` o `trex-browser-runtime.payload` no son `trex-browser-runtime`.
fn owned(exe: &Path, roots: &[PathBuf]) -> bool {
    let exe = comparable(exe);
    exe.is_absolute() && !exe.components().any(|part| matches!(part, Component::ParentDir | Component::CurDir))
        && roots.iter().any(|root| exe.starts_with(comparable(root)))
}

#[cfg(windows)]
mod system {
    use std::ffi::c_void;
    use std::os::windows::ffi::OsStringExt;
    use std::path::PathBuf;

    type Handle = *mut c_void;
    const TERMINATE: u32 = 0x0001;
    const QUERY_LIMITED: u32 = 0x1000;
    const SYNCHRONIZE: u32 = 0x0010_0000;

    #[link(name = "kernel32")]
    extern "system" {
        fn K32EnumProcesses(ids: *mut u32, bytes: u32, needed: *mut u32) -> i32;
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> Handle;
        fn QueryFullProcessImageNameW(process: Handle, flags: u32, name: *mut u16, size: *mut u32) -> i32;
        fn TerminateProcess(process: Handle, code: u32) -> i32;
        fn WaitForSingleObject(handle: Handle, milliseconds: u32) -> u32;
        fn CloseHandle(handle: Handle) -> i32;
    }

    struct Process(Handle);
    impl Drop for Process {
        fn drop(&mut self) { unsafe { CloseHandle(self.0) }; }
    }

    fn open(pid: u32, access: u32) -> Option<Process> {
        let handle = unsafe { OpenProcess(access, 0, pid) };
        (!handle.is_null()).then(|| Process(handle))
    }

    fn image(process: &Process) -> Option<PathBuf> {
        let mut buffer = vec![0u16; 32768];
        let mut size = buffer.len() as u32;
        if unsafe { QueryFullProcessImageNameW(process.0, 0, buffer.as_mut_ptr(), &mut size) } == 0 { return None; }
        buffer.truncate(size as usize);
        Some(PathBuf::from(std::ffi::OsString::from_wide(&buffer)))
    }

    fn pids() -> Vec<u32> {
        let mut ids = vec![0u32; 1024];
        loop {
            let bytes = (ids.len() * 4) as u32;
            let mut needed = 0u32;
            if unsafe { K32EnumProcesses(ids.as_mut_ptr(), bytes, &mut needed) } == 0 { return Vec::new(); }
            if needed < bytes || ids.len() >= 1 << 20 {
                ids.truncate(needed as usize / 4);
                return ids;
            }
            ids.resize(ids.len() * 2, 0);
        }
    }

    pub(super) fn list() -> Vec<(u32, PathBuf)> {
        let me = std::process::id();
        pids().into_iter().filter(|&pid| pid != 0 && pid != me)
            .filter_map(|pid| open(pid, QUERY_LIMITED).and_then(|process| image(&process)).map(|exe| (pid, exe)))
            .collect()
    }

    pub(super) fn stop(pid: u32, roots: &[PathBuf]) -> bool {
        // La ruta se comprueba con el mismo manejador que lo para: un PID reutilizado no cuenta.
        let Some(process) = open(pid, TERMINATE | QUERY_LIMITED | SYNCHRONIZE) else { return false };
        if !image(&process).is_some_and(|exe| super::owned(&exe, roots)) { return false; }
        unsafe { TerminateProcess(process.0, 1) != 0 && WaitForSingleObject(process.0, 5000) == 0 }
    }
}

#[cfg(target_os = "linux")]
mod system {
    use std::path::PathBuf;
    use std::time::{Duration, Instant};

    fn exe(pid: u32) -> Option<PathBuf> {
        let link = std::fs::read_link(format!("/proc/{pid}/exe")).ok()?;
        // Un binario ya borrado (tras actualizar el RPM) sigue en marcha con « (deleted)» al final.
        let text = link.to_string_lossy().into_owned();
        Some(text.strip_suffix(" (deleted)").map(PathBuf::from).unwrap_or(link))
    }

    pub(super) fn list() -> Vec<(u32, PathBuf)> {
        let me = std::process::id();
        let Ok(entries) = std::fs::read_dir("/proc") else { return Vec::new() };
        entries.flatten().filter_map(|entry| entry.file_name().to_str()?.parse::<u32>().ok())
            .filter(|&pid| pid != me).filter_map(|pid| exe(pid).map(|exe| (pid, exe))).collect()
    }

    fn ours(pid: u32, roots: &[PathBuf]) -> bool {
        exe(pid).is_some_and(|exe| super::owned(&exe, roots))
    }

    pub(super) fn stop(pid: u32, roots: &[PathBuf]) -> bool {
        if !ours(pid, roots) { return false; }
        // Primero se le pide que termine; si sigue, se le obliga. Antes de cada señal se comprueba la ruta otra vez.
        for (signal, seconds) in [(libc::SIGTERM, 3), (libc::SIGKILL, 2)] {
            if !ours(pid, roots) { return true; }
            unsafe { libc::kill(pid as i32, signal) };
            let deadline = Instant::now() + Duration::from_secs(seconds);
            while ours(pid, roots) && Instant::now() < deadline { std::thread::sleep(Duration::from_millis(50)); }
        }
        !ours(pid, roots)
    }
}

#[cfg(not(any(windows, target_os = "linux")))]
mod system {
    use std::path::PathBuf;
    pub(super) fn list() -> Vec<(u32, PathBuf)> { Vec::new() }
    pub(super) fn stop(_pid: u32, _roots: &[PathBuf]) -> bool { false }
}

fn running(roots: &[PathBuf]) -> bool {
    system::list().iter().any(|(_, exe)| owned(exe, roots))
}

/// Para los procesos verificados por su ruta y devuelve cuántos terminaron.
fn stop(roots: &[PathBuf]) -> usize {
    system::list().into_iter().filter(|(_, exe)| owned(exe, roots)).filter(|(pid, _)| system::stop(*pid, roots)).count()
}

fn standalone_uninstaller(dir: &Path) -> Option<PathBuf> {
    let path = dir.join(UNINSTALLER);
    fs::symlink_metadata(&path).ok().filter(|meta| meta.is_file() && !link(meta)).map(|_| path)
}

fn inspect(places: &Places) -> LegacyBrowser {
    let items: Vec<LegacyItem> = places.candidates().into_iter().filter_map(|(label, path)| {
        // Un enlace en el sitio de una carpeta conocida no es suyo: ni se cuenta ni se borra.
        let meta = fs::symlink_metadata(&path).ok().filter(|meta| !link(meta))?;
        Some(LegacyItem { label: label.into(), bytes: size(&path, &meta, 0), path: path.to_string_lossy().into_owned() })
    }).collect();
    LegacyBrowser {
        found: !items.is_empty(),
        bytes: items.iter().map(|item| item.bytes).sum(),
        running: running(&places.process_roots()),
        items,
        standalone_uninstaller: places.standalone.as_deref().and_then(standalone_uninstaller)
            .map(|path| path.to_string_lossy().into_owned()),
    }
}

fn clean(places: &Places) -> LegacyBrowser {
    stop(&places.process_roots());
    // Un ejecutable recién parado (o que el antivirus aún lee) puede tardar un momento en soltarse.
    for attempt in 1..=3 {
        let mut done = true;
        for (_, path) in places.candidates() {
            let Ok(meta) = fs::symlink_metadata(&path) else { continue };
            if !link(&meta) && !remove_tree(&path, &meta, 0) {
                done = false;
                if attempt == 3 { eprintln!("trex: no se pudo borrar todo {}", path.display()); }
            }
        }
        if done || attempt == 3 { break; }
        std::thread::sleep(std::time::Duration::from_millis(300));
    }
    inspect(places)
}

/// Lo que queda del Trex Browser antiguo. Solo lee.
#[tauri::command]
pub async fn legacy_browser_status() -> Result<LegacyBrowser, String> {
    crate::blocking(|| Ok(inspect(&Places::current()))).await
}

/// Para el runtime viejo y borra sus datos y lo que quedó junto a trex. No toca
/// la instalación independiente. Devuelve el estado después de borrar: si algo
/// estaba en uso, sigue en `items`.
#[tauri::command]
pub async fn legacy_browser_remove() -> Result<LegacyBrowser, String> {
    crate::blocking(|| Ok(clean(&Places::current()))).await
}

/// Abre el desinstalador de la instalación independiente (solo Windows).
#[tauri::command]
pub async fn legacy_browser_uninstall_standalone() -> Result<(), String> {
    crate::blocking(|| {
        #[cfg(windows)]
        {
            let places = Places::current();
            let Some(dir) = places.standalone.clone() else {
                return Err("No hay ninguna instalación independiente de Trex Browser.".into());
            };
            let Some(uninstaller) = standalone_uninstaller(&dir) else {
                return Err("No se encontró el desinstalador de Trex Browser.".into());
            };
            // Su desinstalador se niega a seguir con archivos en uso: antes se paran sus procesos.
            stop(&Places { standalone: Some(dir), ..Places::default() }.process_roots());
            std::process::Command::new(&uninstaller).spawn()
                .map_err(|error| format!("No se pudo abrir el desinstalador de Trex Browser: {error}"))?;
            Ok(())
        }
        #[cfg(not(windows))]
        {
            Err("La instalación independiente de Trex Browser solo se desinstala desde trex en Windows. En Linux basta con borrar la carpeta ~/.local/share/trex-browser.".into())
        }
    }).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

    struct Scratch(PathBuf);
    impl Scratch {
        fn new(name: &str) -> Self {
            let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
            let dir = std::env::temp_dir().join(format!("trex-legacy-{name}-{}-{nanos}", std::process::id()));
            fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
    }
    impl Drop for Scratch {
        fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); }
    }

    fn write(path: &Path, bytes: usize) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, vec![b'x'; bytes]).unwrap();
    }

    fn places(root: &Path) -> Places {
        Places { home: Some(root.join("local/TrexBrowser")), electron: Some(root.join("roaming/Trex Browser")),
            app_dir: Some(root.join("app")), standalone: Some(root.join("programs/Trex Browser")), system: Vec::new() }
    }

    /// Un enlace a una carpeta: junction en Windows (no pide permisos), enlace simbólico en Unix.
    fn link_dir(link: &Path, target: &Path) {
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            // cmd tomaría «/linked» de `dir/linked` por una opción.
            let native = |path: &Path| path.to_string_lossy().replace('/', "\\");
            let status = std::process::Command::new("cmd").arg("/c").arg("mklink").arg("/J").arg(native(link)).arg(native(target))
                .creation_flags(0x0800_0000).stdout(std::process::Stdio::null()).status().unwrap();
            assert!(status.success(), "mklink /J");
        }
        #[cfg(unix)]
        std::os::unix::fs::symlink(target, link).unwrap();
    }

    #[test]
    fn lists_only_what_exists_with_its_size() {
        let scratch = Scratch::new("list");
        let places = places(&scratch.0);
        let empty = inspect(&places);
        assert_eq!(empty, LegacyBrowser { found: false, bytes: 0, running: false, items: vec![], standalone_uninstaller: None });
        let home = places.home.clone().unwrap();
        let app = places.app_dir.clone().unwrap();
        write(&home.join("projects/0123456789abcdef01234567/BROWSER1/user-data/Default/Cookies"), 100);
        write(&home.join("broker.json"), 20);
        write(&app.join(RUNTIME).join("worker.mjs"), 5);
        write(&app.join("trex-browser.payload"), 7);
        write(&app.join("trex.exe"), 1000);
        let status = inspect(&places);
        assert!(status.found && !status.running);
        assert_eq!(status.bytes, 132, "trex.exe is not part of it");
        let summary: Vec<(&str, u64)> = status.items.iter().map(|item| (item.label.as_str(), item.bytes)).collect();
        assert_eq!(summary, [("Perfiles y sesiones de los agentes", 120), ("Runtime junto a trex", 5), ("Restos de una instalación anterior", 7)]);
        assert_eq!(status.items[0].path, home.to_string_lossy());
        let json = serde_json::to_value(&status).unwrap();
        assert!(json.get("standaloneUninstaller").is_some() && json["items"][0]["bytes"] == 120);
    }

    #[test]
    fn removing_keeps_trex_and_reports_what_is_left() {
        let scratch = Scratch::new("remove");
        let places = places(&scratch.0);
        let app = places.app_dir.clone().unwrap();
        write(&places.home.clone().unwrap().join("personal/user-data/Default/Login Data"), 10);
        write(&places.electron.clone().unwrap().join("Crashpad/settings.dat"), 10);
        write(&app.join(RUNTIME).join("node_modules/playwright/package.json"), 10);
        write(&app.join(LAUNCHER), 10);
        write(&app.join("trex-browser-runtime.payload/node.exe"), 10);
        for keep in ["trex.exe", "trex-agent.exe", "uninstall.exe", "trex-browser-runtime-notes/readme.txt"] { write(&app.join(keep), 3); }
        let after = clean(&places);
        assert_eq!(after, LegacyBrowser { found: false, bytes: 0, running: false, items: vec![], standalone_uninstaller: None });
        for keep in ["trex.exe", "trex-agent.exe", "uninstall.exe", "trex-browser-runtime-notes/readme.txt"] { assert!(app.join(keep).is_file(), "{keep}"); }
        assert!(!places.home.clone().unwrap().exists() && !places.electron.clone().unwrap().exists());
    }

    #[test]
    fn removing_never_follows_links_inside_or_in_place_of_a_known_folder() {
        let scratch = Scratch::new("links");
        let places = places(&scratch.0);
        let outside = scratch.0.join("outside");
        write(&outside.join("secret.txt"), 4);
        let home = places.home.clone().unwrap();
        write(&home.join("projects/state.json"), 4);
        link_dir(&home.join("projects/linked"), &outside);
        #[cfg(unix)]
        std::os::unix::fs::symlink(outside.join("secret.txt"), home.join("file-link")).unwrap();
        // The Electron folder itself is a link: not listed, not removed, its target untouched.
        let electron = places.electron.clone().unwrap();
        fs::create_dir_all(electron.parent().unwrap()).unwrap();
        link_dir(&electron, &outside);
        let status = inspect(&places);
        assert_eq!(status.items.len(), 1);
        assert_eq!(status.bytes, 4, "the linked secret is not counted");
        let after = clean(&places);
        assert!(!after.found);
        assert!(!home.exists());
        assert!(outside.join("secret.txt").is_file(), "the target of a link survives");
        assert!(fs::symlink_metadata(&electron).is_ok_and(|meta| link(&meta)), "a link in place of a known folder is left alone");
    }

    #[test]
    fn only_executables_inside_the_old_folders_are_owned() {
        let base = if cfg!(windows) { PathBuf::from(r"C:\Users\Ana\AppData\Local\trex") } else { PathBuf::from("/home/ana/.local/share/trex") };
        let places = Places { app_dir: Some(base.clone()), ..Places::default() };
        let roots = places.process_roots();
        let runtime = base.join(RUNTIME);
        assert!(owned(&runtime.join("node.exe"), &roots));
        assert!(owned(&runtime.join("shell").join("trex-browser-shell.exe"), &roots));
        assert!(owned(&base.join(LAUNCHER), &roots));
        for outside in [base.join("trex.exe"), base.join("trex-agent.exe"), base.join("trex-browser-runtime2").join("node.exe"),
            base.join("trex-browser-runtime.payload").join("node.exe"), base.join(format!("{LAUNCHER}.previous")),
            runtime.join("..").join("trex.exe"), PathBuf::from("node.exe"), PathBuf::from("trex-browser-runtime/node.exe")] {
            assert!(!owned(&outside, &roots), "{}", outside.display());
        }
        #[cfg(windows)]
        {
            assert!(owned(Path::new(r"c:\users\ana\appdata\local\TREX\Trex-Browser-Runtime\node.exe"), &roots));
            assert!(owned(Path::new(r"\\?\C:\Users\Ana\AppData\Local\trex\trex-browser-runtime\node.exe"), &roots));
        }
        assert!(!owned(&runtime.join("node.exe"), &[]));
    }

    #[test]
    fn the_standalone_uninstaller_must_be_a_real_file() {
        let scratch = Scratch::new("standalone");
        let places = places(&scratch.0);
        let dir = places.standalone.clone().unwrap();
        assert_eq!(inspect(&places).standalone_uninstaller, None);
        fs::create_dir_all(dir.join(UNINSTALLER)).unwrap();
        assert_eq!(standalone_uninstaller(&dir), None, "a folder with that name is not an uninstaller");
        fs::remove_dir(dir.join(UNINSTALLER)).unwrap();
        write(&dir.join(UNINSTALLER), 8);
        let status = inspect(&places);
        assert_eq!(status.standalone_uninstaller, Some(dir.join(UNINSTALLER).to_string_lossy().into_owned()));
        assert!(!status.found, "the standalone installation is not removed from here");
        clean(&places);
        assert!(dir.join(UNINSTALLER).is_file());
    }

    /// Copia un programa del sistema que se queda esperando y lo lanza desde `dir`.
    fn waiting_copy(dir: &Path) -> Option<std::process::Child> {
        fs::create_dir_all(dir).ok()?;
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            let system = PathBuf::from(std::env::var_os("SystemRoot")?).join("System32").join("cmd.exe");
            let copy = dir.join("node.exe");
            fs::copy(system, &copy).ok()?;
            // Con la entrada abierta y sin escribir nada, `cmd /k` espera.
            std::process::Command::new(copy).args(["/d", "/q", "/k"]).creation_flags(0x0800_0000)
                .stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).spawn().ok()
        }
        #[cfg(target_os = "linux")]
        {
            use std::os::unix::fs::PermissionsExt;
            let copy = dir.join("sleep");
            fs::copy("/usr/bin/sleep", &copy).or_else(|_| fs::copy("/bin/sleep", &copy)).ok()?;
            fs::set_permissions(&copy, fs::Permissions::from_mode(0o755)).ok()?;
            // Si /tmp no deja ejecutar, la prueba no aplica.
            std::process::Command::new(copy).arg("60").stdout(std::process::Stdio::null()).spawn().ok()
        }
        #[cfg(not(any(windows, target_os = "linux")))]
        {
            let _ = dir;
            None
        }
    }

    fn exits_within(child: &mut std::process::Child, limit: Duration) -> bool {
        let started = Instant::now();
        while started.elapsed() < limit {
            if child.try_wait().unwrap().is_some() { return true; }
            std::thread::sleep(Duration::from_millis(50));
        }
        false
    }

    #[test]
    fn removing_stops_only_processes_started_from_the_old_runtime() {
        let scratch = Scratch::new("processes");
        let places = places(&scratch.0);
        let app = places.app_dir.clone().unwrap();
        // On Windows a copy of cmd.exe always starts; elsewhere /tmp may forbid running programs.
        let Some(mut inside) = waiting_copy(&app.join(RUNTIME)) else { assert!(!cfg!(windows)); return };
        // Same program, a folder whose name only starts like the runtime's.
        let Some(mut outside) = waiting_copy(&app.join("trex-browser-runtime-old")) else { let _ = inside.kill(); assert!(!cfg!(windows)); return };
        let deadline = Instant::now() + Duration::from_secs(5);
        while !inspect(&places).running && Instant::now() < deadline { std::thread::sleep(Duration::from_millis(50)); }
        assert!(inspect(&places).running, "the copy inside the runtime is seen");
        let after = clean(&places);
        assert!(exits_within(&mut inside, Duration::from_secs(5)), "the old runtime's process was stopped");
        assert!(!exits_within(&mut outside, Duration::from_millis(300)), "a process outside the old folders keeps running");
        assert!(!after.running && !after.found, "{after:?}");
        assert!(app.join("trex-browser-runtime-old").is_dir());
        let _ = outside.kill();
        let _ = outside.wait();
    }

    #[test]
    fn a_link_in_place_of_the_runtime_does_not_lead_to_stopping_what_runs_at_its_target() {
        let scratch = Scratch::new("runtime-link");
        let elsewhere = scratch.0.join("elsewhere");
        let Some(mut running) = waiting_copy(&elsewhere) else { assert!(!cfg!(windows)); return };
        let places = Places { app_dir: Some(scratch.0.join("app")), ..Places::default() };
        fs::create_dir_all(scratch.0.join("app")).unwrap();
        link_dir(&scratch.0.join("app").join(RUNTIME), &elsewhere);
        let after = clean(&places);
        assert!(!after.running && !after.found);
        assert!(!exits_within(&mut running, Duration::from_millis(300)), "the program at the link's target keeps running");
        assert!(fs::symlink_metadata(scratch.0.join("app").join(RUNTIME)).is_ok_and(|meta| link(&meta)));
        let _ = running.kill();
        let _ = running.wait();
    }
}
