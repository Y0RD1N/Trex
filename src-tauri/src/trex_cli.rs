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
const COMMAND_FAILED: &str =
    "No se pudo completar la operación de Trex CLI. Comprueba el perfil y la instalación.";

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

// A fresh key is transient stdin input; a saved key is resolved only by the CLI.
// Do not add Debug or return this request to the WebView.
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelCatalogRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    provider: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    base_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    api_key: Option<String>,
    #[serde(default, skip_serializing)]
    config_dir: Option<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogModel {
    id: String,
    name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    context_window: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    efforts: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    input_modalities: Option<Vec<String>>,
}

#[derive(Deserialize, Serialize)]
pub struct ModelCatalog {
    models: Vec<CatalogModel>,
    source: String,
}

struct CliOutput {
    success: bool,
    bytes: Vec<u8>,
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
    command: Command,
    args: &[&str],
    input: Option<Vec<u8>>,
) -> Result<Vec<u8>, String> {
    let result = run_cli_command_output(command, args, input)?;
    if result.success {
        Ok(result.bytes)
    } else {
        Err(COMMAND_FAILED.into())
    }
}

fn run_cli_command_output(
    mut command: Command,
    args: &[&str],
    input: Option<Vec<u8>>,
) -> Result<CliOutput, String> {
    let failure = COMMAND_FAILED;
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
    let status = status?;
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
    Ok(CliOutput {
        success: status.success(),
        bytes: output,
    })
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

fn catalog_output(output: CliOutput) -> Result<ModelCatalog, String> {
    const INVALID: &str = "Trex CLI devolvió un catálogo de modelos no válido.";
    if !output.success {
        #[derive(Deserialize)]
        struct Failure {
            error: FailureCode,
        }
        #[derive(Deserialize)]
        struct FailureCode {
            code: String,
        }
        let failure: Failure =
            serde_json::from_slice(&output.bytes).map_err(|_| COMMAND_FAILED.to_string())?;
        let message = match failure.error.code.as_str() {
            "unauthorized" => "La credencial no es válida o ha caducado. Comprueba la clave del proveedor.",
            "forbidden" => "La credencial no tiene acceso al catálogo de modelos. Puedes indicar un modelo manualmente.",
            "unsupported" => "El proveedor no ofrece un catálogo compatible. Puedes indicar un modelo manualmente.",
            "unavailable" => "No se pudo conectar con el catálogo del proveedor. Vuelve a intentarlo.",
            "invalid_request" => "Revisa el proveedor, la dirección y la credencial. Pega la clave sin el prefijo Bearer.",
            "invalid_response" => INVALID,
            _ => COMMAND_FAILED,
        };
        return Err(message.into());
    }
    let catalog: ModelCatalog =
        serde_json::from_slice(&output.bytes).map_err(|_| INVALID.to_string())?;
    let valid_text = |value: &str, limit: usize| {
        !value.trim().is_empty() && value.len() <= limit && !value.chars().any(char::is_control)
    };
    if catalog.source != "remote"
        || catalog.models.len() > 4096
        || catalog.models.iter().any(|model| {
            !valid_text(&model.id, 1024)
                || model.id.trim() != model.id
                || !valid_text(&model.name, 2048)
                || model
                    .context_window
                    .is_some_and(|value| value == 0 || value > 9_007_199_254_740_991)
                || [&model.efforts, &model.input_modalities]
                    .into_iter()
                    .any(|values| {
                        values.as_ref().is_some_and(|values| {
                            values.len() > 64 || values.iter().any(|value| !valid_text(value, 128))
                        })
                    })
        })
    {
        return Err(INVALID.into());
    }
    Ok(catalog)
}

#[tauri::command]
pub async fn trex_cli_models(request: ModelCatalogRequest) -> Result<ModelCatalog, String> {
    crate::blocking(move || {
        if !matches!(
            request.provider.as_str(),
            "minimax" | "deepseek" | "openrouter" | "anthropic" | "custom"
        ) || request.name.as_ref().is_some_and(|name| {
            name.trim().is_empty()
                || name.starts_with('-')
                || name.len() > 128
                || name.chars().any(char::is_control)
        }) || request
            .config_dir
            .as_ref()
            .is_some_and(|directory| directory.contains(['\r', '\n', '\0']))
        {
            return Err("La conexión elegida no es válida.".into());
        }
        let mut command = cli_command(&installed_cli_path()?);
        if let Some(directory) = request
            .config_dir
            .as_ref()
            .filter(|directory| !directory.trim().is_empty())
        {
            command.env("TREX_HOME", crate::pty::expand_config_dir(directory));
        }
        let input = serde_json::to_vec(&request)
            .map_err(|_| "No se pudo preparar la consulta de modelos.".to_string())?;
        catalog_output(run_cli_command_output(
            command,
            &["models", "list", "--json", "--stdin-json"],
            Some(input),
        )?)
    })
    .await
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
    fn catalog_bridge_returns_only_model_metadata_and_allows_empty_remote_results() {
        let catalog = catalog_output(CliOutput {
            success: true,
            bytes: br#"{
          "source":"remote","apiKey":"never-return-this",
          "models":[{"id":"vendor/model","name":"A model","contextWindow":32768,
          "efforts":["low","high"],"inputModalities":["text","image"],"apiKey":"never-return-this"}]
        }"#
            .to_vec(),
        })
        .unwrap();
        let serialized = serde_json::to_string(&catalog).unwrap();
        assert!(!serialized.contains("never-return-this"));
        assert!(!serialized.contains("apiKey"));
        assert_eq!(catalog.models[0].id, "vendor/model");
        assert_eq!(catalog.models[0].context_window, Some(32768));
        assert!(catalog_output(CliOutput {
            success: true,
            bytes: br#"{"source":"remote","models":[]}"#.to_vec()
        })
        .unwrap()
        .models
        .is_empty());
        for payload in [
            br#"{"source":"fallback","models":[]}"#.as_slice(),
            br#"{"source":"remote","models":[{"id":" bad ","name":"bad"}]}"#.as_slice(),
            br#"{"source":"remote","models":[{"id":"bad\nmodel","name":"bad"}]}"#.as_slice(),
            br#"{"source":"remote","models":[{"id":"bad","name":"bad","contextWindow":0}]}"#
                .as_slice(),
        ] {
            assert!(catalog_output(CliOutput {
                success: true,
                bytes: payload.to_vec()
            })
            .is_err());
        }
    }

    #[test]
    fn catalog_errors_use_fixed_messages_without_echoing_upstream_diagnostics() {
        for code in [
            "unauthorized",
            "forbidden",
            "unsupported",
            "unavailable",
            "invalid_request",
            "invalid_response",
            "fake-secret",
        ] {
            let bytes = serde_json::to_vec(&serde_json::json!({"error":{"code":code,
                "message":"api_key=fake-secret","apiKey":"fake-secret"}}))
            .unwrap();
            let error = catalog_output(CliOutput {
                success: false,
                bytes,
            })
            .err()
            .unwrap();
            assert!(!error.contains("fake-secret"));
            assert!(!error.contains("api_key"));
            assert!(!error.contains("apiKey"));
        }
        assert_eq!(
            catalog_output(CliOutput {
                success: false,
                bytes: b"fake-secret".to_vec()
            })
            .err()
            .unwrap(),
            COMMAND_FAILED
        );
    }

    #[test]
    fn catalog_request_keeps_the_home_override_out_of_stdin() {
        let request: ModelCatalogRequest = serde_json::from_value(serde_json::json!({
            "name":"TREX2","provider":"minimax","baseUrl":"https://api.minimax.io/v1",
            "apiKey":"fake-transient-key","configDir":"test-private-home"
        }))
        .unwrap();
        assert_eq!(request.config_dir.as_deref(), Some("test-private-home"));
        let serialized = serde_json::to_value(&request).unwrap();
        assert_eq!(serialized["name"], "TREX2");
        assert_eq!(serialized["apiKey"], "fake-transient-key");
        assert!(serialized.get("configDir").is_none());
        assert!(
            serialized.get("model").is_none(),
            "catalog discovery must not require a model ID"
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
        let desktop: DesktopStatus = parse_json(&invoke(&["desktop-doctor", "--json"], None).unwrap()).unwrap();
        assert_eq!(desktop.coordinate_space, "physicalPixels");
        assert!(matches!(desktop.backend.as_str(), "windows" | "x11" | "unsupported"));
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

/// Bind desktop access to a fresh MCP process. The mode cannot be changed by a tool call.
#[tauri::command]
pub async fn trex_desktop_mcp_config(mode: String) -> Result<serde_json::Value, String> {
    let fixed_mode = match mode.as_str() {
        "observe" => "plan",
        "qa" | "full" => "full",
        _ => return Err("Modo de escritorio no válido.".into()),
    };
    let binary = installed_cli_path()?;
    let command = binary.to_str().ok_or("La ruta del agente no es UTF-8 válida.")?;
    Ok(serde_json::json!({"command":command,"args":["desktop-mcp","--mode",fixed_mode]}))
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopStatus {
    available: bool,
    backend: String,
    monitors: Vec<DesktopMonitor>,
    coordinate_space: String,
    reason: Option<String>,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopMonitor {
    id: u32,
    name: String,
    primary: bool,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    scale_factor: f32,
}

/// Read-only preflight. Does not capture the desktop, send input or open a model session.
#[tauri::command]
pub async fn trex_desktop_status() -> Result<DesktopStatus, String> {
    crate::blocking(|| parse_json(&invoke_cli(&["desktop-doctor", "--json"], None)?)).await
}

/// Control por accesibilidad (experimental): si el motor propio existe en esta
/// plataforma. No abre ni lee aplicaciones.
#[tauri::command]
pub async fn trex_a11y_status() -> Result<serde_json::Value, String> {
    crate::blocking(|| parse_json(&invoke_cli(&["a11y-doctor", "--json"], None)?)).await
}

/// Servidor de accesibilidad de una sesión (motor propio), con el modo fijado al
/// arrancar. Antes comprueba que se pueda usar, para avisar en el chat en vez de
/// arrancar un servidor que fallaría.
#[tauri::command]
pub async fn trex_a11y_mcp_config(app: tauri::AppHandle, mode: String) -> Result<serde_json::Value, String> {
    let fixed_mode = match mode.as_str() {
        "observe" => "plan",
        "qa" | "full" => "full",
        _ => return Err("Modo de control por accesibilidad no válido.".into()),
    };
    let settings = crate::config::load(&app).settings;
    let status: serde_json::Value = crate::blocking(|| parse_json(&invoke_cli(&["a11y-doctor", "--json"], None)?)).await
        .map_err(|_| "Actualiza Trex CLI para usar el control por accesibilidad.".to_string())?;
    a11y_ready(&status)?;
    let binary = installed_cli_path()?;
    let command = binary.to_str().ok_or("La ruta del agente no es UTF-8 válida.")?;
    let mut args = vec!["a11y-mcp", "--mode", fixed_mode];
    // Atajos de teclado solo con el permiso de Ajustes (y nunca al planificar: el motor lo impide).
    if settings.a11y_keyboard {
        args.push("--keyboard");
    }
    Ok(serde_json::json!({"command":command,"args":args}))
}

/// Si el motor propio se puede usar aquí, o por qué no.
fn a11y_ready(status: &serde_json::Value) -> Result<(), String> {
    if status["available"] == true {
        return Ok(());
    }
    Err(match status["reason"].as_str() {
        Some("a11yBusUnavailable") | Some("sessionBusUnavailable") => {
            "El bus de accesibilidad (AT-SPI) no responde: instala at-spi2-core e inicia sesión en un escritorio gráfico.".into()
        }
        _ => "El control por accesibilidad solo está disponible en Windows y Linux.".into(),
    })
}

#[cfg(test)]
mod a11y_engine_tests {
    use super::a11y_ready;
    use serde_json::json;

    #[test]
    fn the_builtin_engine_is_used_where_it_exists() {
        assert_eq!(a11y_ready(&json!({"available": true, "engine": "trex"})), Ok(()));
        assert!(a11y_ready(&json!({"available": false, "engine": "trex", "reason": "unsupportedPlatform"})).unwrap_err().contains("solo está disponible en Windows y Linux"));
        assert!(a11y_ready(&json!({"available": false, "engine": "trex", "platform": "linux", "reason": "a11yBusUnavailable"})).unwrap_err().contains("AT-SPI"));
        // Un Trex CLI anterior respondía con otro formato: no se da por disponible.
        assert!(a11y_ready(&json!({"native": {"available": true}})).is_err());
    }
}
