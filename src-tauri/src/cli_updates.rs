//! Actualización de Claude Code y Codex con su propio comando (`claude update`,
//! `codex update`). La ventana compara versiones con el registro de npm; aquí
//! solo se lee el canal elegido en Claude Code y se ejecuta la actualización.
use std::io::Read;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use crate::pty::{enriched_path, home_dir, is_windows};

/// Una actualización descarga el CLI entero; con una red lenta puede tardar.
const UPDATE_TIMEOUT: Duration = Duration::from_secs(10 * 60);
/// Líneas finales de la salida que se devuelven a la ventana.
const OUTPUT_LINES: usize = 12;

/// Canal de Claude Code (`latest` o `stable`) según `autoUpdatesChannel` de sus ajustes.
pub(crate) fn claude_channel(settings: &str) -> &'static str {
    let channel = serde_json::from_str::<serde_json::Value>(settings)
        .ok()
        .and_then(|value| value.get("autoUpdatesChannel")?.as_str().map(str::to_ascii_lowercase));
    if channel.as_deref() == Some("stable") { "stable" } else { "latest" }
}

#[tauri::command]
pub async fn claude_update_channel(config_dir: Option<String>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = config_dir
            .filter(|dir| !dir.trim().is_empty())
            .map(|dir| crate::pty::expand_config_dir(&dir))
            .or_else(|| std::env::var("CLAUDE_CONFIG_DIR").ok().filter(|dir| !dir.trim().is_empty()))
            .or_else(|| home_dir().map(|home| std::path::Path::new(&home).join(".claude").to_string_lossy().into_owned()));
        let settings = dir
            .and_then(|dir| std::fs::read_to_string(std::path::Path::new(&dir).join("settings.json")).ok())
            .unwrap_or_default();
        claude_channel(&settings).to_string()
    })
    .await
    .map_err(|e| e.to_string())
}

/// Quita los códigos de color y de cursor que algunos CLI escriben aunque no haya terminal.
pub(crate) fn plain_output(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            if chars.peek() == Some(&'[') {
                chars.next();
                while let Some(&next) = chars.peek() {
                    chars.next();
                    if ('@'..='~').contains(&next) { break; }
                }
            } else {
                chars.next();
            }
            continue;
        }
        if c == '\r' { out.push('\n'); continue; }
        if c.is_control() && c != '\n' && c != '\t' { continue; }
        out.push(c);
    }
    let lines: Vec<&str> = out.lines().map(str::trim_end).filter(|line| !line.trim().is_empty()).collect();
    lines[lines.len().saturating_sub(OUTPUT_LINES)..].join("\n")
}

fn update_command(path: &str) -> Command {
    let mut cmd = if is_windows() && [".cmd", ".bat"].iter().any(|ext| path.to_ascii_lowercase().ends_with(ext)) {
        let mut c = Command::new("cmd.exe");
        c.arg("/D").arg("/C").arg(path).arg("update");
        c
    } else {
        let mut c = Command::new(path);
        c.arg("update");
        c
    };
    if let Some(path) = enriched_path() {
        cmd.env("PATH", path);
    }
    // Sin terminal: nada de colores ni de preguntas interactivas.
    cmd.env("NO_COLOR", "1").env("CI", "1");
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd
}

fn run_update(path: &str) -> Result<String, String> {
    if !std::path::Path::new(path).is_file() {
        return Err(format!("No se encontró «{path}»."));
    }
    let mut child = update_command(path).spawn().map_err(|e| format!("No se pudo iniciar la actualización: {e}"))?;
    let readers: Vec<_> = [child.stdout.take().map(|s| Box::new(s) as Box<dyn Read + Send>), child.stderr.take().map(|s| Box::new(s) as Box<dyn Read + Send>)]
        .into_iter()
        .flatten()
        .map(|mut stream| std::thread::spawn(move || {
            let mut bytes = Vec::new();
            let _ = stream.read_to_end(&mut bytes);
            bytes
        }))
        .collect();
    let start = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if start.elapsed() < UPDATE_TIMEOUT => std::thread::sleep(Duration::from_millis(200)),
            Ok(None) => {
                let _ = child.kill();
                return Err("La actualización tardó demasiado y se canceló.".into());
            }
            Err(e) => return Err(format!("No se pudo seguir la actualización: {e}")),
        }
    };
    let mut bytes = Vec::new();
    for reader in readers {
        bytes.extend(reader.join().unwrap_or_default());
        bytes.push(b'\n');
    }
    let output = plain_output(&String::from_utf8_lossy(&bytes));
    if status.success() {
        Ok(output)
    } else if output.is_empty() {
        Err(format!("La actualización terminó con el código {}.", status.code().unwrap_or(-1)))
    } else {
        Err(output)
    }
}

/// Ejecuta `<cli> update` y devuelve las últimas líneas de su salida.
#[tauri::command]
pub async fn update_cli(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || run_update(&path))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_channel_follows_its_settings() {
        assert_eq!(claude_channel(r#"{"autoUpdatesChannel":"stable"}"#), "stable");
        assert_eq!(claude_channel(r#"{"autoUpdatesChannel":"latest"}"#), "latest");
        assert_eq!(claude_channel(r#"{"theme":"dark"}"#), "latest");
        assert_eq!(claude_channel("no es json"), "latest");
    }

    #[test]
    fn update_output_is_plain_text() {
        let raw = "\u{1b}[32mChecking for updates\u{1b}[0m\r\n\r\nUpdating 2.1.303 \u{2192} 2.1.304\u{1b}[2K\rDone\n";
        assert_eq!(plain_output(raw), "Checking for updates\nUpdating 2.1.303 \u{2192} 2.1.304\nDone");
        let long: String = (0..30).map(|n| format!("line {n}\n")).collect();
        assert_eq!(plain_output(&long).lines().count(), OUTPUT_LINES);
        assert!(plain_output(&long).ends_with("line 29"));
    }
}
