//! Read permissions and project guidance. Ignore files never grant execution authority.
use crate::settings::PrivacySettings;
use anyhow::{ensure, Context, Result};
use ignore::gitignore::{Gitignore, GitignoreBuilder};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, MutexGuard, PoisonError},
    time::{Duration, Instant},
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
/// Whether `path` names a file whose contents are privacy rules. Compared
/// without case: on a case-insensitive filesystem `.GITIGNORE` is the same file.
pub fn is_ignore_file(path: &Path) -> bool {
    path.file_name().and_then(|n| n.to_str()).is_some_and(|n| {
        n.eq_ignore_ascii_case(".gitignore") || n.eq_ignore_ascii_case(".trexignore")
    })
}
/// Entries one policy walk may visit. Ordinary projects, large monorepos
/// included, never get near it; it only turns a workspace opened on a whole
/// drive into an explained error instead of a tool call that never returns.
/// Reaching it fails the policy: a partial one would leave files readable.
const MAX_POLICY_ENTRIES: usize = 5_000_000;
/// How long the ignore rules loaded by one call are reused by the next ones. A
/// rule added outside the agent's file tools applies at most this long after
/// the walk that missed it finished.
const POLICY_CACHE_TTL: Duration = Duration::from_secs(5);

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    // A panic under one of these locks leaves a dated matcher or an empty
    // slot behind, never a half-written one, so the poison flag is ignored.
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}
type PolicySlot = Arc<Mutex<Option<(Instant, Arc<Gitignore>)>>>;
/// Ignore matchers by canonical root and `respect_gitignore`, the one privacy
/// setting that decides which files are loaded. The other settings are applied
/// by `Policy::allowed` from the caller's own copy and are never cached.
struct PolicyCache {
    slots: Mutex<BTreeMap<(PathBuf, bool), PolicySlot>>,
}
static POLICY_CACHE: PolicyCache = PolicyCache::new();
impl PolicyCache {
    const fn new() -> Self {
        Self {
            slots: Mutex::new(BTreeMap::new()),
        }
    }
    /// `root` must be canonical and normalized. `now` is the caller's clock, so
    /// tests can let the TTL pass without sleeping.
    fn ignored(
        &self,
        root: &Path,
        respect_gitignore: bool,
        max_entries: usize,
        now: Instant,
    ) -> Result<Arc<Gitignore>> {
        let fresh = |slot: &Option<(Instant, Arc<Gitignore>)>| {
            slot.as_ref()
                .filter(|(built, _)| now.saturating_duration_since(*built) < POLICY_CACHE_TTL)
                .map(|(_, ignored)| ignored.clone())
        };
        let slot = {
            let mut slots = lock(&self.slots);
            // Expired matchers of workspaces no longer in use are dropped here,
            // so a long-lived server keeps only those of the last few seconds.
            // A slot someone else holds is being built or read: left alone.
            slots.retain(|_, slot| Arc::strong_count(slot) > 1 || fresh(&lock(slot)).is_some());
            slots
                .entry((root.to_path_buf(), respect_gitignore))
                .or_default()
                .clone()
        };
        // The slot stays locked during the walk: parallel tool calls on a cold
        // workspace wait for one walk instead of each starting their own.
        let mut slot = lock(&slot);
        if let Some(ignored) = fresh(&slot) {
            return Ok(ignored);
        }
        // Emptied before walking, so neither an error nor an expired matcher
        // survives a failed walk.
        *slot = None;
        let ignored = Arc::new(Policy::load_ignored(root, respect_gitignore, max_entries)?);
        *slot = Some((Instant::now(), ignored.clone()));
        Ok(ignored)
    }
    /// A walk still running for `root` finishes into its detached slot and is
    /// served only to the calls already waiting for it.
    fn invalidate(&self, root: &Path) {
        lock(&self.slots).retain(|(cached, _), _| cached != root);
    }
}
/// Cheap to clone: the ignore matcher is shared with the policy cache.
#[derive(Clone)]
pub struct Policy {
    root: PathBuf,
    ignored: Arc<Gitignore>,
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
    /// Loads the ignore files of the whole tree below `root`, or fails. All or
    /// nothing: every rule left out is a set of files the agent could read.
    fn load_ignored(
        root: &Path,
        respect_gitignore: bool,
        max_entries: usize,
    ) -> Result<Gitignore> {
        let mut builder = GitignoreBuilder::new(root);
        // Nested ignore rules are interpreted relative to the directory that owns them.
        let walker = ignore::WalkBuilder::new(root)
            .hidden(false)
            .git_ignore(false)
            .git_exclude(false)
            .git_global(false)
            // This walk only collects rules, so nothing may hide a directory
            // from it: a `.ignore` file (here or in a parent directory) that
            // skipped a folder would leave that folder's own rules unread.
            .ignore(false)
            .parents(false)
            .max_depth(Some(32))
            .filter_entry(|entry| {
                !matches!(
                    entry.file_name().to_str(),
                    Some(".git" | "node_modules" | "target")
                ) && !entry.path_is_symlink()
            })
            .build();
        for (n, entry) in walker.enumerate() {
            ensure!(
                n < max_entries,
                "workspace is too large to build the privacy policy: more than {max_entries} files and directories under {}. File tools are refused rather than run without its ignore rules; open a smaller directory as the workspace",
                root.display()
            );
            let Ok(entry) = entry else {
                continue;
            };
            let name = entry.file_name().to_str().unwrap_or("");
            if (respect_gitignore && name == ".gitignore") || name == ".trexignore" {
                if fs::metadata(entry.path()).is_ok_and(|m| m.len() <= 256 * 1024) {
                    builder.add(entry.path());
                }
            }
        }
        builder.build().context("invalid project ignore rules")
    }
    /// Always walks the workspace. For one-off callers; tool calls use `cached`.
    pub fn new(root: &Path, privacy: PrivacySettings) -> Result<Self> {
        let root = normalized(&root.canonicalize()?);
        let ignored = Arc::new(Self::load_ignored(
            &root,
            privacy.respect_gitignore,
            MAX_POLICY_ENTRIES,
        )?);
        Ok(Self {
            root,
            ignored,
            privacy,
        })
    }
    /// Same policy as `new`, reusing the ignore rules another call loaded for
    /// this workspace within the last `POLICY_CACHE_TTL`.
    pub fn cached(root: &Path, privacy: PrivacySettings) -> Result<Self> {
        let root = normalized(&root.canonicalize()?);
        let ignored = POLICY_CACHE.ignored(
            &root,
            privacy.respect_gitignore,
            MAX_POLICY_ENTRIES,
            Instant::now(),
        )?;
        Ok(Self {
            root,
            ignored,
            privacy,
        })
    }
    /// Forgets the cached rules of a workspace whose ignore files just changed,
    /// so the next `cached` call walks it again.
    pub fn invalidate(root: &Path) {
        let canonical = root.canonicalize();
        POLICY_CACHE.invalidate(&normalized(canonical.as_deref().unwrap_or(root)));
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
/// Nested AGENTS.md files are listed, not inlined: their paths cost a few
/// tokens per request, their contents only when the agent works there.
const MAX_NESTED_INDEX: usize = 32;
const MAX_NESTED_INDEX_BYTES: usize = 4 * 1024;

/// System-prompt guidance: AGENTS.md of the workspace root and its ancestors
/// in full (32 KiB each, 64 KiB total), plus an index of nested AGENTS.md
/// files that pass the privacy policy, to be read with read_file on demand.
pub fn guidance(root: &Path, privacy: &PrivacySettings) -> Result<String> {
    let policy = Policy::cached(root, privacy.clone())?;
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
        .sort_by_file_path(|a, b| a.cmp(b))
        .filter_entry(|e| {
            !matches!(
                e.file_name().to_str(),
                Some(".git" | "node_modules" | "target")
            ) && !e.path_is_symlink()
        })
        .build();
    let mut nested = Vec::new();
    let mut omitted = 0usize;
    for (n, entry) in walker.enumerate() {
        if n >= 10000 {
            break;
        }
        let Ok(e) = entry else {
            continue;
        };
        if e.file_name() == "AGENTS.md"
            && e.path() != root.join("AGENTS.md")
            && e.file_type().is_some_and(|kind| kind.is_file())
            && policy.allowed(e.path(), false)
        {
            let relative = e
                .path()
                .strip_prefix(root)
                .unwrap_or(e.path())
                .to_string_lossy()
                .replace('\\', "/");
            let used: usize = nested.iter().map(|p: &String| p.len() + 2).sum();
            if nested.len() < MAX_NESTED_INDEX && used + relative.len() <= MAX_NESTED_INDEX_BYTES {
                nested.push(relative);
            } else {
                omitted += 1;
            }
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
    if !nested.is_empty() {
        result.push_str(&format!(
            "\nMore specific project instructions exist in: {}{}. Read the relevant AGENTS.md with read_file before working in that directory; it takes precedence there.\n",
            nested.join(", "),
            if omitted > 0 {
                format!(" (and {omitted} more; find them with list_files/search)")
            } else {
                String::new()
            }
        ));
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

    #[test]
    fn nested_ignore_files_past_ten_thousand_entries_still_protect_their_files() {
        // The walk visits entries in whatever order the filesystem returns, so
        // no single ignore file can be placed "late" reliably. Instead 401
        // ignore files each sit at the end of their own chain of 24
        // directories: reaching all of them takes 401 * 25 = 10,025 entries
        // plus the root in any order, so a walk that gives up after 10,000
        // misses at least one. Requiring every one of them is order-proof, and
        // chains need far fewer ignore files than one per directory would
        // (reading them is the slow part). The ten thousand entries still take
        // several seconds to create and remove on Windows.
        const CHAINS: usize = 401;
        const DEPTH: usize = 24;
        let d = tempfile::tempdir().unwrap();
        let chain = |n: usize| {
            let mut dir = d.path().join(format!("c{n}"));
            dir.extend(std::iter::repeat("n").take(DEPTH - 1));
            dir
        };
        for n in 0..CHAINS {
            fs::create_dir_all(chain(n)).unwrap();
            fs::write(chain(n).join(".trexignore"), format!("secret-{n}.txt\n")).unwrap();
        }
        let p = Policy::new(d.path(), PrivacySettings::default()).unwrap();
        let exposed: Vec<_> = (0..CHAINS)
            .filter(|n| p.allowed(&chain(*n).join(format!("secret-{n}.txt")), false))
            .collect();
        assert!(
            exposed.is_empty(),
            "{} protected files are readable, e.g. in chain {}",
            exposed.len(),
            exposed[0]
        );
        assert!(p.allowed(&chain(0).join("public.txt"), false));
    }

    #[test]
    fn a_dot_ignore_file_cannot_hide_a_folder_whose_rules_protect_files() {
        let d = tempfile::tempdir().unwrap();
        // `.ignore` is for search tools; it must not stop the privacy rules of `hidden/` from loading.
        fs::write(d.path().join(".ignore"), "hidden/\n").unwrap();
        fs::create_dir(d.path().join("hidden")).unwrap();
        fs::write(d.path().join("hidden/.trexignore"), "secret.txt\n").unwrap();
        fs::write(d.path().join("hidden/secret.txt"), "x").unwrap();
        let p = Policy::new(d.path(), PrivacySettings::default()).unwrap();
        assert!(!p.allowed(&d.path().join("hidden/secret.txt"), false));
        assert!(p.allowed(&d.path().join("hidden/public.txt"), false));
    }

    #[test]
    fn a_workspace_over_the_entry_bound_fails_instead_of_yielding_a_partial_policy() {
        let d = tempfile::tempdir().unwrap();
        let root = normalized(&d.path().canonicalize().unwrap());
        // Ten entries with the root itself.
        for n in 0..8 {
            fs::write(root.join(format!("f{n}")), "").unwrap();
        }
        fs::write(root.join(".trexignore"), "secret.txt\n").unwrap();
        assert!(Policy::load_ignored(&root, true, 10).is_ok());
        let error = Policy::load_ignored(&root, true, 9).unwrap_err().to_string();
        assert!(
            error.contains("workspace is too large to build the privacy policy"),
            "{error}"
        );

        // Neither the failure nor the rules it replaced are remembered.
        let cache = PolicyCache::new();
        let start = Instant::now();
        let secret = root.join("secret.txt");
        let stored = cache.ignored(&root, true, MAX_POLICY_ENTRIES, start).unwrap();
        assert!(stored.matched_path_or_any_parents(&secret, false).is_ignore());
        let later = Instant::now() + POLICY_CACHE_TTL;
        assert!(cache.ignored(&root, true, 9, later).is_err());
        assert!(cache.ignored(&root, true, 9, start).is_err(), "expired rules served");
        let rebuilt = cache.ignored(&root, true, MAX_POLICY_ENTRIES, start).unwrap();
        assert!(rebuilt.matched_path_or_any_parents(&secret, false).is_ignore());
    }

    #[test]
    fn cached_rules_are_reused_until_the_ttl_passes_or_they_are_invalidated() {
        let d = tempfile::tempdir().unwrap();
        let root = normalized(&d.path().canonicalize().unwrap());
        fs::create_dir_all(root.join("a/b")).unwrap();
        fs::write(root.join(".trexignore"), "first.txt\n").unwrap();
        // A private cache and a clock frozen at `start`: no other test and no
        // stalled runner can expire or evict what this test stores.
        let cache = PolicyCache::new();
        let start = Instant::now();
        let load = |now| cache.ignored(&root, true, MAX_POLICY_ENTRIES, now).unwrap();
        let denies = |ignored: &Gitignore, file: &str| {
            ignored
                .matched_path_or_any_parents(root.join(file), false)
                .is_ignore()
        };
        let first = load(start);
        assert!(denies(&first, "first.txt"));

        // Within the TTL the stored matcher is handed out without a walk, so a
        // rule added meanwhile is not seen yet.
        fs::write(root.join("a/.trexignore"), "second.txt\n").unwrap();
        let reused = load(start);
        assert!(Arc::ptr_eq(&first, &reused));
        assert!(!denies(&reused, "a/second.txt"));

        // Once the TTL has passed the tree is walked again.
        let expired = load(Instant::now() + POLICY_CACHE_TTL);
        assert!(denies(&expired, "a/second.txt"));
        assert!(Arc::ptr_eq(&expired, &load(start)), "the new walk is cached");

        // Invalidation does not wait for the TTL.
        fs::write(root.join("a/b/.trexignore"), "third.txt\n").unwrap();
        assert!(!denies(&load(start), "a/b/third.txt"));
        cache.invalidate(&root);
        assert!(denies(&load(start), "a/b/third.txt"));
    }

    #[test]
    fn cached_policy_matches_a_fresh_one_for_every_privacy_setting() {
        let d = tempfile::tempdir().unwrap();
        for dir in ["cache", "notes", "src", "docs"] {
            fs::create_dir(d.path().join(dir)).unwrap();
        }
        fs::write(d.path().join(".gitignore"), "cache/\n").unwrap();
        fs::write(d.path().join(".trexignore"), "notes/\n").unwrap();
        let path = |file: &str| d.path().join(file);
        let without_gitignore = PrivacySettings {
            respect_gitignore: false,
            ..PrivacySettings::default()
        };
        let permissive = PrivacySettings {
            allow_sensitive_files: true,
            allow_paths: vec!["cache/kept".into()],
            ..PrivacySettings::default()
        };
        for privacy in [
            PrivacySettings::default(),
            without_gitignore.clone(),
            permissive,
        ] {
            let fresh = Policy::new(d.path(), privacy.clone()).unwrap();
            // Twice: the second policy comes from what the first one stored.
            for _ in 0..2 {
                let cached = Policy::cached(d.path(), privacy.clone()).unwrap();
                for file in [
                    "cache/file",
                    "cache/kept",
                    "notes/todo",
                    "src/main.rs",
                    ".env",
                    ".env.example",
                ] {
                    assert_eq!(
                        cached.allowed(&path(file), false),
                        fresh.allowed(&path(file), false),
                        "{file} with {privacy:?}"
                    );
                }
            }
        }
        // The settings share one workspace but never each other's rules.
        let cached = |privacy: &PrivacySettings| Policy::cached(d.path(), privacy.clone()).unwrap();
        assert!(!cached(&PrivacySettings::default()).allowed(&path("cache/file"), false));
        assert!(cached(&without_gitignore).allowed(&path("cache/file"), false));

        // An ignore file written after the policy was cached is honoured as
        // soon as the workspace is invalidated.
        fs::write(path("docs/.trexignore"), "draft.md\n").unwrap();
        Policy::invalidate(d.path());
        assert!(!cached(&PrivacySettings::default()).allowed(&path("docs/draft.md"), false));
        assert!(!cached(&without_gitignore).allowed(&path("docs/draft.md"), false));
    }

    #[tokio::test]
    async fn an_ignore_file_changed_by_a_file_tool_applies_to_the_next_tool_call() {
        use serde_json::{json, Value};
        async fn tool(cwd: &Path, name: &str, input: Value) -> Result<Value> {
            let cancel = tokio_util::sync::CancellationToken::new();
            crate::tools::execute(cwd, name, &input, cancel).await
        }
        let d = tempfile::tempdir().unwrap();
        fs::create_dir(d.path().join("docs")).unwrap();
        fs::write(d.path().join("docs/draft.md"), "draft").unwrap();
        let read = || tool(d.path(), "read_file", json!({"path":"docs/draft.md"}));
        let rename = |from: &str, to: &str| {
            tool(d.path(), "rename_file", json!({"path":from,"destination":to}))
        };
        // Every call below runs well inside the TTL of the policy cached by
        // the previous one; only invalidation makes the rule change visible.
        assert!(read().await.is_ok());
        let rule = json!({"path":"docs/.trexignore","content":"draft.md\n"});
        tool(d.path(), "write_file", rule).await.unwrap();
        let denied = read().await.unwrap_err().to_string();
        assert!(denied.contains("privacy policy"), "{denied}");
        rename("docs/.trexignore", "docs/rules.off").await.unwrap();
        assert!(read().await.is_ok(), "rule renamed away");
        rename("docs/rules.off", "docs/.trexignore").await.unwrap();
        assert!(read().await.is_err(), "rule renamed back");
        tool(d.path(), "remove_file", json!({"path":"docs/.trexignore"}))
            .await
            .unwrap();
        assert!(read().await.is_ok(), "rule removed");
    }

    #[test]
    fn root_guidance_is_inlined_and_nested_guidance_is_only_indexed() {
        let d = tempfile::tempdir().unwrap();
        fs::write(d.path().join("AGENTS.md"), "ROOT_RULES: run tests").unwrap();
        fs::write(d.path().join(".gitignore"), "generated/\n").unwrap();
        for dir in ["web/app", "api", "generated"] {
            fs::create_dir_all(d.path().join(dir)).unwrap();
            fs::write(
                d.path().join(dir).join("AGENTS.md"),
                format!("NESTED_RULES_{dir}"),
            )
            .unwrap();
        }
        let text = guidance(d.path(), &PrivacySettings::default()).unwrap();
        assert!(text.contains("ROOT_RULES: run tests"));
        assert!(!text.contains("NESTED_RULES"), "nested contents are not inlined");
        assert!(text.contains("api/AGENTS.md, web/app/AGENTS.md"), "{text}");
        assert!(text.contains("read_file"));
        assert!(!text.contains("generated/AGENTS.md"), "privacy policy applies");
        // Deterministic order keeps the system prompt (and its cache) stable.
        assert_eq!(text, guidance(d.path(), &PrivacySettings::default()).unwrap());
    }
}
