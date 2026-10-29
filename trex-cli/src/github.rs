//! Structured GitHub CLI tools. No shell, interactive prompts, admin merges or branch deletion.
use crate::tools::{ToolFuture, ToolProvider};
use anyhow::{bail, ensure, Context, Result};
use serde_json::{json, Value};
use std::{path::Path, process::Stdio, time::Duration};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_util::sync::CancellationToken;

const LIMIT: usize = 128 * 1024;
const READ: &[&str] = &["github_repos", "github_prs", "github_pr_view"];
const WRITE: &[&str] = &["github_pr_create", "github_pr_merge"];

#[derive(Debug)]
pub struct GithubUncertain;
impl std::fmt::Display for GithubUncertain {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("GitHub operation may have been applied; inspect GitHub before continuing. Do not automatically retry.")
    }
}
impl std::error::Error for GithubUncertain {}

pub struct GithubProvider;
pub(crate) fn available() -> bool {
    find_github().is_some()
}
impl ToolProvider for GithubProvider {
    fn definitions(&self, mode: &str) -> Vec<Value> {
        let specs = [
            ("github_repos", "List repositories accessible to the current GitHub CLI account or an explicit owner.", json!({"owner":{"type":"string"},"limit":{"type":"integer","minimum":1,"maximum":1000}}), vec![]),
            ("github_prs", "List pull requests for an explicit owner/repository.", json!({"repository":{"type":"string"},"state":{"type":"string","enum":["open","closed","merged","all"]},"limit":{"type":"integer","minimum":1,"maximum":1000}}), vec!["repository"]),
            ("github_pr_view", "Inspect a pull request and its review and check status.", json!({"repository":{"type":"string"},"number":{"type":"integer","minimum":1}}), vec!["repository","number"]),
            ("github_pr_create", "Create a pull request after the user requests it. The branch must already be pushed. Never retry an uncertain creation without inspecting GitHub.", json!({"repository":{"type":"string"},"head":{"type":"string"},"base":{"type":"string"},"title":{"type":"string"},"body":{"type":"string"},"draft":{"type":"boolean"}}), vec!["repository","head","base","title","body"]),
            ("github_pr_merge", "Merge a specified pull request when authorized. Require the reviewed head SHA, respect repository rules, and do not automatically retry an uncertain result.", json!({"repository":{"type":"string"},"number":{"type":"integer","minimum":1},"headSha":{"type":"string"},"strategy":{"type":"string","enum":["merge","squash","rebase"]}}), vec!["repository","number","headSha","strategy"]),
        ];
        specs.into_iter().filter(|(name,_,_,_)| mode != "plan" || READ.contains(name)).map(|(name,description,properties,required)| json!({"type":"function","function":{"name":name,"description":description,"parameters":{"type":"object","properties":properties,"required":required,"additionalProperties":false}}})).collect()
    }
    fn is_mutating(&self, name: &str, _: &Value) -> bool {
        !READ.contains(&name)
    }
    fn execute<'a>(
        &'a self,
        cwd: &'a Path,
        mode: &'a str,
        name: &'a str,
        input: &'a Value,
        _: &'a str,
        cancel: CancellationToken,
    ) -> ToolFuture<'a> {
        Box::pin(async move {
            ensure!(
                mode != "plan" || READ.contains(&name),
                "plan mode forbids GitHub mutations"
            );
            let (args, body) = arguments(name, input)?;
            let binary =
                find_github().context("GitHub CLI unavailable; install and authenticate gh")?;
            run(&binary, cwd, name, args, body, cancel).await
        })
    }
}

fn find_github() -> Option<std::path::PathBuf> {
    let name = if cfg!(windows) { "gh.exe" } else { "gh" };
    let mut directories: Vec<_> = std::env::var_os("PATH")
        .map(|value| {
            std::env::split_paths(&value)
                .filter(|path| path.is_absolute())
                .collect()
        })
        .unwrap_or_default();
    if let Some(home) = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }) {
        let home = std::path::PathBuf::from(home);
        if home.is_absolute() {
            directories.push(home.join(".local/bin"));
        }
    }
    #[cfg(windows)]
    if let Some(programs) = std::env::var_os("ProgramFiles") {
        let programs = std::path::PathBuf::from(programs);
        if programs.is_absolute() {
            directories.push(programs.join("GitHub CLI"));
        }
    }
    directories
        .into_iter()
        .map(|dir| dir.join(name))
        .find(|path| {
            let Ok(meta) = std::fs::metadata(path) else {
                return false;
            };
            if !meta.is_file() {
                return false;
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                meta.permissions().mode() & 0o111 != 0
            }
            #[cfg(not(unix))]
            {
                true
            }
        })
}

fn fields<'a>(
    value: &'a Value,
    allowed: &[&str],
    required: &[&str],
) -> Result<&'a serde_json::Map<String, Value>> {
    let map = value.as_object().context("expected an object")?;
    ensure!(
        map.keys().all(|key| allowed.contains(&key.as_str())),
        "unknown field"
    );
    ensure!(
        required.iter().all(|key| map.contains_key(*key)),
        "missing field"
    );
    Ok(map)
}
fn string<'a>(v: &'a Value, key: &str, max: usize) -> Result<&'a str> {
    let s = v[key]
        .as_str()
        .with_context(|| format!("{key} must be text"))?;
    ensure!(
        !s.trim().is_empty() && s.len() <= max && !s.contains('\0'),
        "invalid {key}"
    );
    Ok(s)
}
fn repo(v: &Value) -> Result<&str> {
    let s = string(v, "repository", 200)?;
    let mut parts = s.split('/');
    let valid = |part: &str| {
        !part.is_empty()
            && part != "."
            && part != ".."
            && !part.starts_with('-')
            && part
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"-_.".contains(&c))
    };
    ensure!(
        parts.next().is_some_and(valid)
            && parts.next().is_some_and(valid)
            && parts.next().is_none(),
        "repository must be owner/name"
    );
    Ok(s)
}
fn branch<'a>(v: &'a Value, key: &str) -> Result<&'a str> {
    let s = string(v, key, 255)?;
    ensure!(
        !s.starts_with('-') && !s.chars().any(|c| c.is_control() || c.is_whitespace()),
        "invalid branch"
    );
    Ok(s)
}
fn number(v: &Value) -> Result<String> {
    let n = v["number"]
        .as_u64()
        .context("number must be a positive integer")?;
    ensure!(n > 0, "invalid pull request number");
    Ok(n.to_string())
}
fn limit(v: &Value) -> Result<String> {
    let number = match v.get("limit") {
        Some(value) => value.as_u64().context("limit must be an integer")?,
        None => 50,
    };
    ensure!(
        (1..=1000).contains(&number),
        "limit must be between 1 and 1000"
    );
    Ok(number.to_string())
}
fn arguments(name: &str, v: &Value) -> Result<(Vec<String>, Option<String>)> {
    let mut body = None;
    let args: Vec<String> = match name {
        "github_repos" => {
            fields(v, &["owner", "limit"], &[])?;
            let mut args = vec!["repo".into(), "list".into()];
            if v.get("owner").is_some() {
                let owner = string(v, "owner", 100)?;
                ensure!(
                    !owner.starts_with('-')
                        && owner
                            .bytes()
                            .all(|c| c.is_ascii_alphanumeric() || c == b'-'),
                    "invalid owner"
                );
                args.push(owner.into());
            }
            args.extend([
                "--limit".into(),
                limit(v)?,
                "--json".into(),
                "nameWithOwner,description,url,isPrivate".into(),
            ]);
            args
        }
        "github_prs" => {
            fields(v, &["repository", "state", "limit"], &["repository"])?;
            let state = match v.get("state") {
                None => "open",
                Some(_) => string(v, "state", 10)?,
            };
            ensure!(
                ["open", "closed", "merged", "all"].contains(&state),
                "invalid pull request state"
            );
            vec![
                "pr".into(),
                "list".into(),
                "--repo".into(),
                repo(v)?.into(),
                "--limit".into(),
                limit(v)?,
                "--state".into(),
                state.into(),
                "--json".into(),
                "number,title,url,state,headRefName,baseRefName".into(),
            ]
        }
        "github_pr_view" => {
            fields(v, &["repository", "number"], &["repository", "number"])?;
            vec!["pr".into(),"view".into(),number(v)?,"--repo".into(),repo(v)?.into(),"--json".into(),"number,title,url,state,body,headRefName,headRefOid,baseRefName,reviewDecision,statusCheckRollup".into()]
        }
        "github_pr_create" => {
            fields(
                v,
                &["repository", "head", "base", "title", "body", "draft"],
                &["repository", "head", "base", "title", "body"],
            )?;
            let title = string(v, "title", 1024)?;
            ensure!(!title.chars().any(char::is_control), "invalid title");
            let text = v["body"].as_str().context("body must be text")?;
            ensure!(text.len() <= 65536 && !text.contains('\0'), "invalid body");
            body = Some(text.to_owned());
            let mut args = vec![
                "pr".into(),
                "create".into(),
                "--repo".into(),
                repo(v)?.into(),
                "--head".into(),
                branch(v, "head")?.into(),
                "--base".into(),
                branch(v, "base")?.into(),
                "--title".into(),
                title.into(),
                "--body-file".into(),
                "-".into(),
            ];
            if let Some(draft) = v.get("draft") {
                ensure!(draft.is_boolean(), "draft must be boolean");
                if draft == true {
                    args.push("--draft".into());
                }
            }
            args
        }
        "github_pr_merge" => {
            fields(
                v,
                &["repository", "number", "headSha", "strategy"],
                &["repository", "number", "headSha", "strategy"],
            )?;
            let sha = string(v, "headSha", 40)?;
            ensure!(
                sha.len() == 40 && sha.bytes().all(|c| c.is_ascii_hexdigit()),
                "headSha must be a full Git commit SHA"
            );
            let strategy = string(v, "strategy", 10)?;
            ensure!(
                ["merge", "squash", "rebase"].contains(&strategy),
                "invalid merge strategy"
            );
            vec![
                "pr".into(),
                "merge".into(),
                number(v)?,
                "--repo".into(),
                repo(v)?.into(),
                format!("--{strategy}"),
                "--match-head-commit".into(),
                sha.into(),
            ]
        }
        _ => bail!("unknown GitHub tool"),
    };
    Ok((args, body))
}
async fn drain(mut pipe: impl tokio::io::AsyncRead + Unpin) -> Result<(Vec<u8>, bool)> {
    let mut out = Vec::new();
    let mut truncated = false;
    let mut buffer = [0u8; 8192];
    loop {
        let n = pipe.read(&mut buffer).await?;
        if n == 0 {
            break;
        }
        let take = n.min(LIMIT.saturating_sub(out.len()));
        out.extend_from_slice(&buffer[..take]);
        truncated |= take < n;
    }
    Ok((out, truncated))
}
async fn run(
    binary: &Path,
    cwd: &Path,
    name: &str,
    args: Vec<String>,
    body: Option<String>,
    cancel: CancellationToken,
) -> Result<Value> {
    ensure!(
        cwd.is_absolute() && cwd.is_dir(),
        "workspace directory unavailable"
    );
    ensure!(!cancel.is_cancelled(), "cancelled before execution");
    let mut command = tokio::process::Command::new(binary);
    command
        .args(&args)
        .current_dir(cwd)
        .env("GH_PROMPT_DISABLED", "1")
        .env("GH_NO_UPDATE_NOTIFIER", "1")
        .stdin(if body.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    {
        command.creation_flags(0x08000000);
    }
    let mut child = command
        .spawn()
        .context("GitHub CLI unavailable; install and authenticate gh")?;
    let output = child.stdout.take().context("stdout unavailable")?;
    let stdin = child.stdin.take();
    let result = tokio::select! { biased; _=cancel.cancelled()=>None, _=tokio::time::sleep(Duration::from_secs(60))=>None, value=async {
        let write=async { if let (Some(mut input),Some(text))=(stdin,body) { input.write_all(text.as_bytes()).await?; } Ok::<_,std::io::Error>(()) };
        let (status,out,written)=tokio::join!(child.wait(),drain(output),write);
        written?; Ok::<_,anyhow::Error>((status?,out?))
    }=>Some(value) };
    let Some(result) = result else {
        let _ = child.kill().await;
        if WRITE.contains(&name) {
            return Err(GithubUncertain.into());
        }
        bail!("GitHub request interrupted or timed out")
    };
    let (status, (output, truncated)) = match result {
        Ok(value) => value,
        Err(error) => {
            if WRITE.contains(&name) {
                return Err(GithubUncertain.into());
            }
            return Err(error);
        }
    };
    if !status.success() {
        if WRITE.contains(&name) {
            return Err(GithubUncertain.into());
        }
        bail!("GitHub CLI failed; check authentication and repository access")
    }
    if WRITE.contains(&name) && (truncated || output.is_empty()) && name == "github_pr_create" {
        return Err(GithubUncertain.into());
    }
    Ok(json!({"success":true,"output":String::from_utf8_lossy(&output),"truncated":truncated}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_injection_and_requires_reviewed_head() {
        for bad in [
            "-evil/repo",
            "owner/repo --admin",
            "owner/../repo",
            "owner/repo/other",
        ] {
            assert!(arguments("github_prs", &json!({"repository":bad})).is_err());
        }
        assert!(arguments(
            "github_pr_merge",
            &json!({"repository":"a/b","number":1,"headSha":"short","strategy":"merge"})
        )
        .is_err());
        assert!(arguments(
            "github_pr_merge",
            &json!({"repository":"a/b","number":1,"headSha":"a".repeat(40),"strategy":"admin"})
        )
        .is_err());
    }
    #[test]
    fn body_is_stdin_and_merge_has_no_implicit_destructive_options() {
        let (args,body)=arguments("github_pr_create",&json!({"repository":"a/b","head":"feature","base":"main","title":"Example","body":"secret body"})).unwrap();
        assert!(!args.iter().any(|arg| arg.contains("secret")));
        assert_eq!(body.as_deref(), Some("secret body"));
        let (args, _) = arguments(
            "github_pr_merge",
            &json!({"repository":"a/b","number":3,"headSha":"a".repeat(40),"strategy":"squash"}),
        )
        .unwrap();
        assert!(args.contains(&"--match-head-commit".to_string()));
        assert!(!args
            .iter()
            .any(|a| a == "--admin" || a == "--delete-branch"));
    }
    #[test]
    fn planning_lists_only_read_tools() {
        let names = GithubProvider
            .definitions("plan")
            .into_iter()
            .map(|v| v["function"]["name"].as_str().unwrap().to_string())
            .collect::<Vec<_>>();
        assert_eq!(names, READ);
        assert!(!GithubProvider.is_mutating("github_pr_view", &json!({})));
        assert!(GithubProvider.is_mutating("github_pr_merge", &json!({})));
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn real_subprocess_receives_body_and_cancelled_write_is_uncertain() {
        use std::os::unix::fs::PermissionsExt;
        let temp = tempfile::tempdir().unwrap();
        let binary = temp.path().join("fake-gh");
        std::fs::write(
            &binary,
            b"#!/bin/sh\ncat >/dev/null\nprintf 'https://example.invalid/pull/1\\n'\n",
        )
        .unwrap();
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o700)).unwrap();
        let (args,body)=arguments("github_pr_create",&json!({"repository":"a/b","head":"feature","base":"main","title":"Example","body":"test body"})).unwrap();
        let result = run(
            &binary,
            temp.path(),
            "github_pr_create",
            args,
            body,
            CancellationToken::new(),
        )
        .await
        .unwrap();
        assert_eq!(result["success"], true);
        assert_eq!(result["output"], "https://example.invalid/pull/1\n");
        std::fs::write(&binary, b"#!/bin/sh\nwhile :; do :; done\n").unwrap();
        let cancel = CancellationToken::new();
        let trigger = cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(50)).await;
            trigger.cancel();
        });
        let result = run(
            &binary,
            temp.path(),
            "github_pr_merge",
            vec![],
            None,
            cancel,
        )
        .await
        .unwrap_err();
        assert!(result.downcast_ref::<GithubUncertain>().is_some());
    }
}
