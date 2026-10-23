//! Offline process-level tests of strict, transient model discovery.
//! All credentials are fake and every HTTP socket is on loopback.
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    fs,
    io::{BufRead, BufReader, Read, Write},
    net::{SocketAddr, TcpListener, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, Output, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};
use tempfile::TempDir;

const KEY: &str = "synthetic-catalog-transient-key-7391";
const STORED_KEY: &str = "synthetic-catalog-saved-key-2856";
const BODY_MARKER: &str = "private-upstream-body-must-not-be-printed";
const MIB: usize = 1024 * 1024;
const PROCESS_LIMIT: Duration = Duration::from_secs(15);

fn command(home: &Path) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_trex-agent"));
    command.env("TREX_HOME", home.join("private-home"));
    for name in [
        "OPENAI_API_KEY",
        "OPENROUTER_API_KEY",
        "DEEPSEEK_API_KEY",
        "MINIMAX_API_KEY",
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "http_proxy",
        "https_proxy",
        "all_proxy",
    ] {
        command.env_remove(name);
    }
    // Defense in depth for invalid, non-loopback URL cases. No live service is
    // used, even if a regression accidentally attempts a request to .invalid.
    command
        .env("HTTP_PROXY", "http://127.0.0.1:1")
        .env("HTTPS_PROXY", "http://127.0.0.1:1")
        .env("ALL_PROXY", "http://127.0.0.1:1")
        .env("NO_PROXY", "127.0.0.1,localhost,::1")
        .env("no_proxy", "127.0.0.1,localhost,::1");
    command
}

struct Process {
    child: Child,
    readers: Vec<JoinHandle<Vec<u8>>>,
    writer: Option<JoinHandle<()>>,
}

impl Process {
    fn spawn(mut command: Command, input: Vec<u8>) -> Self {
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn actual trex-agent binary");
        let mut stdin = child.stdin.take().unwrap();
        let writer = thread::spawn(move || {
            // Early rejection may close stdin before an oversized input drains.
            let _ = stdin.write_all(&input);
        });
        let stdout = child.stdout.take().unwrap();
        let stderr = child.stderr.take().unwrap();
        fn capture(mut pipe: impl Read + Send + 'static) -> JoinHandle<Vec<u8>> {
            thread::spawn(move || {
                let mut bytes = Vec::new();
                pipe.read_to_end(&mut bytes).unwrap();
                bytes
            })
        }
        Self {
            child,
            readers: vec![capture(stdout), capture(stderr)],
            writer: Some(writer),
        }
    }

    fn wait(self) -> Output {
        self.wait_with_limit(PROCESS_LIMIT)
    }

    fn wait_with_limit(mut self, limit: Duration) -> Output {
        let started = Instant::now();
        let status = loop {
            if let Some(status) = self.child.try_wait().unwrap() {
                break status;
            }
            if started.elapsed() > limit {
                let _ = self.child.kill();
                let _ = self.child.wait();
                panic!("trex-agent exceeded the {limit:?} process deadline");
            }
            thread::sleep(Duration::from_millis(10));
        };
        self.writer.take().unwrap().join().unwrap();
        let mut readers = self.readers.drain(..);
        Output {
            status,
            stdout: readers.next().unwrap().join().unwrap(),
            stderr: readers.next().unwrap().join().unwrap(),
        }
    }
}

impl Drop for Process {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn run(home: &Path, args: &[&str], input: Vec<u8>) -> Output {
    let mut cmd = command(home);
    cmd.args(args);
    Process::spawn(cmd, input).wait()
}

fn discover(home: &Path, input: Value) -> Output {
    run(
        home,
        &["models", "list", "--json", "--stdin-json"],
        serde_json::to_vec(&input).unwrap(),
    )
}

fn assert_redacted(output: &Output, secrets: &[&str]) {
    for bytes in [&output.stdout, &output.stderr] {
        for secret in secrets {
            assert!(
                !bytes
                    .windows(secret.len())
                    .any(|part| part == secret.as_bytes()),
                "process exposed a synthetic secret or raw upstream body"
            );
        }
    }
}

fn success(output: &Output, models: Value) {
    assert_redacted(output, &[KEY, STORED_KEY, BODY_MARKER]);
    assert!(
        output.status.success(),
        "status={}; stdout={}; stderr={}",
        output.status,
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        output.stderr.is_empty(),
        "unexpected stderr: {:?}",
        output.stderr
    );
    let actual: Value = serde_json::from_slice(&output.stdout).expect("one JSON stdout value");
    assert_eq!(actual, json!({"models":models,"source":"remote"}));
}

fn failure(output: &Output, code: &str) {
    assert_redacted(output, &[KEY, STORED_KEY, BODY_MARKER]);
    assert!(!output.status.success(), "failure must exit nonzero");
    assert!(
        output.stderr.is_empty(),
        "unexpected stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let expected = json!({"error":{"code":code}});
    // Require exactly the compact protocol object, allowing only its line ending.
    assert_eq!(
        String::from_utf8_lossy(&output.stdout).trim_end_matches(['\r', '\n']),
        expected.to_string()
    );
}

#[derive(Clone)]
enum Reply {
    Body {
        status: u16,
        body: Vec<u8>,
        headers: Vec<(String, String)>,
        chunked: bool,
    },
    Disconnect,
    Stall,
    Trickle,
}

impl Reply {
    fn json(value: Value) -> Self {
        Self::bytes(200, serde_json::to_vec(&value).unwrap())
    }
    fn bytes(status: u16, body: Vec<u8>) -> Self {
        Self::Body {
            status,
            body,
            headers: vec![],
            chunked: false,
        }
    }
}

#[derive(Debug)]
struct Request {
    method: String,
    path: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

fn read_request(socket: TcpStream) -> Result<(Request, TcpStream), String> {
    // Winsock may inherit nonblocking mode from the listening socket.
    socket.set_nonblocking(false).map_err(|e| e.to_string())?;
    socket
        .set_read_timeout(Some(Duration::from_secs(1)))
        .map_err(|e| e.to_string())?;
    socket
        .set_write_timeout(Some(Duration::from_secs(2)))
        .map_err(|e| e.to_string())?;
    let mut reader = BufReader::new(socket);
    let mut line = String::new();
    reader.read_line(&mut line).map_err(|e| e.to_string())?;
    let fields: Vec<_> = line.split_whitespace().collect();
    if fields.len() != 3 {
        return Err("invalid HTTP request line".into());
    }
    let method = fields[0].to_owned();
    let path = fields[1].to_owned();
    let mut headers = vec![];
    let mut total = line.len();
    loop {
        line.clear();
        if reader.read_line(&mut line).map_err(|e| e.to_string())? == 0 {
            return Err("EOF in headers".into());
        }
        total += line.len();
        if total > 65536 {
            return Err("oversized request headers".into());
        }
        if line == "\r\n" {
            break;
        }
        let (name, value) = line.split_once(':').ok_or("malformed HTTP header")?;
        headers.push((name.to_ascii_lowercase(), value.trim().to_owned()));
    }
    let length = headers
        .iter()
        .find(|(name, _)| name == "content-length")
        .map(|(_, value)| value.parse::<usize>().map_err(|e| e.to_string()))
        .transpose()?
        .unwrap_or(0);
    if length > 65536 {
        return Err("unexpected large request body".into());
    }
    let mut body = vec![0; length];
    reader.read_exact(&mut body).map_err(|e| e.to_string())?;
    Ok((
        Request {
            method,
            path,
            headers,
            body,
        },
        reader.into_inner(),
    ))
}

fn respond(socket: &mut TcpStream, reply: &Reply) -> std::io::Result<()> {
    match reply {
        Reply::Body {
            status,
            body,
            headers,
            chunked,
        } => {
            write!(
                socket,
                "HTTP/1.1 {status} Mock\r\nContent-Type: application/json\r\nConnection: close\r\n"
            )?;
            for (name, value) in headers {
                write!(socket, "{name}: {value}\r\n")?;
            }
            if *chunked {
                socket.write_all(b"Transfer-Encoding: chunked\r\n\r\n")?;
                for chunk in body.chunks(16384) {
                    write!(socket, "{:x}\r\n", chunk.len())?;
                    socket.write_all(chunk)?;
                    socket.write_all(b"\r\n")?;
                }
                socket.write_all(b"0\r\n\r\n")?;
            } else {
                write!(socket, "Content-Length: {}\r\n\r\n", body.len())?;
                socket.write_all(body)?;
            }
            socket.flush()
        }
        Reply::Trickle => {
            socket.write_all(
                b"HTTP/1.1 200 OK\r\nContent-Length: 1048576\r\nConnection: close\r\n\r\n{",
            )?;
            socket.flush()
        }
        Reply::Disconnect | Reply::Stall => Ok(()),
    }
}

struct MockApi {
    address: SocketAddr,
    requests: Arc<Mutex<Vec<Result<Request, String>>>>,
    stop: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
}

impl MockApi {
    fn new(reply: Reply) -> Self {
        Self::bind("127.0.0.1:0", reply).unwrap()
    }
    fn bind(address: &str, reply: Reply) -> std::io::Result<Self> {
        let listener = TcpListener::bind(address)?;
        let address = listener.local_addr()?;
        listener.set_nonblocking(true)?;
        let requests = Arc::new(Mutex::new(vec![]));
        let recorded = requests.clone();
        let stop = Arc::new(AtomicBool::new(false));
        let stopping = stop.clone();
        let worker = thread::spawn(move || {
            let mut held = Vec::<TcpStream>::new();
            let mut next_byte = Instant::now();
            while !stopping.load(Ordering::SeqCst) {
                match listener.accept() {
                    Ok((socket, _)) => match read_request(socket) {
                        Ok((request, mut socket)) => {
                            recorded.lock().unwrap().push(Ok(request));
                            let _ = respond(&mut socket, &reply);
                            if matches!(reply, Reply::Stall | Reply::Trickle) {
                                held.push(socket);
                            }
                        }
                        Err(error) => recorded.lock().unwrap().push(Err(error)),
                    },
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => (),
                    Err(error) => {
                        recorded.lock().unwrap().push(Err(error.to_string()));
                        break;
                    }
                }
                if matches!(reply, Reply::Trickle) && Instant::now() >= next_byte {
                    held.retain_mut(|socket| {
                        socket.write_all(b" ").and_then(|_| socket.flush()).is_ok()
                    });
                    next_byte = Instant::now() + Duration::from_millis(100);
                }
                thread::sleep(Duration::from_millis(5));
            }
        });
        Ok(Self {
            address,
            requests,
            stop,
            worker: Some(worker),
        })
    }
    fn endpoint(&self) -> String {
        format!("http://{}/v1", self.address)
    }
    fn assert_request(&self, key: Option<&str>) {
        let requests = self.requests.lock().unwrap();
        assert_eq!(
            requests.len(),
            1,
            "expected one request, with no retries: {requests:?}"
        );
        let request = requests[0].as_ref().expect("valid local HTTP request");
        assert_eq!(request.method, "GET");
        assert_eq!(request.path, "/v1/models");
        assert!(request.body.is_empty());
        let auth: Vec<_> = request
            .headers
            .iter()
            .filter(|(name, _)| name == "authorization")
            .map(|(_, value)| value.as_str())
            .collect();
        let expected = key.map(|key| format!("Bearer {key}"));
        assert_eq!(auth, expected.as_deref().into_iter().collect::<Vec<_>>());
    }
    fn assert_quiet(&self) {
        thread::sleep(Duration::from_millis(40));
        assert!(
            self.requests.lock().unwrap().is_empty(),
            "request happened before validation"
        );
    }
}

impl Drop for MockApi {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        self.worker.take().unwrap().join().unwrap();
    }
}

fn request(api: &MockApi, provider: &str) -> Value {
    json!({"provider":provider,"baseUrl":api.endpoint(),"apiKey":KEY})
}

fn one_model() -> Value {
    json!({"data":[{"id":"remote-model"}]})
}
fn expected_one() -> Value {
    json!([{"id":"remote-model","name":"remote-model"}])
}

fn save_profile(home: &Path, provider: &str, endpoint: &str, key: Option<&str>) {
    let mut input = json!({"name":"Saved","provider":provider,"baseUrl":endpoint,"model":"configured-model","effort":"high"});
    if let Some(key) = key {
        input["apiKey"] = json!(key);
    }
    let output = run(
        home,
        &["profiles", "save", "--stdin-json"],
        serde_json::to_vec(&input).unwrap(),
    );
    assert_redacted(&output, &[KEY, STORED_KEY]);
    assert!(
        output.status.success(),
        "profile save failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let saved: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(saved["hasApiKey"], key.is_some());
}

fn snapshot(home: &Path) -> BTreeMap<PathBuf, Vec<u8>> {
    fn walk(root: &Path, path: &Path, files: &mut BTreeMap<PathBuf, Vec<u8>>) {
        if !path.exists() {
            return;
        }
        for entry in fs::read_dir(path).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                walk(root, &path, files);
            } else {
                files.insert(
                    path.strip_prefix(root).unwrap().to_owned(),
                    fs::read(path).unwrap(),
                );
            }
        }
    }
    let root = home.join("private-home");
    let mut files = BTreeMap::new();
    walk(&root, &root, &mut files);
    files
}

#[test]
fn transient_bearer_get_and_normalization_work_for_every_provider_without_a_model() {
    for provider in ["deepseek", "minimax", "openrouter", "custom"] {
        let home = TempDir::new().unwrap();
        let api = MockApi::new(Reply::json(json!({"data":[
            {"id":"mock","display_name":"Mock model","context_length":64000,
             "supportedEfforts":["low","high","high",null],
             "architecture":{"input_modalities":["text","image","text"]}},
            {"id":"unknown"}
        ]})));
        success(
            &discover(home.path(), request(&api, provider)),
            json!([
                {"id":"mock","name":"Mock model","contextWindow":64000,"efforts":["low","high"],"inputModalities":["text","image"]},
                {"id":"unknown","name":"unknown"}
            ]),
        );
        api.assert_request(Some(KEY));
        assert!(
            snapshot(home.path()).is_empty(),
            "transient discovery persisted profile data"
        );
    }
}

#[test]
fn openrouter_filters_only_explicit_non_text_output_and_keeps_unknown_capabilities() {
    let home = TempDir::new().unwrap();
    let api = MockApi::new(Reply::json(json!({"data":[
        {"id":"image-only","architecture":{"output_modalities":["image"]}},
        {"id":"chat","name":"Chat","context_length":32768,"architecture":{"input_modalities":["text","image"],"output_modalities":["text","image"]}},
        {"id":"audio-only","architecture":{"output_modalities":["audio"]}},
        {"id":"unknown","supported_parameters":["reasoning"]}
    ]})));
    success(
        &discover(home.path(), request(&api, "openrouter")),
        json!([
            {"id":"chat","name":"Chat","contextWindow":32768,"inputModalities":["text","image"]},
            {"id":"unknown","name":"unknown"}
        ]),
    );
    api.assert_request(Some(KEY));
}

#[test]
fn loopback_without_a_key_and_explicit_empty_key_are_allowed() {
    let home = TempDir::new().unwrap();
    for key in [None, Some("")] {
        let api = MockApi::new(Reply::json(one_model()));
        let mut input = json!({"provider":"custom","baseUrl":api.endpoint()});
        if let Some(key) = key {
            input["apiKey"] = json!(key);
        }
        success(&discover(home.path(), input), expected_one());
        api.assert_request(None);
    }
}

#[test]
fn named_keyless_profile_reuses_canonical_endpoint_without_mutation() {
    let home = TempDir::new().unwrap();
    let api = MockApi::new(Reply::json(one_model()));
    save_profile(home.path(), "custom", &format!("{}/", api.endpoint()), None);
    let before = snapshot(home.path());
    success(
        &discover(
            home.path(),
            json!({"name":"Saved","provider":"custom","baseUrl":api.endpoint()}),
        ),
        expected_one(),
    );
    api.assert_request(None);
    assert_eq!(snapshot(home.path()), before);
}

#[test]
fn mismatched_saved_provider_or_endpoint_is_rejected_before_http() {
    for change in ["provider", "port", "path"] {
        let home = TempDir::new().unwrap();
        let saved_api = MockApi::new(Reply::json(one_model()));
        let other_api = MockApi::new(Reply::json(one_model()));
        save_profile(home.path(), "custom", &saved_api.endpoint(), None);
        let before = snapshot(home.path());
        let mut input = json!({"name":"Saved","provider":"custom","baseUrl":saved_api.endpoint()});
        match change {
            "provider" => input["provider"] = json!("deepseek"),
            "port" => input["baseUrl"] = json!(other_api.endpoint()),
            _ => input["baseUrl"] = json!(format!("{}/different", saved_api.endpoint())),
        }
        failure(&discover(home.path(), input), "invalid_request");
        saved_api.assert_quiet();
        other_api.assert_quiet();
        assert_eq!(snapshot(home.path()), before);
    }
}

#[test]
fn explicit_key_skips_all_saved_metadata_even_when_home_is_unreadable() {
    let home = TempDir::new().unwrap();
    // A regular file where the profile directory should be makes every load fail.
    fs::write(home.path().join("private-home"), b"not a profile directory").unwrap();
    for key in [KEY, ""] {
        let api = MockApi::new(Reply::json(one_model()));
        let input =
            json!({"name":"nonexistent","provider":"custom","baseUrl":api.endpoint(),"apiKey":key});
        success(&discover(home.path(), input), expected_one());
        api.assert_request(if key.is_empty() { None } else { Some(KEY) });
        assert_eq!(
            fs::read(home.path().join("private-home")).unwrap(),
            b"not a profile directory"
        );
    }
}

#[cfg(windows)]
fn credential_path(home: &Path) -> PathBuf {
    let root = home.join("private-home");
    let config: Value =
        serde_json::from_slice(&fs::read(root.join("profiles.json")).unwrap()).unwrap();
    root.join("credentials").join(format!(
        "{}.dpapi",
        config["profiles"][0]["credentialId"].as_str().unwrap()
    ))
}

#[cfg(windows)]
#[test]
fn saved_dpapi_key_is_reused_for_host_case_and_trailing_slash_equivalence() {
    for trailing in ["", "/", "////"] {
        let home = TempDir::new().unwrap();
        let api = MockApi::new(Reply::json(one_model()));
        let saved = format!("http://LOCALHOST:{}/v1/", api.address.port());
        save_profile(home.path(), "custom", &saved, Some(STORED_KEY));
        let before = snapshot(home.path());
        let cipher = fs::read(credential_path(home.path())).unwrap();
        assert!(!cipher.is_empty());
        assert!(!cipher
            .windows(STORED_KEY.len())
            .any(|bytes| bytes == STORED_KEY.as_bytes()));
        assert!(before.values().all(|bytes| !bytes
            .windows(STORED_KEY.len())
            .any(|part| part == STORED_KEY.as_bytes())));
        success(
            &discover(
                home.path(),
                json!({"name":"Saved","provider":"custom",
            "baseUrl":format!("http://localhost:{}/v1{trailing}", api.address.port())}),
            ),
            expected_one(),
        );
        api.assert_request(Some(STORED_KEY));
        assert_eq!(snapshot(home.path()), before);
    }
}

#[cfg(windows)]
#[test]
fn saved_key_default_http_port_is_equivalent_when_port_80_is_available() {
    let Ok(api) = MockApi::bind("127.0.0.1:80", Reply::json(one_model())) else {
        eprintln!("port 80 unavailable; default-port equivalence case skipped");
        return;
    };
    let home = TempDir::new().unwrap();
    save_profile(
        home.path(),
        "custom",
        "http://127.0.0.1:80/v1/",
        Some(STORED_KEY),
    );
    let before = snapshot(home.path());
    success(
        &discover(
            home.path(),
            json!({"name":"Saved","provider":"custom","baseUrl":"http://127.0.0.1/v1"}),
        ),
        expected_one(),
    );
    api.assert_request(Some(STORED_KEY));
    assert_eq!(snapshot(home.path()), before);
}

#[cfg(windows)]
#[test]
fn transient_key_overrides_saved_key_and_changed_endpoint_without_reading_dpapi() {
    use std::os::windows::fs::OpenOptionsExt;
    let home = TempDir::new().unwrap();
    let saved_api = MockApi::new(Reply::json(one_model()));
    save_profile(
        home.path(),
        "custom",
        &saved_api.endpoint(),
        Some(STORED_KEY),
    );
    let before = snapshot(home.path());
    // No sharing: any attempt by the CLI to read the encrypted key must fail.
    let locked = fs::OpenOptions::new()
        .read(true)
        .share_mode(0)
        .open(credential_path(home.path()))
        .unwrap();
    success(
        &discover(
            home.path(),
            json!({"name":"Saved","provider":"custom","baseUrl":saved_api.endpoint(),"apiKey":KEY}),
        ),
        expected_one(),
    );
    saved_api.assert_request(Some(KEY));
    let changed_api = MockApi::new(Reply::json(one_model()));
    success(
        &discover(
            home.path(),
            json!({"name":"Saved","provider":"deepseek","baseUrl":changed_api.endpoint(),"apiKey":KEY}),
        ),
        expected_one(),
    );
    changed_api.assert_request(Some(KEY));
    saved_api.assert_request(Some(KEY));
    let empty_api = MockApi::new(Reply::json(one_model()));
    success(
        &discover(
            home.path(),
            json!({"name":"Saved","provider":"custom","baseUrl":empty_api.endpoint(),"apiKey":""}),
        ),
        expected_one(),
    );
    empty_api.assert_request(None);
    drop(locked);
    assert_eq!(snapshot(home.path()), before);
}

#[cfg(windows)]
#[test]
fn saved_key_failures_are_redacted_and_leave_profile_and_ciphertext_unchanged() {
    use std::os::windows::fs::OpenOptionsExt;
    for reply in [
        Reply::json(json!({"data":[{"id":"safe","name":format!("echo-{STORED_KEY}")}]})),
        Reply::bytes(401, format!("{BODY_MARKER}:{STORED_KEY}").into_bytes()),
    ] {
        let home = TempDir::new().unwrap();
        let code = if matches!(reply, Reply::Body { status: 401, .. }) {
            "unauthorized"
        } else {
            "invalid_response"
        };
        let api = MockApi::new(reply);
        save_profile(home.path(), "custom", &api.endpoint(), Some(STORED_KEY));
        let before = snapshot(home.path());
        failure(
            &discover(
                home.path(),
                json!({"name":"Saved","provider":"custom","baseUrl":api.endpoint()}),
            ),
            code,
        );
        api.assert_request(Some(STORED_KEY));
        assert_eq!(snapshot(home.path()), before);
    }
    let home = TempDir::new().unwrap();
    let api = MockApi::new(Reply::json(one_model()));
    let other = MockApi::new(Reply::json(one_model()));
    save_profile(home.path(), "custom", &api.endpoint(), Some(STORED_KEY));
    let before = snapshot(home.path());
    let locked = fs::OpenOptions::new()
        .read(true)
        .share_mode(0)
        .open(credential_path(home.path()))
        .unwrap();
    for input in [
        json!({"name":"Saved","provider":"minimax","baseUrl":api.endpoint()}),
        json!({"name":"Saved","provider":"custom","baseUrl":other.endpoint()}),
    ] {
        failure(&discover(home.path(), input), "invalid_request");
    }
    api.assert_quiet();
    other.assert_quiet();
    drop(locked);
    assert_eq!(snapshot(home.path()), before);
}

#[test]
fn http_failures_have_finite_codes_and_never_print_upstream_body() {
    for (status, code) in [
        (401, "unauthorized"),
        (403, "forbidden"),
        (404, "unsupported"),
        (405, "unsupported"),
        (501, "unsupported"),
        (500, "unavailable"),
        (502, "unavailable"),
    ] {
        let home = TempDir::new().unwrap();
        let api = MockApi::new(Reply::bytes(
            status,
            format!("{BODY_MARKER}: {KEY}").into_bytes(),
        ));
        failure(&discover(home.path(), request(&api, "custom")), code);
        api.assert_request(Some(KEY));
    }
}

#[test]
fn redirects_are_unsupported_and_never_followed() {
    for status in [301, 302, 303, 307, 308] {
        let home = TempDir::new().unwrap();
        let target = MockApi::new(Reply::json(one_model()));
        let api = MockApi::new(Reply::Body {
            status,
            body: vec![],
            chunked: false,
            headers: vec![("Location".into(), format!("{}/models", target.endpoint()))],
        });
        failure(
            &discover(home.path(), request(&api, "custom")),
            "unsupported",
        );
        api.assert_request(Some(KEY));
        target.assert_quiet();
    }
}

#[test]
fn disconnected_or_refused_connections_are_unavailable_without_retries() {
    let home = TempDir::new().unwrap();
    let api = MockApi::new(Reply::Disconnect);
    failure(
        &discover(home.path(), request(&api, "custom")),
        "unavailable",
    );
    api.assert_request(Some(KEY));
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    drop(listener);
    failure(
        &discover(
            home.path(),
            json!({"provider":"custom","baseUrl":format!("http://{address}/v1"),"apiKey":KEY}),
        ),
        "unavailable",
    );
}

#[test]
fn malformed_catalogs_and_empty_or_invalid_ids_are_invalid_response() {
    let bodies = [
        b"not JSON".to_vec(),
        serde_json::to_vec(&json!({"other":[]})).unwrap(),
        serde_json::to_vec(&json!({"data":{}})).unwrap(),
        serde_json::to_vec(&json!({"data":[]})).unwrap(),
        serde_json::to_vec(&json!({"data":[{}]})).unwrap(),
        serde_json::to_vec(&json!({"data":[{"id":42}]})).unwrap(),
        serde_json::to_vec(&json!({"data":[{"id":""}]})).unwrap(),
        serde_json::to_vec(&json!({"data":[{"id":" "}]})).unwrap(),
        serde_json::to_vec(&json!({"data":[{"id":" good"}]})).unwrap(),
        serde_json::to_vec(&json!({"data":[{"id":"bad\nmodel"}]})).unwrap(),
        serde_json::to_vec(&json!({"data":[{"id":"good"},null]})).unwrap(),
    ];
    for body in bodies {
        let home = TempDir::new().unwrap();
        let api = MockApi::new(Reply::bytes(200, body));
        failure(
            &discover(home.path(), request(&api, "custom")),
            "invalid_response",
        );
        api.assert_request(Some(KEY));
    }
    let home = TempDir::new().unwrap();
    let api = MockApi::new(Reply::json(
        json!({"data":[{"id":"image","architecture":{"output_modalities":["image"]}}]}),
    ));
    failure(
        &discover(home.path(), request(&api, "openrouter")),
        "invalid_response",
    );
    api.assert_request(Some(KEY));
}

#[test]
fn provider_business_errors_cannot_become_success_even_with_a_data_array() {
    for extra in [
        json!({"error":{"message":BODY_MARKER}}),
        json!({"error":false}),
        json!({"base_resp":{"status_code":1008,"status_msg":BODY_MARKER}}),
        json!({"base_resp":{"status_code":"0"}}),
        json!({"base_resp":{}}),
        json!({"base_resp":null}),
    ] {
        let home = TempDir::new().unwrap();
        let mut body = one_model();
        body.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        let api = MockApi::new(Reply::json(body));
        failure(
            &discover(home.path(), request(&api, "minimax")),
            "invalid_response",
        );
        api.assert_request(Some(KEY));
    }
    let home = TempDir::new().unwrap();
    let api = MockApi::new(Reply::json(
        json!({"data":[{"id":"remote-model"}],"error":null,"base_resp":{"status_code":0}}),
    ));
    success(
        &discover(home.path(), request(&api, "minimax")),
        expected_one(),
    );
    api.assert_request(Some(KEY));
}

#[test]
fn invalid_input_types_unknown_fields_and_profile_flag_conflict_are_invalid_request() {
    let home = TempDir::new().unwrap();
    let api = MockApi::new(Reply::json(one_model()));
    for input in [
        Value::Null,
        json!([]),
        json!({}),
        json!({"provider":"other","baseUrl":api.endpoint(),"apiKey":KEY}),
        json!({"provider":"custom"}),
        json!({"provider":42}),
        json!({"provider":"custom","baseUrl":null}),
        json!({"provider":"custom","baseUrl":api.endpoint(),"name":null}),
        json!({"provider":"custom","baseUrl":api.endpoint(),"name":42}),
        json!({"provider":"custom","baseUrl":api.endpoint(),"name":""}),
        json!({"provider":"custom","baseUrl":api.endpoint(),"name":"bad\nname"}),
        json!({"provider":"custom","baseUrl":api.endpoint(),"apiKey":null}),
        json!({"provider":"custom","baseUrl":api.endpoint(),"apiKey":42}),
        json!({"provider":"custom","baseUrl":api.endpoint(),"model":"unneeded","apiKey":KEY}),
        json!({"provider":"custom","baseUrl":api.endpoint(),"unknown":true,"apiKey":KEY}),
        json!({"provider":"custom","baseUrl":api.endpoint(),"apiKey":"bad key"}),
        json!({"provider":"custom","baseUrl":api.endpoint(),"apiKey":"bad\nkey"}),
    ] {
        failure(&discover(home.path(), input), "invalid_request");
    }
    for bytes in [b"".as_slice(), b"{", b"{} {}", b"\xff"] {
        failure(
            &run(
                home.path(),
                &["models", "list", "--json", "--stdin-json"],
                bytes.to_vec(),
            ),
            "invalid_request",
        );
    }
    failure(
        &run(
            home.path(),
            &[
                "--profile",
                "Saved",
                "models",
                "list",
                "--json",
                "--stdin-json",
            ],
            serde_json::to_vec(&request(&api, "custom")).unwrap(),
        ),
        "invalid_request",
    );
    api.assert_quiet();
}

#[test]
fn unsafe_urls_and_missing_nonloopback_key_fail_before_http() {
    let home = TempDir::new().unwrap();
    let api = MockApi::new(Reply::json(one_model()));
    for url in [
        "http://catalog.invalid/v1".to_owned(),
        "ftp://127.0.0.1/v1".into(),
        "file:///models".into(),
        format!("http://{KEY}@{}/v1", api.address),
        format!("{}?key={KEY}", api.endpoint()),
        format!("{}#{KEY}", api.endpoint()),
        format!("{}\\models", api.endpoint()),
        "not a URL".into(),
    ] {
        failure(
            &discover(
                home.path(),
                json!({"provider":"custom","baseUrl":url,"apiKey":KEY}),
            ),
            "invalid_request",
        );
    }
    failure(
        &discover(
            home.path(),
            json!({"provider":"custom","baseUrl":"https://catalog.invalid/v1"}),
        ),
        "invalid_request",
    );
    api.assert_quiet();
}

#[test]
fn stdin_limit_accepts_exactly_one_mib_and_rejects_one_byte_more() {
    let home = TempDir::new().unwrap();
    let api = MockApi::new(Reply::json(one_model()));
    let mut input = serde_json::to_vec(&request(&api, "custom")).unwrap();
    input.resize(MIB, b' ');
    success(
        &run(
            home.path(),
            &["models", "list", "--json", "--stdin-json"],
            input.clone(),
        ),
        expected_one(),
    );
    api.assert_request(Some(KEY));
    let quiet = MockApi::new(Reply::json(one_model()));
    let mut oversized = serde_json::to_vec(&request(&quiet, "custom")).unwrap();
    oversized.resize(MIB + 1, b' ');
    failure(
        &run(
            home.path(),
            &["models", "list", "--json", "--stdin-json"],
            oversized,
        ),
        "invalid_request",
    );
    quiet.assert_quiet();
}

#[test]
fn raw_response_limit_is_four_mib_for_known_length_and_chunked_bodies() {
    for chunked in [false, true] {
        let home = TempDir::new().unwrap();
        let mut exact = serde_json::to_vec(&one_model()).unwrap();
        exact.resize(4 * MIB, b' ');
        let api = MockApi::new(Reply::Body {
            status: 200,
            body: exact,
            headers: vec![],
            chunked,
        });
        success(
            &discover(home.path(), request(&api, "custom")),
            expected_one(),
        );
        api.assert_request(Some(KEY));
        let mut oversized = serde_json::to_vec(&one_model()).unwrap();
        oversized.resize(4 * MIB + 1, b' ');
        let api = MockApi::new(Reply::Body {
            status: 200,
            body: oversized,
            headers: vec![],
            chunked,
        });
        failure(
            &discover(home.path(), request(&api, "custom")),
            "invalid_response",
        );
        api.assert_request(Some(KEY));
    }
}

#[test]
fn normalized_output_over_one_mib_is_rejected_even_when_raw_body_is_under_four_mib() {
    let home = TempDir::new().unwrap();
    let models: Vec<_> = (0..600)
        .map(|id| json!({"id":format!("model-{id}"),"name":"N".repeat(2000)}))
        .collect();
    let body = json!({"data":models});
    assert!(serde_json::to_vec(&body).unwrap().len() < 4 * MIB);
    let api = MockApi::new(Reply::json(body));
    failure(
        &discover(home.path(), request(&api, "custom")),
        "invalid_response",
    );
    api.assert_request(Some(KEY));
}

#[test]
fn model_count_and_metadata_bounds_are_enforced() {
    for data in [
        json!([{"id":"x".repeat(1025)}]),
        json!([{"id":"ok","name":"n".repeat(2049)}]),
        json!([{"id":"ok","name":"bad\nname"}]),
        json!([{"id":"ok","efforts":(0..65).map(|id| format!("level-{id}")).collect::<Vec<_>>()}]),
        json!([{"id":"ok","inputModalities":["m".repeat(129)]}]),
        json!([{"id":"ok","contextWindow":9007199254740992_u64}]),
        json!((0..4097)
            .map(|id| json!({"id":format!("m{id}")}))
            .collect::<Vec<_>>()),
    ] {
        let home = TempDir::new().unwrap();
        let api = MockApi::new(Reply::json(json!({"data":data})));
        failure(
            &discover(home.path(), request(&api, "custom")),
            "invalid_response",
        );
        api.assert_request(Some(KEY));
    }
}

#[test]
fn model_count_and_metadata_upper_boundaries_remain_valid() {
    let home = TempDir::new().unwrap();
    let models: Vec<_> = (0..4096)
        .map(|id| json!({"id":format!("model-{id}"),"name":format!("model-{id}")}))
        .collect();
    let api = MockApi::new(Reply::json(json!({"data":models})));
    success(
        &discover(home.path(), request(&api, "custom")),
        json!(models),
    );
    api.assert_request(Some(KEY));
    let strings: Vec<_> = (0..64)
        .map(|id| format!("{}{:03}", "s".repeat(125), id))
        .collect();
    let model = json!({"id":"i".repeat(1024),"name":"n".repeat(2048),
        "contextWindow":9007199254740991_u64,"efforts":strings,"inputModalities":strings});
    let api = MockApi::new(Reply::json(json!({"data":[model]})));
    success(
        &discover(home.path(), request(&api, "custom")),
        json!([model]),
    );
    api.assert_request(Some(KEY));
}

#[test]
fn effective_key_echoes_in_every_accepted_model_field_are_rejected() {
    for field in [
        "id",
        "name",
        "displayName",
        "display_name",
        "efforts",
        "inputModalities",
    ] {
        let home = TempDir::new().unwrap();
        let mut model = json!({"id":"safe"});
        model[field] = if matches!(field, "efforts" | "inputModalities") {
            json!([format!("prefix-{KEY}-suffix")])
        } else {
            json!(format!("prefix-{KEY}-suffix"))
        };
        let api = MockApi::new(Reply::json(json!({"data":[model]})));
        failure(
            &discover(home.path(), request(&api, "custom")),
            "invalid_response",
        );
        api.assert_request(Some(KEY));
    }
    let home = TempDir::new().unwrap();
    let api = MockApi::new(Reply::bytes(
        200,
        format!("{{invalid:{KEY}:{BODY_MARKER}}}").into_bytes(),
    ));
    failure(
        &discover(home.path(), request(&api, "custom")),
        "invalid_response",
    );
    api.assert_request(Some(KEY));
}

fn set_metadata(model: &mut Value, path: &str, value: Value) {
    let mut parent = model;
    let mut fields = path.trim_start_matches('/').split('/').peekable();
    while let Some(field) = fields.next() {
        if fields.peek().is_none() {
            parent[field] = value;
            return;
        }
        let object = parent
            .as_object_mut()
            .expect("metadata parent is an object");
        parent = object.entry(field).or_insert_with(|| json!({}));
    }
    panic!("metadata path must not be empty");
}

fn assert_fast_metadata_rejection(path: &str, entries: Vec<String>) {
    let home = TempDir::new().unwrap();
    let mut model = json!({"id":"safe"});
    set_metadata(&mut model, path, json!(entries));
    let body = serde_json::to_vec(&json!({"data":[model]})).unwrap();
    // This must exercise metadata preflight, rather than the 4 MiB body cap.
    assert!(body.len() < 4 * MIB, "fixture exceeds raw response limit");
    let api = MockApi::new(Reply::bytes(200, body));
    let mut cmd = command(home.path());
    cmd.args(["models", "list", "--json", "--stdin-json"]);
    // Three seconds of work plus one second for process startup/scheduling.
    // The shorter process deadline also kills the former quadratic loop promptly.
    let limit = Duration::from_secs(4);
    let started = Instant::now();
    let output = Process::spawn(
        cmd,
        serde_json::to_vec(&request(&api, "openrouter")).unwrap(),
    )
    .wait_with_limit(limit);
    assert!(
        started.elapsed() < limit,
        "metadata rejection was too slow at {path}"
    );
    failure(&output, "invalid_response");
    api.assert_request(Some(KEY));
}

#[test]
fn hostile_distinct_metadata_rejects_before_quadratic_normalization() {
    for path in [
        "/efforts",
        "/capabilities/reasoning/supported_efforts",
        "/architecture/input_modalities",
        "/architecture/output_modalities",
    ] {
        let mut entries: Vec<_> = (0..100_000).map(|id| format!("effort-{id:06}")).collect();
        if path == "/architecture/output_modalities" {
            // Keep the model eligible for text output, so filtering alone
            // cannot make the oversized output metadata case pass.
            entries[0] = "text".into();
        }
        assert_fast_metadata_rejection(path, entries);
    }
}

#[test]
fn hostile_duplicate_metadata_rejects_raw_entries_before_deduplication() {
    for path in [
        "/efforts",
        "/capabilities/effort/supported_levels",
        "/capabilities/input_modalities",
        "/architecture/output_modalities",
    ] {
        let entry = if path == "/architecture/output_modalities" {
            "text"
        } else {
            "effort-000000"
        };
        assert_fast_metadata_rejection(path, vec![entry.to_owned(); 100_000]);
    }
}

#[test]
fn every_recognized_metadata_alias_obeys_raw_limit_even_when_shadowed() {
    for path in [
        "/efforts",
        "/supportedEfforts",
        "/supported_efforts",
        "/effort/supported_levels",
        "/reasoning/supported_efforts",
        "/reasoning/supportedEfforts",
        "/capabilities/efforts",
        "/capabilities/supportedEfforts",
        "/capabilities/supported_efforts",
        "/capabilities/reasoningEfforts",
        "/capabilities/reasoning_efforts",
        "/capabilities/reasoning/supported_efforts",
        "/capabilities/reasoning/supportedEfforts",
        "/capabilities/reasoning/efforts",
        "/capabilities/effort/supported_levels",
        "/inputModalities",
        "/input_modalities",
        "/architecture/input_modalities",
        "/capabilities/inputModalities",
        "/capabilities/input_modalities",
        "/architecture/output_modalities",
    ] {
        for entries in [
            json!(vec!["text"; 65]),
            json!(vec![Value::Null; 65]),
            json!(vec![" "; 65]),
        ] {
            let home = TempDir::new().unwrap();
            // Empty higher precedence effort metadata still shadows nested
            // aliases. Null/blank entries count toward the raw-entry limit.
            let mut model = json!({"id":"safe","efforts":[],"inputModalities":["text"],
                "architecture":{"output_modalities":["text"]}});
            set_metadata(&mut model, path, entries);
            let api = MockApi::new(Reply::json(json!({"data":[model]})));
            let output = discover(home.path(), request(&api, "openrouter"));
            assert!(
                !output.status.success(),
                "oversized raw metadata accepted at {path}"
            );
            failure(&output, "invalid_response");
            api.assert_request(Some(KEY));
        }
    }
}

#[test]
fn numeric_effective_key_cannot_escape_through_normalized_context_window() {
    const NUMERIC_KEY: &str = "1234567890123456";
    for path in [
        "/contextWindow",
        "/context_window",
        "/context_length",
        "/contextLength",
        "/capabilities/contextWindow",
        "/capabilities/context_window",
        "/capabilities/context_length",
    ] {
        let home = TempDir::new().unwrap();
        let mut model = json!({"id":"safe"});
        // A valid JS-safe integer, so numeric validation must not hide a
        // credential leak that string-only checks previously missed.
        set_metadata(&mut model, path, json!(1_234_567_890_123_456_u64));
        let api = MockApi::new(Reply::json(json!({"data":[model]})));
        let output = discover(
            home.path(),
            json!({"provider":"custom","baseUrl":api.endpoint(),"apiKey":NUMERIC_KEY}),
        );
        assert_redacted(&output, &[NUMERIC_KEY]);
        failure(&output, "invalid_response");
        api.assert_request(Some(NUMERIC_KEY));
    }
}

#[test]
fn large_context_number_is_valid_without_matching_effective_key() {
    let home = TempDir::new().unwrap();
    let api = MockApi::new(Reply::json(
        json!({"data":[{"id":"safe","contextWindow":1_234_567_890_123_456_u64}]}),
    ));
    success(
        &discover(home.path(), request(&api, "custom")),
        json!([{"id":"safe","name":"safe","contextWindow":1_234_567_890_123_456_u64}]),
    );
    api.assert_request(Some(KEY));
}

#[test]
fn json_escaped_effective_key_is_rejected_after_metadata_decoding() {
    const ESCAPED_KEY: &str = r#"synthetic-\key-"catalog-3817"#;
    let encoded = serde_json::to_string(ESCAPED_KEY).unwrap();
    for field in ["id", "name"] {
        let home = TempDir::new().unwrap();
        let mut model = json!({"id":"safe"});
        model[field] = json!(format!("prefix-{ESCAPED_KEY}-suffix"));
        let body = serde_json::to_vec(&json!({"data":[model]})).unwrap();
        assert!(!body
            .windows(ESCAPED_KEY.len())
            .any(|bytes| bytes == ESCAPED_KEY.as_bytes()));
        let api = MockApi::new(Reply::bytes(200, body));
        let output = discover(
            home.path(),
            json!({"provider":"custom","baseUrl":api.endpoint(),"apiKey":ESCAPED_KEY}),
        );
        assert_redacted(&output, &[ESCAPED_KEY, encoded.trim_matches('"')]);
        failure(&output, "invalid_response");
        api.assert_request(Some(ESCAPED_KEY));
    }
}

#[test]
fn stalled_headers_obey_ten_second_total_request_limit() {
    assert_timeout(Reply::Stall);
}

#[test]
fn continuously_trickling_body_obeys_ten_second_total_request_limit() {
    assert_timeout(Reply::Trickle);
}

fn assert_timeout(reply: Reply) {
    let home = TempDir::new().unwrap();
    let api = MockApi::new(reply);
    let started = Instant::now();
    let output = discover(home.path(), request(&api, "custom"));
    let elapsed = started.elapsed();
    failure(&output, "unavailable");
    assert!(
        elapsed >= Duration::from_secs(9),
        "timeout fired too early: {elapsed:?}"
    );
    assert!(
        elapsed < Duration::from_secs(13),
        "10 second HTTP total timeout exceeded margin: {elapsed:?}"
    );
    api.assert_request(Some(KEY));
}

#[test]
fn legacy_custom_404_without_stdin_still_uses_configured_model() {
    let home = TempDir::new().unwrap();
    let api = MockApi::new(Reply::bytes(404, vec![]));
    save_profile(home.path(), "custom", &api.endpoint(), None);
    let output = run(
        home.path(),
        &["--profile", "Saved", "models", "list", "--json"],
        vec![],
    );
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        serde_json::from_slice::<Value>(&output.stdout).unwrap(),
        json!({"models":[{"id":"configured-model","name":"configured-model"}]})
    );
    api.assert_request(None);
}
