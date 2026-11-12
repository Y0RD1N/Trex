//! HyperFrames (HTML rendered to video) as structured tools: project info, built-in docs, doctor,
//! the check gate, snapshots the model can LOOK at, render, a background preview and init.
//!
//! The CLI is run directly (no shell), with its own environment: no telemetry, no update checks,
//! no automatic installs, no colour. Trex never downloads or updates HyperFrames; cloud, publish
//! and sign-in commands are not exposed. A tool whose outcome is unknown after a cancel or a
//! timeout reports it as uncertain instead of being retried.
use crate::blender::{is_executable, versioned_dirs};
use crate::tools::{spawn_owned_command, stop_process, ToolFuture, ToolProvider};
use anyhow::{bail, ensure, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Map, Value};
use std::{
    path::{Component, Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::{io::AsyncReadExt, process::Command};
use tokio_util::sync::CancellationToken;

const READ: &[&str] = &["hyperframes_project", "hyperframes_docs", "hyperframes_doctor", "hyperframes_check"];
const MAX_STDOUT: usize = 2 * 1024 * 1024;
const STDERR_TAIL: usize = 6 * 1024;
const TEXT_CAP: usize = 24 * 1024;
const INSTALL_GUIDE: &str = "https://hyperframes.heygen.com/packages/cli";
const MAX_IMAGE_EDGE: u32 = 1568;

#[derive(Debug)]
pub struct HyperframesUncertain;
impl std::fmt::Display for HyperframesUncertain {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("HyperFrames may have changed files or started a process; inspect the project (hyperframes_project, hyperframes_preview status) before continuing. Do not automatically retry.")
    }
}
impl std::error::Error for HyperframesUncertain {}

pub fn read_only(name: &str) -> bool {
    READ.contains(&name)
}
pub(crate) fn available(root: &Path) -> bool {
    find_cli(root).is_some()
}

// ----------------------------------------------------------------------------- discovery
fn home() -> Option<PathBuf> {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from).filter(|p| p.is_absolute())
}
fn bin_name(base: &str) -> String {
    if cfg!(windows) {
        if base == "node" { "node.exe".into() } else { format!("{base}.cmd") }
    } else {
        base.into()
    }
}
/// Where a global npm/pnpm/bun/volta/nvm/mise/fnm install usually puts its binaries. The app may be
/// started from a launcher that never saw the shell's PATH, so these are searched explicitly.
fn global_bin_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Some(home) = home() {
        for relative in [".local/bin", ".npm-global/bin", ".bun/bin", ".volta/bin", ".local/share/pnpm", ".local/share/mise/shims", ".asdf/shims"] {
            dirs.push(home.join(relative));
        }
        for (base, suffix) in [
            (".local/share/mise/installs/node", "bin"),
            (".nvm/versions/node", "bin"),
            (".local/share/fnm/node-versions", "installation/bin"),
            (".asdf/installs/nodejs", "bin"),
        ] {
            for version in versioned_dirs(&home.join(base), "") {
                dirs.push(version.join(suffix));
            }
        }
    }
    #[cfg(windows)]
    for var in ["APPDATA", "LOCALAPPDATA"] {
        if let Some(base) = std::env::var_os(var).map(PathBuf::from).filter(|p| p.is_absolute()) {
            dirs.push(base.join("npm"));
            dirs.push(base.join("pnpm"));
        }
    }
    #[cfg(target_os = "macos")]
    {
        dirs.push(PathBuf::from("/opt/homebrew/bin"));
        dirs.push(PathBuf::from("/usr/local/bin"));
    }
    dirs
}
fn path_dirs() -> Vec<PathBuf> {
    std::env::var_os("PATH").map(|value| std::env::split_paths(&value).filter(|p| p.is_absolute()).collect()).unwrap_or_default()
}
/// The project's own install first, then PATH, then the usual global locations.
pub(crate) fn find_cli(root: &Path) -> Option<PathBuf> {
    let name = bin_name("hyperframes");
    std::iter::once(root.join("node_modules/.bin")).chain(path_dirs()).chain(global_bin_dirs()).map(|dir| dir.join(&name)).find(|path| is_executable(path))
}
/// Folders with a `node` binary, so the CLI's `#!/usr/bin/env node` works from any launcher.
fn node_dirs() -> Vec<PathBuf> {
    let name = bin_name("node");
    path_dirs().into_iter().chain(global_bin_dirs()).filter(|dir| is_executable(&dir.join(&name))).collect()
}
fn configure(command: &mut Command, cli: &Path) {
    command
        .env("HYPERFRAMES_NO_UPDATE_CHECK", "1")
        .env("HYPERFRAMES_NO_TELEMETRY", "1")
        .env("HYPERFRAMES_NO_AUTO_INSTALL", "1")
        .env("HYPERFRAMES_AGENT", "1")
        .env("HYPERFRAMES_SKIP_SKILLS", "1")
        .env("NO_COLOR", "1")
        .env_remove("FORCE_COLOR");
    let mut paths: Vec<PathBuf> = cli.parent().map(Path::to_path_buf).into_iter().chain(node_dirs()).collect();
    paths.extend(path_dirs());
    if let Ok(joined) = std::env::join_paths(paths) {
        command.env("PATH", joined);
    }
}

// ----------------------------------------------------------------------------- running
struct Finished {
    code: Option<i32>,
    stdout: String,
    stderr: String,
}
pub(crate) async fn read_capped(mut pipe: impl tokio::io::AsyncRead + Unpin, cap: usize) -> Vec<u8> {
    let (mut kept, mut buffer) = (Vec::new(), [0u8; 8192]);
    while let Ok(n) = pipe.read(&mut buffer).await {
        if n == 0 {
            break;
        }
        let take = n.min(cap.saturating_sub(kept.len()));
        kept.extend_from_slice(&buffer[..take]); // keep draining so a full pipe never blocks the child
    }
    kept
}
pub(crate) async fn read_tail(mut pipe: impl tokio::io::AsyncRead + Unpin, keep: usize) -> Vec<u8> {
    let (mut tail, mut buffer) = (Vec::<u8>::new(), [0u8; 8192]);
    while let Ok(n) = pipe.read(&mut buffer).await {
        if n == 0 {
            break;
        }
        tail.extend_from_slice(&buffer[..n]);
        if tail.len() > keep * 2 {
            tail.drain(..tail.len() - keep);
        }
    }
    if tail.len() > keep {
        tail.drain(..tail.len() - keep);
    }
    tail
}
/// Run the CLI in `cwd`. A cancel or timeout stops the whole process tree (Chrome included); for a
/// tool that changes things that is "uncertain", for a read it is an ordinary failure.
async fn run(cli: &Path, cwd: &Path, args: &[String], limit: Duration, cancel: &CancellationToken, changes_things: bool) -> Result<Finished> {
    ensure!(!cancel.is_cancelled(), "cancelled before HyperFrames started");
    let mut command = Command::new(cli);
    command.args(args).current_dir(cwd).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    configure(&mut command, cli);
    // After `check` the CLI keeps a warm Chrome helper alive for five minutes unless it sees CI; that is
    // memory per project for a saving of about a second, so `check` runs as if in CI.
    if args.first().is_some_and(|a| a == "check") {
        command.env("CI", "1");
    }
    let (mut child, mut guard) = spawn_owned_command(command).context("could not start the HyperFrames CLI")?;
    let out = child.stdout.take().context("stdout unavailable")?;
    let err = child.stderr.take().context("stderr unavailable")?;
    let reader = tokio::spawn(read_capped(out, MAX_STDOUT));
    let tail = tokio::spawn(read_tail(err, STDERR_TAIL));
    let waited = tokio::select! {
        biased;
        _ = cancel.cancelled() => Err("was interrupted"),
        _ = tokio::time::sleep(limit) => Err("timed out"),
        status = child.wait() => Ok(status),
    };
    match waited {
        Err(reason) => {
            stop_process(&mut child, &mut guard).await;
            if changes_things {
                return Err(HyperframesUncertain.into());
            }
            bail!("the HyperFrames command {reason}");
        }
        Ok(status) => {
            let code = status?.code();
            let stdout = String::from_utf8_lossy(&reader.await?).into_owned();
            let stderr = String::from_utf8_lossy(&tail.await?).into_owned();
            Ok(Finished { code, stdout, stderr })
        }
    }
}
fn args(items: &[&str]) -> Vec<String> {
    items.iter().map(|s| (*s).to_owned()).collect()
}
/// `--json` output, tolerating a few lines of noise before the object.
fn parse_json(text: &str) -> Option<Value> {
    let start = text.find('{')?;
    serde_json::from_str(text[start..].trim()).ok()
}
fn last_line(text: &str) -> String {
    text.lines().rev().map(str::trim).find(|line| !line.is_empty()).unwrap_or("").chars().take(300).collect()
}
pub(crate) fn cap_text(mut text: String) -> String {
    if text.len() > TEXT_CAP {
        let mut end = TEXT_CAP;
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        text.truncate(end);
        text.push_str("\n… [truncated]");
    }
    text
}
fn short(value: &Value, max: usize) -> String {
    value.as_str().unwrap_or("").chars().take(max).collect()
}
fn failure(what: &str, finished: &Finished) -> anyhow::Error {
    let detail = if finished.stderr.trim().is_empty() { last_line(&finished.stdout) } else { last_line(&finished.stderr) };
    anyhow::anyhow!("{what} failed (exit {}): {detail}", finished.code.map_or("?".into(), |c| c.to_string()))
}

// ----------------------------------------------------------------------------- results and inputs
fn text(value: impl Into<String>) -> Value {
    json!({"type": "text", "text": value.into()})
}
fn image(mime: &str, bytes: &[u8]) -> Value {
    json!({"type": "image", "mimeType": mime, "data": STANDARD.encode(bytes)})
}
fn done(content: Vec<Value>, structured: Value, is_error: bool) -> Value {
    json!({"content": content, "structuredContent": structured, "isError": is_error})
}
fn allowed(input: &Value, keys: &[&str]) -> Result<Map<String, Value>> {
    let map = input.as_object().context("expected an object")?;
    ensure!(map.keys().all(|key| keys.contains(&key.as_str())), "unknown field; allowed: {}", keys.join(", "));
    Ok(map.clone())
}
fn bounded(map: &Map<String, Value>, key: &str, min: u64, max: u64) -> Result<Option<u64>> {
    match map.get(key) {
        None => Ok(None),
        Some(value) => {
            let n = value.as_u64().with_context(|| format!("{key} must be an integer"))?;
            ensure!((min..=max).contains(&n), "{key} must be between {min} and {max}");
            Ok(Some(n))
        }
    }
}
fn one_of(map: &Map<String, Value>, key: &str, options: &[&str]) -> Result<Option<String>> {
    match map.get(key) {
        None => Ok(None),
        Some(value) => {
            let s = value.as_str().with_context(|| format!("{key} must be text"))?;
            ensure!(options.contains(&s), "{key} must be one of: {}", options.join(", "));
            Ok(Some(s.to_owned()))
        }
    }
}
fn seconds(value: &Value, key: &str) -> Result<f64> {
    let n = value.as_f64().with_context(|| format!("{key} must be a number of seconds"))?;
    ensure!(n.is_finite() && (0.0..=86_400.0).contains(&n), "{key} must be between 0 and 86400 seconds");
    Ok(n)
}
/// A zoom made only of numbers is a pixel region `x,y,w,h` and is checked here: the CLI turns a region with
/// no width or height into a blank picture instead of an error (seen in a real run), so the model would
/// "inspect" an empty frame and never learn its region was wrong. Anything else is a CSS selector.
fn zoom_region(zoom: &str) -> Result<()> {
    if !zoom.chars().all(|c| c.is_ascii_digit() || " ,.".contains(c)) {
        return Ok(());
    }
    let numbers: Vec<f64> = zoom.split(',').map(|part| part.trim().parse::<f64>().unwrap_or(f64::NAN)).collect();
    let [x, y, w, h] = numbers[..] else { bail!("zoom region must be x,y,w,h in pixels, e.g. 120,880,600,200") };
    ensure!([x, y, w, h].iter().all(|n| n.is_finite()) && x >= 0.0 && y >= 0.0 && w > 0.0 && h > 0.0, "zoom region needs a positive width and height (x,y,w,h in pixels, e.g. 120,880,600,200): \"{zoom}\" would capture nothing");
    Ok(())
}
fn plain_text<'a>(map: &'a Map<String, Value>, key: &str, max: usize) -> Result<Option<&'a str>> {
    match map.get(key) {
        None => Ok(None),
        Some(value) => {
            let s = value.as_str().with_context(|| format!("{key} must be text"))?;
            ensure!(!s.is_empty() && s.len() <= max && !s.chars().any(char::is_control) && !s.starts_with('-'), "{key} is not valid");
            Ok(Some(s))
        }
    }
}
/// A relative path made of plain components, inside `root`.
fn relative(raw: &str) -> Result<&Path> {
    let path = Path::new(raw);
    ensure!(!raw.is_empty() && !raw.contains('\0') && !path.is_absolute() && path.components().all(|c| matches!(c, Component::Normal(_) | Component::CurDir)), "path must be relative to the workspace");
    Ok(path)
}
/// The folder the command runs in: the workspace, or a project inside it.
fn project_dir(root: &Path, map: &Map<String, Value>) -> Result<PathBuf> {
    let Some(value) = map.get("project") else { return Ok(root.to_owned()) };
    let dir = root.join(relative(value.as_str().context("project must be text")?)?).canonicalize().context("project folder not found")?;
    ensure!(dir.starts_with(root) && dir.is_dir(), "project must be a folder inside the workspace");
    Ok(dir)
}
/// A path the CLI will write: relative, inside the project, never through a link. Parents are created.
fn safe_destination(root: &Path, raw: &str) -> Result<PathBuf> {
    let dest = root.join(relative(raw)?);
    ensure!(dest != root, "output must name a file or folder inside the project");
    let parent = dest.parent().context("output parent unavailable")?;
    std::fs::create_dir_all(parent).context("could not create the output folder")?;
    ensure!(parent.canonicalize()?.starts_with(root), "output parent leaves the project");
    match std::fs::symlink_metadata(&dest) {
        Ok(metadata) => {
            ensure!(!metadata.file_type().is_symlink(), "linked output is not supported");
            ensure!(dest.canonicalize()?.starts_with(root), "output leaves the project");
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
        Err(error) => return Err(error.into()),
    }
    Ok(dest)
}
fn display(root: &Path, path: &Path) -> String {
    path.strip_prefix(root).unwrap_or(path).to_string_lossy().into_owned()
}

// ----------------------------------------------------------------------------- summaries
const SECTIONS: &[&str] = &["lint", "runtime", "layout", "motion", "contrast", "craft", "audio"];
fn finding_line(section: &str, finding: &Value) -> String {
    let when = finding["time"].as_f64().map(|t| format!(" at {t}s")).unwrap_or_default();
    let target = finding["selector"].as_str().filter(|s| !s.is_empty()).map(|s| format!(" ({s})")).unwrap_or_default();
    let fix = finding["fixHint"].as_str().or(finding["fix"].as_str()).map(|f| format!(" Fix: {}", f.chars().take(260).collect::<String>())).unwrap_or_default();
    format!("- [{}] {section}/{}{when}{target}: {}{fix}", finding["severity"].as_str().unwrap_or("?"), finding["code"].as_str().unwrap_or("?"), short(&finding["message"], 240))
}
/// A compact view of `check --json` / `lint --json`: counts per section and the findings that matter first.
fn summarize_check(report: &Value, label: &str) -> (String, Value, bool) {
    let ok = report["ok"] == true;
    let mut counts = Map::new();
    let mut findings: Vec<(u8, String, Value)> = Vec::new();
    let (mut errors, mut warnings) = (0u64, 0u64);
    let sections: Vec<(&str, &Value)> = if SECTIONS.iter().any(|s| report[*s].is_object()) {
        SECTIONS.iter().filter(|s| report[**s].is_object()).map(|s| (*s, &report[*s])).collect()
    } else {
        vec![("lint", report)] // `lint --json` is the section itself
    };
    for (name, section) in sections {
        let (e, w) = (section["errorCount"].as_u64().unwrap_or(0), section["warningCount"].as_u64().unwrap_or(0));
        errors += e;
        warnings += w;
        counts.insert(name.into(), json!({"errors": e, "warnings": w}));
        for finding in section["findings"].as_array().into_iter().flatten() {
            let rank = match finding["severity"].as_str() { Some("error") => 0, Some("warning") => 1, _ => 2 };
            let trimmed = json!({"section": name, "severity": finding["severity"], "code": finding["code"], "message": short(&finding["message"], 300),
                "fixHint": short(&finding["fixHint"], 400), "selector": finding["selector"], "sourceFile": finding["sourceFile"], "time": finding["time"],
                "occurrences": finding["occurrences"], "suggestedColor": finding["suggestedColor"]});
            findings.push((rank, finding_line(name, finding), trimmed));
        }
    }
    findings.sort_by_key(|(rank, ..)| *rank);
    let mut out = format!("{label} {}: {errors} error(s), {warnings} warning(s).", if ok { "PASSED" } else { "FAILED" });
    if report["browserSkipped"] == true {
        out.push_str(" The browser audits were skipped: empty runtime/layout/contrast sections do NOT mean clean.");
    }
    for (_, line, _) in findings.iter().take(15) {
        out.push('\n');
        out.push_str(line);
    }
    if findings.len() > 15 {
        out.push_str(&format!("\n(+{} more findings in structuredContent.findings)", findings.len() - 15));
    }
    if let Some(path) = report["saved"]["report"].as_str() {
        out.push_str(&format!("\nFull report: {path}"));
    }
    let kept: Vec<Value> = findings.into_iter().take(40).map(|(_, _, v)| v).collect();
    (out, json!({"ok": ok, "errors": errors, "warnings": warnings, "sections": counts, "findings": kept, "browserSkipped": report["browserSkipped"]}), ok)
}
fn optional_check(check: &Value) -> bool {
    ["name", "detail", "hint"].iter().any(|k| check[*k].as_str().is_some_and(|s| s.to_lowercase().contains("optional")))
}
/// `doctor --json`: what blocks work (required checks that failed) apart from optional extras.
fn summarize_doctor(report: &Value) -> (String, Value) {
    let checks = report["checks"].as_array().cloned().unwrap_or_default();
    let (mut problems, mut optional) = (Vec::new(), Vec::new());
    for check in &checks {
        // A newer version is reported on its own (updateAvailable); it never blocks work.
        if check["ok"] == true || check["name"] == "Version" {
            continue;
        }
        let line = format!("{}: {}{}", short(&check["name"], 60), short(&check["detail"], 120), check["hint"].as_str().map(|h| format!(" ({h})")).unwrap_or_default());
        if optional_check(check) { optional.push(line) } else { problems.push(line) }
    }
    let meta = &report["_meta"];
    let mut out = format!("HyperFrames {} — {} checks, {} problem(s).", meta["version"].as_str().unwrap_or("?"), checks.len(), problems.len());
    if meta["updateAvailable"] == true {
        out.push_str(&format!(" Version {} is available (the user updates it; Trex never does).", meta["latestVersion"].as_str().unwrap_or("?")));
    }
    for line in &problems {
        out.push_str(&format!("\n- {line}"));
    }
    if !optional.is_empty() {
        out.push_str(&format!("\nOptional, not installed: {}", optional.iter().map(|l| l.split(':').next().unwrap_or("")).collect::<Vec<_>>().join(", ")));
    }
    (out, json!({"version": meta["version"], "latestVersion": meta["latestVersion"], "updateAvailable": meta["updateAvailable"], "problems": problems, "optional": optional, "checks": checks.len()}))
}

// ----------------------------------------------------------------------------- images
/// Shrink to `max_edge` on the long side and encode as PNG, so a 1080p frame costs about a thousand tokens.
fn shrink_png(bytes: &[u8], max_edge: u32) -> Result<(Vec<u8>, (u32, u32))> {
    let mut picture = image::load_from_memory(bytes).context("the snapshot is not a readable image")?;
    let long = picture.width().max(picture.height());
    if long > max_edge {
        let scale = f64::from(max_edge) / f64::from(long);
        picture = picture.resize_exact(((f64::from(picture.width()) * scale).round() as u32).max(1), ((f64::from(picture.height()) * scale).round() as u32).max(1), image::imageops::FilterType::CatmullRom);
    }
    let size = (picture.width(), picture.height());
    let mut out = std::io::Cursor::new(Vec::new());
    picture.write_to(&mut out, image::ImageFormat::Png)?;
    Ok((out.into_inner(), size))
}
/// Only files the CLI wrote under the project's `.hyperframes` folder are read back.
fn artifact(root: &Path, raw: &str) -> Result<PathBuf> {
    let path = Path::new(raw);
    let resolved = if path.is_absolute() { path.to_owned() } else { root.join(path) }.canonicalize().context("snapshot file missing")?;
    // Fails closed: with no artifacts folder there is nothing legitimate to read (an empty path would match everything).
    let artifacts = root.join(".hyperframes").canonicalize().context("the project has no .hyperframes artifacts folder")?;
    ensure!(resolved.starts_with(&artifacts) && resolved.is_file(), "snapshot file is outside the project's artifacts");
    Ok(resolved)
}

// ----------------------------------------------------------------------------- provider
pub struct HyperframesProvider;
impl HyperframesProvider {
    fn cli(root: &Path) -> Result<PathBuf> {
        find_cli(root).with_context(|| format!("HyperFrames not found; install it as in {INSTALL_GUIDE} (Trex never installs it)"))
    }

    async fn project(&self, root: &Path, input: &Value, cancel: &CancellationToken) -> Result<Value> {
        let map = allowed(input, &["project"])?;
        let dir = project_dir(root, &map)?;
        let cli = Self::cli(root)?;
        let info = run(&cli, &dir, &args(&["info", "--json"]), Duration::from_secs(60), cancel, false).await?;
        let Some(info_json) = parse_json(&info.stdout).filter(|_| info.code == Some(0)) else {
            bail!("{} Is this a HyperFrames project (hyperframes.json, index.html)? Create one with hyperframes_init.", failure("info", &info));
        };
        let comps = run(&cli, &dir, &args(&["compositions", "--json"]), Duration::from_secs(60), cancel, false).await?;
        let compositions = parse_json(&comps.stdout).map(|v| v["compositions"].clone()).unwrap_or(Value::Null);
        let meta = &info_json["_meta"];
        let mut out = format!("Project {}: {}x{} ({}), {} s, {} element(s) on {} track(s).", short(&info_json["name"], 80), info_json["width"], info_json["height"], short(&info_json["resolution"], 30), info_json["duration"], info_json["elements"], info_json["tracks"]);
        for c in compositions.as_array().into_iter().flatten() {
            out.push_str(&format!("\n- composition {} ({} s, {} element(s))", short(&c["id"], 80), c["duration"], c["elementCount"]));
        }
        if meta["updateAvailable"] == true {
            out.push_str(&format!("\nHyperFrames {} is installed; {} is available (the user decides whether to update).", meta["version"].as_str().unwrap_or("?"), meta["latestVersion"].as_str().unwrap_or("?")));
        }
        Ok(done(vec![text(out)], json!({"info": info_json, "compositions": compositions, "directory": display(root, &dir)}), false))
    }

    async fn docs(&self, root: &Path, input: &Value, cancel: &CancellationToken) -> Result<Value> {
        let map = allowed(input, &["topic"])?;
        let topic = plain_text(&map, "topic", 40)?;
        ensure!(topic.is_none_or(|t| t.chars().all(|c| c.is_ascii_lowercase() || c == '-')), "topic must be one of the names listed by hyperframes_docs without a topic");
        let cli = Self::cli(root)?;
        let mut a = args(&["docs"]);
        a.extend(topic.map(str::to_owned));
        let finished = run(&cli, root, &a, Duration::from_secs(30), cancel, false).await?;
        ensure!(finished.code == Some(0) && !finished.stdout.trim().is_empty(), "{}", failure("docs", &finished));
        Ok(done(vec![text(cap_text(finished.stdout.trim().to_owned()))], json!({"topic": topic}), false))
    }

    async fn doctor(&self, root: &Path, input: &Value, cancel: &CancellationToken) -> Result<Value> {
        allowed(input, &[])?;
        let cli = Self::cli(root)?;
        // `doctor --json` exits 0 even when a check fails: the verdict is in the report.
        let finished = run(&cli, root, &args(&["doctor", "--json"]), Duration::from_secs(90), cancel, false).await?;
        let report = parse_json(&finished.stdout).with_context(|| failure("doctor", &finished).to_string())?;
        let (summary, structured) = summarize_doctor(&report);
        Ok(done(vec![text(summary)], structured, false))
    }

    async fn check(&self, root: &Path, input: &Value, cancel: &CancellationToken) -> Result<Value> {
        let map = allowed(input, &["project", "scope", "samples", "range", "strict"])?;
        let dir = project_dir(root, &map)?;
        let cli = Self::cli(root)?;
        let scope = one_of(&map, "scope", &["full", "lint"])?.unwrap_or_else(|| "full".into());
        let mut a = if scope == "lint" { args(&["lint", "--json"]) } else { args(&["check", "--json"]) };
        if scope == "full" {
            if let Some(n) = bounded(&map, "samples", 1, 60)? {
                a.extend(["--samples".into(), n.to_string()]);
            }
            if let Some(range) = map.get("range") {
                let pair = range.as_array().filter(|p| p.len() == 2).context("range must be [startSeconds, endSeconds]")?;
                let (start, end) = (seconds(&pair[0], "range start")?, seconds(&pair[1], "range end")?);
                ensure!(start < end, "range start must be before its end");
                a.extend(["--range".into(), format!("{start},{end}")]);
            }
            if map.get("strict") == Some(&json!(true)) {
                a.push("--strict".into());
            }
        } else {
            ensure!(!map.contains_key("samples") && !map.contains_key("range") && !map.contains_key("strict"), "samples, range and strict only apply to scope=full");
        }
        let finished = run(&cli, &dir, &a, Duration::from_secs(300), cancel, false).await?;
        // A failed check still prints its report on stdout: the exit code only says "findings".
        let report = parse_json(&finished.stdout).with_context(|| failure(&scope, &finished).to_string())?;
        // Findings are an answer, not a failure of the tool: the model reads them and fixes the composition.
        let (summary, structured, _) = summarize_check(&report, if scope == "lint" { "lint" } else { "check" });
        Ok(done(vec![text(summary)], structured, false))
    }

    async fn snapshot(&self, root: &Path, input: &Value, cancel: &CancellationToken) -> Result<Value> {
        let map = allowed(input, &["project", "frames", "at", "range", "composition", "zoom", "review", "images", "maxEdge"])?;
        let dir = project_dir(root, &map)?;
        let cli = Self::cli(root)?;
        let mut a = args(&["snapshot", "--json"]);
        let mut wanted = 5usize;
        if let Some(at) = map.get("at") {
            let times = at.as_array().filter(|t| !t.is_empty() && t.len() <= 12).context("at must list 1 to 12 times in seconds")?;
            let times = times.iter().map(|t| seconds(t, "at")).collect::<Result<Vec<_>>>()?;
            wanted = times.len();
            a.extend(["--at".into(), times.iter().map(f64::to_string).collect::<Vec<_>>().join(",")]);
        } else {
            wanted = bounded(&map, "frames", 1, 12)?.map_or(wanted, |n| n as usize);
            a.extend(["--frames".into(), wanted.to_string()]);
        }
        if let Some(range) = map.get("range") {
            let pair = range.as_array().filter(|p| p.len() == 2).context("range must be [startSeconds, endSeconds]")?;
            let (start, end) = (seconds(&pair[0], "range start")?, seconds(&pair[1], "range end")?);
            ensure!(start < end, "range start must be before its end");
            a.extend(["--range".into(), format!("{start},{end}")]);
        }
        if let Some(id) = plain_text(&map, "composition", 200)? {
            a.extend(["--composition".into(), id.into()]);
        }
        if let Some(zoom) = plain_text(&map, "zoom", 160)? {
            ensure!(zoom.chars().all(|c| c.is_ascii_alphanumeric() || " #.:_-[]=\"'>+~*,()".contains(c)), "zoom must be a CSS selector or an x,y,w,h pixel region");
            zoom_region(zoom)?;
            a.extend(["--zoom".into(), zoom.into()]);
        }
        if map.get("review") == Some(&json!(true)) {
            a.push("--review".into());
        }
        let layout = one_of(&map, "images", &["sheet", "frames"])?.unwrap_or_else(|| if wanted > 3 { "sheet".into() } else { "frames".into() });
        let edge = bounded(&map, "maxEdge", 256, u64::from(MAX_IMAGE_EDGE))?.map_or(1280, |n| n as u32);
        let finished = run(&cli, &dir, &a, Duration::from_secs(300), cancel, false).await?;
        let report = parse_json(&finished.stdout).filter(|r| r["ok"] == true).with_context(|| failure("snapshot", &finished).to_string())?;
        let project = dir.canonicalize()?;
        let frames: Vec<(f64, PathBuf)> = report["frames"].as_array().into_iter().flatten().filter_map(|f| Some((f["time"].as_f64()?, artifact(&project, f["path"].as_str()?).ok()?))).collect();
        ensure!(!frames.is_empty(), "the snapshot produced no frames");
        let times = frames.iter().map(|(t, _)| format!("{t}s")).collect::<Vec<_>>().join(", ");
        let mut content = Vec::new();
        let sheet = report["contactSheets"].as_array().and_then(|s| s.first()).and_then(Value::as_str).and_then(|p| artifact(&project, p).ok());
        let (mut shown, mut mode) = (0usize, "frames");
        if layout == "sheet" {
            if let Some(path) = &sheet {
                let (png, (w, h)) = shrink_png(&std::fs::read(path)?, MAX_IMAGE_EDGE)?;
                content.push(image("image/png", &png));
                shown = frames.len();
                mode = "sheet";
                content.insert(0, text(format!("Snapshot sheet {w}x{h} of {} frame(s) at {times} (left to right). Look at it before saying how the video looks; ask for single frames with `at` and `zoom` to inspect details.", frames.len())));
            }
        }
        if mode == "frames" {
            let mut sizes = Vec::new();
            for (time, path) in frames.iter().take(6) {
                let (png, size) = shrink_png(&std::fs::read(path)?, edge)?;
                content.push(text(format!("Frame at {time}s ({}x{}):", size.0, size.1)));
                content.push(image("image/png", &png));
                sizes.push(size);
            }
            shown = sizes.len();
            if frames.len() > shown {
                content.push(text(format!("({} more frame(s) not shown; use `at` to pick moments or images=sheet.)", frames.len() - shown)));
            }
        }
        // Paths are relative to the workspace, so the model can open a file with its own file tools.
        let listed: Vec<Value> = frames.iter().map(|(t, p)| json!({"time": t, "path": display(root, p)})).collect();
        Ok(done(content, json!({"outputDir": report["outputDir"].as_str().and_then(|p| Path::new(p).canonicalize().ok()).map(|p| display(root, &p)), "frames": listed, "shown": shown, "mode": mode}), false))
    }

    async fn render(&self, root: &Path, input: &Value, cancel: &CancellationToken) -> Result<Value> {
        let map = allowed(input, &["project", "output", "quality", "fps", "format", "composition", "start", "end", "poster", "timeoutMs"])?;
        let dir = project_dir(root, &map)?;
        let cli = Self::cli(root)?;
        let project = dir.canonicalize()?;
        let output = safe_destination(&project, map.get("output").and_then(Value::as_str).context("output is required, e.g. renders/draft.mp4")?)?;
        let mut a = args(&["render", "--quiet", "--output"]);
        a.push(output.to_str().context("output path must be UTF-8")?.to_owned());
        if let Some(q) = one_of(&map, "quality", &["draft", "looks", "delivery", "standard", "high"])? {
            a.extend(["--quality".into(), q]);
        }
        match map.get("fps") {
            None => {}
            Some(Value::Number(n)) => {
                let n = n.as_u64().filter(|n| (1..=240).contains(n)).context("fps must be between 1 and 240")?;
                a.extend(["--fps".into(), n.to_string()]);
            }
            Some(Value::String(s)) if s.len() <= 16 && s.split_once('/').is_some_and(|(x, y)| !x.is_empty() && !y.is_empty() && x.bytes().chain(y.bytes()).all(|b| b.is_ascii_digit())) => a.extend(["--fps".into(), s.clone()]),
            _ => bail!("fps must be a number or a rational such as 30000/1001"),
        }
        let format = one_of(&map, "format", &["mp4", "webm", "mov", "gif", "png-sequence", "hls"])?;
        if let Some(f) = &format {
            a.extend(["--format".into(), f.clone()]);
        }
        if let Some(id) = plain_text(&map, "composition", 200)? {
            a.extend(["--composition".into(), id.into()]);
        }
        for key in ["start", "end"] {
            if let Some(value) = map.get(key) {
                a.extend([format!("--{key}"), seconds(value, key)?.to_string()]);
            }
        }
        let limit = Duration::from_millis(bounded(&map, "timeoutMs", 1000, 3_600_000)?.unwrap_or(900_000));
        let finished = run(&cli, &project, &a, limit, cancel, true).await?;
        if finished.code != Some(0) {
            let mut error = done(vec![text(format!("{} Output may be incomplete: {}", failure("render", &finished), display(root, &output)))], json!({"ok": false}), true);
            error["executionMayHaveChangedFiles"] = json!(true);
            return Ok(error);
        }
        let facts = file_facts(&output, cancel).await;
        let mut out = format!("Rendered {}", display(root, &output));
        if let Some(bytes) = facts["bytes"].as_u64() {
            out.push_str(&format!(" — {}", human_bytes(bytes)));
        }
        if let Some(d) = facts["duration"].as_f64() {
            out.push_str(&format!(", {d:.1} s"));
        }
        if let (Some(w), Some(h)) = (facts["width"].as_u64(), facts["height"].as_u64()) {
            out.push_str(&format!(", {w}x{h}"));
        }
        out.push('.');
        let mut content = vec![text(out)];
        let mut poster_file = Value::Null;
        if map.get("poster") == Some(&json!(true)) {
            match poster(&output, facts["duration"].as_f64().unwrap_or(0.0), cancel).await {
                Ok(png) => {
                    let (small, _) = shrink_png(&png, 1280)?;
                    // Kept on disk next to the video, so the model can name the file in its report.
                    match save_poster(&project, &output, &png) {
                        Ok(path) => {
                            content.push(text(format!("Poster frame from the middle of the render, saved as {}:", display(root, &path))));
                            poster_file = json!(display(root, &path));
                        }
                        Err(error) => content.push(text(format!("Poster frame from the middle of the render (not saved to disk: {error}):"))),
                    }
                    content.push(image("image/png", &small));
                }
                Err(error) => content.push(text(format!("(No poster frame: {error})"))),
            }
        }
        Ok(done(content, json!({"ok": true, "output": display(root, &output), "file": facts, "poster": poster_file}), false))
    }

    async fn preview(&self, root: &Path, input: &Value, cancel: &CancellationToken) -> Result<Value> {
        let map = allowed(input, &["project", "action", "port"])?;
        let dir = project_dir(root, &map)?;
        let cli = Self::cli(root)?;
        let action = one_of(&map, "action", &["start", "status", "stop"])?.unwrap_or_else(|| "start".into());
        let mut a = args(&["preview", "--json"]);
        match action.as_str() {
            "start" => {
                a.extend(args(&["--background", "--no-open"]));
                if let Some(port) = bounded(&map, "port", 1024, 65535)? {
                    a.extend(["--port".into(), port.to_string()]);
                }
            }
            "status" => a.push("--status".into()),
            _ => a.push("--stop".into()),
        }
        let finished = run(&cli, &dir, &a, Duration::from_secs(90), cancel, action != "status").await?;
        let report = parse_json(&finished.stdout).with_context(|| failure("preview", &finished).to_string())?;
        ensure!(report["ok"] == true, "preview {action} failed: {}", short(&report["error"]["message"], 300));
        let result = &report["result"];
        let state = result["state"].as_str().unwrap_or("?");
        let message = match state {
            "started" | "running" => format!("Studio preview {state} for {}: {} — the user can watch and edit there. It stays running until hyperframes_preview action=stop.", short(&result["projectName"], 80), result["studioUrl"].as_str().unwrap_or("?")),
            "stopped" => "Studio preview stopped.".into(),
            _ => "No background preview is running for this project.".into(),
        };
        Ok(done(vec![text(message)], json!({"state": state, "studioUrl": result["studioUrl"], "port": result["port"], "pid": result["pid"]}), false))
    }

    async fn init(&self, root: &Path, input: &Value, cancel: &CancellationToken) -> Result<Value> {
        let map = allowed(input, &["name", "example", "resolution"])?;
        let name = map.get("name").and_then(Value::as_str).context("name is required: the folder for the new project, e.g. videos/intro")?;
        let target = root.join(relative(name)?);
        ensure!(target != root, "name must be a new folder inside the workspace");
        if target.exists() {
            ensure!(target.is_dir() && std::fs::read_dir(&target)?.next().is_none(), "{name} already exists and is not empty");
        }
        let parent = target.parent().context("name has no parent")?;
        std::fs::create_dir_all(parent).context("could not create the parent folder")?;
        ensure!(parent.canonicalize()?.starts_with(root), "name leaves the workspace");
        let cli = Self::cli(root)?;
        let mut a = args(&["init", name, "--non-interactive", "--skip-skills", "--skip-transcribe"]);
        if let Some(example) = plain_text(&map, "example", 60)? {
            ensure!(example.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'), "example is not valid");
            a.extend(["--example".into(), example.into()]);
        }
        if let Some(r) = one_of(&map, "resolution", &["landscape", "portrait", "landscape-4k", "portrait-4k", "square", "square-4k"])? {
            a.extend(["--resolution".into(), r]);
        }
        let finished = run(&cli, root, &a, Duration::from_secs(120), cancel, true).await?;
        ensure!(finished.code == Some(0), "{}", failure("init", &finished));
        let files: Vec<String> = std::fs::read_dir(&target)?.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        Ok(done(vec![text(format!("Created the HyperFrames project in {name}: {}. Next: read the contract (hyperframes_docs compositions, data-attributes, gsap), write the composition, hyperframes_check, hyperframes_snapshot. Pass project=\"{name}\" to the other tools.", files.join(", ")))], json!({"project": name, "files": files}), false))
    }
}

fn human_bytes(bytes: u64) -> String {
    if bytes >= 1 << 20 { format!("{:.1} MB", bytes as f64 / f64::from(1 << 20)) } else { format!("{:.1} KB", bytes as f64 / 1024.0) }
}
fn find_tool(name: &str) -> Option<PathBuf> {
    let file = bin_name(name).replace(".cmd", if cfg!(windows) { ".exe" } else { "" });
    path_dirs().into_iter().chain(global_bin_dirs()).map(|dir| dir.join(&file)).find(|p| is_executable(p))
}
/// Size, and duration and resolution when `ffprobe` is around (HyperFrames itself needs FFmpeg).
async fn file_facts(path: &Path, cancel: &CancellationToken) -> Value {
    let bytes = std::fs::metadata(path).map(|m| if m.is_dir() { 0 } else { m.len() }).ok();
    let mut facts = json!({"bytes": bytes});
    let Some(ffprobe) = std::env::var_os("HYPERFRAMES_FFPROBE_PATH").map(PathBuf::from).or_else(|| find_tool("ffprobe")) else { return facts };
    if path.is_dir() {
        return facts;
    }
    let a = args(&["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,codec_name:format=duration", "-of", "json"]);
    let mut all = a;
    all.push(path.to_string_lossy().into_owned());
    if let Ok(out) = run_plain(&ffprobe, &all, Duration::from_secs(30), cancel).await {
        if let Some(probe) = parse_json(&out) {
            facts["duration"] = json!(probe["format"]["duration"].as_str().and_then(|d| d.parse::<f64>().ok()));
            facts["width"] = probe["streams"][0]["width"].clone();
            facts["height"] = probe["streams"][0]["height"].clone();
            facts["codec"] = probe["streams"][0]["codec_name"].clone();
        }
    }
    facts
}
async fn run_plain(program: &Path, a: &[String], limit: Duration, cancel: &CancellationToken) -> Result<String> {
    let mut command = Command::new(program);
    command.args(a).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).kill_on_drop(true);
    let child = command.spawn().context("could not start the tool")?;
    tokio::select! {
        biased;
        _ = cancel.cancelled() => bail!("cancelled"),
        out = tokio::time::timeout(limit, child.wait_with_output()) => {
            let out = out.context("timed out")??;
            ensure!(out.status.success(), "the tool failed");
            Ok(String::from_utf8_lossy(&out.stdout).into_owned())
        }
    }
}
/// `renders/final.mp4` keeps its poster as `renders/final.poster.png`, under the same rules as any output.
fn save_poster(project: &Path, video: &Path, png: &[u8]) -> Result<PathBuf> {
    let relative = video.strip_prefix(project).context("the render is outside the project")?.with_extension("poster.png");
    let target = safe_destination(project, relative.to_str().context("path must be UTF-8")?)?;
    std::fs::write(&target, png).context("could not write the poster")?;
    Ok(target)
}
/// One frame from the middle of a finished render, to catch black or wrong output at a glance.
async fn poster(video: &Path, duration: f64, cancel: &CancellationToken) -> Result<Vec<u8>> {
    ensure!(video.is_file(), "the render is not a single video file");
    let ffmpeg = std::env::var_os("HYPERFRAMES_FFMPEG_PATH").map(PathBuf::from).or_else(|| find_tool("ffmpeg")).context("ffmpeg not found")?;
    let at = (duration / 2.0).max(0.0).to_string();
    let a = vec!["-v".into(), "error".into(), "-ss".into(), at, "-i".into(), video.to_string_lossy().into_owned(), "-frames:v".into(), "1".into(), "-f".into(), "image2pipe".into(), "-vcodec".into(), "png".into(), "-".into()];
    let mut command = Command::new(&ffmpeg);
    command.args(&a).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).kill_on_drop(true);
    let child = command.spawn().context("could not start ffmpeg")?;
    let out = tokio::select! {
        biased;
        _ = cancel.cancelled() => bail!("cancelled"),
        out = tokio::time::timeout(Duration::from_secs(60), child.wait_with_output()) => out.context("timed out")??,
    };
    ensure!(out.status.success() && out.stdout.starts_with(b"\x89PNG"), "ffmpeg could not read a frame");
    Ok(out.stdout)
}

// ----------------------------------------------------------------------------- settings
/// What Settings shows: is the CLI there, its version and whether a newer one exists, what blocks
/// work (required checks that failed), and the state of the skills HyperFrames installs for agents.
pub async fn admin_status(root: &Path, cancel: &CancellationToken) -> Result<Value> {
    let Some(cli) = find_cli(root) else {
        return Ok(json!({"found": false, "guide": INSTALL_GUIDE}));
    };
    let doctor_args = args(&["doctor", "--json"]);
    let skills_args = args(&["skills", "check", "--json"]);
    let (doctor, skills) = tokio::join!(
        run(&cli, root, &doctor_args, Duration::from_secs(90), cancel, false),
        run(&cli, root, &skills_args, Duration::from_secs(60), cancel, false),
    );
    let report = doctor.ok().and_then(|d| parse_json(&d.stdout));
    let (_, doctor_view) = report.as_ref().map(summarize_doctor).unwrap_or((String::new(), json!({})));
    let skills_report = skills.ok().and_then(|s| parse_json(&s.stdout));
    let skills_view = skills_report.map(|r| {
        json!({"location": r["location"], "agent": r["agent"], "updateAvailable": r["updateAvailable"],
               "current": r["summary"]["current"], "outdated": r["summary"]["outdated"], "missing": r["summary"]["missing"], "coreMissing": r["summary"]["coreMissing"]})
    });
    let version = report.as_ref().and_then(|r| r["_meta"]["version"].as_str().map(str::to_owned)).or_else(|| {
        std::process::Command::new(&cli).arg("--version").output().ok().and_then(|o| String::from_utf8(o.stdout).ok()).map(|v| v.trim().to_owned())
    });
    Ok(json!({"found": true, "path": cli, "version": version, "latestVersion": doctor_view["latestVersion"], "updateAvailable": doctor_view["updateAvailable"],
              "problems": doctor_view["problems"], "optional": doctor_view["optional"], "doctorRan": report.is_some(), "skills": skills_view}))
}

/// Install or update the HyperFrames skills in the user's agent folders. Only ever called from an
/// explicit button: it writes outside the project (the CLI decides where, e.g. ~/.claude/skills).
pub async fn admin_skills_update(root: &Path, cancel: &CancellationToken) -> Result<Value> {
    let cli = HyperframesProvider::cli(root)?;
    let finished = run(&cli, root, &args(&["skills", "update", "--json"]), Duration::from_secs(240), cancel, true).await?;
    ensure!(finished.code == Some(0), "{}", failure("skills update", &finished));
    admin_status(root, cancel).await
}
// ----------------------------------------------------------------------------- guidance and catalog
pub fn guidance(read_only: bool) -> String {
    if read_only {
        return "HyperFrames (read-only session): hyperframes_project, hyperframes_docs, hyperframes_doctor and hyperframes_check inspect a project and read the contract; nothing is created, rendered or started from here.".into();
    }
    "HyperFrames renders HTML compositions to video. A project is index.html + compositions/ + assets/ (hyperframes_init creates one; pass `project` when it is not the workspace root). Before writing a composition read the contract: the HyperFrames skills (/hyperframes, /hyperframes-cli) if installed, otherwise hyperframes_docs (compositions, data-attributes, gsap, rendering, troubleshooting). Loop: write, then hyperframes_check (the gate: lint, runtime, layout, contrast; fix every error, each finding says how), then hyperframes_snapshot and LOOK at the frames: that is how you see the video (use at/range/zoom to inspect a moment; the default for 4+ frames is one sheet). hyperframes_preview opens the live Studio for the user. hyperframes_render writes the file (draft while iterating, looks or delivery for the final; poster=true saves and shows a middle frame): confirm the reported size and duration. Never say a frame looks right unless you looked at it; name the moments you inspected. Trex never installs or updates HyperFrames and exposes no cloud, publish or sign-in commands.".into()
}

fn tool(name: &str, description: &str, properties: Value, required: &[&str]) -> Value {
    json!({"type":"function","function":{"name":name,"description":description,"parameters":{"type":"object","properties":properties,"required":required,"additionalProperties":false}}})
}
impl ToolProvider for HyperframesProvider {
    fn guidance(&self, mode: &str) -> Option<String> {
        Some(guidance(mode == "plan"))
    }
    fn definitions(&self, mode: &str) -> Vec<Value> {
        let project = json!({"type":"string","description":"Project folder relative to the workspace (default: the workspace itself)"});
        let times = json!({"type":"array","items":{"type":"number","minimum":0},"minItems":1,"maxItems":12,"description":"Exact moments in seconds; overrides frames"});
        let range = json!({"type":"array","items":{"type":"number","minimum":0},"minItems":2,"maxItems":2,"description":"[startSeconds, endSeconds]"});
        let all = vec![
            tool("hyperframes_project", "Describe a HyperFrames project: name, size, duration, elements, compositions and whether an update exists. Start here in an existing project.", json!({"project": project}), &[]),
            tool("hyperframes_docs", "Read HyperFrames' built-in documentation. Without a topic it lists the topics (data-attributes, compositions, gsap, rendering, audio, troubleshooting…). Read the relevant ones before authoring.", json!({"topic":{"type":"string","description":"A topic name from the list"}}), &[]),
            tool("hyperframes_doctor", "Check the machine for HyperFrames: Node, FFmpeg, the browser used for rendering, disk and GPU. Reports what blocks work, apart from optional extras.", json!({}), &[]),
            tool("hyperframes_check", "The quality gate. scope=full (default) runs lint, runtime, layout, motion and contrast checks in a headless browser (a few seconds); scope=lint is the quick static check. Fix every error: each finding carries a fixHint. An empty section does not mean clean when browserSkipped is true.",
                json!({"project": project, "scope":{"type":"string","enum":["full","lint"]}, "samples":{"type":"integer","minimum":1,"maximum":60}, "range": range.clone(), "strict":{"type":"boolean"}}), &[]),
            tool("hyperframes_snapshot", "Capture frames of the composition and return them as images: this is how you SEE the video. By default 5 evenly spaced frames as one sheet (up to 3 frames come as separate images). Use `at` for exact moments, `range` for part of the film, `composition` for one scene, `zoom` (CSS selector or x,y,w,h) to inspect a detail at high density, `review` for each scene's start and middle. Writes PNGs under .hyperframes/.",
                json!({"project": project, "frames":{"type":"integer","minimum":1,"maximum":12}, "at": times, "range": range, "composition":{"type":"string"}, "zoom":{"type":"string"}, "review":{"type":"boolean"}, "images":{"type":"string","enum":["sheet","frames"]}, "maxEdge":{"type":"integer","minimum":256,"maximum":1568}}), &[]),
            tool("hyperframes_render", "Render the composition to a file inside the project. quality draft is fast for iterating; looks is the default; delivery for the final. Reports size, duration and resolution; poster=true saves a frame from the middle next to the video (<name>.poster.png) and attaches it. May take minutes for long films.",
                json!({"project": project, "output":{"type":"string","description":"Relative path inside the project, e.g. renders/draft.mp4"}, "quality":{"type":"string","enum":["draft","looks","delivery","standard","high"]}, "fps":{"description":"1-240 or a rational such as 30000/1001"}, "format":{"type":"string","enum":["mp4","webm","mov","gif","png-sequence","hls"]}, "composition":{"type":"string"}, "start":{"type":"number","minimum":0}, "end":{"type":"number","minimum":0}, "poster":{"type":"boolean"}, "timeoutMs":{"type":"integer","minimum":1000,"maximum":3600000}}), &["output"]),
            tool("hyperframes_preview", "Control the live Studio preview of a project (it runs in the background and the user can watch and edit there). action=start (default) returns the URL; status; stop.",
                json!({"project": project, "action":{"type":"string","enum":["start","status","stop"]}, "port":{"type":"integer","minimum":1024,"maximum":65535}}), &[]),
            tool("hyperframes_init", "Create a new HyperFrames project in a new, empty folder inside the workspace (no skills are installed, nothing is transcribed).",
                json!({"name":{"type":"string","description":"New folder, e.g. videos/intro"}, "example":{"type":"string"}, "resolution":{"type":"string","enum":["landscape","portrait","landscape-4k","portrait-4k","square","square-4k"]}}), &["name"]),
        ];
        all.into_iter().filter(|t| mode != "plan" || read_only(t["function"]["name"].as_str().unwrap_or(""))).collect()
    }
    fn is_mutating(&self, name: &str, _: &Value) -> bool {
        !read_only(name)
    }
    fn execute<'a>(&'a self, cwd: &'a Path, mode: &'a str, name: &'a str, input: &'a Value, _: &'a str, cancel: CancellationToken) -> ToolFuture<'a> {
        Box::pin(async move {
            ensure!(mode != "plan" || read_only(name), "HyperFrames changes are unavailable in planning mode");
            let root = cwd.canonicalize().context("workspace unavailable")?;
            match name {
                "hyperframes_project" => self.project(&root, input, &cancel).await,
                "hyperframes_docs" => self.docs(&root, input, &cancel).await,
                "hyperframes_doctor" => self.doctor(&root, input, &cancel).await,
                "hyperframes_check" => self.check(&root, input, &cancel).await,
                "hyperframes_snapshot" => self.snapshot(&root, input, &cancel).await,
                "hyperframes_render" => self.render(&root, input, &cancel).await,
                "hyperframes_preview" => self.preview(&root, input, &cancel).await,
                "hyperframes_init" => self.init(&root, input, &cancel).await,
                _ => bail!("unknown HyperFrames tool"),
            }
        })
    }
}

#[cfg(test)]
mod tests;
