//! AT-SPI2 por D-Bus, sin libatspi ni GLib: llamadas con zbus (ya usado en Linux).
//!
//! - Cada llamada tiene un plazo: una app colgada no deja colgado al motor.
//! - Un árbol se lee por niveles, con muchas llamadas en vuelo a la vez (cada app
//!   responde en orden, pero no se espera cada ida y vuelta).
//! - Lo que el motor necesita saber de un elemento (rol, estados, nombre,
//!   interfaces, hijos, acciones, texto, valor) se pide en bloque.
use crate::a11y::ToolError;
use futures_util::stream::{self, StreamExt};
use std::collections::HashMap;
use std::future::Future;
use std::time::Duration;
use zbus::zvariant::{OwnedObjectPath, OwnedValue, Value as Variant};
use zbus::Connection;

pub const ACCESSIBLE: &str = "org.a11y.atspi.Accessible";
pub const ACTION: &str = "org.a11y.atspi.Action";
pub const COMPONENT: &str = "org.a11y.atspi.Component";
pub const EDITABLE_TEXT: &str = "org.a11y.atspi.EditableText";
pub const TEXT: &str = "org.a11y.atspi.Text";
pub const VALUE: &str = "org.a11y.atspi.Value";
pub const SELECTION: &str = "org.a11y.atspi.Selection";
const PROPERTIES: &str = "org.freedesktop.DBus.Properties";

/// Plazo de una llamada normal, y de una acción (que puede abrir un diálogo modal).
pub const CALL_TIMEOUT: Duration = Duration::from_secs(3);
pub const ACTION_TIMEOUT: Duration = Duration::from_millis(2_500);
/// Llamadas en vuelo a la vez al leer un árbol.
const IN_FLIGHT: usize = 64;
/// Hijos que se leen de un elemento (una tabla con miles de filas se recorta).
pub const MAX_CHILDREN: usize = 2_000;

/// Estados de AT-SPI (`AtspiStateType`): bits de `GetState`.
pub mod state {
    pub const ACTIVE: u32 = 1;
    pub const CHECKED: u32 = 4;
    pub const DEFUNCT: u32 = 6;
    pub const EDITABLE: u32 = 7;
    pub const ENABLED: u32 = 8;
    pub const EXPANDABLE: u32 = 9;
    pub const EXPANDED: u32 = 10;
    pub const FOCUSABLE: u32 = 11;
    pub const FOCUSED: u32 = 12;
    pub const HORIZONTAL: u32 = 14;
    pub const ICONIFIED: u32 = 15;
    pub const PRESSED: u32 = 20;
    pub const SELECTABLE: u32 = 22;
    pub const SELECTED: u32 = 23;
    pub const SENSITIVE: u32 = 24;
    pub const SHOWING: u32 = 25;
    pub const VERTICAL: u32 = 29;
    pub const VISIBLE: u32 = 30;
    pub const INDETERMINATE: u32 = 32;
    pub const CHECKABLE: u32 = 41;
    pub const READ_ONLY: u32 = 43;
}

/// Roles de AT-SPI (`AtspiRole`) que el motor distingue.
pub mod role {
    pub const ACCELERATOR_LABEL: u32 = 1;
    pub const ALERT: u32 = 2;
    pub const CALENDAR: u32 = 5;
    pub const CANVAS: u32 = 6;
    pub const CHECK_BOX: u32 = 7;
    pub const CHECK_MENU_ITEM: u32 = 8;
    pub const COLUMN_HEADER: u32 = 10;
    pub const COMBO_BOX: u32 = 11;
    pub const DIALOG: u32 = 16;
    pub const DRAWING_AREA: u32 = 18;
    pub const FILE_CHOOSER: u32 = 19;
    pub const FILLER: u32 = 20;
    pub const FRAME: u32 = 23;
    pub const GLASS_PANE: u32 = 24;
    pub const ICON: u32 = 26;
    pub const IMAGE: u32 = 27;
    pub const INTERNAL_FRAME: u32 = 28;
    pub const LABEL: u32 = 29;
    pub const LAYERED_PANE: u32 = 30;
    pub const LIST: u32 = 31;
    pub const LIST_ITEM: u32 = 32;
    pub const MENU: u32 = 33;
    pub const MENU_BAR: u32 = 34;
    pub const MENU_ITEM: u32 = 35;
    pub const OPTION_PANE: u32 = 36;
    pub const PAGE_TAB: u32 = 37;
    pub const PAGE_TAB_LIST: u32 = 38;
    pub const PANEL: u32 = 39;
    pub const PASSWORD_TEXT: u32 = 40;
    pub const POPUP_MENU: u32 = 41;
    pub const PROGRESS_BAR: u32 = 42;
    pub const BUTTON: u32 = 43;
    pub const RADIO_BUTTON: u32 = 44;
    pub const RADIO_MENU_ITEM: u32 = 45;
    pub const ROOT_PANE: u32 = 46;
    pub const ROW_HEADER: u32 = 47;
    pub const SCROLL_BAR: u32 = 48;
    pub const SCROLL_PANE: u32 = 49;
    pub const SEPARATOR: u32 = 50;
    pub const SLIDER: u32 = 51;
    pub const SPIN_BUTTON: u32 = 52;
    pub const SPLIT_PANE: u32 = 53;
    pub const STATUS_BAR: u32 = 54;
    pub const TABLE: u32 = 55;
    pub const TABLE_CELL: u32 = 56;
    pub const TABLE_COLUMN_HEADER: u32 = 57;
    pub const TABLE_ROW_HEADER: u32 = 58;
    pub const TEAROFF_MENU_ITEM: u32 = 59;
    pub const TERMINAL: u32 = 60;
    pub const TEXT: u32 = 61;
    pub const TOGGLE_BUTTON: u32 = 62;
    pub const TOOL_BAR: u32 = 63;
    pub const TOOL_TIP: u32 = 64;
    pub const TREE: u32 = 65;
    pub const TREE_TABLE: u32 = 66;
    pub const VIEWPORT: u32 = 68;
    pub const WINDOW: u32 = 69;
    pub const HEADER: u32 = 71;
    pub const FOOTER: u32 = 72;
    pub const PARAGRAPH: u32 = 73;
    pub const APPLICATION: u32 = 75;
    pub const AUTOCOMPLETE: u32 = 76;
    pub const ENTRY: u32 = 79;
    pub const CAPTION: u32 = 81;
    pub const DOCUMENT_FRAME: u32 = 82;
    pub const HEADING: u32 = 83;
    pub const PAGE: u32 = 84;
    pub const SECTION: u32 = 85;
    pub const FORM: u32 = 87;
    pub const LINK: u32 = 88;
    pub const TABLE_ROW: u32 = 90;
    pub const TREE_ITEM: u32 = 91;
    pub const DOCUMENT_SPREADSHEET: u32 = 92;
    pub const DOCUMENT_PRESENTATION: u32 = 93;
    pub const DOCUMENT_TEXT: u32 = 94;
    pub const DOCUMENT_WEB: u32 = 95;
    pub const DOCUMENT_EMAIL: u32 = 96;
    pub const LIST_BOX: u32 = 98;
    pub const GROUPING: u32 = 99;
    pub const NOTIFICATION: u32 = 101;
    pub const INFO_BAR: u32 = 102;
    pub const LEVEL_BAR: u32 = 103;
    pub const TITLE_BAR: u32 = 104;
    pub const BLOCK_QUOTE: u32 = 105;
    pub const ARTICLE: u32 = 109;
    pub const LANDMARK: u32 = 110;
    pub const STATIC: u32 = 116;
    pub const PUSH_BUTTON_MENU: u32 = 129;
}

/// `ScrollTo`: dejarlo donde se vea, como sea.
pub const SCROLL_ANYWHERE: u32 = 6;
/// Coordenadas de `GetExtents` relativas a la ventana (las de pantalla no valen en Wayland).
pub const COORDS_WINDOW: u32 = 1;

/// Un objeto accesible: nombre en el bus y ruta.
#[derive(Clone, Debug, Default, PartialEq, Eq, Hash)]
pub struct Obj {
    pub bus: String,
    pub path: String,
}
impl Obj {
    pub fn new(bus: &str, path: &str) -> Self {
        Self { bus: bus.to_owned(), path: path.to_owned() }
    }
    fn from_pair((bus, path): (String, OwnedObjectPath)) -> Self {
        Self { bus, path: path.as_str().to_owned() }
    }
    /// La ruta nula de AT-SPI: «sin objeto».
    pub fn is_null(&self) -> bool {
        self.bus.is_empty() || self.path == "/org/a11y/atspi/null"
    }
}

pub fn registry_root() -> Obj {
    Obj::new("org.a11y.atspi.Registry", "/org/a11y/atspi/accessible/root")
}

/// Estados como un conjunto de 64 bits.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct States(pub u64);
impl States {
    pub fn from_words(words: &[u32]) -> Self {
        let low = u64::from(words.first().copied().unwrap_or(0));
        let high = u64::from(words.get(1).copied().unwrap_or(0));
        Self(low | (high << 32))
    }
    #[cfg(test)]
    pub fn of(list: &[u32]) -> Self {
        Self(list.iter().fold(0, |bits, state| bits | (1u64 << state)))
    }
    pub fn has(self, state: u32) -> bool {
        state < 64 && self.0 & (1u64 << state) != 0
    }
}

/// Interfaces que el motor usa, como bits.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Ifaces(pub u16);
impl Ifaces {
    pub const ACTION: u16 = 1;
    pub const COMPONENT: u16 = 2;
    pub const EDITABLE_TEXT: u16 = 4;
    pub const TEXT: u16 = 8;
    pub const VALUE: u16 = 16;
    pub const SELECTION: u16 = 32;
    pub const HYPERLINK: u16 = 64;
    pub const DOCUMENT: u16 = 128;
    pub fn from_names(names: &[String]) -> Self {
        let bits = names.iter().fold(0, |bits, name| {
            bits | match name.rsplit('.').next().unwrap_or("") {
                "Action" => Self::ACTION,
                "Component" => Self::COMPONENT,
                "EditableText" => Self::EDITABLE_TEXT,
                "Text" => Self::TEXT,
                "Value" => Self::VALUE,
                "Selection" => Self::SELECTION,
                "Hyperlink" => Self::HYPERLINK,
                "Document" => Self::DOCUMENT,
                _ => 0,
            }
        });
        Self(bits)
    }
    pub fn has(self, bit: u16) -> bool {
        self.0 & bit != 0
    }
}

/// Error de D-Bus para el agente.
pub fn failure(error: zbus::Error) -> ToolError {
    match &error {
        zbus::Error::MethodError(name, detail, _) => {
            let name = name.as_str();
            let detail = detail.clone().unwrap_or_default();
            if ["UnknownObject", "ServiceUnknown", "NameHasNoOwner", "Disconnected"].iter().any(|end| name.ends_with(end)) {
                ToolError::new("STALE_REF", "The element no longer exists (or its application closed). Take a new snapshot.")
            } else if ["UnknownMethod", "UnknownInterface", "UnknownProperty", "NotSupported"].iter().any(|end| name.ends_with(end)) {
                ToolError::new("NOT_SUPPORTED", "The element does not support that operation.")
            } else if name.ends_with("NoReply") || name.ends_with("Timeout") || name.ends_with("TimedOut") {
                uncertain()
            } else if name.ends_with("AccessDenied") {
                ToolError::new("ACCESS_DENIED", format!("Access denied: {detail}"))
            } else {
                ToolError::new("ACTION_FAILED", format!("{name}: {detail}"))
            }
        }
        zbus::Error::InputOutput(_) => ToolError::new("ENGINE_UNAVAILABLE", format!("Lost the connection to the accessibility bus: {error}")),
        _ => ToolError::new("ACTION_FAILED", error.to_string()),
    }
}

pub fn uncertain() -> ToolError {
    ToolError::new("UNCERTAIN", "The application did not answer in time; it may still be processing (for example, a dialog opened). Take a snapshot before retrying.")
}

/// Lo que se sabe de un elemento.
#[derive(Clone, Debug, Default)]
pub struct Info {
    pub role: u32,
    pub states: States,
    pub name: String,
    pub ifaces: Ifaces,
    pub children: Vec<Obj>,
}

/// Un elemento de un árbol leído, con sus hijos (índices) y lo que hizo falta pedir aparte.
#[derive(Clone, Debug, Default)]
pub struct Raw {
    pub obj: Obj,
    pub parent: Option<usize>,
    pub info: Info,
    pub kids: Vec<usize>,
    pub actions: Vec<String>,
    pub text: Option<String>,
    pub number: Option<f64>,
    pub valuetext: Option<String>,
}

/// Qué leer de un árbol.
#[derive(Clone, Copy, Debug)]
pub struct Fetch {
    pub max_depth: usize,
    pub max_nodes: usize,
    /// También el texto de etiquetas y párrafos sin nombre (lectura completa).
    pub texts: bool,
    /// No entrar en contenedores ocultos (páginas de pila sin mostrar, menús cerrados).
    pub prune_hidden: bool,
}

/// Rol de documento: dentro, el contenido fuera de la vista sigue siendo contenido.
pub fn is_document(role: u32) -> bool {
    matches!(role, role::DOCUMENT_FRAME | role::DOCUMENT_WEB | role::DOCUMENT_TEXT | role::DOCUMENT_EMAIL
        | role::DOCUMENT_SPREADSHEET | role::DOCUMENT_PRESENTATION | role::TERMINAL)
}

/// Contenedores de maquetación de las apps de escritorio: si no se muestran, lo de
/// dentro tampoco (una página de una pila, un menú cerrado, un panel plegado).
pub fn is_layout(role: u32) -> bool {
    matches!(role, role::PANEL | role::FILLER | role::GROUPING | role::SCROLL_PANE | role::VIEWPORT | role::SPLIT_PANE
        | role::LAYERED_PANE | role::GLASS_PANE | role::ROOT_PANE | role::OPTION_PANE | role::MENU | role::POPUP_MENU
        | role::PAGE_TAB | role::LIST | role::TABLE | role::TREE | role::TREE_TABLE | role::TOOL_BAR)
}

/// Si se baja a los hijos de un elemento al leer el árbol.
pub fn descend(info: &Info, in_document: bool, prune_hidden: bool) -> bool {
    if !prune_hidden || in_document {
        return true;
    }
    info.states.has(state::SHOWING) || !is_layout(info.role)
}

/// Un elemento sin mostrar ni visible no se lista (salvo la raíz de la lectura).
pub fn hidden(states: States) -> bool {
    !states.has(state::SHOWING) && !states.has(state::VISIBLE)
}

/// Texto que una app enseña en vez del verdadero (campos de contraseña de GTK 4).
pub fn obscured(text: &str) -> bool {
    !text.is_empty() && text.chars().all(|ch| matches!(ch, '•' | '●' | '*' | '∗' | '⚫' | '·'))
}

/// Saca los marcadores de objeto incrustado (U+FFFC) que deja el texto de las páginas.
pub fn plain(text: &str) -> String {
    text.replace('\u{FFFC}', " ").split(' ').filter(|part| !part.is_empty()).collect::<Vec<_>>().join(" ")
}

/// La conexión al bus de accesibilidad, con su propio runtime.
pub struct Bus {
    runtime: tokio::runtime::Runtime,
    conn: Connection,
    session: Option<Connection>,
    gateways: Gateways,
}

/// Pasarelas de Trex vivas que usan el bus. Trex enciende `org.a11y.Status.IsEnabled`
/// si estaba apagado, y la última pasarela en salir lo vuelve a apagar (no la primera:
/// otro chat podría seguir usándolo).
pub struct Gateways {
    dir: std::path::PathBuf,
    pid: u32,
}
impl Gateways {
    const MARKER: &'static str = "a11y-enabled-by-trex";

    pub fn join(dir: std::path::PathBuf, pid: u32) -> Self {
        let _ = std::fs::create_dir_all(&dir);
        let _ = std::fs::write(dir.join(format!("gateway-{pid}")), "");
        Self { dir, pid }
    }

    pub fn mark_enabled(&self) {
        let _ = std::fs::write(self.dir.join(Self::MARKER), "");
    }

    pub fn enabled_by_trex(&self) -> bool {
        self.dir.join(Self::MARKER).exists()
    }

    /// Sale. true si era la última pasarela viva y Trex había encendido el estado.
    pub fn leave(&self) -> bool {
        let _ = std::fs::remove_file(self.dir.join(format!("gateway-{}", self.pid)));
        let others = std::fs::read_dir(&self.dir).into_iter().flatten().flatten().filter_map(|entry| {
            let pid: u32 = entry.file_name().to_str()?.strip_prefix("gateway-")?.parse().ok()?;
            // Una pasarela que terminó de golpe deja su archivo: no cuenta.
            if std::path::Path::new(&format!("/proc/{pid}")).exists() {
                Some(pid)
            } else {
                let _ = std::fs::remove_file(entry.path());
                None
            }
        }).count();
        others == 0 && self.enabled_by_trex() && std::fs::remove_file(self.dir.join(Self::MARKER)).is_ok()
    }
}

/// La dirección del bus de accesibilidad: la del entorno o la que da `org.a11y.Bus`.
async fn address(session: Option<&Connection>) -> Result<String, String> {
    if let Some(address) = std::env::var("AT_SPI_BUS_ADDRESS").ok().filter(|address| !address.is_empty()) {
        return Ok(address);
    }
    let session = session.ok_or("there is no D-Bus session bus")?;
    let reply = tokio::time::timeout(CALL_TIMEOUT, session.call_method(Some("org.a11y.Bus"), "/org/a11y/bus", Some("org.a11y.Bus"), "GetAddress", &()))
        .await
        .map_err(|_| "the accessibility bus did not answer".to_owned())?
        .map_err(|error| format!("the accessibility bus is not available ({error})"))?;
    reply.body().deserialize::<String>().map_err(|error| error.to_string())
}

async fn session_bus() -> Option<Connection> {
    tokio::time::timeout(CALL_TIMEOUT, Connection::session()).await.ok()?.ok()
}

/// Por qué no se puede usar el bus de accesibilidad, o None si se puede (para Ajustes).
pub fn probe() -> Option<&'static str> {
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().ok()?;
    runtime.block_on(async {
        let session = session_bus().await;
        if session.is_none() && std::env::var("AT_SPI_BUS_ADDRESS").is_err() {
            return Some("sessionBusUnavailable");
        }
        address(session.as_ref()).await.err().map(|_| "a11yBusUnavailable")
    })
}

impl Bus {
    pub fn connect() -> anyhow::Result<Self> {
        let runtime = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build()?;
        let gateways = Gateways::join(std::env::temp_dir().join("trex-a11y-locks"), std::process::id());
        let (conn, session) = runtime.block_on(async {
            let session = session_bus().await;
            let address = address(session.as_ref()).await.map_err(|error| anyhow::anyhow!(
                "{error}. Install at-spi2-core and sign in to a desktop session with accessibility support."))?;
            let conn = tokio::time::timeout(CALL_TIMEOUT, async { zbus::connection::Builder::address(address.as_str())?.build().await })
                .await
                .map_err(|_| anyhow::anyhow!("the accessibility bus did not answer"))??;
            // Chromium, Electron, Firefox y Qt solo publican su árbol si hay
            // tecnologías de asistencia: se lo pedimos como haría un lector de pantalla.
            if let Some(session) = &session {
                let status = Obj::new("org.a11y.Bus", "/org/a11y/bus");
                if let Ok(value) = get_on(session, &status, "org.a11y.Status", "IsEnabled").await {
                    if bool::try_from(value).ok() == Some(false)
                        && set_on(session, &status, "org.a11y.Status", "IsEnabled", Variant::from(true)).await.is_ok() {
                        gateways.mark_enabled();
                    }
                }
            }
            Ok::<_, anyhow::Error>((conn, session))
        })?;
        Ok(Self { runtime, conn, session, gateways })
    }

    pub fn block<F: Future>(&self, future: F) -> F::Output {
        self.runtime.block_on(future)
    }

    pub fn conn(&self) -> &Connection {
        &self.conn
    }

    pub fn session(&self) -> Option<&Connection> {
        self.session.as_ref()
    }

    /// Trex encendió la accesibilidad de las apps (Chromium, Qt…) para estas sesiones.
    pub fn enabled_by_trex(&self) -> bool {
        self.gateways.enabled_by_trex()
    }

    /// Lee un árbol desde `root`, por niveles.
    pub fn tree(&self, root: &Obj, fetch: Fetch) -> Result<(Vec<Raw>, bool), ToolError> {
        let conn = self.conn.clone();
        self.block(tree(&conn, root, fetch))
    }
}

impl Drop for Bus {
    fn drop(&mut self) {
        if self.gateways.leave() {
            if let Some(session) = self.session.clone() {
                let status = Obj::new("org.a11y.Bus", "/org/a11y/bus");
                let _ = self.runtime.block_on(set_on(&session, &status, "org.a11y.Status", "IsEnabled", Variant::from(false)));
            }
        }
    }
}

// --- Llamadas ----------------------------------------------------------------------

/// Una llamada con plazo.
pub async fn call<B, R>(conn: &Connection, obj: &Obj, iface: &str, method: &str, body: &B) -> Result<R, ToolError>
where
    B: serde::Serialize + zbus::zvariant::DynamicType,
    R: serde::de::DeserializeOwned + zbus::zvariant::Type,
{
    call_within(conn, obj, iface, method, body, CALL_TIMEOUT).await
}

pub async fn call_within<B, R>(conn: &Connection, obj: &Obj, iface: &str, method: &str, body: &B, timeout: Duration) -> Result<R, ToolError>
where
    B: serde::Serialize + zbus::zvariant::DynamicType,
    R: serde::de::DeserializeOwned + zbus::zvariant::Type,
{
    if obj.is_null() {
        return Err(ToolError::new("STALE_REF", "The element no longer exists. Take a new snapshot."));
    }
    let reply = tokio::time::timeout(timeout, conn.call_method(Some(obj.bus.as_str()), obj.path.as_str(), Some(iface), method, body))
        .await
        .map_err(|_| uncertain())?
        .map_err(failure)?;
    reply.body().deserialize::<R>().map_err(|error| ToolError::new("ACTION_FAILED", format!("Unexpected reply to {method}: {error}")))
}

async fn get_on(conn: &Connection, obj: &Obj, iface: &str, name: &str) -> Result<OwnedValue, ToolError> {
    call(conn, obj, PROPERTIES, "Get", &(iface, name)).await
}

async fn set_on(conn: &Connection, obj: &Obj, iface: &str, name: &str, value: Variant<'_>) -> Result<(), ToolError> {
    call::<_, ()>(conn, obj, PROPERTIES, "Set", &(iface, name, value)).await
}

pub async fn get(conn: &Connection, obj: &Obj, iface: &str, name: &str) -> Result<OwnedValue, ToolError> {
    get_on(conn, obj, iface, name).await
}

pub async fn get_string(conn: &Connection, obj: &Obj, iface: &str, name: &str) -> Result<String, ToolError> {
    String::try_from(get(conn, obj, iface, name).await?).map_err(|error| ToolError::new("ACTION_FAILED", error.to_string()))
}

pub async fn get_f64(conn: &Connection, obj: &Obj, iface: &str, name: &str) -> Result<f64, ToolError> {
    f64::try_from(get(conn, obj, iface, name).await?).map_err(|error| ToolError::new("ACTION_FAILED", error.to_string()))
}

pub async fn get_i32(conn: &Connection, obj: &Obj, iface: &str, name: &str) -> Result<i32, ToolError> {
    i32::try_from(get(conn, obj, iface, name).await?).map_err(|error| ToolError::new("ACTION_FAILED", error.to_string()))
}

pub async fn set_f64(conn: &Connection, obj: &Obj, iface: &str, name: &str, value: f64) -> Result<(), ToolError> {
    set_on(conn, obj, iface, name, Variant::from(value)).await
}

pub async fn role(conn: &Connection, obj: &Obj) -> Result<u32, ToolError> {
    call(conn, obj, ACCESSIBLE, "GetRole", &()).await
}

pub async fn states(conn: &Connection, obj: &Obj) -> Result<States, ToolError> {
    call::<_, Vec<u32>>(conn, obj, ACCESSIBLE, "GetState", &()).await.map(|words| States::from_words(&words))
}

pub async fn name(conn: &Connection, obj: &Obj) -> Result<String, ToolError> {
    get_string(conn, obj, ACCESSIBLE, "Name").await
}

pub async fn ifaces(conn: &Connection, obj: &Obj) -> Result<Ifaces, ToolError> {
    call::<_, Vec<String>>(conn, obj, ACCESSIBLE, "GetInterfaces", &()).await.map(|names| Ifaces::from_names(&names))
}

pub async fn parent(conn: &Connection, obj: &Obj) -> Result<Option<Obj>, ToolError> {
    let value = get(conn, obj, ACCESSIBLE, "Parent").await?;
    let pair = <(String, OwnedObjectPath)>::try_from(value).map_err(|error| ToolError::new("ACTION_FAILED", error.to_string()))?;
    let parent = Obj::from_pair(pair);
    Ok((!parent.is_null()).then_some(parent))
}

pub async fn index_in_parent(conn: &Connection, obj: &Obj) -> Result<i32, ToolError> {
    call(conn, obj, ACCESSIBLE, "GetIndexInParent", &()).await
}

/// Los hijos de un elemento (como mucho `MAX_CHILDREN`).
pub async fn children(conn: &Connection, obj: &Obj) -> Result<Vec<Obj>, ToolError> {
    match call::<_, Vec<(String, OwnedObjectPath)>>(conn, obj, ACCESSIBLE, "GetChildren", &()).await {
        Ok(list) => Ok(list.into_iter().take(MAX_CHILDREN).map(Obj::from_pair).filter(|child| !child.is_null()).collect()),
        // Implementaciones antiguas sin GetChildren: uno a uno.
        Err(error) if error.code == "NOT_SUPPORTED" => {
            let count = get_i32(conn, obj, ACCESSIBLE, "ChildCount").await?.clamp(0, MAX_CHILDREN as i32);
            let replies = stream::iter(0..count)
                .map(|index| async move { call::<_, (String, OwnedObjectPath)>(conn, obj, ACCESSIBLE, "GetChildAtIndex", &(index,)).await })
                .buffered(IN_FLIGHT)
                .collect::<Vec<_>>()
                .await;
            Ok(replies.into_iter().filter_map(Result::ok).map(Obj::from_pair).filter(|child| !child.is_null()).collect())
        }
        Err(error) => Err(error),
    }
}

/// Rol, estados, nombre, interfaces y (si se pide) hijos, a la vez.
pub async fn info(conn: &Connection, obj: &Obj, with_children: bool) -> Result<Info, ToolError> {
    let (role, states, name, ifaces, children) = tokio::join!(
        role(conn, obj),
        states(conn, obj),
        name(conn, obj),
        ifaces(conn, obj),
        async { if with_children { children(conn, obj).await } else { Ok(Vec::new()) } }
    );
    let states = states?;
    Ok(Info { role: role?, states, name: name.unwrap_or_default(), ifaces: ifaces.unwrap_or_default(), children: children.unwrap_or_default() })
}

/// Nombres de las acciones, en minúsculas. Son los nombres estables (`GetName`):
/// `GetActions` los da traducidos («pulsar» en vez de «click»).
pub async fn actions(conn: &Connection, obj: &Obj) -> Result<Vec<String>, ToolError> {
    let count = get_i32(conn, obj, ACTION, "NActions").await?.clamp(0, 64);
    let names = stream::iter(0..count)
        .map(|index| async move { call::<_, String>(conn, obj, ACTION, "GetName", &(index,)).await })
        .buffered(IN_FLIGHT)
        .collect::<Vec<_>>()
        .await;
    Ok(names.into_iter().map(|name| name.unwrap_or_default().to_lowercase()).collect())
}

pub async fn do_action(conn: &Connection, obj: &Obj, index: usize) -> Result<bool, ToolError> {
    call_within(conn, obj, ACTION, "DoAction", &(index as i32,), ACTION_TIMEOUT).await
}

/// Texto de un elemento con Text: de `start` a `end` (-1, hasta el final).
pub async fn text(conn: &Connection, obj: &Obj, start: i32, end: i32) -> Result<String, ToolError> {
    call(conn, obj, TEXT, "GetText", &(start, end)).await
}

pub async fn set_text(conn: &Connection, obj: &Obj, value: &str) -> Result<bool, ToolError> {
    call_within(conn, obj, EDITABLE_TEXT, "SetTextContents", &(value,), ACTION_TIMEOUT).await
}

pub async fn attributes(conn: &Connection, obj: &Obj) -> Result<HashMap<String, String>, ToolError> {
    call(conn, obj, ACCESSIBLE, "GetAttributes", &()).await
}

pub async fn extents(conn: &Connection, obj: &Obj) -> Result<(i32, i32, i32, i32), ToolError> {
    call(conn, obj, COMPONENT, "GetExtents", &(COORDS_WINDOW,)).await
}

pub async fn scroll_to(conn: &Connection, obj: &Obj) -> Result<bool, ToolError> {
    call_within(conn, obj, COMPONENT, "ScrollTo", &(SCROLL_ANYWHERE,), ACTION_TIMEOUT).await
}

pub async fn grab_focus(conn: &Connection, obj: &Obj) -> Result<bool, ToolError> {
    call(conn, obj, COMPONENT, "GrabFocus", &()).await
}

pub async fn select_child(conn: &Connection, container: &Obj, index: i32) -> Result<bool, ToolError> {
    call_within(conn, container, SELECTION, "SelectChild", &(index,), ACTION_TIMEOUT).await
}

/// Proceso dueño de un nombre del bus de accesibilidad.
pub async fn process_id(conn: &Connection, bus: &str) -> Result<u32, ToolError> {
    let daemon = Obj::new("org.freedesktop.DBus", "/org/freedesktop/DBus");
    call(conn, &daemon, "org.freedesktop.DBus", "GetConnectionUnixProcessID", &(bus,)).await
}

/// Milisegundos desde la última entrada de la persona, según GNOME (Mutter);
/// None fuera de GNOME.
pub async fn idle_ms(session: &Connection) -> Option<u64> {
    let monitor = Obj::new("org.gnome.Mutter.IdleMonitor", "/org/gnome/Mutter/IdleMonitor/Core");
    call::<_, u64>(session, &monitor, "org.gnome.Mutter.IdleMonitor", "GetIdletime", &()).await.ok()
}

/// Rol de texto que hace falta leer para mostrar su valor.
pub fn text_role(role: u32) -> bool {
    matches!(role, role::TEXT | role::ENTRY | role::PASSWORD_TEXT | role::SPIN_BUTTON | role::COMBO_BOX | role::AUTOCOMPLETE | role::TERMINAL)
}

/// Rol cuyo texto (sin nombre) es lo que se lee en una página.
pub fn reading_role(role: u32) -> bool {
    matches!(role, role::PARAGRAPH | role::HEADING | role::STATIC | role::LABEL | role::SECTION | role::LIST_ITEM | role::TABLE_CELL
        | role::CAPTION | role::BLOCK_QUOTE | role::LINK | role::TEXT | role::ARTICLE | role::FOOTER | role::HEADER)
}

/// Lee un árbol por niveles. Devuelve los elementos (el primero es la raíz) y si se recortó.
pub async fn tree(conn: &Connection, root: &Obj, fetch: Fetch) -> Result<(Vec<Raw>, bool), ToolError> {
    let mut nodes: Vec<Raw> = Vec::new();
    let mut truncated = false;
    let mut level: Vec<(Obj, Option<usize>, usize, bool)> = vec![(root.clone(), None, 0, false)];
    while !level.is_empty() {
        let infos = stream::iter(level.iter().map(|(obj, ..)| obj.clone()).collect::<Vec<_>>())
            .map(|obj| async move { info(conn, &obj, true).await })
            .buffered(IN_FLIGHT)
            .collect::<Vec<_>>()
            .await;
        let mut next = Vec::new();
        for ((obj, parent, depth, inherited), info) in level.into_iter().zip(infos) {
            let info = match info {
                Ok(info) => info,
                Err(error) if parent.is_none() => return Err(error),
                Err(_) => continue,
            };
            if parent.is_some() && (hidden(info.states) || info.states.has(state::DEFUNCT)) {
                continue;
            }
            // Las entradas de un menú cerrado no se ven (aunque digan que son visibles).
            let closed_menu = parent.is_some_and(|parent| matches!(nodes[parent].info.role, role::MENU | role::POPUP_MENU))
                && !info.states.has(state::SHOWING);
            if fetch.prune_hidden && !inherited && closed_menu {
                continue;
            }
            if nodes.len() >= fetch.max_nodes {
                truncated = true;
                break;
            }
            let in_document = inherited || is_document(info.role);
            let index = nodes.len();
            if let Some(parent) = parent {
                nodes[parent].kids.push(index);
            }
            if depth < fetch.max_depth && descend(&info, in_document, fetch.prune_hidden) {
                next.extend(info.children.iter().map(|child| (child.clone(), Some(index), depth + 1, in_document)));
            }
            nodes.push(Raw { obj, parent, info, ..Raw::default() });
        }
        if truncated {
            break;
        }
        level = next;
    }
    extras(conn, &mut nodes, fetch.texts).await;
    Ok((nodes, truncated))
}

/// Lo que solo algunos elementos necesitan: acciones, texto, valor numérico y
/// el valor que anuncian los desplegables.
pub async fn extras(conn: &Connection, nodes: &mut [Raw], texts: bool) {
    let wanted: Vec<(usize, Obj, Info)> = nodes.iter().enumerate().map(|(index, raw)| (index, raw.obj.clone(), raw.info.clone())).collect();
    let results = stream::iter(wanted)
        .map(|(index, obj, info)| async move {
            let read_text = info.ifaces.has(Ifaces::TEXT)
                && (text_role(info.role) || (texts && info.name.trim().is_empty() && reading_role(info.role)));
            let (actions, text, number, attributes) = tokio::join!(
                async { if info.ifaces.has(Ifaces::ACTION) { actions(conn, &obj).await.unwrap_or_default() } else { Vec::new() } },
                async { if read_text { text(conn, &obj, 0, 4_000).await.ok() } else { None } },
                async { if info.ifaces.has(Ifaces::VALUE) { get_f64(conn, &obj, VALUE, "CurrentValue").await.ok() } else { None } },
                async { if info.role == role::COMBO_BOX { attributes(conn, &obj).await.ok() } else { None } }
            );
            (index, actions, text, number, attributes.and_then(|mut map| map.remove("valuetext")))
        })
        .buffered(IN_FLIGHT)
        .collect::<Vec<_>>()
        .await;
    for (index, actions, text, number, valuetext) in results {
        let raw = &mut nodes[index];
        raw.actions = actions;
        raw.text = text;
        raw.number = number;
        raw.valuetext = valuetext;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn states_interfaces_and_pruning() {
        let states = States::from_words(&[(1 << state::SHOWING) | (1 << state::FOCUSED), 1 << (state::READ_ONLY - 32)]);
        assert!(states.has(state::SHOWING) && states.has(state::FOCUSED) && states.has(state::READ_ONLY));
        assert!(!states.has(state::CHECKED) && !states.has(99));
        assert_eq!(States::of(&[state::SHOWING, state::READ_ONLY]), States((1 << 25) | (1 << 43)));
        let ifaces = Ifaces::from_names(&["org.a11y.atspi.Accessible".into(), "org.a11y.atspi.Action".into(), "org.a11y.atspi.EditableText".into()]);
        assert!(ifaces.has(Ifaces::ACTION) && ifaces.has(Ifaces::EDITABLE_TEXT) && !ifaces.has(Ifaces::TEXT));
        let page = Info { role: role::PANEL, states: States::of(&[state::VISIBLE]), ..Info::default() };
        assert!(!descend(&page, false, true), "a hidden stack page is not walked");
        assert!(descend(&page, true, true), "inside a web page, content beyond the window is still content");
        assert!(descend(&page, false, false));
        let button = Info { role: role::BUTTON, states: States::of(&[state::VISIBLE]), ..Info::default() };
        assert!(descend(&button, false, true), "an off-screen control is listed (scroll_to brings it)");
        assert!(hidden(States::default()) && !hidden(States::of(&[state::VISIBLE])));
        assert!(Obj::new("", "/x").is_null() && Obj::new(":1.2", "/org/a11y/atspi/null").is_null() && !Obj::new(":1.2", "/a").is_null());
    }

    #[test]
    fn the_last_gateway_out_turns_accessibility_back_off() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().to_path_buf();
        let first = Gateways::join(path.clone(), std::process::id());
        first.mark_enabled();
        // Otra pasarela viva (el proceso 1 siempre existe) y una que terminó de golpe.
        let other = Gateways::join(path.clone(), 1);
        std::fs::write(path.join("gateway-4000000000"), "").unwrap();
        assert!(first.enabled_by_trex());
        assert!(!first.leave(), "another chat still uses it");
        assert!(!path.join("gateway-4000000000").exists(), "stale entries are cleaned up");
        let last = other;
        assert!(last.leave(), "the last one turns it off");
        assert!(!last.enabled_by_trex());
        let again = Gateways::join(path, std::process::id());
        assert!(!again.leave(), "nothing to turn off when Trex did not turn it on");
    }

    #[test]
    fn password_text_and_page_text() {
        assert!(obscured("•••") && obscured("●●") && !obscured("") && !obscured("a•"));
        assert_eq!(plain("Hola \u{FFFC} mundo\u{FFFC}"), "Hola mundo");
        assert!(text_role(role::ENTRY) && !text_role(role::BUTTON));
        assert!(reading_role(role::PARAGRAPH) && !reading_role(role::BUTTON));
        assert!(is_document(role::DOCUMENT_WEB) && !is_document(role::FRAME));
    }
}
