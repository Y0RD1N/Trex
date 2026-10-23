//! Management bridge for the optional CLI. Never resolve it through PATH, and
//! never put credentials in command arguments, diagnostics or returned errors.
use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

const NOT_INSTALLED: &str =
    "Trex CLI no está instalado. Activa «Instalar Trex CLI» al ejecutar el instalador de Trex.";
const OUTPUT_LIMIT: usize = 1024 * 1024;
const INPUT_LIMIT: usize = 64 * 1024;
const COMMAND_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliStatus {
    installed: bool,
    path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    version: Option<String>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileSummary {
    name: String,
    provider: String,
    base_url: String,
    model: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    effort: Option<String>,
    has_api_key: bool,
}

// Deliberately no Debug implementation: this request can contain credentials.
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveProfileRequest {
    name: String,
    provider: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    base_url: Option<String>,
    model: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    api_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    effort: Option<String>,
}

fn sibling_cli(executable: &Path) -> Option<PathBuf> {
    let name = if cfg!(windows) {
        "trex-agent.exe"
    } else {
        "trex-agent"
    };
    executable.parent().map(|directory| directory.join(name))
}

pub(crate) fn is_trex_command(command: &str) -> bool {
    matches!(command, "trex-agent" | "trex-agent.exe")
}

/// Production accepts only the installed sibling. Development can additionally
/// use this checkout's debug CLI; an unrelated PATH binary is never accepted.
pub(crate) fn installed_cli_path() -> Result<PathBuf, String> {
    if let Some(path) = std::env::current_exe()
        .ok()
        .as_deref()
        .and_then(sibling_cli)
    {
        if path.is_absolute() && path.is_file() {
            return Ok(path);
        }
    }
    #[cfg(debug_assertions)]
    {
        let name = if cfg!(windows) {
            "trex-agent.exe"
        } else {
            "trex-agent"
        };
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../trex-cli/target/debug")
            .join(name);
        if path.is_file() {
            return path.canonicalize().map_err(|_| NOT_INSTALLED.to_string());
        }
    }
    Err(NOT_INSTALLED.to_string())
}

fn read_output(mut output: impl Read) -> Result<Vec<u8>, ()> {
    let mut bytes = Vec::new();
    let mut buffer = [0u8; 8192];
    let mut overflow = false;
    loop {
        let read = output.read(&mut buffer).map_err(|_| ())?;
        if read == 0 {
            break;
        }
        if bytes.len() + read <= OUTPUT_LIMIT {
            bytes.extend_from_slice(&buffer[..read]);
        } else {
            // Keep draining so a full pipe cannot deadlock the child.
            overflow = true;
        }
    }
    if overflow {
        Err(())
    } else {
        Ok(bytes)
    }
}

fn cli_command(path: &Path) -> Command {
    let mut command = Command::new(path);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    command
}

fn invoke_cli_at(path: &Path, args: &[&str], input: Option<Vec<u8>>) -> Result<Vec<u8>, String> {
    run_cli_command(cli_command(path), args, input)
}

fn run_cli_command(
    mut command: Command,
    args: &[&str],
    input: Option<Vec<u8>>,
) -> Result<Vec<u8>, String> {
    let failure =
        "No se pudo completar la operación de Trex CLI. Comprueba el perfil y la instalación.";
    if input
        .as_ref()
        .is_some_and(|bytes| bytes.len() > INPUT_LIMIT)
    {
        return Err("El perfil supera el tamaño permitido.".into());
    }
    command
        .args(args)
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        // The CLI could echo an invalid key in a diagnostic. Never return it.
        .stderr(Stdio::null());
    let mut child = command.spawn().map_err(|_| failure.to_string())?;
    let stdout = child.stdout.take().ok_or_else(|| failure.to_string())?;
    let (output_tx, output_rx) = mpsc::sync_channel(1);
    thread::spawn(move || {
        let _ = output_tx.send(read_output(stdout));
    });
    let input_rx = input.map(|bytes| {
        let stdin = child.stdin.take();
        let (input_tx, input_rx) = mpsc::sync_channel(1);
        thread::spawn(move || {
            let result = stdin
                .ok_or(())
                .and_then(|mut stdin| stdin.write_all(&bytes).map_err(|_| ()));
            // Dropping stdin signals EOF; no secret is written to a file.
            let _ = input_tx.send(result);
        });
        input_rx
    });
    let deadline = Instant::now() + COMMAND_TIMEOUT;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Ok(status),
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(15)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break Err(failure.to_string());
            }
        }
    };
    if !status?.success() {
        return Err(failure.into());
    }
    // Bound pipe completion too: an unexpected descendant retaining a handle
    // must not leave the Tauri invocation waiting forever after the CLI exits.
    if let Some(input_rx) = input_rx {
        input_rx
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .map_err(|_| failure.to_string())?
            .map_err(|_| failure.to_string())?;
    }
    let output = output_rx
        .recv_timeout(deadline.saturating_duration_since(Instant::now()))
        .map_err(|_| failure.to_string())?
        .map_err(|_| failure.to_string())?;
    Ok(output)
}

fn invoke_cli(args: &[&str], input: Option<Vec<u8>>) -> Result<Vec<u8>, String> {
    invoke_cli_at(&installed_cli_path()?, args, input)
}

fn parse_json<T: serde::de::DeserializeOwned>(bytes: &[u8]) -> Result<T, String> {
    serde_json::from_slice(bytes).map_err(|_| "Trex CLI devolvió una respuesta no válida.".into())
}

#[tauri::command]
pub async fn trex_cli_status() -> Result<CliStatus, String> {
    crate::blocking(|| {
        let Ok(path) = installed_cli_path() else {
            return Ok(CliStatus {
                installed: false,
                path: None,
                version: None,
            });
        };
        let version = invoke_cli_at(&path, &["--version"], None)
            .ok()
            .and_then(|bytes| String::from_utf8(bytes).ok())
            .map(|value| value.trim().to_string())
            .filter(|value| {
                !value.is_empty() && value.len() <= 200 && !value.contains(['\r', '\n'])
            });
        Ok(CliStatus {
            installed: true,
            path: Some(path.to_string_lossy().into_owned()),
            version,
        })
    })
    .await
}

#[tauri::command]
pub async fn trex_cli_profiles() -> Result<Vec<ProfileSummary>, String> {
    crate::blocking(|| parse_json(&invoke_cli(&["profiles", "list", "--json"], None)?)).await
}

#[tauri::command]
pub async fn trex_cli_save_profile(request: SaveProfileRequest) -> Result<ProfileSummary, String> {
    crate::blocking(move || {
        let input = serde_json::to_vec(&request)
            .map_err(|_| "No se pudo preparar el perfil.".to_string())?;
        parse_json(&invoke_cli(
            &["profiles", "save", "--stdin-json"],
            Some(input),
        )?)
    })
    .await
}

#[tauri::command]
pub async fn trex_cli_remove_profile(name: String) -> Result<(), String> {
    crate::blocking(move || {
        // Names are arguments, never shell text. Reject option-like names too.
        if name.is_empty()
            || name.starts_with('-')
            || name.len() > 128
            || name.contains(['\r', '\n', '\0'])
        {
            return Err("El nombre del perfil no es válido.".into());
        }
        invoke_cli(&["profiles", "remove", &name], None)?;
        Ok(())
    })
    .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionMetadata {
    id: String,
    provider: String,
    title: String,
    cwd: String,
    updated_at: u64,
}

fn same_cwd(one: &str, two: &str, windows: bool) -> bool {
    if one.is_empty() || two.is_empty() {
        return false;
    }
    let normalize = |path: &str| {
        let slashes = path.replace('\\', "/");
        let path = slashes.trim_end_matches('/');
        let path = if path.is_empty() { "/" } else { path };
        if windows {
            path.to_lowercase()
        } else {
            path.to_string()
        }
    };
    normalize(one) == normalize(two)
}

fn filter_sessions(
    bytes: &[u8],
    cwd: &str,
    windows: bool,
) -> Result<Vec<crate::conversations::Conversation>, String> {
    let metadata: Vec<SessionMetadata> = parse_json(bytes)?;
    let mut conversations: Vec<_> = metadata
        .into_iter()
        .filter(|item| {
            item.provider == "trex"
                && crate::conversations::valid_id(&item.id)
                && same_cwd(&item.cwd, cwd, windows)
        })
        .map(|item| crate::conversations::Conversation {
            id: item.id,
            provider: "trex".into(),
            title: item
                .title
                .chars()
                .filter(|character| !character.is_control())
                .take(160)
                .collect(),
            cwd: item.cwd,
            updated_at: item.updated_at,
        })
        .collect();
    conversations.sort_by_key(|item| std::cmp::Reverse(item.updated_at));
    Ok(conversations)
}

#[tauri::command]
pub async fn trex_cli_conversations(
    name: String,
    config_dir: String,
    cwd: String,
) -> Result<Vec<crate::conversations::Conversation>, String> {
    crate::blocking(move || {
        if name.is_empty()
            || name.starts_with('-')
            || name.len() > 128
            || name.contains(['\r', '\n', '\0'])
        {
            return Err("El nombre del perfil no es válido.".into());
        }
        if cwd.trim().is_empty() || cwd.contains('\0') || config_dir.contains(['\r', '\n', '\0']) {
            return Err("La carpeta de las conversaciones no es válida.".into());
        }
        let mut command = cli_command(&installed_cli_path()?);
        if !config_dir.trim().is_empty() {
            command.env("TREX_HOME", crate::pty::expand_config_dir(&config_dir));
        }
        let bytes = run_cli_command(
            command,
            &["--profile", &name, "sessions", "list", "--json"],
            None,
        )?;
        filter_sessions(&bytes, &cwd, cfg!(windows))
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_exact_reserved_names_use_the_bundled_cli() {
        assert!(is_trex_command("trex-agent"));
        assert!(is_trex_command("trex-agent.exe"));
        for command in [
            "trex-agent --profile TREX1",
            "trex-agent-alias",
            "TREX-AGENT",
            "./trex-agent",
        ] {
            assert!(!is_trex_command(command));
        }
    }

    #[test]
    fn resolution_uses_the_application_directory() {
        let executable = Path::new(if cfg!(windows) {
            r"C:\Program Files\trex\trex.exe"
        } else {
            "/opt/trex/trex"
        });
        assert_eq!(
            sibling_cli(executable).unwrap(),
            executable.parent().unwrap().join(if cfg!(windows) {
                "trex-agent.exe"
            } else {
                "trex-agent"
            })
        );
    }

    #[test]
    fn returned_summaries_cannot_expose_a_cli_credential_field() {
        let summary: ProfileSummary = parse_json(br#"{"name":"TREX1","provider":"openai","baseUrl":"https://api.example.test","model":"test","hasApiKey":true,"apiKey":"do-not-return"}"#).unwrap();
        let json = serde_json::to_string(&summary).unwrap();
        assert!(!json.contains("do-not-return"));
        assert!(!json.contains("apiKey"));
        assert!(json.contains("hasApiKey"));
        assert_eq!(
            parse_json::<ProfileSummary>(b"secret invalid response")
                .err()
                .unwrap(),
            "Trex CLI devolvió una respuesta no válida."
        );
    }

    #[test]
    fn output_limit_is_enforced_after_draining() {
        assert!(read_output(std::io::repeat(b'x').take((OUTPUT_LIMIT + 1) as u64)).is_err());
    }

    #[test]
    fn conversations_are_uuid_checked_and_confined_to_the_requested_directory() {
        let bytes = br#"[
          {"id":"a0a0a0a0-1111-4111-8111-a0a0a0a0a0a0","provider":"trex","title":"keep\nthis","cwd":"C:\\Work\\Project\\","updatedAt":10,"apiKey":"ignored"},
          {"id":"b0b0b0b0-1111-4111-8111-b0b0b0b0b0b0","provider":"trex","title":"other project","cwd":"C:/Work/Project-other","updatedAt":20},
          {"id":"../invalid","provider":"trex","title":"bad id","cwd":"c:/work/project","updatedAt":30},
          {"id":"c0c0c0c0-1111-4111-8111-c0c0c0c0c0c0","provider":"codex","title":"other provider","cwd":"c:/work/project","updatedAt":40}
        ]"#;
        let sessions = filter_sessions(bytes, "c:/work/project", true).unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].title, "keepthis");
        assert!(!serde_json::to_string(&sessions).unwrap().contains("apiKey"));
        assert!(filter_sessions(bytes, "c:/work/project", false)
            .unwrap()
            .is_empty());
        assert!(!same_cwd("/", "", false));
        assert!(!same_cwd("/Work/Project", "/work/project", false));
    }

    #[test]
    #[ignore = "requires TREX_TEST_CLI pointing to a built standalone CLI; management commands only"]
    fn management_roundtrip_uses_an_isolated_cli_home() {
        let binary = PathBuf::from(std::env::var_os("TREX_TEST_CLI").expect("set TREX_TEST_CLI"));
        assert!(binary.is_absolute() && binary.is_file());
        let home = std::env::temp_dir().join(format!(
            "trex-bridge-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        // The CLI creates its own private home instead of trusting inherited
        // access permissions on an already-created shared temporary directory.
        assert!(!home.exists());
        struct Cleanup(PathBuf);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
        let _cleanup = Cleanup(home.clone());
        let invoke = |args: &[&str], input: Option<Vec<u8>>| {
            let mut command = cli_command(&binary);
            command.env("TREX_HOME", &home);
            run_cli_command(command, args, input)
        };
        let before: Vec<ProfileSummary> =
            parse_json(&invoke(&["profiles", "list", "--json"], None).unwrap()).unwrap();
        assert!(before.is_empty());
        let input = br#"{"name":"TREX1","provider":"custom","baseUrl":"https://example.test/v1","model":"mock-model","apiKey":"trex-fake-test-key"}"#.to_vec();
        let saved: ProfileSummary =
            parse_json(&invoke(&["profiles", "save", "--stdin-json"], Some(input)).unwrap())
                .unwrap();
        assert_eq!(saved.name, "TREX1");
        assert!(saved.has_api_key);
        assert!(!serde_json::to_string(&saved)
            .unwrap()
            .contains("trex-fake-test-key"));
        let profiles: Vec<ProfileSummary> =
            parse_json(&invoke(&["profiles", "list", "--json"], None).unwrap()).unwrap();
        assert_eq!(profiles.len(), 1);
        let sessions: Vec<SessionMetadata> = parse_json(
            &invoke(&["--profile", "TREX1", "sessions", "list", "--json"], None).unwrap(),
        )
        .unwrap();
        assert!(sessions.is_empty());
        let invalid = br#"{"name":"TREX2","provider":"invalid-provider","model":"mock","apiKey":"never-echo-this-key"}"#.to_vec();
        let error = invoke(&["profiles", "save", "--stdin-json"], Some(invalid)).unwrap_err();
        assert!(!error.contains("never-echo-this-key"));
        invoke(&["profiles", "remove", "TREX1"], None).unwrap();
        let after: Vec<ProfileSummary> =
            parse_json(&invoke(&["profiles", "list", "--json"], None).unwrap()).unwrap();
        assert!(after.is_empty());
    }
}
