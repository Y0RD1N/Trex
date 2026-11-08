//! Motor de Linux: AT-SPI2 (GNOME, KDE y cualquier escritorio con el bus de
//! accesibilidad) desde un proceso sin ventana. Funciona igual en Wayland y X11.
//!
//! - Las acciones usan las interfaces de cada control (Action, EditableText,
//!   Value, Selection, Component), nunca ratón ni teclado, y se rechazan si la
//!   persona está usando esa misma ventana justo ahora, o si otro agente de Trex
//!   la está usando.
//! - Cada acción con estado se comprueba releyendo el control, y cada acción que
//!   puede cambiar la ventana dice qué apareció (elementos y ventanas nuevos, ya
//!   con referencia), igual que el motor de Windows.
//! - Wayland no deja saber posiciones en la pantalla ni traer ventanas al frente:
//!   no hay resaltado en pantalla, los límites (`bounds`) son relativos a la
//!   ventana, el desplazamiento usa las barras accesibles o `ScrollTo`, y los
//!   atajos de teclado (`press`, por el portal RemoteDesktop) solo van a la
//!   ventana que ya está activa.
//! - Chromium, Electron, Firefox y Qt publican su árbol solo con tecnologías de
//!   asistencia activas: el motor enciende `org.a11y.Status.IsEnabled` mientras
//!   dura (y lo apaga al terminar si lo encendió él).
mod bus;
mod portal;

use super::locks::Locks;
use super::{format_node, keys, lines, quote, Engine, Node, ToolError, ToolResult};
use bus::{role as r, state as s, Bus, Fetch, Ifaces, Obj, Raw, States};
use futures_util::stream::{self, StreamExt};
use serde_json::Value;
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread::sleep;
use std::time::{Duration, Instant};

/// Snapshots (y listas de cambios) cuyas referencias siguen valiendo.
const KEEP_SNAPSHOTS: usize = 8;
/// Elementos nuevos que se listan tras una acción, y de cada ventana nueva.
const CHANGE_LINES: usize = 40;
const NEW_WINDOW_LINES: usize = 25;
/// Un atajo de teclado solo si la persona lleva este tiempo sin tocar nada.
const KEYBOARD_IDLE_MS: u32 = 3_000;
/// Si la persona usó ratón o teclado hace menos de esto en la ventana destino, no se actúa.
const USER_ACTIVE_MS: u32 = 2_000;
/// Si la persona está usando la ventana, se espera hasta esto a que haga una pausa.
const PAUSE_WAIT: Duration = Duration::from_millis(4_000);
/// Elementos que cambiaron de valor o de estado que se listan tras una acción.
const CHANGED_LINES: usize = 12;
/// Textos nuevos (mensajes de la app) que se listan tras una acción.
const NEW_TEXT_LINES: usize = 8;
/// Lo más que se lee de un valor o del texto de un documento.
const MAX_TEXT: i32 = 20_000;
/// Aplicaciones del bus que no son ventanas de la persona: el propio escritorio.
const SHELL_APPS: [&str; 3] = ["gnome-shell", "mutter-x11-frames", "plasmashell"];

/// Por qué no se puede usar el bus de accesibilidad, o None si se puede.
pub fn probe() -> Option<&'static str> {
    bus::probe()
}

// --- Funciones puras (probadas sin escritorio) ----------------------------------------

/// Rol de AT-SPI con los nombres del motor (los mismos que en Windows).
pub(super) fn role_name(role: u32, states: States, ifaces: Ifaces, actionable: bool) -> &'static str {
    match role {
        r::CHECK_BOX => "checkbox",
        r::CHECK_MENU_ITEM | r::RADIO_MENU_ITEM | r::MENU_ITEM | r::TEAROFF_MENU_ITEM => "menuitem",
        // Un menú con acción es una entrada de la barra de menús («Archivo»).
        r::MENU if actionable => "menuitem",
        r::MENU | r::POPUP_MENU => "menu",
        r::MENU_BAR => "menubar",
        r::COMBO_BOX => "combobox",
        r::TEXT | r::ENTRY | r::AUTOCOMPLETE if ifaces.has(Ifaces::EDITABLE_TEXT) || states.has(s::EDITABLE) => "edit",
        r::TEXT | r::ENTRY | r::AUTOCOMPLETE => "text",
        r::PASSWORD_TEXT => "edit",
        r::SPIN_BUTTON => "spinner",
        r::SLIDER => "slider",
        r::LINK => "hyperlink",
        r::IMAGE | r::ICON => "image",
        r::LIST_ITEM => "listitem",
        r::LIST | r::LIST_BOX => "list",
        r::PROGRESS_BAR | r::LEVEL_BAR => "progressbar",
        r::RADIO_BUTTON => "radiobutton",
        r::SCROLL_BAR => "scrollbar",
        r::STATUS_BAR => "statusbar",
        r::PAGE_TAB_LIST => "tab",
        r::PAGE_TAB => "tabitem",
        r::LABEL | r::STATIC | r::ACCELERATOR_LABEL | r::CAPTION | r::PARAGRAPH => "text",
        r::HEADING => "heading",
        r::TOOL_BAR => "toolbar",
        r::TOOL_TIP => "tooltip",
        r::TREE | r::TREE_TABLE => "tree",
        r::TREE_ITEM => "treeitem",
        r::BUTTON | r::PUSH_BUTTON_MENU | r::TOGGLE_BUTTON => "button",
        r::PANEL | r::FILLER | r::GROUPING | r::SECTION | r::FORM | r::LANDMARK | r::ARTICLE | r::BLOCK_QUOTE | r::FILE_CHOOSER | r::FOOTER
        | r::PAGE => "group",
        role if bus::is_document(role) => "document",
        r::FRAME | r::DIALOG | r::WINDOW | r::INTERNAL_FRAME => "window",
        r::ALERT | r::NOTIFICATION | r::INFO_BAR => "alert",
        r::SCROLL_PANE | r::VIEWPORT | r::SPLIT_PANE | r::LAYERED_PANE | r::GLASS_PANE | r::ROOT_PANE | r::OPTION_PANE => "pane",
        r::HEADER => "header",
        r::COLUMN_HEADER | r::TABLE_COLUMN_HEADER | r::TABLE_ROW_HEADER | r::ROW_HEADER => "headeritem",
        r::TABLE => "table",
        r::TABLE_CELL => "dataitem",
        r::TABLE_ROW => "row",
        r::TITLE_BAR => "titlebar",
        r::SEPARATOR => "separator",
        r::CALENDAR => "calendar",
        r::CANVAS | r::DRAWING_AREA => "canvas",
        r::APPLICATION => "application",
        _ => "element",
    }
}

/// Contenedores: su «foco» o «fuera de pantalla» es ruido, y su nombre (a veces
/// el título de la ventana) no identifica lo que contienen.
pub(super) fn is_container(role: &str) -> bool {
    matches!(role, "window" | "pane" | "group" | "menu" | "menubar" | "list" | "tree" | "toolbar" | "tab" | "table" | "datagrid"
        | "header" | "statusbar" | "titlebar" | "application" | "row")
}

/// Roles cuyo nombre suele ser un título que cambia solo (la ventana, la página).
fn titled(role: &str) -> bool {
    is_container(role) || role == "document"
}

/// Roles que de verdad reciben texto.
pub(super) fn takes_text(role: &str) -> bool {
    matches!(role, "edit" | "document" | "combobox" | "spinner" | "dataitem")
}

/// Casillas, interruptores y botones que se quedan pulsados.
pub(super) fn checkable(role: u32, states: States) -> bool {
    states.has(s::CHECKABLE)
        || matches!(role, r::CHECK_BOX | r::CHECK_MENU_ITEM | r::TOGGLE_BUTTON | r::RADIO_BUTTON | r::RADIO_MENU_ITEM)
}

/// Nombres de acción que equivalen a un clic, por preferencia.
const CLICKS: [&str; 9] = ["click", "press", "activate", "jump", "open", "push", "dodefault", "default", "toggle"];

/// La acción de clic de un elemento. En un campo de texto «activate» es pulsar
/// Intro (enviar), no un clic: no cuenta.
pub(super) fn click_action(actions: &[String], role: &str) -> Option<usize> {
    CLICKS.iter().filter(|wanted| !(**wanted == "activate" && matches!(role, "edit" | "document" | "spinner" | "text")))
        .find_map(|wanted| actions.iter().position(|action| action == wanted))
}

pub(super) fn toggle_action(actions: &[String]) -> Option<usize> {
    ["toggle", "click", "press", "activate"].iter().find_map(|wanted| actions.iter().position(|action| action == wanted))
}

pub(super) fn expand_action(actions: &[String], expand: bool) -> Option<usize> {
    let specific = if expand { "expand" } else { "collapse" };
    ["expand or contract", specific, "toggle", "activate", "click", "press", "open"].iter()
        .find_map(|wanted| actions.iter().position(|action| action == wanted))
}

/// La acción que abre el menú contextual («showmenu» en Qt, «menu.popup» en GTK 4…).
pub(super) fn menu_action(actions: &[String]) -> Option<usize> {
    actions.iter().position(|action| action.contains("menu") && !action.contains("menubar"))
}

/// Un campo de contraseña: por su rol, por el texto tapado (GTK 4 no tiene rol
/// propio) o por su nombre.
pub(super) fn is_password(role: u32, name: &str, text: Option<&str>) -> bool {
    if role == r::PASSWORD_TEXT || text.is_some_and(bus::obscured) {
        return true;
    }
    let name = name.trim().to_lowercase();
    const EXACT: [&str; 8] = ["pin", "clave", "clave de acceso", "palavra-passe", "wachtwoord", "hasło", "пароль", "密码"];
    const PARTS: [&str; 7] = ["password", "contraseña", "contrasena", "passwort", "mot de passe", "senha", "passphrase"];
    EXACT.contains(&name.as_str()) || PARTS.iter().any(|part| name.contains(part)) || name.contains("パスワード")
}

/// Lo que se sabe de un elemento, y si se le da referencia.
pub(super) struct Described {
    pub(super) node: Node,
    pub(super) referenced: bool,
}

/// Un elemento de un árbol leído, como línea del snapshot. `parent_selection`:
/// su contenedor tiene Selection (se puede elegir); `scrollable`: tiene barras de
/// desplazamiento accesibles.
pub(super) fn describe(raw: &Raw, parent_selection: bool, scrollable: bool) -> Described {
    let info = &raw.info;
    let states = info.states;
    let role = role_name(info.role, states, info.ifaces, click_action(&raw.actions, "").is_some());
    let editable_role = matches!(role, "edit" | "document");
    let password = editable_role && is_password(info.role, &info.name, raw.text.as_deref());
    let container = is_container(role);
    let can_check = checkable(info.role, states);
    let mut name = info.name.clone();
    // Párrafos y etiquetas de páginas web: su texto es lo que se lee.
    if name.trim().is_empty() && !takes_text(role) {
        if let Some(text) = raw.text.as_deref() {
            name = bus::plain(text);
        }
    }
    let mut node_states = Vec::new();
    if !(container || states.has(s::SENSITIVE) || states.has(s::ENABLED)) {
        node_states.push("disabled");
    }
    if !container && states.has(s::FOCUSED) {
        node_states.push("focused");
    }
    let offscreen = !container && !states.has(s::SHOWING);
    if offscreen {
        node_states.push("offscreen");
    }
    if password {
        node_states.push("password");
    }
    if can_check {
        node_states.push(if states.has(s::INDETERMINATE) {
            "mixed"
        } else if states.has(s::CHECKED) || states.has(s::PRESSED) {
            "checked"
        } else {
            "unchecked"
        });
    }
    let expandable = states.has(s::EXPANDABLE);
    if expandable {
        node_states.push(if states.has(s::EXPANDED) { "expanded" } else { "collapsed" });
    }
    // Elegir tiene sentido en listas, árboles, tablas y pestañas (en un menú, «seleccionar» solo lo resalta).
    let selectable = states.has(s::SELECTABLE) && !matches!(role, "menuitem" | "menu" | "separator" | "combobox")
        && (parent_selection || matches!(role, "tabitem" | "listitem" | "treeitem" | "dataitem" | "row"));
    if selectable && states.has(s::SELECTED) && !can_check {
        node_states.push("selected");
    }
    let text_like = info.ifaces.has(Ifaces::EDITABLE_TEXT) || info.ifaces.has(Ifaces::TEXT);
    let read_only = editable_role && (states.has(s::READ_ONLY) || (text_like && !states.has(s::EDITABLE)));
    if read_only {
        node_states.push("readonly");
    }
    let mut actions = Vec::new();
    let click = click_action(&raw.actions, role).is_some();
    let radio = matches!(info.role, r::RADIO_BUTTON | r::RADIO_MENU_ITEM);
    if radio {
        // Un botón de opción se elige (como en Windows): select lo marca y lo comprueba.
        actions.push("select");
    } else if can_check {
        if role == "button" && click {
            actions.push("click");
        }
        if toggle_action(&raw.actions).is_some() {
            actions.push("toggle");
        }
    } else if role == "combobox" {
        // Un desplegable se abre (expand) o se elige una opción por su nombre (select con value).
        if click || expandable {
            actions.push("expand");
        }
        actions.push("select");
    } else if click {
        actions.push("click");
    }
    if expandable && role != "combobox" {
        actions.push("expand");
    }
    if selectable && !radio && !can_check {
        actions.push("select");
    }
    let writable = info.ifaces.has(Ifaces::EDITABLE_TEXT) && states.has(s::EDITABLE) && !password && takes_text(role);
    let ranged = info.ifaces.has(Ifaces::VALUE) && matches!(role, "slider" | "spinner") && !states.has(s::READ_ONLY);
    if writable || ranged {
        actions.push("set_value");
    }
    if scrollable {
        actions.push("scroll");
    }
    if offscreen && info.ifaces.has(Ifaces::COMPONENT) && !actions.is_empty() {
        actions.push("scroll_to");
    }
    let value = if password || role == "hyperlink" {
        None
    } else if takes_text(role) && raw.text.is_some() {
        raw.text.as_deref().map(lines)
    } else if role == "combobox" {
        raw.valuetext.clone()
    } else {
        raw.number.filter(|_| matches!(role, "slider" | "spinner" | "progressbar")).map(|number| number.to_string())
    }
    .filter(|text| !text.is_empty() && *text != name);
    let editable = editable_role && states.has(s::FOCUSABLE);
    let focused = node_states.contains(&"focused");
    Described {
        referenced: !actions.is_empty() || editable || focused,
        node: Node { depth: 0, reference: None, role, name, value, states: node_states, actions },
    }
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

/// La persona está usando la ventana destino ahora mismo.
pub(super) fn user_active(window_active: bool, idle: u32) -> bool {
    window_active && idle < USER_ACTIVE_MS
}

/// Identificador estable de una ventana (igual en todas las pasarelas: sirve para
/// las reservas entre agentes).
pub(super) fn window_key(obj: &Obj) -> isize {
    let mut hash: u32 = 0x811c_9dc5;
    for byte in obj.bus.bytes().chain([0u8]).chain(obj.path.bytes()) {
        hash ^= u32::from(byte);
        hash = hash.wrapping_mul(0x0100_0193);
    }
    hash as isize
}

pub(super) fn parse_window_id(id: &str) -> Option<isize> {
    isize::from_str_radix(id.trim().trim_start_matches(['w', 'W']), 16).ok()
}

/// Nombre de archivo sin carpeta ni extensión, en minúsculas.
pub(super) fn stem(text: &str) -> String {
    let file = text.trim().rsplit(['\\', '/']).next().unwrap_or("");
    file.rsplit_once('.').map_or(file, |(base, _)| base).trim().to_lowercase()
}

/// Valor y estados de un elemento, para saber si cambió tras una acción.
#[derive(Clone, Debug, PartialEq)]
pub(super) struct Signature {
    pub(super) value: Option<String>,
    pub(super) states: Vec<&'static str>,
}
impl Signature {
    fn of(node: &Node) -> Self {
        Self { value: node.value.clone(), states: node.states.clone() }
    }
}

#[derive(Debug, PartialEq)]
pub(super) enum Change {
    Same,
    Changed,
    Shown,
}

/// Qué le pasó a un elemento que ya estaba. Perder el foco o la selección, o
/// salir de la pantalla, no cuenta: ya lo dice el elemento que los ganó.
pub(super) fn change(before: &Signature, after: &Signature) -> Change {
    let gained = after.states.iter().any(|state| *state != "offscreen" && !before.states.contains(state));
    let lost = before.states.iter().any(|state| !matches!(*state, "focused" | "selected" | "offscreen") && !after.states.contains(state));
    if before.value != after.value || gained || lost {
        Change::Changed
    } else if before.states.contains(&"offscreen") && !after.states.contains(&"offscreen") {
        Change::Shown
    } else {
        Change::Same
    }
}

/// Botones de la barra de título por su nombre, en los idiomas más comunes.
pub(super) fn title_button(name: &str, operation: &str) -> bool {
    let name = name.trim().to_lowercase();
    let names: &[&str] = match operation {
        "close" => &["close", "cerrar", "fermer", "schließen", "chiudi", "fechar", "sluiten", "zamknij", "закрыть", "关闭", "閉じる"],
        "minimize" => &["minimize", "minimise", "minimizar", "réduire", "minimieren", "riduci a icona", "minimaliseren", "minimalizuj", "свернуть", "最小化"],
        "maximize" => &["maximize", "maximise", "maximizar", "agrandir", "maximieren", "massimizza", "maximaliseren", "maksymalizuj", "развернуть", "最大化"],
        "restore" => &["restore", "unmaximize", "restaurar", "desmaximizar", "restaurer", "wiederherstellen", "ripristina", "herstellen", "przywróć", "восстановить", "还原"],
        _ => &[],
    };
    names.contains(&name.as_str())
}

/// Una entrada `.desktop` ya leída.
#[derive(Clone, Debug, PartialEq)]
pub(super) struct DesktopEntry {
    pub(super) path: PathBuf,
    pub(super) id: String,
    pub(super) names: Vec<String>,
    pub(super) exec: String,
}

pub(super) fn parse_desktop(path: &Path, text: &str) -> Option<DesktopEntry> {
    let mut in_entry = false;
    let (mut names, mut exec, mut application, mut hidden) = (Vec::new(), String::new(), false, false);
    for line in text.lines().map(str::trim) {
        if line.starts_with('[') {
            in_entry = line == "[Desktop Entry]";
            continue;
        }
        let Some((key, value)) = line.split_once('=').filter(|_| in_entry) else { continue };
        let (key, value) = (key.trim(), value.trim());
        match key {
            "Type" => application = value == "Application",
            "Hidden" => hidden = value == "true",
            "Exec" => exec = value.to_owned(),
            _ if key == "Name" || (key.starts_with("Name[") && key.ends_with(']')) || key == "GenericName" => names.push(value.to_lowercase()),
            _ => {}
        }
    }
    (application && !hidden).then(|| DesktopEntry {
        path: path.to_path_buf(),
        id: path.file_stem().map(|stem| stem.to_string_lossy().to_lowercase()).unwrap_or_default(),
        names,
        exec,
    })
}

/// Qué tan bien coincide una app instalada con lo que se pidió (0: nada).
pub(super) fn desktop_score(entry: &DesktopEntry, wanted: &str) -> u8 {
    let wanted = wanted.trim().to_lowercase();
    let wanted = wanted.trim_end_matches(".desktop");
    if wanted.is_empty() {
        return 0;
    }
    let program = entry.exec.split_whitespace().next().map(stem).unwrap_or_default();
    if entry.id == wanted || entry.id.rsplit('.').next() == Some(wanted) || entry.names.iter().any(|name| name == wanted) {
        3
    } else if program == wanted {
        2
    } else if entry.names.iter().any(|name| name.contains(wanted)) || entry.id.contains(wanted) {
        1
    } else {
        0
    }
}

/// Carpetas de aplicaciones instaladas, en el orden de la especificación XDG.
fn application_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    let home = std::env::var_os("HOME").map(PathBuf::from);
    match std::env::var_os("XDG_DATA_HOME").filter(|value| !value.is_empty()) {
        Some(data) => dirs.push(PathBuf::from(data).join("applications")),
        None => dirs.extend(home.iter().map(|home| home.join(".local/share/applications"))),
    }
    let data_dirs = std::env::var("XDG_DATA_DIRS").ok().filter(|value| !value.is_empty()).unwrap_or_else(|| "/usr/local/share:/usr/share".into());
    dirs.extend(data_dirs.split(':').filter(|dir| !dir.is_empty()).map(|dir| PathBuf::from(dir).join("applications")));
    dirs.extend(home.iter().map(|home| home.join(".local/share/flatpak/exports/share/applications")));
    dirs.push(PathBuf::from("/var/lib/flatpak/exports/share/applications"));
    let mut seen = HashSet::new();
    dirs.retain(|dir| seen.insert(dir.clone()));
    dirs
}

/// La app instalada que mejor coincide con `wanted`.
fn find_desktop(wanted: &str) -> Option<DesktopEntry> {
    let mut best: Option<(u8, DesktopEntry)> = None;
    for dir in application_dirs() {
        for file in walkdir::WalkDir::new(&dir).max_depth(3).into_iter().filter_map(Result::ok) {
            let path = file.path();
            if path.extension().and_then(|ext| ext.to_str()) != Some("desktop") {
                continue;
            }
            let Some(entry) = std::fs::read_to_string(path).ok().and_then(|text| parse_desktop(path, &text)) else { continue };
            let score = desktop_score(&entry, wanted);
            if score > 0 && best.as_ref().is_none_or(|(old, _)| score > *old) {
                best = Some((score, entry));
            }
        }
    }
    best.map(|(_, entry)| entry)
}

/// Apps que solo publican su árbol de accesibilidad si estaba activa al arrancar
/// (Chromium y derivados, Electron; Firefox y Thunderbird pueden necesitarlo también).
const STARTUP_ONLY: [&str; 26] = ["brave", "brave-browser", "chrome", "google-chrome", "google-chrome-stable", "chromium", "chromium-browser",
    "msedge", "microsoft-edge", "vivaldi", "vivaldi-bin", "opera", "electron", "code", "codium", "cursor", "discord", "slack", "spotify",
    "obsidian", "signal-desktop", "teams-for-linux", "firefox", "librewolf", "thunderbird", "zen"];

/// Si un proceso es la ventana principal de una de esas apps (no un proceso hijo
/// de Chromium o Firefox), su nombre.
pub(super) fn startup_only_app(args: &[String]) -> Option<String> {
    // Chromium reescribe su línea de comandos con espacios en vez de separadores
    // nulos: todo llega como un solo argumento.
    let words: Vec<&str> = args.iter().flat_map(|arg| arg.split_whitespace()).collect();
    let program = words.first()?.rsplit('/').next()?.to_lowercase();
    let child = words.iter().any(|word| word.starts_with("--type=") || *word == "-contentproc" || word.contains("crashpad"));
    (!child && STARTUP_ONLY.contains(&program.as_str())).then_some(program)
}

/// Si una app aparece entre las registradas en el bus (por su nombre de app o de proceso).
pub(super) fn exposed(app: &str, registered: &[String]) -> bool {
    let app = app.trim_end_matches("-browser").trim_end_matches("-stable").trim_end_matches("-bin");
    registered.iter().map(|name| name.to_lowercase()).filter(|name| name.chars().count() >= 3)
        .any(|name| name == app || name.contains(app) || app.contains(name.as_str()))
}

/// Por qué una app abierta no aparece, y qué hacer.
fn unexposed_note(apps: &[String]) -> String {
    format!("Running but not exposed to accessibility: {}. Chromium-based browsers and Electron apps only expose their windows if \
accessibility was on when they started (Trex has it on now). Ask the user to close the app completely and open it again; do not restart it \
yourself (the user would lose open tabs or work).", apps.join(", "))
}

/// Programas que ejecutan a otros: su nombre no dice qué app es.
fn interpreter(name: &str) -> bool {
    ["python", "perl", "ruby", "node", "gjs", "bash", "sh", "java", "mono", "dotnet", "env", "bwrap"].iter().any(|prefix| name.starts_with(prefix))
}

/// Nombre del proceso, en minúsculas: «nautilus», «gnome-text-editor».
fn process_name(pid: u32) -> String {
    let exe = std::fs::read_link(format!("/proc/{pid}/exe")).ok().and_then(|path| path.file_name().map(|name| name.to_string_lossy().to_lowercase()));
    let comm = std::fs::read_to_string(format!("/proc/{pid}/comm")).ok().map(|text| text.trim().to_lowercase()).filter(|text| !text.is_empty());
    match exe {
        Some(exe) if !interpreter(&exe) => exe.trim_end_matches(" (deleted)").to_owned(),
        exe => comm.or(exe).unwrap_or_else(|| format!("pid{pid}")),
    }
}

// --- Motor ---------------------------------------------------------------------------

/// Una ventana: su clave estable y su objeto.
#[derive(Clone, Debug)]
struct WindowRef {
    key: isize,
    obj: Obj,
}

#[derive(Clone, Debug)]
struct WindowInfo {
    key: isize,
    obj: Obj,
    title: String,
    app: String,
    app_name: String,
    minimized: bool,
    active: bool,
}
impl WindowInfo {
    fn line(&self) -> String {
        let mut line = format!("w{:X} {} {}", self.key, self.app, quote(&self.title, 100));
        if self.minimized {
            line.push_str(" minimized");
        }
        if self.active {
            line.push_str(" foreground");
        }
        line
    }
    fn reference(&self) -> WindowRef {
        WindowRef { key: self.key, obj: self.obj.clone() }
    }
}

#[derive(Clone, Debug)]
struct Target {
    obj: Obj,
    parent: Option<Obj>,
    window: WindowRef,
}

/// Un elemento recorrido. La clave (ruta de rol y nombre desde la ventana) sirve
/// para saber qué es nuevo tras una acción.
struct Entry {
    key: String,
    node: Node,
    obj: Obj,
    parent: Option<Obj>,
    referenced: bool,
}

struct Walk {
    entries: Vec<Entry>,
    truncated: bool,
}

/// Tiene barras de desplazamiento accesibles como hijos.
fn has_scrollbar(raws: &[Raw], index: usize) -> bool {
    raws[index].kids.iter().any(|kid| raws[*kid].info.role == r::SCROLL_BAR && raws[*kid].info.ifaces.has(Ifaces::VALUE))
}

/// Convierte un árbol leído en las líneas del snapshot (sin la raíz).
fn build(raws: &[Raw], interactive_only: bool, max_elements: usize) -> Walk {
    struct Builder<'a> {
        raws: &'a [Raw],
        interactive_only: bool,
        max_elements: usize,
        entries: Vec<Entry>,
        truncated: bool,
    }
    impl Builder<'_> {
        fn visit(&mut self, index: usize, indent: usize, path: &str) {
            if self.truncated {
                return;
            }
            let raw = &self.raws[index];
            let parent = raw.parent.map(|parent| &self.raws[parent]);
            let parent_selection = parent.is_some_and(|parent| parent.info.ifaces.has(Ifaces::SELECTION));
            let described = describe(raw, parent_selection, has_scrollbar(self.raws, index));
            let role = described.node.role;
            // Barras de desplazamiento y de título: ruido para el agente (hay herramientas propias).
            if self.interactive_only && matches!(role, "scrollbar" | "titlebar" | "separator") {
                return;
            }
            let key = if titled(role) { format!("{path}/{role}") } else { format!("{path}/{role}:{}", described.node.name) };
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
                self.entries.push(Entry { key: key.clone(), node, obj: raw.obj.clone(), parent: parent.map(|parent| parent.obj.clone()), referenced: described.referenced });
                next_indent += 1;
            }
            for kid in raw.kids.clone() {
                self.visit(kid, next_indent, &key);
            }
        }
    }
    let mut builder = Builder { raws, interactive_only, max_elements, entries: Vec::new(), truncated: false };
    if let Some(root) = raws.first() {
        for kid in root.kids.clone() {
            builder.visit(kid, 0, "");
        }
    }
    Walk { entries: builder.entries, truncated: builder.truncated }
}

/// El texto de un elemento de texto estático (no de un control), si tiene.
fn static_text(node: &Node) -> Option<String> {
    matches!(node.role, "text" | "heading").then(|| node.name.trim().to_owned()).filter(|name| !name.is_empty())
}

/// Lo que había antes de una acción, para decir después qué cambió.
struct Before {
    window: WindowRef,
    title: Option<String>,
    entries: HashMap<String, VecDeque<Signature>>,
    texts: HashMap<String, usize>,
    windows: HashSet<isize>,
}

enum Outcome {
    Done,
    Refused,
    Pending,
}

pub struct AtspiEngine {
    bus: Bus,
    refs: HashMap<String, Target>,
    kept: VecDeque<u32>,
    next: u32,
    /// Proceso de cada aplicación del bus (por nombre único).
    processes: HashMap<String, String>,
    keyboard: bool,
    locks: Locks,
    epoch: Instant,
    /// Último atajo enviado por Trex (ms desde `epoch`), para no tomarlo por la persona.
    own_input: Option<(u32, u32)>,
    portal: Option<portal::Keyboard>,
    /// Dentro de un lote: cada paso no informa cambios (lo hace el lote al final).
    quiet: bool,
}

impl AtspiEngine {
    pub fn new(keyboard: bool) -> anyhow::Result<Self> {
        Ok(Self { bus: Bus::connect()?, refs: HashMap::new(), kept: VecDeque::new(), next: 0, processes: HashMap::new(), keyboard,
            locks: Locks::default(), epoch: Instant::now(), own_input: None, portal: None, quiet: false })
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

    fn now_ms(&self) -> u32 {
        self.epoch.elapsed().as_millis() as u32
    }

    /// Milisegundos desde la última entrada de la persona (u32::MAX si el
    /// escritorio no lo dice: fuera de GNOME).
    fn idle_ms(&self) -> u32 {
        let Some(session) = self.bus.session() else { return u32::MAX };
        let Some(idle) = self.bus.block(bus::idle_ms(session)) else { return u32::MAX };
        let now = self.now_ms();
        user_idle(now, Some(now.wrapping_sub(idle.min(u64::from(u32::MAX / 2)) as u32)), self.own_input)
    }

    fn idle_known(&self) -> bool {
        self.bus.session().is_some_and(|session| self.bus.block(bus::idle_ms(session)).is_some())
    }

    fn states(&self, obj: &Obj) -> Result<States, ToolError> {
        self.bus.block(bus::states(self.bus.conn(), obj))
    }

    fn actions(&self, obj: &Obj) -> Vec<String> {
        self.bus.block(bus::actions(self.bus.conn(), obj)).unwrap_or_default()
    }

    fn read_text(&self, obj: &Obj) -> Option<String> {
        self.bus.block(bus::text(self.bus.conn(), obj, 0, -1)).ok().map(|text| lines(&text))
    }

    fn process(&mut self, bus_name: &str) -> String {
        if let Some(name) = self.processes.get(bus_name) {
            return name.clone();
        }
        let name = self.bus.block(bus::process_id(self.bus.conn(), bus_name)).map(process_name).unwrap_or_else(|_| "unknown".into());
        self.processes.insert(bus_name.to_owned(), name.clone());
        name
    }

    /// Apps abiertas de la persona que no están en el bus de accesibilidad aunque
    /// deberían (arrancaron antes de que se activara).
    fn unexposed(&mut self) -> Vec<String> {
        use std::os::unix::fs::MetadataExt;
        let conn = self.bus.conn().clone();
        let apps = self.bus.block(async {
            let apps = bus::children(&conn, &bus::registry_root()).await.unwrap_or_default();
            stream::iter(apps).map(|app| { let conn = &conn; async move { (bus::name(conn, &app).await.unwrap_or_default(), app.bus) } })
                .buffered(16).collect::<Vec<_>>().await
        });
        let mut registered = Vec::new();
        for (name, bus_name) in apps {
            registered.push(name);
            registered.push(self.process(&bus_name));
        }
        let uid = std::fs::metadata("/proc/self").map(|meta| meta.uid()).ok();
        let mut found: Vec<String> = Vec::new();
        for entry in std::fs::read_dir("/proc").into_iter().flatten().flatten() {
            if !entry.file_name().to_string_lossy().chars().all(|ch| ch.is_ascii_digit()) || entry.metadata().ok().map(|meta| meta.uid()) != uid {
                continue;
            }
            let Ok(raw) = std::fs::read(entry.path().join("cmdline")) else { continue };
            let args: Vec<String> = raw.split(|byte| *byte == 0).filter(|part| !part.is_empty()).map(|part| String::from_utf8_lossy(part).into_owned()).collect();
            if let Some(app) = startup_only_app(&args) {
                if !found.contains(&app) && !exposed(&app, &registered) {
                    found.push(app);
                }
            }
        }
        found
    }

    /// Ventanas de primer nivel visibles de todas las aplicaciones.
    fn windows(&mut self) -> Vec<WindowInfo> {
        let conn = self.bus.conn().clone();
        let apps = self.bus.block(async {
            let apps = bus::children(&conn, &bus::registry_root()).await.unwrap_or_default();
            stream::iter(apps)
                .map(|app| {
                    let conn = &conn;
                    async move {
                        let (name, kids) = tokio::join!(bus::name(conn, &app), bus::children(conn, &app));
                        let kids: Vec<Obj> = kids.unwrap_or_default().into_iter().take(64).collect();
                        let infos = stream::iter(kids.clone()).map(|kid| async move { bus::info(conn, &kid, false).await }).buffered(16).collect::<Vec<_>>().await;
                        (app, name.unwrap_or_default(), kids.into_iter().zip(infos).collect::<Vec<_>>())
                    }
                })
                .buffered(16)
                .collect::<Vec<_>>()
                .await
        });
        let mut windows = Vec::new();
        for (app, app_name, kids) in apps {
            if SHELL_APPS.contains(&app_name.as_str()) {
                continue;
            }
            for (obj, info) in kids {
                let Ok(info) = info else { continue };
                if !matches!(info.role, r::FRAME | r::DIALOG | r::WINDOW | r::ALERT | r::FILE_CHOOSER | r::INTERNAL_FRAME)
                    || bus::hidden(info.states) || info.states.has(s::DEFUNCT) {
                    continue;
                }
                let title = info.name.trim().to_owned();
                // Sin título: una ventana principal o un diálogo se listan; las emergentes
                // sin nombre (menús, sugerencias) no.
                if title.is_empty() && (info.role == r::WINDOW || !info.states.has(s::SHOWING)) {
                    continue;
                }
                let process = self.process(&app.bus);
                windows.push(WindowInfo {
                    key: window_key(&obj),
                    obj,
                    title: if title.is_empty() { "(untitled)".into() } else { title },
                    app: process,
                    app_name: app_name.to_lowercase(),
                    minimized: info.states.has(s::ICONIFIED),
                    active: info.states.has(s::ACTIVE),
                });
            }
        }
        windows
    }

    fn active_window(&mut self) -> Option<isize> {
        self.windows().into_iter().find(|window| window.active).map(|window| window.key)
    }

    /// Ventana por `window_id` o por `app` (proceso, nombre de la app o parte del título, si solo coincide una).
    fn resolve_window(&mut self, args: &Value) -> Result<WindowInfo, ToolError> {
        let windows = self.windows();
        if let Some(id) = args["window_id"].as_str() {
            let key = parse_window_id(id).ok_or_else(|| ToolError::new("INVALID_ARGS", format!("Invalid window_id {id}.")))?;
            return windows.into_iter().find(|window| window.key == key)
                .ok_or_else(|| ToolError::new("NOT_FOUND", format!("Window {id} is no longer open. Use a11y_list_windows.")));
        }
        let Some(app) = args["app"].as_str().map(str::to_lowercase).filter(|app| !app.trim().is_empty()) else {
            return Err(ToolError::new("INVALID_ARGS", "Pass window_id or app (see a11y_list_windows)."));
        };
        let app = app.trim().to_owned();
        let matches: Vec<_> = windows.into_iter().filter(|window| {
            window.app == app || window.app_name == app || window.app_name.rsplit('.').next() == Some(app.as_str()) || window.title.to_lowercase().contains(&app)
        }).collect();
        match matches.len() {
            0 => {
                let hidden: Vec<String> = self.unexposed().into_iter().filter(|name| name.contains(app.as_str()) || app.contains(name.as_str())).collect();
                if hidden.is_empty() {
                    Err(ToolError::new("NOT_FOUND", format!("No open window matches {app}. Use a11y_list_windows or a11y_launch.")))
                } else {
                    Err(ToolError::new("NOT_EXPOSED", unexposed_note(&hidden)))
                }
            }
            1 => Ok(matches.into_iter().next().unwrap()),
            _ => {
                let list = matches.iter().take(8).map(WindowInfo::line).collect::<Vec<_>>().join("\n");
                Err(ToolError::new("AMBIGUOUS", format!("Several windows match {app}; pass window_id:\n{list}")))
            }
        }
    }

    fn window_active(&self, window: &WindowRef) -> bool {
        self.states(&window.obj).is_ok_and(|states| states.has(s::ACTIVE))
    }

    /// No actuar sobre la ventana que la persona está usando ahora mismo, ni sobre
    /// la que usa otro agente de Trex. Si la persona la está usando, se espera un
    /// poco a que haga una pausa. Devuelve la ventana activa de antes.
    /// Un control desactivado no se toca (la app ignoraría la acción).
    fn enabled(&self, obj: &Obj) -> Result<(), ToolError> {
        let states = self.states(obj)?;
        if states.has(s::SENSITIVE) || states.has(s::ENABLED) {
            Ok(())
        } else {
            Err(ToolError::new("DISABLED", "The element is disabled."))
        }
    }

    fn guard(&mut self, window: &WindowRef) -> Result<Option<isize>, ToolError> {
        let deadline = Instant::now() + PAUSE_WAIT;
        while user_active(self.window_active(window), self.idle_ms()) && Instant::now() < deadline {
            sleep(Duration::from_millis(100));
        }
        let idle = self.idle_ms();
        if user_active(self.window_active(window), idle) {
            return Err(ToolError::new("USER_ACTIVE", format!(
                "The user kept working in this window for {} s (last input {idle} ms ago). Nothing was done; wait a few seconds with a11y_wait and retry.",
                PAUSE_WAIT.as_secs())));
        }
        self.claim(window.key)?;
        Ok(self.active_window())
    }

    fn claim(&mut self, window: isize) -> Result<(), ToolError> {
        self.locks.claim(window).map_err(|owner| ToolError::new("WINDOW_BUSY", format!(
            "Another Trex agent (process {owner}) is working in this window. Nothing was done; use another window or try again in a minute.")))
    }

    /// Tras una acción: si cambió la ventana activa. En Wayland Trex no puede
    /// devolver el foco: solo lo dice.
    fn focus_note(&mut self, before: Option<isize>, window: &WindowRef) -> String {
        let windows = self.windows();
        if !windows.iter().any(|open| open.key == window.key) {
            // La ventana se cerró: que el foco pase a otra es lo normal.
            return String::new();
        }
        match (before, windows.iter().find(|open| open.active).map(|open| open.key)) {
            (Some(before), Some(after)) if after != before && after == window.key => " Note: the window came to the front.".into(),
            (Some(before), Some(after)) if after != before => format!(" Note: the active window is now w{after:X} (the application may have opened a dialog)."),
            _ => String::new(),
        }
    }

    /// Recorre una ventana o un elemento.
    fn walk(&mut self, root: &Obj, interactive_only: bool, max_depth: usize, max_elements: usize) -> Result<Walk, ToolError> {
        let fetch = Fetch { max_depth, max_nodes: (max_elements * 12).clamp(1_500, 8_000), texts: !interactive_only, prune_hidden: true };
        let (raws, cut) = self.bus.tree(root, fetch)?;
        let mut walk = build(&raws, interactive_only, max_elements);
        walk.truncated |= cut;
        Ok(walk)
    }

    /// Da referencia a lo que tiene acciones y lo convierte en líneas.
    fn render(&mut self, entries: Vec<Entry>, window: &WindowRef, id: u32, base_depth: usize, counter: &mut usize) -> Vec<String> {
        let mut lines = Vec::new();
        for entry in entries {
            *counter += 1;
            let mut node = entry.node;
            node.depth = node.depth.saturating_sub(base_depth);
            if entry.referenced {
                let reference = format!("@s{id}:e{counter}");
                node.reference = Some(reference.clone());
                self.refs.insert(reference, Target { obj: entry.obj, parent: entry.parent, window: window.clone() });
            }
            lines.push(format_node(&node));
        }
        lines
    }

    fn title(&self, window: &WindowRef) -> Option<String> {
        self.bus.block(bus::name(self.bus.conn(), &window.obj)).ok()
    }

    fn before(&mut self, window: &WindowRef) -> Before {
        if self.quiet {
            return Before { window: window.clone(), title: None, entries: HashMap::new(), texts: HashMap::new(), windows: HashSet::new() };
        }
        let mut entries: HashMap<String, VecDeque<Signature>> = HashMap::new();
        let mut texts: HashMap<String, usize> = HashMap::new();
        for entry in self.walk(&window.obj, false, 25, 1_500).map(|walk| walk.entries).unwrap_or_default() {
            if entry.referenced {
                entries.entry(entry.key).or_default().push_back(Signature::of(&entry.node));
            } else if let Some(name) = static_text(&entry.node) {
                *texts.entry(name).or_insert(0) += 1;
            }
        }
        let windows = self.windows().into_iter().map(|window| window.key).collect();
        Before { window: window.clone(), title: self.title(window), entries, texts, windows }
    }

    /// Ventanas que no estaban, con sus elementos (y referencias).
    fn new_windows(&mut self, known: &HashSet<isize>, slot: &mut Option<u32>, counter: &mut usize) -> String {
        let mut text = String::new();
        let fresh: Vec<_> = self.windows().into_iter().filter(|window| !known.contains(&window.key)).take(3).collect();
        for info in fresh {
            text.push_str(&format!("\nNew window {}", info.line()));
            let Ok(walk) = self.walk(&info.obj, true, 25, NEW_WINDOW_LINES) else { continue };
            if walk.entries.is_empty() {
                continue;
            }
            let id = *slot.get_or_insert_with(|| self.begin_snapshot());
            let lines = self.render(walk.entries, &info.reference(), id, 0, counter);
            text.push_str(&format!(" (snapshot s{id}):\n{}", lines.join("\n")));
        }
        text
    }

    fn changes(&mut self, before: Before, acted: Option<&Obj>) -> String {
        self.changes_except(before, acted.map(std::slice::from_ref).unwrap_or_default())
    }

    /// Qué cambió tras una acción: el título, elementos nuevos, elementos que
    /// cambiaron (valor, estado, foco) o entraron en la vista, y ventanas nuevas.
    fn changes_except(&mut self, before: Before, acted: &[Obj]) -> String {
        if self.quiet {
            return String::new();
        }
        sleep(Duration::from_millis(250));
        let mut slot = None;
        let mut counter = 0;
        let mut text = String::new();
        let open = self.windows().iter().any(|window| window.key == before.window.key);
        if open {
            let title = self.title(&before.window);
            let retitled = matches!((&before.title, &title), (Some(old), Some(new)) if old != new);
            if retitled {
                text.push_str(&format!("\nWindow title is now {}.", quote(title.as_deref().unwrap_or(""), 100)));
            }
            if let Ok(walk) = self.walk(&before.window.obj, false, 25, 1_500) {
                let mut remaining = before.entries;
                let mut texts = before.texts;
                let (mut fresh, mut changed, mut shown) = (Vec::new(), Vec::new(), Vec::new());
                let mut new_texts: Vec<String> = Vec::new();
                for entry in walk.entries {
                    if !entry.referenced {
                        if let Some(name) = static_text(&entry.node) {
                            match texts.get_mut(&name) {
                                Some(count) if *count > 0 => *count -= 1,
                                _ if !new_texts.contains(&name) => new_texts.push(name),
                                _ => {}
                            }
                        }
                        continue;
                    }
                    match remaining.get_mut(&entry.key).and_then(VecDeque::pop_front) {
                        None => fresh.push(entry),
                        Some(old) => match change(&old, &Signature::of(&entry.node)) {
                            Change::Changed => changed.push(entry),
                            Change::Shown => shown.push(entry),
                            Change::Same => {}
                        },
                    }
                }
                changed.retain(|entry| !acted.contains(&entry.obj));
                let gone: usize = remaining.values().map(VecDeque::len).sum();
                let quiet = fresh.is_empty() && changed.is_empty() && shown.is_empty() && new_texts.is_empty() && gone == 0 && !retitled;
                let window = before.window.clone();
                self.section(&mut text, "New in the window", fresh, CHANGE_LINES, true, &window, &mut slot, &mut counter);
                self.section(&mut text, "Changed", changed, CHANGED_LINES, false, &window, &mut slot, &mut counter);
                self.section(&mut text, "Now visible", shown, CHANGE_LINES, true, &window, &mut slot, &mut counter);
                if !new_texts.is_empty() {
                    text.push_str("\nNew text:");
                    for line in new_texts.iter().take(NEW_TEXT_LINES) {
                        text.push_str(&format!("\n- {}", quote(line, 160)));
                    }
                    if new_texts.len() > NEW_TEXT_LINES {
                        text.push_str(&format!("\n…and {} more (read them with a11y_snapshot format:\"text\").", new_texts.len() - NEW_TEXT_LINES));
                    }
                }
                if quiet {
                    text.push_str("\nNo visible change in the window.");
                }
                if gone > 0 {
                    text.push_str(&format!("\n{gone} elements disappeared."));
                }
            }
        } else {
            text.push_str("\nThe window closed.");
        }
        text + &self.new_windows(&before.windows, &mut slot, &mut counter)
    }

    #[allow(clippy::too_many_arguments)]
    fn section(&mut self, text: &mut String, title: &str, entries: Vec<Entry>, limit: usize, tree: bool, window: &WindowRef, slot: &mut Option<u32>,
        counter: &mut usize) {
        if entries.is_empty() {
            return;
        }
        let total = entries.len();
        let base = if tree { entries.iter().map(|entry| entry.node.depth).min().unwrap_or(0) } else { usize::MAX };
        let id = *slot.get_or_insert_with(|| self.begin_snapshot());
        let lines = self.render(entries.into_iter().take(limit).collect(), window, id, base, counter);
        let more = if total > limit { format!(", first {limit} of {total}") } else { String::new() };
        text.push_str(&format!("\n{title} (snapshot s{id}{more}):\n{}", lines.join("\n")));
    }

    /// Hace una acción de AT-SPI con plazo: si la app no responde a tiempo (abrió
    /// un diálogo modal, por ejemplo) se da por pendiente.
    fn act(&self, obj: &Obj, index: usize) -> Result<Outcome, ToolError> {
        match self.bus.block(bus::do_action(self.bus.conn(), obj, index)) {
            Ok(true) => Ok(Outcome::Done),
            Ok(false) => Ok(Outcome::Refused),
            Err(error) if error.code == "UNCERTAIN" => Ok(Outcome::Pending),
            Err(error) => Err(error),
        }
    }

    /// Espera a que los estados de un elemento cumplan algo (hasta `ms`).
    fn settle(&self, obj: &Obj, ms: u64, done: impl Fn(States) -> bool) -> Option<States> {
        let deadline = Instant::now() + Duration::from_millis(ms);
        loop {
            let states = self.states(obj).ok();
            if states.is_some_and(&done) || Instant::now() >= deadline {
                return states;
            }
            sleep(Duration::from_millis(50));
        }
    }

    // --- Lectura -------------------------------------------------------------------

    fn list_windows(&mut self, args: &Value) -> ToolResult {
        let filter = args["app"].as_str().map(str::to_lowercase).filter(|text| !text.is_empty());
        let lines: Vec<String> = self.windows().iter()
            .filter(|window| filter.as_ref().is_none_or(|text| window.app.contains(text.as_str()) || window.app_name.contains(text.as_str()) || window.title.to_lowercase().contains(text.as_str())))
            .map(WindowInfo::line)
            .collect();
        let hidden: Vec<String> = self.unexposed().into_iter()
            .filter(|app| filter.as_ref().is_none_or(|text| app.contains(text.as_str()) || text.contains(app.as_str())))
            .collect();
        let mut text = if lines.is_empty() {
            "No matching windows. (Apps appear here when they expose accessibility: GTK, Qt, Firefox, Chromium and Electron apps do.)".to_owned()
        } else {
            format!("{} windows (id app \"title\" state):\n{}", lines.len(), lines.join("\n"))
        };
        if !hidden.is_empty() {
            text.push_str(&format!("\n{}", unexposed_note(&hidden)));
        }
        Ok(text)
    }

    fn snapshot(&mut self, args: &Value) -> ToolResult {
        let interactive_only = args["interactive_only"].as_bool().unwrap_or(true);
        let max_depth = args["max_depth"].as_u64().unwrap_or(25).min(60) as usize;
        let max_elements = args["max_elements"].as_u64().unwrap_or(300).clamp(1, 1000) as usize;
        let (root, window, header) = if args["root"].is_string() {
            let target = self.target(&serde_json::json!({"ref_id": args["root"]}))?;
            (target.obj, target.window, format!("subtree of {}", args["root"].as_str().unwrap_or("")))
        } else {
            let info = self.resolve_window(args)?;
            let header = format!("window w{:X} {} ({})", info.key, quote(&info.title, 100), info.app);
            (info.obj.clone(), info.reference(), header)
        };
        if args["format"].as_str() == Some("text") {
            return self.read_page(&root, &header, args, max_depth);
        }
        let started = Instant::now();
        let walk = self.walk(&root, interactive_only, max_depth, max_elements)?;
        let id = self.begin_snapshot();
        let (count, truncated) = (walk.entries.len(), walk.truncated);
        let lines = self.render(walk.entries, &window, id, 0, &mut 0);
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

    /// El texto de una ventana o de una parte, sin referencias, por páginas de líneas.
    fn read_page(&mut self, root: &Obj, header: &str, args: &Value, max_depth: usize) -> ToolResult {
        let limit = args["max_elements"].as_u64().unwrap_or(300).clamp(1, 1000) as usize;
        let offset = args["offset"].as_u64().unwrap_or(0) as usize;
        let walk = self.walk(root, false, max_depth, 5_000)?;
        let mut text: Vec<String> = Vec::new();
        for entry in &walk.entries {
            let node = &entry.node;
            let name = node.name.trim();
            let value = node.value.as_deref().map(str::trim).filter(|value| !value.is_empty() && *value != name && !value.contains("://"));
            let piece = match (name.is_empty(), value) {
                (false, Some(value)) => format!("{name}: {value}"),
                (false, None) => name.to_owned(),
                (true, Some(value)) => value.to_owned(),
                (true, None) => continue,
            };
            for line in lines(&piece).lines().map(str::trim).filter(|line| !line.is_empty()) {
                if text.last().is_none_or(|last| last != line) {
                    text.push(line.to_owned());
                }
            }
        }
        let total = text.len();
        let from = offset.min(total);
        let to = (from + limit).min(total);
        let mut result = format!("{header} · text · lines {}-{to} of {total}", from + usize::from(to > from));
        if walk.truncated {
            result.push_str(" · the window has more elements than were read: narrow it with root");
        }
        if to < total {
            result.push_str(&format!(" · more with offset={to}"));
        }
        result.push('\n');
        result.push_str(&text[from..to].join("\n"));
        Ok(result)
    }

    /// Varias acciones seguidas en una llamada, con un solo informe de cambios al final.
    fn batch(&mut self, args: &Value, cancel: &AtomicBool) -> ToolResult {
        let steps = args["steps"].as_array().filter(|steps| (1..=super::MAX_BATCH).contains(&steps.len()))
            .ok_or_else(|| ToolError::new("INVALID_ARGS", format!("steps must list 1 to {} steps.", super::MAX_BATCH)))?
            .clone();
        let window = steps.iter().find_map(|step| match step["ref_id"].as_str() {
            Some(reference) => self.refs.get(reference).map(|target| target.window.clone()),
            None if step["window_id"].is_string() || step["app"].is_string() => self.resolve_window(step).ok().map(|info| info.reference()),
            None => None,
        });
        let seen = window.map(|window| self.before(&window));
        let acted: Vec<Obj> = steps.iter().filter_map(|step| step["ref_id"].as_str()).filter_map(|reference| self.refs.get(reference)).map(|target| target.obj.clone()).collect();
        self.quiet = true;
        let mut done = Vec::new();
        let mut failure = None;
        for (index, step) in steps.iter().enumerate() {
            let tool = step["tool"].as_str().unwrap_or("").to_owned();
            if cancel.load(Ordering::SeqCst) {
                failure = Some((index, tool, ToolError::new("CANCELLED", "Cancelled.")));
                break;
            }
            match self.call(&tool, step, cancel) {
                Ok(text) => done.push(format!("{}. {tool}: {}", index + 1, text.trim())),
                Err(error) => {
                    failure = Some((index, tool, error));
                    break;
                }
            }
        }
        self.quiet = false;
        let report = seen.map(|seen| self.changes_except(seen, &acted)).unwrap_or_default();
        let completed = if done.is_empty() { "none".to_owned() } else { format!("\n{}", done.join("\n")) };
        match failure {
            None => Ok(format!("Batch completed ({} steps):{completed}{report}", steps.len())),
            Some((index, tool, error)) => Err(ToolError::new(error.code, format!(
                "step {} ({tool}) failed: {}\nCompleted, do not repeat: {completed}{report}", index + 1, error.message))),
        }
    }

    /// Elementos de una ventana que coinciden con un rol y/o un nombre.
    fn matches(&mut self, args: &Value) -> Result<(WindowInfo, Vec<Entry>), ToolError> {
        let info = self.resolve_window(args)?;
        let role = args["role"].as_str().map(str::to_lowercase).filter(|text| !text.is_empty());
        let name = args["name"].as_str().map(str::to_lowercase).filter(|text| !text.is_empty());
        let walk = self.walk(&info.obj, false, 40, 5_000)?;
        let found = walk.entries.into_iter().filter(|entry| {
            role.as_ref().is_none_or(|role| entry.node.role == role) && name.as_ref().is_none_or(|name| entry.node.name.to_lowercase().contains(name))
        }).collect();
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
        let window = info.reference();
        let mut lines = Vec::new();
        for (index, entry) in found.into_iter().take(limit).enumerate() {
            let reference = format!("@s{id}:e{}", index + 1);
            let mut node = entry.node;
            node.depth = 0;
            node.reference = Some(reference.clone());
            lines.push(format_node(&node));
            self.refs.insert(reference, Target { obj: entry.obj, parent: entry.parent, window: window.clone() });
        }
        Ok(format!("find s{id} in w{:X} · {total} matches{}\n{}", info.key,
            if total > limit { format!(", first {limit}") } else { String::new() },
            if lines.is_empty() { "(none)".into() } else { lines.join("\n") }))
    }

    /// Un elemento leído de nuevo, como en el árbol.
    fn describe_now(&self, target: &Target) -> Result<Described, ToolError> {
        let conn = self.bus.conn().clone();
        let (raw, parent_selection) = self.bus.block(async {
            let info = bus::info(&conn, &target.obj, true).await?;
            let mut nodes = [Raw { obj: target.obj.clone(), info, ..Raw::default() }];
            bus::extras(&conn, &mut nodes, false).await;
            let [raw] = nodes;
            let parent_selection = match &target.parent {
                Some(parent) => bus::ifaces(&conn, parent).await.is_ok_and(|ifaces| ifaces.has(Ifaces::SELECTION)),
                None => false,
            };
            Ok::<_, ToolError>((raw, parent_selection))
        })?;
        let scrollable = self.bus.block(async {
            let kids = stream::iter(raw.info.children.clone()).map(|kid| {
                let conn = &conn;
                async move { tokio::join!(bus::role(conn, &kid), bus::ifaces(conn, &kid)) }
            }).buffered(16).collect::<Vec<_>>().await;
            kids.into_iter().any(|(role, ifaces)| role.ok() == Some(r::SCROLL_BAR) && ifaces.is_ok_and(|ifaces| ifaces.has(Ifaces::VALUE)))
        });
        Ok(describe(&raw, parent_selection, scrollable))
    }

    fn get(&mut self, args: &Value) -> ToolResult {
        let target = self.target(args)?;
        let property = args["property"].as_str().unwrap_or("all");
        let described = self.describe_now(&target)?;
        let password = described.node.states.contains(&"password");
        if password && matches!(property, "value" | "text") {
            return Err(ToolError::new("PASSWORD", "Trex never reads password fields."));
        }
        let clip = |text: String| -> String {
            let total = text.chars().count();
            if total > MAX_TEXT as usize { format!("{}…({total} chars)", text.chars().take(MAX_TEXT as usize).collect::<String>()) } else { text }
        };
        let conn = self.bus.conn().clone();
        match property {
            "value" => self.value_of(&target, &described).map(clip).ok_or_else(|| ToolError::new("NO_VALUE", "The element has no value.")),
            "text" => {
                let ifaces = self.bus.block(bus::ifaces(&conn, &target.obj)).unwrap_or_default();
                let document = ifaces.has(Ifaces::TEXT).then(|| self.bus.block(bus::text(&conn, &target.obj, 0, MAX_TEXT + 1)).ok()).flatten()
                    .map(|text| bus::plain(&lines(&text)).trim().to_owned().replace(" \n", "\n")).filter(|text| !text.is_empty());
                let full = match document {
                    Some(text) => Some(text),
                    None => {
                        // Sin Text propio (un contenedor de una página): el texto de lo que contiene.
                        let walk = self.walk(&target.obj, false, 30, 5_000).ok();
                        walk.map(|walk| walk.entries.iter().map(|entry| entry.node.name.trim().to_owned()).filter(|name| !name.is_empty()).collect::<Vec<_>>().join("\n"))
                            .filter(|text| !text.is_empty())
                    }
                };
                Ok(clip(full.or_else(|| self.value_of(&target, &described)).unwrap_or_else(|| described.node.name.clone())))
            }
            "name" => Ok(described.node.name.clone()),
            "bounds" => self.bus.block(bus::extents(&conn, &target.obj))
                .map(|(x, y, width, height)| format!("x={x} y={y} width={width} height={height} (relative to its window: Wayland does not expose screen positions)")),
            "states" => Ok(if described.node.states.is_empty() { "enabled".into() } else { described.node.states.join(" ") }),
            "all" => {
                let mut node = described.node.clone();
                node.reference = args["ref_id"].as_str().map(str::to_owned);
                if !password {
                    node.value = self.value_of(&target, &described).filter(|text| !text.is_empty()).or(node.value);
                }
                Ok(format_node(&node))
            }
            other => Err(ToolError::new("INVALID_ARGS", format!("Unknown property {other}."))),
        }
    }

    /// El valor completo de un elemento: su texto (campos) o su número (deslizadores).
    fn value_of(&self, target: &Target, described: &Described) -> Option<String> {
        let conn = self.bus.conn();
        let ifaces = self.bus.block(bus::ifaces(conn, &target.obj)).unwrap_or_default();
        if ifaces.has(Ifaces::TEXT) && takes_text(described.node.role) {
            return self.bus.block(bus::text(conn, &target.obj, 0, MAX_TEXT + 1)).ok().map(|text| lines(&text));
        }
        if ifaces.has(Ifaces::VALUE) {
            return self.bus.block(bus::get_f64(conn, &target.obj, bus::VALUE, "CurrentValue")).ok().map(|number| number.to_string());
        }
        described.node.value.clone()
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
        let session = std::env::var("XDG_SESSION_TYPE").unwrap_or_else(|_| "unknown".into());
        let desktop = std::env::var("XDG_CURRENT_DESKTOP").unwrap_or_else(|_| "unknown".into());
        let idle = if self.idle_known() { format!("{} ms ago", self.idle_ms()) } else { "unknown (this desktop does not report it; only GNOME does)".into() };
        let active = self.active_window().map_or("none".to_owned(), |key| format!("w{key:X}"));
        Ok(format!(
            "engine: trex (Linux AT-SPI)\ndesktop: {desktop} ({session})\nactions keep the user's focus: yes (AT-SPI actions do not raise windows)\n\
accessibility for Chromium/Electron/Firefox/Qt: {}\nkeyboard shortcuts: {}\nuser last input: {idle}\nforeground window: {active}\nlive refs: {}\n\
limits: no on-screen highlight; bounds are relative to the window; Trex cannot bring windows to the front",
            if self.bus.enabled_by_trex() { "turned on by Trex while it is in use" } else { "already on" },
            if self.keyboard { "allowed (a11y_press, only into the window that is already active; GNOME asks the user once)" } else { "disabled in Trex settings" },
            self.refs.len()
        ))
    }

    // --- Acciones ------------------------------------------------------------------

    fn click(&mut self, args: &Value) -> ToolResult {
        let target = self.target(args)?;
        self.enabled(&target.obj)?;
        let actions = self.actions(&target.obj);
        let role = self.describe_now(&target)?.node.role;
        let index = click_action(&actions, role);
        let selectable = index.is_none() && target.parent.is_some() && self.states(&target.obj).is_ok_and(|states| states.has(s::SELECTABLE));
        if index.is_none() && !selectable {
            return Err(ToolError::new("NOT_ACTIONABLE", "The element cannot be activated semantically."));
        }
        let before = self.guard(&target.window)?;
        let hidden = !self.states(&target.obj).is_ok_and(|states| states.has(s::SHOWING));
        let seen = self.before(&target.window);
        let head = match index {
            Some(index) => match self.act(&target.obj, index)? {
                Outcome::Done => format!("Clicked ({}).", actions[index]),
                Outcome::Refused => return Err(ToolError::new("NOT_ACTIONABLE", "The application refused the action.")),
                Outcome::Pending => "Clicked; the application is still handling it (for example, a modal dialog opened).".into(),
            },
            None => {
                self.select_in_parent(&target)?;
                "Clicked (selected it in its container).".into()
            }
        };
        let mut changes = self.changes(seen, Some(&target.obj));
        if hidden && changes.contains("No visible change in the window.") {
            changes.push_str("\nThe element is off screen (hidden or scrolled away) and the app did not react; many apps ignore hidden controls. \
Bring it into view with a11y_scroll_to (or a11y_scroll) and click it again.");
        }
        Ok(format!("{head}{}{changes}", self.focus_note(before, &target.window)))
    }

    fn right_click(&mut self, args: &Value) -> ToolResult {
        let target = self.target(args)?;
        self.enabled(&target.obj)?;
        let actions = self.actions(&target.obj);
        let index = menu_action(&actions).ok_or_else(|| ToolError::new("NOT_SUPPORTED", "This element has no context-menu action."))?;
        let before = self.guard(&target.window)?;
        let seen = self.before(&target.window);
        let head = match self.act(&target.obj, index)? {
            Outcome::Done => "Context menu opened.".to_owned(),
            Outcome::Refused => return Err(ToolError::new("NOT_SUPPORTED", "The application refused to open the context menu.")),
            Outcome::Pending => "Context menu requested; the application is still handling it.".into(),
        };
        let changes = self.changes(seen, Some(&target.obj));
        Ok(format!("{head}{}{changes}", self.focus_note(before, &target.window)))
    }

    /// Elige un elemento en su contenedor (Selection) y lo comprueba.
    fn select_in_parent(&self, target: &Target) -> Result<(), ToolError> {
        let parent = target.parent.as_ref().ok_or_else(|| ToolError::new("NOT_SELECTABLE", "The element has no container to select it in."))?;
        let conn = self.bus.conn();
        let index = self.bus.block(bus::index_in_parent(conn, &target.obj))?;
        if index < 0 || !self.bus.block(bus::ifaces(conn, parent)).is_ok_and(|ifaces| ifaces.has(Ifaces::SELECTION)) {
            return Err(ToolError::new("NOT_SELECTABLE", "The element is not a selectable item; pass value to pick an option inside it."));
        }
        if !self.bus.block(bus::select_child(conn, parent, index))? {
            return Err(ToolError::new("NOT_KEPT", "The application refused the selection."));
        }
        Ok(())
    }

    /// Atajo de teclado real (solo con el permiso de Ajustes) por el portal
    /// RemoteDesktop. Wayland no deja traer ventanas al frente: solo va a la
    /// ventana que ya está activa.
    fn press(&mut self, args: &Value, cancel: &AtomicBool) -> ToolResult {
        if !self.keyboard {
            return Err(ToolError::new("NOT_ALLOWED", "Keyboard shortcuts are disabled in Trex settings."));
        }
        let combo = keys::parse(args["keys"].as_str().unwrap_or("")).map_err(|message| ToolError::new("INVALID_ARGS", message))?;
        let modifiers: Vec<u32> = combo.modifiers.iter().filter_map(|code| keys::keysym(*code)).collect();
        let key = keys::keysym(combo.key).ok_or_else(|| ToolError::new("INVALID_ARGS", format!("Unsupported key {}.", combo.label)))?;
        let (element, window) = if args["ref_id"].is_string() {
            let target = self.target(args)?;
            (Some(target.obj), target.window)
        } else {
            let info = self.resolve_window(args)?;
            (None, info.reference())
        };
        let idle = self.idle_ms();
        if idle < KEYBOARD_IDLE_MS {
            return Err(ToolError::new("USER_ACTIVE", format!(
                "The user is using the mouse or keyboard (last input {idle} ms ago); a shortcut now would mix with their typing. Nothing was done; wait and retry.")));
        }
        if !self.window_active(&window) {
            return Err(ToolError::new("FOCUS_FAILED", format!(
                "w{:X} is not the active window, and on Linux (Wayland) Trex cannot bring a window to the front. Nothing was typed. Use a semantic \
action (menus, buttons), or ask the user to switch to that window and retry.", window.key)));
        }
        self.claim(window.key)?;
        if self.portal.is_none() {
            // La primera vez GNOME pregunta a la persona si deja controlar el teclado.
            let started = self.bus.block(async {
                tokio::select! {
                    result = tokio::time::timeout(Duration::from_secs(120), portal::Keyboard::start()) => Some(result),
                    _ = async { while !cancel.load(Ordering::SeqCst) { tokio::time::sleep(Duration::from_millis(100)).await } } => None,
                }
            });
            match started {
                None => return Err(ToolError::new("CANCELLED", "Cancelled while waiting for the user's permission.")),
                Some(Err(_)) => return Err(ToolError::new("NOT_ALLOWED", "The user did not answer the keyboard permission request in time. Nothing was typed.")),
                Some(Ok(Err(error))) => return Err(ToolError::new("NOT_ALLOWED", format!(
                    "The keyboard permission was not granted ({error}). Nothing was typed; use menus and buttons instead."))),
                Some(Ok(Ok(keyboard))) => self.portal = Some(keyboard),
            }
            // La persona acaba de pulsar en el aviso: se deja que el foco vuelva.
            let deadline = Instant::now() + Duration::from_secs(3);
            while (!self.window_active(&window) || self.idle_ms() < 700) && Instant::now() < deadline {
                sleep(Duration::from_millis(100));
            }
            if !self.window_active(&window) {
                return Err(ToolError::new("FOCUS_FAILED", "Keyboard permission granted, but the window is no longer the active one. Nothing was typed; retry when it is."));
            }
        }
        if let Some(element) = &element {
            // Dentro de la ventana activa, el foco va al elemento (sin traer nada al frente).
            let _ = self.bus.block(bus::grab_focus(self.bus.conn(), element));
            let _ = self.settle(element, 400, |states| states.has(s::FOCUSED));
        }
        let seen = self.before(&window);
        // Última comprobación justo antes de usar el teclado.
        if self.idle_ms() < 300 || !self.window_active(&window) {
            return Err(ToolError::new("USER_ACTIVE", "The user started typing or switched windows; nothing was sent."));
        }
        let from = self.now_ms();
        let sent = match &self.portal {
            Some(keyboard) => self.bus.block(keyboard.combo(&modifiers, key)),
            None => Err(anyhow::anyhow!("no keyboard session")),
        };
        self.own_input = Some((from, self.now_ms()));
        if let Err(error) = sent {
            if let Some(keyboard) = self.portal.take() {
                self.bus.block(keyboard.close());
            }
            return Err(ToolError::new("UNCERTAIN", format!("The keyboard session failed while sending {} ({error}); part of it may have been sent. Take a snapshot.", combo.label)));
        }
        sleep(Duration::from_millis(150));
        Ok(format!("Pressed {} in w{:X} (the active window).{}", combo.label, window.key, self.changes(seen, None)))
    }

    /// set_value: escribe con EditableText (o Value en deslizadores) y comprueba que se conserva.
    fn write_value(&mut self, args: &Value, append: bool) -> ToolResult {
        let target = self.target(args)?;
        self.enabled(&target.obj)?;
        let wanted = args["value"].as_str().ok_or_else(|| ToolError::new("INVALID_ARGS", "value is required."))?.to_owned();
        let described = self.describe_now(&target)?;
        if described.node.states.contains(&"password") {
            return Err(ToolError::new("PASSWORD", "Trex never writes into password fields; ask the user to do it."));
        }
        let conn = self.bus.conn().clone();
        let ifaces = self.bus.block(bus::ifaces(&conn, &target.obj))?;
        let role = described.node.role;
        let number: Option<f64> = wanted.trim().parse().ok();
        if ifaces.has(Ifaces::VALUE) && (matches!(role, "slider" | "spinner") || !ifaces.has(Ifaces::EDITABLE_TEXT)) {
            let number = number.ok_or_else(|| ToolError::new("INVALID_ARGS", "This element takes a number."))?;
            let before = self.guard(&target.window)?;
            self.bus.block(bus::set_f64(&conn, &target.obj, bus::VALUE, "CurrentValue", number))?;
            sleep(Duration::from_millis(150));
            let actual = self.bus.block(bus::get_f64(&conn, &target.obj, bus::VALUE, "CurrentValue"))?;
            return if (actual - number).abs() < 1e-6 {
                Ok(format!("Value set and verified: {actual}.{}", self.focus_note(before, &target.window)))
            } else {
                Err(ToolError::new("NOT_KEPT", format!("The control now reports {actual} instead of {number}.")))
            };
        }
        if !ifaces.has(Ifaces::EDITABLE_TEXT) {
            return Err(if ifaces.has(Ifaces::TEXT) {
                ToolError::new("KEYBOARD_ONLY", "This field only accepts real keystrokes; Trex never types with the user's keyboard. Explain it or ask the user.")
            } else {
                ToolError::new("NOT_EDITABLE", "The element has no editable value.")
            });
        }
        if described.node.states.contains(&"readonly") {
            return Err(ToolError::new("READ_ONLY", "The field is read-only."));
        }
        let old = self.read_text(&target.obj).unwrap_or_default();
        let expected = if append { old.clone() + &wanted } else { wanted };
        let before = self.guard(&target.window)?;
        let seen = self.before(&target.window);
        match self.bus.block(bus::set_text(&conn, &target.obj, &expected)) {
            Ok(true) => {}
            Ok(false) => return Err(ToolError::new("NOT_KEPT", "The application refused the text.")),
            Err(error) => return Err(error),
        }
        // Releer un poco después: algunos controles aceptan el valor y luego lo descartan.
        sleep(Duration::from_millis(150));
        let actual = self.read_text(&target.obj).unwrap_or_default();
        if bus::obscured(&actual) && !bus::obscured(&expected) {
            // Era un campo de contraseña sin marcar: se deshace lo escrito.
            let _ = self.bus.block(bus::set_text(&conn, &target.obj, &old));
            return Err(ToolError::new("PASSWORD", "This turned out to be a password field; Trex removed what it wrote. Ask the user to fill it."));
        }
        if lines(&actual) == lines(&expected) {
            let note = self.focus_note(before, &target.window);
            Ok(format!("Value verified: {}.{note}{}", quote(&actual, 200), self.changes(seen, Some(&target.obj))))
        } else {
            Err(ToolError::new("NOT_KEPT", format!(
                "The control accepted the value but now reports {}; the application did not keep it. Do not claim it was written.", quote(&actual, 200))))
        }
    }

    fn toggle(&mut self, args: &Value, wanted: Option<bool>) -> ToolResult {
        let target = self.target(args)?;
        self.enabled(&target.obj)?;
        let conn = self.bus.conn().clone();
        let role = self.bus.block(bus::role(&conn, &target.obj))?;
        let states = self.states(&target.obj)?;
        if !checkable(role, states) {
            return Err(ToolError::new("NOT_TOGGLEABLE", "The element is not a checkbox or switch."));
        }
        let index = toggle_action(&self.actions(&target.obj)).ok_or_else(|| ToolError::new("NOT_TOGGLEABLE", "The element has no toggle action."))?;
        let on = |states: States| states.has(s::CHECKED) || states.has(s::PRESSED);
        let label = |states: States| if states.has(s::INDETERMINATE) { "mixed" } else if on(states) { "checked" } else { "unchecked" };
        let current = on(states) && !states.has(s::INDETERMINATE);
        if wanted == Some(current) && !states.has(s::INDETERMINATE) {
            return Ok(format!("Already {}; nothing changed.", label(states)));
        }
        let before = self.guard(&target.window)?;
        let seen = self.before(&target.window);
        let done = |engine: &Self| -> Result<Option<States>, ToolError> {
            if let Outcome::Refused = engine.act(&target.obj, index)? {
                return Err(ToolError::new("NOT_KEPT", "The application refused the action."));
            }
            Ok(engine.settle(&target.obj, 600, |after| match wanted {
                Some(wanted) => on(after) == wanted && !after.has(s::INDETERMINATE),
                None => on(after) != on(states) || after.has(s::INDETERMINATE) != states.has(s::INDETERMINATE),
            }))
        };
        let mut after = done(self)?;
        // Una casilla de tres estados puede necesitar una segunda vuelta.
        if let (Some(wanted), Some(now)) = (wanted, after) {
            if on(now) != wanted || now.has(s::INDETERMINATE) {
                after = done(self)?;
            }
        }
        let after = after.ok_or_else(|| ToolError::new("UNCERTAIN", "Could not read the control after the action. Take a snapshot."))?;
        let ok = match wanted {
            Some(wanted) => on(after) == wanted && !after.has(s::INDETERMINATE),
            None => on(after) != on(states) || after.has(s::INDETERMINATE) != states.has(s::INDETERMINATE),
        };
        if ok {
            let note = self.focus_note(before, &target.window);
            Ok(format!("Now {} (verified).{note}{}", label(after), self.changes(seen, Some(&target.obj))))
        } else {
            Err(ToolError::new("NOT_KEPT", format!("The control is still {}.", label(after))))
        }
    }

    /// La acción que despliega un elemento: la suya o la de su botón (los
    /// desplegables de GTK 4 se abren con un botón hijo).
    fn expander(&self, obj: &Obj, expand: bool) -> Option<(Obj, usize)> {
        if let Some(index) = expand_action(&self.actions(obj), expand) {
            return Some((obj.clone(), index));
        }
        let conn = self.bus.conn().clone();
        let kids = self.bus.block(bus::children(&conn, obj)).unwrap_or_default();
        kids.into_iter().take(8).find_map(|kid| {
            let role = self.bus.block(bus::role(&conn, &kid)).ok()?;
            matches!(role, r::TOGGLE_BUTTON | r::BUTTON | r::PUSH_BUTTON_MENU).then(|| click_action(&self.actions(&kid), "button").map(|index| (kid, index))).flatten()
        })
    }

    fn expand(&mut self, args: &Value, expand: bool) -> ToolResult {
        let target = self.target(args)?;
        self.enabled(&target.obj)?;
        let role = self.bus.block(bus::role(self.bus.conn(), &target.obj))?;
        let states = self.states(&target.obj)?;
        let expandable = states.has(s::EXPANDABLE);
        if !expandable && !matches!(role, r::COMBO_BOX | r::MENU | r::PUSH_BUTTON_MENU) {
            return Err(ToolError::new("NOT_EXPANDABLE", "The element cannot be expanded or collapsed."));
        }
        if expandable && states.has(s::EXPANDED) == expand {
            return Ok(format!("Already {}; nothing changed.", if expand { "expanded" } else { "collapsed" }));
        }
        let (obj, index) = self.expander(&target.obj, expand).ok_or_else(|| ToolError::new("NOT_EXPANDABLE", "The element has no action to expand or collapse it."))?;
        let before = self.guard(&target.window)?;
        let seen = self.before(&target.window);
        match self.act(&obj, index)? {
            Outcome::Refused => return Err(ToolError::new("NOT_KEPT", "The application refused the action.")),
            Outcome::Pending => return Ok(format!("Requested; the application is still handling it.{}", self.changes(seen, Some(&target.obj)))),
            Outcome::Done => {}
        }
        if !expandable {
            // Sin estado que comprobar (un desplegable de GTK 3): se informa lo que apareció.
            let changes = self.changes(seen, Some(&target.obj));
            return Ok(format!("{} requested.{}{changes}", if expand { "Expand" } else { "Collapse" }, self.focus_note(before, &target.window)));
        }
        let after = self.settle(&target.obj, 600, |states| states.has(s::EXPANDED) == expand);
        if after.is_some_and(|states| states.has(s::EXPANDED) == expand) {
            let changes = self.changes(seen, Some(&target.obj));
            Ok(format!("{} (verified).{}{changes}", if expand { "Expanded" } else { "Collapsed" }, self.focus_note(before, &target.window)))
        } else {
            Err(ToolError::new("NOT_KEPT", "The element did not change state."))
        }
    }

    /// Opciones dentro de un elemento (aunque estén ocultas, como los menús de los
    /// desplegables de GTK 3): (objeto, contenedor, nombre).
    fn options(&self, root: &Obj) -> Vec<(Obj, Option<Obj>, String, u32)> {
        let fetch = Fetch { max_depth: 10, max_nodes: 3_000, texts: false, prune_hidden: false };
        let Ok((raws, _)) = self.bus.tree(root, fetch) else { return Vec::new() };
        raws.iter().enumerate().skip(1).filter_map(|(index, raw)| {
            let option = matches!(raw.info.role, r::LIST_ITEM | r::MENU_ITEM | r::RADIO_MENU_ITEM | r::CHECK_MENU_ITEM | r::PAGE_TAB | r::TREE_ITEM
                | r::TABLE_ROW | r::TABLE_CELL | r::RADIO_BUTTON) || raw.info.states.has(s::SELECTABLE);
            if !option {
                return None;
            }
            // El nombre de la opción, o el de su primera etiqueta (filas de GTK 4).
            let mut name = raw.info.name.trim().to_owned();
            if name.is_empty() {
                name = raw.kids.iter().map(|kid| raws[*kid].info.name.trim()).find(|text| !text.is_empty()).unwrap_or("").to_owned();
                if name.is_empty() {
                    name = raw.kids.iter().flat_map(|kid| raws[*kid].kids.iter()).map(|kid| raws[*kid].info.name.trim()).find(|text| !text.is_empty()).unwrap_or("").to_owned();
                }
            }
            let _ = index;
            (!name.is_empty()).then(|| (raw.obj.clone(), raw.parent.map(|parent| raws[parent].obj.clone()), name, raw.info.role))
        }).collect()
    }

    /// Lo que muestra un desplegable ahora (su valor, su nombre o su texto).
    fn shown_value(&self, obj: &Obj) -> String {
        let conn = self.bus.conn();
        let attributes = self.bus.block(bus::attributes(conn, obj)).unwrap_or_default();
        if let Some(text) = attributes.get("valuetext").filter(|text| !text.is_empty()) {
            return text.clone();
        }
        self.bus.block(bus::name(conn, obj)).unwrap_or_default()
    }

    fn select(&mut self, args: &Value) -> ToolResult {
        let target = self.target(args)?;
        self.enabled(&target.obj)?;
        let conn = self.bus.conn().clone();
        let Some(wanted) = args["value"].as_str().map(str::to_owned) else {
            let role = self.bus.block(bus::role(&conn, &target.obj))?;
            let before = self.guard(&target.window)?;
            let seen = self.before(&target.window);
            let radio = matches!(role, r::RADIO_BUTTON | r::RADIO_MENU_ITEM);
            let done = |states: States| if radio { states.has(s::CHECKED) } else { states.has(s::SELECTED) };
            if self.states(&target.obj).is_ok_and(done) {
                return Ok("Already selected; nothing changed.".into());
            }
            match self.select_in_parent(&target) {
                Ok(()) => {}
                Err(error) if error.code == "NOT_SELECTABLE" => {
                    let index = click_action(&self.actions(&target.obj), "button").ok_or(error)?;
                    if let Outcome::Refused = self.act(&target.obj, index)? {
                        return Err(ToolError::new("NOT_KEPT", "The application refused the action."));
                    }
                }
                Err(error) => return Err(error),
            }
            return if self.settle(&target.obj, 600, done).is_some_and(done) {
                let note = self.focus_note(before, &target.window);
                Ok(format!("Selected (verified).{note}{}", self.changes(seen, Some(&target.obj))))
            } else {
                Err(ToolError::new("NOT_KEPT", "The item is not selected."))
            };
        };
        let lowered = wanted.to_lowercase();
        let pick = |options: Vec<(Obj, Option<Obj>, String, u32)>| {
            let exact = options.iter().position(|option| option.2.to_lowercase() == lowered);
            let partial = || options.iter().position(|option| option.2.to_lowercase().contains(&lowered));
            exact.or_else(partial).map(|index| options[index].clone())
        };
        let before = self.guard(&target.window)?;
        let seen = self.before(&target.window);
        if self.shown_value(&target.obj).to_lowercase() == lowered {
            return Ok(format!("{} is already selected; nothing changed.", quote(&wanted, 80)));
        }
        // Las opciones están dentro del desplegable (GTK 3, aunque ocultas) o, con la
        // lista abierta, en una ventana emergente de la misma ventana (GTK 4).
        let showing = |options: Vec<(Obj, Option<Obj>, String, u32)>, engine: &Self| -> Vec<(Obj, Option<Obj>, String, u32)> {
            options.into_iter().filter(|option| engine.states(&option.0).is_ok_and(|states| states.has(s::SHOWING))).collect()
        };
        let already_open = self.states(&target.obj).is_ok_and(|states| states.has(s::EXPANDED));
        let mut opened = None;
        let mut option = pick(self.options(&target.obj));
        if option.is_none() && already_open {
            option = pick(showing(self.options(&target.window.obj), self));
        }
        if option.is_none() && !already_open {
            // Las opciones de algunos desplegables solo existen con la lista abierta:
            // se buscan entre las que aparecen al abrirla.
            if let Some((obj, index)) = self.expander(&target.obj, true) {
                let earlier: HashSet<Obj> = self.options(&target.window.obj).into_iter().map(|option| option.0).collect();
                if matches!(self.act(&obj, index), Ok(Outcome::Done)) {
                    sleep(Duration::from_millis(300));
                    option = pick(self.options(&target.obj));
                    if option.is_none() {
                        let fresh = self.options(&target.window.obj).into_iter().filter(|option| !earlier.contains(&option.0)).collect();
                        option = pick(showing(fresh, self));
                    }
                    opened = Some((obj, index));
                }
            }
        }
        let list_open = already_open || opened.is_some();
        let close = |engine: &Self, opened: &Option<(Obj, usize)>| {
            if let Some((obj, index)) = opened {
                if engine.states(&target.obj).is_ok_and(|states| states.has(s::EXPANDED)) {
                    let _ = engine.act(obj, *index);
                }
            }
        };
        let Some((item, parent, name, role)) = option else {
            close(self, &opened);
            return Err(ToolError::new("NOT_FOUND", format!("No option named {} inside the element.", quote(&wanted, 80))));
        };
        let item_target = Target { obj: item.clone(), parent, window: target.window.clone() };
        let target_role = self.bus.block(bus::role(&conn, &target.obj)).unwrap_or_default();
        // En un desplegable (o un menú) la opción se activa: seleccionarla en su lista
        // solo la resalta. En una lista, se selecciona.
        let activate = |engine: &Self| -> Result<bool, ToolError> {
            match click_action(&engine.actions(&item), "button") {
                Some(index) => Ok(matches!(engine.act(&item, index)?, Outcome::Done | Outcome::Pending)),
                None => Ok(false),
            }
        };
        let activate_first = target_role == r::COMBO_BOX || matches!(role, r::MENU_ITEM | r::RADIO_MENU_ITEM | r::CHECK_MENU_ITEM);
        let mut selected = false;
        for activating in [activate_first, !activate_first] {
            selected = if activating { activate(self)? } else { self.select_in_parent(&item_target).is_ok() };
            if selected {
                break;
            }
        }
        if !selected {
            close(self, &opened);
            return Err(ToolError::new("NOT_SELECTABLE", "The option cannot be selected."));
        }
        sleep(Duration::from_millis(200));
        let shown = self.shown_value(&target.obj);
        let committed = shown.to_lowercase() == name.to_lowercase() || (!shown.is_empty() && shown.to_lowercase().contains(&lowered));
        let item_states = self.states(&item).unwrap_or_default();
        // En un desplegable solo vale lo que el desplegable muestra: que la fila quede
        // marcada en la lista abierta no la elige (GTK 4 solo la toma con un clic o Intro).
        let verified = committed || (target_role != r::COMBO_BOX && (item_states.has(s::SELECTED)
            || (matches!(role, r::RADIO_MENU_ITEM | r::RADIO_BUTTON | r::CHECK_MENU_ITEM) && item_states.has(s::CHECKED))));
        if verified {
            close(self, &opened);
            let note = self.focus_note(before, &target.window);
            return Ok(format!("Selected {} (verified).{note}{}", quote(&name, 80), self.changes(seen, Some(&target.obj))));
        }
        if target_role == r::COMBO_BOX && list_open && self.keyboard {
            // La lista queda abierta con la opción enfocada: Intro la confirma.
            let _ = self.bus.block(bus::grab_focus(&conn, &item));
            return Err(ToolError::new("NOT_KEPT", format!(
                "{} is highlighted in the open list, but this dropdown only takes a real click or Enter (GTK 4). The list is still open with it \
focused: confirm it with a11y_press keys:\"enter\" on this window, or ask the user. The control still shows {}.", quote(&name, 80), quote(&shown, 80))));
        }
        close(self, &opened);
        Err(ToolError::new("NOT_KEPT", format!(
            "{} is not selected: the control still shows {}. This dropdown only takes a real click or Enter (GTK 4); ask the user to pick it.",
            quote(&name, 80), quote(&shown, 80))))
    }

    /// La barra de desplazamiento (y su panel) de un elemento o de su antepasado más cercano.
    fn scrollbar_near(&self, obj: &Obj, horizontal: bool) -> Option<(Obj, Obj)> {
        let conn = self.bus.conn().clone();
        self.bus.block(async {
            let mut current = Some(obj.clone());
            for _ in 0..12 {
                let item = current?;
                let kids = bus::children(&conn, &item).await.unwrap_or_default();
                for kid in kids.into_iter().take(64) {
                    let info = bus::info(&conn, &kid, false).await.ok();
                    if let Some(info) = info.filter(|info| info.role == r::SCROLL_BAR && info.ifaces.has(Ifaces::VALUE)) {
                        if orientation(&conn, &kid, info.states).await == Some(horizontal) {
                            return Some((kid, item));
                        }
                    }
                }
                current = bus::parent(&conn, &item).await.ok().flatten();
            }
            None
        })
    }

    /// La barra del contenido principal de una ventana: la del panel más grande.
    fn main_scrollbar(&self, window: &Obj, horizontal: bool) -> Option<(Obj, Obj)> {
        let fetch = Fetch { max_depth: 30, max_nodes: 4_000, texts: false, prune_hidden: true };
        let (raws, _) = self.bus.tree(window, fetch).ok()?;
        let conn = self.bus.conn().clone();
        let candidates: Vec<(Obj, Obj, States)> = raws.iter()
            .filter(|raw| raw.info.role == r::SCROLL_BAR && raw.info.ifaces.has(Ifaces::VALUE))
            .filter_map(|raw| raw.parent.map(|parent| (raw.obj.clone(), raws[parent].obj.clone(), raw.info.states)))
            .collect();
        self.bus.block(async {
            let mut best: Option<(i64, Obj, Obj)> = None;
            for (bar, pane, states) in candidates {
                if orientation(&conn, &bar, states).await != Some(horizontal) {
                    continue;
                }
                let area = bus::extents(&conn, &pane).await.map_or(0, |(_, _, width, height)| i64::from(width.max(0)) * i64::from(height.max(0)));
                if best.as_ref().is_none_or(|(size, ..)| area > *size) {
                    best = Some((area, bar, pane));
                }
            }
            best.map(|(_, bar, pane)| (bar, pane))
        })
    }

    /// Mueve una barra: `to` arriba o abajo del todo, o `steps` pasos (negativos hacia atrás).
    fn move_bar(&self, bar: &Obj, pane: &Obj, horizontal: bool, to: Option<bool>, steps: i32, page: bool) -> Result<(f64, f64, f64, f64), ToolError> {
        let conn = self.bus.conn().clone();
        self.bus.block(async {
            let (value, min, max, increment, extents) = tokio::join!(
                bus::get_f64(&conn, bar, bus::VALUE, "CurrentValue"),
                bus::get_f64(&conn, bar, bus::VALUE, "MinimumValue"),
                bus::get_f64(&conn, bar, bus::VALUE, "MaximumValue"),
                bus::get_f64(&conn, bar, bus::VALUE, "MinimumIncrement"),
                bus::extents(&conn, pane)
            );
            let (value, min, max) = (value?, min?, max?);
            let range = (max - min).max(0.0);
            let visible = extents.ok().map(|(_, _, width, height)| f64::from(if horizontal { width } else { height })).filter(|size| *size > 0.0);
            let page_step = visible.map_or(range / 5.0, |size| size * 0.9).max(1.0);
            let small = increment.ok().filter(|step| *step > 0.0 && *step < range).unwrap_or(page_step / 10.0).max(1.0);
            let wanted = match to {
                Some(true) => max,
                Some(false) => min,
                None => (value + f64::from(steps) * if page { page_step } else { small }).clamp(min, max),
            };
            bus::set_f64(&conn, bar, bus::VALUE, "CurrentValue", wanted).await?;
            let mut now = value;
            for _ in 0..7 {
                tokio::time::sleep(Duration::from_millis(100)).await;
                now = bus::get_f64(&conn, bar, bus::VALUE, "CurrentValue").await?;
                if (now - value).abs() > f64::EPSILON {
                    break;
                }
            }
            Ok((value, now, min, max))
        })
    }

    /// Desplaza con las barras accesibles del panel y, si no hay (páginas web),
    /// trayendo a la vista el siguiente elemento que queda fuera.
    fn scroll(&mut self, args: &Value) -> ToolResult {
        let to = args["to"].as_str();
        let (horizontal, forward) = match (to, args["direction"].as_str()) {
            (Some("top"), _) => (false, false),
            (Some("bottom"), _) => (false, true),
            (Some(_), _) => return Err(ToolError::new("INVALID_ARGS", "to must be top or bottom.")),
            (None, Some("down")) => (false, true),
            (None, Some("up")) => (false, false),
            (None, Some("right")) => (true, true),
            (None, Some("left")) => (true, false),
            _ => return Err(ToolError::new("INVALID_ARGS", "Pass direction (up, down, left or right) or to (top or bottom).")),
        };
        let page = args["page"].as_bool().unwrap_or(false);
        let amount = args["amount"].as_u64().unwrap_or(if page { 1 } else { 3 }).clamp(1, 20) as i32;
        let (obj, window, whole) = if args["ref_id"].is_string() {
            let target = self.target(args)?;
            (target.obj, target.window, false)
        } else {
            let info = self.resolve_window(args)?;
            (info.obj.clone(), info.reference(), true)
        };
        let bar = if whole { self.main_scrollbar(&obj, horizontal) } else { self.scrollbar_near(&obj, horizontal) };
        let before = self.guard(&window)?;
        let seen = self.before(&window);
        let edge = if forward { "end" } else { "start" };
        let head = if let Some((bar, pane)) = bar {
            let steps = if forward { amount } else { -amount };
            let (start, end, min, max) = self.move_bar(&bar, &pane, horizontal, to.map(|to| to == "bottom"), steps, page)?;
            if (end - start).abs() <= f64::EPSILON {
                format!("Nothing moved: it is already at the {edge}.")
            } else if max > min {
                format!("Scrolled; position now {:.0}%.", (end - min) / (max - min) * 100.0)
            } else {
                "Scrolled.".into()
            }
        } else {
            let container = if whole { window.obj.clone() } else { obj.clone() };
            match self.reveal_next(&container, forward, to.is_some())? {
                Some(name) => format!("Scrolled by bringing the next off-screen element into view ({}).", quote(&name, 60)),
                None => "Nothing to scroll: everything in this part is already in view (or the app exposes no scrolling).".into(),
            }
        };
        let changes = self.changes(seen, None).replace("\nNo visible change in the window.", "\nNothing new came into view.");
        Ok(format!("{head}{}{changes}", self.focus_note(before, &window)))
    }

    /// Sin barras accesibles: trae a la vista (ScrollTo) el primer elemento fuera de
    /// la vista después de lo visible (o antes, hacia atrás; o el último/primero con `jump`).
    fn reveal_next(&self, container: &Obj, forward: bool, jump: bool) -> Result<Option<String>, ToolError> {
        let fetch = Fetch { max_depth: 40, max_nodes: 5_000, texts: false, prune_hidden: true };
        let (raws, _) = self.bus.tree(container, fetch)?;
        let candidates: Vec<&Raw> = raws.iter().skip(1)
            .filter(|raw| raw.info.ifaces.has(Ifaces::COMPONENT) && !bus::is_layout(raw.info.role) && raw.info.role != r::SCROLL_BAR)
            .collect();
        let showing: Vec<usize> = candidates.iter().enumerate().filter(|(_, raw)| raw.info.states.has(s::SHOWING)).map(|(index, _)| index).collect();
        let hidden = |index: &usize| !candidates[*index].info.states.has(s::SHOWING);
        let pick = match (forward, jump, showing.first(), showing.last()) {
            (true, true, ..) => (0..candidates.len()).rev().find(hidden),
            (false, true, ..) => (0..candidates.len()).find(hidden),
            (true, false, _, Some(last)) => (last + 1..candidates.len()).find(hidden),
            (false, false, Some(first), _) => (0..*first).rev().find(hidden),
            _ => None,
        };
        let Some(pick) = pick else { return Ok(None) };
        let raw = candidates[pick];
        let moved = self.bus.block(bus::scroll_to(self.bus.conn(), &raw.obj))?;
        if !moved {
            return Err(ToolError::new("NOT_SCROLLABLE", "The application does not support scrolling through accessibility here."));
        }
        let name = if raw.info.name.trim().is_empty() { role_name(raw.info.role, raw.info.states, raw.info.ifaces, false).to_owned() } else { raw.info.name.clone() };
        Ok(Some(name))
    }

    /// Trae un elemento a la vista: con ScrollTo si la app lo tiene y, si no,
    /// moviendo la barra de su panel hasta donde está.
    fn scroll_to(&mut self, args: &Value) -> ToolResult {
        let target = self.target(args)?;
        let showing = |states: States| states.has(s::SHOWING);
        let before = self.guard(&target.window)?;
        let seen = self.before(&target.window);
        let head = if self.states(&target.obj).is_ok_and(showing) {
            "Already in view.".to_owned()
        } else {
            let scrolled = self.bus.block(bus::scroll_to(self.bus.conn(), &target.obj)).unwrap_or(false)
                && self.settle(&target.obj, 600, showing).is_some_and(showing);
            if scrolled {
                "Scrolled into view (verified).".to_owned()
            } else {
                self.scroll_bar_to(&target.obj)?
            }
        };
        let changes = self.changes(seen, None).replace("\nNo visible change in the window.", "\nNothing new came into view.");
        Ok(format!("{head}{}{changes}", self.focus_note(before, &target.window)))
    }

    /// Mueve la barra vertical del panel que contiene el elemento hasta que se vea.
    fn scroll_bar_to(&self, obj: &Obj) -> Result<String, ToolError> {
        let (bar, pane) = self.scrollbar_near(obj, false)
            .ok_or_else(|| ToolError::new("NOT_SCROLLABLE", "Could not bring it into view: the app supports neither ScrollTo nor accessible scroll bars here."))?;
        let conn = self.bus.conn().clone();
        for _ in 0..4 {
            let (element, frame) = self.bus.block(async { tokio::join!(bus::extents(&conn, obj), bus::extents(&conn, &pane)) });
            let ((_, top, _, height), (_, pane_top, _, pane_height)) = (element?, frame?);
            if height <= 0 {
                return Err(ToolError::new("NOT_SCROLLABLE", "The element has no place on screen: it is hidden, not scrolled away."));
            }
            let delta = f64::from(top - pane_top) - f64::from(pane_height) / 3.0;
            let value = self.bus.block(bus::get_f64(&conn, &bar, bus::VALUE, "CurrentValue"))?;
            let (min, max) = self.bus.block(async {
                tokio::join!(bus::get_f64(&conn, &bar, bus::VALUE, "MinimumValue"), bus::get_f64(&conn, &bar, bus::VALUE, "MaximumValue"))
            });
            let wanted = (value + delta).clamp(min.unwrap_or(f64::MIN), max.unwrap_or(f64::MAX));
            if (wanted - value).abs() < 1.0 {
                break;
            }
            self.bus.block(bus::set_f64(&conn, &bar, bus::VALUE, "CurrentValue", wanted))?;
            if self.settle(obj, 400, |states| states.has(s::SHOWING)).is_some_and(|states| states.has(s::SHOWING)) {
                return Ok("Scrolled into view with the panel's scroll bar (verified).".into());
            }
        }
        if self.states(obj).is_ok_and(|states| states.has(s::SHOWING)) {
            Ok("Scrolled into view with the panel's scroll bar (verified).".into())
        } else {
            Err(ToolError::new("NOT_SCROLLABLE", "Could not bring it into view: the panel did not scroll any further."))
        }
    }

    fn launch(&mut self, args: &Value, cancel: &AtomicBool) -> ToolResult {
        let app = args["app"].as_str().map(str::trim).filter(|app| !app.is_empty()).ok_or_else(|| ToolError::new("INVALID_ARGS", "app is required."))?.to_owned();
        let extra: Vec<String> = args["args"].as_array().map(|items| items.iter().filter_map(Value::as_str).map(str::to_owned).collect()).unwrap_or_default();
        // Una ventana nueva podría llevarse lo que la persona teclea: se espera una pausa.
        let deadline = Instant::now() + PAUSE_WAIT;
        while self.idle_ms() < USER_ACTIVE_MS && Instant::now() < deadline {
            if cancel.load(Ordering::SeqCst) {
                return Err(ToolError::new("CANCELLED", "Cancelled."));
            }
            sleep(Duration::from_millis(100));
        }
        let idle = self.idle_ms();
        if idle < USER_ACTIVE_MS {
            return Err(ToolError::new("USER_ACTIVE", format!(
                "The user kept typing or moving the mouse for {} s (last input {idle} ms ago); a new window now could take their keystrokes. Wait with a11y_wait and retry.",
                PAUSE_WAIT.as_secs())));
        }
        let (program, command_args, how) = launch_command(&app, &extra)?;
        let titles: HashMap<isize, String> = self.windows().into_iter().map(|window| (window.key, window.title)).collect();
        let known: HashSet<isize> = titles.keys().copied().collect();
        let names: Vec<String> = std::iter::once(app.as_str()).chain(extra.iter().map(String::as_str)).map(stem).filter(|name| name.chars().count() >= 3).collect();
        spawn_detached(&program, &command_args).map_err(|error| ToolError::new("LAUNCH_FAILED", format!("Could not open {app}: {error}")))?;
        let deadline = Instant::now() + Duration::from_secs(12);
        while Instant::now() < deadline {
            if cancel.load(Ordering::SeqCst) {
                return Err(ToolError::new("CANCELLED", "Cancelled after starting the application."));
            }
            sleep(Duration::from_millis(300));
            let now = self.windows();
            if now.iter().any(|window| !known.contains(&window.key)) {
                // Dejar que termine de construirse antes de leerla.
                sleep(Duration::from_millis(400));
                let opened = self.new_windows(&known, &mut None, &mut 0);
                return Ok(format!("Opened {app} ({how}).{opened}"));
            }
            // Apps de una sola instancia abren en la ventana que ya estaba: cambia su título.
            let reused = now.into_iter().find(|window| {
                titles.get(&window.key).is_some_and(|title| *title != window.title)
                    && names.iter().any(|name| window.app == *name || window.app_name.contains(name.as_str()) || window.title.to_lowercase().contains(name.as_str()))
            });
            if let Some(window) = reused {
                return Ok(format!("Started {app}; it opened in a window that was already open (its title changed):\n{}", window.line()));
            }
        }
        Ok(format!("Started {app} ({how}), but no new window appeared within 12 s (it may still be starting, or it does not expose accessibility). \
Use a11y_list_windows or a11y_wait."))
    }

    /// Minimizar, maximizar, restaurar o cerrar: con las acciones de ventana de GTK 4
    /// o los botones de la barra de título (no hay otra forma en Wayland).
    fn window_action(&mut self, args: &Value, operation: &str) -> ToolResult {
        let info = self.resolve_window(args)?;
        let window = info.reference();
        if operation == "restore" && info.minimized {
            return Err(ToolError::new("NOT_SUPPORTED", "On Linux (Wayland) apps cannot bring back a minimized window; ask the user to open it from the dock or the overview."));
        }
        let actions = self.actions(&info.obj);
        let gaction = match operation {
            "close" => "window.close",
            "minimize" => "window.minimize",
            _ => "window.toggle-maximized",
        };
        // Botones de la barra de título: los que están junto a otro botón de ventana.
        let fetch = Fetch { max_depth: 20, max_nodes: 4_000, texts: false, prune_hidden: true };
        let (raws, _) = self.bus.tree(&info.obj, fetch)?;
        let is_button = |raw: &Raw| matches!(raw.info.role, r::BUTTON | r::PUSH_BUTTON_MENU);
        let titled_group = |raw: &Raw| raw.parent.is_some_and(|parent| raws[parent].kids.iter().filter(|kid| {
            let kid = &raws[**kid];
            is_button(kid) && ["close", "minimize", "maximize", "restore"].iter().any(|kind| title_button(&kid.info.name, kind))
        }).count() >= 2);
        let button = |kind: &str| raws.iter().find(|raw| is_button(raw) && title_button(&raw.info.name, kind) && (kind == "close" || titled_group(raw)))
            .or_else(|| raws.iter().find(|raw| is_button(raw) && title_button(&raw.info.name, kind) && titled_group(raw)))
            .map(|raw| raw.obj.clone());
        let maximized = button("restore").is_some();
        if (operation == "maximize" && maximized) || (operation == "restore" && !maximized && button("maximize").is_some()) {
            return Ok(format!("Window w{:X} is already {}; nothing changed.", info.key, if maximized { "maximized" } else { "restored" }));
        }
        let wanted_button = operation;
        let (obj, index) = match actions.iter().position(|action| action == gaction) {
            Some(index) => (info.obj.clone(), index),
            None => {
                let obj = button(wanted_button).ok_or_else(|| ToolError::new("NOT_SUPPORTED", format!(
                    "This window has no accessible {wanted_button} button (it may use a title bar drawn by the system); on Linux (Wayland) Trex cannot {operation} it.")))?;
                let index = click_action(&self.actions(&obj), "button").ok_or_else(|| ToolError::new("NOT_SUPPORTED", "The title-bar button has no action."))?;
                (obj, index)
            }
        };
        let before = self.guard(&window)?;
        let size = |engine: &Self| engine.bus.block(bus::extents(engine.bus.conn(), &info.obj)).ok().map(|(_, _, width, height)| (width, height));
        let start = size(self);
        if let Outcome::Refused = self.act(&obj, index)? {
            return Err(ToolError::new("NOT_KEPT", "The application refused the action."));
        }
        match operation {
            "close" => {
                let deadline = Instant::now() + Duration::from_millis(1_500);
                while self.windows().iter().any(|open| open.key == info.key) && Instant::now() < deadline {
                    sleep(Duration::from_millis(100));
                }
                let open = self.windows().iter().any(|open| open.key == info.key);
                Ok(if open {
                    format!("Close requested, but w{:X} is still open (it may be asking to save). Take a snapshot of it.", info.key)
                } else {
                    format!("Closed w{:X} {}.", info.key, quote(&info.title, 80))
                })
            }
            "minimize" => {
                let states = self.settle(&info.obj, 800, |states| states.has(s::ICONIFIED) || !states.has(s::SHOWING));
                Ok(if states.is_some_and(|states| states.has(s::ICONIFIED) || !states.has(s::SHOWING)) {
                    format!("Window w{:X} is now minimized (verified).", info.key)
                } else {
                    format!("Minimize requested for w{:X}; this desktop does not report whether it worked.", info.key)
                })
            }
            _ => {
                sleep(Duration::from_millis(400));
                let end = size(self);
                let word = if operation == "maximize" { "maximized" } else { "restored" };
                let changed = matches!((start, end), (Some(a), Some(b)) if a != b);
                if changed {
                    Ok(format!("Window w{:X} is now {word} (verified: its size changed).{}", info.key, self.focus_note(before, &window)))
                } else {
                    Err(ToolError::new("NOT_KEPT", "The window did not change size."))
                }
            }
        }
    }
}

/// La orientación de una barra: por su estado o, si no lo dice, por su forma.
async fn orientation(conn: &zbus::Connection, bar: &Obj, states: States) -> Option<bool> {
    if states.has(s::HORIZONTAL) {
        return Some(true);
    }
    if states.has(s::VERTICAL) {
        return Some(false);
    }
    bus::extents(conn, bar).await.ok().map(|(_, _, width, height)| width > height)
}

/// Cómo abrir lo que se pidió: (programa, argumentos, descripción).
pub(super) fn launch_command(app: &str, extra: &[String]) -> Result<(PathBuf, Vec<String>, String), ToolError> {
    let expanded = match (app.strip_prefix("~/"), std::env::var_os("HOME")) {
        (Some(rest), Some(home)) => PathBuf::from(home).join(rest),
        _ => PathBuf::from(app),
    };
    let gio = crate::tools::find_program("gio");
    if app.contains('/') && expanded.exists() {
        if expanded.extension().and_then(|ext| ext.to_str()) == Some("desktop") {
            let gio = gio.ok_or_else(|| ToolError::new("LAUNCH_FAILED", "Opening .desktop files needs gio (glib2)."))?;
            let mut args = vec!["launch".to_owned(), expanded.to_string_lossy().into_owned()];
            args.extend(extra.iter().cloned());
            return Ok((gio, args, "desktop entry".into()));
        }
        if is_executable(&expanded) {
            return Ok((expanded, extra.to_vec(), "program".into()));
        }
        // Un documento: con la app predeterminada.
        let (opener, mut args) = match gio {
            Some(gio) => (gio, vec!["open".to_owned()]),
            None => (crate::tools::find_program("xdg-open").ok_or_else(|| ToolError::new("LAUNCH_FAILED", "Opening documents needs gio or xdg-open."))?, Vec::new()),
        };
        args.push(expanded.to_string_lossy().into_owned());
        return Ok((opener, args, "default application".into()));
    }
    if let Some(program) = crate::tools::find_program(app) {
        return Ok((program, extra.to_vec(), "program".into()));
    }
    let entry = find_desktop(app).ok_or_else(|| ToolError::new("LAUNCH_FAILED", format!(
        "No installed application or program matches {app}. Pass the program name (gnome-text-editor), the app name (Calculator) or a path.")))?;
    let gio = gio.ok_or_else(|| ToolError::new("LAUNCH_FAILED", "Opening installed applications needs gio (glib2)."))?;
    let mut args = vec!["launch".to_owned(), entry.path.to_string_lossy().into_owned()];
    args.extend(extra.iter().cloned());
    let label = entry.path.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default();
    Ok((gio, args, label))
}

fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    path.metadata().is_ok_and(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
}

/// Arranca un programa suelto: su propio grupo de procesos, sin la entrada ni la
/// salida de la pasarela, y sin quedar como zombi.
fn spawn_detached(program: &Path, args: &[String]) -> std::io::Result<()> {
    use std::os::unix::process::CommandExt;
    let mut child = std::process::Command::new(program)
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .process_group(0)
        .spawn()?;
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

impl Engine for AtspiEngine {
    fn call(&mut self, tool: &str, args: &Value, cancel: &AtomicBool) -> ToolResult {
        match tool {
            "list_windows" => self.list_windows(args),
            "snapshot" => self.snapshot(args),
            "find" => self.find(args),
            "get" => self.get(args),
            "wait" => self.wait(args, cancel),
            "status" => self.status(),
            "click" if args["button"].as_str() == Some("right") => self.right_click(args),
            "click" => self.click(args),
            "set_value" => self.write_value(args, args["append"].as_bool() == Some(true)),
            "toggle" => self.toggle(args, match args["state"].as_str() {
                Some("on") => Some(true),
                Some("off") => Some(false),
                None => None,
                Some(_) => return Err(ToolError::new("INVALID_ARGS", "state must be on or off.")),
            }),
            "expand" => self.expand(args, args["collapse"].as_bool() != Some(true)),
            "select" => self.select(args),
            "scroll" => self.scroll(args),
            "scroll_to" => self.scroll_to(args),
            "launch" => self.launch(args, cancel),
            "press" => self.press(args, cancel),
            "window" => match args["action"].as_str() {
                Some(action @ ("close" | "minimize" | "maximize" | "restore")) => self.window_action(args, action),
                _ => Err(ToolError::new("INVALID_ARGS", "action must be minimize, maximize, restore or close.")),
            },
            "batch" => self.batch(args, cancel),
            other => Err(ToolError::new("INVALID_ARGS", format!("Unknown tool {other}."))),
        }
    }
}

impl Drop for AtspiEngine {
    fn drop(&mut self) {
        if let Some(keyboard) = self.portal.take() {
            self.bus.block(keyboard.close());
        }
    }
}

#[cfg(test)]
mod tests;
