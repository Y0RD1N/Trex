//! Motor de Windows: UI Automation desde un proceso sin ventana.
//!
//! - `AutoSetFocus` desactivado (IUIAutomation6): las acciones no traen la
//!   ventana al frente.
//! - Un snapshot es una sola llamada entre procesos (`BuildUpdatedCache` con el
//!   subárbol) y se recorre en memoria; las referencias apuntan a esos elementos.
//! - Las acciones usan los patrones de cada control (Invoke, Value, Toggle,
//!   ExpandCollapse, SelectionItem, Scroll, Window…), nunca ratón ni teclado, y
//!   se rechazan si la persona está usando esa misma ventana justo ahora.
use super::{format_node, quote, Engine, Node, ToolError, ToolResult};
use serde_json::Value;
use std::collections::{HashMap, HashSet, VecDeque};
use std::thread::sleep;
use std::time::{Duration, Instant};
use windows::core::{Interface, BOOL, BSTR, HSTRING, PCWSTR, PWSTR};
use windows::Win32::Foundation::{CloseHandle, E_ACCESSDENIED, HWND, LPARAM};
use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED};
use windows::Win32::System::SystemInformation::GetTickCount;
use windows::Win32::System::Threading::{OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION};
use windows::Win32::UI::Accessibility::*;
use windows::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
use windows::Win32::UI::Shell::{ShellExecuteExW, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetForegroundWindow, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId, IsIconic, IsWindow, IsWindowVisible, IsZoomed,
    SW_SHOWNOACTIVATE,
};

/// Snapshots cuyas referencias siguen valiendo.
const KEEP_SNAPSHOTS: usize = 5;
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

fn idle_ms() -> u32 {
    let mut info = LASTINPUTINFO { cbSize: size_of::<LASTINPUTINFO>() as u32, dwTime: 0 };
    if unsafe { GetLastInputInfo(&mut info) }.as_bool() {
        unsafe { GetTickCount() }.wrapping_sub(info.dwTime)
    } else {
        u32::MAX
    }
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
}

impl UiaEngine {
    pub fn new() -> anyhow::Result<Self> {
        unsafe {
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
            Ok(Self { automation, view, walker, tree, single, keeps_focus, refs: HashMap::new(), kept: VecDeque::new(), next: 0, process_names: HashMap::new() })
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

    /// No actuar sobre la ventana que la persona está usando ahora mismo.
    fn guard(&self, window: isize) -> Result<isize, ToolError> {
        let (front, idle) = (foreground(), idle_ms());
        if user_active(front, window, idle) {
            return Err(ToolError::new("USER_ACTIVE", format!(
                "The user is working in this window right now (last input {idle} ms ago). Nothing was done; wait a few seconds with a11y_wait and retry.")));
        }
        Ok(front)
    }

    fn focus_note(before: isize, window: isize) -> &'static str {
        let after = foreground();
        if after != before && after == window { " Note: the window came to the front." } else { "" }
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
        let cached = unsafe { root.BuildUpdatedCache(&self.tree) }.map_err(failure)?;
        let id = self.begin_snapshot();
        let mut walk = Walk { id, interactive_only, max_depth, max_elements, lines: Vec::new(), count: 0, refs: Vec::new(), truncated: false };
        walk.children(&cached, 0, 0);
        let Walk { lines, count, refs, truncated, .. } = walk;
        for (reference, element) in refs {
            self.refs.insert(reference, Target { element, window });
        }
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
                return unsafe { pattern.CurrentValue() }.ok().map(|text| text.to_string());
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
                    .map(|text| text.to_string());
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

    fn wait(&mut self, args: &Value) -> ToolResult {
        if let Some(ms) = args["ms"].as_u64() {
            let ms = ms.min(10_000);
            sleep(Duration::from_millis(ms));
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
            sleep(Duration::from_millis(300));
        }
    }

    fn status(&mut self) -> ToolResult {
        Ok(format!(
            "engine: trex (Windows UI Automation)\nactions keep the user's focus: {}\nuser last input: {} ms ago\nforeground window: w{:X}\nlive refs: {}",
            if self.keeps_focus { "yes" } else { "no (older Windows: windows may come to the front)" },
            idle_ms(), foreground(), self.refs.len()
        ))
    }

    // --- Acciones ------------------------------------------------------------------

    fn click(&mut self, args: &Value) -> ToolResult {
        let target = self.target(args)?;
        let before = self.guard(target.window)?;
        let element = &target.element;
        let method = unsafe {
            if let Some(pattern) = pattern::<IUIAutomationInvokePattern>(element, UIA_InvokePatternId) {
                pattern.Invoke().map_err(failure)?;
                "invoked"
            } else if let Some(pattern) = pattern::<IUIAutomationTogglePattern>(element, UIA_TogglePatternId) {
                pattern.Toggle().map_err(failure)?;
                "toggled"
            } else if let Some(pattern) = pattern::<IUIAutomationSelectionItemPattern>(element, UIA_SelectionItemPatternId) {
                pattern.Select().map_err(failure)?;
                "selected"
            } else if let Some(pattern) = pattern::<IUIAutomationExpandCollapsePattern>(element, UIA_ExpandCollapsePatternId) {
                if pattern.CurrentExpandCollapseState().map_err(failure)? == ExpandCollapseState_Collapsed {
                    pattern.Expand().map_err(failure)?;
                    "expanded"
                } else {
                    pattern.Collapse().map_err(failure)?;
                    "collapsed"
                }
            } else if let Some(pattern) = pattern::<IUIAutomationLegacyIAccessiblePattern>(element, UIA_LegacyIAccessiblePatternId) {
                pattern.DoDefaultAction().map_err(failure)?;
                "default action"
            } else {
                return Err(ToolError::new("NOT_ACTIONABLE", "The element cannot be activated semantically."));
            }
        };
        Ok(format!("Clicked ({method}).{}", Self::focus_note(before, target.window)))
    }

    fn right_click(&mut self, args: &Value) -> ToolResult {
        let target = self.target(args)?;
        let before = self.guard(target.window)?;
        let element = target.element.cast::<IUIAutomationElement3>().map_err(|_| ToolError::new("NOT_SUPPORTED", "Context menus need Windows 8.1 or later."))?;
        unsafe { element.ShowContextMenu() }.map_err(failure)?;
        Ok(format!("Context menu requested; take a snapshot (menus can appear as their own window in a11y_list_windows).{}", Self::focus_note(before, target.window)))
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
        let before = self.guard(target.window)?;
        unsafe { if expand { pattern.Expand() } else { pattern.Collapse() } }.map_err(failure)?;
        sleep(Duration::from_millis(150));
        let state = unsafe { pattern.CurrentExpandCollapseState() }.map_err(failure)?;
        let done = if expand { state == ExpandCollapseState_Expanded || state == ExpandCollapseState_PartiallyExpanded } else { state == ExpandCollapseState_Collapsed };
        if done {
            Ok(format!("{} (verified); take a snapshot to see its items.{}", if expand { "Expanded" } else { "Collapsed" }, Self::focus_note(before, target.window)))
        } else {
            Err(ToolError::new("NOT_KEPT", "The element did not change state."))
        }
    }

    fn select(&mut self, args: &Value) -> ToolResult {
        let target = self.target(args)?;
        let element = target.element.clone();
        let before = self.guard(target.window)?;
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

    fn launch(&mut self, args: &Value) -> ToolResult {
        let app = args["app"].as_str().filter(|app| !app.trim().is_empty()).ok_or_else(|| ToolError::new("INVALID_ARGS", "app is required."))?;
        let idle = idle_ms();
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
            sleep(Duration::from_millis(250));
            let front = foreground();
            let fresh: Vec<String> = self.windows()?.iter().filter(|window| !known.contains(&window.hwnd)).map(|window| window.line(front)).collect();
            if !fresh.is_empty() {
                return Ok(format!("Opened {app}. New windows:\n{}", fresh.join("\n")));
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

/// Recorrido en memoria del subárbol cacheado.
struct Walk {
    id: u32,
    interactive_only: bool,
    max_depth: usize,
    max_elements: usize,
    lines: Vec<String>,
    count: usize,
    refs: Vec<(String, IUIAutomationElement)>,
    truncated: bool,
}
impl Walk {
    fn children(&mut self, parent: &IUIAutomationElement, depth: usize, indent: usize) {
        let Ok(children) = (unsafe { parent.GetCachedChildren() }) else { return };
        for index in 0..unsafe { children.Length() }.unwrap_or(0) {
            if self.truncated {
                return;
            }
            let Ok(child) = (unsafe { children.GetElement(index) }) else { continue };
            self.visit(&child, depth + 1, indent);
        }
    }
    fn visit(&mut self, element: &IUIAutomationElement, depth: usize, indent: usize) {
        if depth > self.max_depth {
            return;
        }
        let mut described = describe(element);
        // Barras de desplazamiento y de título: ruido para el agente (hay herramientas propias).
        if self.interactive_only && matches!(described.node.role, "scrollbar" | "titlebar" | "thumb") {
            return;
        }
        let include = described.referenced
            || (!self.interactive_only && (!described.node.name.trim().is_empty() || described.node.value.is_some()));
        let mut next_indent = indent;
        if include {
            if self.count >= self.max_elements {
                self.truncated = true;
                return;
            }
            self.count += 1;
            if described.referenced {
                let reference = format!("@s{}:e{}", self.id, self.count);
                described.node.reference = Some(reference.clone());
                self.refs.push((reference, element.clone()));
            }
            described.node.depth = indent;
            self.lines.push(format_node(&described.node));
            next_indent += 1;
        }
        self.children(element, depth, next_indent);
    }
}

impl Engine for UiaEngine {
    fn call(&mut self, tool: &str, args: &Value) -> ToolResult {
        match tool {
            "list_windows" => self.list_windows(args),
            "snapshot" => self.snapshot(args),
            "find" => self.find(args),
            "get" => self.get(args),
            "wait" => self.wait(args),
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
            "launch" => self.launch(args),
            "close_app" | "minimize" | "maximize" | "restore" => self.window_action(args, tool),
            other => Err(ToolError::new("INVALID_ARGS", format!("Unknown tool {other}."))),
        }
    }
}

#[cfg(test)]
mod tests;
