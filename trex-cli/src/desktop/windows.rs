//! Physical-pixel Windows input. Keep DPI changes scoped to the worker thread.
use anyhow::{ensure, Context, Result};
use windows_sys::Win32::System::StationsAndDesktops::{
    CloseDesktop, OpenInputDesktop, DESKTOP_READOBJECTS,
};
use windows_sys::Win32::UI::Shell::GetScaleFactorForMonitor;
use windows_sys::Win32::UI::{
    HiDpi::{SetThreadDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2},
    Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_0, INPUT_MOUSE, MOUSEEVENTF_ABSOLUTE, MOUSEEVENTF_MOVE,
        MOUSEEVENTF_VIRTUALDESK, MOUSEINPUT,
    },
    WindowsAndMessaging::{
        GetForegroundWindow, GetSystemMetrics, GetWindowTextW, GetWindowThreadProcessId, SM_CXVIRTUALSCREEN,
        SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN,
    },
};

pub(super) struct DpiScope(*mut core::ffi::c_void);
impl DpiScope {
    pub(super) fn enter() -> Result<Self> {
        let previous =
            unsafe { SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) };
        ensure!(
            !previous.is_null(),
            "Windows physical-pixel coordinates unavailable"
        );
        Ok(Self(previous))
    }
}
impl Drop for DpiScope {
    fn drop(&mut self) {
        unsafe {
            SetThreadDpiAwarenessContext(self.0);
        }
    }
}

pub(super) fn bounds() -> Result<[i32; 4]> {
    let values = unsafe {
        [
            GetSystemMetrics(SM_XVIRTUALSCREEN),
            GetSystemMetrics(SM_YVIRTUALSCREEN),
            GetSystemMetrics(SM_CXVIRTUALSCREEN),
            GetSystemMetrics(SM_CYVIRTUALSCREEN),
        ]
    };
    ensure!(
        values[2] > 1 && values[3] > 1,
        "Windows interactive desktop unavailable"
    );
    Ok(values)
}

pub(super) fn ensure_interactive() -> Result<()> {
    let desktop = unsafe { OpenInputDesktop(0, 0, DESKTOP_READOBJECTS) };
    ensure!(
        !desktop.is_null(),
        "Windows input desktop is locked or protected"
    );
    unsafe {
        CloseDesktop(desktop);
    }
    Ok(())
}

pub(super) fn scale_factor(monitor: u32) -> Result<f32> {
    let mut percent = 0;
    ensure!(
        unsafe {
            GetScaleFactorForMonitor(monitor as usize as *mut core::ffi::c_void, &mut percent)
        } >= 0
            && percent > 0,
        "monitor scale unavailable"
    );
    Ok(percent as f32 / 100.0)
}

pub(super) fn focus() -> Option<(usize, u32)> {
    let window = unsafe { GetForegroundWindow() };
    if window.is_null() {
        return None;
    }
    let mut pid = 0;
    unsafe {
        GetWindowThreadProcessId(window, &mut pid);
    }
    (pid != 0).then_some((window as usize, pid))
}

/// Título de la ventana en primer plano.
pub(super) fn foreground_title() -> Option<String> {
    let window = unsafe { GetForegroundWindow() };
    if window.is_null() {
        return None;
    }
    let mut buffer = [0u16; 256];
    let length = unsafe { GetWindowTextW(window, buffer.as_mut_ptr(), buffer.len() as i32) };
    (length > 0).then(|| String::from_utf16_lossy(&buffer[..length as usize]))
}

pub(super) fn validate_monitor(id: u32, x: i32, y: i32, width: u32, height: u32) -> Result<()> {
    let monitor = xcap::Monitor::all()?
        .into_iter()
        .find(|m| m.id().ok() == Some(id))
        .context("monitor disconnected; capture again")?;
    ensure!(
        monitor.x()? == x
            && monitor.y()? == y
            && monitor.width()? == width
            && monitor.height()? == height,
        "monitor geometry changed; capture again"
    );
    Ok(())
}

// Enigo 0.6 maps absolute motion onto the primary monitor only. SendInput's
// virtual-desktop flag is needed for secondary monitors and negative origins.
pub(super) fn move_pointer(x: i32, y: i32) -> Result<()> {
    let [left, top, width, height] = bounds()?;
    let (dx, dy) = super::normalize_virtual_point(x, y, [left, top, width, height])?;
    let event = INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                dx,
                dy,
                mouseData: 0,
                dwFlags: MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    };
    ensure!(
        unsafe { SendInput(1, &event, core::mem::size_of::<INPUT>() as i32) } == 1,
        "Windows rejected pointer input; protected or elevated windows cannot be controlled"
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn dpi_context_is_restored_after_each_worker_operation() {
        use windows_sys::Win32::UI::HiDpi::{
            AreDpiAwarenessContextsEqual, GetThreadDpiAwarenessContext,
        };
        let before = unsafe { GetThreadDpiAwarenessContext() };
        {
            let _scope = DpiScope::enter().unwrap();
            assert_ne!(
                unsafe {
                    AreDpiAwarenessContextsEqual(
                        GetThreadDpiAwarenessContext(),
                        DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
                    )
                },
                0
            );
        }
        assert_ne!(
            unsafe { AreDpiAwarenessContextsEqual(GetThreadDpiAwarenessContext(), before) },
            0
        );
    }
}
