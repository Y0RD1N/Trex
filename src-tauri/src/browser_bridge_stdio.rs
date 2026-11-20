//! Adaptador para los agentes que solo hablan MCP por stdio (Antigravity, Trex CLI):
//! `trex.exe --trex-chrome-mcp http://127.0.0.1:<puerto>/mcp` lee peticiones JSON-RPC
//! por la entrada estándar, las reenvía tal cual al puente de la app
//! (`browser_bridge.rs`) y escribe sus respuestas. No interpreta nada: qué herramientas
//! hay y qué permite cada modo lo decide el puente.
//!
//! El token del chat viene en la variable de entorno `TREX_CHROME_TOKEN`, nunca en la
//! línea de comandos, y la dirección solo puede ser este mismo equipo.
use serde_json::{json, Value};
use std::io::{self, BufRead, Read, Write};
use std::time::Duration;

pub const FLAG: &str = "--trex-chrome-mcp";
pub const TOKEN_ENV: &str = "TREX_CHROME_TOKEN";
const MAX_LINE_BYTES: usize = 1024 * 1024;
/// Algo más que el tope de una herramienta en el puente (60 s), para que conteste él.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(75);

/// La dirección, solo si es el puente local: `http://127.0.0.1:<puerto>/mcp`.
pub fn local_endpoint(url: &str) -> Option<String> {
    let port = url.strip_prefix("http://127.0.0.1:")?.strip_suffix("/mcp")?;
    let port: u16 = port.parse().ok().filter(|port| *port >= 1024)?;
    // Sin ceros a la izquierda ni signos: la dirección que se usa es la que se reconstruye aquí.
    (port.to_string() == url["http://127.0.0.1:".len()..url.len() - "/mcp".len()]).then(|| format!("http://127.0.0.1:{port}/mcp"))
}

fn valid_token(token: &str) -> bool {
    token.len() == 64 && token.bytes().all(|byte| byte.is_ascii_hexdigit())
}

/// Reenvía cada línea. `post` devuelve el cuerpo de la respuesta, o `None` si era un aviso.
fn serve(mut reader: impl BufRead, mut writer: impl Write, post: impl Fn(&[u8]) -> Result<Option<Vec<u8>>, String>) -> io::Result<()> {
    let mut line = Vec::new();
    loop {
        line.clear();
        // Una línea desmesurada no se guarda entera: se lee hasta su final y se rechaza.
        let read = reader.by_ref().take(MAX_LINE_BYTES as u64 + 1).read_until(b'\n', &mut line)?;
        if read == 0 { return Ok(()); }
        let complete = line.last() == Some(&b'\n');
        if !complete && line.len() > MAX_LINE_BYTES {
            let mut rest = Vec::new();
            loop {
                rest.clear();
                let more = reader.by_ref().take(64 * 1024).read_until(b'\n', &mut rest)?;
                if more == 0 || rest.last() == Some(&b'\n') { break; }
            }
            write_reply(&mut writer, &json!({ "jsonrpc": "2.0", "id": null, "error": { "code": -32600, "message": "Petición demasiado grande" } }))?;
            continue;
        }
        let body = line.strip_suffix(b"\n").unwrap_or(&line);
        let body = body.strip_suffix(b"\r").unwrap_or(body);
        if body.iter().all(u8::is_ascii_whitespace) { continue; }
        let id = serde_json::from_slice::<Value>(body).ok().and_then(|message| message.get("id").cloned());
        match post(body) {
            Ok(Some(reply)) => { writer.write_all(&reply)?; writer.write_all(b"\n")?; writer.flush()?; }
            Ok(None) => {}
            // Un aviso (sin id) no lleva respuesta ni aunque falle el envío.
            Err(error) => if let Some(id) = id {
                write_reply(&mut writer, &json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32603, "message": error } }))?;
            },
        }
    }
}

fn write_reply(writer: &mut impl Write, value: &Value) -> io::Result<()> {
    writer.write_all(value.to_string().as_bytes())?;
    writer.write_all(b"\n")?;
    writer.flush()
}

/// Devuelve `true` siempre que se pidió este modo, también con argumentos malos, para que
/// quien llama no arranque la ventana después.
pub fn run_if_requested() -> bool {
    let mut args = std::env::args().skip(1);
    if args.next().as_deref() != Some(FLAG) { return false; }
    let (Some(url), None) = (args.next(), args.next()) else {
        eprintln!("trex chrome MCP: uso: {FLAG} http://127.0.0.1:<puerto>/mcp");
        return true;
    };
    let Some(endpoint) = local_endpoint(&url) else {
        eprintln!("trex chrome MCP: la dirección debe ser el puente local de trex");
        return true;
    };
    let token = std::env::var(TOKEN_ENV).unwrap_or_default();
    if !valid_token(&token) {
        eprintln!("trex chrome MCP: falta {TOKEN_ENV}");
        return true;
    }
    // Sin proxy del sistema: la petición es a este mismo equipo y no debe salir de él.
    let client = match reqwest::blocking::Client::builder().no_proxy().timeout(REQUEST_TIMEOUT).build() {
        Ok(client) => client,
        Err(error) => { eprintln!("trex chrome MCP: {error}"); return true; }
    };
    let post = |body: &[u8]| -> Result<Option<Vec<u8>>, String> {
        let response = client.post(&endpoint).header("authorization", format!("Bearer {token}"))
            .header("content-type", "application/json").body(body.to_vec()).send()
            .map_err(|_| "trex no responde. Comprueba que la app siga abierta y «Tu navegador» activado.".to_string())?;
        let status = response.status();
        if status == reqwest::StatusCode::ACCEPTED { return Ok(None); }
        if status == reqwest::StatusCode::UNAUTHORIZED { return Err("La sesión de este chat con el navegador caducó. Reinicia la conversación.".into()); }
        let bytes = response.bytes().map_err(|error| error.to_string())?;
        // Una respuesta en varias líneas rompería el protocolo por líneas: se compacta.
        let value: Value = serde_json::from_slice(&bytes).map_err(|_| format!("Respuesta no válida de trex ({status})."))?;
        Ok(Some(value.to_string().into_bytes()))
    };
    if let Err(error) = serve(io::stdin().lock(), io::stdout().lock(), post) {
        eprintln!("trex chrome MCP: {error}");
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    #[test]
    fn only_the_local_bridge_address_is_accepted() {
        assert_eq!(local_endpoint("http://127.0.0.1:7341/mcp").as_deref(), Some("http://127.0.0.1:7341/mcp"));
        for other in ["https://127.0.0.1:7341/mcp", "http://localhost:7341/mcp", "http://127.0.0.1:7341/mcp/x", "http://127.0.0.1:80/mcp",
            "http://127.0.0.1:7341@evil.example/mcp", "http://127.0.0.1:07341/mcp", "http://127.0.0.1:+7341/mcp", "http://127.0.0.1:7341/", "http://evil.example:7341/mcp", ""] {
            assert_eq!(local_endpoint(other), None, "{other}");
        }
        assert!(valid_token(&"a1".repeat(32)));
        assert!(!valid_token("corto") && !valid_token(&"z".repeat(64)));
    }

    #[test]
    fn requests_are_forwarded_line_by_line_and_notifications_stay_silent() {
        let seen = RefCell::new(Vec::new());
        let input = b"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"ping\"}\r\n\n{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}\n{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/list\"}\n";
        let mut output = Vec::new();
        serve(&input[..], &mut output, |body| {
            let message: Value = serde_json::from_slice(body).unwrap();
            seen.borrow_mut().push(message["method"].as_str().unwrap().to_string());
            Ok(message.get("id").map(|id| json!({ "jsonrpc": "2.0", "id": id, "result": {} }).to_string().into_bytes()))
        }).unwrap();
        assert_eq!(*seen.borrow(), ["ping", "notifications/initialized", "tools/list"]);
        let replies: Vec<Value> = String::from_utf8(output).unwrap().lines().map(|line| serde_json::from_str(line).unwrap()).collect();
        assert_eq!(replies.iter().map(|reply| reply["id"].as_i64().unwrap()).collect::<Vec<_>>(), [1, 2]);
    }

    #[test]
    fn a_failed_request_answers_with_an_error_and_an_oversized_line_is_refused() {
        let mut output = Vec::new();
        let huge = format!("{{\"jsonrpc\":\"2.0\",\"id\":9,\"pad\":\"{}\"}}\n", "x".repeat(MAX_LINE_BYTES + 10));
        let input = format!("{{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tools/call\"}}\n{{\"jsonrpc\":\"2.0\",\"method\":\"notifications/x\"}}\n{huge}{{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"ping\"}}\n");
        let calls = RefCell::new(0);
        serve(input.as_bytes(), &mut output, |_| { *calls.borrow_mut() += 1; Err("trex no responde.".into()) }).unwrap();
        let replies: Vec<Value> = String::from_utf8(output).unwrap().lines().map(|line| serde_json::from_str(line).unwrap()).collect();
        // La petición fallida, la línea desmesurada (sin llegar a enviarse) y la siguiente, que sigue funcionando.
        assert_eq!(replies.len(), 3);
        assert_eq!((replies[0]["id"].as_i64(), replies[0]["error"]["code"].as_i64()), (Some(3), Some(-32603)));
        assert_eq!(replies[1]["error"]["code"], -32600);
        assert_eq!(replies[2]["id"], 4);
        assert_eq!(*calls.borrow(), 3, "el aviso se intenta enviar, la línea enorme no");
    }
}
