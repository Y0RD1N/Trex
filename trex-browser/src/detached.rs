//! Create the broker without inheriting *any* adapter pipe or other handle.
//! Redirecting stdio with Command is insufficient on Windows: an unrelated
//! inheritable pipe can otherwise keep a completed adapter's output open.
use crate::environment::ChildEnvironment;
use anyhow::{bail, Context, Result};
use std::ffi::OsStr;
use std::mem::{size_of, zeroed};
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::{FromRawHandle, OwnedHandle};
use std::path::Path;
use windows_sys::Win32::System::Threading::{
    CreateProcessW, CREATE_BREAKAWAY_FROM_JOB, CREATE_NEW_PROCESS_GROUP,
    CREATE_UNICODE_ENVIRONMENT, DETACHED_PROCESS, PROCESS_INFORMATION, STARTUPINFOW,
};

pub struct DetachedProcess {
    _handle: OwnedHandle,
    #[cfg(test)]
    pid: u32,
}

fn wide(value: &OsStr) -> Result<Vec<u16>> {
    let mut value: Vec<u16> = value.encode_wide().collect();
    if value.contains(&0) {
        bail!("invalid NUL in detached process configuration");
    }
    value.push(0);
    Ok(value)
}

fn quote(value: &OsStr) -> Result<Vec<u16>> {
    let value = wide(value)?;
    let mut result = vec![b'"' as u16];
    let mut slashes = 0;
    for &unit in &value[..value.len() - 1] {
        if unit == b'\\' as u16 {
            slashes += 1;
            continue;
        }
        result.extend(std::iter::repeat_n(
            b'\\' as u16,
            if unit == b'"' as u16 {
                slashes * 2 + 1
            } else {
                slashes
            },
        ));
        slashes = 0;
        result.push(unit);
    }
    result.extend(std::iter::repeat_n(b'\\' as u16, slashes * 2));
    result.push(b'"' as u16);
    Ok(result)
}

pub fn spawn(
    program: &Path,
    args: &[&OsStr],
    environment: &ChildEnvironment,
) -> Result<DetachedProcess> {
    if !program.is_absolute() {
        bail!("detached process executable must be absolute");
    }
    let application = wide(program.as_os_str())?;
    let mut command_line = quote(program.as_os_str())?;
    for arg in args {
        command_line.push(b' ' as u16);
        command_line.extend(quote(arg)?);
    }
    command_line.push(0);
    if command_line.len() > 32767 {
        bail!("detached process command exceeds Windows limit");
    }
    let mut block = Vec::<u16>::new();
    for (name, value) in environment {
        let name = wide(name)?;
        if name.len() <= 1 || name.contains(&(b'=' as u16)) {
            bail!("invalid detached process environment key");
        }
        block.extend_from_slice(&name[..name.len() - 1]);
        block.push(b'=' as u16);
        block.extend(wide(value)?);
    }
    if block.is_empty() {
        block.push(0);
    }
    block.push(0);
    let mut startup: STARTUPINFOW = unsafe { zeroed() };
    startup.cb = size_of::<STARTUPINFOW>() as u32;
    let mut process: PROCESS_INFORMATION = unsafe { zeroed() };
    // No shell, elevation, parent spoofing, inherited environment or inherited
    // handles. A disallowed job breakaway is an error, never a silent fallback.
    let created = unsafe {
        CreateProcessW(
            application.as_ptr(),
            command_line.as_mut_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            0,
            DETACHED_PROCESS
                | CREATE_NEW_PROCESS_GROUP
                | CREATE_BREAKAWAY_FROM_JOB
                | CREATE_UNICODE_ENVIRONMENT,
            block.as_ptr().cast(),
            std::ptr::null(),
            &startup,
            &mut process,
        )
    };
    if created == 0 {
        return Err(std::io::Error::last_os_error()).context("could not launch a detached browser broker with Windows job breakaway; the launcher's job must permit breakaway");
    }
    let _thread = unsafe { OwnedHandle::from_raw_handle(process.hThread) };
    Ok(DetachedProcess {
        _handle: unsafe { OwnedHandle::from_raw_handle(process.hProcess) },
        #[cfg(test)]
        pid: process.dwProcessId,
    })
}

#[cfg(test)]
impl DetachedProcess {
    pub fn id(&self) -> u32 {
        self.pid
    }
    pub fn kill(&mut self) -> Result<()> {
        use std::os::windows::io::AsRawHandle;
        if unsafe {
            windows_sys::Win32::System::Threading::TerminateProcess(self._handle.as_raw_handle(), 0)
        } == 0
        {
            return Err(std::io::Error::last_os_error()).context("could not stop detached fixture");
        }
        Ok(())
    }
    pub fn wait(&mut self) -> Result<()> {
        use std::os::windows::io::AsRawHandle;
        if unsafe {
            windows_sys::Win32::System::Threading::WaitForSingleObject(
                self._handle.as_raw_handle(),
                5000,
            )
        } != windows_sys::Win32::Foundation::WAIT_OBJECT_0
        {
            bail!("detached fixture did not terminate");
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn quotes_windows_arguments_without_a_shell() {
        for (input, expected) in [
            ("", "\"\""),
            ("a b", "\"a b\""),
            ("a\\\"b", "\"a\\\\\\\"b\""),
            ("C:\\a b\\", "\"C:\\a b\\\\\""),
            ("$()&日本語", "\"$()&日本語\""),
        ] {
            assert_eq!(
                String::from_utf16(&quote(OsStr::new(input)).unwrap()).unwrap(),
                expected
            );
        }
        assert!(quote(OsStr::new("a\0b")).is_err());
    }
}
