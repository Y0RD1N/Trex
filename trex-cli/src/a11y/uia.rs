//! Motor de Windows: UI Automation desde un proceso sin ventana.
//!
//! - `AutoSetFocus` desactivado (IUIAutomation6): las acciones no traen la
//!   ventana al frente.
//! - Un snapshot es una sola llamada entre procesos (`BuildUpdatedCache` con el
//!   subárbol) y se recorre en memoria; las referencias apuntan a esos elementos.
//! - Las acciones usan los patrones de cada control (Invoke, Value, Toggle,
//!   ExpandCollapse, SelectionItem, Scroll, Window…), nunca ratón ni teclado, y
//!   se rechazan si la persona está usando esa misma ventana justo ahora, o si
//!   otro agente de Trex la está usando.
//! - Cada acción que puede cambiar la ventana dice qué apareció (elementos y
//!   ventanas nuevos, ya con referencia), y se marca en pantalla dónde actúa.
//! - Lo que podría quedarse esperando (un botón que abre un diálogo modal) corre
//!   en otro hilo: la respuesta llega igual a los 2,5 s.
use super::highlight::Highlighter;
use super::locks::Locks;
use super::{format_node, keys, lines, quote, Engine, Node, ToolError, ToolResult};
use serde_json::Value;
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::thread::sleep;
use std::time::{Duration, Instant};
use windows::core::{AgileReference, Interface, BOOL, BSTR, HSTRING, PCWSTR, PWSTR};
use windows::Win32::Foundation::{CloseHandle, E_ACCESSDENIED, HWND, LPARAM, WPARAM};
use windows::Win32::UI::HiDpi::{SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2};
use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED};
use windows::Win32::System::SystemInformation::GetTickCount;
use windows::Win32::System::Threading::{OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION};
use windows::Win32::UI::Accessibility::*;
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetLastInputInfo, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP, LASTINPUTINFO, VIRTUAL_KEY,
};
use windows::Win32::UI::Shell::{ShellExecuteExW, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumChildWindows, EnumWindows, GetClassNameW, GetForegroundWindow, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId, IsIconic,
    IsWindow, IsWindowVisible, IsZoomed, PostMessageW, SendMessageTimeoutW, BM_CLICK, SMTO_ABORTIFHUNG, SW_SHOWNOACTIVATE, WM_GETOBJECT,
};

/// Snapshots (y listas de cambios) cuyas referencias siguen valiendo.
const KEEP_SNAPSHOTS: usize = 8;
/// Elementos nuevos que se listan tras una acción, y de cada ventana nueva.
const CHANGE_LINES: usize = 40;
const NEW_WINDOW_LINES: usize = 25;
/// Un atajo de teclado solo si la persona lleva este tiempo sin tocar nada.
const KEYBOARD_IDLE_MS: u32 = 3_000;
/// Si la persona usó ratón o teclado hace menos de esto en la ventana destino, no se actúa.
const USER_ACTIVE_MS: u32 = 2_000;
/// Lo más que se lee de un valor o del texto de un documento.
const MAX_TEXT: i32 = 20_000;

const TREE_PROPERTIES: [UIA_PROPERTY_ID; 25] = [
    UIA_ControlTypePropertyId, UIA_NamePropertyId, UIA_IsEnabledPropertyId, UIA_IsOffscreenPropertyId,
    UIA_HasKeyboardFocusPropertyId, UIA_IsKeyboardFocusablePropertyId, UIA_IsPasswordPropertyId,
    UIA_NativeWindowHandlePropertyId, UIA_IsInvokePatternAvailablePropertyId, UIA_IsValuePatternAvailablePropertyId,
    UIA_IsTogglePatternAvailablePropertyId, UIA_IsExpandCollapsePatternAvailablePropertyId,
    UIA_IsSelectionItemPatternAvailablePropertyId, UIA_IsScrollPatternAvailablePropertyId,
    UIA_IsScrollItemPatternAvailablePropertyId, UIA_IsRangeValuePatternAvailablePropertyId,
    UIA_IsTextPatternAvailablePropertyId, UIA_IsLegacyIAccessiblePatternAvailablePropertyId, UIA_ValueValuePropertyId,
    UIA_ValueIsReadOnlyPropertyId, UIA_ToggleToggleStatePropertyId, UIA_ExpandCollapseExpandCollapseStatePropertyId,
    UIA_SelectionItemIsSelectedPropertyId, UIA_RangeValueValuePropertyId, UIA_LegacyIAccessibleDefaultActionPropertyId,
];

fn role(kind: UIA_CONTROLTYPE_ID) -> &'static str {
    const ROLES: [(UIA_CONTROLTYPE_ID, &str); 41] = [
        (UIA_ButtonControlTypeId, "button"), (UIA_CalendarControlTypeId, "calendar"), (UIA_CheckBoxControlTypeId, "checkbox"),
        (UIA_ComboBoxControlTypeId, "combobox"), (UIA_EditControlTypeId, "edit"), (UIA_HyperlinkControlTypeId, "hyperlink"),
        (UIA_ImageControlTypeId, "image"), (UIA_ListItemControlTypeId, "listitem"), (UIA_ListControlTypeId, "list"),
        (UIA_MenuControlTypeId, "menu"), (UIA_MenuBarControlTypeId, "menubar"), (UIA_MenuItemControlTypeId, "menuitem"),
        (UIA_ProgressBarControlTypeId, "progressbar"), (UIA_RadioButtonControlTypeId, "radiobutton"),
        (UIA_ScrollBarControlTypeId, "scrollbar"), (UIA_SliderControlTypeId, "slider"), (UIA_SpinnerControlTypeId, "spinner"),
        (UIA_StatusBarControlTypeId, "statusbar"), (UIA_TabControlTypeId, "tab"), (UIA_TabItemControlTypeId, "tabitem"),
        (UIA_TextControlTypeId, "text"), (UIA_ToolBarControlTypeId, "toolbar"), (UIA_ToolTipControlTypeId, "tooltip"),
        (UIA_TreeControlTypeId, "tree"), (UIA_TreeItemControlTypeId, "treeitem"), (UIA_CustomControlTypeId, "custom"),
        (UIA_GroupControlTypeId, "group"), (UIA_ThumbControlTypeId, "thumb"), (UIA_DataGridControlTypeId, "datagrid"),
        (UIA_DataItemControlTypeId, "dataitem"), (UIA_DocumentControlTypeId, "document"),
        (UIA_SplitButtonControlTypeId, "splitbutton"), (UIA_WindowControlTypeId, "window"), (UIA_PaneControlTypeId, "pane"),
        (UIA_HeaderControlTypeId, "header"), (UIA_HeaderItemControlTypeId, "headeritem"), (UIA_TableControlTypeId, "table"),
        (UIA_TitleBarControlTypeId, "titlebar"), (UIA_SeparatorControlTypeId, "separator"),
        (UIA_SemanticZoomControlTypeId, "semanticzoom"), (UIA_AppBarControlTypeId, "appbar"),
    ];
    ROLES.iter().find(|(id, _)| *id == kind).map_or("element", |(_, name)| name)
}

/// Error de UI Automation para el agente.
fn failure(error: windows::core::Error) -> ToolError {
    match error.code().0 as u32 {
        UIA_E_ELEMENTNOTAVAILABLE => ToolError::new("STALE_REF", "The element no longer exists. Take a new snapshot."),
        UIA_E_ELEMENTNOTENABLED => ToolError::new("DISABLED", "The element is disabled."),
        UIA_E_TIMEOUT => ToolError::new("UNCERTAIN", "The application did not answer in time; it may still be processing (for example, a dialog opened). Take a snapshot before retrying."),
        code if code == E_ACCESSDENIED.0 as u32 => ToolError::new("ACCESS_DENIED", "Windows denied access; the application may run as administrator."),
        _ => ToolError::new("ACTION_FAILED", error.message()),
    }
}

/// Momento (en ticks) de la última entrada de ratón o teclado del sistema.
fn last_input_tick() -> Option<u32> {
    let mut info = LASTINPUTINFO { cbSize: size_of::<LASTINPUTINFO>() as u32, dwTime: 0 };
    unsafe { GetLastInputInfo(&mut info) }.as_bool().then_some(info.dwTime)
}

/// Milisegundos desde la última entrada de la persona. Si la última fue un atajo
/// que envió Trex (entre `own.0` y `own.1`), la de la persona es anterior.
pub(super) fn user_idle(now: u32, last: Option<u32>, own: Option<(u32, u32)>) -> u32 {
    let Some(last) = last else { return u32::MAX };
    match own {
        Some((from, until)) if last.wrapping_sub(from) <= until.wrapping_sub(from).wrapping_add(100) => now.wrapping_sub(from),
        _ => now.wrapping_sub(last),
    }
}

fn same_process(first: isize, second: isize) -> bool {
    let pid = |window: isize| {
        let mut pid = 0u32;
        unsafe { GetWindowThreadProcessId(HWND(window as _), Some(&mut pid)) };
        pid
    };
    first != 0 && second != 0 && pid(first) == pid(second)
}

fn foreground() -> isize {
    unsafe { GetForegroundWindow() }.0 as isize
}

/// La persona está usando la ventana destino ahora mismo.
pub(super) fn user_active(foreground: isize, window: isize, idle: u32) -> bool {
    window != 0 && foreground == window && idle < USER_ACTIVE_MS
}

fn cached(element: &IUIAutomationElement, id: UIA_PROPERTY_ID) -> Option<windows::Win32::System::Variant::VARIANT> {
    unsafe { element.GetCachedPropertyValue(id) }.ok()
}
fn cached_bool(element: &IUIAutomationElement, id: UIA_PROPERTY_ID) -> bool {
    cached(element, id).and_then(|value| bool::try_from(&value).ok()).unwrap_or(false)
}
fn cached_i32(element: &IUIAutomationElement, id: UIA_PROPERTY_ID) -> Option<i32> {
    cached(element, id).and_then(|value| i32::try_from(&value).ok())
}
fn cached_text(element: &IUIAutomationElement, id: UIA_PROPERTY_ID) -> Option<String> {
    cached(element, id).and_then(|value| BSTR::try_from(&value).ok()).map(|text| text.to_string())
}

fn pattern<T: Interface>(element: &IUIAutomationElement, id: UIA_PATTERN_ID) -> Option<T> {
    unsafe { element.GetCurrentPatternAs::<T>(id) }.ok()
}

/// Lo que se sabe de un elemento ya cacheado, y si se le da referencia.
struct Described {
    node: Node,
    referenced: bool,
}

fn describe(element: &IUIAutomationElement) -> Described {
    let kind = unsafe { element.CachedControlType() }.unwrap_or(UIA_CustomControlTypeId);
    let role = role(kind);
    let name = unsafe { element.CachedName() }.map(|name| name.to_string()).unwrap_or_default();
    let password = cached_bool(element, UIA_IsPasswordPropertyId);
    let has = |id| cached_bool(element, id);
    let (invoke, value, toggle, expand, select) = (has(UIA_IsInvokePatternAvailablePropertyId), has(UIA_IsValuePatternAvailablePropertyId),
        has(UIA_IsTogglePatternAvailablePropertyId), has(UIA_IsExpandCollapsePatternAvailablePropertyId), has(UIA_IsSelectionItemPatternAvailablePropertyId));
    let (scroll, scroll_item, range) = (has(UIA_IsScrollPatternAvailablePropertyId), has(UIA_IsScrollItemPatternAvailablePropertyId), has(UIA_IsRangeValuePatternAvailablePropertyId));
    let legacy = has(UIA_IsLegacyIAccessiblePatternAvailablePropertyId)
        && cached_text(element, UIA_LegacyIAccessibleDefaultActionPropertyId).is_some_and(|action| !action.trim().is_empty());
    let read_only = has(UIA_ValueIsReadOnlyPropertyId);
    let offscreen = has(UIA_IsOffscreenPropertyId);
    let focused = has(UIA_HasKeyboardFocusPropertyId);
    // En un contenedor, «tiene el foco» (porque lo tiene un hijo) o «fuera de
    // pantalla» (un menú emergente) son ruido: lo que importa es el control.
    let container = matches!(role, "window" | "pane" | "group" | "menu" | "menubar" | "list" | "tree" | "toolbar" | "tab" | "table" | "datagrid"
        | "header" | "statusbar" | "titlebar" | "appbar");
    let focused = focused && !container;
    let offscreen = offscreen && !container;
    let mut states = Vec::new();
    if !has(UIA_IsEnabledPropertyId) {
        states.push("disabled");
    }
    if focused {
        states.push("focused");
    }
    if offscreen {
        states.push("offscreen");
    }
    if password {
        states.push("password");
    }
    if toggle {
        states.push(match cached_i32(element, UIA_ToggleToggleStatePropertyId) {
            Some(1) => "checked",
            Some(2) => "mixed",
            _ => "unchecked",
        });
    }
    let expanded = cached_i32(element, UIA_ExpandCollapseExpandCollapseStatePropertyId);
    if expand {
        match expanded {
            Some(0) => states.push("collapsed"),
            Some(1 | 2) => states.push("expanded"),
            _ => {}
        }
    }
    if select && has(UIA_SelectionItemIsSelectedPropertyId) {
        states.push("selected");
    }
    if value && read_only {
        states.push("readonly");
    }
    let mut actions = Vec::new();
    if invoke || (legacy && !toggle && !select && !expand) {
        actions.push("click");
    }
    if toggle {
        actions.push("toggle");
    }
    if expand && expanded != Some(3) {
        actions.push(if expanded == Some(0) { "expand" } else { "collapse" });
    }
    if select {
        actions.push("select");
    }
    if (value && !read_only && !password) || range {
        actions.push("set_value");
    }
    if value && !read_only && !password {
        actions.push("type");
    }
    if scroll {
        actions.push("scroll");
    }
    if scroll_item && offscreen {
        actions.push("scroll_to");
    }
    let value_text = if password {
        None
    } else if value {
        cached_text(element, UIA_ValueValuePropertyId).filter(|text| !text.is_empty() && text != &name)
    } else if range {
        cached(element, UIA_RangeValueValuePropertyId).and_then(|value| f64::try_from(&value).ok()).map(|number| number.to_string())
    } else {
        None
    };
    let editable = matches!(role, "edit" | "document") && has(UIA_IsKeyboardFocusablePropertyId);
    Described {
        referenced: !actions.is_empty() || editable || focused,
        node: Node { depth: 0, reference: None, role, name, value: value_text, states, actions },
    }
}

fn class_name(window: isize) -> String {
    let mut buffer = [0u16; 256];
    let length = unsafe { GetClassNameW(HWND(window as _), &mut buffer) };
    String::from_utf16_lossy(&buffer[..length.max(0) as usize])
}

/// Ventanas de contenido de Chromium y Electron dentro de una ventana.
fn render_hosts(window: isize) -> Vec<isize> {
    unsafe extern "system" fn collect(hwnd: HWND, list: LPARAM) -> BOOL {
        unsafe { (*(list.0 as *mut Vec<isize>)).push(hwnd.0 as isize) };
        true.into()
    }
    let mut children: Vec<isize> = Vec::new();
    unsafe {
        let _ = EnumChildWindows(Some(HWND(window as _)), Some(collect), LPARAM(&mut children as *mut Vec<isize> as isize));
    }
    children.into_iter().filter(|child| class_name(*child) == "Chrome_RenderWidgetHostHWND").collect()
}

enum Outcome {
    Done(&'static str),
    Unsupported,
    /// Sigue en curso (p. ej. un botón que abrió un diálogo modal y espera a que se cierre).
    Pending,
}

/// Corre una acción en otro hilo y espera como mucho 2,5 s: la llamada de UI
/// Automation puede quedarse esperando a la aplicación.
fn bounded(element: &IUIAutomationElement, action: fn(&IUIAutomationElement) -> windows::core::Result<Option<&'static str>>) -> Result<Outcome, ToolError> {
    let agile = AgileReference::new(element).map_err(failure)?;
    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        }
        let _ = sender.send(agile.resolve().and_then(|element| action(&element)));
    });
    match receiver.recv_timeout(Duration::from_millis(2_500)) {
        Ok(Ok(Some(method))) => Ok(Outcome::Done(method)),
        Ok(Ok(None)) => Ok(Outcome::Unsupported),
        Ok(Err(error)) => Err(failure(error)),
        Err(_) => Ok(Outcome::Pending),
    }
}

/// Botón clásico (Win32 o WinForms): su propia ventana, de clase BUTTON.
fn classic_button(element: &IUIAutomationElement) -> Option<HWND> {
    let handle = unsafe { element.CurrentNativeWindowHandle() }.ok().filter(|handle| !handle.is_invalid())?;
    let kind = unsafe { element.CurrentControlType() }.ok()?;
    (kind == UIA_ButtonControlTypeId && class_name(handle.0 as isize).to_ascii_uppercase().contains("BUTTON")).then_some(handle)
}

/// Lo que haría un clic, con el primer patrón que tenga el elemento.
fn activate(element: &IUIAutomationElement) -> windows::core::Result<Option<&'static str>> {
    unsafe {
        // Un botón clásico recibe el clic como mensaje encolado, igual que el de un
        // ratón: si abre un diálogo modal, la aplicación sigue atendiendo a UI
        // Automation (con Invoke se quedaba esperando a que se cerrara el diálogo).
        if let Some(button) = classic_button(element) {
            PostMessageW(Some(button), BM_CLICK, WPARAM(0), LPARAM(0))?;
            return Ok(Some("button message"));
        }
        if let Some(pattern) = pattern::<IUIAutomationInvokePattern>(element, UIA_InvokePatternId) {
            pattern.Invoke()?;
            Ok(Some("invoked"))
        } else if let Some(pattern) = pattern::<IUIAutomationTogglePattern>(element, UIA_TogglePatternId) {
            pattern.Toggle()?;
            Ok(Some("toggled"))
        } else if let Some(pattern) = pattern::<IUIAutomationSelectionItemPattern>(element, UIA_SelectionItemPatternId) {
            pattern.Select()?;
            Ok(Some("selected"))
        } else if let Some(pattern) = pattern::<IUIAutomationExpandCollapsePattern>(element, UIA_ExpandCollapsePatternId) {
            if pattern.CurrentExpandCollapseState()? == ExpandCollapseState_Collapsed {
                pattern.Expand()?;
                Ok(Some("expanded"))
            } else {
                pattern.Collapse()?;
                Ok(Some("collapsed"))
            }
        } else if let Some(pattern) = pattern::<IUIAutomationLegacyIAccessiblePattern>(element, UIA_LegacyIAccessiblePatternId) {
            pattern.DoDefaultAction()?;
            Ok(Some("default action"))
        } else {
            Ok(None)
        }
    }
}

fn context_menu(element: &IUIAutomationElement) -> windows::core::Result<Option<&'static str>> {
    let Ok(element) = element.cast::<IUIAutomationElement3>() else { return Ok(None) };
    unsafe { element.ShowContextMenu() }?;
    Ok(Some("context menu"))
}

fn open_element(element: &IUIAutomationElement) -> windows::core::Result<Option<&'static str>> {
    let Some(pattern) = pattern::<IUIAutomationExpandCollapsePattern>(element, UIA_ExpandCollapsePatternId) else { return Ok(None) };
    unsafe { pattern.Expand() }?;
    Ok(Some("expanded"))
}

fn close_element(element: &IUIAutomationElement) -> windows::core::Result<Option<&'static str>> {
    let Some(pattern) = pattern::<IUIAutomationExpandCollapsePattern>(element, UIA_ExpandCollapsePatternId) else { return Ok(None) };
    unsafe { pattern.Collapse() }?;
    Ok(Some("collapsed"))
}

/// Pulsa y suelta una combinación con el teclado real (modificadores primero).
fn send_combo(combo: &keys::Combo) {
    let key = |code: u16, up: bool| INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT { wVk: VIRTUAL_KEY(code), wScan: 0, dwFlags: if up { KEYEVENTF_KEYUP } else { KEYBD_EVENT_FLAGS(0) }, time: 0, dwExtraInfo: 0 },
        },
    };
    let mut inputs: Vec<INPUT> = combo.modifiers.iter().map(|code| key(*code, false)).collect();
    inputs.push(key(combo.key, false));
    inputs.push(key(combo.key, true));
    inputs.extend(combo.modifiers.iter().rev().map(|code| key(*code, true)));
    unsafe {
        SendInput(&inputs, size_of::<INPUT>() as i32);
    }
}

/// Lo que había antes de una acción, para decir después qué cambió.
struct Before {
    window: isize,
    keys: HashMap<String, usize>,
    windows: HashSet<isize>,
}

#[derive(Clone)]
struct Target {
    element: IUIAutomationElement,
    window: isize,
}

struct WindowInfo {
    hwnd: isize,
    title: String,
    app: String,
    state: Option<i32>,
}

/// Ventanas de primer nivel visibles, con la API clásica (milisegundos, frente
/// a cientos con UI Automation). Sin las ocultas por el sistema (cloaked).
fn top_windows() -> Vec<(isize, String, u32, i32)> {
    unsafe extern "system" fn collect(hwnd: HWND, list: LPARAM) -> BOOL {
        unsafe { (*(list.0 as *mut Vec<isize>)).push(hwnd.0 as isize) };
        true.into()
    }
    let mut handles: Vec<isize> = Vec::new();
    unsafe {
        let _ = EnumWindows(Some(collect), LPARAM(&mut handles as *mut Vec<isize> as isize));
    }
    handles.into_iter().filter_map(window_facts).collect()
}

/// Título, proceso y estado de una ventana visible con título; None si no lo es.
fn window_facts(handle: isize) -> Option<(isize, String, u32, i32)> {
    let hwnd = HWND(handle as _);
    unsafe {
        if !IsWindow(Some(hwnd)).as_bool() || !IsWindowVisible(hwnd).as_bool() {
            return None;
        }
        let mut cloaked = 0u32;
        if DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, &mut cloaked as *mut u32 as *mut _, size_of::<u32>() as u32).is_ok() && cloaked != 0 {
            return None;
        }
        let length = GetWindowTextLengthW(hwnd);
        if length <= 0 {
            return None;
        }
        let mut buffer = vec![0u16; length as usize + 1];
        let copied = GetWindowTextW(hwnd, &mut buffer);
        let title = String::from_utf16_lossy(&buffer[..copied.max(0) as usize]);
        if title.trim().is_empty() {
            return None;
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        let state = if IsIconic(hwnd).as_bool() { 2 } else if IsZoomed(hwnd).as_bool() { 1 } else { 0 };
        Some((handle, title, pid, state))
    }
}
impl WindowInfo {
    fn line(&self, foreground: isize) -> String {
        let mut line = format!("w{:X} {} {}", self.hwnd, self.app, quote(&self.title, 100));
        match self.state {
            Some(1) => line.push_str(" maximized"),
            Some(2) => line.push_str(" minimized"),
            _ => {}
        }
        if self.hwnd == foreground {
            line.push_str(" foreground");
        }
        line
    }
}

pub struct UiaEngine {
    automation: IUIAutomation,
    view: IUIAutomationCondition,
    walker: IUIAutomationTreeWalker,
    /// Subárbol completo (snapshot).
    tree: IUIAutomationCacheRequest,
    /// Un elemento (find, get).
    single: IUIAutomationCacheRequest,
    keeps_focus: bool,
    refs: HashMap<String, Target>,
    kept: VecDeque<u32>,
    next: u32,
    process_names: HashMap<u32, String>,
    /// Atajos de teclado permitidos en Ajustes.
    keyboard: bool,
    locks: Locks,
    highlighter: Option<Highlighter>,
    highlight_started: bool,
    /// Ventanas de Chromium/Electron a las que ya se pidió el árbol.
    woken: HashSet<isize>,
    /// Último atajo enviado por Trex (ticks de inicio y fin), para no tomarlo por la persona.
    own_input: Option<(u32, u32)>,
}

impl UiaEngine {
    pub fn new(keyboard: bool) -> anyhow::Result<Self> {
        unsafe {
            // Coordenadas físicas en todas las pantallas: el resaltado coincide con el elemento.
            let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
            // S_FALSE (ya iniciado) también vale.
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            let automation: IUIAutomation = CoCreateInstance(&CUIAutomation8, None, CLSCTX_INPROC_SERVER)?;
            let keeps_focus = automation.cast::<IUIAutomation6>().and_then(|six| six.SetAutoSetFocus(false)).is_ok();
            if let Ok(two) = automation.cast::<IUIAutomation2>() {
                let _ = two.SetConnectionTimeout(3_000);
                let _ = two.SetTransactionTimeout(6_000);
            }
            let view = automation.ControlViewCondition()?;
            let walker = automation.ControlViewWalker()?;
            let tree = automation.CreateCacheRequest()?;
            let single = automation.CreateCacheRequest()?;
            for id in TREE_PROPERTIES {
                tree.AddProperty(id)?;
                single.AddProperty(id)?;
            }
            tree.SetTreeScope(TreeScope_Subtree)?;
            tree.SetTreeFilter(&view)?;
            Ok(Self { automation, view, walker, tree, single, keeps_focus, refs: HashMap::new(), kept: VecDeque::new(), next: 0, process_names: HashMap::new(),
                keyboard, locks: Locks::default(), highlighter: None, highlight_started: false, woken: HashSet::new(), own_input: None })
        }
    }

    fn begin_snapshot(&mut self) -> u32 {
        self.next += 1;
        self.kept.push_back(self.next);
        while self.kept.len() > KEEP_SNAPSHOTS {
            if let Some(old) = self.kept.pop_front() {
                let prefix = format!("@s{old}:");
                self.refs.retain(|reference, _| !reference.starts_with(&prefix));
            }
        }
        self.next
    }

    fn target(&self, args: &Value) -> Result<Target, ToolError> {
        let reference = args["ref_id"].as_str().ok_or_else(|| ToolError::new("INVALID_ARGS", "ref_id is required."))?;
        self.refs.get(reference).cloned().ok_or_else(|| ToolError::new("STALE_REF", format!("Unknown or expired ref {reference}. Take a new snapshot.")))
    }

    fn process_name(&mut self, pid: u32) -> String {
        if let Some(name) = self.process_names.get(&pid) {
            return name.clone();
        }
        let name = unsafe {
            OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok().and_then(|handle| {
                let mut buffer = [0u16; 1024];
                let mut size = buffer.len() as u32;
                let path = QueryFullProcessImageNameW(handle, PROCESS_NAME_WIN32, PWSTR(buffer.as_mut_ptr()), &mut size)
                    .ok()
                    .map(|()| String::from_utf16_lossy(&buffer[..size as usize]));
                let _ = CloseHandle(handle);
                path
            })
        }
        .and_then(|path| path.rsplit(['\\', '/']).next().map(str::to_lowercase))
        .unwrap_or_else(|| format!("pid{pid}"));
        self.process_names.insert(pid, name.clone());
        name
    }

    fn info(&mut self, (hwnd, title, pid, state): (isize, String, u32, i32)) -> WindowInfo {
        let app = self.process_name(pid);
        WindowInfo { hwnd, title, app, state: Some(state) }
    }

    fn windows(&mut self) -> Result<Vec<WindowInfo>, ToolError> {
        Ok(top_windows().into_iter().map(|facts| self.info(facts)).collect())
    }

    /// El elemento de UI Automation de una ventana.
    fn element(&self, window: &WindowInfo) -> Result<IUIAutomationElement, ToolError> {
        unsafe { self.automation.ElementFromHandle(HWND(window.hwnd as _)) }.map_err(failure)
    }

    /// Ventana por `window_id` o por `app` (proceso o parte del título, si solo coincide una).
    fn resolve_window(&mut self, args: &Value) -> Result<WindowInfo, ToolError> {
        if let Some(id) = args["window_id"].as_str() {
            let hwnd = isize::from_str_radix(id.trim_start_matches(['w', 'W']), 16)
                .map_err(|_| ToolError::new("INVALID_ARGS", format!("Invalid window_id {id}.")))?;
            return window_facts(hwnd).map(|facts| self.info(facts))
                .ok_or_else(|| ToolError::new("NOT_FOUND", format!("Window {id} is no longer open. Use a11y_list_windows.")));
        }
        let windows = self.windows()?;
        let Some(app) = args["app"].as_str().map(str::to_lowercase).filter(|app| !app.trim().is_empty()) else {
            return Err(ToolError::new("INVALID_ARGS", "Pass window_id or app (see a11y_list_windows)."));
        };
        let bare = app.trim_end_matches(".exe").to_owned();
        let matches: Vec<_> = windows
            .into_iter()
            .filter(|window| window.app.trim_end_matches(".exe") == bare || window.title.to_lowercase().contains(&app))
            .collect();
        match matches.len() {
            0 => Err(ToolError::new("NOT_FOUND", format!("No open window matches {app}. Use a11y_list_windows or a11y_launch."))),
            1 => Ok(matches.into_iter().next().unwrap()),
            _ => {
                let foreground = foreground();
                let list = matches.iter().take(8).map(|window| window.line(foreground)).collect::<Vec<_>>().join("\n");
                Err(ToolError::new("AMBIGUOUS", format!("Several windows match {app}; pass window_id:\n{list}")))
            }
        }
    }

    /// No actuar sobre la ventana que la persona está usando ahora mismo, ni
    /// sobre la que usa otro agente de Trex.
    fn guard(&mut self, window: isize) -> Result<isize, ToolError> {
        let (front, idle) = (foreground(), self.idle_ms());
        if user_active(front, window, idle) {
            return Err(ToolError::new("USER_ACTIVE", format!(
                "The user is working in this window right now (last input {idle} ms ago). Nothing was done; wait a few seconds with a11y_wait and retry.")));
        }
        self.claim(window)?;
        Ok(front)
    }

    fn idle_ms(&self) -> u32 {
        user_idle(unsafe { GetTickCount() }, last_input_tick(), self.own_input)
    }

    /// Tras una acción: si la aplicación activó una de sus ventanas (un diálogo)
    /// y la persona no tocó nada mientras, el foco vuelve a la ventana que usaba.
    fn settle_focus(&self, user_window: isize, target: isize, started: Instant) -> String {
        let now = foreground();
        if now == user_window || now == 0 {
            return String::new();
        }
        let app_took_it = !same_process(user_window, target) && same_process(now, target)
            && u128::from(self.idle_ms()) >= started.elapsed().as_millis();
        if !app_took_it {
            return if now == target { " Note: the window came to the front.".into() } else { String::new() };
        }
        if self.restore_focus(user_window) {
            " The application activated one of its windows; the focus went back to the user's window.".into()
        } else {
            format!(" Note: the application activated w{now:X} and kept the focus.")
        }
    }

    fn claim(&mut self, window: isize) -> Result<(), ToolError> {
        self.locks.claim(window).map_err(|owner| ToolError::new("WINDOW_BUSY", format!(
            "Another Trex agent (process {owner}) is working in this window. Nothing was done; use another window or try again in a minute.")))
    }

    /// Marca en pantalla dónde se va a actuar, si el elemento se ve.
    fn mark(&mut self, element: &IUIAutomationElement, label: &str) {
        if !self.highlight_started {
            self.highlight_started = true;
            self.highlighter = Highlighter::start();
        }
        let Some(highlighter) = &self.highlighter else { return };
        if unsafe { element.CurrentIsOffscreen() }.map(|value| value.as_bool()).unwrap_or(true) {
            return;
        }
        if let Ok(rect) = unsafe { element.CurrentBoundingRectangle() } {
            highlighter.show(rect, label);
        }
    }

    /// Chromium y Electron solo construyen su árbol de accesibilidad cuando un
    /// cliente lo pide: se lo pedimos una vez por ventana. true si se acaba de pedir.
    fn wake_chromium(&mut self, window: isize) -> bool {
        if !self.woken.insert(window) || !class_name(window).starts_with("Chrome_WidgetWin") {
            return false;
        }
        for host in render_hosts(window) {
            // OBJID_CLIENT y UiaRootObjectId.
            for object in [-4isize, -25] {
                unsafe {
                    SendMessageTimeoutW(HWND(host as _), WM_GETOBJECT, WPARAM(0), LPARAM(object), SMTO_ABORTIFHUNG, 500, None);
                }
            }
        }
        true
    }

    /// Recorre una ventana o un elemento con una sola llamada entre procesos.
    fn walk(&mut self, root: &IUIAutomationElement, window: isize, interactive_only: bool, max_depth: usize, max_elements: usize) -> Result<Walk, ToolError> {
        if self.wake_chromium(window) {
            // Chromium construye el árbol de la página al primer pedido y tarda un
            // momento: se pide, se espera y se lee de nuevo (solo la primera vez).
            let _ = unsafe { root.BuildUpdatedCache(&self.tree) };
            sleep(Duration::from_millis(1_200));
        }
        let cached = unsafe { root.BuildUpdatedCache(&self.tree) }.map_err(failure)?;
        let mut walk = Walk { interactive_only, max_depth, max_elements, entries: Vec::new(), truncated: false };
        walk.children(&cached, 0, 0, "");
        Ok(walk)
    }

    /// Da referencia a lo que tiene acciones y lo convierte en líneas.
    fn render(&mut self, entries: Vec<Entry>, window: isize, id: u32, base_depth: usize, counter: &mut usize) -> Vec<String> {
        let mut lines = Vec::new();
        for entry in entries {
            *counter += 1;
            let mut node = entry.node;
            node.depth = node.depth.saturating_sub(base_depth);
            if entry.referenced {
                let reference = format!("@s{id}:e{counter}");
                node.reference = Some(reference.clone());
                self.refs.insert(reference, Target { element: entry.element, window });
            }
            lines.push(format_node(&node));
        }
        lines
    }

    fn before(&mut self, window: isize) -> Before {
        let keys = unsafe { self.automation.ElementFromHandle(HWND(window as _)) }
            .ok()
            .and_then(|root| self.walk(&root, window, true, 25, 600).ok())
            .map(|walk| {
                let mut keys = HashMap::new();
                for entry in walk.entries {
                    *keys.entry(entry.key).or_insert(0) += 1;
                }
                keys
            })
            .unwrap_or_default();
        Before { window, keys, windows: top_windows().into_iter().map(|facts| facts.0).collect() }
    }

    /// Ventanas que no estaban, con sus elementos (y referencias). Tras una
    /// acción se omiten las del propio Windows (avisos y ventanas emergentes del shell).
    fn new_windows(&mut self, known: &HashSet<isize>, slot: &mut Option<u32>, counter: &mut usize) -> String {
        const SHELL: [&str; 6] = ["explorer.exe", "shellexperiencehost.exe", "searchhost.exe", "textinputhost.exe", "startmenuexperiencehost.exe", "lockapp.exe"];
        let front = foreground();
        let mut text = String::new();
        let fresh: Vec<_> = top_windows().into_iter().filter(|facts| !known.contains(&facts.0)).collect();
        let mut shown = 0;
        for facts in fresh {
            if shown == 3 {
                break;
            }
            let info = self.info(facts);
            if SHELL.contains(&info.app.as_str()) || info.title == "PopupHost" {
                continue;
            }
            shown += 1;
            text.push_str(&format!("\nNew window {}", info.line(front)));
            let Ok(root) = self.element(&info) else { continue };
            let Ok(walk) = self.walk(&root, info.hwnd, true, 25, NEW_WINDOW_LINES) else { continue };
            if walk.entries.is_empty() {
                continue;
            }
            let id = *slot.get_or_insert_with(|| self.begin_snapshot());
            let lines = self.render(walk.entries, info.hwnd, id, 0, counter);
            text.push_str(&format!(" (snapshot s{id}):\n{}", lines.join("\n")));
        }
        text
    }

    /// Qué cambió tras una acción: elementos nuevos de la ventana y ventanas nuevas.
    fn changes(&mut self, before: Before) -> String {
        sleep(Duration::from_millis(250));
        let mut slot = None;
        let mut counter = 0;
        let mut text = String::new();
        if window_facts(before.window).is_none() {
            text.push_str("\nThe window closed.");
        } else if let Ok(root) = unsafe { self.automation.ElementFromHandle(HWND(before.window as _)) } {
            if let Ok(walk) = self.walk(&root, before.window, true, 25, 600) {
                let mut remaining = before.keys;
                let fresh: Vec<Entry> = walk
                    .entries
                    .into_iter()
                    .filter(|entry| match remaining.get_mut(&entry.key) {
                        Some(count) if *count > 0 => {
                            *count -= 1;
                            false
                        }
                        _ => true,
                    })
                    .collect();
                let gone: usize = remaining.values().sum();
                if !fresh.is_empty() {
                    let total = fresh.len();
                    let base = fresh.iter().map(|entry| entry.node.depth).min().unwrap_or(0);
                    let id = *slot.get_or_insert_with(|| self.begin_snapshot());
                    let lines = self.render(fresh.into_iter().take(CHANGE_LINES).collect(), before.window, id, base, &mut counter);
                    let more = if total > CHANGE_LINES { format!(", first {CHANGE_LINES} of {total}") } else { String::new() };
                    text.push_str(&format!("\nNew in the window (snapshot s{id}{more}):\n{}", lines.join("\n")));
                } else if gone == 0 {
                    text.push_str("\nNo visible change in the window.");
                }
                if gone > 0 {
                    text.push_str(&format!("\n{gone} elements disappeared."));
                }
            }
        }
        text + &self.new_windows(&before.windows, &mut slot, &mut counter)
    }

    /// Devuelve el foco a la ventana que tenía la persona. true si lo consiguió.
    fn restore_focus(&self, window: isize) -> bool {
        if window == 0 || window_facts(window).is_none() {
            return false;
        }
        if let Ok(element) = unsafe { self.automation.ElementFromHandle(HWND(window as _)) } {
            let _ = unsafe { element.SetFocus() };
        }
        let deadline = Instant::now() + Duration::from_millis(500);
        while foreground() != window && Instant::now() < deadline {
            sleep(Duration::from_millis(20));
        }
        foreground() == window
    }

    fn focus_note(before: isize, window: isize) -> String {
        let after = foreground();
        if after == before || after == 0 {
            String::new()
        } else if after == window {
            " Note: the window came to the front.".into()
        } else {
            format!(" Note: the foreground window changed to w{after:X} (the application may have activated a dialog).")
        }
    }

    // --- Lectura -------------------------------------------------------------------

    fn list_windows(&mut self, args: &Value) -> ToolResult {
        let filter = args["app"].as_str().map(str::to_lowercase).filter(|text| !text.is_empty());
        let front = foreground();
        let lines: Vec<String> = self
            .windows()?
            .iter()
            .filter(|window| filter.as_ref().is_none_or(|text| window.app.contains(text.trim_end_matches(".exe")) || window.title.to_lowercase().contains(text)))
            .map(|window| window.line(front))
            .collect();
        Ok(if lines.is_empty() { "No matching windows.".into() } else { format!("{} windows (id app \"title\" state):\n{}", lines.len(), lines.join("\n")) })
    }

    fn snapshot(&mut self, args: &Value) -> ToolResult {
        let interactive_only = args["interactive_only"].as_bool().unwrap_or(true);
        let max_depth = args["max_depth"].as_u64().unwrap_or(25).min(60) as usize;
        let max_elements = args["max_elements"].as_u64().unwrap_or(300).clamp(1, 1000) as usize;
        let (root, window, header) = if args["root"].is_string() {
            let target = self.target(&json_ref(&args["root"]))?;
            (target.element, target.window, format!("subtree of {}", args["root"].as_str().unwrap_or("")))
        } else {
            let info = self.resolve_window(args)?;
            let header = format!("window w{:X} {} ({})", info.hwnd, quote(&info.title, 100), info.app);
            (self.element(&info)?, info.hwnd, header)
        };
        let started = Instant::now();
        let mut walk = self.walk(&root, window, interactive_only, max_depth, max_elements)?;
        // Chromium/Electron recién despertado tarda un momento en construir su árbol.
        if walk.entries.len() <= 3 && class_name(window).starts_with("Chrome_WidgetWin") {
            sleep(Duration::from_millis(700));
            walk = self.walk(&root, window, interactive_only, max_depth, max_elements)?;
        }
        let id = self.begin_snapshot();
        let (count, truncated) = (walk.entries.len(), walk.truncated);
        let lines = self.render(walk.entries, window, id, 0, &mut 0);
        let mut text = format!("{header} · snapshot s{id} · {count} elements · {} ms", started.elapsed().as_millis());
        if truncated {
            text.push_str(&format!(" · truncated at {max_elements}: narrow it with root or raise max_elements"));
        }
        if lines.is_empty() {
            text.push_str(if interactive_only {
                "\n(no actionable elements; try interactive_only:false, or the app may not expose accessibility data)"
            } else {
                "\n(empty)"
            });
        } else {
            text.push('\n');
            text.push_str(&lines.join("\n"));
        }
        Ok(text)
    }

    /// Elementos de una ventana que coinciden con un rol y/o un nombre.
    fn matches(&mut self, args: &Value) -> Result<(WindowInfo, Vec<(IUIAutomationElement, Described)>), ToolError> {
        let info = self.resolve_window(args)?;
        if self.wake_chromium(info.hwnd) {
            sleep(Duration::from_millis(500));
        }
        let role = args["role"].as_str().map(str::to_lowercase).filter(|text| !text.is_empty());
        let name = args["name"].as_str().map(str::to_lowercase).filter(|text| !text.is_empty());
        let list = unsafe { self.element(&info)?.FindAllBuildCache(TreeScope_Descendants, &self.view, &self.single) }.map_err(failure)?;
        let mut found = Vec::new();
        for index in 0..unsafe { list.Length() }.unwrap_or(0) {
            let Ok(element) = (unsafe { list.GetElement(index) }) else { continue };
            let described = describe(&element);
            if role.as_ref().is_some_and(|role| described.node.role != role) {
                continue;
            }
            if name.as_ref().is_some_and(|name| !described.node.name.to_lowercase().contains(name)) {
                continue;
            }
            found.push((element, described));
        }
        Ok((info, found))
    }

    fn find(&mut self, args: &Value) -> ToolResult {
        if args["role"].as_str().unwrap_or("").is_empty() && args["name"].as_str().unwrap_or("").is_empty() {
            return Err(ToolError::new("INVALID_ARGS", "Pass role and/or name."));
        }
        let limit = args["limit"].as_u64().unwrap_or(20).clamp(1, 100) as usize;
        let (info, found) = self.matches(args)?;
        let total = found.len();
        let id = self.begin_snapshot();
        let mut lines = Vec::new();
        for (index, (element, mut described)) in found.into_iter().take(limit).enumerate() {
            let reference = format!("@s{id}:e{}", index + 1);
            described.node.reference = Some(reference.clone());
            lines.push(format_node(&described.node));
            self.refs.insert(reference, Target { element, window: info.hwnd });
        }
        Ok(format!("find s{id} in w{:X} · {total} matches{}\n{}", info.hwnd,
            if total > limit { format!(", first {limit}") } else { String::new() },
            if lines.is_empty() { "(none)".into() } else { lines.join("\n") }))
    }

    fn get(&mut self, args: &Value) -> ToolResult {
        let target = self.target(args)?;
        let element = &target.element;
        let password = unsafe { element.CurrentIsPassword() }.map(|value| value.as_bool()).unwrap_or(false);
        let property = args["property"].as_str().unwrap_or("all");
        if password && matches!(property, "value" | "text") {
            return Err(ToolError::new("PASSWORD", "Trex never reads password fields."));
        }
        let value = || -> Option<String> {
            if let Some(pattern) = pattern::<IUIAutomationValuePattern>(element, UIA_ValuePatternId) {
                return unsafe { pattern.CurrentValue() }.ok().map(|text| lines(&text.to_string()));
            }
            pattern::<IUIAutomationRangeValuePattern>(element, UIA_RangeValuePatternId).and_then(|pattern| unsafe { pattern.CurrentValue() }.ok()).map(|number| number.to_string())
        };
        let clip = |text: String| -> String {
            let total = text.chars().count();
            if total > MAX_TEXT as usize { format!("{}…({total} chars)", text.chars().take(MAX_TEXT as usize).collect::<String>()) } else { text }
        };
        match property {
            "value" => value().map(clip).ok_or_else(|| ToolError::new("NO_VALUE", "The element has no value.")),
            "text" => {
                let document = pattern::<IUIAutomationTextPattern>(element, UIA_TextPatternId)
                    .and_then(|pattern| unsafe { pattern.DocumentRange().and_then(|range| range.GetText(MAX_TEXT + 1)) }.ok())
                    .map(|text| lines(&text.to_string()));
                Ok(clip(document.or_else(value).or_else(|| unsafe { element.CurrentName() }.ok().map(|name| name.to_string())).unwrap_or_default()))
            }
            "name" => unsafe { element.CurrentName() }.map(|name| name.to_string()).map_err(failure),
            "bounds" => unsafe { element.CurrentBoundingRectangle() }
                .map(|rect| format!("x={} y={} width={} height={}", rect.left, rect.top, rect.right - rect.left, rect.bottom - rect.top))
                .map_err(failure),
            "states" | "all" => {
                let cached = unsafe { element.BuildUpdatedCache(&self.single) }.map_err(failure)?;
                let described = describe(&cached);
                if property == "states" {
                    return Ok(if described.node.states.is_empty() { "enabled".into() } else { described.node.states.join(" ") });
                }
                let mut node = described.node;
                node.reference = args["ref_id"].as_str().map(str::to_owned);
                if !password {
                    node.value = value().filter(|text| !text.is_empty()).or(node.value);
                }
                Ok(format_node(&node))
            }
            other => Err(ToolError::new("INVALID_ARGS", format!("Unknown property {other}."))),
        }
    }

    fn wait(&mut self, args: &Value, cancel: &AtomicBool) -> ToolResult {
        if let Some(ms) = args["ms"].as_u64() {
            let ms = ms.min(10_000);
            let deadline = Instant::now() + Duration::from_millis(ms);
            while Instant::now() < deadline {
                if cancel.load(Ordering::SeqCst) {
                    return Err(ToolError::new("CANCELLED", "Cancelled."));
                }
                sleep(Duration::from_millis(50).min(deadline.saturating_duration_since(Instant::now())));
            }
            return Ok(format!("Waited {ms} ms."));
        }
        let timeout = Duration::from_millis(args["timeout_ms"].as_u64().unwrap_or(5_000).min(15_000));
        let gone = args["gone"].as_bool().unwrap_or(false);
        let element = args["role"].is_string() || args["name"].is_string();
        if !element && !args["window_id"].is_string() && !args["app"].is_string() {
            return Err(ToolError::new("INVALID_ARGS", "Pass ms, or a window (window_id/app) with optional role/name."));
        }
        let deadline = Instant::now() + timeout;
        loop {
            let present = if element {
                match self.matches(args) {
                    Ok((_, found)) => !found.is_empty(),
                    Err(error) if error.code == "NOT_FOUND" => false,
                    Err(error) => return Err(error),
                }
            } else {
                match self.resolve_window(args) {
                    Ok(_) => true,
                    Err(error) if error.code == "NOT_FOUND" => false,
                    Err(error) => return Err(error),
                }
            };
            if present != gone {
                return if element && !gone { self.find(args) } else { Ok(if gone { "It is gone.".into() } else { "The window is open.".into() }) };
            }
            if Instant::now() >= deadline {
                return Err(ToolError::new("TIMEOUT", format!("Still {} after {} ms.", if gone { "present" } else { "absent" }, timeout.as_millis())));
            }
            if cancel.load(Ordering::SeqCst) {
                return Err(ToolError::new("CANCELLED", "Cancelled."));
            }
            sleep(Duration::from_millis(300));
        }
    }

    fn status(&mut self) -> ToolResult {
        Ok(format!(
            "engine: trex (Windows UI Automation)\nactions keep the user's focus: {}\nkeyboard shortcuts: {}\nuser last input: {} ms ago\nforeground window: w{:X}\nlive refs: {}",
            if self.keeps_focus { "yes" } else { "no (older Windows: windows may come to the front)" },
            if self.keyboard { "allowed (a11y_press)" } else { "disabled in Trex settings" },
            self.idle_ms(), foreground(), self.refs.len()
        ))
    }

    // --- Acciones ------------------------------------------------------------------

    fn click(&mut self, args: &Value) -> ToolResult {
        let target = self.target(args)?;
        let front = self.guard(target.window)?;
        let started = Instant::now();
        let seen = self.before(target.window);
        self.mark(&target.element, "clic");
        let head = match bounded(&target.element, activate)? {
            Outcome::Done(method) => format!("Clicked ({method})."),
            Outcome::Unsupported => return Err(ToolError::new("NOT_ACTIONABLE", "The element cannot be activated semantically.")),
            Outcome::Pending => "Clicked; the application is still handling it (for example, a modal dialog opened).".into(),
        };
        let changes = self.changes(seen);
        Ok(format!("{head}{}{changes}", self.settle_focus(front, target.window, started)))
    }

    fn right_click(&mut self, args: &Value) -> ToolResult {
        let target = self.target(args)?;
        let front = self.guard(target.window)?;
        let started = Instant::now();
        let seen = self.before(target.window);
        self.mark(&target.element, "menú contextual");
        let head = match bounded(&target.element, context_menu)? {
            Outcome::Done(_) => "Context menu opened.".to_owned(),
            Outcome::Unsupported => return Err(ToolError::new("NOT_SUPPORTED", "This element has no context menu (needs Windows 8.1 or later).")),
            Outcome::Pending => "Context menu requested; the application is still handling it.".into(),
        };
        let changes = self.changes(seen);
        Ok(format!("{head}{}{changes}", self.settle_focus(front, target.window, started)))
    }

    /// Atajo de teclado real (solo con el permiso de Ajustes): trae la ventana al
    /// frente un instante, pulsa y devuelve el foco a la de la persona.
    fn press(&mut self, args: &Value) -> ToolResult {
        if !self.keyboard {
            return Err(ToolError::new("NOT_ALLOWED", "Keyboard shortcuts are disabled in Trex settings."));
        }
        let combo = keys::parse(args["keys"].as_str().unwrap_or("")).map_err(|message| ToolError::new("INVALID_ARGS", message))?;
        let (element, window) = if args["ref_id"].is_string() {
            let target = self.target(args)?;
            (target.element, target.window)
        } else {
            let info = self.resolve_window(args)?;
            (self.element(&info)?, info.hwnd)
        };
        let idle = self.idle_ms();
        if idle < KEYBOARD_IDLE_MS {
            return Err(ToolError::new("USER_ACTIVE", format!(
                "The user is using the mouse or keyboard (last input {idle} ms ago); a shortcut now would mix with their typing. Nothing was done; wait and retry.")));
        }
        self.claim(window)?;
        let seen = self.before(window);
        let previous = foreground();
        self.mark(&element, &combo.label);
        unsafe { element.SetFocus() }.map_err(failure)?;
        let deadline = Instant::now() + Duration::from_millis(800);
        while foreground() != window && Instant::now() < deadline {
            sleep(Duration::from_millis(20));
        }
        if foreground() != window {
            self.restore_focus(previous);
            return Err(ToolError::new("FOCUS_FAILED", "Windows did not let the window come to the front; nothing was typed."));
        }
        // Última comprobación justo antes de usar el teclado.
        if self.idle_ms() < 300 {
            self.restore_focus(previous);
            return Err(ToolError::new("USER_ACTIVE", "The user started typing; nothing was sent."));
        }
        let from = unsafe { GetTickCount() };
        send_combo(&combo);
        self.own_input = Some((from, unsafe { GetTickCount() }));
        sleep(Duration::from_millis(150));
        let back = previous != window && self.restore_focus(previous);
        let note = if back { " The window came to the front for a moment; the focus went back to the user's window." } else { " The window is now in front." };
        Ok(format!("Pressed {} in w{window:X}.{note}{}", combo.label, self.changes(seen)))
    }

    /// set_value, type y clear: escribe con el patrón Value y comprueba que se conserva.
    fn write_value(&mut self, args: &Value, operation: &str) -> ToolResult {
        let target = self.target(args)?;
        let element = &target.element;
        if unsafe { element.CurrentIsPassword() }.map(|value| value.as_bool()).unwrap_or(false) {
            return Err(ToolError::new("PASSWORD", "Trex never writes into password fields; ask the user to do it."));
        }
        let Some(pattern) = pattern::<IUIAutomationValuePattern>(element, UIA_ValuePatternId) else {
            if operation == "set_value" {
                if let Some(range) = pattern::<IUIAutomationRangeValuePattern>(element, UIA_RangeValuePatternId) {
                    let number: f64 = args["value"].as_str().and_then(|text| text.trim().parse().ok())
                        .ok_or_else(|| ToolError::new("INVALID_ARGS", "This element takes a number."))?;
                    let before = self.guard(target.window)?;
                    unsafe { range.SetValue(number) }.map_err(failure)?;
                    sleep(Duration::from_millis(150));
                    let actual = unsafe { range.CurrentValue() }.map_err(failure)?;
                    return if (actual - number).abs() < 1e-9 {
                        Ok(format!("Value set and verified: {actual}.{}", Self::focus_note(before, target.window)))
                    } else {
                        Err(ToolError::new("NOT_KEPT", format!("The control now reports {actual} instead of {number}.")))
                    };
                }
            }
            return Err(if pattern::<IUIAutomationTextPattern>(element, UIA_TextPatternId).is_some() {
                ToolError::new("KEYBOARD_ONLY", "This field only accepts real keystrokes; Trex never types with the user's keyboard. Explain it or ask the user.")
            } else {
                ToolError::new("NOT_EDITABLE", "The element has no editable value.")
            });
        };
        if unsafe { pattern.CurrentIsReadOnly() }.map(|value| value.as_bool()).unwrap_or(false) {
            return Err(ToolError::new("READ_ONLY", "The field is read-only."));
        }
        let expected = match operation {
            "clear" => String::new(),
            "type" => {
                let text = args["text"].as_str().ok_or_else(|| ToolError::new("INVALID_ARGS", "text is required."))?;
                let current = unsafe { pattern.CurrentValue() }.map_err(failure)?.to_string();
                current + text
            }
            _ => args["value"].as_str().ok_or_else(|| ToolError::new("INVALID_ARGS", "value is required."))?.to_owned(),
        };
        let before = self.guard(target.window)?;
        self.mark(&target.element, "escribir");
        unsafe { pattern.SetValue(&BSTR::from(expected.as_str())) }.map_err(failure)?;
        // Releer un poco después: algunos controles aceptan el valor y luego lo descartan.
        sleep(Duration::from_millis(150));
        let actual = unsafe { pattern.CurrentValue() }.map_err(failure)?.to_string();
        let normalize = |text: &str| text.replace("\r\n", "\n").replace('\r', "\n");
        if normalize(&actual) == normalize(&expected) {
            Ok(format!("Value verified: {}.{}", quote(&actual, 200), Self::focus_note(before, target.window)))
        } else {
            Err(ToolError::new("NOT_KEPT", format!(
                "The control accepted the value but now reports {}; the application did not keep it. Do not claim it was written.", quote(&actual, 200))))
        }
    }

    fn toggle(&mut self, args: &Value, operation: &str) -> ToolResult {
        let target = self.target(args)?;
        let pattern = pattern::<IUIAutomationTogglePattern>(&target.element, UIA_TogglePatternId)
            .ok_or_else(|| ToolError::new("NOT_TOGGLEABLE", "The element is not a checkbox or switch."))?;
        let current = unsafe { pattern.CurrentToggleState() }.map_err(failure)?;
        let wanted = match operation {
            "check" => Some(ToggleState_On),
            "uncheck" => Some(ToggleState_Off),
            _ => None,
        };
        let label = |state: ToggleState| if state == ToggleState_On { "checked" } else if state == ToggleState_Off { "unchecked" } else { "mixed" };
        if wanted == Some(current) {
            return Ok(format!("Already {}; nothing changed.", label(current)));
        }
        let before = self.guard(target.window)?;
        self.mark(&target.element, "marcar");
        unsafe { pattern.Toggle() }.map_err(failure)?;
        sleep(Duration::from_millis(100));
        let mut after = unsafe { pattern.CurrentToggleState() }.map_err(failure)?;
        // Una casilla de tres estados puede necesitar una segunda vuelta.
        if wanted.is_some_and(|wanted| after != wanted) && after == ToggleState_Indeterminate {
            unsafe { pattern.Toggle() }.map_err(failure)?;
            sleep(Duration::from_millis(100));
            after = unsafe { pattern.CurrentToggleState() }.map_err(failure)?;
        }
        let ok = match wanted { Some(wanted) => after == wanted, None => after != current };
        if ok {
            Ok(format!("Now {} (verified).{}", label(after), Self::focus_note(before, target.window)))
        } else {
            Err(ToolError::new("NOT_KEPT", format!("The control is still {}.", label(after))))
        }
    }

    fn expand(&mut self, args: &Value, expand: bool) -> ToolResult {
        let target = self.target(args)?;
        let pattern = pattern::<IUIAutomationExpandCollapsePattern>(&target.element, UIA_ExpandCollapsePatternId)
            .ok_or_else(|| ToolError::new("NOT_EXPANDABLE", "The element cannot be expanded or collapsed."))?;
        let front = self.guard(target.window)?;
        let started = Instant::now();
        let seen = self.before(target.window);
        self.mark(&target.element, if expand { "desplegar" } else { "plegar" });
        if let Outcome::Pending = bounded(&target.element, if expand { open_element } else { close_element })? {
            return Ok(format!("Requested; the application is still handling it.{}", self.changes(seen)));
        }
        sleep(Duration::from_millis(100));
        let state = unsafe { pattern.CurrentExpandCollapseState() }.map_err(failure)?;
        let done = if expand { state == ExpandCollapseState_Expanded || state == ExpandCollapseState_PartiallyExpanded } else { state == ExpandCollapseState_Collapsed };
        if done {
            let changes = self.changes(seen);
            Ok(format!("{} (verified).{}{changes}", if expand { "Expanded" } else { "Collapsed" }, self.settle_focus(front, target.window, started)))
        } else {
            Err(ToolError::new("NOT_KEPT", "The element did not change state."))
        }
    }

    fn select(&mut self, args: &Value) -> ToolResult {
        let target = self.target(args)?;
        let element = target.element.clone();
        let before = self.guard(target.window)?;
        self.mark(&element, "elegir");
        let Some(wanted) = args["value"].as_str().map(str::to_owned) else {
            let pattern = pattern::<IUIAutomationSelectionItemPattern>(&element, UIA_SelectionItemPatternId)
                .ok_or_else(|| ToolError::new("NOT_SELECTABLE", "The element is not a selectable item; pass value to pick an option inside it."))?;
            unsafe { pattern.Select() }.map_err(failure)?;
            sleep(Duration::from_millis(150));
            return if unsafe { pattern.CurrentIsSelected() }.map(|value| value.as_bool()).unwrap_or(false) {
                Ok(format!("Selected (verified).{}", Self::focus_note(before, target.window)))
            } else {
                Err(ToolError::new("NOT_KEPT", "The item is not selected."))
            };
        };
        let option = |engine: &Self| -> Option<IUIAutomationElement> {
            let list = unsafe { element.FindAllBuildCache(TreeScope_Descendants, &engine.view, &engine.single) }.ok()?;
            let lowered = wanted.to_lowercase();
            let mut partial = None;
            for index in 0..unsafe { list.Length() }.unwrap_or(0) {
                let item = unsafe { list.GetElement(index) }.ok()?;
                if !cached_bool(&item, UIA_IsSelectionItemPatternAvailablePropertyId) {
                    continue;
                }
                let name = unsafe { item.CachedName() }.map(|name| name.to_string().to_lowercase()).unwrap_or_default();
                if name == lowered {
                    return Some(item);
                }
                if partial.is_none() && name.contains(&lowered) {
                    partial = Some(item);
                }
            }
            partial
        };
        let mut expanded = None;
        let mut item = option(self);
        if item.is_none() && unsafe { element.CurrentControlType() }.is_ok_and(|kind| kind == UIA_ComboBoxControlTypeId) {
            // Un desplegable clásico elige la opción que empieza por ese texto sin abrir la lista.
            if let Some(value) = pattern::<IUIAutomationValuePattern>(&element, UIA_ValuePatternId) {
                if unsafe { value.SetValue(&BSTR::from(wanted.as_str())) }.is_ok() {
                    sleep(Duration::from_millis(100));
                    let now = unsafe { value.CurrentValue() }.map(|text| text.to_string()).unwrap_or_default();
                    if now.to_lowercase() == wanted.to_lowercase() || (!now.is_empty() && now.to_lowercase().starts_with(&wanted.to_lowercase())) {
                        return Ok(format!("Selected {} (verified).{}", quote(&now, 80), Self::focus_note(before, target.window)));
                    }
                }
            }
        }
        if item.is_none() {
            // Las opciones de algunos desplegables solo existen con la lista abierta.
            if let Some(pattern) = pattern::<IUIAutomationExpandCollapsePattern>(&element, UIA_ExpandCollapsePatternId) {
                if unsafe { pattern.Expand() }.is_ok() {
                    sleep(Duration::from_millis(250));
                    item = option(self);
                    expanded = Some(pattern);
                }
            }
        }
        let close = |expanded: &Option<IUIAutomationExpandCollapsePattern>| {
            if let Some(pattern) = expanded {
                let _ = unsafe { pattern.Collapse() };
            }
        };
        let Some(item) = item else {
            close(&expanded);
            return Err(ToolError::new("NOT_FOUND", format!("No option named {} inside the element.", quote(&wanted, 80))));
        };
        let pattern = pattern::<IUIAutomationSelectionItemPattern>(&item, UIA_SelectionItemPatternId)
            .ok_or_else(|| ToolError::new("NOT_SELECTABLE", "The option cannot be selected."))?;
        let result = unsafe { pattern.Select() }.map_err(failure);
        sleep(Duration::from_millis(150));
        let selected = unsafe { pattern.CurrentIsSelected() }.map(|value| value.as_bool()).unwrap_or(false);
        close(&expanded);
        result?;
        let name = unsafe { item.CurrentName() }.map(|name| name.to_string()).unwrap_or(wanted);
        if selected {
            Ok(format!("Selected {} (verified).{}", quote(&name, 80), Self::focus_note(before, target.window)))
        } else {
            Err(ToolError::new("NOT_KEPT", format!("{} is not selected.", quote(&name, 80))))
        }
    }

    fn scroll(&mut self, args: &Value) -> ToolResult {
        let target = self.target(args)?;
        let amount = args["amount"].as_u64().unwrap_or(3).clamp(1, 20);
        let (horizontal, vertical) = match args["direction"].as_str() {
            Some("down") => (ScrollAmount_NoAmount, ScrollAmount_SmallIncrement),
            Some("up") => (ScrollAmount_NoAmount, ScrollAmount_SmallDecrement),
            Some("right") => (ScrollAmount_SmallIncrement, ScrollAmount_NoAmount),
            Some("left") => (ScrollAmount_SmallDecrement, ScrollAmount_NoAmount),
            _ => return Err(ToolError::new("INVALID_ARGS", "direction must be up, down, left or right.")),
        };
        // El propio elemento o su contenedor desplazable más cercano.
        let mut current = Some(target.element.clone());
        let mut scrollable = None;
        for _ in 0..8 {
            let Some(element) = current else { break };
            if let Some(pattern) = pattern::<IUIAutomationScrollPattern>(&element, UIA_ScrollPatternId) {
                scrollable = Some(pattern);
                break;
            }
            current = unsafe { self.walker.GetParentElement(&element) }.ok();
        }
        let pattern = scrollable.ok_or_else(|| ToolError::new("NOT_SCROLLABLE", "Nothing scrollable around this element."))?;
        let before = self.guard(target.window)?;
        self.mark(&target.element, "desplazar");
        for _ in 0..amount {
            unsafe { pattern.Scroll(horizontal, vertical) }.map_err(failure)?;
        }
        let position = unsafe { (pattern.CurrentHorizontalScrollPercent(), pattern.CurrentVerticalScrollPercent()) };
        let percent = |value: windows::core::Result<f64>| value.ok().filter(|value| *value >= 0.0).map_or("-".into(), |value| format!("{value:.0}%"));
        Ok(format!("Scrolled; position horizontal {} vertical {}. Take a snapshot to see what is visible.{}", percent(position.0), percent(position.1),
            Self::focus_note(before, target.window)))
    }

    fn scroll_to(&mut self, args: &Value) -> ToolResult {
        let target = self.target(args)?;
        let pattern = pattern::<IUIAutomationScrollItemPattern>(&target.element, UIA_ScrollItemPatternId)
            .ok_or_else(|| ToolError::new("NOT_SCROLLABLE", "The element cannot be scrolled into view."))?;
        let before = self.guard(target.window)?;
        unsafe { pattern.ScrollIntoView() }.map_err(failure)?;
        Ok(format!("Scrolled into view.{}", Self::focus_note(before, target.window)))
    }

    fn launch(&mut self, args: &Value, cancel: &AtomicBool) -> ToolResult {
        let app = args["app"].as_str().filter(|app| !app.trim().is_empty()).ok_or_else(|| ToolError::new("INVALID_ARGS", "app is required."))?;
        let idle = self.idle_ms();
        if idle < USER_ACTIVE_MS {
            return Err(ToolError::new("USER_ACTIVE", format!(
                "The user is typing or moving the mouse (last input {idle} ms ago); a new window now could take their keystrokes. Wait with a11y_wait and retry.")));
        }
        let parameters = args["args"].as_array().map(|items| {
            items.iter().filter_map(Value::as_str).map(|item| {
                if item.contains([' ', '"']) { format!("\"{}\"", item.replace('"', "\\\"")) } else { item.to_owned() }
            }).collect::<Vec<_>>().join(" ")
        }).unwrap_or_default();
        let known: HashSet<isize> = self.windows()?.iter().map(|window| window.hwnd).collect();
        let file = HSTRING::from(app);
        let parameters = HSTRING::from(parameters);
        let mut info = SHELLEXECUTEINFOW {
            cbSize: size_of::<SHELLEXECUTEINFOW>() as u32,
            fMask: SEE_MASK_NOCLOSEPROCESS,
            lpFile: PCWSTR(file.as_ptr()),
            lpParameters: if parameters.is_empty() { PCWSTR::null() } else { PCWSTR(parameters.as_ptr()) },
            nShow: SW_SHOWNOACTIVATE.0,
            ..Default::default()
        };
        unsafe { ShellExecuteExW(&mut info) }.map_err(|error| ToolError::new("LAUNCH_FAILED", format!("Could not open {app}: {}", error.message())))?;
        if !info.hProcess.is_invalid() {
            let _ = unsafe { CloseHandle(info.hProcess) };
        }
        let deadline = Instant::now() + Duration::from_secs(8);
        while Instant::now() < deadline {
            if cancel.load(Ordering::SeqCst) {
                return Err(ToolError::new("CANCELLED", "Cancelled after starting the application."));
            }
            sleep(Duration::from_millis(250));
            if top_windows().iter().any(|facts| !known.contains(&facts.0)) {
                // Dejar que termine de pintarse antes de leerla.
                sleep(Duration::from_millis(300));
                let opened = self.new_windows(&known, &mut None, &mut 0);
                return Ok(format!("Opened {app}.{opened}"));
            }
        }
        Ok(format!("Started {app}, but no new window appeared within 8 s (it may still be starting, or reused an open window). Use a11y_list_windows or a11y_wait."))
    }

    fn window_action(&mut self, args: &Value, operation: &str) -> ToolResult {
        let info = self.resolve_window(args)?;
        let pattern = pattern::<IUIAutomationWindowPattern>(&self.element(&info)?, UIA_WindowPatternId)
            .ok_or_else(|| ToolError::new("NOT_SUPPORTED", "This window cannot be controlled that way."))?;
        let before = self.guard(info.hwnd)?;
        let target = match operation {
            "close_app" => {
                unsafe { pattern.Close() }.map_err(failure)?;
                let deadline = Instant::now() + Duration::from_millis(1_500);
                while window_facts(info.hwnd).is_some() && Instant::now() < deadline {
                    sleep(Duration::from_millis(50));
                }
                let open = window_facts(info.hwnd).is_some();
                return Ok(if open {
                    format!("Close requested, but w{:X} is still open (it may be asking to save). Take a snapshot of it.", info.hwnd)
                } else {
                    format!("Closed w{:X} {}.", info.hwnd, quote(&info.title, 80))
                });
            }
            "minimize" => WindowVisualState_Minimized,
            "maximize" => {
                if !unsafe { pattern.CurrentCanMaximize() }.map(|value| value.as_bool()).unwrap_or(false) {
                    return Err(ToolError::new("NOT_SUPPORTED", "This window cannot be maximized."));
                }
                WindowVisualState_Maximized
            }
            _ => WindowVisualState_Normal,
        };
        unsafe { pattern.SetWindowVisualState(target) }.map_err(failure)?;
        sleep(Duration::from_millis(200));
        let state = unsafe { pattern.CurrentWindowVisualState() }.map_err(failure)?;
        let word = match operation { "minimize" => "minimized", "maximize" => "maximized", _ => "restored" };
        if state == target {
            Ok(format!("Window w{:X} is now {word} (verified).{}", info.hwnd, Self::focus_note(before, info.hwnd)))
        } else {
            Err(ToolError::new("NOT_KEPT", "The window did not change state."))
        }
    }
}

/// `root` como si fuera `ref_id`.
fn json_ref(value: &Value) -> Value {
    serde_json::json!({"ref_id": value})
}

/// Un elemento recorrido. La clave (ruta de rol y nombre desde la ventana)
/// sirve para saber qué es nuevo tras una acción.
struct Entry {
    key: String,
    node: Node,
    element: IUIAutomationElement,
    referenced: bool,
}

/// Recorrido en memoria del subárbol cacheado.
struct Walk {
    interactive_only: bool,
    max_depth: usize,
    max_elements: usize,
    entries: Vec<Entry>,
    truncated: bool,
}
impl Walk {
    fn children(&mut self, parent: &IUIAutomationElement, depth: usize, indent: usize, path: &str) {
        let Ok(children) = (unsafe { parent.GetCachedChildren() }) else { return };
        for index in 0..unsafe { children.Length() }.unwrap_or(0) {
            if self.truncated {
                return;
            }
            let Ok(child) = (unsafe { children.GetElement(index) }) else { continue };
            self.visit(&child, depth + 1, indent, path);
        }
    }
    fn visit(&mut self, element: &IUIAutomationElement, depth: usize, indent: usize, path: &str) {
        if depth > self.max_depth {
            return;
        }
        let described = describe(element);
        // Barras de desplazamiento y de título: ruido para el agente (hay herramientas propias).
        if self.interactive_only && matches!(described.node.role, "scrollbar" | "titlebar" | "thumb") {
            return;
        }
        let key = format!("{path}/{}:{}", described.node.role, described.node.name);
        let include = described.referenced
            || (!self.interactive_only && (!described.node.name.trim().is_empty() || described.node.value.is_some()));
        let mut next_indent = indent;
        if include {
            if self.entries.len() >= self.max_elements {
                self.truncated = true;
                return;
            }
            let mut node = described.node;
            node.depth = indent;
            self.entries.push(Entry { key: key.clone(), node, element: element.clone(), referenced: described.referenced });
            next_indent += 1;
        }
        self.children(element, depth, next_indent, &key);
    }
}

impl Engine for UiaEngine {
    fn call(&mut self, tool: &str, args: &Value, cancel: &AtomicBool) -> ToolResult {
        match tool {
            "list_windows" => self.list_windows(args),
            "snapshot" => self.snapshot(args),
            "find" => self.find(args),
            "get" => self.get(args),
            "wait" => self.wait(args, cancel),
            "status" => self.status(),
            "click" => self.click(args),
            "right_click" => self.right_click(args),
            "set_value" | "type" | "clear" => self.write_value(args, tool),
            "toggle" | "check" | "uncheck" => self.toggle(args, tool),
            "expand" => self.expand(args, true),
            "collapse" => self.expand(args, false),
            "select" => self.select(args),
            "scroll" => self.scroll(args),
            "scroll_to" => self.scroll_to(args),
            "launch" => self.launch(args, cancel),
            "press" => self.press(args),
            "close_app" | "minimize" | "maximize" | "restore" => self.window_action(args, tool),
            other => Err(ToolError::new("INVALID_ARGS", format!("Unknown tool {other}."))),
        }
    }
}

#[cfg(test)]
impl UiaEngine {
    /// Una llamada sin cancelación, para las pruebas.
    fn run(&mut self, tool: &str, args: &Value) -> ToolResult {
        self.call(tool, args, &AtomicBool::new(false))
    }
}

#[cfg(test)]
mod tests;
