//! Cerebro del modo llamada: convierte una orden hablada en una respuesta y acciones.
//!
//! Llama a Claude Code sin interfaz (`claude -p`, modelo Haiku), sin herramientas
//! y con salida estructurada. Usa la sesión de Claude que la persona ya tiene
//! iniciada; no hay claves propias ni otra red. Qué acciones existen y cómo se
//! ejecutan lo decide el frontend (`src/voiceBrain.ts`): aquí solo se pregunta.
use serde_json::Value;
use std::io::{Read, Write};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const MAX_PROMPT: usize = 200 * 1024;
const MAX_SYSTEM: usize = 16 * 1024;
const MAX_SCHEMA: usize = 16 * 1024;
const THINK_TIMEOUT: Duration = Duration::from_secs(90);

fn think(program: &str, system: &str, prompt: &str, schema: &str) -> Result<Value, String> {
    let mut command = Command::new(program);
    command
        .args(["-p", "--model", "haiku", "--effort", "low", "--output-format", "json"])
        .args(["--no-session-persistence", "--strict-mcp-config", "--tools", ""])
        .args(["--json-schema", schema, "--system-prompt", system])
        // Fuera de cualquier proyecto: no debe leer CLAUDE.md ni ajustes de un repositorio.
        .current_dir(std::env::temp_dir())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let mut child = command.spawn().map_err(|error| format!("No se pudo ejecutar Claude Code: {error}"))?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(prompt.as_bytes()).map_err(|e| e.to_string())?;
    }
    // Las tuberías se leen en hilos aparte para que una respuesta larga no bloquee la espera.
    let mut stdout = child.stdout.take().ok_or("No se pudo leer la respuesta de Claude Code.")?;
    let mut stderr = child.stderr.take().ok_or("No se pudieron leer los errores de Claude Code.")?;
    let output_reader = std::thread::spawn(move || { let mut bytes = Vec::new(); stdout.read_to_end(&mut bytes).map(|_| bytes) });
    let error_reader = std::thread::spawn(move || { let mut bytes = Vec::new(); stderr.read_to_end(&mut bytes).map(|_| bytes) });
    let start = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if start.elapsed() < THINK_TIMEOUT => std::thread::sleep(Duration::from_millis(50)),
            result => {
                // Sin respuesta a tiempo: se termina el proceso para no dejar la llamada colgada.
                let _ = child.kill();
                let _ = child.wait();
                return Err(match result {
                    Err(error) => format!("No se pudo esperar a Claude Code: {error}"),
                    _ => "Claude Code tardó demasiado en responder.".into(),
                });
            }
        }
    };
    let stdout = output_reader.join().map_err(|_| "No se pudo leer la respuesta de Claude Code.")?.map_err(|e| e.to_string())?;
    let stderr = error_reader.join().map_err(|_| "No se pudieron leer los errores de Claude Code.")?.map_err(|e| e.to_string())?;
    if !status.success() {
        // Con --output-format json el motivo del fallo suele venir en la propia respuesta.
        if let Err(error) = parse_reply(&String::from_utf8_lossy(&stdout)) {
            if error.starts_with("Claude Code falló") { return Err(error); }
        }
        let detail: String = String::from_utf8_lossy(&stderr).trim().chars().take(300).collect();
        return Err(if detail.is_empty() { "Claude Code terminó con un error.".into() } else { format!("Claude Code falló: {detail}") });
    }
    parse_reply(&String::from_utf8_lossy(&stdout))
}

/// La respuesta estructurada viene en `structured_output`; en versiones que no lo
/// traen, `result` es el mismo JSON como texto.
fn parse_reply(stdout: &str) -> Result<Value, String> {
    let envelope: Value = serde_json::from_str(stdout.trim()).map_err(|_| "Claude Code devolvió una respuesta que no se entiende.".to_string())?;
    if envelope["is_error"] == true {
        let detail: String = envelope["result"].as_str().unwrap_or_default().chars().take(300).collect();
        return Err(format!("Claude Code falló: {detail}"));
    }
    if envelope["structured_output"].is_object() {
        return Ok(envelope["structured_output"].clone());
    }
    let text = envelope["result"].as_str().unwrap_or_default().trim();
    let text = text.strip_prefix("```json").or_else(|| text.strip_prefix("```")).unwrap_or(text);
    let text = text.strip_suffix("```").unwrap_or(text).trim();
    serde_json::from_str::<Value>(text).ok().filter(Value::is_object)
        .ok_or_else(|| "Claude Code no devolvió una respuesta estructurada.".to_string())
}

#[tauri::command]
pub async fn voice_think(system: String, prompt: String, schema: String) -> Result<Value, String> {
    if prompt.len() > MAX_PROMPT || system.len() > MAX_SYSTEM || schema.len() > MAX_SCHEMA {
        return Err("La orden es demasiado larga para procesarla.".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let claude = crate::pty::detect_claude();
        let program = claude.path.filter(|_| claude.found)
            .ok_or("No se encontró Claude Code: el modo llamada lo necesita para entender las órdenes.")?;
        think(&program, &system, &prompt, &schema)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Commits de un proyecto desde hace `hours` horas, para el resumen hablado.
#[tauri::command]
pub async fn voice_recent_commits(cwd: String, hours: u32) -> Result<Vec<String>, String> {
    let hours = hours.clamp(1, 24 * 14);
    tauri::async_runtime::spawn_blocking(move || Ok(crate::git::recent_commits(&cwd, hours)))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::parse_reply;
    use serde_json::json;

    #[test]
    fn reads_the_structured_output() {
        let reply = parse_reply(r#"{"is_error":false,"result":"","structured_output":{"say":"Hecho","actions":[]}}"#).unwrap();
        assert_eq!(reply, json!({ "say": "Hecho", "actions": [] }));
    }

    #[test]
    fn falls_back_to_json_inside_the_result_text() {
        let reply = parse_reply("{\"result\":\"```json\\n{\\\"say\\\":\\\"Hola\\\",\\\"actions\\\":[]}\\n```\"}").unwrap();
        assert_eq!(reply["say"], "Hola");
    }

    #[test]
    fn rejects_errors_and_plain_text() {
        assert!(parse_reply(r#"{"is_error":true,"result":"Not logged in"}"#).unwrap_err().contains("Not logged in"));
        assert!(parse_reply(r#"{"result":"no es json"}"#).is_err());
        assert!(parse_reply("basura").is_err());
    }
}
