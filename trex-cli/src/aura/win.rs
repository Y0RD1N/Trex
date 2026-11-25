//! Las ventanas del aura en Windows.
//!
//! Son capas que no reciben clics (`WS_EX_TRANSPARENT`) ni foco
//! (`WS_EX_NOACTIVATE`), no salen en la barra de tareas y se excluyen de las
//! capturas (`WDA_EXCLUDEFROMCAPTURE`): el modelo nunca ve el aura, y la
//! comparación de capturas del control de computadora no la toma por un
//! cambio. Si Windows no permite excluirlas (antes de Windows 10 2004), no se
//! dibuja nada.
//!
//! Todo vive en un hilo propio con su bucle de mensajes. El resto de trex solo
//! deja órdenes en una cola y despierta al hilo; nunca espera por él.
//!
//! - **Visor** (control de computadora): una capa por monitor, por encima de
//!   todo. En reposo no se redibuja; solo hay fotogramas mientras se cierra
//!   (captura), mientras dura una onda (clic) y al aparecer o irse.
//! - **Cinta** (control por accesibilidad): cuatro tiras finas y una etiqueta
//!   colocadas justo encima de la ventana controlada en el orden de ventanas (no
//!   encima de todo), que la siguen al moverla. La cinta avanza a saltos de
//!   100 ms; al esperar se para.
use super::paint::{bump, ease_out, paint_disc, paint_outline, paint_ring, paint_segment, settle_label, Canvas, Corner, Dashes, Palette, Rgb, Tape, TapeField, Track};
use super::Command;
use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::{mpsc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use windows::core::{w, PCWSTR};
use windows::Win32::Foundation::{COLORREF, HINSTANCE, HWND, LPARAM, LRESULT, POINT, RECT, SIZE, WPARAM};
use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS};
use windows::Win32::Graphics::Gdi::{
    CreateCompatibleDC, CreateDIBSection, CreateFontW, DeleteDC, DeleteObject, EnumDisplayMonitors, GdiFlush, GetMonitorInfoW, GetTextExtentPoint32W,
    GetTextFaceW, MonitorFromWindow, SelectObject, SetBkMode, SetTextColor, TextOutW, AC_SRC_ALPHA, AC_SRC_OVER, BITMAPINFO, BITMAPINFOHEADER, BI_RGB,
    BLENDFUNCTION, CLEARTYPE_QUALITY, CLIP_DEFAULT_PRECIS, DEFAULT_CHARSET, DIB_RGB_COLORS, FF_MODERN, FIXED_PITCH, HBITMAP, HDC, HFONT, HGDIOBJ, HMONITOR,
    MONITORINFO, MONITOR_DEFAULTTONEAREST, OUT_DEFAULT_PRECIS, TRANSPARENT,
};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::Accessibility::{SetWinEventHook, UnhookWinEvent, HWINEVENTHOOK};
use windows::Win32::UI::HiDpi::{GetDpiForMonitor, SetThreadDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2, MDT_EFFECTIVE_DPI};
use windows::Win32::UI::WindowsAndMessaging::*;

/// Clase de las capas del aura: la lista de ventanas del control por accesibilidad la omite.
pub const CLASS: &str = "TrexAura";
const LAYER_CLASS: PCWSTR = w!("TrexAura");
const HOST_CLASS: PCWSTR = w!("TrexAuraHost");
const WAKE: u32 = WM_APP + 7;
const TIMER: usize = 1;

/// Sin acciones en este tiempo, el aura se va sola.
const IDLE: Duration = Duration::from_secs(30);
const FRAME: Duration = Duration::from_millis(16);
const STEP: Duration = Duration::from_millis(100);

// Visor (medidas a 100 % de escala).
const VISOR_ENTER: Duration = Duration::from_millis(300);
const VISOR_LEAVE: Duration = Duration::from_millis(400);
const VISOR_LOOK: Duration = Duration::from_millis(420);
const VISOR_FLASH: Duration = Duration::from_millis(550);
const VISOR_RIPPLE: Duration = Duration::from_millis(700);
const VISOR_INSET: f32 = 12.0;
const VISOR_RADIUS: f32 = 22.0;
const VISOR_ARM: f32 = 84.0;
const VISOR_PINCH: f32 = 12.0;
const VISOR_AWAY: f32 = 26.0;
const RIPPLE_RADIUS: f32 = 26.0;

// Cinta.
const TAPE_ENTER: Duration = Duration::from_millis(250);
const TAPE_LEAVE: Duration = Duration::from_millis(400);
const TAPE_OFFSET: f32 = 5.0;
const WINDOW_CORNER: f32 = 8.0;
const TAPE_PERIOD: f32 = 30.0;
const TAPE_ADVANCE: f32 = 2.0;

static QUEUE: Mutex<Vec<Command>> = Mutex::new(Vec::new());
static HOST: OnceLock<Option<isize>> = OnceLock::new();

/// Deja una orden para el hilo del aura (y lo arranca la primera vez).
pub(super) fn send(command: Command) {
    let Some(host) = *HOST.get_or_init(start) else { return };
    if let Ok(mut queue) = QUEUE.lock() {
        if queue.len() >= 256 {
            return;
        }
        queue.push(command);
    }
    unsafe {
        let _ = PostMessageW(Some(HWND(host as _)), WAKE, WPARAM(0), LPARAM(0));
    }
}

fn start() -> Option<isize> {
    let (ready, receiver) = mpsc::channel();
    std::thread::Builder::new().name("trex-aura".into()).spawn(move || unsafe { run(ready) }).ok()?;
    receiver.recv_timeout(Duration::from_secs(2)).ok().flatten()
}

thread_local! {
    static STATE: RefCell<Option<State>> = const { RefCell::new(None) };
}

unsafe fn run(ready: mpsc::Sender<Option<isize>>) {
    unsafe {
        // Píxeles físicos en todas las pantallas, como el control de computadora y UI Automation.
        let _ = SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        let Ok(module) = GetModuleHandleW(None) else {
            let _ = ready.send(None);
            return;
        };
        let module: HINSTANCE = module.into();
        RegisterClassW(&WNDCLASSW { lpfnWndProc: Some(host_procedure), hInstance: module, lpszClassName: HOST_CLASS, ..Default::default() });
        RegisterClassW(&WNDCLASSW { lpfnWndProc: Some(layer_procedure), hInstance: module, lpszClassName: LAYER_CLASS, ..Default::default() });
        let Ok(host) = CreateWindowExW(WINDOW_EX_STYLE(0), HOST_CLASS, w!("Trex"), WINDOW_STYLE(0), 0, 0, 0, 0, Some(HWND_MESSAGE), None, Some(module), None) else {
            let _ = ready.send(None);
            return;
        };
        STATE.with(|state| *state.borrow_mut() = Some(State::new(host, module)));
        let _ = ready.send(Some(host.0 as isize));
        let mut message = MSG::default();
        while GetMessageW(&mut message, None, 0, 0).as_bool() {
            let _ = TranslateMessage(&message);
            DispatchMessageW(&message);
        }
    }
}

/// Con el estado, si nadie lo está usando ya (un mensaje anidado no debe entrar dos veces).
fn with_state(action: impl FnOnce(&mut State)) {
    STATE.with(|state| {
        if let Ok(mut state) = state.try_borrow_mut() {
            if let Some(state) = state.as_mut() {
                action(state);
            }
        }
    });
}

unsafe extern "system" fn host_procedure(hwnd: HWND, message: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    match message {
        WAKE => {
            let commands = QUEUE.lock().map(|mut queue| std::mem::take(&mut *queue)).unwrap_or_default();
            with_state(|state| {
                for command in commands {
                    state.apply(command);
                }
                state.frame();
            });
            LRESULT(0)
        }
        WM_TIMER => {
            with_state(State::frame);
            LRESULT(0)
        }
        _ => unsafe { DefWindowProcW(hwnd, message, wparam, lparam) },
    }
}

unsafe extern "system" fn layer_procedure(hwnd: HWND, message: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    match message {
        WM_NCHITTEST => LRESULT(HTTRANSPARENT as isize),
        WM_MOUSEACTIVATE => LRESULT(MA_NOACTIVATE as isize),
        _ => unsafe { DefWindowProcW(hwnd, message, wparam, lparam) },
    }
}

/// La ventana controlada se movió o cambió de tamaño, o cambió la ventana activa.
unsafe extern "system" fn on_event(_: HWINEVENTHOOK, event: u32, hwnd: HWND, object: i32, child: i32, _: u32, _: u32) {
    if event == EVENT_SYSTEM_FOREGROUND {
        with_state(|state| state.restack_all());
    } else if object == OBJID_WINDOW.0 && child == 0 {
        with_state(|state| state.follow(hwnd));
    }
}

fn progress(since: Instant, now: Instant, span: Duration) -> f32 {
    (now.saturating_duration_since(since).as_secs_f32() / span.as_secs_f32()).clamp(0.0, 1.0)
}

/// Los efectos de animación de Windows (Configuración → Accesibilidad).
fn animations_enabled() -> bool {
    let mut enabled = windows::core::BOOL(1);
    unsafe {
        let _ = SystemParametersInfoW(SPI_GETCLIENTAREAANIMATION, 0, Some(&mut enabled as *mut _ as *mut _), SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0));
    }
    enabled.as_bool()
}

fn colorref(color: Rgb) -> COLORREF {
    COLORREF(u32::from(color.0) | (u32::from(color.1) << 8) | (u32::from(color.2) << 16))
}

/// Una capa: ventana por capas con su DIB de 32 bits premultiplicado.
struct Layer {
    hwnd: HWND,
    dc: HDC,
    bitmap: HBITMAP,
    previous: HGDIOBJ,
    bits: *mut u32,
    width: i32,
    height: i32,
    shown: bool,
    position: (i32, i32),
}

impl Layer {
    fn create(module: HINSTANCE, topmost: bool) -> Option<Self> {
        unsafe {
            let mut style = WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE;
            if topmost {
                style |= WS_EX_TOPMOST;
            }
            let hwnd = CreateWindowExW(style, LAYER_CLASS, w!("Trex"), WS_POPUP, 0, 0, 1, 1, None, None, Some(module), None).ok()?;
            // Sin exclusión de las capturas no se dibuja: el modelo vería el aura.
            // Solo al desarrollar, TREX_AURA_CAPTURABLE la deja ver en capturas para revisarla.
            let capturable = cfg!(debug_assertions) && std::env::var_os("TREX_AURA_CAPTURABLE").is_some();
            if !capturable && SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE).is_err() {
                let _ = DestroyWindow(hwnd);
                return None;
            }
            let dc = CreateCompatibleDC(None);
            if dc.is_invalid() {
                let _ = DestroyWindow(hwnd);
                return None;
            }
            Some(Self { hwnd, dc, bitmap: HBITMAP::default(), previous: HGDIOBJ::default(), bits: std::ptr::null_mut(), width: 0, height: 0, shown: false, position: (0, 0) })
        }
    }

    /// Un DIB del tamaño pedido (se reutiliza si no cambió).
    fn ensure(&mut self, width: i32, height: i32) -> bool {
        if width <= 0 || height <= 0 {
            return false;
        }
        if width == self.width && height == self.height && !self.bits.is_null() {
            return true;
        }
        self.release_bitmap();
        unsafe {
            let info = BITMAPINFO {
                bmiHeader: BITMAPINFOHEADER {
                    biSize: size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: width,
                    biHeight: -height,
                    biPlanes: 1,
                    biBitCount: 32,
                    biCompression: BI_RGB.0,
                    ..Default::default()
                },
                ..Default::default()
            };
            let mut bits = std::ptr::null_mut();
            let Ok(bitmap) = CreateDIBSection(Some(self.dc), &info, DIB_RGB_COLORS, &mut bits, None, 0) else { return false };
            if bits.is_null() {
                let _ = DeleteObject(bitmap.into());
                return false;
            }
            self.previous = SelectObject(self.dc, bitmap.into());
            self.bitmap = bitmap;
            self.bits = bits.cast();
        }
        self.width = width;
        self.height = height;
        true
    }

    fn release_bitmap(&mut self) {
        if self.bits.is_null() {
            return;
        }
        unsafe {
            SelectObject(self.dc, self.previous);
            let _ = DeleteObject(self.bitmap.into());
        }
        self.bits = std::ptr::null_mut();
        self.width = 0;
        self.height = 0;
    }

    fn canvas(&mut self) -> Canvas<'_> {
        let (width, height) = (self.width.max(0) as usize, self.height.max(0) as usize);
        // SAFETY: el DIB tiene width*height píxeles de 32 bits y vive mientras la capa.
        let pixels = unsafe { std::slice::from_raw_parts_mut(self.bits, width * height) };
        Canvas { width, height, pixels }
    }

    /// Entrega el DIB a la ventana en `position` con la opacidad global dada.
    fn present(&mut self, position: (i32, i32), opacity: f32) {
        if self.bits.is_null() {
            return;
        }
        let blend = BLENDFUNCTION {
            BlendOp: AC_SRC_OVER as u8,
            BlendFlags: 0,
            SourceConstantAlpha: (opacity.clamp(0.0, 1.0) * 255.0).round() as u8,
            AlphaFormat: AC_SRC_ALPHA as u8,
        };
        let point = POINT { x: position.0, y: position.1 };
        let size = SIZE { cx: self.width, cy: self.height };
        let source = POINT { x: 0, y: 0 };
        unsafe {
            let _ = GdiFlush();
            let _ = UpdateLayeredWindow(self.hwnd, None, Some(&point), Some(&size), Some(self.dc), Some(&source), COLORREF(0), Some(&blend), ULW_ALPHA);
            if !self.shown {
                let _ = ShowWindow(self.hwnd, SW_SHOWNOACTIVATE);
                self.shown = true;
            }
        }
        self.position = position;
    }

    fn hide(&mut self) {
        if self.shown {
            unsafe {
                let _ = ShowWindow(self.hwnd, SW_HIDE);
            }
            self.shown = false;
        }
    }
}

impl Drop for Layer {
    fn drop(&mut self) {
        self.release_bitmap();
        unsafe {
            let _ = DeleteDC(self.dc);
            let _ = DestroyWindow(self.hwnd);
        }
    }
}

/// Fuentes de las etiquetas. El texto se pinta con GDI sobre un fondo opaco y
/// luego se le da su opacidad con `settle_label`.
struct Fonts {
    cache: HashMap<(i32, i32), HFONT>,
    /// Cascadia Mono viene con Windows 11; si no está, Consolas.
    cascadia: Option<bool>,
}

impl Fonts {
    fn create(face: PCWSTR, size: i32, weight: i32) -> HFONT {
        let pitch = u32::from(FIXED_PITCH.0) | u32::from(FF_MODERN.0);
        unsafe { CreateFontW(-size, 0, 0, 0, weight, 0, 0, 0, DEFAULT_CHARSET, OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY, pitch, face) }
    }

    fn get(&mut self, dc: HDC, size: i32, weight: i32) -> HFONT {
        if let Some(font) = self.cache.get(&(size, weight)) {
            return *font;
        }
        let cascadia = *self.cascadia.get_or_insert_with(|| {
            let probe = Self::create(w!("Cascadia Mono"), size, weight);
            let mut name = [0u16; 64];
            let length = unsafe {
                let previous = SelectObject(dc, probe.into());
                let length = GetTextFaceW(dc, Some(&mut name));
                SelectObject(dc, previous);
                let _ = DeleteObject(probe.into());
                length
            };
            String::from_utf16_lossy(&name[..length.clamp(0, 64) as usize]).trim_end_matches('\0').eq_ignore_ascii_case("Cascadia Mono")
        });
        let font = Self::create(if cascadia { w!("Cascadia Mono") } else { w!("Consolas") }, size, weight);
        self.cache.insert((size, weight), font);
        font
    }
}

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}

/// Mide un texto con la fuente dada.
fn measure(dc: HDC, font: HFONT, text: &[u16]) -> (i32, i32) {
    let mut size = SIZE::default();
    unsafe {
        let previous = SelectObject(dc, font.into());
        let _ = GetTextExtentPoint32W(dc, text, &mut size);
        SelectObject(dc, previous);
    }
    (size.cx, size.cy)
}

/// Escribe trozos de texto seguidos (cada uno con su fuente y color) desde (x, y).
fn write(dc: HDC, mut x: i32, y: i32, parts: &[(HFONT, Rgb, &[u16])]) {
    unsafe {
        let _ = GdiFlush();
        SetBkMode(dc, TRANSPARENT);
        for (font, color, text) in parts {
            let previous = SelectObject(dc, (*font).into());
            SetTextColor(dc, colorref(*color));
            let _ = TextOutW(dc, x, y, text);
            let mut size = SIZE::default();
            let _ = GetTextExtentPoint32W(dc, text, &mut size);
            SelectObject(dc, previous);
            x += size.cx;
        }
        let _ = GdiFlush();
    }
}

struct Monitor {
    rect: RECT,
    scale: f32,
    layer: Layer,
}

struct Visor {
    monitors: Vec<Monitor>,
    shown: Instant,
    leaving: Option<Instant>,
    last: Instant,
    look: Option<Instant>,
    ripples: Vec<((i32, i32), Instant)>,
    label: String,
    motion: bool,
    /// Algo cambió desde el último dibujo (en reposo no se redibuja).
    dirty: bool,
}

struct Strip {
    layer: Layer,
    /// Lo que no cambia entre pasos mientras la ventana no se mueva.
    field: Option<TapeField>,
}

/// Cómo se dibujó la etiqueta: si no cambia, solo se mueve.
#[derive(Clone, PartialEq)]
struct TagLook {
    label: String,
    waiting: bool,
    scale: f32,
    palette: Palette,
    below: bool,
    size: (i32, i32),
}

struct Cinta {
    target: HWND,
    strips: Vec<Strip>,
    tag: Layer,
    hook: HWINEVENTHOOK,
    topmost: bool,
    shown: Instant,
    leaving: Option<Instant>,
    last: Instant,
    waiting: bool,
    label: String,
    phase: f32,
    pulse: Option<(f32, Instant)>,
    motion: bool,
    next_step: Instant,
    drawn: Option<Drawn>,
    tag_look: Option<TagLook>,
    hidden: bool,
}

/// Lo que se dibujó por última vez: si no cambia, no se redibuja.
#[derive(Clone, PartialEq)]
struct Drawn {
    frame: RECT,
    zoomed: bool,
    scale: f32,
    phase: f32,
    waiting: bool,
    label: String,
    accent: Palette,
}

struct State {
    host: HWND,
    module: HINSTANCE,
    palette: Palette,
    visor: Option<Visor>,
    tapes: Vec<Cinta>,
    foreground_hook: Option<HWINEVENTHOOK>,
    fonts: Fonts,
    timer: Option<Duration>,
    /// Windows no deja excluir las capas de las capturas: no se dibuja nada.
    unsupported: bool,
}

impl State {
    fn new(host: HWND, module: HINSTANCE) -> Self {
        Self {
            host,
            module,
            palette: Palette::from_accent(super::accent()),
            visor: None,
            tapes: Vec::new(),
            foreground_hook: None,
            fonts: Fonts { cache: HashMap::new(), cascadia: None },
            timer: None,
            unsupported: false,
        }
    }

    fn apply(&mut self, command: Command) {
        if self.unsupported {
            return;
        }
        self.palette = Palette::from_accent(super::accent());
        let now = Instant::now();
        match command {
            Command::ScreenLook { label } => {
                if let Some(visor) = self.visor_mut(now) {
                    visor.look = Some(now);
                    visor.label = label;
                }
            }
            Command::ScreenAct { label, point } => {
                if let Some(visor) = self.visor_mut(now) {
                    visor.label = label;
                    if let Some(point) = point {
                        visor.ripples.push((point, now));
                    }
                }
            }
            Command::WindowLook { window } => {
                if let Some(tape) = self.tape_mut(window, now) {
                    tape.waiting = false;
                    tape.label = "lee la ventana".into();
                    tape.pulse = Some((2.0, now + Duration::from_millis(500)));
                }
            }
            Command::WindowAct { window, label } => {
                if let Some(tape) = self.tape_mut(window, now) {
                    if let Some(label) = label {
                        tape.label = label;
                    } else if tape.waiting {
                        tape.label = "sigue".into();
                    }
                    tape.waiting = false;
                    tape.pulse = Some((3.0, now + Duration::from_millis(650)));
                }
            }
            Command::WindowWait { window } => {
                if let Some(tape) = self.tape_mut(window, now) {
                    tape.waiting = true;
                    tape.label = "espera: estás usando la ventana".into();
                    tape.pulse = None;
                }
            }
        }
    }

    /// El visor, creado si hace falta (una capa por monitor).
    fn visor_mut(&mut self, now: Instant) -> Option<&mut Visor> {
        if self.visor.is_none() {
            let mut monitors = Vec::new();
            for (rect, scale) in monitors_now() {
                let Some(layer) = Layer::create(self.module, true) else {
                    self.unsupported = true;
                    return None;
                };
                monitors.push(Monitor { rect, scale, layer });
            }
            if monitors.is_empty() {
                return None;
            }
            self.visor = Some(Visor {
                monitors,
                shown: now,
                leaving: None,
                last: now,
                look: None,
                ripples: Vec::new(),
                label: String::new(),
                motion: animations_enabled(),
                dirty: true,
            });
        }
        let visor = self.visor.as_mut()?;
        if let Some(leaving) = visor.leaving.take() {
            // Volvía a irse: reaparece desde donde estaba.
            let away = progress(leaving, now, VISOR_LEAVE);
            visor.shown = now.checked_sub(VISOR_ENTER.mul_f32(1.0 - away)).unwrap_or(now);
        }
        visor.last = now;
        visor.dirty = true;
        Some(visor)
    }

    /// La cinta de una ventana, creada si hace falta.
    fn tape_mut(&mut self, window: isize, now: Instant) -> Option<&mut Cinta> {
        let target = HWND(window as _);
        if window == 0 || !unsafe { IsWindow(Some(target)) }.as_bool() {
            return None;
        }
        let index = match self.tapes.iter().position(|tape| tape.target == target) {
            Some(index) => index,
            None => {
                let mut strips = Vec::new();
                for _ in 0..4 {
                    let Some(layer) = Layer::create(self.module, false) else {
                        self.unsupported = true;
                        return None;
                    };
                    strips.push(Strip { layer, field: None });
                }
                let Some(tag) = Layer::create(self.module, false) else {
                    self.unsupported = true;
                    return None;
                };
                let mut process = 0u32;
                unsafe { GetWindowThreadProcessId(target, Some(&mut process)) };
                let hook = unsafe {
                    SetWinEventHook(EVENT_OBJECT_LOCATIONCHANGE, EVENT_OBJECT_LOCATIONCHANGE, None, Some(on_event), process, 0, WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS)
                };
                if self.foreground_hook.is_none() {
                    let hook = unsafe { SetWinEventHook(EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND, None, Some(on_event), 0, 0, WINEVENT_OUTOFCONTEXT) };
                    self.foreground_hook = (!hook.is_invalid()).then_some(hook);
                }
                self.tapes.push(Cinta {
                    target,
                    strips,
                    tag,
                    hook,
                    topmost: false,
                    shown: now,
                    leaving: None,
                    last: now,
                    waiting: false,
                    label: String::new(),
                    phase: 0.0,
                    pulse: None,
                    motion: true,
                    next_step: now,
                    drawn: None,
                    tag_look: None,
                    hidden: false,
                });
                self.tapes.len() - 1
            }
        };
        let tape = &mut self.tapes[index];
        if let Some(leaving) = tape.leaving.take() {
            let away = progress(leaving, now, TAPE_LEAVE);
            tape.shown = now.checked_sub(TAPE_ENTER.mul_f32(1.0 - away)).unwrap_or(now);
        }
        tape.last = now;
        tape.motion = animations_enabled();
        Some(tape)
    }

    /// Un fotograma: dibuja lo que cambió, retira lo que caducó y programa el siguiente.
    fn frame(&mut self) {
        let now = Instant::now();
        let mut next: Option<Duration> = None;
        let mut soon = |wait: Duration| next = Some(next.map_or(wait, |current| current.min(wait)));

        if let Some(visor) = self.visor.as_mut() {
            if visor.leaving.is_none() && now.saturating_duration_since(visor.last) >= IDLE {
                visor.leaving = Some(now);
            }
            if visor.leaving.is_some_and(|leaving| now.saturating_duration_since(leaving) >= VISOR_LEAVE) {
                self.visor = None;
            } else {
                let animating = paint_visor(visor, &self.palette, &mut self.fonts, now);
                soon(if animating { FRAME } else { IDLE.saturating_sub(now.saturating_duration_since(visor.last)).max(FRAME) });
            }
        }

        let palette = self.palette;
        let mut index = 0;
        while index < self.tapes.len() {
            let tape = &mut self.tapes[index];
            let gone = !unsafe { IsWindow(Some(tape.target)) }.as_bool();
            if !gone && tape.leaving.is_none() && now.saturating_duration_since(tape.last) >= IDLE {
                tape.leaving = Some(now);
            }
            if gone || tape.leaving.is_some_and(|leaving| now.saturating_duration_since(leaving) >= TAPE_LEAVE) {
                let tape = self.tapes.remove(index);
                drop_tape(tape);
                continue;
            }
            let fading = paint_tape(tape, &palette, &mut self.fonts, now, false);
            soon(if fading { FRAME } else { tape.next_step.saturating_duration_since(now).max(FRAME) });
            index += 1;
        }
        if self.tapes.is_empty() {
            if let Some(hook) = self.foreground_hook.take() {
                unsafe {
                    let _ = UnhookWinEvent(hook);
                }
            }
        }

        // Un solo temporizador: rápido mientras algo se anima, lento o ninguno en reposo.
        if next != self.timer {
            unsafe {
                match next {
                    Some(wait) => {
                        SetTimer(Some(self.host), TIMER, wait.as_millis().clamp(10, 60_000) as u32, None);
                    }
                    None => {
                        let _ = KillTimer(Some(self.host), TIMER);
                    }
                }
            }
            self.timer = next;
        }
    }

    /// La ventana controlada se movió: la cinta va con ella al momento.
    fn follow(&mut self, hwnd: HWND) {
        let palette = self.palette;
        let now = Instant::now();
        for tape in self.tapes.iter_mut().filter(|tape| tape.target == hwnd) {
            paint_tape(tape, &palette, &mut self.fonts, now, true);
        }
    }

    fn restack_all(&mut self) {
        for tape in &mut self.tapes {
            restack(tape);
        }
    }
}

fn drop_tape(tape: Cinta) {
    if !tape.hook.is_invalid() {
        unsafe {
            let _ = UnhookWinEvent(tape.hook);
        }
    }
    drop(tape);
}

/// Los monitores ahora: rectángulo físico y escala.
fn monitors_now() -> Vec<(RECT, f32)> {
    unsafe extern "system" fn collect(monitor: HMONITOR, _: HDC, _: *mut RECT, data: LPARAM) -> windows::core::BOOL {
        unsafe { (*(data.0 as *mut Vec<HMONITOR>)).push(monitor) };
        windows::core::BOOL(1)
    }
    let mut handles: Vec<HMONITOR> = Vec::new();
    unsafe {
        let _ = EnumDisplayMonitors(None, None, Some(collect), LPARAM(&mut handles as *mut _ as isize));
    }
    handles
        .into_iter()
        .filter_map(|monitor| {
            let mut info = MONITORINFO { cbSize: size_of::<MONITORINFO>() as u32, ..Default::default() };
            if !unsafe { GetMonitorInfoW(monitor, &mut info) }.as_bool() {
                return None;
            }
            Some((info.rcMonitor, monitor_scale(monitor)))
        })
        .collect()
}

fn monitor_scale(monitor: HMONITOR) -> f32 {
    let (mut x, mut y) = (96u32, 96u32);
    if unsafe { GetDpiForMonitor(monitor, MDT_EFFECTIVE_DPI, &mut x, &mut y) }.is_err() {
        return 1.0;
    }
    (x.max(96) as f32 / 96.0).clamp(1.0, 4.0)
}

/// Dibuja el visor en cada monitor. Devuelve si sigue animándose.
fn paint_visor(visor: &mut Visor, palette: &Palette, fonts: &mut Fonts, now: Instant) -> bool {
    let presence = match visor.leaving {
        Some(leaving) => 1.0 - ease_out(progress(leaving, now, VISOR_LEAVE)),
        None => ease_out(progress(visor.shown, now, VISOR_ENTER)),
    };
    let look = visor.look.map(|at| progress(at, now, VISOR_LOOK.max(VISOR_FLASH)));
    let pinch = match visor.look {
        Some(at) if visor.motion => bump(progress(at, now, VISOR_LOOK)),
        _ => 0.0,
    };
    let flash = visor.look.map_or(0.0, |at| 1.0 - ease_out(progress(at, now, VISOR_FLASH)));
    visor.ripples.retain(|(_, at)| now.saturating_duration_since(*at) < VISOR_RIPPLE);
    if look.is_some_and(|t| t >= 1.0) {
        visor.look = None;
    }
    let entering = visor.leaving.is_some() || presence < 1.0;
    let animating = entering || visor.look.is_some() || !visor.ripples.is_empty();
    if !animating && !visor.dirty {
        return false;
    }
    visor.dirty = animating;

    for monitor in &mut visor.monitors {
        let s = monitor.scale;
        let width = monitor.rect.right - monitor.rect.left;
        let height = monitor.rect.bottom - monitor.rect.top;
        if !monitor.layer.ensure(width, height) {
            continue;
        }
        let dc = monitor.layer.dc;
        let away = if visor.motion { -VISOR_AWAY * s * (1.0 - presence) } else { 0.0 };
        let shift = away + VISOR_PINCH * s * pinch;
        let inset = VISOR_INSET * s;
        let (w, h) = (width as f32, height as f32);
        let track = Track { left: inset, top: inset, right: w - inset, bottom: h - inset, radius: VISOR_RADIUS * s };
        let mut canvas = monitor.layer.canvas();
        canvas.clear();
        paint_outline(&mut canvas, &track, (0.75 * s).max(0.6), palette.accent, 0.3 + 0.65 * flash);
        let corners = [(inset, inset, 1.0, 1.0), (w - inset, inset, -1.0, 1.0), (w - inset, h - inset, -1.0, -1.0), (inset, h - inset, 1.0, -1.0)];
        for (x, y, inward_x, inward_y) in corners {
            let corner = Corner { x: x + inward_x * shift, y: y + inward_y * shift, inward_x, inward_y };
            corner.paint(&mut canvas, VISOR_RADIUS * s, VISOR_ARM * s, 2.5 * s, 4.5 * s, palette.accent, palette);
        }
        for ((x, y), at) in &visor.ripples {
            let (local_x, local_y) = (x - monitor.rect.left, y - monitor.rect.top);
            if local_x < 0 || local_y < 0 || local_x >= width || local_y >= height {
                continue;
            }
            let t = progress(*at, now, VISOR_RIPPLE);
            let (radius, alpha) = if visor.motion {
                (RIPPLE_RADIUS * s * (0.15 + 0.95 * ease_out(t)), if t < 0.55 { 1.0 - 0.05 * t / 0.55 } else { 0.95 * (1.0 - t) / 0.45 })
            } else {
                (RIPPLE_RADIUS * s * 0.7, if t < 0.6 { 1.0 } else { 0.0 })
            };
            paint_ring(&mut canvas, (local_x as f32 + 0.5, local_y as f32 + 0.5), radius, 1.75 * s, 3.0 * s, alpha, palette);
        }
        drop(canvas);
        // La etiqueta corta la línea de arriba, centrada.
        if !visor.label.is_empty() {
            let size = (13.0 * s).round() as i32;
            let bold = fonts.get(dc, size, 600);
            let regular = fonts.get(dc, size, 400);
            let lead = wide("trex › ");
            let text = wide(&visor.label);
            let (lead_w, line_h) = measure(dc, bold, &lead);
            let (text_w, _) = measure(dc, regular, &text);
            let (pad_x, pad_y) = ((10.0 * s).round() as i32, (5.0 * s).round() as i32);
            let box_w = lead_w + text_w + 2 * pad_x;
            let box_h = line_h + 2 * pad_y;
            let left = (width - box_w) / 2;
            let top = ((inset - box_h as f32 / 2.0).round() as i32).max((2.0 * s) as i32);
            let area = [left as f32, top as f32, (left + box_w) as f32, (top + box_h) as f32];
            monitor.layer.canvas().fill_box(area, 0.0, palette.label_back, 1.0);
            write(dc, left + pad_x, top + pad_y, &[(bold, palette.label_text, &lead), (regular, palette.label_text, &text)]);
            settle_label(&mut monitor.layer.canvas(), area, 7.0 * s, 0.88);
        }
        monitor.layer.present((monitor.rect.left, monitor.rect.top), presence);
    }
    animating
}

/// El marco de la ventana sin los bordes invisibles de cambiar el tamaño.
fn frame_of(window: HWND) -> Option<RECT> {
    let mut rect = RECT::default();
    let ok = unsafe { DwmGetWindowAttribute(window, DWMWA_EXTENDED_FRAME_BOUNDS, &mut rect as *mut _ as *mut _, size_of::<RECT>() as u32) }.is_ok();
    if ok && rect.right > rect.left && rect.bottom > rect.top {
        return Some(rect);
    }
    let mut rect = RECT::default();
    unsafe { GetWindowRect(window, &mut rect) }.ok()?;
    (rect.right > rect.left && rect.bottom > rect.top).then_some(rect)
}

/// La ventana no se ve: minimizada, oculta o en otro escritorio virtual.
fn out_of_sight(window: HWND) -> bool {
    let mut cloaked = 0u32;
    let is_cloaked = unsafe { DwmGetWindowAttribute(window, DWMWA_CLOAKED, &mut cloaked as *mut _ as *mut _, size_of::<u32>() as u32) }.is_ok() && cloaked != 0;
    is_cloaked || unsafe { IsIconic(window).as_bool() || !IsWindowVisible(window).as_bool() }
}

fn is_topmost(window: HWND) -> bool {
    (unsafe { GetWindowLongW(window, GWL_EXSTYLE) } as u32 & WS_EX_TOPMOST.0) != 0
}

/// Coloca las capas de la cinta justo encima de la ventana controlada: lo que
/// esté delante de ella también queda delante de la cinta.
fn restack(tape: &mut Cinta) {
    if tape.hidden {
        return;
    }
    let ours: Vec<HWND> = std::iter::once(tape.tag.hwnd).chain(tape.strips.iter().map(|strip| strip.layer.hwnd)).collect();
    // ¿Ya están justo encima?
    let mut above = unsafe { GetWindow(tape.target, GW_HWNDPREV) }.ok();
    let mut seen = 0;
    while let Some(window) = above.filter(|window| ours.contains(window)) {
        seen += 1;
        above = unsafe { GetWindow(window, GW_HWNDPREV) }.ok();
    }
    if seen == ours.len() {
        return;
    }
    let target_top = is_topmost(tape.target);
    if target_top != tape.topmost {
        let band = if target_top { HWND_TOPMOST } else { HWND_NOTOPMOST };
        for window in &ours {
            unsafe {
                let _ = SetWindowPos(*window, Some(band), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOOWNERZORDER);
            }
        }
        tape.topmost = target_top;
    }
    let mut after = match above {
        None => if target_top { HWND_TOPMOST } else { HWND_TOP },
        Some(window) if !target_top && is_topmost(window) => HWND_TOP,
        Some(window) => window,
    };
    for window in ours {
        unsafe {
            let _ = SetWindowPos(window, Some(after), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOOWNERZORDER);
        }
        after = window;
    }
}

/// Dibuja (si cambió) y coloca la cinta. Devuelve si está apareciendo o yéndose.
fn paint_tape(tape: &mut Cinta, palette: &Palette, fonts: &mut Fonts, now: Instant, moved: bool) -> bool {
    let presence = match tape.leaving {
        Some(leaving) => 1.0 - ease_out(progress(leaving, now, TAPE_LEAVE)),
        None => ease_out(progress(tape.shown, now, TAPE_ENTER)),
    };
    let fading = tape.leaving.is_some() || presence < 1.0;
    if out_of_sight(tape.target) {
        for strip in &mut tape.strips {
            strip.layer.hide();
        }
        tape.tag.hide();
        tape.hidden = true;
        tape.drawn = None;
        return fading;
    }
    let Some(frame) = frame_of(tape.target) else { return fading };
    if tape.hidden {
        tape.hidden = false;
    }
    let monitor = unsafe { MonitorFromWindow(tape.target, MONITOR_DEFAULTTONEAREST) };
    let scale = monitor_scale(monitor);
    let zoomed = unsafe { IsZoomed(tape.target) }.as_bool();

    // Avanza a saltos de 100 ms; quieta mientras espera o sin animaciones.
    if !moved && now >= tape.next_step {
        tape.next_step = now + STEP;
        if tape.pulse.is_some_and(|(_, until)| now >= until) {
            tape.pulse = None;
        }
        let speed = if tape.waiting || !tape.motion { 0.0 } else { tape.pulse.map_or(1.0, |(speed, _)| speed) };
        tape.phase = (tape.phase + speed * TAPE_ADVANCE * scale) % 100_000.0;
    }

    let drawn = Drawn { frame, zoomed, scale, phase: tape.phase, waiting: tape.waiting, label: tape.label.clone(), accent: *palette };
    let changed = tape.drawn.as_ref() != Some(&drawn);
    if changed {
        draw_tape(tape, &drawn, palette, fonts, monitor);
        tape.drawn = Some(drawn);
    }
    if changed || fading || moved {
        for strip in &mut tape.strips {
            let position = strip.layer.position;
            strip.layer.present(position, presence);
        }
        let position = tape.tag.position;
        tape.tag.present(position, presence);
    }
    restack(tape);
    fading
}

fn draw_tape(tape: &mut Cinta, drawn: &Drawn, palette: &Palette, fonts: &mut Fonts, monitor: HMONITOR) {
    let s = drawn.scale;
    let frame = drawn.frame;
    // Maximizada, la cinta va por dentro (por fuera quedaría fuera de la pantalla).
    let offset = if drawn.zoomed { -TAPE_OFFSET * s } else { TAPE_OFFSET * s };
    let corner = if drawn.zoomed { 6.0 * s } else { WINDOW_CORNER * s + offset };
    let track = Track {
        left: frame.left as f32 - offset,
        top: frame.top as f32 - offset,
        right: frame.right as f32 + offset,
        bottom: frame.bottom as f32 + offset,
        radius: corner,
    };
    let (line_half, keyline_half) = (2.5 * s, 4.0 * s);
    let tape_shape = Tape { track, dashes: Dashes::fit(track.length(), TAPE_PERIOD * s, 0.56), line_half, keyline_half, phase: drawn.phase };
    let line = if drawn.waiting { palette.idle } else { palette.accent };
    let band = keyline_half + 1.5;
    let radius = track.radius;
    let (left, top, right, bottom) = (track.left - band, track.top - band, track.right + band, track.bottom + band);
    // Arriba y abajo con sus esquinas; los lados, entre medias.
    let pieces = [
        (left, top, right, track.top + radius + band),
        (left, track.bottom - radius - band, right, bottom),
        (left, track.top + radius + band, track.left + band, track.bottom - radius - band),
        (track.right - band, track.top + radius + band, right, track.bottom - radius - band),
    ];
    for (strip, (x0, y0, x1, y1)) in tape.strips.iter_mut().zip(pieces) {
        let (x0, y0, x1, y1) = (x0.floor() as i32, y0.floor() as i32, x1.ceil() as i32, y1.ceil() as i32);
        if x1 <= x0 || y1 <= y0 || !strip.layer.ensure(x1 - x0, y1 - y0) {
            strip.layer.release_bitmap();
            strip.layer.hide();
            continue;
        }
        let (width, height) = ((x1 - x0) as usize, (y1 - y0) as usize);
        let fresh = !strip.field.as_ref().is_some_and(|field| field.fits(&tape_shape, (x0, y0), width, height, palette));
        if fresh {
            strip.field = Some(tape_shape.field((x0, y0), width, height, palette));
        }
        if let Some(field) = &strip.field {
            tape_shape.paint_field(field, &mut strip.layer.canvas(), line, fresh);
        }
        strip.layer.position = (x0, y0);
    }
    draw_tag(tape, &track, drawn, palette, fonts, monitor);
}

/// La etiqueta de campo: cuelga de la cinta por debajo, a la derecha.
fn draw_tag(tape: &mut Cinta, track: &Track, drawn: &Drawn, palette: &Palette, fonts: &mut Fonts, monitor: HMONITOR) {
    let s = drawn.scale;
    let dc = tape.tag.dc;
    let size = (12.0 * s).round() as i32;
    let bold = fonts.get(dc, size, 700);
    let regular = fonts.get(dc, size, 400);
    let lead = wide("trex");
    let text = wide(&format!(" · {}", drawn.label));
    let (pad_left, pad_right, pad_y) = ((22.0 * s).round() as i32, (10.0 * s).round() as i32, (4.0 * s).round() as i32);
    let string = (12.0 * s).round() as i32;
    // Medir solo cuando cambia lo que dice: en cada paso de la cinta no se toca.
    let same_text = tape.tag_look.as_ref().filter(|look| look.label == drawn.label && look.waiting == drawn.waiting && look.scale == s && look.palette == *palette);
    let (body_w, height) = match same_text {
        Some(look) => look.size,
        None => {
            let (lead_w, line_h) = measure(dc, bold, &lead);
            let (text_w, _) = measure(dc, regular, &text);
            (pad_left + lead_w + text_w + pad_right, string + line_h + 2 * pad_y + 1)
        }
    };
    let body_h = height - string - 1;
    let tape_y = track.bottom.round() as i32;
    let x = (track.right - 18.0 * s).round() as i32 - body_w;
    // Debajo de la ventana si cabe en el área de trabajo; si no, dentro, sobre la cinta.
    let mut info = MONITORINFO { cbSize: size_of::<MONITORINFO>() as u32, ..Default::default() };
    let work_bottom = if unsafe { GetMonitorInfoW(monitor, &mut info) }.as_bool() { info.rcWork.bottom } else { i32::MAX };
    let below = !drawn.zoomed && tape_y + height <= work_bottom;
    let y = if below { tape_y } else { tape_y - height };
    let look = TagLook { label: drawn.label.clone(), waiting: drawn.waiting, scale: s, palette: *palette, below, size: (body_w, height) };
    if tape.tag_look.as_ref() == Some(&look) && !tape.tag.bits.is_null() {
        tape.tag.position = (x, y);
        return;
    }
    tape.tag_look = Some(look);
    if !tape.tag.ensure(body_w, height) {
        tape.tag.release_bitmap();
        tape.tag.hide();
        return;
    }
    let body_top = if below { string } else { 0 };
    let body = [0.0, body_top as f32, body_w as f32, (body_top + body_h) as f32];
    let back = if drawn.waiting { palette.idle } else { palette.accent };
    let mut canvas = tape.tag.canvas();
    canvas.clear();
    canvas.fill_box(body, 0.0, back, 1.0);
    drop(canvas);
    write(dc, pad_left, body_top + pad_y, &[(bold, palette.ink, &lead), (regular, palette.ink, &text)]);
    let mut canvas = tape.tag.canvas();
    settle_label(&mut canvas, body, 7.0 * s, 1.0);
    let eyelet = ((11.0 * s).round() + 0.5, body_top as f32 + body_h as f32 / 2.0);
    let tape_local = if below { 0.0 } else { height as f32 };
    paint_segment(&mut canvas, (eyelet.0, tape_local), eyelet, 0.75 * s, palette.ink, 0.75);
    paint_disc(&mut canvas, eyelet, 3.5 * s, back.mix(Rgb(0, 0, 0), 0.4), 1.0);
    tape.tag.position = (x, y);
}
