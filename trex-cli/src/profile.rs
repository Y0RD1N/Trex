//! Profile metadata and OS-protected credentials. A persistent sidecar lock
//! covers each transaction, including credential staging and cleanup.

use anyhow::{anyhow, bail, ensure, Result};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::ffi::OsStr;
use std::fs::{self, File, OpenOptions};
use std::io::{ErrorKind, Read, Write};
use std::net::IpAddr;
use std::path::{Path, PathBuf};
use uuid::Uuid;

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Profile {
    pub name: String,
    pub provider: String,
    #[serde(rename = "baseUrl")]
    pub base_url: String,
    pub model: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
}

/// Resolve the storage directory without accessing any credential backend.
pub fn home() -> Result<PathBuf> {
    resolve_home(std::env::var_os("TREX_HOME").as_deref(), dirs::data_dir())
}

fn resolve_home(override_path: Option<&OsStr>, data_dir: Option<PathBuf>) -> Result<PathBuf> {
    let path = match override_path {
        Some(path) if path.is_empty() => bail!("TREX_HOME must not be empty"),
        Some(path) => PathBuf::from(path),
        None => data_dir
            .ok_or_else(|| anyhow!("could not locate the application data directory"))?
            .join("trex-agent"),
    };
    if path.is_absolute() {
        Ok(path)
    } else {
        Ok(std::env::current_dir()
            .map_err(|_| anyhow!("could not resolve the profile directory"))?
            .join(path))
    }
}

pub fn list() -> Result<Vec<Value>> {
    native_store()?.list()
}

pub fn save(input: Value) -> Result<Value> {
    native_store()?.save(input)
}

pub fn remove(name: &str) -> Result<()> {
    native_store()?.remove(name)
}

pub fn load(name: &str) -> Result<Profile> {
    native_store()?.load(name)
}

pub fn api_key(profile: &Profile) -> Result<Option<String>> {
    native_store()?.api_key(profile)
}

/// Fixed-name, private CLI-owned documents share the credential home's checks.
pub fn read_user_file(name: &str) -> Result<Option<Vec<u8>>> {
    ensure_user_filename(name)?;
    let store = native_store()?;
    let _lock = store.lock()?;
    read_private_file(&store.directory.join(name))
}
pub(crate) fn update_user_file(
    name: &str,
    update: impl FnOnce(Option<Vec<u8>>) -> Result<Vec<u8>>,
) -> Result<()> {
    ensure_user_filename(name)?;
    let store = native_store()?;
    let _lock = store.lock()?;
    let path = store.directory.join(name);
    let bytes = update(read_private_file(&path)?)?;
    ensure!(
        bytes.len() <= 64 * 1024 * 1024,
        "private document exceeds 64 MiB"
    );
    atomic_write(&path, &bytes)?.require_durable()
}
pub fn write_user_file(name: &str, bytes: &[u8]) -> Result<()> {
    ensure_user_filename(name)?;
    ensure!(
        bytes.len() <= 64 * 1024 * 1024,
        "private document exceeds 64 MiB"
    );
    let store = native_store()?;
    let _lock = store.lock()?;
    atomic_write(&store.directory.join(name), bytes)?.require_durable()
}
pub(crate) fn lock_user_file(name: &str, exclusive: bool) -> Result<File> {
    ensure_user_filename(name)?;
    let store = native_store()?;
    let _lock = store.lock()?;
    let path = store.directory.join(name);
    reject_link(&path)?;
    let mut options = OpenOptions::new();
    options.create(true).truncate(false).read(true).write(true);
    private_options(&mut options);
    let file = options.open(path)?;
    secure_file(&file, true)?;
    if exclusive {
        FileExt::try_lock_exclusive(&file)
    } else {
        FileExt::try_lock_shared(&file)
    }
    .map_err(|_| anyhow!("conversation storage is in use; close sessions before cleanup"))?;
    Ok(file)
}
pub(crate) fn validate_storage_path(path: &Path) -> Result<()> {
    for ancestor in path.ancestors() {
        reject_link(ancestor)?;
    }
    Ok(())
}
fn ensure_user_filename(name: &str) -> Result<()> {
    if !name.is_empty()
        && name.len() <= 80
        && name
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c))
        && name != "."
        && name != ".."
    {
        Ok(())
    } else {
        bail!("invalid private document name")
    }
}
pub(crate) fn global_control_lock() -> Result<File> {
    let directory = dirs::data_local_dir()
        .ok_or_else(|| anyhow!("local user directory unavailable"))?
        .join("trex-agent-system");
    private_directory(&directory)?;
    let path = directory.join("desktop.lock");
    reject_link(&path)?;
    let mut options = OpenOptions::new();
    options.create(true).truncate(false).read(true).write(true);
    private_options(&mut options);
    let file = options.open(path)?;
    secure_file(&file, true)?;
    file.try_lock_exclusive()
        .map_err(|_| anyhow!("another Trex desktop operation is in progress"))?;
    Ok(file)
}

fn native_store() -> Result<ProfileStore<platform::Credentials>> {
    let directory = home()?;
    let credentials = platform::Credentials::new(&directory);
    Ok(ProfileStore {
        directory,
        credentials,
    })
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SaveInput {
    name: String,
    provider: String,
    model: String,
    #[serde(default, rename = "baseUrl")]
    base_url: Option<String>,
    #[serde(default)]
    effort: Option<String>,
    #[serde(default, rename = "apiKey")]
    api_key: KeyUpdate,
}

#[derive(Default)]
enum KeyUpdate {
    #[default]
    Retain,
    Delete,
    Set(String),
}

impl<'de> Deserialize<'de> for KeyUpdate {
    fn deserialize<D: serde::Deserializer<'de>>(
        deserializer: D,
    ) -> std::result::Result<Self, D::Error> {
        let key = String::deserialize(deserializer)?;
        Ok(if key.is_empty() {
            Self::Delete
        } else {
            Self::Set(key)
        })
    }
}

impl SaveInput {
    fn parse(input: Value) -> Result<(Profile, KeyUpdate)> {
        // Serde's errors can quote supplied values. Never attach those errors to
        // diagnostics because the input includes the API key.
        let input: Self = serde_json::from_value(input).map_err(|_| {
            anyhow!("invalid profile input: expected name, provider, model, and optional baseUrl, effort, apiKey")
        })?;
        let default_url = provider_url(&input.provider)?;
        let base_url = input
            .base_url
            .filter(|url| !url.trim().is_empty())
            .unwrap_or_else(|| default_url.to_owned())
            .trim()
            .to_owned();
        if input.provider == "custom" && base_url.is_empty() {
            bail!("custom provider requires baseUrl");
        }
        let profile = Profile {
            name: input.name.trim().to_owned(),
            provider: input.provider,
            base_url,
            model: input.model.trim().to_owned(),
            effort: input.effort.map(|value| value.trim().to_owned()),
        };
        validate_profile(&profile)?;
        if let KeyUpdate::Set(key) = &input.api_key {
            if key.chars().any(|c| c.is_control() || c.is_whitespace()) {
                bail!("apiKey must not contain whitespace or control characters");
            }
        }
        Ok((profile, input.api_key))
    }
}

fn provider_url(provider: &str) -> Result<&'static str> {
    match provider {
        "deepseek" => Ok("https://api.deepseek.com"),
        "minimax" => Ok("https://api.minimax.io/v1"),
        "openrouter" => Ok("https://openrouter.ai/api/v1"),
        "custom" => Ok(""),
        _ => bail!("provider must be deepseek, minimax, openrouter, or custom"),
    }
}

fn validate_profile(profile: &Profile) -> Result<()> {
    for (field, value) in [("name", &profile.name), ("model", &profile.model)] {
        if value.trim().is_empty() || value.chars().any(char::is_control) {
            bail!("profile {field} must be nonempty and contain no control characters");
        }
    }
    provider_url(&profile.provider)?;
    if let Some(effort) = &profile.effort {
        if effort.is_empty() || effort.chars().any(char::is_control) {
            bail!("effort must be nonempty and contain no control characters");
        }
    }
    validate_url(&profile.base_url)
}

fn validate_url(value: &str) -> Result<()> {
    let invalid = || {
        anyhow!(
            "baseUrl must use HTTPS, or HTTP on loopback, without credentials, query, or fragment"
        )
    };
    if value
        .chars()
        .any(|c| c.is_whitespace() || c.is_control() || c == '\\')
    {
        return Err(invalid());
    }
    let url = reqwest::Url::parse(value).map_err(|_| invalid())?;
    let authority = value
        .split_once("://")
        .map(|(_, tail)| tail.split(['/', '?', '#']).next().unwrap_or_default())
        .ok_or_else(invalid)?;
    if url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || authority.is_empty()
        || authority.contains('@')
    {
        return Err(invalid());
    }
    let host = url.host_str().unwrap_or_default();
    let host = host
        .strip_prefix('[')
        .and_then(|host| host.strip_suffix(']'))
        .unwrap_or(host);
    let loopback = host.eq_ignore_ascii_case("localhost")
        || host.parse::<IpAddr>().is_ok_and(|ip| ip.is_loopback());
    if url.scheme() != "https" && !(url.scheme() == "http" && loopback) {
        return Err(invalid());
    }
    Ok(())
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    profiles: Vec<StoredProfile>,
    /// IDs only, never secrets. Journal a new ID before touching the OS store;
    /// after commit journal the old ID instead. Interrupted cleanup is retried.
    #[serde(
        default,
        rename = "pendingCredentialDeletes",
        skip_serializing_if = "Vec::is_empty"
    )]
    pending_deletes: Vec<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct StoredProfile {
    profile: Profile,
    #[serde(
        default,
        rename = "credentialId",
        skip_serializing_if = "Option::is_none"
    )]
    credential_id: Option<String>,
}

trait CredentialStore {
    fn get(&self, id: &str) -> Result<Option<String>>;
    fn set(&self, id: &str, key: &str) -> Result<()>;
    fn delete(&self, id: &str) -> Result<()>;
}

struct ProfileStore<K> {
    directory: PathBuf,
    credentials: K,
}

impl<K: CredentialStore> ProfileStore<K> {
    fn lock(&self) -> Result<File> {
        private_directory(&self.directory)?;
        reject_link(&self.directory.join("profiles.lock"))?;
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true).truncate(false);
        private_options(&mut options);
        let file = options
            .open(self.directory.join("profiles.lock"))
            .map_err(|_| anyhow!("could not open the profile lock"))?;
        secure_file(&file, true)?;
        FileExt::lock_exclusive(&file)
            .map_err(|_| anyhow!("could not acquire the profile lock"))?;
        // Closing this separate, never-replaced file releases the lock.
        Ok(file)
    }

    fn read_config(&self) -> Result<Config> {
        let bytes = match read_private_file(&self.directory.join("profiles.json"))? {
            Some(bytes) => bytes,
            None => return Ok(Config::default()),
        };
        let config: Config = serde_json::from_slice(&bytes)
            .map_err(|_| anyhow!("profile configuration is invalid"))?;
        let mut names = HashSet::new();
        let mut live_ids = HashSet::new();
        for stored in &config.profiles {
            validate_profile(&stored.profile)
                .map_err(|_| anyhow!("profile configuration is invalid"))?;
            if !names.insert(stored.profile.name.to_lowercase()) {
                bail!("profile configuration contains case-colliding names");
            }
            if let Some(id) = &stored.credential_id {
                validate_credential_id(id)?;
                if !live_ids.insert(id.as_str()) {
                    bail!("profile configuration contains duplicate credential IDs");
                }
            }
        }
        for id in &config.pending_deletes {
            validate_credential_id(id)?;
            if live_ids.contains(id.as_str()) {
                bail!("profile credential cleanup journal is invalid");
            }
        }
        Ok(config)
    }

    fn write_config(&self, config: &Config) -> Result<WriteState> {
        let bytes = serde_json::to_vec_pretty(config)
            .map_err(|_| anyhow!("could not serialize profile configuration"))?;
        atomic_write(&self.directory.join("profiles.json"), &bytes)
    }

    fn cleanup(&self, config: &mut Config) -> Result<()> {
        self.cleanup_with_sync(config, sync_directory)
    }

    fn cleanup_with_sync(
        &self,
        config: &mut Config,
        sync: impl FnOnce(&Path) -> Result<()>,
    ) -> Result<()> {
        if config.pending_deletes.is_empty() {
            return Ok(());
        }
        // Also covers recovery of a previous committed-but-unsynced write. No
        // key can be deleted until the config that retires it is durable.
        sync(&self.directory)?;
        for id in &config.pending_deletes {
            self.credentials.delete(id)?;
        }
        config.pending_deletes.clear();
        self.write_config(config)?.require_durable()
    }

    fn list(&self) -> Result<Vec<Value>> {
        let _lock = self.lock()?;
        let mut config = self.read_config()?;
        self.cleanup(&mut config)?;
        config
            .profiles
            .iter()
            .map(|stored| {
                let has_key = self.key(stored)?.is_some();
                Ok(summary(&stored.profile, has_key))
            })
            .collect()
    }

    fn load(&self, name: &str) -> Result<Profile> {
        let _lock = self.lock()?;
        let config = self.read_config()?;
        config
            .profiles
            .into_iter()
            .find(|stored| stored.profile.name == name)
            .map(|stored| stored.profile)
            .ok_or_else(|| anyhow!("profile was not found"))
    }

    fn key(&self, stored: &StoredProfile) -> Result<Option<String>> {
        match &stored.credential_id {
            Some(id) => self.credentials.get(id),
            None => Ok(None),
        }
    }

    fn api_key(&self, profile: &Profile) -> Result<Option<String>> {
        let _lock = self.lock()?;
        let config = self.read_config()?;
        match config
            .profiles
            .iter()
            .find(|stored| stored.profile.name == profile.name)
        {
            Some(stored) => {
                if stored.profile.provider != profile.provider
                    || stored.profile.base_url != profile.base_url
                {
                    bail!("profile provider or baseUrl no longer matches the saved configuration");
                }
                self.key(stored)
            }
            None => Ok(None),
        }
    }

    fn save(&self, input: Value) -> Result<Value> {
        let (profile, update) = SaveInput::parse(input)?;
        let _lock = self.lock()?;
        let mut config = self.read_config()?;
        self.cleanup(&mut config)?;
        if config.profiles.iter().any(|stored| {
            stored.profile.name != profile.name
                && stored.profile.name.to_lowercase() == profile.name.to_lowercase()
        }) {
            bail!("profile name conflicts with an existing name when ignoring case");
        }
        let index = config
            .profiles
            .iter()
            .position(|stored| stored.profile.name == profile.name);
        let old_id = index.and_then(|index| config.profiles[index].credential_id.clone());
        if matches!(update, KeyUpdate::Retain)
            && old_id.is_some()
            && index.is_some_and(|index| {
                let previous = &config.profiles[index].profile;
                previous.provider != profile.provider || previous.base_url != profile.base_url
            })
        {
            bail!("changing provider or baseUrl requires explicitly replacing or removing apiKey");
        }
        let new_id = match &update {
            KeyUpdate::Retain => old_id.clone(),
            KeyUpdate::Delete => None,
            KeyUpdate::Set(_) => Some(Uuid::new_v4().to_string()),
        };
        let has_key = match &update {
            KeyUpdate::Retain => match &old_id {
                Some(id) => self.credentials.get(id)?.is_some(),
                None => false,
            },
            KeyUpdate::Delete => false,
            KeyUpdate::Set(_) => true,
        };

        // Persist the recovery journal *before* creating a credential. If the
        // final config replacement fails or the process stops, the old profile
        // remains usable and this staged credential can be deleted safely.
        let mut staged = config.clone();
        if let (KeyUpdate::Set(key), Some(id)) = (&update, &new_id) {
            staged.pending_deletes.push(id.clone());
            self.write_config(&staged)?.require_durable()?;
            if self.credentials.set(id, key).is_err() {
                if self.cleanup(&mut staged).is_err() {
                    bail!("could not store API key; credential cleanup is pending; retry the operation");
                }
                bail!("could not store API key in the OS credential store");
            }
        }

        let stored = StoredProfile {
            profile: profile.clone(),
            credential_id: new_id.clone(),
        };
        match index {
            Some(index) => config.profiles[index] = stored,
            None => config.profiles.push(stored),
        }
        if old_id != new_id {
            if let Some(id) = old_id {
                config.pending_deletes.push(id);
            }
        }
        match self.write_config(&config) {
            Ok(state) => {
                // A committed replacement must never be rolled back as though
                // rename failed. Keep both keys until durability is confirmed.
                state.require_durable()?;
            }
            Err(_) => {
                if self.cleanup(&mut staged).is_err() {
                    bail!("could not save profile configuration; credential cleanup is pending; retry the operation");
                }
                bail!("could not save profile configuration");
            }
        }
        self.cleanup(&mut config).map_err(|_| {
            anyhow!("profile was saved, but OS credential cleanup failed; retry the operation")
        })?;
        Ok(summary(&profile, has_key))
    }

    fn remove(&self, name: &str) -> Result<()> {
        let _lock = self.lock()?;
        let mut config = self.read_config()?;
        self.cleanup(&mut config)?;
        // Removing an absent name is idempotent, including retries after a
        // successful config commit followed by interrupted credential cleanup.
        let Some(index) = config
            .profiles
            .iter()
            .position(|stored| stored.profile.name == name)
        else {
            return Ok(());
        };
        if let Some(id) = config.profiles.remove(index).credential_id {
            config.pending_deletes.push(id);
        }
        self.write_config(&config)?.require_durable()?;
        self.cleanup(&mut config).map_err(|_| {
            anyhow!("profile was removed, but OS credential cleanup failed; retry the operation")
        })
    }
}

fn summary(profile: &Profile, has_key: bool) -> Value {
    let mut value = json!({
        "name": profile.name, "provider": profile.provider,
        "baseUrl": profile.base_url, "model": profile.model, "hasApiKey": has_key,
    });
    if let Some(effort) = &profile.effort {
        value["effort"] = json!(effort);
    }
    value
}

fn validate_credential_id(id: &str) -> Result<()> {
    if Uuid::parse_str(id).is_ok_and(|uuid| uuid.to_string() == id) {
        Ok(())
    } else {
        bail!("profile credential identifier is invalid")
    }
}

fn private_directory(path: &Path) -> Result<()> {
    reject_link(path)?;
    let existed = path.exists();
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder
        .create(path)
        .map_err(|_| anyhow!("could not create the profile storage directory"))?;
    reject_link(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        // TREX_HOME may be an existing workspace. Refuse unsafe permissions
        // without changing access to unrelated files in a user-selected folder.
        if fs::metadata(path)
            .map_err(|_| anyhow!("could not inspect profile storage"))?
            .permissions()
            .mode()
            & 0o077
            != 0
        {
            bail!("profile storage directory must be private to the current user");
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        let directory = OpenOptions::new()
            .access_mode(0x0002_0000 | 0x0004_0000) // READ_CONTROL | WRITE_DAC
            .custom_flags(0x0200_0000 | 0x0020_0000) // BACKUP_SEMANTICS | OPEN_REPARSE_POINT
            .open(path)
            .map_err(|_| anyhow!("could not open profile storage permissions"))?;
        reject_link_metadata(
            &directory
                .metadata()
                .map_err(|_| anyhow!("could not inspect profile storage"))?,
        )?;
        private_acl(&directory, true, !existed)?;
    }
    #[cfg(not(windows))]
    let _ = existed;
    Ok(())
}

fn reject_link(path: &Path) -> Result<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => reject_link_metadata(&metadata),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Err(_) => bail!("could not inspect profile storage"),
    }
}

fn reject_link_metadata(metadata: &fs::Metadata) -> Result<()> {
    #[cfg(windows)]
    let linked = {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0 // FILE_ATTRIBUTE_REPARSE_POINT
    };
    #[cfg(not(windows))]
    let linked = metadata.file_type().is_symlink();
    if linked {
        bail!("profile storage must not use symlinks or reparse points");
    }
    Ok(())
}

fn secure_file(file: &File, restrict: bool) -> Result<()> {
    let metadata = file
        .metadata()
        .map_err(|_| anyhow!("could not inspect profile storage"))?;
    reject_link_metadata(&metadata)?;
    if !metadata.is_file() {
        bail!("profile storage must be a regular file");
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        if metadata.nlink() != 1 {
            bail!("profile storage must not use hard links");
        }
        file.set_permissions(fs::Permissions::from_mode(0o600))
            .map_err(|_| anyhow!("could not restrict profile storage permissions"))?;
    }
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::{
            GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
        };
        let mut information = BY_HANDLE_FILE_INFORMATION::default();
        if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut information) } == 0 {
            bail!("could not inspect profile storage links");
        }
        if information.nNumberOfLinks != 1 {
            bail!("profile storage must not use hard links");
        }
        private_acl(file, false, restrict)?;
    }
    #[cfg(not(windows))]
    let _ = restrict;
    Ok(())
}

fn read_private_file(path: &Path) -> Result<Option<Vec<u8>>> {
    reject_link(path)?;
    let mut options = OpenOptions::new();
    options.read(true);
    private_options(&mut options);
    let file = match options.open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(_) => bail!("could not read profile storage"),
    };
    secure_file(&file, false)?;
    ensure!(
        file.metadata()?.len() <= 64 * 1024 * 1024,
        "private document exceeds 64 MiB"
    );
    let mut bytes = Vec::new();
    file.take(64 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| anyhow!("could not read profile storage"))?;
    ensure!(
        bytes.len() <= 64 * 1024 * 1024,
        "private document exceeds 64 MiB"
    );
    Ok(Some(bytes))
}

fn private_options(options: &mut OpenOptions) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // Open the link itself, then reject it before reading or writing. Also
        // request the rights needed to repair an existing permissive DACL.
        options
            .custom_flags(0x0020_0000) // FILE_FLAG_OPEN_REPARSE_POINT
            .access_mode(0x8000_0000 | 0x4000_0000 | 0x0002_0000 | 0x0004_0000);
    }
    #[cfg(not(any(unix, windows)))]
    let _ = options;
}

#[cfg(windows)]
fn private_acl(file: &File, directory: bool, restrict: bool) -> Result<()> {
    use std::os::windows::io::AsRawHandle;
    use std::ptr;
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Authorization::{
        GetSecurityInfo, SetEntriesInAclW, SetSecurityInfo, EXPLICIT_ACCESS_W, GRANT_ACCESS,
        SE_FILE_OBJECT, TRUSTEE_IS_SID, TRUSTEE_IS_USER, TRUSTEE_W,
    };
    use windows_sys::Win32::Security::{
        EqualSid, GetAce, GetTokenInformation, IsWellKnownSid, TokenUser,
        WinBuiltinAdministratorsSid, WinCreatorOwnerSid, WinLocalSystemSid, ACCESS_ALLOWED_ACE,
        ACE_HEADER, DACL_SECURITY_INFORMATION, OWNER_SECURITY_INFORMATION,
        PROTECTED_DACL_SECURITY_INFORMATION, TOKEN_USER,
    };

    struct LocalAllocation(*mut std::ffi::c_void);
    impl Drop for LocalAllocation {
        fn drop(&mut self) {
            unsafe {
                LocalFree(self.0);
            }
        }
    }

    let failure = || anyhow!("could not restrict profile storage to the current user");
    // The current-process token pseudo handle needs no CloseHandle (Windows 8+).
    let token = -4_isize as windows_sys::Win32::Foundation::HANDLE;
    let mut size = 0;
    unsafe {
        GetTokenInformation(token, TokenUser, ptr::null_mut(), 0, &mut size);
    }
    if size < std::mem::size_of::<TOKEN_USER>() as u32 {
        return Err(failure());
    }
    // usize gives TOKEN_USER the required pointer alignment.
    let mut user = vec![0usize; (size as usize).div_ceil(std::mem::size_of::<usize>())];
    if unsafe { GetTokenInformation(token, TokenUser, user.as_mut_ptr().cast(), size, &mut size) }
        == 0
    {
        return Err(failure());
    }
    let sid = unsafe { (*user.as_ptr().cast::<TOKEN_USER>()).User.Sid };
    let handle = file.as_raw_handle();
    let mut owner = ptr::null_mut();
    let mut existing_acl = ptr::null_mut();
    let mut descriptor = LocalAllocation(ptr::null_mut());
    if unsafe {
        GetSecurityInfo(
            handle,
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            &mut owner,
            ptr::null_mut(),
            &mut existing_acl,
            ptr::null_mut(),
            &mut descriptor.0,
        )
    } != 0
        || unsafe { EqualSid(owner, sid) } == 0
    {
        // A different owner could restore write access after we repair the DACL.
        return Err(failure());
    }
    if !restrict {
        // Do not rewrite ACLs on an existing TREX_HOME or silently trust
        // metadata from a shared file after repairing it. Unknown/conditional
        // ACE types are deliberately rejected.
        if existing_acl.is_null() {
            return Err(failure());
        }
        for index in 0..unsafe { (*existing_acl).AceCount } as u32 {
            let mut ace = ptr::null_mut();
            if unsafe { GetAce(existing_acl, index, &mut ace) } == 0 {
                return Err(failure());
            }
            let header = unsafe { &*ace.cast::<ACE_HEADER>() };
            if header.AceType == 1 {
                // ACCESS_DENIED_ACE_TYPE
                continue;
            }
            if header.AceType != 0 {
                // ACCESS_ALLOWED_ACE_TYPE
                return Err(failure());
            }
            let trustee = unsafe {
                ptr::addr_of!((*ace.cast::<ACCESS_ALLOWED_ACE>()).SidStart)
                    .cast_mut()
                    .cast()
            };
            let trusted = unsafe {
                EqualSid(trustee, sid) != 0
                    || IsWellKnownSid(trustee, WinLocalSystemSid) != 0
                    || IsWellKnownSid(trustee, WinBuiltinAdministratorsSid) != 0
                    || (header.AceFlags & 0x8 != 0 // INHERIT_ONLY_ACE
                        && IsWellKnownSid(trustee, WinCreatorOwnerSid) != 0)
            };
            if !trusted {
                bail!("profile storage must be private to the current user");
            }
        }
        return Ok(());
    }
    let entry = EXPLICIT_ACCESS_W {
        grfAccessPermissions: 0x001f_01ff, // FILE_ALL_ACCESS
        grfAccessMode: GRANT_ACCESS,
        grfInheritance: if directory { 0x3 } else { 0 }, // OBJECT_INHERIT | CONTAINER_INHERIT
        Trustee: TRUSTEE_W {
            TrusteeForm: TRUSTEE_IS_SID,
            TrusteeType: TRUSTEE_IS_USER,
            ptstrName: sid.cast(),
            ..Default::default()
        },
    };
    let mut acl = ptr::null_mut();
    let status = unsafe { SetEntriesInAclW(1, &entry, ptr::null(), &mut acl) };
    let _acl = LocalAllocation(acl.cast());
    if status != 0
        || unsafe {
            SetSecurityInfo(
                handle,
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                ptr::null_mut(),
                ptr::null_mut(),
                acl,
                ptr::null(),
            )
        } != 0
    {
        return Err(failure());
    }
    Ok(())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum WriteState {
    Durable,
    CommittedButUnsynced,
}

impl WriteState {
    fn require_durable(self) -> Result<()> {
        match self {
            Self::Durable => Ok(()),
            Self::CommittedButUnsynced => {
                bail!(
                    "profile storage was committed but directory sync failed; retry the operation"
                )
            }
        }
    }
}

fn sync_directory(path: &Path) -> Result<()> {
    #[cfg(unix)]
    File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|_| {
            anyhow!("could not sync profile storage directory; credentials were retained")
        })?;
    // Windows replacements use MOVEFILE_WRITE_THROUGH below.
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<WriteState> {
    atomic_write_with_sync(path, bytes, sync_directory)
}

fn atomic_write_with_sync(
    path: &Path,
    bytes: &[u8],
    sync: impl FnOnce(&Path) -> Result<()>,
) -> Result<WriteState> {
    let parent = path
        .parent()
        .ok_or_else(|| anyhow!("invalid profile storage path"))?;
    let temporary = parent.join(format!(".trex-{}.tmp", Uuid::new_v4()));
    struct Cleanup(PathBuf);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            let _ = fs::remove_file(&self.0);
        }
    }
    let _cleanup = Cleanup(temporary.clone());
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    private_options(&mut options);
    let mut file = options
        .open(&temporary)
        .map_err(|_| anyhow!("could not create a temporary profile storage file"))?;
    secure_file(&file, true)?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|_| anyhow!("could not write profile storage"))?;
    drop(file); // Windows cannot replace an open temporary file.
    replace_file(&temporary, path)
        .map_err(|_| anyhow!("could not atomically replace profile storage"))?;
    // Preserve the distinction between failed replacement and committed but
    // not confirmed durable. Callers must retain credentials in the latter case.
    Ok(if sync(parent).is_ok() {
        WriteState::Durable
    } else {
        WriteState::CommittedButUnsynced
    })
}

#[cfg(not(windows))]
fn replace_file(source: &Path, destination: &Path) -> std::io::Result<()> {
    fs::rename(source, destination)
}

#[cfg(windows)]
fn replace_file(source: &Path, destination: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    // This binding avoids requiring an additional windows-sys feature.
    #[link(name = "kernel32")]
    extern "system" {
        fn MoveFileExW(existing: *const u16, replacement: *const u16, flags: u32) -> i32;
    }
    fn wide(path: &Path) -> std::io::Result<Vec<u16>> {
        // canonicalize on Windows supplies an absolute extended-length parent,
        // including the correct UNC prefix. The destination need not exist.
        let parent = path
            .parent()
            .ok_or_else(|| std::io::Error::new(ErrorKind::InvalidInput, "invalid storage path"))?;
        let name = path
            .file_name()
            .ok_or_else(|| std::io::Error::new(ErrorKind::InvalidInput, "invalid storage path"))?;
        let path = fs::canonicalize(parent)?.join(name);
        let mut value: Vec<_> = path.as_os_str().encode_wide().collect();
        if value.contains(&0) {
            return Err(std::io::Error::new(
                ErrorKind::InvalidInput,
                "invalid storage path",
            ));
        }
        value.push(0);
        Ok(value)
    }
    let source = wide(source)?;
    let destination = wide(destination)?;
    // MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH. No copy fallback and
    // no delete-before-rename window; source is always in the same directory.
    let result = unsafe { MoveFileExW(source.as_ptr(), destination.as_ptr(), 0x1 | 0x8) };
    if result == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(windows)]
mod platform {
    use super::*;
    use std::ptr;
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{
        CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    pub(super) struct Credentials {
        directory: PathBuf,
    }

    impl Credentials {
        pub(super) fn new(directory: &Path) -> Self {
            Self {
                directory: directory.join("credentials"),
            }
        }

        fn path(&self, id: &str) -> Result<PathBuf> {
            validate_credential_id(id)?;
            Ok(self.directory.join(format!("{id}.dpapi")))
        }

        fn existing_directory(&self) -> Result<bool> {
            reject_link(&self.directory)?;
            match fs::symlink_metadata(&self.directory) {
                Ok(_) => {
                    private_directory(&self.directory)?;
                    Ok(true)
                }
                Err(error) if error.kind() == ErrorKind::NotFound => Ok(false),
                Err(_) => bail!("could not inspect DPAPI credential storage"),
            }
        }
    }

    impl CredentialStore for Credentials {
        fn get(&self, id: &str) -> Result<Option<String>> {
            let path = self.path(id)?;
            if !self.existing_directory()? {
                return Ok(None);
            }
            let protected = match read_private_file(&path)? {
                Some(bytes) => bytes,
                None => return Ok(None),
            };
            let plain = dpapi(&protected, false)?;
            // Decode before dropping the allocation; Drop wipes even invalid
            // UTF-8 and releases every DPAPI output buffer with LocalFree.
            let key = std::str::from_utf8(plain.bytes())
                .map_err(|_| anyhow!("DPAPI credential data is invalid"))?
                .to_owned();
            Ok(Some(key))
        }

        fn set(&self, id: &str, key: &str) -> Result<()> {
            let path = self.path(id)?;
            let protected = dpapi(key.as_bytes(), true)?;
            private_directory(&self.directory)?;
            // Only ciphertext reaches atomic_write. There is no plaintext path.
            atomic_write(&path, protected.bytes())?.require_durable()
        }

        fn delete(&self, id: &str) -> Result<()> {
            let path = self.path(id)?;
            if !self.existing_directory()? {
                return Ok(());
            }
            reject_link(&path)?;
            match fs::remove_file(path) {
                Ok(()) => Ok(()),
                Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
                Err(_) => bail!("could not delete the DPAPI credential file"),
            }
        }
    }

    struct LocalBlob(CRYPT_INTEGER_BLOB);

    impl LocalBlob {
        fn bytes(&self) -> &[u8] {
            if self.0.cbData == 0 {
                return &[];
            }
            // DPAPI supplies an allocation of cbData bytes on success.
            unsafe { std::slice::from_raw_parts(self.0.pbData, self.0.cbData as usize) }
        }
    }

    impl Drop for LocalBlob {
        fn drop(&mut self) {
            if !self.0.pbData.is_null() {
                unsafe {
                    for offset in 0..self.0.cbData as usize {
                        ptr::write_volatile(self.0.pbData.add(offset), 0);
                    }
                    LocalFree(self.0.pbData.cast());
                }
            }
        }
    }

    fn dpapi(input: &[u8], protect: bool) -> Result<LocalBlob> {
        let length = u32::try_from(input.len())
            .map_err(|_| anyhow!("credential data exceeds the DPAPI size limit"))?;
        let input = CRYPT_INTEGER_BLOB {
            cbData: length,
            pbData: input.as_ptr().cast_mut(),
        };
        let mut output = LocalBlob(CRYPT_INTEGER_BLOB::default());
        let success = unsafe {
            if protect {
                CryptProtectData(
                    &input,
                    ptr::null(),
                    ptr::null(),
                    ptr::null(),
                    ptr::null(),
                    CRYPTPROTECT_UI_FORBIDDEN,
                    &mut output.0,
                )
            } else {
                CryptUnprotectData(
                    &input,
                    ptr::null_mut(),
                    ptr::null(),
                    ptr::null(),
                    ptr::null(),
                    CRYPTPROTECT_UI_FORBIDDEN,
                    &mut output.0,
                )
            }
        };
        if success == 0 || (output.0.cbData != 0 && output.0.pbData.is_null()) {
            bail!("DPAPI credential protection or decryption failed");
        }
        Ok(output)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::{Arc, Barrier, Mutex};

    #[derive(Clone, Default)]
    struct MockCredentials(Arc<Mutex<MockState>>);

    #[derive(Default)]
    struct MockState {
        keys: HashMap<String, String>,
        fail_reads: bool,
        fail_set_after_write: bool,
        fail_deletes: bool,
    }

    impl CredentialStore for MockCredentials {
        fn get(&self, id: &str) -> Result<Option<String>> {
            let state = self.0.lock().unwrap();
            if state.fail_reads {
                bail!("credential backend unavailable");
            }
            Ok(state.keys.get(id).cloned())
        }

        fn set(&self, id: &str, key: &str) -> Result<()> {
            let mut state = self.0.lock().unwrap();
            state.keys.insert(id.to_owned(), key.to_owned());
            if state.fail_set_after_write {
                bail!("credential write failed");
            }
            Ok(())
        }

        fn delete(&self, id: &str) -> Result<()> {
            let mut state = self.0.lock().unwrap();
            if state.fail_deletes {
                bail!("credential deletion failed");
            }
            state.keys.remove(id);
            Ok(())
        }
    }

    struct NoCredentials;

    impl CredentialStore for NoCredentials {
        fn get(&self, _id: &str) -> Result<Option<String>> {
            panic!("unexpected key store lookup")
        }
        fn set(&self, _id: &str, _key: &str) -> Result<()> {
            panic!("unexpected key store write")
        }
        fn delete(&self, _id: &str) -> Result<()> {
            panic!("unexpected key store deletion")
        }
    }

    /// Interrupt only the final config replacement, after the staged journal
    /// and credential have been written. This leaves the real atomic writer
    /// responsible for failing, instead of substituting a fake persistence API.
    struct InterruptCommit {
        inner: MockCredentials,
        directory: PathBuf,
    }

    impl CredentialStore for InterruptCommit {
        fn get(&self, id: &str) -> Result<Option<String>> {
            self.inner.get(id)
        }

        fn set(&self, id: &str, key: &str) -> Result<()> {
            self.inner.set(id, key)?;
            fs::rename(
                self.directory.join("profiles.json"),
                self.directory.join("staged-config-backup.json"),
            )?;
            fs::create_dir(self.directory.join("profiles.json"))?;
            Ok(())
        }

        fn delete(&self, id: &str) -> Result<()> {
            self.inner.delete(id)
        }
    }

    fn input(name: &str) -> Value {
        json!({ "name": name, "provider": "deepseek", "model": "deepseek-chat" })
    }

    fn store(path: &Path) -> ProfileStore<MockCredentials> {
        #[cfg(unix)]
        if reject_link(path).is_ok() && path.is_dir() {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
        }
        #[cfg(windows)]
        if reject_link(path).is_ok() && path.is_dir() {
            secure_test_directory(path);
        }
        ProfileStore {
            directory: path.to_owned(),
            credentials: MockCredentials::default(),
        }
    }

    #[test]
    fn home_resolution_does_not_require_mutating_environment() {
        let data = std::env::temp_dir().join("trex-profile-data");
        let custom = std::env::temp_dir().join("trex-profile-custom");
        assert_eq!(
            resolve_home(None, Some(data.clone())).unwrap(),
            data.join("trex-agent")
        );
        assert_eq!(
            resolve_home(Some(custom.as_os_str()), None).unwrap(),
            custom
        );
        assert!(resolve_home(Some(OsStr::new("")), Some(data)).is_err());
        assert!(resolve_home(None, None).is_err());
    }

    #[test]
    fn defaults_and_custom_provider_contract() {
        for (provider, expected) in [
            ("deepseek", "https://api.deepseek.com"),
            ("minimax", "https://api.minimax.io/v1"),
            ("openrouter", "https://openrouter.ai/api/v1"),
        ] {
            let mut value = input("example");
            value["provider"] = json!(provider);
            let (profile, _) = SaveInput::parse(value).unwrap();
            assert_eq!(profile.base_url, expected);
        }
        let mut value = input("custom");
        value["provider"] = json!("custom");
        assert!(SaveInput::parse(value.clone()).is_err());
        value["baseUrl"] = json!("http://127.0.0.1:18080/v1");
        value["effort"] = json!("provider-defined-value");
        let (profile, _) = SaveInput::parse(value).unwrap();
        assert_eq!(profile.provider, "custom");
        assert_eq!(profile.effort.as_deref(), Some("provider-defined-value"));
    }

    #[test]
    fn urls_allow_https_and_only_loopback_http() {
        for url in [
            "https://example.com/v1",
            "https://localhost/v1",
            "http://localhost:8000/v1",
            "http://127.0.0.1:8000",
            "http://127.5.1.2/v1",
            "http://[::1]:8000/v1",
        ] {
            assert!(validate_url(url).is_ok(), "{url}");
        }
        for url in [
            "http://example.com/v1",
            "http://localhost.example.com",
            "http://192.168.1.2",
            "http://0.0.0.0",
            "http://[::]",
            "ftp://localhost",
            "file:///tmp/config",
            "https://user:password@example.com",
            "https://@example.com",
            "https://example.com?",
            "https://example.com#",
            "https://example.com?key=secret",
            "https://example.com/#secret",
            "https://example.com/\npath",
            "https:example.com",
            "https:////@example.com",
            "https://example.com\\@localhost",
            "",
            "not-a-url",
        ] {
            assert!(validate_url(url).is_err(), "{url}");
        }
    }

    #[test]
    fn input_is_strict_and_diagnostics_do_not_quote_secrets() {
        const SECRET: &str = "test-secret-not-for-diagnostics";
        for value in [
            json!({ "name": "p", "provider": "deepseek", "model": "m", "apiKey": { "secret": SECRET } }),
            json!({ "name": "p", "provider": "deepseek", "model": "m", "apiKey": null }),
            json!({ "name": "p", "provider": "deepseek", "model": "m", "unexpected": SECRET }),
            json!({ "name": "p", "provider": SECRET, "model": "m" }),
            json!({ "name": "p", "provider": "custom", "model": "m", "baseUrl": format!("https://user:{SECRET}@example.com") }),
            json!({ "name": "p", "provider": "deepseek", "model": "m", "apiKey": format!("{SECRET}\n") }),
            json!({ "name": " ", "provider": "deepseek", "model": "m" }),
            json!({ "name": "p", "provider": "deepseek", "model": " " }),
        ] {
            let error = match SaveInput::parse(value) {
                Ok(_) => panic!("input should fail"),
                Err(error) => error,
            };
            assert!(!format!("{error:#}").contains(SECRET));
        }
    }

    #[test]
    fn no_key_profiles_and_unsaved_synthetic_profiles_never_open_key_store() {
        let temp = tempfile::tempdir().unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(temp.path(), fs::Permissions::from_mode(0o700)).unwrap();
        }
        #[cfg(windows)]
        secure_test_directory(temp.path());
        let store = ProfileStore {
            directory: temp.path().to_owned(),
            credentials: NoCredentials,
        };
        let synthetic = Profile {
            name: "unsaved-mock".to_owned(),
            provider: "custom".to_owned(),
            base_url: "http://127.0.0.1:18080/v1".to_owned(),
            model: "mock".to_owned(),
            effort: None,
        };
        assert!(store.api_key(&synthetic).unwrap().is_none());
        let result = store.save(input("no-key")).unwrap();
        assert_eq!(result["hasApiKey"], false);
        assert!(result.get("effort").is_none());
        assert_eq!(store.list().unwrap().len(), 1);
        assert!(store
            .api_key(&store.load("no-key").unwrap())
            .unwrap()
            .is_none());
        store.remove("no-key").unwrap();
        store.remove("no-key").unwrap();
        assert!(store.list().unwrap().is_empty());
    }

    #[test]
    fn missing_key_retains_empty_key_removes_and_rotation_replaces() {
        let temp = tempfile::tempdir().unwrap();
        let store = store(temp.path());
        let mut value = input("saved");
        value["apiKey"] = json!("first-test-secret");
        assert_eq!(store.save(value).unwrap()["hasApiKey"], true);
        let profile = store.load("saved").unwrap();
        assert_eq!(
            store.api_key(&profile).unwrap().as_deref(),
            Some("first-test-secret")
        );

        let mut update = input("saved");
        update["model"] = json!("updated-model");
        assert_eq!(store.save(update.clone()).unwrap()["hasApiKey"], true);
        assert_eq!(
            store.api_key(&profile).unwrap().as_deref(),
            Some("first-test-secret")
        );
        update["apiKey"] = json!("rotated-test-secret");
        store.save(update.clone()).unwrap();
        assert_eq!(
            store.api_key(&profile).unwrap().as_deref(),
            Some("rotated-test-secret")
        );
        assert_eq!(store.credentials.0.lock().unwrap().keys.len(), 1);
        update["apiKey"] = json!("");
        assert_eq!(store.save(update).unwrap()["hasApiKey"], false);
        assert!(store.api_key(&profile).unwrap().is_none());
        assert!(store.credentials.0.lock().unwrap().keys.is_empty());
    }

    #[test]
    fn config_and_summaries_never_contain_api_key_material() {
        const SECRET: &str = "unique-test-credential-material";
        let temp = tempfile::tempdir().unwrap();
        let store = store(temp.path());
        let mut value = input("saved");
        value["apiKey"] = json!(SECRET);
        let result = store.save(value).unwrap();
        for value in [result, json!(store.list().unwrap())] {
            assert!(!value.to_string().contains(SECRET));
        }
        let bytes = fs::read(temp.path().join("profiles.json")).unwrap();
        let text = String::from_utf8(bytes).unwrap();
        assert!(!text.contains(SECRET));
        assert!(!text.contains("apiKey"));
        let config: Config = serde_json::from_str(&text).unwrap();
        assert!(config.pending_deletes.is_empty());
        assert!(config.profiles[0].credential_id.is_some());
    }

    #[test]
    fn names_cannot_collide_when_case_changes() {
        let temp = tempfile::tempdir().unwrap();
        let store = store(temp.path());
        store.save(input("TREX1")).unwrap();
        assert!(store.save(input("trex1")).is_err());
        assert_eq!(store.list().unwrap().len(), 1);
        store.save(input("TREX1")).unwrap();
        assert_eq!(store.list().unwrap().len(), 1);
    }

    #[test]
    fn credential_binding_checks_provider_and_url_but_allows_model_changes() {
        let temp = tempfile::tempdir().unwrap();
        let store = store(temp.path());
        let mut value = input("saved");
        value["apiKey"] = json!("binding-test-key");
        store.save(value).unwrap();
        let original = store.load("saved").unwrap();
        let mut changed = original.clone();
        changed.provider = "custom".to_owned();
        assert!(store.api_key(&changed).is_err());
        changed = original.clone();
        changed.base_url = "https://different.example/v1".to_owned();
        assert!(store.api_key(&changed).is_err());
        changed = original;
        changed.model = "another-model".to_owned();
        assert!(store.api_key(&changed).unwrap().is_some());
    }

    #[test]
    fn changing_credential_destination_requires_an_explicit_key_update() {
        for change_provider in [false, true] {
            let temp = tempfile::tempdir().unwrap();
            let store = store(temp.path());
            let mut value = input("saved");
            value["apiKey"] = json!("destination-bound-test-key");
            store.save(value).unwrap();
            let before = fs::read(temp.path().join("profiles.json")).unwrap();
            let mut update = input("saved");
            if change_provider {
                update["provider"] = json!("custom");
                update["baseUrl"] = json!("https://api.deepseek.com");
            } else {
                update["baseUrl"] = json!("https://different.example/v1");
            }
            assert!(store.save(update.clone()).is_err());
            assert_eq!(fs::read(temp.path().join("profiles.json")).unwrap(), before);
            assert_eq!(store.credentials.0.lock().unwrap().keys.len(), 1);
            update["apiKey"] = json!("explicit-replacement-test-key");
            store.save(update.clone()).unwrap();
            assert_eq!(
                store
                    .api_key(&store.load("saved").unwrap())
                    .unwrap()
                    .as_deref(),
                Some("explicit-replacement-test-key")
            );
            update["baseUrl"] = json!("https://third.example/v1");
            update["apiKey"] = json!("");
            assert_eq!(store.save(update).unwrap()["hasApiKey"], false);
            assert!(store.credentials.0.lock().unwrap().keys.is_empty());
        }
    }

    #[cfg(unix)]
    #[test]
    fn existing_storage_permissions_are_restricted_and_linked_files_are_rejected() {
        use std::os::unix::fs::PermissionsExt;
        let temp = tempfile::tempdir().unwrap();
        let directory = temp.path().join("storage");
        fs::create_dir(&directory).unwrap();
        let store = store(&directory);
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o777)).unwrap();
        let lock = directory.join("profiles.lock");
        fs::write(&lock, b"").unwrap();
        fs::set_permissions(&lock, fs::Permissions::from_mode(0o666)).unwrap();
        assert!(store.save(input("saved")).is_err());
        assert_eq!(
            fs::metadata(&directory).unwrap().permissions().mode() & 0o777,
            0o777
        );
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700)).unwrap();
        store.save(input("saved")).unwrap();
        assert_eq!(
            fs::metadata(&directory).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(
            fs::metadata(&lock).unwrap().permissions().mode() & 0o777,
            0o600
        );
        let config = directory.join("profiles.json");
        fs::set_permissions(&config, fs::Permissions::from_mode(0o666)).unwrap();
        assert_eq!(store.list().unwrap().len(), 1);
        assert_eq!(
            fs::metadata(&config).unwrap().permissions().mode() & 0o777,
            0o600
        );
        let outside = temp.path().join("outside.json");
        fs::rename(&config, &outside).unwrap();
        std::os::unix::fs::symlink(&outside, &config).unwrap();
        assert!(store.list().is_err());
        fs::remove_file(&config).unwrap();
        fs::hard_link(&outside, &config).unwrap();
        assert!(store.list().is_err());
    }

    #[cfg(any(unix, windows))]
    fn directory_link(target: &Path, link: &Path) {
        #[cfg(unix)]
        std::os::unix::fs::symlink(target, link).unwrap();
        #[cfg(windows)]
        {
            let result = std::process::Command::new("cmd.exe")
                .args(["/D", "/C", "mklink", "/J"])
                .arg(link)
                .arg(target)
                .output()
                .unwrap();
            assert!(result.status.success());
        }
    }

    #[cfg(any(unix, windows))]
    #[test]
    fn linked_profile_storage_is_rejected_before_accessing_the_target() {
        let temp = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let link = temp.path().join("linked-storage");
        directory_link(outside.path(), &link);
        assert!(store(&link).save(input("saved")).is_err());
        assert_eq!(fs::read_dir(outside.path()).unwrap().count(), 0);
    }

    #[cfg(windows)]
    #[test]
    fn windows_credential_junctions_cannot_redirect_reads_writes_or_cleanup() {
        let temp = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let id = Uuid::new_v4().to_string();
        let target = outside.path().join(format!("{id}.dpapi"));
        fs::write(&target, b"outside-file-must-survive").unwrap();
        directory_link(outside.path(), &temp.path().join("credentials"));
        let credentials = platform::Credentials::new(temp.path());
        assert!(credentials.get(&id).is_err());
        assert!(credentials.set(&id, "synthetic-junction-key").is_err());
        assert!(credentials.delete(&id).is_err());
        assert_eq!(fs::read(&target).unwrap(), b"outside-file-must-survive");
        assert_eq!(fs::read_dir(outside.path()).unwrap().count(), 1);
    }

    #[cfg(windows)]
    #[test]
    fn windows_hard_links_are_rejected_without_mutating_an_unrelated_alias() {
        for name in ["profiles.lock", "profiles.json"] {
            let temp = tempfile::tempdir().unwrap();
            let directory = temp.path().join("storage");
            private_directory(&directory).unwrap();
            let outside = temp.path().join("unrelated-file");
            fs::write(&outside, b"unrelated-file-must-survive").unwrap();
            let before = test_acl(&outside, None);
            fs::hard_link(&outside, directory.join(name)).unwrap();
            let store = ProfileStore {
                directory,
                credentials: NoCredentials,
            };
            assert!(store.list().is_err());
            assert_eq!(test_acl(&outside, None), before);
            assert_eq!(fs::read(&outside).unwrap(), b"unrelated-file-must-survive");
        }
    }

    #[cfg(windows)]
    fn secure_test_directory(path: &Path) {
        use std::os::windows::fs::OpenOptionsExt;
        // The harness temp directory grants its sandbox identities write access.
        // Fixtures explicitly provision their own synthetic storage as private.
        let file = OpenOptions::new()
            .access_mode(0x0006_0000)
            .custom_flags(0x0220_0000)
            .open(path)
            .unwrap();
        private_acl(&file, true, true).unwrap();
    }

    #[cfg(windows)]
    fn test_acl(path: &Path, replacement: Option<&str>) -> String {
        use std::os::windows::ffi::OsStrExt;
        use std::ptr;
        use windows_sys::Win32::Foundation::LocalFree;
        use windows_sys::Win32::Security::Authorization::{
            ConvertSecurityDescriptorToStringSecurityDescriptorW,
            ConvertStringSecurityDescriptorToSecurityDescriptorW, GetNamedSecurityInfoW,
            SetNamedSecurityInfoW, SE_FILE_OBJECT,
        };
        use windows_sys::Win32::Security::{
            GetSecurityDescriptorDacl, DACL_SECURITY_INFORMATION,
            PROTECTED_DACL_SECURITY_INFORMATION,
        };
        let path: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        unsafe {
            let mut descriptor = ptr::null_mut();
            if let Some(replacement) = replacement {
                let sddl: Vec<u16> = replacement.encode_utf16().chain(Some(0)).collect();
                assert_ne!(
                    ConvertStringSecurityDescriptorToSecurityDescriptorW(
                        sddl.as_ptr(),
                        1,
                        &mut descriptor,
                        ptr::null_mut()
                    ),
                    0
                );
                let mut present = 0;
                let mut defaulted = 0;
                let mut acl = ptr::null_mut();
                assert_ne!(
                    GetSecurityDescriptorDacl(descriptor, &mut present, &mut acl, &mut defaulted),
                    0
                );
                assert_eq!(
                    SetNamedSecurityInfoW(
                        path.as_ptr(),
                        SE_FILE_OBJECT,
                        DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                        ptr::null_mut(),
                        ptr::null_mut(),
                        acl,
                        ptr::null()
                    ),
                    0
                );
                LocalFree(descriptor);
                descriptor = ptr::null_mut();
            }
            assert_eq!(
                GetNamedSecurityInfoW(
                    path.as_ptr(),
                    SE_FILE_OBJECT,
                    DACL_SECURITY_INFORMATION,
                    ptr::null_mut(),
                    ptr::null_mut(),
                    ptr::null_mut(),
                    ptr::null_mut(),
                    &mut descriptor
                ),
                0
            );
            let mut sddl = ptr::null_mut();
            let mut length = 0;
            assert_ne!(
                ConvertSecurityDescriptorToStringSecurityDescriptorW(
                    descriptor,
                    1,
                    DACL_SECURITY_INFORMATION,
                    &mut sddl,
                    &mut length
                ),
                0
            );
            let text = std::slice::from_raw_parts(sddl, length as usize);
            let result = String::from_utf16_lossy(text)
                .trim_end_matches('\0')
                .to_owned();
            LocalFree(sddl.cast());
            LocalFree(descriptor);
            result
        }
    }

    #[cfg(windows)]
    #[test]
    fn windows_shared_home_rejects_poisoned_metadata_without_rewriting_its_acl() {
        let temp = tempfile::tempdir().unwrap();
        let directory = temp.path().join("profiles");
        let store = ProfileStore {
            credentials: platform::Credentials::new(&directory),
            directory: directory.clone(),
        };
        let mut value = input("saved");
        value["apiKey"] = json!("shared-home-test-key");
        store.save(value).unwrap();
        let mut profile = store.load("saved").unwrap();
        profile.base_url = "https://attacker.example/v1".to_owned();
        let config_path = directory.join("profiles.json");
        let mut config: Config = serde_json::from_slice(&fs::read(&config_path).unwrap()).unwrap();
        config.profiles[0].profile = profile.clone();
        fs::write(&config_path, serde_json::to_vec(&config).unwrap()).unwrap();
        let shared_acl = test_acl(&directory, Some("D:P(A;OICI;FA;;;WD)"));
        let poisoned = fs::read(&config_path).unwrap();
        assert!(store.api_key(&profile).is_err());
        assert!(store.list().is_err());
        assert!(store.save(input("other")).is_err());
        assert_eq!(test_acl(&directory, None), shared_acl);
        assert_eq!(fs::read(&config_path).unwrap(), poisoned);
        // Once the caller restores privacy, the existing encrypted credential
        // remains available; refusal neither migrates nor destroys credentials.
        secure_test_directory(&directory);
        assert_eq!(
            store.api_key(&profile).unwrap().as_deref(),
            Some("shared-home-test-key")
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_new_storage_is_private_and_shared_profile_files_fail_closed() {
        let temp = tempfile::tempdir().unwrap();
        let directory = temp.path().join("new-storage");
        let store = ProfileStore {
            credentials: platform::Credentials::new(&directory),
            directory: directory.clone(),
        };
        let mut value = input("saved");
        value["apiKey"] = json!("private-acl-test-key");
        store.save(value).unwrap();
        let config = store.read_config().unwrap();
        let id = config.profiles[0].credential_id.as_ref().unwrap();
        let files = [
            directory.join("profiles.lock"),
            directory.join("profiles.json"),
            directory.join("credentials").join(format!("{id}.dpapi")),
        ];
        for path in files
            .iter()
            .chain([&directory, &directory.join("credentials")])
        {
            let acl = test_acl(path, None);
            assert!(acl.starts_with("D:P"), "{acl}");
            assert_eq!(acl.matches("(A;").count(), 1, "{acl}");
        }
        for file in &files {
            assert!(test_acl(file, Some("D:P(A;;FA;;;WD)")).contains(";;;WD)"));
        }
        assert!(store.list().is_err());
        // The unsafe metadata ACL is left intact so its provenance is never
        // accepted merely because reading it happened to repair permissions.
        assert!(test_acl(&directory.join("profiles.json"), None).contains(";;;WD)"));
        for path in &files {
            use std::os::windows::fs::OpenOptionsExt;
            let file = OpenOptions::new()
                .access_mode(0x0006_0000)
                .open(path)
                .unwrap();
            private_acl(&file, false, true).unwrap();
        }
        assert_eq!(store.list().unwrap()[0]["hasApiKey"], true);
        for path in files
            .iter()
            .chain([&directory, &directory.join("credentials")])
        {
            let acl = test_acl(path, None);
            assert!(acl.starts_with("D:P"), "{acl}");
            assert!(!acl.contains(";;;WD)"), "{acl}");
            assert_eq!(acl.matches("(A;").count(), 1, "{acl}");
        }
    }

    #[test]
    fn concurrent_updates_do_not_lose_profiles_or_credentials() {
        let temp = tempfile::tempdir().unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(temp.path(), fs::Permissions::from_mode(0o700)).unwrap();
        }
        #[cfg(windows)]
        secure_test_directory(temp.path());
        let credentials = MockCredentials::default();
        let count = 12;
        let barrier = Arc::new(Barrier::new(count));
        let mut threads = Vec::new();
        for index in 0..count {
            let directory = temp.path().to_owned();
            let credentials = credentials.clone();
            let barrier = barrier.clone();
            threads.push(std::thread::spawn(move || {
                let store = ProfileStore {
                    directory,
                    credentials,
                };
                barrier.wait();
                let name = format!("profile-{index}");
                let mut value = input(&name);
                value["apiKey"] = json!(format!("test-key-{index}"));
                store.save(value).unwrap();
                store.save(input(&name)).unwrap(); // read/modify/write with retention
                assert!(store
                    .api_key(&store.load(&name).unwrap())
                    .unwrap()
                    .is_some());
                assert!(!store.list().unwrap().is_empty());
            }));
        }
        for thread in threads {
            thread.join().unwrap();
        }
        let store = ProfileStore {
            directory: temp.path().to_owned(),
            credentials,
        };
        assert_eq!(store.list().unwrap().len(), count);
        assert_eq!(store.credentials.0.lock().unwrap().keys.len(), count);
    }

    #[test]
    fn failed_secret_write_preserves_old_profile_and_cleans_new_secret() {
        let temp = tempfile::tempdir().unwrap();
        let store = store(temp.path());
        let mut value = input("saved");
        value["apiKey"] = json!("old-test-key");
        store.save(value.clone()).unwrap();
        store.credentials.0.lock().unwrap().fail_set_after_write = true;
        value["apiKey"] = json!("failed-new-test-key");
        value["model"] = json!("uncommitted-model");
        assert!(store.save(value).is_err());
        let profile = store.load("saved").unwrap();
        assert_eq!(profile.model, "deepseek-chat");
        assert_eq!(
            store.api_key(&profile).unwrap().as_deref(),
            Some("old-test-key")
        );
        assert_eq!(store.credentials.0.lock().unwrap().keys.len(), 1);
        assert!(store.read_config().unwrap().pending_deletes.is_empty());
    }

    #[test]
    fn failed_config_commit_keeps_previous_profile_and_cleans_staged_credential() {
        let temp = tempfile::tempdir().unwrap();
        let original = store(temp.path());
        let mut value = input("saved");
        value["apiKey"] = json!("previous-test-key");
        original.save(value.clone()).unwrap();
        let interrupted = ProfileStore {
            directory: temp.path().to_owned(),
            credentials: InterruptCommit {
                inner: original.credentials.clone(),
                directory: temp.path().to_owned(),
            },
        };
        value["apiKey"] = json!("uncommitted-test-key");
        value["model"] = json!("uncommitted-model");
        assert!(interrupted.save(value).is_err());
        assert_eq!(original.credentials.0.lock().unwrap().keys.len(), 1);
        fs::remove_dir(temp.path().join("profiles.json")).unwrap();
        fs::rename(
            temp.path().join("staged-config-backup.json"),
            temp.path().join("profiles.json"),
        )
        .unwrap();
        let profile = original.load("saved").unwrap();
        assert_eq!(profile.model, "deepseek-chat");
        assert_eq!(
            original.api_key(&profile).unwrap().as_deref(),
            Some("previous-test-key")
        );
        // Recovery tolerates a credential already removed during compensation.
        assert_eq!(original.list().unwrap().len(), 1);
        assert!(original.read_config().unwrap().pending_deletes.is_empty());
    }

    #[test]
    fn failed_cleanup_remains_journaled_and_retry_deletes_credentials() {
        let temp = tempfile::tempdir().unwrap();
        let store = store(temp.path());
        let mut value = input("saved");
        value["apiKey"] = json!("remove-test-key");
        store.save(value).unwrap();
        store.credentials.0.lock().unwrap().fail_deletes = true;
        assert!(store.remove("saved").is_err());
        assert_eq!(store.read_config().unwrap().pending_deletes.len(), 1);
        assert!(store.load("saved").is_err());
        store.credentials.0.lock().unwrap().fail_deletes = false;
        store.remove("saved").unwrap();
        assert!(store.credentials.0.lock().unwrap().keys.is_empty());
        assert!(store.read_config().unwrap().pending_deletes.is_empty());
    }

    #[test]
    fn interrupted_staging_is_recovered_before_the_next_update() {
        let temp = tempfile::tempdir().unwrap();
        let store = store(temp.path());
        store.save(input("old-profile")).unwrap();
        let id = Uuid::new_v4().to_string();
        let mut config = store.read_config().unwrap();
        config.pending_deletes.push(id.clone());
        store.write_config(&config).unwrap();
        store.credentials.set(&id, "uncommitted-test-key").unwrap();
        store.save(input("new-profile")).unwrap();
        assert!(store.credentials.get(&id).unwrap().is_none());
        assert_eq!(store.list().unwrap().len(), 2);
        assert!(store.read_config().unwrap().pending_deletes.is_empty());
    }

    #[test]
    fn configured_credential_read_failures_are_explicit() {
        let temp = tempfile::tempdir().unwrap();
        let store = store(temp.path());
        let mut value = input("saved");
        value["apiKey"] = json!("unavailable-keyring-test-secret");
        store.save(value).unwrap();
        store.credentials.0.lock().unwrap().fail_reads = true;
        let error = store.api_key(&store.load("saved").unwrap()).unwrap_err();
        assert!(!error
            .to_string()
            .contains("unavailable-keyring-test-secret"));
        assert!(store.list().is_err());
        assert!(store.save(input("saved")).is_err());
    }

    #[test]
    fn invalid_config_and_unsafe_ids_are_never_silently_overwritten() {
        let temp = tempfile::tempdir().unwrap();
        let store = store(temp.path());
        let path = temp.path().join("profiles.json");
        let invalid = b"{not valid json or a credential}";
        fs::write(&path, invalid).unwrap();
        assert!(store.save(input("new")).is_err());
        assert_eq!(fs::read(&path).unwrap(), invalid);
        assert!(validate_credential_id("../../credential").is_err());
        assert!(validate_credential_id(&Uuid::new_v4().to_string()).is_ok());
    }

    #[test]
    fn atomic_replacement_replaces_existing_files_and_cleans_failed_temporaries() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("profiles.json");
        atomic_write(&path, b"old").unwrap();
        atomic_write(&path, b"new").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"new");
        fs::remove_file(&path).unwrap();
        fs::create_dir(&path).unwrap();
        fs::write(path.join("keep"), b"existing destination").unwrap();
        assert!(atomic_write(&path, b"cannot replace a directory").is_err());
        assert_eq!(
            fs::read(path.join("keep")).unwrap(),
            b"existing destination"
        );
        assert_eq!(fs::read_dir(temp.path()).unwrap().count(), 1);
    }

    #[test]
    fn directory_sync_failure_is_distinct_from_a_failed_replacement() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("profiles.json");
        atomic_write(&path, b"previous config").unwrap();
        let state = atomic_write_with_sync(&path, b"committed config", |_| {
            bail!("injected directory sync failure")
        })
        .unwrap();
        assert_eq!(state, WriteState::CommittedButUnsynced);
        assert!(state.require_durable().is_err());
        assert_eq!(fs::read(&path).unwrap(), b"committed config");
    }

    #[test]
    fn cleanup_never_deletes_credentials_before_the_journal_is_durable() {
        let temp = tempfile::tempdir().unwrap();
        let store = store(temp.path());
        let id = Uuid::new_v4().to_string();
        store.credentials.set(&id, "retired-test-key").unwrap();
        let mut config = Config {
            profiles: Vec::new(),
            pending_deletes: vec![id.clone()],
        };
        store.write_config(&config).unwrap();
        assert!(store
            .cleanup_with_sync(&mut config, |_| {
                bail!("injected directory sync failure")
            })
            .is_err());
        assert_eq!(config.pending_deletes, vec![id.clone()]);
        assert!(store.credentials.get(&id).unwrap().is_some());
        assert_eq!(
            store.read_config().unwrap().pending_deletes,
            vec![id.clone()]
        );
        store.cleanup(&mut config).unwrap();
        assert!(store.credentials.get(&id).unwrap().is_none());
        assert!(store.read_config().unwrap().pending_deletes.is_empty());
    }

    #[cfg(any(target_os = "linux", target_os = "macos", target_os = "ios"))]
    #[test]
    fn unix_keyring_namespaces_isolate_copied_configs_without_opening_keyring() {
        let source = tempfile::tempdir().unwrap();
        let destination = tempfile::tempdir().unwrap();
        let original = store(source.path());
        original.save(input("copied")).unwrap();
        fs::copy(
            source.path().join("profiles.json"),
            destination.path().join("profiles.json"),
        )
        .unwrap();
        let first = platform::Credentials::new(source.path());
        let second = platform::Credentials::new(destination.path());
        assert_ne!(first.service().unwrap(), second.service().unwrap());
        let alias = platform::Credentials::new(&source.path().join("."));
        assert_eq!(first.service().unwrap(), alias.service().unwrap());
    }

    #[cfg(windows)]
    #[test]
    fn windows_atomic_replacement_supports_paths_longer_than_max_path() {
        let temp = tempfile::tempdir().unwrap();
        let directory = temp
            .path()
            .join("a".repeat(100))
            .join("b".repeat(100))
            .join("c".repeat(100));
        private_directory(&directory).unwrap();
        let path = directory.join("profiles.json");
        assert!(path.as_os_str().len() > 260);
        atomic_write(&path, b"old")
            .unwrap()
            .require_durable()
            .unwrap();
        atomic_write(&path, b"new")
            .unwrap()
            .require_durable()
            .unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"new");
    }

    #[cfg(windows)]
    #[test]
    fn windows_absent_key_is_none_and_plaintext_is_never_a_dpapi_fallback() {
        let temp = tempfile::tempdir().unwrap();
        let credentials = platform::Credentials::new(temp.path());
        let id = Uuid::new_v4().to_string();
        assert!(credentials.get(&id).unwrap().is_none());
        let directory = temp.path().join("credentials");
        private_directory(&directory).unwrap();
        fs::write(
            directory.join(format!("{id}.dpapi")),
            b"plaintext-must-be-rejected",
        )
        .unwrap();
        let error = credentials.get(&id).unwrap_err();
        assert!(error.to_string().contains("DPAPI"));
        assert!(!error.to_string().contains("plaintext-must-be-rejected"));
    }

    #[cfg(windows)]
    #[test]
    fn windows_dpapi_round_trip_writes_only_ciphertext() {
        let temp = tempfile::tempdir().unwrap();
        let credentials = platform::Credentials::new(temp.path());
        let id = Uuid::new_v4().to_string();
        const SECRET: &str = "dpapi-round-trip-test-secret";
        credentials.set(&id, SECRET).unwrap();
        assert_eq!(credentials.get(&id).unwrap().as_deref(), Some(SECRET));
        let protected =
            fs::read(temp.path().join("credentials").join(format!("{id}.dpapi"))).unwrap();
        assert!(!protected
            .windows(SECRET.len())
            .any(|window| window == SECRET.as_bytes()));
        credentials.delete(&id).unwrap();
        assert!(credentials.get(&id).unwrap().is_none());
    }
}

#[cfg(not(windows))]
mod platform {
    use super::*;

    pub(super) struct Credentials {
        #[cfg(any(target_os = "linux", target_os = "macos", target_os = "ios"))]
        directory: PathBuf,
    }

    impl Credentials {
        pub(super) fn new(directory: &Path) -> Self {
            #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "ios")))]
            let _ = directory;
            Self {
                #[cfg(any(target_os = "linux", target_os = "macos", target_os = "ios"))]
                directory: directory.to_owned(),
            }
        }

        #[cfg(any(target_os = "linux", target_os = "macos", target_os = "ios"))]
        pub(super) fn service(&self) -> Result<String> {
            use base64::Engine;
            use std::os::unix::ffi::OsStrExt;
            let directory = fs::canonicalize(&self.directory)
                .map_err(|_| anyhow!("could not resolve the credential storage directory"))?;
            // Encoding the canonical path is stable across compiler versions,
            // handles non-UTF-8 paths, and isolates even copied config files.
            Ok(format!(
                "trex-agent:{}",
                base64::engine::general_purpose::URL_SAFE_NO_PAD
                    .encode(directory.as_os_str().as_bytes())
            ))
        }

        #[cfg(any(target_os = "linux", target_os = "macos", target_os = "ios"))]
        fn entry(&self, id: &str) -> Result<keyring::Entry> {
            validate_credential_id(id)?;
            keyring::Entry::new(&self.service()?, id).map_err(|_| {
                anyhow!("OS keyring is unavailable; API keys cannot be stored securely")
            })
        }
    }

    impl CredentialStore for Credentials {
        fn get(&self, id: &str) -> Result<Option<String>> {
            #[cfg(any(target_os = "linux", target_os = "macos", target_os = "ios"))]
            {
                match self.entry(id)?.get_password() {
                    Ok(key) => Ok(Some(key)),
                    Err(keyring::Error::NoEntry) => Ok(None),
                    Err(_) => bail!("could not read API key from the OS keyring"),
                }
            }
            #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "ios")))]
            {
                let _ = id;
                bail!("secure OS keyring storage is unsupported on this platform")
            }
        }

        fn set(&self, id: &str, key: &str) -> Result<()> {
            #[cfg(any(target_os = "linux", target_os = "macos", target_os = "ios"))]
            {
                self.entry(id)?
                    .set_password(key)
                    .map_err(|_| anyhow!("could not save API key in the OS keyring"))
            }
            #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "ios")))]
            {
                let _ = (id, key);
                bail!("secure OS keyring storage is unsupported on this platform")
            }
        }

        fn delete(&self, id: &str) -> Result<()> {
            #[cfg(any(target_os = "linux", target_os = "macos", target_os = "ios"))]
            {
                match self.entry(id)?.delete_credential() {
                    Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
                    Err(_) => bail!("could not delete API key from the OS keyring"),
                }
            }
            #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "ios")))]
            {
                let _ = id;
                bail!("secure OS keyring storage is unsupported on this platform")
            }
        }
    }
}
