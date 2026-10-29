//! Read permissions and project guidance. Ignore files never grant execution authority.
use crate::settings::PrivacySettings;
use anyhow::{ensure, Context, Result};
use ignore::gitignore::{Gitignore, GitignoreBuilder};
use std::{
    fs,
    path::{Path, PathBuf},
};

pub fn sensitive(path: &Path) -> bool {
    path.components().any(|c| {
        let name = c.as_os_str().to_string_lossy().to_ascii_lowercase();
        (name == ".env" || name.starts_with(".env."))
            && !matches!(
                name.as_str(),
                ".env.example" | ".env.sample" | ".env.template"
            )
            || matches!(
                name.as_str(),
                ".git"
                    | ".ssh"
                    | ".aws"
                    | ".azure"
                    | ".gnupg"
                    | "credentials.json"
                    | "service-account.json"
                    | "id_rsa"
                    | "id_ed25519"
                    | ".netrc"
                    | ".npmrc"
            )
            || name.ends_with(".pem")
            || name.ends_with(".p12")
            || name.ends_with(".pfx")
            || name.ends_with(".key")
    })
}
pub struct Policy {
    root: PathBuf,
    ignored: Gitignore,
    privacy: PrivacySettings,
}
fn normalized(path: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        let s = path.to_string_lossy();
        PathBuf::from(s.strip_prefix(r"\\?\").unwrap_or(&s))
    }
    #[cfg(not(windows))]
    {
        path.to_path_buf()
    }
}
impl Policy {
    pub fn new(root: &Path, privacy: PrivacySettings) -> Result<Self> {
        let root = normalized(&root.canonicalize()?);
        let mut builder = GitignoreBuilder::new(&root);
        // Nested ignore rules are interpreted relative to the directory that owns them.
        let walker = ignore::WalkBuilder::new(&root)
            .hidden(false)
            .git_ignore(false)
            .git_exclude(false)
            .git_global(false)
            .max_depth(Some(32))
            .filter_entry(|entry| {
                !matches!(
                    entry.file_name().to_str(),
                    Some(".git" | "node_modules" | "target")
                ) && !entry.path_is_symlink()
            })
            .build();
        for (n, entry) in walker.enumerate() {
            if n >= 10000 {
                break;
            }
            let Ok(entry) = entry else {
                continue;
            };
            let name = entry.file_name().to_str().unwrap_or("");
            if (privacy.respect_gitignore && name == ".gitignore") || name == ".trexignore" {
                if fs::metadata(entry.path()).is_ok_and(|m| m.len() <= 256 * 1024) {
                    builder.add(entry.path());
                }
            }
        }
        let ignored = builder.build().context("invalid project ignore rules")?;
        Ok(Self {
            root,
            ignored,
            privacy,
        })
    }
    pub fn allowed(&self, path: &Path, is_dir: bool) -> bool {
        let canonical = path.canonicalize().or_else(|_| {
            path.parent()
                .context("path parent unavailable")
                .and_then(|p| Ok(p.canonicalize()?.join(path.file_name().unwrap_or_default())))
        });
        let path = normalized(canonical.as_deref().unwrap_or(path));
        let path = path.as_path();
        if !path.starts_with(&self.root) {
            return false;
        }
        let relative = path.strip_prefix(&self.root).unwrap_or(path);
        let explicitly_allowed = self
            .privacy
            .allow_paths
            .iter()
            .any(|p| relative == Path::new(p));
        if explicitly_allowed {
            return true;
        }
        (!sensitive(relative) || self.privacy.allow_sensitive_files)
            && !self
                .ignored
                .matched_path_or_any_parents(path, is_dir)
                .is_ignore()
    }
    pub fn require(&self, path: &Path) -> Result<()> {
        ensure!(self.allowed(path,path.is_dir()),"file excluded by project privacy policy; explicitly allow its workspace-relative path in user configuration if needed");
        Ok(())
    }
}
pub fn guidance(root: &Path, privacy: &PrivacySettings) -> Result<String> {
    let policy = Policy::new(root, privacy.clone())?;
    let mut files = Vec::new();
    for dir in root.ancestors().collect::<Vec<_>>().into_iter().rev() {
        let file = dir.join("AGENTS.md");
        if file.is_file() {
            files.push((file, dir.to_path_buf()));
        }
    }
    let walker = ignore::WalkBuilder::new(root)
        .hidden(false)
        .max_depth(Some(8))
        .filter_entry(|e| {
            !matches!(
                e.file_name().to_str(),
                Some(".git" | "node_modules" | "target")
            ) && !e.path_is_symlink()
        })
        .build();
    for (n, entry) in walker.enumerate() {
        if n >= 10000 || files.len() >= 64 {
            break;
        }
        let Ok(e) = entry else {
            continue;
        };
        if e.file_name() == "AGENTS.md"
            && e.path() != root.join("AGENTS.md")
            && policy.allowed(e.path(), false)
        {
            files.push((
                e.path().to_path_buf(),
                e.path().parent().unwrap_or(root).to_path_buf(),
            ));
        }
    }
    let mut result = String::new();
    for (file, scope) in files {
        let meta = fs::symlink_metadata(&file)?;
        if meta.file_type().is_symlink() || meta.len() > 32 * 1024 {
            continue;
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if meta.file_attributes() & 0x400 != 0 {
                continue;
            }
        }
        let text = fs::read_to_string(file)?;
        if result.len() + text.len() > 64 * 1024 {
            break;
        }
        result.push_str(&format!("\nProject instructions, scope {} (more specific directories take precedence; tool permissions remain authoritative):\n{text}\n",scope.display()));
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ignores_generated_and_sensitive_files_but_allows_examples() {
        let d = tempfile::tempdir().unwrap();
        fs::write(d.path().join(".gitignore"), "cache/\n").unwrap();
        fs::create_dir(d.path().join("cache")).unwrap();
        let p = Policy::new(d.path(), PrivacySettings::default()).unwrap();
        assert!(!p.allowed(&d.path().join("cache/file"), false));
        assert!(!p.allowed(&d.path().join(".env"), false));
        assert!(p.allowed(&d.path().join(".env.example"), false));
    }
}
