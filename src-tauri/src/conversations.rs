//! Recuperación local de conversaciones; no ejecuta los CLI ni envía mensajes.
use serde::Serialize;
use serde_json::Value;
use std::{
    collections::HashMap,
    fs,
    io::{BufRead, BufReader, Read},
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Conversation {
    pub id: String,
    pub provider: String,
    pub title: String,
    pub cwd: String,
    pub updated_at: u64,
}
pub fn valid_id(id: &str) -> bool {
    id.len() == 36
        && id.bytes().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                b == b'-'
            } else {
                b.is_ascii_hexdigit()
            }
        })
}
fn home() -> PathBuf {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .map(PathBuf::from)
        .unwrap_or_default()
}
pub(crate) fn root(provider: &str, dir: &str) -> PathBuf {
    if dir == "~" {
        return home();
    }
    if let Some(rest) = dir.strip_prefix("~/").or_else(|| dir.strip_prefix("~\\")) {
        return home().join(rest);
    }
    if !dir.trim().is_empty() {
        return PathBuf::from(dir);
    }
    let variable = if provider == "codex" {
        "CODEX_HOME"
    } else {
        "CLAUDE_CONFIG_DIR"
    };
    std::env::var_os(variable)
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            home().join(if provider == "codex" {
                ".codex"
            } else {
                ".claude"
            })
        })
}
fn same_path(a: &str, b: &str) -> bool {
    let normalize = |value: &str| {
        let path = value.replace('\\', "/").trim_end_matches('/').to_string();
        if cfg!(windows) {
            path.to_lowercase()
        } else {
            path
        }
    };
    normalize(a) == normalize(b)
}
fn clean_title(value: &str) -> String {
    value
        .chars()
        .filter(|c| !c.is_control())
        .take(160)
        .collect::<String>()
        .trim()
        .to_string()
}
fn files(dir: &Path, depth: usize, out: &mut Vec<(PathBuf, u64)>) {
    if depth > 4 || out.len() >= 20_000 {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if kind.is_symlink() {
            continue;
        }
        if kind.is_dir() && entry.file_name() != "subagents" {
            files(&entry.path(), depth + 1, out);
        } else if kind.is_file() && entry.path().extension().is_some_and(|ext| ext == "jsonl") {
            let modified = entry
                .metadata()
                .ok()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|t| t.as_millis() as u64)
                .unwrap_or(0);
            out.push((entry.path(), modified));
        }
        if out.len() >= 20_000 {
            break;
        }
    }
}
fn metadata(path: &Path, provider: &str, cwd: &str, updated_at: u64) -> Option<Conversation> {
    let reader = BufReader::new(fs::File::open(path).ok()?.take(512 * 1024));
    let mut id = String::new();
    let mut directory = String::new();
    let mut title = String::new();
    for line in reader.lines().take(80).flatten() {
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if provider == "codex" && value["type"] == "session_meta" {
            let payload = &value["payload"];
            id = payload["id"]
                .as_str()
                .or_else(|| payload["session_id"].as_str())
                .unwrap_or("")
                .to_string();
            directory = payload["cwd"].as_str().unwrap_or("").to_string();
            title = payload["title"]
                .as_str()
                .map(clean_title)
                .unwrap_or_default();
            break;
        }
        if provider == "claude" {
            if value["isSidechain"] == true {
                return None;
            }
            if directory.is_empty() {
                directory = value["cwd"].as_str().unwrap_or("").to_string();
            }
            if id.is_empty() {
                id = value["sessionId"].as_str().unwrap_or("").to_string();
            }
            if value["type"] == "custom-title" {
                title = value["customTitle"]
                    .as_str()
                    .map(clean_title)
                    .unwrap_or_default();
            }
            if value["type"] == "user" && title.is_empty() {
                let content = &value["message"]["content"];
                let text = content.as_str().or_else(|| {
                    content.as_array().and_then(|blocks| {
                        blocks.iter().find_map(|block| {
                            if block["type"] == "text" {
                                block["text"].as_str()
                            } else {
                                None
                            }
                        })
                    })
                });
                if let Some(text) = text.filter(|text| !text.starts_with('<')) {
                    title = clean_title(text);
                }
            }
            if !directory.is_empty() && !same_path(&directory, cwd) {
                return None;
            }
        }
    }
    if !valid_id(&id) || !same_path(&directory, cwd) {
        return None;
    }
    if title.is_empty() {
        title = format!("Conversación · {}", &id[..8]);
    }
    Some(Conversation {
        id,
        provider: provider.to_string(),
        title,
        cwd: directory,
        updated_at,
    })
}
pub fn list(provider: &str, config_dir: &str, cwd: &str) -> Result<Vec<Conversation>, String> {
    if !["claude", "codex"].contains(&provider) {
        return Err("Proveedor desconocido.".into());
    }
    if !Path::new(cwd).is_dir() {
        return Err("La carpeta del proyecto no existe.".into());
    }
    let root = root(provider, config_dir);
    let mut candidates = Vec::new();
    files(
        &root.join(if provider == "codex" {
            "sessions"
        } else {
            "projects"
        }),
        0,
        &mut candidates,
    );
    candidates.sort_by_key(|(_, time)| std::cmp::Reverse(*time));
    let mut titles = HashMap::new();
    if provider == "codex" {
        if let Ok(file) = fs::File::open(root.join("session_index.jsonl")) {
            for line in BufReader::new(file.take(4 * 1024 * 1024)).lines().flatten() {
                if let Ok(value) = serde_json::from_str::<Value>(&line) {
                    if let (Some(id), Some(name)) =
                        (value["id"].as_str(), value["thread_name"].as_str())
                    {
                        titles.insert(id.to_string(), clean_title(name));
                    }
                }
            }
        }
    }
    let mut sessions = HashMap::new();
    for (path, time) in candidates.into_iter().take(2000) {
        if let Some(mut conversation) = metadata(&path, provider, cwd, time) {
            if let Some(title) = titles.get(&conversation.id) {
                conversation.title = title.clone();
            }
            sessions
                .entry(conversation.id.clone())
                .or_insert(conversation);
        }
    }
    let mut result: Vec<_> = sessions.into_values().collect();
    result.sort_by_key(|item| std::cmp::Reverse(item.updated_at));
    result.truncate(100);
    Ok(result)
}
/// Texto máximo de cada resultado de herramienta al mostrar el historial.
const HISTORY_TEXT_LIMIT: usize = 30_000;
/// Mensajes más recientes que se devuelven de una conversación larga.
const HISTORY_ENTRIES: usize = 1_500;

fn truncate_text(value: &mut Value) {
    if let Some(text) = value.as_str() {
        if text.len() > HISTORY_TEXT_LIMIT {
            let cut: String = text.chars().take(HISTORY_TEXT_LIMIT).collect();
            *value = Value::String(format!("{cut}…"));
        }
    }
}

/// Deja solo lo que el chat necesita: sin imágenes en base64 ni archivos completos.
fn slim_entry(mut value: Value) -> Option<Value> {
    let kind = value["type"].as_str()?.to_string();
    if !["user", "assistant"].contains(&kind.as_str()) || value["isSidechain"] == true || value["isMeta"] == true {
        return None;
    }
    if let Some(blocks) = value["message"]["content"].as_array_mut() {
        for block in blocks.iter_mut() {
            if block["type"] == "image" {
                *block = serde_json::json!({ "type": "image" });
            } else if block["type"] == "tool_result" {
                truncate_text(&mut block["content"]);
                if let Some(parts) = block["content"].as_array_mut() {
                    for part in parts.iter_mut() {
                        if part["type"] == "image" { *part = serde_json::json!({ "type": "image" }); }
                        truncate_text(&mut part["text"]);
                    }
                }
            }
        }
    }
    let result = &value["toolUseResult"];
    let patch = result.get("structuredPatch").map(|patch| serde_json::json!({
        "filePath": result["filePath"], "structuredPatch": patch,
    }));
    Some(serde_json::json!({
        "type": kind,
        "uuid": value["uuid"],
        "timestamp": value["timestamp"],
        "message": value["message"].take(),
        "toolUseResult": patch,
    }))
}

/// Carpetas de cuenta de Claude Code donde buscar una conversación: la indicada y,
/// por si el lanzador elige otra por dentro, las demás `~/.claude*` del equipo
/// (los ids no se repiten entre cuentas).
fn claude_roots(config_dir: &str) -> Vec<PathBuf> {
    claude_roots_in(&home(), root("claude", config_dir))
}
fn claude_roots_in(home: &Path, first: PathBuf) -> Vec<PathBuf> {
    let mut roots = vec![first];
    if let Ok(entries) = fs::read_dir(home) {
        let mut others: Vec<PathBuf> = entries
            .flatten()
            .filter(|entry| entry.file_name().to_string_lossy().starts_with(".claude"))
            .map(|entry| entry.path())
            .filter(|path| path.join("projects").is_dir())
            .collect();
        others.sort();
        for path in others {
            if !roots.contains(&path) {
                roots.push(path);
            }
        }
    }
    roots
}

/// Mensajes de una conversación de Claude Code para mostrarla en el chat.
fn claude_path(config_dir: &str, id: &str) -> Result<PathBuf, String> {
    if !valid_id(id) {
        return Err("La conversación necesita un identificador válido.".into());
    }
    let file_name = format!("{id}.jsonl");
    claude_roots(config_dir)
        .into_iter()
        .filter_map(|root| fs::read_dir(root.join("projects")).ok())
        .flat_map(|entries| entries.flatten())
        .map(|entry| entry.path().join(&file_name))
        .find(|path| path.is_file())
        .ok_or_else(|| "No se encontró esta conversación en el equipo.".to_string())
}

pub fn history(config_dir: &str, id: &str) -> Result<Vec<Value>, String> {
    let path = claude_path(config_dir, id)?;
    let file = fs::File::open(&path).map_err(|e| format!("No se pudo abrir el historial: {e}"))?;
    let mut entries: Vec<Value> = BufReader::new(file.take(96 * 1024 * 1024))
        .lines()
        .map_while(Result::ok)
        .filter_map(|line| serde_json::from_str::<Value>(&line).ok())
        .filter_map(slim_entry)
        .collect();
    if entries.len() > HISTORY_ENTRIES {
        entries.drain(..entries.len() - HISTORY_ENTRIES);
    }
    Ok(entries)
}

/// Punto anterior al mensaje que se sustituye. Solo lee el historial; nunca lo modifica.
fn rewind_point(path: &Path, message_id: &str) -> Result<Option<String>, String> {
    if !valid_id(message_id) { return Err("El mensaje necesita un identificador válido.".into()); }
    let file = fs::File::open(path).map_err(|e| format!("No se pudo abrir la conversación: {e}"))?;
    for line in BufReader::new(file.take(96 * 1024 * 1024)).lines() {
        let line = line.map_err(|e| e.to_string())?;
        let Ok(entry) = serde_json::from_str::<Value>(&line) else { continue };
        if entry["uuid"].as_str() != Some(message_id) || entry["type"] != "user" { continue; }
        if entry["isSidechain"] == true { continue; }
        return match &entry["parentUuid"] {
            Value::Null => Ok(None),
            Value::String(parent) if valid_id(parent) => Ok(Some(parent.clone())),
            _ => Err("El mensaje no tiene un punto de reanudación válido.".into()),
        };
    }
    Err("No se encontró el mensaje original en la conversación. Intenta reabrirla.".into())
}

#[tauri::command]
pub async fn claude_rewind_point(config_dir: String, id: String, message_id: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || rewind_point(&claude_path(&config_dir, &id)?, &message_id))
        .await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn read_conversation(config_dir: String, id: String) -> Result<Vec<Value>, String> {
    tauri::async_runtime::spawn_blocking(move || history(&config_dir, &id))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn list_conversations(
    provider: String,
    config_dir: String,
    cwd: String,
) -> Result<Vec<Conversation>, String> {
    tauri::async_runtime::spawn_blocking(move || list(&provider, &config_dir, &cwd))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rewind_finds_the_previous_chain_entry_without_modifying_the_transcript() {
        let first = "11111111-1111-4111-8111-111111111111";
        let second = "22222222-2222-4222-8222-222222222222";
        let parent = "33333333-3333-4333-8333-333333333333";
        let missing = "44444444-4444-4444-8444-444444444444";
        let path = std::env::temp_dir().join(format!("trex-rewind-{}.jsonl", std::process::id()));
        let content = format!("{}\n{}\n{}\n", serde_json::json!({"type":"user","uuid":first,"parentUuid":null}),
            serde_json::json!({"type":"user","uuid":second,"parentUuid":first,"isSidechain":true}),
            serde_json::json!({"type":"user","uuid":second,"parentUuid":parent}));
        fs::write(&path, &content).unwrap();
        assert_eq!(rewind_point(&path, first).unwrap(), None);
        assert_eq!(rewind_point(&path, second).unwrap().as_deref(), Some(parent));
        assert!(rewind_point(&path, missing).is_err());
        assert!(rewind_point(&path, "../../invalid").is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), content);
        fs::remove_file(path).unwrap();
    }
    #[test]
    fn ids_cannot_contain_shell_commands_or_paths() {
        assert!(valid_id("550e8400-e29b-41d4-a716-446655440000"));
        for id in [
            "",
            "../../secrets",
            "550e8400-e29b-41d4-a716-44665544000;",
            "550e8400xe29bx41d4xa716x446655440000",
        ] {
            assert!(!valid_id(id));
        }
    }
    #[test]
    fn metadata_limits_sessions_to_the_project_and_skips_subagents() {
        let path = std::env::temp_dir().join(format!("trex-resume-{}.jsonl", std::process::id()));
        fs::write(&path, "{\"type\":\"session_meta\",\"payload\":{\"id\":\"550e8400-e29b-41d4-a716-446655440000\",\"cwd\":\"/work/project\"}}\n").unwrap();
        assert!(metadata(&path, "codex", "/work/project", 1).is_some());
        assert!(metadata(&path, "codex", "/work/another", 1).is_none());
        fs::write(&path,"{\"type\":\"user\",\"isSidechain\":true,\"sessionId\":\"550e8400-e29b-41d4-a716-446655440000\",\"cwd\":\"/work/project\"}\n").unwrap();
        assert!(metadata(&path, "claude", "/work/project", 1).is_none());
        let _ = fs::remove_file(path);
    }
    #[test]
    fn recovery_reads_each_profile_without_mixing_projects_or_subagents() {
        let stamp = std::time::SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let temp =
            std::env::temp_dir().join(format!("trex-history-test-{}-{stamp}", std::process::id()));
        let project = temp.join("project with spaces");
        let other = temp.join("another project");
        let claude = temp.join("claude account");
        let codex = temp.join("codex account");
        for dir in [
            &project,
            &other,
            &claude.join("projects/example/subagents"),
            &codex.join("sessions/2026/10/07"),
        ] {
            fs::create_dir_all(dir).unwrap();
        }
        let id = "550e8400-e29b-41d4-a716-446655440000";
        let write = |path: PathBuf, values: Vec<Value>| {
            let text = values
                .into_iter()
                .map(|value| value.to_string())
                .collect::<Vec<_>>()
                .join("\n");
            fs::write(path, format!("malformed JSON\n{text}\n{{truncated")).unwrap();
        };
        write(
            claude.join("projects/example/conversation.jsonl"),
            vec![
                serde_json::json!({"type":"user","sessionId":id,"cwd":project,"message":{"content":[{"type":"image"},{"type":"text","text":"Primera consulta"}]}}),
                serde_json::json!({"type":"custom-title","customTitle":"Diseño de terminales"}),
            ],
        );
        write(
            claude.join("projects/example/subagents/agent.jsonl"),
            vec![
                serde_json::json!({"type":"user","sessionId":"650e8400-e29b-41d4-a716-446655440000","cwd":project}),
            ],
        );
        write(
            claude.join("projects/example/other.jsonl"),
            vec![
                serde_json::json!({"type":"user","sessionId":"750e8400-e29b-41d4-a716-446655440000","cwd":other}),
            ],
        );
        write(
            codex.join("sessions/2026/10/07/conversation.jsonl"),
            vec![serde_json::json!({"type":"session_meta","payload":{"id":id,"cwd":project}})],
        );
        fs::write(
            codex.join("session_index.jsonl"),
            format!(
                "{}\n",
                serde_json::json!({"id":id,"thread_name":"Pruebas del portapapeles"})
            ),
        )
        .unwrap();
        let cwd = project.to_str().unwrap();
        let claude_sessions = list("claude", claude.to_str().unwrap(), cwd).unwrap();
        let codex_sessions = list("codex", codex.to_str().unwrap(), cwd).unwrap();
        assert_eq!(claude_sessions.len(), 1);
        assert_eq!(codex_sessions.len(), 1);
        assert_eq!(claude_sessions[0].title, "Diseño de terminales");
        assert_eq!(codex_sessions[0].title, "Pruebas del portapapeles");
        assert_eq!(claude_sessions[0].provider, "claude");
        assert_eq!(codex_sessions[0].provider, "codex");
        assert!(
            list("codex", temp.join("empty account").to_str().unwrap(), cwd)
                .unwrap()
                .is_empty()
        );
        assert!(list("unknown", codex.to_str().unwrap(), cwd).is_err());
        assert!(temp.is_absolute() && temp.starts_with(std::env::temp_dir()));
        fs::remove_dir_all(&temp).unwrap();
    }

    #[test]
    fn a_conversation_is_found_in_the_account_its_launcher_chose() {
        let home = std::env::temp_dir().join(format!("trex-roots-{}", std::process::id()));
        for dir in [".claude/projects", ".claude2/projects/-p", ".claude-old", ".codex/sessions"] {
            fs::create_dir_all(home.join(dir)).unwrap();
        }
        let roots = claude_roots_in(&home, home.join(".claude"));
        assert_eq!(roots, vec![home.join(".claude"), home.join(".claude2")], "solo carpetas de Claude con proyectos");
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn history_keeps_the_visible_chat_and_drops_heavy_or_hidden_entries() {
        let stamp = std::time::SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let temp = std::env::temp_dir().join(format!("trex-chat-history-{}-{stamp}", std::process::id()));
        let folder = temp.join("projects/-home-me-app");
        fs::create_dir_all(&folder).unwrap();
        let id = "550e8400-e29b-41d4-a716-446655440001";
        let lines = [
            serde_json::json!({"type": "mode", "mode": "default"}),
            serde_json::json!({"type": "user", "uuid": "u1", "message": {"role": "user", "content": [
                {"type": "text", "text": "hola"}, {"type": "image", "source": {"data": "AAAA"}}]}}),
            serde_json::json!({"type": "user", "isMeta": true, "message": {"role": "user", "content": "<interno>"}}),
            serde_json::json!({"type": "assistant", "isSidechain": true, "message": {"content": []}}),
            serde_json::json!({"type": "assistant", "uuid": "a1", "message": {"id": "m1", "content": [
                {"type": "tool_use", "id": "t1", "name": "Edit", "input": {}}]}}),
            serde_json::json!({"type": "user", "uuid": "u2", "message": {"content": [
                {"type": "tool_result", "tool_use_id": "t1", "content": "x".repeat(HISTORY_TEXT_LIMIT + 50)}]},
                "toolUseResult": {"filePath": "/app/a.ts", "originalFile": "enorme", "structuredPatch": [{"lines": ["-a", "+b"]}]}}),
        ];
        let text = lines.iter().map(Value::to_string).collect::<Vec<_>>().join("\n");
        fs::write(folder.join(format!("{id}.jsonl")), format!("{text}\n{{roto")).unwrap();

        let entries = history(&temp.to_string_lossy(), id).unwrap();
        fs::remove_dir_all(&temp).unwrap();
        assert_eq!(entries.iter().map(|e| e["uuid"].as_str().unwrap()).collect::<Vec<_>>(), ["u1", "a1", "u2"]);
        assert_eq!(entries[0]["message"]["content"][1], serde_json::json!({"type": "image"}));
        let result = entries[2]["message"]["content"][0]["content"].as_str().unwrap();
        assert!(result.ends_with('…') && result.chars().count() == HISTORY_TEXT_LIMIT + 1);
        assert_eq!(entries[2]["toolUseResult"]["filePath"], "/app/a.ts");
        assert!(entries[2]["toolUseResult"].get("originalFile").is_none());
        assert!(history(&temp.to_string_lossy(), "../../etc/passwd").is_err());
    }
}

