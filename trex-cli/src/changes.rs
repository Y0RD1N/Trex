//! Private checkpoints cover native file tools only; arbitrary shell changes need Git review.
use anyhow::{ensure, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
};
#[derive(Clone, Serialize, Deserialize)]
pub struct FileChange {
    pub path: String,
    pub before: Option<String>,
    pub after: Option<String>,
}
#[derive(Serialize, Deserialize)]
struct Checkpoint {
    id: String,
    workspace: PathBuf,
    state: String,
    files: Vec<FileChange>,
}
fn name(id: &str) -> Result<String> {
    ensure!(
        uuid::Uuid::parse_str(id).is_ok_and(|u| u.to_string() == id),
        "invalid checkpoint ID"
    );
    Ok(format!("change-{id}.json"))
}
pub fn prepare(cwd: &Path, files: Vec<FileChange>) -> Result<Option<String>> {
    if files.is_empty() {
        return Ok(None);
    }
    ensure!(
        files.len() <= 32
            && files.iter().all(|f| f
                .before
                .as_ref()
                .is_none_or(|s| s.len() <= 1024 * 1024 && !s.contains('\0'))
                && f.after
                    .as_ref()
                    .is_none_or(|s| s.len() <= 1024 * 1024 && !s.contains('\0'))),
        "checkpoint file limits exceeded"
    );
    ensure!(
        files
            .iter()
            .map(|f| f.before.as_ref().map_or(0, String::len)
                + f.after.as_ref().map_or(0, String::len))
            .sum::<usize>()
            <= 8 * 1024 * 1024,
        "checkpoint exceeds 8 MiB"
    );
    let id = uuid::Uuid::new_v4().to_string();
    let record = Checkpoint {
        id: id.clone(),
        workspace: cwd.canonicalize()?,
        state: "prepared".into(),
        files,
    };
    crate::profile::write_user_file(&name(&id)?, &serde_json::to_vec(&record)?)?;
    Ok(Some(id))
}
pub fn finish(id: &str, success: bool) -> Result<()> {
    let name = name(id)?;
    let bytes = crate::profile::read_user_file(&name)?.context("checkpoint missing")?;
    let mut record: Checkpoint = serde_json::from_slice(&bytes)?;
    record.state = if success {
        "applied"
    } else {
        "review_required"
    }
    .into();
    crate::profile::write_user_file(&name, &serde_json::to_vec(&record)?)
}
pub fn list(cwd: &Path) -> Result<Value> {
    let cwd = cwd.canonicalize()?;
    let mut records = Vec::new();
    for entry in fs::read_dir(crate::profile::home()?)? {
        let entry = entry?;
        let filename = entry.file_name().to_string_lossy().into_owned();
        if !filename.starts_with("change-") || !filename.ends_with(".json") {
            continue;
        }
        let Some(bytes) = crate::profile::read_user_file(&filename)? else {
            continue;
        };
        let record: Checkpoint = serde_json::from_slice(&bytes)?;
        if record.workspace == cwd {
            records.push(json!({"id":record.id,"state":record.state,"files":record.files.iter().map(|f|&f.path).collect::<Vec<_>>()}));
        }
    }
    Ok(json!({"checkpoints":records,"scope":"native_file_tools_only"}))
}
fn load(cwd: &Path, id: &str) -> Result<Checkpoint> {
    let record: Checkpoint = serde_json::from_slice(
        &crate::profile::read_user_file(&name(id)?)?.context("checkpoint missing")?,
    )?;
    ensure!(
        record.id == id && record.workspace == cwd.canonicalize()?,
        "checkpoint belongs to a different workspace"
    );
    Ok(record)
}
pub fn diff(cwd: &Path, id: &str) -> Result<Value> {
    let record = load(cwd, id)?;
    let patches=record.files.iter().map(|f|json!({"path":f.path,"diff":crate::context::clip(&diffy::create_patch(f.before.as_deref().unwrap_or(""),f.after.as_deref().unwrap_or("")).to_string(),128*1024)})).collect::<Vec<_>>();
    Ok(json!({"id":id,"state":record.state,"files":patches}))
}
pub fn undo(cwd: &Path, id: &str, privacy: &crate::settings::PrivacySettings) -> Result<Value> {
    let mut record = load(cwd, id)?;
    ensure!(record.state != "restored", "checkpoint already restored");
    let ws = crate::tools::Workspace::configured(cwd, privacy.clone())?;
    for file in &record.files {
        let path = ws.resolve(&file.path, true)?;
        ws.require(&path)?;
        let current = if path.exists() {
            Some(fs::read_to_string(&path)?)
        } else {
            None
        };
        ensure!(
            current == file.after,
            "{} changed after the checkpoint; restore refused to preserve newer work",
            file.path
        );
    }
    let restore = (|| -> Result<()> {
        for file in record.files.iter().rev() {
            let path = ws.resolve(&file.path, true)?;
            if let Some(before) = &file.before {
                crate::tools::execute_sync_restore(cwd, &file.path, before, privacy)?;
            } else if path.exists() {
                fs::remove_file(path)?;
            }
        }
        Ok(())
    })();
    restore.map_err(|e| {
        e.context(crate::tools::ToolExecutionUncertain(
            "Checkpoint restore stopped; inspect all listed files before continuing".into(),
        ))
    })?;
    record.state = "restored".into();
    crate::profile::write_user_file(&name(id)?, &serde_json::to_vec(&record)?)?;
    Ok(json!({"restored":true,"id":id}))
}
pub fn hash(text: &str) -> String {
    format!("{:x}", Sha256::digest(text.as_bytes()))
}
