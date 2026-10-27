//! Only paths observed on an owned agent's protocol stream can be read by the UI.
use serde::Serialize;
use serde_json::Value;
use std::{
    collections::HashMap,
    fs,
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    sync::Mutex,
};

const LIMIT: usize = 64 * 1024;
pub struct TerminalLogs {
    paths: Mutex<HashMap<String, PathBuf>>,
    root: PathBuf,
    alias: PathBuf,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Output {
    pub text: String,
    pub truncated: bool,
    pub available: bool,
}
impl TerminalLogs {
    pub fn new(root: PathBuf) -> Self {
        Self {
            paths: Mutex::new(HashMap::new()),
            alias: root.clone(),
            root: root.canonicalize().unwrap_or(root),
        }
    }
    fn register(&self, id: &str, path: &str) {
        if id.is_empty()
            || id.len() > 128
            || !id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"-_".contains(&b))
        {
            return;
        }
        let path = Path::new(path);
        if !path.is_absolute()
            || path
                .components()
                .any(|c| matches!(c, std::path::Component::ParentDir))
        {
            return;
        }
        let relative = path
            .strip_prefix(&self.alias)
            .or_else(|_| path.strip_prefix(&self.root));
        #[cfg(windows)]
        let plain_root = PathBuf::from(self.root.to_string_lossy().trim_start_matches("\\\\?\\"));
        #[cfg(windows)]
        let relative = relative.or_else(|_| path.strip_prefix(&plain_root));
        let Ok(relative) = relative else {
            return;
        };
        let path = self.root.join(relative);
        if path.file_name().and_then(|n| n.to_str()) != Some(format!("{id}.output").as_str()) {
            return;
        }
        if let Ok(mut paths) = self.paths.lock() {
            if paths.len() < 256 || paths.contains_key(id) {
                paths.insert(id.into(), path);
            }
        }
    }
    pub fn observe(&self, line: &str) {
        if !line.contains("output_file")
            && !line.contains("outputFile")
            && !line.contains("Output is being written to:")
        {
            return;
        }
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            return;
        };
        let track = |v: &Value| {
            let id = v["task_id"]
                .as_str()
                .or_else(|| v["taskId"].as_str())
                .or_else(|| v["backgroundTaskId"].as_str())
                .or_else(|| v["id"].as_str());
            let path = v["output_file"]
                .as_str()
                .or_else(|| v["outputFilePath"].as_str())
                .or_else(|| v["outputFile"].as_str())
                .or_else(|| {
                    id.and_then(|id| {
                        v["stdout"]
                            .as_str()
                            .and_then(|text| description_path(id, text))
                    })
                });
            if let (Some(id), Some(path)) = (id, path) {
                self.register(id, path);
            }
        };
        if value["type"] == "system" {
            track(&value);
            if let Some(tasks) = value["tasks"].as_array() {
                for task in tasks {
                    track(task);
                }
            }
        }
        if value["type"] == "user" {
            track(&value["tool_use_result"]);
            if let Some(id) = value["tool_use_result"]["backgroundTaskId"].as_str() {
                if let Some(blocks) = value["message"]["content"].as_array() {
                    for block in blocks {
                        if block["type"] != "tool_result" {
                            continue;
                        }
                        let text = block["content"].as_str().unwrap_or("");
                        if let Some(path) = description_path(id, text) {
                            self.register(id, path);
                        }
                        if let Some(parts) = block["content"].as_array() {
                            for part in parts {
                                if let Some(path) = part["text"]
                                    .as_str()
                                    .and_then(|text| description_path(id, text))
                                {
                                    self.register(id, path);
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    pub fn read(&self, id: &str) -> Result<Output, String> {
        let path = self
            .paths
            .lock()
            .map_err(|_| "No se pudo consultar la salida.")?
            .get(id)
            .cloned();
        let Some(path) = path else {
            return Ok(Output {
                text: String::new(),
                truncated: false,
                available: false,
            });
        };
        for ancestor in path.ancestors() {
            let meta = fs::symlink_metadata(ancestor)
                .map_err(|_| "La salida de la terminal aún no está disponible.")?;
            if meta.file_type().is_symlink() {
                return Err("La salida de la terminal no puede ser un enlace.".into());
            }
            #[cfg(windows)]
            {
                use std::os::windows::fs::MetadataExt;
                if meta.file_attributes() & 0x400 != 0 {
                    return Err("La salida de la terminal no puede atravesar enlaces.".into());
                }
            }
        }
        let meta =
            fs::metadata(&path).map_err(|_| "No se pudo consultar la salida de la terminal.")?;
        if !meta.is_file() {
            return Err("La salida de la terminal no es un archivo.".into());
        }
        let mut file =
            fs::File::open(&path).map_err(|_| "No se pudo leer la salida de la terminal.")?;
        verify_opened_file(&file, &path)?;
        let length = file
            .metadata()
            .map_err(|_| "No se pudo consultar la salida.")?
            .len();
        file.seek(SeekFrom::Start(length.saturating_sub(LIMIT as u64)))
            .map_err(|_| "No se pudo leer la salida.")?;
        let mut bytes = Vec::new();
        file.take(LIMIT as u64)
            .read_to_end(&mut bytes)
            .map_err(|_| "No se pudo leer la salida.")?;
        Ok(Output {
            text: String::from_utf8_lossy(&bytes).into_owned(),
            truncated: length > LIMIT as u64,
            available: true,
        })
    }
}

fn description_path<'a>(id: &str, text: &'a str) -> Option<&'a str> {
    let (_, path) = text.split_once("Output is being written to: ")?;
    let filename = format!("{id}.output");
    Some(path.get(..path.find(&filename)? + filename.len())?.trim())
}

// Validate the opened handle itself: pathname checks alone do not survive a
// rename/junction swap between checking the path and opening the file.
#[cfg(windows)]
fn verify_opened_file(file: &fs::File, expected: &Path) -> Result<(), String> {
    use std::{
        ffi::c_void,
        os::windows::{
            ffi::{OsStrExt, OsStringExt},
            io::AsRawHandle,
        },
    };
    #[repr(C)]
    #[derive(Default)]
    struct Info {
        attrs: u32,
        created: [u32; 2],
        accessed: [u32; 2],
        written: [u32; 2],
        volume: u32,
        high: u32,
        low: u32,
        links: u32,
        index_high: u32,
        index_low: u32,
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetFinalPathNameByHandleW(
            file: *mut c_void,
            path: *mut u16,
            size: u32,
            flags: u32,
        ) -> u32;
        fn GetFileInformationByHandle(file: *mut c_void, info: *mut Info) -> i32;
        fn GetLongPathNameW(path: *const u16, output: *mut u16, size: u32) -> u32;
    }
    let mut info = Info::default();
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0
        || info.links != 1
        || info.attrs & (0x400 | 0x10) != 0
    {
        return Err("La salida debe ser un archivo regular sin enlaces.".into());
    }
    let mut buffer = vec![0u16; 32768];
    let length = unsafe {
        GetFinalPathNameByHandleW(
            file.as_raw_handle(),
            buffer.as_mut_ptr(),
            buffer.len() as u32,
            0,
        )
    } as usize;
    if length == 0 || length >= buffer.len() {
        return Err("No se pudo verificar la salida.".into());
    }
    let actual = std::ffi::OsString::from_wide(&buffer[..length])
        .to_string_lossy()
        .into_owned();
    let expected = expected.to_string_lossy().replace('/', "\\");
    let encoded: Vec<u16> = std::ffi::OsStr::new(&expected)
        .encode_wide()
        .chain(Some(0))
        .collect();
    let mut expanded = vec![0u16; 32768];
    let expanded_length = unsafe {
        GetLongPathNameW(
            encoded.as_ptr(),
            expanded.as_mut_ptr(),
            expanded.len() as u32,
        )
    } as usize;
    if expanded_length == 0 || expanded_length >= expanded.len() {
        return Err("No se pudo verificar la ruta de la salida.".into());
    }
    let expected = std::ffi::OsString::from_wide(&expanded[..expanded_length])
        .to_string_lossy()
        .into_owned();
    if !actual
        .trim_start_matches("\\\\?\\")
        .eq_ignore_ascii_case(expected.trim_start_matches("\\\\?\\"))
    {
        return Err("La ruta de la salida cambió; vuelve a consultar la terminal.".into());
    }
    Ok(())
}
#[cfg(unix)]
fn verify_opened_file(file: &fs::File, expected: &Path) -> Result<(), String> {
    use std::os::unix::{fs::MetadataExt, io::AsRawFd};
    let meta = file
        .metadata()
        .map_err(|_| "No se pudo verificar la salida.")?;
    if !meta.is_file() || meta.nlink() != 1 {
        return Err("La salida debe ser un archivo regular sin enlaces.".into());
    }
    #[cfg(target_os = "linux")]
    {
        let actual = fs::read_link(format!("/proc/self/fd/{}", file.as_raw_fd()))
            .map_err(|_| "No se pudo verificar la salida.")?;
        if actual != expected {
            return Err("La ruta de la salida cambió; vuelve a consultar la terminal.".into());
        }
    }
    #[cfg(target_os = "macos")]
    {
        let mut path = vec![0u8; 1024];
        if unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GETPATH, path.as_mut_ptr()) } < 0 {
            return Err("No se pudo verificar la salida.".into());
        }
        let length = path.iter().position(|b| *b == 0).unwrap_or(path.len());
        use std::os::unix::ffi::OsStrExt;
        if Path::new(std::ffi::OsStr::from_bytes(&path[..length])) != expected {
            return Err("La ruta de la salida cambió; vuelve a consultar la terminal.".into());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_owned_observed_regular_outputs_are_available_and_bounded() {
        let root = std::env::temp_dir().join(format!(
            "trex-terminal-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&root).unwrap();
        let registry = TerminalLogs::new(root.clone());
        let path = root.join("task-1.output");
        fs::write(&path, vec![b'x'; LIMIT + 100]).unwrap();
        assert!(!registry.read("task-1").unwrap().available);
        registry.observe(&serde_json::json!({"type":"system","subtype":"task_started","task_id":"task-1","output_file":path}).to_string());
        let output = registry.read("task-1").unwrap();
        assert!(output.available && output.truncated);
        assert_eq!(output.text.len(), LIMIT);
        registry.register("unrelated", path.to_str().unwrap());
        assert!(!registry.read("unrelated").unwrap().available);
        registry.register(
            "task-2",
            root.parent()
                .unwrap()
                .join("task-2.output")
                .to_str()
                .unwrap(),
        );
        assert!(!registry.read("task-2").unwrap().available);
        let outside = root.join("outside-fixture.txt");
        let linked = root.join("linked.output");
        fs::write(&outside, "private fixture").unwrap();
        fs::hard_link(&outside, &linked).unwrap();
        registry.register("linked", linked.to_str().unwrap());
        assert!(registry.read("linked").is_err());
        fs::remove_file(linked).unwrap();
        fs::remove_file(outside).unwrap();
        let announced = root.join("task-3.output");
        fs::write(&announced, "live output").unwrap();
        registry.observe(&serde_json::json!({"type":"user","tool_use_result":{"backgroundTaskId":"task-3"},"message":{"content":[{"type":"tool_result","content":format!("Command running in background with ID: task-3. Output is being written to: {}. You will be notified when it completes.",announced.display())}]}}).to_string());
        assert_eq!(registry.read("task-3").unwrap().text, "live output");
        fs::remove_file(announced).unwrap();
        fs::remove_file(path).unwrap();
        fs::remove_dir(root).unwrap();
    }
}
