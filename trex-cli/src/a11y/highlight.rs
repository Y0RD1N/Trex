//! Dónde actúa la IA: un marco naranja con la etiqueta «Trex» sobre el elemento,
//! durante un instante. Es una ventana por encima de todo que no recibe clics
//! (`WS_EX_TRANSPARENT`) ni foco (`WS_EX_NOACTIVATE`) y no sale en la barra de
//! tareas: se ve, pero no estorba.
use std::sync::{mpsc, Mutex};
use std::time::Duration;
use windows::core::{w, PCWSTR};
use windows::Win32::Foundation::{COLORREF, HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows::Win32::Graphics::Gdi::{
    BeginPaint, CreatePen, CreateSolidBrush, DeleteObject, DrawTextW, EndPaint, FillRect, GetStockObject, InvalidateRect, RoundRect, SelectObject,
    SetBkMode, SetTextColor, DEFAULT_GUI_FONT, DT_LEFT, DT_SINGLELINE, DT_VCENTER, NULL_BRUSH, PAINTSTRUCT, PS_SOLID, TRANSPARENT,
};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::WindowsAndMessaging::*;

/// Color que la ventana deja transparente (magenta) y color del marco (#E8834A en BGR).
const KEY: COLORREF = COLORREF(0x00FF_00FF);
const ACCENT: COLORREF = COLORREF(0x004A_83E8);
const WHITE: COLORREF = COLORREF(0x00FF_FFFF);
const SHOW: u32 = WM_APP + 1;
const BORDER: i32 = 3;
const GAP: i32 = 2;
const TAG_HEIGHT: i32 = 18;
const VISIBLE_MS: u32 = 900;

/// Lo próximo que se resalta: el rectángulo del elemento en la pantalla y la acción.
static TARGET: Mutex<Option<(RECT, String)>> = Mutex::new(None);

pub struct Highlighter {
    window: isize,
}

unsafe extern "system" fn procedure(hwnd: HWND, message: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    unsafe {
        match message {
            SHOW => {
                if let Some((rect, _)) = TARGET.lock().ok().and_then(|target| target.clone()) {
                    let pad = BORDER + GAP;
                    let _ = SetWindowPos(hwnd, Some(HWND_TOPMOST), rect.left - pad, rect.top - pad - TAG_HEIGHT,
                        rect.right - rect.left + 2 * pad, rect.bottom - rect.top + 2 * pad + TAG_HEIGHT, SWP_NOACTIVATE | SWP_SHOWWINDOW);
                    let _ = InvalidateRect(Some(hwnd), None, true);
                    SetTimer(Some(hwnd), 1, VISIBLE_MS, None);
                }
                LRESULT(0)
            }
            WM_TIMER => {
                let _ = KillTimer(Some(hwnd), 1);
                let _ = ShowWindow(hwnd, SW_HIDE);
                LRESULT(0)
            }
            WM_ERASEBKGND => LRESULT(1),
            WM_NCHITTEST => LRESULT(HTTRANSPARENT as isize),
            WM_PAINT => {
                let mut paint = PAINTSTRUCT::default();
                let hdc = BeginPaint(hwnd, &mut paint);
                let mut area = RECT::default();
                let _ = GetClientRect(hwnd, &mut area);
                let transparent = CreateSolidBrush(KEY);
                FillRect(hdc, &area, transparent);
                let _ = DeleteObject(transparent.into());
                // Marco redondeado alrededor del elemento.
                let pen = CreatePen(PS_SOLID, BORDER, ACCENT);
                let previous_pen = SelectObject(hdc, pen.into());
                let previous_brush = SelectObject(hdc, GetStockObject(NULL_BRUSH));
                let _ = RoundRect(hdc, 1, TAG_HEIGHT + 1, area.right - 1, area.bottom - 1, 10, 10);
                SelectObject(hdc, previous_brush);
                SelectObject(hdc, previous_pen);
                let _ = DeleteObject(pen.into());
                // Etiqueta «Trex · acción» encima, a la izquierda.
                let label = TARGET.lock().ok().and_then(|target| target.as_ref().map(|(_, label)| label.clone())).unwrap_or_default();
                let mut text: Vec<u16> = format!("  Trex · {label}  ").encode_utf16().collect();
                let previous_font = SelectObject(hdc, GetStockObject(DEFAULT_GUI_FONT));
                let mut measure = RECT { left: 0, top: 0, right: area.right, bottom: TAG_HEIGHT };
                DrawTextW(hdc, &mut text, &mut measure, DT_LEFT | DT_SINGLELINE | DT_VCENTER | windows::Win32::Graphics::Gdi::DT_CALCRECT);
                let tag = RECT { left: 0, top: 0, right: measure.right.min(area.right), bottom: TAG_HEIGHT + 1 };
                let accent = CreateSolidBrush(ACCENT);
                FillRect(hdc, &tag, accent);
                let _ = DeleteObject(accent.into());
                SetBkMode(hdc, TRANSPARENT);
                SetTextColor(hdc, WHITE);
                let mut place = tag;
                DrawTextW(hdc, &mut text, &mut place, DT_LEFT | DT_SINGLELINE | DT_VCENTER);
                SelectObject(hdc, previous_font);
                let _ = EndPaint(hwnd, &paint);
                LRESULT(0)
            }
            _ => DefWindowProcW(hwnd, message, wparam, lparam),
        }
    }
}

impl Highlighter {
    /// Crea la ventana del resaltado en su propio hilo; None si no se puede (sin escritorio).
    pub fn start() -> Option<Self> {
        let (sender, receiver) = mpsc::channel();
        std::thread::spawn(move || unsafe {
            let Ok(module) = GetModuleHandleW(None) else {
                let _ = sender.send(0);
                return;
            };
            let class: PCWSTR = w!("TrexA11yHighlight");
            let definition = WNDCLASSW { lpfnWndProc: Some(procedure), hInstance: module.into(), lpszClassName: class, ..Default::default() };
            RegisterClassW(&definition);
            let window = CreateWindowExW(WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOPMOST | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW,
                class, w!("Trex"), WS_POPUP, 0, 0, 0, 0, None, None, Some(module.into()), None);
            let Ok(window) = window else {
                let _ = sender.send(0);
                return;
            };
            let _ = SetLayeredWindowAttributes(window, KEY, 235, LWA_COLORKEY | LWA_ALPHA);
            let _ = sender.send(window.0 as isize);
            let mut message = MSG::default();
            while GetMessageW(&mut message, None, 0, 0).as_bool() {
                let _ = TranslateMessage(&message);
                DispatchMessageW(&message);
            }
        });
        receiver.recv_timeout(Duration::from_secs(2)).ok().filter(|window| *window != 0).map(|window| Self { window })
    }

    /// Resalta un rectángulo de la pantalla (coordenadas físicas) con la acción en curso.
    pub fn show(&self, rect: RECT, label: &str) {
        if rect.right <= rect.left || rect.bottom <= rect.top {
            return;
        }
        if let Ok(mut target) = TARGET.lock() {
            *target = Some((rect, label.to_owned()));
        }
        unsafe {
            let _ = PostMessageW(Some(HWND(self.window as _)), SHOW, WPARAM(0), LPARAM(0));
        }
    }
}

impl Drop for Highlighter {
    fn drop(&mut self) {
        unsafe {
            let _ = PostMessageW(Some(HWND(self.window as _)), WM_CLOSE, WPARAM(0), LPARAM(0));
        }
    }
}
