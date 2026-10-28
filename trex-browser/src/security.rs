//! Windows-only private state boundary. No shell commands, localized ACL text,
//! ambient group grants, or inherited verification markers are trusted.

use anyhow::{bail, Context, Result};
use std::ffi::{c_void, OsStr, OsString};
use std::fs;
use std::io::{self, Read};
use std::mem::{size_of, zeroed};
use std::os::windows::ffi::{OsStrExt, OsStringExt};
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::path::{Component, Path, PathBuf, Prefix};
use std::ptr::{null, null_mut};
use windows_sys::Wdk::Foundation::OBJECT_ATTRIBUTES;
use windows_sys::Wdk::Storage::FileSystem::{
    NtCreateFile, FILE_DIRECTORY_FILE, FILE_NON_DIRECTORY_FILE, FILE_OPEN, FILE_OPEN_REPARSE_POINT,
    FILE_SYNCHRONOUS_IO_NONALERT,
};
use windows_sys::Win32::Foundation::{
    GetLastError, LocalFree, ERROR_ALREADY_EXISTS, ERROR_INSUFFICIENT_BUFFER, ERROR_SUCCESS,
    GENERIC_EXECUTE, GENERIC_READ, GENERIC_WRITE, HANDLE, INVALID_HANDLE_VALUE,
};
use windows_sys::Win32::Foundation::{RtlNtStatusToDosError, OBJ_DONT_REPARSE, UNICODE_STRING};
use windows_sys::Win32::Security::Authorization::{
    ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW, GetSecurityInfo,
    SetSecurityInfo, SDDL_REVISION_1, SE_FILE_OBJECT,
};
use windows_sys::Win32::Security::{
    DeriveCapabilitySidsFromName, EqualSid, GetAce, GetLengthSid, GetSecurityDescriptorControl,
    GetSecurityDescriptorDacl, GetSidIdentifierAuthority, GetSidSubAuthority,
    GetSidSubAuthorityCount, GetTokenInformation, IsValidAcl, IsValidSecurityDescriptor,
    IsValidSid, IsWellKnownSid, TokenUser, WinBuiltinAdministratorsSid, WinLocalSystemSid,
    WinWorldSid, ACCESS_ALLOWED_ACE, ACE_HEADER, ACL, DACL_SECURITY_INFORMATION, INHERIT_ONLY_ACE,
    NO_PROPAGATE_INHERIT_ACE, OWNER_SECURITY_INFORMATION, PROTECTED_DACL_SECURITY_INFORMATION,
    PSECURITY_DESCRIPTOR, PSID, SECURITY_ATTRIBUTES, SE_DACL_PROTECTED,
    SUB_CONTAINERS_AND_OBJECTS_INHERIT, TOKEN_QUERY, TOKEN_USER,
};
use windows_sys::Win32::Storage::FileSystem::{
    CreateDirectoryW, CreateFileW, GetFileInformationByHandle, GetFileType,
    GetVolumeInformationByHandleW, BY_HANDLE_FILE_INFORMATION, DELETE, FILE_ALL_ACCESS,
    FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT, FILE_EXECUTE,
    FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_GENERIC_EXECUTE,
    FILE_GENERIC_READ, FILE_GENERIC_WRITE, FILE_READ_ATTRIBUTES, FILE_SHARE_READ, FILE_SHARE_WRITE,
    FILE_TYPE_DISK, OPEN_EXISTING, READ_CONTROL, WRITE_DAC,
};
use windows_sys::Win32::Storage::FileSystem::{
    GetFinalPathNameByHandleW, FILE_LIST_DIRECTORY, SYNCHRONIZE, VOLUME_NAME_GUID,
};
use windows_sys::Win32::System::SystemInformation::GetWindowsDirectoryW;
use windows_sys::Win32::System::SystemServices::FILE_PERSISTENT_ACLS;
use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
use windows_sys::Win32::System::IO::IO_STATUS_BLOCK;

const MAX_TREE_DEPTH: usize = 128;
const MAX_TREE_ENTRIES: usize = 250_000;
const ACCESS_ALLOWED_ACE_TYPE: u8 = 0;
const ACCESS_DENIED_ACE_TYPE: u8 = 1;
// Chromium's ChromeContentBrowserClient::GetLPACCapabilityNameForNetworkService
// defines these names. Resolve exact SIDs with Windows, never a SID prefix match.
// https://github.com/chromium/chromium/blob/main/chrome/browser/chrome_content_browser_client.cc
const CHROMIUM_NETWORK_CAPABILITIES: &[&str] = &[
    "lpacChromeStableNetworkSandbox",
    "lpacChromeBetaNetworkSandbox",
    "lpacChromeDevNetworkSandbox",
    "lpacChromeCanaryNetworkSandbox",
    "lpacChromeNetworkSandbox",
];
const CHROMIUM_DATA_RIGHTS: u32 = GENERIC_READ
    | GENERIC_WRITE
    | GENERIC_EXECUTE
    | FILE_GENERIC_READ
    | FILE_GENERIC_WRITE
    | FILE_GENERIC_EXECUTE
    | DELETE;

pub struct PrivateHome {
    path: PathBuf,
    // Handles do not permit FILE_SHARE_DELETE, so checked path components
    // cannot be replaced while the native CLI is alive. They are not inherited.
    _path_handles: Vec<OwnedHandle>,
}

impl PrivateHome {
    pub fn prepare() -> Result<Self> {
        let requested = match std::env::var_os("TREX_BROWSER_HOME") {
            Some(value) if value.is_empty() => bail!("TREX_BROWSER_HOME must not be empty"),
            Some(value) => PathBuf::from(value),
            None => PathBuf::from(std::env::var_os("LOCALAPPDATA").filter(|value| !value.is_empty())
                .context("LOCALAPPDATA is unavailable; set TREX_BROWSER_HOME to an isolated directory")?)
                .join("TrexBrowser"),
        };
        Self::at(&requested)
    }

    fn at(requested: &Path) -> Result<Self> {
        let path = checked_absolute_path(requested)?;
        let policy = Policy::current_user()?;
        let mut path_handles = Vec::new();
        let mut current = PathBuf::new();
        let last = path.components().count() - 1;
        for (index, component) in path.components().enumerate() {
            current.push(component.as_os_str());
            if matches!(component, Component::Prefix(_)) {
                continue;
            }
            let is_home = index == last;
            let access =
                FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | if is_home { READ_CONTROL } else { 0 };
            let handle = match open_checked(&current, access) {
                Ok(handle) => handle,
                Err(error)
                    if error
                        .downcast_ref::<io::Error>()
                        .is_some_and(|error| error.kind() == io::ErrorKind::NotFound) =>
                {
                    // Each missing component is created atomically with the
                    // private descriptor; never create broadly then chmod it.
                    policy.create_directory(&current)?;
                    open_checked(&current, access)?
                }
                Err(error) => {
                    return Err(error).context("could not safely open the private-home path")
                }
            };
            let info = file_information(&handle)?;
            if info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY == 0 {
                bail!("a private-home path component is not a directory");
            }
            if is_home {
                require_persistent_acls(&handle)?;
                policy.verify_acl(&handle, true, true, false)?;
                let mut entries = 0;
                policy.verify_tree(&current, &current, 0, &mut entries)?;
            }
            path_handles.push(handle);
        }
        Ok(Self {
            path,
            _path_handles: path_handles,
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

/// Normalize syntax without following links or asking Windows to resolve DOS
/// aliases. Only local drive paths are supported; device/UNC/ADS paths fail shut.
pub(crate) fn checked_absolute_path(requested: &Path) -> Result<PathBuf> {
    if requested.as_os_str().is_empty() {
        bail!("the private-home path must not be empty");
    }
    let absolute = if requested.is_absolute() {
        requested.to_owned()
    } else {
        std::env::current_dir()
            .context("could not resolve the private-home path")?
            .join(requested)
    };
    let mut components = absolute.components();
    let drive = match components.next() {
        Some(Component::Prefix(prefix)) => match prefix.kind() {
            Prefix::Disk(drive) | Prefix::VerbatimDisk(drive) => drive,
            _ => bail!("the private home must use a local drive path"),
        },
        _ => bail!("the private home must use a local drive path"),
    };
    if !matches!(components.next(), Some(Component::RootDir)) {
        bail!("the private-home path must be absolute");
    }
    let mut path = PathBuf::from(format!("{}:\\", char::from(drive.to_ascii_uppercase())));
    let mut names = 0;
    for component in components {
        match component {
            Component::Normal(name) => {
                validate_name(name)?;
                path.push(name);
                names += 1;
            }
            Component::CurDir => {}
            _ => bail!("the private-home path must not contain parent traversal or device syntax"),
        }
    }
    if names == 0 {
        bail!("a drive root cannot be used as the private home");
    }
    Ok(path)
}

fn validate_name(name: &OsStr) -> Result<()> {
    let chars: Vec<_> = name.encode_wide().collect();
    if chars.is_empty()
        || chars.iter().any(|c| *c == 0 || *c == u16::from(b':'))
        || chars
            .last()
            .is_some_and(|c| *c == u16::from(b'.') || *c == u16::from(b' '))
    {
        bail!("the private-home path contains an ambiguous or alternate-stream name");
    }
    let name = name.to_string_lossy();
    let base = name.split('.').next().unwrap_or("").to_ascii_uppercase();
    let reserved = matches!(
        base.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
    ) || ["COM", "LPT"].iter().any(|prefix| {
        base.strip_prefix(prefix).is_some_and(|suffix| {
            matches!(
                suffix,
                "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
            )
        })
    });
    if reserved {
        bail!("the private-home path contains a reserved device name");
    }
    Ok(())
}

fn wide_path(path: &Path) -> Vec<u16> {
    // checked_absolute_path has already rejected non-drive namespace paths.
    OsStr::new("\\\\?\\")
        .encode_wide()
        .chain(path.as_os_str().encode_wide())
        .chain(Some(0))
        .collect()
}

fn open_checked(path: &Path, access: u32) -> Result<OwnedHandle> {
    open_checked_sharing(path, access, FILE_SHARE_READ | FILE_SHARE_WRITE)
}

fn open_checked_sharing(path: &Path, access: u32, sharing: u32) -> Result<OwnedHandle> {
    let path = wide_path(path);
    let raw = unsafe {
        CreateFileW(
            path.as_ptr(),
            access,
            sharing,
            null(),
            OPEN_EXISTING,
            FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS,
            null_mut(),
        )
    };
    if raw == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error().into());
    }
    // SAFETY: the successful CreateFileW call transfers one owned handle.
    let handle = unsafe { OwnedHandle::from_raw_handle(raw) };
    checked_handle(handle)
}

fn checked_handle(handle: OwnedHandle) -> Result<OwnedHandle> {
    let info = file_information(&handle)?;
    if info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        bail!("the private-home path/tree contains a symlink, junction, or reparse point");
    }
    if info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY == 0 && info.nNumberOfLinks != 1 {
        bail!("the private-home tree contains a hard-linked file");
    }
    Ok(handle)
}

fn file_information(handle: &impl AsRawHandle) -> Result<BY_HANDLE_FILE_INFORMATION> {
    let mut info = unsafe { zeroed() };
    if unsafe { GetFileInformationByHandle(handle.as_raw_handle(), &mut info) } == 0 {
        return Err(io::Error::last_os_error())
            .context("could not verify private-home file identity");
    }
    Ok(info)
}

pub const MAX_UPLOAD_BYTES: u64 = 64 * 1024 * 1024;

/// Returns immutable bytes, never a pathname for a later asynchronous reader.
pub fn upload_snapshot(cwd: &Path, candidate: &Path) -> Result<Vec<u8>> {
    HeldUpload::open(cwd, candidate)?.read()
}

struct HeldUpload {
    ancestors: Vec<OwnedHandle>,
    file: fs::File,
    before: BY_HANDLE_FILE_INFORMATION,
}

impl HeldUpload {
    fn open(cwd: &Path, candidate: &Path) -> Result<Self> {
        if !cwd.is_absolute() || !candidate.is_absolute() {
            bail!("upload paths must be absolute");
        }
        // Normalize only safe syntax, not links. Preserve the workspace boundary
        // by comparing whole components rather than a textual path prefix.
        let cwd = checked_absolute_path(cwd)?;
        let candidate = checked_absolute_path(candidate)?;
        let boundary: Vec<_> = cwd.components().collect();
        let parts: Vec<_> = candidate.components().collect();
        if parts.len() <= boundary.len()
            || !boundary
                .iter()
                .zip(&parts)
                .all(|(a, b)| a.as_os_str() == b.as_os_str())
        {
            bail!("upload path is outside the workspace");
        }
        let root_path: PathBuf = parts[..2].iter().map(|part| part.as_os_str()).collect();
        let root = open_checked_sharing(
            &root_path,
            FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ,
        )?;
        require_local_volume(&root)?;
        let mut ancestors = vec![root];
        for (index, component) in parts.iter().enumerate().skip(2) {
            let final_file = index == parts.len() - 1;
            // Resolve one component against its retained parent object. No
            // absolute traversal can follow an ancestor replaced by a junction.
            let handle = open_relative_upload(
                ancestors.last().unwrap(),
                component.as_os_str(),
                !final_file,
            )?;
            let info = file_information(&handle)?;
            if final_file {
                require_upload_file(&handle, &info)?;
                return Ok(Self {
                    ancestors,
                    file: fs::File::from(handle),
                    before: info,
                });
            }
            if info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY == 0 {
                bail!("upload ancestor is not a directory");
            }
            ancestors.push(handle);
        }
        bail!("upload file is missing")
    }

    fn read(mut self) -> Result<Vec<u8>> {
        let expected = upload_size(&self.before);
        let mut bytes = Vec::with_capacity(expected as usize);
        (&mut self.file)
            .take(MAX_UPLOAD_BYTES + 1)
            .read_to_end(&mut bytes)?;
        let after = file_information(&self.file)?;
        require_upload_file(&self.file, &after)?;
        if bytes.len() as u64 != expected
            || upload_size(&after) != expected
            || self.before.dwVolumeSerialNumber != after.dwVolumeSerialNumber
            || self.before.nFileIndexHigh != after.nFileIndexHigh
            || self.before.nFileIndexLow != after.nFileIndexLow
            || self.before.dwFileAttributes != after.dwFileAttributes
            || self.before.ftCreationTime.dwHighDateTime != after.ftCreationTime.dwHighDateTime
            || self.before.ftCreationTime.dwLowDateTime != after.ftCreationTime.dwLowDateTime
            || self.before.ftLastWriteTime.dwHighDateTime != after.ftLastWriteTime.dwHighDateTime
            || self.before.ftLastWriteTime.dwLowDateTime != after.ftLastWriteTime.dwLowDateTime
        {
            bail!("upload file changed while taking a snapshot");
        }
        for directory in &self.ancestors {
            let info = file_information(directory)?;
            if info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
                || info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY == 0
            {
                bail!("upload ancestor changed while taking a snapshot");
            }
        }
        Ok(bytes)
    }
}

fn upload_size(info: &BY_HANDLE_FILE_INFORMATION) -> u64 {
    (u64::from(info.nFileSizeHigh) << 32) | u64::from(info.nFileSizeLow)
}

fn require_local_volume(handle: &OwnedHandle) -> Result<()> {
    let mut buffer = vec![0u16; 32_768];
    let length = unsafe {
        GetFinalPathNameByHandleW(
            handle.as_raw_handle(),
            buffer.as_mut_ptr(),
            buffer.len() as u32,
            VOLUME_NAME_GUID,
        )
    } as usize;
    // SMB/mapped network drives cannot resolve to a local volume GUID. Check
    // the held object, not a drive-letter lookup that could change afterward.
    if length == 0
        || length >= buffer.len()
        || !buffer[..length].starts_with(&"\\\\?\\Volume{".encode_utf16().collect::<Vec<_>>())
    {
        bail!("upload requires a local Windows volume");
    }
    Ok(())
}

fn open_relative_upload(
    parent: &OwnedHandle,
    name: &OsStr,
    directory: bool,
) -> Result<OwnedHandle> {
    validate_name(name)?;
    let mut name: Vec<u16> = name.encode_wide().collect();
    // One component only; RootDirectory is the sole source of parent identity.
    if name
        .iter()
        .any(|c| *c == u16::from(b'\\') || *c == u16::from(b'/'))
    {
        bail!("upload component must not contain a separator");
    }
    let bytes: u16 = name
        .len()
        .checked_mul(2)
        .and_then(|length| length.try_into().ok())
        .context("upload component is too long")?;
    let name = UNICODE_STRING {
        Length: bytes,
        MaximumLength: bytes,
        Buffer: name.as_mut_ptr(),
    };
    let attributes = OBJECT_ATTRIBUTES {
        Length: size_of::<OBJECT_ATTRIBUTES>() as u32,
        RootDirectory: parent.as_raw_handle(),
        ObjectName: &name,
        Attributes: OBJ_DONT_REPARSE,
        SecurityDescriptor: null(),
        SecurityQualityOfService: null(),
    };
    let mut status_block: IO_STATUS_BLOCK = unsafe { zeroed() };
    let mut raw = null_mut();
    let status = unsafe {
        NtCreateFile(
            &mut raw,
            if directory {
                FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | SYNCHRONIZE
            } else {
                FILE_GENERIC_READ
            },
            &attributes,
            &mut status_block,
            null(),
            0,
            FILE_SHARE_READ,
            FILE_OPEN,
            FILE_OPEN_REPARSE_POINT
                | FILE_SYNCHRONOUS_IO_NONALERT
                | if directory {
                    FILE_DIRECTORY_FILE
                } else {
                    FILE_NON_DIRECTORY_FILE
                },
            null(),
            0,
        )
    };
    if status < 0 {
        return Err(
            io::Error::from_raw_os_error(unsafe { RtlNtStatusToDosError(status) } as i32).into(),
        );
    }
    if raw.is_null() || raw == INVALID_HANDLE_VALUE {
        bail!("upload component did not return a valid handle");
    }
    checked_handle(unsafe { OwnedHandle::from_raw_handle(raw) })
}

fn require_upload_file(handle: &impl AsRawHandle, info: &BY_HANDLE_FILE_INFORMATION) -> Result<()> {
    if unsafe { GetFileType(handle.as_raw_handle()) } != FILE_TYPE_DISK
        || info.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT) != 0
        || info.nNumberOfLinks != 1
        || upload_size(info) > MAX_UPLOAD_BYTES
    {
        bail!("upload requires a bounded regular file with one link");
    }
    Ok(())
}

fn require_persistent_acls(handle: &OwnedHandle) -> Result<()> {
    let mut flags = 0;
    if unsafe {
        GetVolumeInformationByHandleW(
            handle.as_raw_handle(),
            null_mut(),
            0,
            null_mut(),
            null_mut(),
            &mut flags,
            null_mut(),
            0,
        )
    } == 0
    {
        return Err(io::Error::last_os_error())
            .context("could not verify private-home filesystem security support");
    }
    if flags & FILE_PERSISTENT_ACLS == 0 {
        bail!("the private home requires a filesystem with persistent Windows ACLs");
    }
    Ok(())
}

struct LocalAllocation(*mut c_void);

impl Drop for LocalAllocation {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe {
                LocalFree(self.0);
            }
        }
    }
}

struct Policy {
    // usize storage preserves TOKEN_USER pointer alignment; its SID points into
    // this allocation and remains valid for Policy's entire lifetime.
    token_user: Vec<usize>,
    descriptor: LocalAllocation,
    chromium_capability_sids: Vec<Vec<usize>>,
}

impl Policy {
    fn current_user() -> Result<Self> {
        let mut token: HANDLE = null_mut();
        if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
            return Err(io::Error::last_os_error())
                .context("could not identify the current Windows user");
        }
        let token = unsafe { OwnedHandle::from_raw_handle(token) };
        let mut length = 0;
        unsafe {
            GetTokenInformation(token.as_raw_handle(), TokenUser, null_mut(), 0, &mut length);
        }
        if unsafe { GetLastError() } != ERROR_INSUFFICIENT_BUFFER
            || length < size_of::<TOKEN_USER>() as u32
        {
            bail!("could not size the current Windows user identity");
        }
        let mut token_user = vec![0usize; (length as usize).div_ceil(size_of::<usize>())];
        if unsafe {
            GetTokenInformation(
                token.as_raw_handle(),
                TokenUser,
                token_user.as_mut_ptr().cast(),
                length,
                &mut length,
            )
        } == 0
        {
            return Err(io::Error::last_os_error())
                .context("could not read the current Windows user identity");
        }
        let sid = unsafe { (*(token_user.as_ptr().cast::<TOKEN_USER>())).User.Sid };
        let mut sid_text = null_mut();
        if unsafe { ConvertSidToStringSidW(sid, &mut sid_text) } == 0 {
            return Err(io::Error::last_os_error())
                .context("could not encode the current Windows user identity");
        }
        let sid_text_allocation = LocalAllocation(sid_text.cast());
        let mut sid_length = 0;
        while unsafe { *sid_text.add(sid_length) } != 0 {
            sid_length += 1;
        }
        let sid_text =
            String::from_utf16(unsafe { std::slice::from_raw_parts(sid_text, sid_length) })
                .context("the current Windows user identity has invalid encoding")?;
        drop(sid_text_allocation);
        // Protected DACL, current-user owner, and inheritable full control for
        // exactly the user and Local System. No Administrators/Everyone grants.
        let sddl = format!("O:{sid_text}G:{sid_text}D:P(A;OICI;FA;;;{sid_text})(A;OICI;FA;;;SY)");
        let sddl: Vec<_> = sddl.encode_utf16().chain(Some(0)).collect();
        let mut descriptor: PSECURITY_DESCRIPTOR = null_mut();
        if unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl.as_ptr(),
                SDDL_REVISION_1,
                &mut descriptor,
                null_mut(),
            )
        } == 0
        {
            return Err(io::Error::last_os_error())
                .context("could not construct the private-home security descriptor");
        }
        Ok(Self {
            token_user,
            descriptor: LocalAllocation(descriptor),
            chromium_capability_sids: chromium_capability_sids()?,
        })
    }

    fn user_sid(&self) -> PSID {
        unsafe { (*(self.token_user.as_ptr().cast::<TOKEN_USER>())).User.Sid }
    }

    fn create_directory(&self, path: &Path) -> Result<()> {
        let path = wide_path(path);
        let attributes = SECURITY_ATTRIBUTES {
            nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: self.descriptor.0,
            bInheritHandle: 0,
        };
        if unsafe { CreateDirectoryW(path.as_ptr(), &attributes) } == 0
            && unsafe { GetLastError() } != ERROR_ALREADY_EXISTS
        {
            return Err(io::Error::last_os_error())
                .context("could not create a private-home directory with its Windows ACL");
        }
        Ok(())
    }

    fn verify_acl(
        &self,
        handle: &OwnedHandle,
        root: bool,
        directory: bool,
        chromium_profile: bool,
    ) -> Result<()> {
        let mut owner: PSID = null_mut();
        let mut acl: *mut ACL = null_mut();
        let mut descriptor: PSECURITY_DESCRIPTOR = null_mut();
        let status = unsafe {
            GetSecurityInfo(
                handle.as_raw_handle(),
                SE_FILE_OBJECT,
                OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
                &mut owner,
                null_mut(),
                &mut acl,
                null_mut(),
                &mut descriptor,
            )
        };
        if status != ERROR_SUCCESS {
            return Err(io::Error::from_raw_os_error(status as i32))
                .context("could not read a private-home Windows ACL");
        }
        let _descriptor = LocalAllocation(descriptor);
        if descriptor.is_null()
            || unsafe { IsValidSecurityDescriptor(descriptor) } == 0
            || owner.is_null()
            || unsafe { EqualSid(owner, self.user_sid()) } == 0
        {
            bail!("the private home and its contents must be owned by the current Windows user");
        }
        let (mut control, mut revision) = (0, 0);
        if unsafe { GetSecurityDescriptorControl(descriptor, &mut control, &mut revision) } == 0 {
            return Err(io::Error::last_os_error())
                .context("could not verify private-home ACL protection");
        }
        if root && control & SE_DACL_PROTECTED == 0 {
            bail!("the existing private home must have a protected Windows DACL granting only the current user and SYSTEM");
        }
        if acl.is_null() || unsafe { IsValidAcl(acl) } == 0 {
            bail!("the private home has a missing or invalid Windows DACL");
        }
        let (mut user_access, mut system_access) = (0u32, 0u32);
        let (mut user_inheritance, mut system_inheritance) = (0u32, 0u32);
        for index in 0..u32::from(unsafe { (*acl).AceCount }) {
            let mut raw_ace = null_mut();
            if unsafe { GetAce(acl, index, &mut raw_ace) } == 0 {
                return Err(io::Error::last_os_error())
                    .context("could not inspect a private-home ACL entry");
            }
            let header = unsafe { &*raw_ace.cast::<ACE_HEADER>() };
            // Read only the common header until type, size and SID bounds have
            // been verified; never form a typed reference to a shorter ACE.
            const SID_OFFSET: usize = std::mem::offset_of!(ACCESS_ALLOWED_ACE, SidStart);
            const SID_HEADER_SIZE: usize = 8;
            if !matches!(
                header.AceType,
                ACCESS_ALLOWED_ACE_TYPE | ACCESS_DENIED_ACE_TYPE
            ) || usize::from(header.AceSize) < SID_OFFSET + SID_HEADER_SIZE
            {
                bail!("the private home contains an unsupported Windows ACL entry");
            }
            let sid = unsafe { raw_ace.cast::<u8>().add(SID_OFFSET) }.cast::<c_void>();
            let sid_bytes = SID_HEADER_SIZE + 4 * usize::from(unsafe { *sid.cast::<u8>().add(1) });
            if SID_OFFSET + sid_bytes > usize::from(header.AceSize) {
                bail!("the private home contains a truncated Windows ACL identity");
            }
            if unsafe { IsValidSid(sid) } == 0 {
                bail!("the private home contains an invalid Windows ACL identity");
            }
            if unsafe { GetLengthSid(sid) } as usize != sid_bytes {
                bail!("the private home contains an inconsistent Windows ACL identity");
            }
            let ace = unsafe { &*raw_ace.cast::<ACCESS_ALLOWED_ACE>() };
            if header.AceType == ACCESS_DENIED_ACE_TYPE {
                // Chromium marks data files non-executable. This deny grants
                // no access and is accepted only for its exact safe shape.
                if chromium_profile
                    && !root
                    && !directory
                    && ace.Mask == FILE_EXECUTE
                    && ace.Header.AceFlags == 0
                    && unsafe { IsWellKnownSid(sid, WinWorldSid) } != 0
                {
                    continue;
                }
                bail!("the private home contains an unsupported Windows deny ACL entry");
            }
            if !root
                && chromium_profile
                && ace.Mask & !CHROMIUM_DATA_RIGHTS == 0
                && self
                    .chromium_capability_sids
                    .iter()
                    .any(|known| unsafe { EqualSid(sid, known.as_ptr().cast_mut().cast()) } != 0)
            {
                // The sandbox gets data access only, never WRITE_DAC/WRITE_OWNER
                // or GENERIC_ALL. User/System grants are still verified below.
                continue;
            }
            let (access, inheritance) = if unsafe { EqualSid(sid, self.user_sid()) } != 0 {
                (&mut user_access, &mut user_inheritance)
            } else if unsafe { IsWellKnownSid(sid, WinLocalSystemSid) } != 0 {
                (&mut system_access, &mut system_inheritance)
            } else {
                bail!("the private-home ACL grants access to an identity other than the current user or SYSTEM");
            };
            let flags = u32::from(ace.Header.AceFlags);
            if flags & INHERIT_ONLY_ACE == 0 {
                *access |= ace.Mask;
            }
            if flags & SUB_CONTAINERS_AND_OBJECTS_INHERIT == SUB_CONTAINERS_AND_OBJECTS_INHERIT
                && flags & NO_PROPAGATE_INHERIT_ACE == 0
            {
                *inheritance |= ace.Mask;
            }
        }
        if user_access & FILE_ALL_ACCESS != FILE_ALL_ACCESS
            || system_access & FILE_ALL_ACCESS != FILE_ALL_ACCESS
            || (directory
                && (user_inheritance & FILE_ALL_ACCESS != FILE_ALL_ACCESS
                    || system_inheritance & FILE_ALL_ACCESS != FILE_ALL_ACCESS))
        {
            bail!("the private-home ACL must grant full control to the current user and SYSTEM, with directory inheritance");
        }
        Ok(())
    }

    fn verify_tree(
        &self,
        home: &Path,
        path: &Path,
        depth: usize,
        entries: &mut usize,
    ) -> Result<()> {
        if depth > MAX_TREE_DEPTH {
            bail!("the private-home tree exceeds the supported directory depth");
        }
        for entry in fs::read_dir(path).context("could not enumerate the private-home tree")? {
            let entry = entry.context("could not inspect a private-home directory entry")?;
            *entries += 1;
            if *entries > MAX_TREE_ENTRIES {
                bail!("the private-home tree exceeds the supported entry limit");
            }
            // Validate even names returned by the filesystem to exclude ADS and
            // DOS aliases if state was populated by another program.
            validate_name(&entry.file_name())?;
            let child = path.join(entry.file_name());
            let browser_data = chromium_managed_data_child(home, &child);
            let Some(handle) = open_tree_entry(home, &child)? else {
                continue;
            };
            let directory =
                file_information(&handle)?.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0;
            let checked_acl = self.verify_acl(
                &handle,
                false,
                directory,
                chromium_profile_path(home, &child),
            );
            if let Err(error) = checked_acl {
                if browser_data {
                    self.restrict_imported_profile_acl(&handle).context(error)?;
                    self.verify_acl(&handle, false, directory, true)?;
                } else {
                    return Err(error);
                }
            }
            if directory {
                // Keep this handle open during recursion, preventing replacement
                // of the checked directory by a junction between path accesses.
                self.verify_tree(home, &child, depth + 1, entries)?;
            }
        }
        Ok(())
    }

    // Chrome imports component packages/directories with legacy account ACLs.
    // Remove those grants from current-user-owned browser data, never allow
    // them. The profile root, broker metadata and artifacts remain fail-closed.
    // Links are refused and identity held before any permission change.
    fn restrict_imported_profile_acl(&self, handle: &OwnedHandle) -> Result<()> {
        let mut owner: PSID = null_mut();
        let mut old_acl: *mut ACL = null_mut();
        let mut descriptor: PSECURITY_DESCRIPTOR = null_mut();
        let status = unsafe {
            GetSecurityInfo(
                handle.as_raw_handle(),
                SE_FILE_OBJECT,
                OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
                &mut owner,
                null_mut(),
                &mut old_acl,
                null_mut(),
                &mut descriptor,
            )
        };
        let _descriptor = LocalAllocation(descriptor);
        if status != ERROR_SUCCESS
            || owner.is_null()
            || unsafe { IsValidSid(owner) } == 0
            || unsafe { EqualSid(owner, self.user_sid()) } == 0
        {
            bail!("imported browser data must be owned by the current user");
        }
        if old_acl.is_null() || unsafe { IsValidAcl(old_acl) } == 0 {
            bail!("invalid imported browser ACL");
        }
        let mut imported_account = false;
        for index in 0..u32::from(unsafe { (*old_acl).AceCount }) {
            let mut raw: *mut c_void = null_mut();
            if unsafe { GetAce(old_acl, index, &mut raw) } == 0 {
                bail!("could not inspect imported browser ACL");
            }
            let header = unsafe { &*raw.cast::<ACE_HEADER>() };
            const OFFSET: usize = std::mem::offset_of!(ACCESS_ALLOWED_ACE, SidStart);
            if header.AceType != ACCESS_ALLOWED_ACE_TYPE || usize::from(header.AceSize) < OFFSET + 8
            {
                bail!("unsupported imported browser ACL");
            }
            let sid = unsafe { raw.cast::<u8>().add(OFFSET) }.cast::<c_void>();
            let size = 8 + 4 * usize::from(unsafe { *sid.cast::<u8>().add(1) });
            if OFFSET + size > usize::from(header.AceSize) || unsafe { IsValidSid(sid) } == 0 {
                bail!("invalid imported browser ACL identity");
            }
            if unsafe { EqualSid(sid, self.user_sid()) } != 0
                || unsafe { IsWellKnownSid(sid, WinLocalSystemSid) } != 0
            {
                continue;
            }
            let account = unsafe { *GetSidSubAuthorityCount(sid) } == 5
                && unsafe { (*GetSidIdentifierAuthority(sid)).Value } == [0, 0, 0, 0, 0, 5]
                && unsafe { *GetSidSubAuthority(sid, 0) } == 21;
            if account || unsafe { IsWellKnownSid(sid, WinBuiltinAdministratorsSid) } != 0 {
                imported_account = true;
            } else {
                bail!("unsupported imported browser ACL identity");
            }
        }
        if !imported_account {
            bail!("browser ACL is not a legacy imported account ACL");
        }
        let (mut present, mut defaulted, mut acl) = (0, 0, null_mut());
        if unsafe {
            GetSecurityDescriptorDacl(self.descriptor.0, &mut present, &mut acl, &mut defaulted)
        } == 0
            || present == 0
            || acl.is_null()
        {
            bail!("could not read the private component cache policy");
        }
        let status = unsafe {
            SetSecurityInfo(
                handle.as_raw_handle(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                null_mut(),
                null_mut(),
                acl,
                null(),
            )
        };
        if status != ERROR_SUCCESS {
            return Err(io::Error::from_raw_os_error(status as i32))
                .context("could not restrict imported component cache permissions");
        }
        Ok(())
    }
}

fn open_tree_entry(home: &Path, child: &Path) -> Result<Option<OwnedHandle>> {
    open_tree_entry_with(
        home,
        child,
        |access| open_checked(child, access),
        |attempt| std::thread::sleep(std::time::Duration::from_millis(5 << attempt)),
    )
}

fn open_tree_entry_with(
    home: &Path,
    child: &Path,
    mut open: impl FnMut(u32) -> Result<OwnedHandle>,
    mut retry: impl FnMut(u32),
) -> Result<Option<OwnedHandle>> {
    let managed = chromium_managed_data_child(home, child);
    for attempt in 0..=4 {
        match open(FILE_READ_ATTRIBUTES | READ_CONTROL | if managed { WRITE_DAC } else { 0 }) {
            Ok(handle) => return Ok(Some(handle)),
            Err(error)
                if managed
                    && error
                        .downcast_ref::<io::Error>()
                        .is_some_and(|error| error.kind() == io::ErrorKind::NotFound) =>
            {
                return Ok(None)
            }
            // Concurrent browser state updates may transiently deny an audit
            // open. Retry the open, not the browser action. Every successful
            // retry still checks the held object's links and ACLs; inaccessible
            // objects are never skipped. Missing non-data entries still fail.
            Err(error)
                if attempt < 4
                    && error.downcast_ref::<io::Error>().is_some_and(|error| {
                        matches!(error.raw_os_error(), Some(5 | 32 | 303))
                    }) =>
            {
                retry(attempt)
            }
            Err(error) => return Err(error),
        }
    }
    unreachable!("the final native audit attempt always returns")
}

fn chromium_managed_data_child(home: &Path, path: &Path) -> bool {
    if !chromium_profile_path(home, path) {
        return false;
    }
    let Ok(relative) = path.strip_prefix(home) else {
        return false;
    };
    let parts: Vec<_> = relative.iter().collect();
    parts.len() > 4
}

fn chromium_profile_path(home: &Path, path: &Path) -> bool {
    let Ok(relative) = path.strip_prefix(home) else {
        return false;
    };
    let parts: Vec<_> = relative.components().map(|part| part.as_os_str()).collect();
    if parts.len() < 4
        || !parts[0].eq_ignore_ascii_case(OsStr::new("projects"))
        || !parts[3].eq_ignore_ascii_case(OsStr::new("user-data"))
    {
        return false;
    }
    let Some(project) = parts[1].to_str() else {
        return false;
    };
    if project.len() != 24 || !project.bytes().all(|c| c.is_ascii_hexdigit()) {
        return false;
    }
    let Some(profile) = parts[2].to_str() else {
        return false;
    };
    let profile = profile.to_ascii_uppercase();
    let Some(number) = profile.strip_prefix("BROWSER") else {
        return false;
    };
    (1..=2).contains(&number.len())
        && !number.starts_with('0')
        && number.bytes().all(|c| c.is_ascii_digit())
}

struct SidArray {
    pointer: *mut PSID,
    count: u32,
}

impl Drop for SidArray {
    fn drop(&mut self) {
        if !self.pointer.is_null() {
            for index in 0..self.count as usize {
                unsafe {
                    LocalFree(*self.pointer.add(index));
                }
            }
            unsafe {
                LocalFree(self.pointer.cast());
            }
        }
    }
}

fn chromium_capability_sids() -> Result<Vec<Vec<usize>>> {
    let mut result = Vec::new();
    for name in CHROMIUM_NETWORK_CAPABILITIES {
        let name: Vec<_> = name.encode_utf16().chain(Some(0)).collect();
        let (mut groups, mut capabilities) = (null_mut(), null_mut());
        let (mut group_count, mut capability_count) = (0, 0);
        if unsafe {
            DeriveCapabilitySidsFromName(
                name.as_ptr(),
                &mut groups,
                &mut group_count,
                &mut capabilities,
                &mut capability_count,
            )
        } == 0
        {
            return Err(io::Error::last_os_error())
                .context("could not derive trusted Chromium sandbox capability identities");
        }
        let _groups = SidArray {
            pointer: groups,
            count: group_count,
        };
        let capabilities = SidArray {
            pointer: capabilities,
            count: capability_count,
        };
        if capabilities.pointer.is_null() || capabilities.count != 1 {
            bail!("Windows returned an unexpected Chromium sandbox capability identity");
        }
        let sid = unsafe { *capabilities.pointer };
        if sid.is_null() || unsafe { IsValidSid(sid) } == 0 {
            bail!("Windows returned an invalid Chromium sandbox capability identity");
        }
        let length = unsafe { GetLengthSid(sid) } as usize;
        let mut owned = vec![0usize; length.div_ceil(size_of::<usize>())];
        unsafe {
            std::ptr::copy_nonoverlapping(
                sid.cast::<u8>(),
                owned.as_mut_ptr().cast::<u8>(),
                length,
            );
        }
        result.push(owned);
    }
    Ok(result)
}

pub fn windows_directory() -> Result<PathBuf> {
    let mut buffer = vec![0u16; 32_768];
    let length = unsafe { GetWindowsDirectoryW(buffer.as_mut_ptr(), buffer.len() as u32) } as usize;
    if length == 0 || length >= buffer.len() {
        bail!("could not locate the trusted Windows system directory");
    }
    Ok(PathBuf::from(OsString::from_wide(&buffer[..length])))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use windows_sys::Win32::Security::Authorization::{
        ConvertStringSidToSidW, SetEntriesInAclW, SetSecurityInfo, ACCESS_MODE, DENY_ACCESS,
        EXPLICIT_ACCESS_W, GRANT_ACCESS, NO_MULTIPLE_TRUSTEE, TRUSTEE_IS_SID, TRUSTEE_IS_UNKNOWN,
        TRUSTEE_W,
    };
    use windows_sys::Win32::Security::PROTECTED_DACL_SECURITY_INFORMATION;
    use windows_sys::Win32::Storage::FileSystem::WRITE_DAC;

    static SEQUENCE: AtomicUsize = AtomicUsize::new(0);

    struct TestHome(PathBuf);

    impl TestHome {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "trex-browser-native-{}-{}",
                std::process::id(),
                SEQUENCE.fetch_add(1, Ordering::SeqCst)
            ));
            assert!(!path.exists());
            Self(path)
        }
    }

    impl Drop for TestHome {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn private_home_created_atomically_and_reverified() {
        let test = TestHome::new();
        let first = PrivateHome::at(&test.0).unwrap();
        fs::create_dir(first.path().join("profiles")).unwrap();
        fs::write(first.path().join("profiles/state.json"), b"{}").unwrap();
        drop(first);
        let second = PrivateHome::at(&test.0).unwrap();
        assert_eq!(second.path(), test.0);
    }

    #[test]
    fn a_delete_pending_chromium_file_has_no_auditable_object_until_its_last_handle_closes() {
        let test = TestHome::new();
        let home = PrivateHome::at(&test.0).unwrap();
        let file = home.path().join(
            "projects/0123456789abcdef01234567/BROWSER1/user-data/Default/Cache/rotating-entry",
        );
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(&file, b"cache").unwrap();
        let file = checked_absolute_path(&file).unwrap();
        let held = open_checked_sharing(
            &file,
            FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ
                | FILE_SHARE_WRITE
                | windows_sys::Win32::Storage::FileSystem::FILE_SHARE_DELETE,
        )
        .unwrap();
        // DeleteFileW retains the directory entry until the final open handle
        // closes, unlike Rust's newer POSIX-style remove_file implementation.
        assert_ne!(
            unsafe {
                windows_sys::Win32::Storage::FileSystem::DeleteFileW(wide_path(&file).as_ptr())
            },
            0
        );
        let error =
            open_checked(&file, FILE_READ_ATTRIBUTES | READ_CONTROL | WRITE_DAC).unwrap_err();
        let error = error.downcast_ref::<io::Error>().unwrap();
        assert!(matches!(error.raw_os_error(), Some(2 | 5 | 303)), "{error}");
        if error.kind() == io::ErrorKind::NotFound {
            assert!(open_tree_entry(home.path(), &file).unwrap().is_none());
        } else {
            assert!(open_tree_entry_with(
                home.path(),
                &file,
                |access| open_checked(&file, access),
                |_| {}
            )
            .is_err());
        }
        drop(held);
        assert!(open_tree_entry(home.path(), &file).unwrap().is_none());
    }

    #[test]
    fn transient_audit_denial_reopens_and_checks_the_real_object() {
        let test = TestHome::new();
        let home = PrivateHome::at(&test.0).unwrap();
        let file = home.path().join("state.json");
        fs::write(&file, b"private").unwrap();
        let mut attempts = 0;
        let mut retries = vec![];
        let result = open_tree_entry_with(
            home.path(),
            &file,
            |access| {
                attempts += 1;
                if attempts == 1 {
                    Err(io::Error::from_raw_os_error(5).into())
                } else {
                    open_checked(&file, access)
                }
            },
            |attempt| retries.push(attempt),
        )
        .unwrap();
        assert!(result.is_some());
        assert_eq!(attempts, 2);
        assert_eq!(retries, vec![0]);
        drop(result);
        fs::hard_link(&file, home.path().join("alias")).unwrap();
        attempts = 0;
        let error = open_tree_entry_with(
            home.path(),
            &file,
            |access| {
                attempts += 1;
                if attempts == 1 {
                    Err(io::Error::from_raw_os_error(5).into())
                } else {
                    open_checked(&file, access)
                }
            },
            |_| {},
        )
        .unwrap_err();
        assert!(error.to_string().contains("hard-linked"));
        assert_eq!(attempts, 2);
    }
    #[test]
    fn persistent_audit_denial_is_bounded_and_missing_broker_entries_still_fail() {
        let test = TestHome::new();
        let home = PrivateHome::at(&test.0).unwrap();
        for relative in [
            "broker.token",
            "artifacts/missing",
            "projects/0123456789abcdef01234567/BROWSER1/user-data/Default/Cache/item",
        ] {
            let mut attempts = 0;
            let mut retries = 0;
            assert!(open_tree_entry_with(
                home.path(),
                &home.path().join(relative),
                |_| {
                    attempts += 1;
                    Err(io::Error::from_raw_os_error(5).into())
                },
                |_| retries += 1
            )
            .is_err());
            assert_eq!((attempts, retries), (5, 4));
        }
        let mut attempts = 0;
        assert!(open_tree_entry_with(
            home.path(),
            &home.path().join("broker.token"),
            |_| {
                attempts += 1;
                Err(io::Error::from_raw_os_error(if attempts == 1 { 5 } else { 2 }).into())
            },
            |_| {}
        )
        .is_err());
        assert_eq!(attempts, 2);
    }

    #[test]
    fn a_rotated_chromium_child_can_disappear_between_enumeration_and_open() {
        let test = TestHome::new();
        let home = PrivateHome::at(&test.0).unwrap();
        let directory = home
            .path()
            .join("projects/0123456789abcdef01234567/BROWSER1/user-data/Default/Cache");
        fs::create_dir_all(&directory).unwrap();
        fs::write(directory.join("rotating-entry"), b"cache").unwrap();
        let entry = checked_absolute_path(
            &fs::read_dir(&directory)
                .unwrap()
                .next()
                .unwrap()
                .unwrap()
                .path(),
        )
        .unwrap();
        fs::remove_file(&entry).unwrap();
        assert!(open_tree_entry(home.path(), &entry).unwrap().is_none());
        for relative in [
            "broker.token",
            "artifacts/missing",
            "projects/0123456789abcdef01234567/BROWSER1/profile.json",
            "projects/0123456789abcdef01234567/BROWSER2/user-data",
            "projects/short/BROWSER1/user-data/missing",
        ] {
            assert!(
                open_tree_entry(
                    home.path(),
                    &checked_absolute_path(&home.path().join(relative)).unwrap()
                )
                .is_err(),
                "{relative}"
            );
        }
    }

    #[test]
    fn hardlinked_descendant_fails_closed() {
        let test = TestHome::new();
        let home = PrivateHome::at(&test.0).unwrap();
        fs::write(home.path().join("state"), b"private").unwrap();
        fs::hard_link(home.path().join("state"), home.path().join("alias")).unwrap();
        drop(home);
        let error = PrivateHome::at(&test.0).err().unwrap().to_string();
        assert!(error.contains("hard-linked"), "{error}");
    }

    #[test]
    fn existing_inherited_acl_is_not_trusted_or_rewritten() {
        let test = TestHome::new();
        fs::create_dir(&test.0).unwrap();
        assert!(PrivateHome::at(&test.0).is_err());
    }

    #[test]
    fn unsafe_path_syntax_is_rejected() {
        for path in [
            "C:/",
            "C:/temp/../private",
            "C:/private:stream",
            "C:/private.",
            "C:/private ",
            "C:/NUL",
            "//server/share/private",
            "//./pipe/private",
        ] {
            assert!(checked_absolute_path(Path::new(path)).is_err(), "{path}");
        }
        assert_eq!(
            checked_absolute_path(Path::new("C:/private/state")).unwrap(),
            PathBuf::from("C:/private/state")
        );
    }

    fn sid(text: &str) -> LocalAllocation {
        let text: Vec<_> = text.encode_utf16().chain(Some(0)).collect();
        let mut pointer = null_mut();
        assert_ne!(
            unsafe { ConvertStringSidToSidW(text.as_ptr(), &mut pointer) },
            0
        );
        LocalAllocation(pointer)
    }

    fn extra_ace(path: &Path, sid: PSID, mask: u32, inheritance: u32, mode: ACCESS_MODE) {
        let path = checked_absolute_path(path).unwrap();
        let handle = open_checked(&path, READ_CONTROL | WRITE_DAC | FILE_READ_ATTRIBUTES).unwrap();
        let (mut acl, mut descriptor) = (null_mut(), null_mut());
        assert_eq!(
            unsafe {
                GetSecurityInfo(
                    handle.as_raw_handle(),
                    SE_FILE_OBJECT,
                    DACL_SECURITY_INFORMATION,
                    null_mut(),
                    null_mut(),
                    &mut acl,
                    null_mut(),
                    &mut descriptor,
                )
            },
            ERROR_SUCCESS
        );
        let _descriptor = LocalAllocation(descriptor);
        let access = EXPLICIT_ACCESS_W {
            grfAccessPermissions: mask,
            grfAccessMode: mode,
            grfInheritance: inheritance,
            Trustee: TRUSTEE_W {
                pMultipleTrustee: null_mut(),
                MultipleTrusteeOperation: NO_MULTIPLE_TRUSTEE,
                TrusteeForm: TRUSTEE_IS_SID,
                TrusteeType: TRUSTEE_IS_UNKNOWN,
                ptstrName: sid.cast(),
            },
        };
        let mut updated = null_mut();
        assert_eq!(
            unsafe { SetEntriesInAclW(1, &access, acl, &mut updated) },
            ERROR_SUCCESS
        );
        let _updated = LocalAllocation(updated.cast());
        assert_eq!(
            unsafe {
                SetSecurityInfo(
                    handle.as_raw_handle(),
                    SE_FILE_OBJECT,
                    DACL_SECURITY_INFORMATION,
                    null_mut(),
                    null_mut(),
                    updated,
                    null(),
                )
            },
            ERROR_SUCCESS
        );
    }

    const PROFILE_DATA: &str =
        "projects/0123456789abcdef01234567/BROWSER1/user-data/Default/Network";

    #[test]
    fn imported_browser_account_acls_are_made_private_without_relaxing_other_paths() {
        let imported = sid("S-1-5-21-111-222-333-444");
        let cache = format!(
            "projects/0123456789abcdef01234567/BROWSER1/user-data/component_crx_cache/{}",
            "a".repeat(64)
        );
        for (relative, bytes, accepted) in [
            (cache.clone(), b"Cr24synthetic package".as_slice(), true),
            (cache.clone(), b"synthetic component data".as_slice(), true),
            (
                format!("artifacts/{}", "a".repeat(64)),
                b"Cr24synthetic package".as_slice(),
                false,
            ),
            (
                cache.replace("component_crx_cache", "other-cache"),
                b"Cr24synthetic package".as_slice(),
                true,
            ),
            (
                cache[..cache.len() - 1].to_owned(),
                b"Cr24synthetic package".as_slice(),
                true,
            ),
        ] {
            let test = TestHome::new();
            let home = PrivateHome::at(&test.0).unwrap();
            let target = home.path().join(&relative);
            fs::create_dir_all(target.parent().unwrap()).unwrap();
            fs::write(&target, bytes).unwrap();
            extra_ace(&target, imported.0, FILE_GENERIC_READ, 0, GRANT_ACCESS);
            drop(home);
            assert_eq!(PrivateHome::at(&test.0).is_ok(), accepted, "{relative}");
            let handle = open_checked(
                &checked_absolute_path(&target).unwrap(),
                READ_CONTROL | FILE_READ_ATTRIBUTES,
            )
            .unwrap();
            assert_eq!(
                Policy::current_user()
                    .unwrap()
                    .verify_acl(&handle, false, false, false)
                    .is_ok(),
                accepted
            );
            assert_eq!(fs::read(&target).unwrap(), bytes);
        }
    }

    #[test]
    fn imported_account_acl_normalization_cannot_reach_profile_roots_or_broker_files() {
        let imported = sid("S-1-5-21-111-222-333-444");
        for relative in [
            "projects/0123456789abcdef01234567/BROWSER1/user-data",
            "artifacts",
            "",
        ] {
            let test = TestHome::new();
            let home = PrivateHome::at(&test.0).unwrap();
            let target = home.path().join(relative);
            fs::create_dir_all(&target).unwrap();
            extra_ace(&target, imported.0, FILE_GENERIC_READ, 0, GRANT_ACCESS);
            drop(home);
            assert!(PrivateHome::at(&test.0).is_err(), "{relative}");
        }
        let test = TestHome::new();
        let home = PrivateHome::at(&test.0).unwrap();
        let target = home.path().join("broker.token");
        fs::write(&target, b"synthetic only").unwrap();
        extra_ace(&target, imported.0, FILE_GENERIC_READ, 0, GRANT_ACCESS);
        drop(home);
        assert!(PrivateHome::at(&test.0).is_err());
    }

    #[test]
    fn linked_component_cache_is_rejected_before_any_permission_change() {
        let test = TestHome::new();
        let home = PrivateHome::at(&test.0).unwrap();
        let target = home.path().join(format!(
            "projects/0123456789abcdef01234567/BROWSER1/user-data/component_crx_cache/{}",
            "b".repeat(64)
        ));
        fs::create_dir_all(target.parent().unwrap()).unwrap();
        fs::write(&target, b"Cr24synthetic package").unwrap();
        extra_ace(
            &target,
            sid("S-1-1-0").0,
            FILE_GENERIC_READ,
            0,
            GRANT_ACCESS,
        );
        fs::hard_link(&target, home.path().join("alias")).unwrap();
        drop(home);
        assert!(PrivateHome::at(&test.0)
            .err()
            .unwrap()
            .to_string()
            .contains("hard-linked"));
    }

    #[test]
    fn exact_chromium_capability_is_accepted_only_in_profile_data() {
        let policy = Policy::current_user().unwrap();
        let stable = policy.chromium_capability_sids[0]
            .as_ptr()
            .cast_mut()
            .cast();
        for (relative, accepted) in [(PROFILE_DATA, true), ("artifacts", false), ("", false)] {
            let test = TestHome::new();
            let home = PrivateHome::at(&test.0).unwrap();
            let target = home.path().join(relative);
            fs::create_dir_all(&target).unwrap();
            extra_ace(
                &target,
                stable,
                FILE_GENERIC_READ | FILE_GENERIC_WRITE | FILE_GENERIC_EXECUTE | DELETE,
                SUB_CONTAINERS_AND_OBJECTS_INHERIT,
                GRANT_ACCESS,
            );
            drop(home);
            assert_eq!(PrivateHome::at(&test.0).is_ok(), accepted, "{relative}");
        }
    }

    #[test]
    fn unknown_capabilities_broad_grants_and_capability_acl_control_are_rejected() {
        let policy = Policy::current_user().unwrap();
        let stable = policy.chromium_capability_sids[0]
            .as_ptr()
            .cast_mut()
            .cast();
        let unknown = sid("S-1-15-3-1");
        let everyone = sid("S-1-1-0");
        for (principal, mask) in [
            (unknown.0, FILE_GENERIC_READ),
            (everyone.0, FILE_GENERIC_READ),
            (stable, FILE_ALL_ACCESS),
        ] {
            let test = TestHome::new();
            let home = PrivateHome::at(&test.0).unwrap();
            let target = home.path().join(PROFILE_DATA);
            fs::create_dir_all(&target).unwrap();
            extra_ace(
                &target,
                principal,
                mask,
                SUB_CONTAINERS_AND_OBJECTS_INHERIT,
                GRANT_ACCESS,
            );
            drop(home);
            assert!(PrivateHome::at(&test.0).is_err());
        }
    }

    #[test]
    fn chromium_nonexecutable_file_deny_is_scoped_to_profile_data() {
        let everyone = sid("S-1-1-0");
        for (relative, accepted) in [(PROFILE_DATA, true), ("artifacts", false)] {
            let test = TestHome::new();
            let home = PrivateHome::at(&test.0).unwrap();
            let target = home.path().join(relative).join("state");
            fs::create_dir_all(target.parent().unwrap()).unwrap();
            fs::write(&target, b"private").unwrap();
            extra_ace(&target, everyone.0, FILE_EXECUTE, 0, DENY_ACCESS);
            drop(home);
            assert_eq!(PrivateHome::at(&test.0).is_ok(), accepted);
        }
    }

    #[test]
    fn profile_exception_requires_exact_worker_layout() {
        let home = Path::new("C:/private");
        assert!(chromium_profile_path(home, &home.join(PROFILE_DATA)));
        for relative in [
            "artifacts/user-data",
            "projects/short/BROWSER1/user-data",
            "projects/0123456789abcdef01234567/BROWSER0/user-data",
            "projects/0123456789abcdef01234567/BROWSER100/user-data",
            "projects/0123456789abcdef01234567/BROWSER1/profile.json",
        ] {
            assert!(
                !chromium_profile_path(home, &home.join(relative)),
                "{relative}"
            );
        }
    }

    #[test]
    fn inheritance_that_stops_after_one_generation_is_rejected() {
        let test = TestHome::new();
        let home = PrivateHome::at(&test.0).unwrap();
        let handle =
            open_checked(home.path(), READ_CONTROL | WRITE_DAC | FILE_READ_ATTRIBUTES).unwrap();
        let (mut acl, mut descriptor) = (null_mut(), null_mut());
        assert_eq!(
            unsafe {
                GetSecurityInfo(
                    handle.as_raw_handle(),
                    SE_FILE_OBJECT,
                    DACL_SECURITY_INFORMATION,
                    null_mut(),
                    null_mut(),
                    &mut acl,
                    null_mut(),
                    &mut descriptor,
                )
            },
            ERROR_SUCCESS
        );
        let _descriptor = LocalAllocation(descriptor);
        for index in 0..u32::from(unsafe { (*acl).AceCount }) {
            let mut ace = null_mut();
            assert_ne!(unsafe { GetAce(acl, index, &mut ace) }, 0);
            unsafe {
                (*ace.cast::<ACE_HEADER>()).AceFlags |= NO_PROPAGATE_INHERIT_ACE as u8;
            }
        }
        assert_eq!(
            unsafe {
                SetSecurityInfo(
                    handle.as_raw_handle(),
                    SE_FILE_OBJECT,
                    DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                    null_mut(),
                    null_mut(),
                    acl,
                    null(),
                )
            },
            ERROR_SUCCESS
        );
        drop(handle);
        drop(home);
        assert!(PrivateHome::at(&test.0).is_err());
    }

    fn upload_fixture() -> (TestHome, PathBuf, PathBuf) {
        let test = TestHome::new();
        let workspace = test.0.join("ws");
        let candidate = workspace.join("nested").join("upload.bin");
        fs::create_dir_all(candidate.parent().unwrap()).unwrap();
        fs::write(&candidate, b"workspace\0bytes\xff").unwrap();
        (test, workspace, candidate)
    }

    #[test]
    fn upload_returns_immutable_bytes_after_source_is_replaced() {
        let (test, workspace, candidate) = upload_fixture();
        let bytes = upload_snapshot(&workspace, &candidate).unwrap();
        let outside = test.0.join("outside.bin");
        fs::write(&outside, b"outside secret").unwrap();
        fs::remove_file(&candidate).unwrap();
        fs::hard_link(&outside, &candidate).unwrap();
        assert_eq!(bytes, b"workspace\0bytes\xff");
        assert!(upload_snapshot(&workspace, &candidate).is_err());
    }

    #[test]
    fn upload_rejects_traversal_sibling_prefix_case_changes_and_device_syntax() {
        let (test, workspace, candidate) = upload_fixture();
        for path in [
            workspace.join("nested").join("..").join("upload.bin"),
            test.0.join("ws-other").join("file"),
            test.0.join("WS").join("nested").join("upload.bin"),
            candidate.with_extension("bin:stream"),
            PathBuf::from("relative.bin"),
            PathBuf::from("//server/share/file"),
            PathBuf::from("//./pipe/file"),
        ] {
            assert!(upload_snapshot(&workspace, &path).is_err());
        }
        assert!(upload_snapshot(Path::new("relative"), &candidate).is_err());
        assert!(upload_snapshot(&workspace, &workspace).is_err());
    }

    #[test]
    fn upload_holds_real_ancestor_rename_and_file_write_locks() {
        let (test, workspace, candidate) = upload_fixture();
        let held = HeldUpload::open(&workspace, &candidate).unwrap();
        assert_eq!(
            fs::rename(&workspace, test.0.join("moved-ws"))
                .unwrap_err()
                .raw_os_error(),
            Some(32)
        );
        assert_eq!(
            fs::rename(candidate.parent().unwrap(), workspace.join("moved-nested"))
                .unwrap_err()
                .raw_os_error(),
            Some(32)
        );
        assert_eq!(
            fs::rename(&candidate, workspace.join("moved-file"))
                .unwrap_err()
                .raw_os_error(),
            Some(32)
        );
        assert_eq!(
            fs::OpenOptions::new()
                .write(true)
                .open(&candidate)
                .unwrap_err()
                .raw_os_error(),
            Some(32)
        );
        assert_eq!(held.read().unwrap(), b"workspace\0bytes\xff");
        fs::rename(&workspace, test.0.join("moved-ws")).unwrap();
    }

    #[test]
    fn upload_rejects_existing_writers_and_oversized_or_directory_inputs() {
        let (_test, workspace, candidate) = upload_fixture();
        let writer = fs::OpenOptions::new().write(true).open(&candidate).unwrap();
        assert!(upload_snapshot(&workspace, &candidate).is_err());
        writer.set_len(MAX_UPLOAD_BYTES + 1).unwrap();
        drop(writer);
        assert!(upload_snapshot(&workspace, &candidate).is_err());
        assert!(upload_snapshot(&workspace, candidate.parent().unwrap()).is_err());
    }

    fn set_test_junction(directory: &Path, target: &Path) {
        use windows_sys::Win32::Storage::FileSystem::{FILE_SHARE_DELETE, FILE_WRITE_ATTRIBUTES};
        use windows_sys::Win32::System::SystemServices::IO_REPARSE_TAG_MOUNT_POINT;
        use windows_sys::Win32::System::IO::DeviceIoControl;
        let directory = checked_absolute_path(directory).unwrap();
        let target = checked_absolute_path(target).unwrap();
        let mut substitute: Vec<u16> = OsStr::new("\\??\\")
            .encode_wide()
            .chain(target.as_os_str().encode_wide())
            .collect();
        let name_bytes = u16::try_from(substitute.len() * 2).unwrap();
        substitute.extend([0, 0]);
        let mut buffer = Vec::new();
        buffer.extend(IO_REPARSE_TAG_MOUNT_POINT.to_le_bytes());
        buffer.extend((8u16 + name_bytes + 4).to_le_bytes());
        buffer.extend(0u16.to_le_bytes());
        buffer.extend(0u16.to_le_bytes());
        buffer.extend(name_bytes.to_le_bytes());
        buffer.extend((name_bytes + 2).to_le_bytes());
        buffer.extend(0u16.to_le_bytes());
        for character in substitute {
            buffer.extend(character.to_le_bytes());
        }
        let handle = open_checked_sharing(
            &directory,
            FILE_WRITE_ATTRIBUTES,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
        )
        .unwrap();
        let mut returned = 0;
        const FSCTL_SET_REPARSE_POINT: u32 = 0x0009_00a4;
        assert_ne!(
            unsafe {
                DeviceIoControl(
                    handle.as_raw_handle(),
                    FSCTL_SET_REPARSE_POINT,
                    buffer.as_ptr().cast(),
                    buffer.len() as u32,
                    null_mut(),
                    0,
                    &mut returned,
                    null_mut(),
                )
            },
            0,
            "junction fixture failed: {}",
            io::Error::last_os_error()
        );
    }

    #[test]
    fn handle_relative_upload_does_not_follow_an_ancestor_mutated_into_a_junction() {
        let test = TestHome::new();
        let workspace = test.0.join("ws");
        let ancestor = workspace.join("empty");
        let outside = test.0.join("outside");
        fs::create_dir_all(&ancestor).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("secret"), b"outside secret").unwrap();
        let checked = open_checked_sharing(
            &checked_absolute_path(&ancestor).unwrap(),
            FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ,
        )
        .unwrap();
        // Attribute-only FSCTL mutation is possible even with READ-only sharing.
        // RootDirectory anchoring must still prevent resolution into outside.
        set_test_junction(&ancestor, &outside);
        assert!(open_relative_upload(&checked, OsStr::new("secret"), false).is_err());
        assert!(upload_snapshot(&workspace, &ancestor.join("secret")).is_err());
    }
}
