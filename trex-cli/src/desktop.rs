//! Explicitly enabled desktop access. Screenshots and input share an observation token (a few inputs, 30 s).
use crate::tools::{ToolFuture, ToolProvider};
use anyhow::{bail, ensure, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
#[cfg(not(windows))]
use enigo::Coordinate;
use enigo::{Axis, Button, Direction, Enigo, Key, Keyboard, Mouse, Settings};
use image::GenericImageView;
use serde_json::{json, Value};
use std::{
    io::Cursor,
    path::Path,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio_util::sync::CancellationToken;

#[cfg(target_os = "linux")]
mod wayland;
#[cfg(windows)]
mod windows;
pub(crate) struct DesktopLease(std::fs::File);
impl DesktopLease {
    pub(crate) fn acquire() -> Result<Self> {
        Ok(Self(crate::profile::global_control_lock()?))
    }
    pub(crate) fn generation(&mut self) -> Result<u64> {
        use std::io::{Read, Seek, SeekFrom};
        self.0.seek(SeekFrom::Start(0))?;
        let mut bytes = [0; 8];
        match self.0.read_exact(&mut bytes) {
            Ok(()) => Ok(u64::from_le_bytes(bytes)),
            Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => Ok(0),
            Err(e) => Err(e.into()),
        }
    }
    pub(crate) fn advance(&mut self) -> Result<()> {
        use std::io::{Seek, SeekFrom, Write};
        let n = self
            .generation()?
            .checked_add(1)
            .context("desktop generation exhausted")?;
        self.0.seek(SeekFrom::Start(0))?;
        self.0.write_all(&n.to_le_bytes())?;
        self.0.sync_data()?;
        Ok(())
    }
}
// Input from different chat sessions must never interleave modifier/button state.
static DESKTOP_ACCESS: Mutex<()> = Mutex::new(());

pub async fn doctor() -> Result<Value> {
    #[cfg(target_os = "linux")]
    if wayland::active() {
        return Ok(wayland::probe().await);
    }
    status()
}

pub fn read_only(name: &str) -> bool {
    matches!(
        name,
        "desktop_screenshot" | "desktop_status" | "desktop_monitors" | "desktop_wait"
    )
}

#[derive(Debug)]
pub struct DesktopUncertain;
impl std::fmt::Display for DesktopUncertain {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Desktop input may have been applied; inspect the screen before continuing. Do not automatically retry.")
    }
}
impl std::error::Error for DesktopUncertain {}

#[derive(Clone)]
struct Observation {
    token: String,
    width: u32,
    height: u32,
    /// Captured area in screen pixels (the image may be downscaled).
    region: [u32; 4],
    /// Full monitor size in screen pixels (Windows re-validates the monitor).
    #[cfg_attr(not(windows), allow(dead_code))]
    screen: (u32, u32),
    uses: u8,
    origin_x: i32,
    origin_y: i32,
    captured_at: Instant,
    generation: u64,
    #[cfg(windows)]
    monitor: u32,
    #[cfg(windows)]
    focus: Option<(usize, u32)>,
}
#[derive(Default)]
pub struct DesktopProvider {
    observation: Arc<Mutex<Option<Observation>>>,
    #[cfg(target_os = "linux")]
    portal: Arc<tokio::sync::Mutex<wayland::PortalState>>,
}

/// Cómo usar el control de computadora: la misma guía para el servidor MCP
/// (Claude, Codex) y para las sesiones de Trex CLI.
pub fn guidance(read_only: bool) -> String {
    let permissions = if read_only {
        "This process is read-only: status, monitors, screenshots and waits only. Input is unavailable."
    } else {
        "Input tools are available subject to the host agent's permission policy. Use their schemas for pointer motion, double clicks, gradual drag, vertical or horizontal scroll, typing and shortcuts."
    };
    format!("Trex desktop controls the real computer with screenshots and real mouse and keyboard input; it is separate from the trex_browser project browser and from accessibility control. Start with desktop_screenshot (primary screen unless monitor is given; it says how many screens there are, desktop_monitors lists them) and check the screen and focus before input. Input coordinates are pixels of the latest screenshot image. For cheaper captures use region (screen pixels) or maxEdge. One observation serves up to 3 inputs within 30 seconds while the screen is unchanged; capture again after focus, layout or display changes. {permissions} Never claim an unadvertised capability; if unavailable, explain the diagnostic rather than silently switching control systems. Never automatically replay uncertain input. A desktop-control failure says nothing about Trex Browser, whose websites go through browser_navigate.")
}

impl ToolProvider for DesktopProvider {
    fn guidance(&self, mode: &str) -> Option<String> {
        Some(guidance(mode == "plan"))
    }
    fn invalidate_observation(&self) {
        #[cfg(target_os = "linux")]
        if let Ok(mut portal) = self.portal.try_lock() {
            portal.invalidate();
        }
        if let Ok(mut state) = self.observation.lock() {
            *state = None;
        }
    }
    fn shutdown<'a>(&'a self) -> ToolFuture<'a> {
        Box::pin(async move {
            self.invalidate_observation();
            #[cfg(target_os = "linux")]
            self.portal.lock().await.close().await;
            Ok(json!({"closed":true}))
        })
    }
    fn definitions(&self, mode: &str) -> Vec<Value> {
        let specs = [
            ("desktop_status", "Check desktop backend and availability without taking a screenshot or sending input.", json!({}), vec![]),
            ("desktop_monitors", "List screens with physical-pixel origins, dimensions and IDs. Windows screenshots can select a monitor by ID.", json!({}), vec![]),
            ("desktop_wait", "Wait for the desktop to settle, in milliseconds (0 to 10000). Capture again afterwards before input.", json!({"milliseconds":{"type":"integer","minimum":0,"maximum":10000}}), vec!["milliseconds"]),
            ("desktop_screenshot", "Capture a screen (the primary unless monitor is given; the result says how many there are), downscaled to 1280 px on its long edge. region {x,y,width,height} in screen pixels captures only that area, sharper and cheaper. maxEdge (256-1568) sets the long edge: 768 px costs about 440 tokens, enough to check a change. fullResolution:true keeps up to 1568 px, the most a model sees. The observation serves up to 3 inputs within 30 s while the screen is unchanged.", json!({"monitor":{"type":"integer","minimum":0},"region":{"type":"object","properties":{"x":{"type":"integer","minimum":0},"y":{"type":"integer","minimum":0},"width":{"type":"integer","minimum":16},"height":{"type":"integer","minimum":16}},"required":["x","y","width","height"],"additionalProperties":false},"maxEdge":{"type":"integer","minimum":256,"maximum":1568},"fullResolution":{"type":"boolean"}}), vec![]),
            ("desktop_move", "Move the pointer to a point in the latest screenshot without clicking. Coordinates are screenshot pixels.", json!({"observation":{"type":"string"},"x":{"type":"integer","minimum":0},"y":{"type":"integer","minimum":0}}), vec!["observation","x","y"]),
            ("desktop_click", "Click a point in the latest desktop screenshot. Coordinates are screenshot pixels. Use clicks:2 for a double click.", json!({"observation":{"type":"string"},"x":{"type":"integer","minimum":0},"y":{"type":"integer","minimum":0},"button":{"type":"string","enum":["left","right","middle"]},"clicks":{"type":"integer","minimum":1,"maximum":2}}), vec!["observation","x","y"]),
            ("desktop_scroll", "Scroll at a point in the latest screenshot. Positive amount scrolls down (vertical) or right (horizontal).", json!({"observation":{"type":"string"},"x":{"type":"integer","minimum":0},"y":{"type":"integer","minimum":0},"amount":{"type":"integer","minimum":-20,"maximum":20},"axis":{"type":"string","enum":["vertical","horizontal"]}}), vec!["observation","x","y","amount"]),
            ("desktop_type", "Type text into the currently focused control. Verify focus from the latest screenshot (a click just made on the field counts).", json!({"observation":{"type":"string"},"text":{"type":"string","maxLength":4000}}), vec!["observation","text"]),
            ("desktop_key", "Press a key or keyboard shortcut in the focused control. Keys: enter, tab, escape, backspace, delete, arrows, home, end, pageup, pagedown, space, or one character. Modifiers: ctrl, alt, shift, meta.", json!({"observation":{"type":"string"},"key":{"type":"string"},"modifiers":{"type":"array","maxItems":4,"items":{"type":"string","enum":["ctrl","alt","shift","meta"]}}}), vec!["observation","key"]),
            ("desktop_drag", "Drag between points in the latest desktop screenshot using the left button.", json!({"observation":{"type":"string"},"x":{"type":"integer","minimum":0},"y":{"type":"integer","minimum":0},"toX":{"type":"integer","minimum":0},"toY":{"type":"integer","minimum":0}}), vec!["observation","x","y","toX","toY"]),
        ];
        specs.into_iter().filter(|(name,_,_,_)| mode != "plan" || read_only(name)).map(|(name,description,properties,required)| json!({"type":"function","function":{"name":name,"description":description,"parameters":{"type":"object","properties":properties,"required":required,"additionalProperties":false}}})).collect()
    }
    fn is_mutating(&self, name: &str, _: &Value) -> bool {
        !read_only(name)
    }
    fn execute<'a>(
        &'a self,
        _: &'a Path,
        mode: &'a str,
        name: &'a str,
        input: &'a Value,
        _: &'a str,
        cancel: CancellationToken,
    ) -> ToolFuture<'a> {
        Box::pin(async move {
            ensure!(!cancel.is_cancelled(), "cancelled before desktop operation");
            #[cfg(target_os = "linux")]
            if wayland::active() {
                return self
                    .portal
                    .lock()
                    .await
                    .run(mode, name, input, cancel)
                    .await;
            }
            ensure!(
                mode != "plan" || read_only(name),
                "plan mode forbids desktop input"
            );
            if name == "desktop_wait" {
                validate_fields(input, &["milliseconds"], &["milliseconds"])?;
                let milliseconds = input["milliseconds"]
                    .as_u64()
                    .filter(|n| *n <= 10000)
                    .context("milliseconds must be 0..10000")?;
                self.invalidate_observation();
                tokio::select! {
                    _ = cancel.cancelled() => bail!("cancelled before desktop wait completed"),
                    _ = tokio::time::sleep(Duration::from_millis(milliseconds)) => return Ok(json!({"completed":true,"milliseconds":milliseconds})),
                }
            }
            let input = input.clone();
            let name = name.to_string();
            let state = self.observation.clone();
            tokio::task::spawn_blocking(move || run(&state, &name, &input, &cancel))
                .await
                .context("desktop worker failed")?
        })
    }
}

fn validate_fields(input: &Value, allowed: &[&str], required: &[&str]) -> Result<()> {
    let obj = input.as_object().context("expected an object")?;
    ensure!(
        obj.keys().all(|k| allowed.contains(&k.as_str())),
        "unknown desktop argument"
    );
    ensure!(
        required.iter().all(|k| obj.contains_key(*k)),
        "missing desktop argument"
    );
    Ok(())
}
fn point(input: &Value, x: &str, y: &str, o: &Observation) -> Result<(i32, i32)> {
    let x = input[x].as_u64().context("invalid x")?;
    let y = input[y].as_u64().context("invalid y")?;
    let (x, y) = frame_point(x, y, o.width, o.height, o.region)?;
    Ok((
        o.origin_x
            .checked_add(i32::try_from(x).context("invalid x")?)
            .context("invalid x")?,
        o.origin_y
            .checked_add(i32::try_from(y).context("invalid y")?)
            .context("invalid y")?,
    ))
}
/// Long edge of a default screenshot. 1280 px costs a model about 1.1k image
/// tokens; a 1920x1080 capture about 1.8k (and 4K is downscaled anyway).
const SCREENSHOT_EDGE: u32 = 1280;
/// Lo más que ve un modelo: Claude reduce lo que pase de aquí, y entonces los
/// píxeles de la imagen ya no coincidirían con los de la pantalla.
pub(crate) const MODEL_EDGE: u32 = 1568;
const MIN_EDGE: u32 = 256;
/// Identificadores cortos de observación (el modelo los copia en cada entrada).
static NEXT_OBSERVATION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
/// Inputs one screenshot may drive while the screen is unchanged, e.g. click
/// a field, type, press Enter. Each extra screenshot stays in the context.
pub(crate) const OBSERVATION_USES: u8 = 3;
pub(crate) const SCREENSHOT_FIELDS: &[&str] = &["monitor", "region", "fullResolution", "maxEdge"];

/// A capture prepared for a model: cropped to a region, downscaled, PNG.
pub(crate) struct Framed {
    pub png: Vec<u8>,
    pub width: u32,
    pub height: u32,
    /// x, y, width, height of the captured area in screen pixels.
    pub region: [u32; 4],
    pub screen: (u32, u32),
}
impl Framed {
    pub(crate) fn scale(&self) -> f64 {
        f64::from(self.width) / f64::from(self.region[2])
    }
    /// An image pixel of this screenshot as a screen pixel.
    #[cfg(test)]
    fn to_screen(&self, x: u64, y: u64) -> Result<(u32, u32)> {
        frame_point(x, y, self.width, self.height, self.region)
    }
    /// Lo que el modelo necesita para actuar, sin repetir la descripción de la
    /// herramienta. `monitors` es cuántas pantallas hay (se nombra solo si hay varias).
    pub(crate) fn summary(&self, token: &str, monitor: u32, monitors: usize) -> String {
        let area = if self.region == [0, 0, self.screen.0, self.screen.1] {
            String::new()
        } else {
            format!(
                ", region x={} y={} {}x{}",
                self.region[0], self.region[1], self.region[2], self.region[3]
            )
        };
        let screens = if monitors > 1 { format!(", monitor {monitor} of {monitors}") } else { String::new() };
        format!(
            "Screenshot {}x{} of screen {}x{}{area}{screens}, scale {:.3}, observation {token}. Coordinates are pixels of this image; valid for {OBSERVATION_USES} inputs within 30 s while nothing moves.",
            self.width,
            self.height,
            self.screen.0,
            self.screen.1,
            self.scale()
        )
    }
    pub(crate) fn structured(&self) -> Value {
        json!({"width":self.width,"height":self.height,"screenWidth":self.screen.0,"screenHeight":self.screen.1,
            "region":{"x":self.region[0],"y":self.region[1],"width":self.region[2],"height":self.region[3]},
            "scale":self.scale(),"coordinateSpace":"imagePixels","uses":OBSERVATION_USES,"expiresInMs":30000})
    }
}
pub(crate) fn frame_point(x: u64, y: u64, width: u32, height: u32, region: [u32; 4]) -> Result<(u32, u32)> {
    ensure!(
        x < u64::from(width) && y < u64::from(height),
        "point outside screenshot"
    );
    let map = |v: u64, size: u32, offset: u32, span: u32| -> u32 {
        let screen = ((v as f64 + 0.5) * f64::from(span) / f64::from(size)).floor() as u32;
        offset + screen.min(span - 1)
    };
    Ok((
        map(x, width, region[0], region[2]),
        map(y, height, region[1], region[3]),
    ))
}
/// Reads desktop_screenshot's region / maxEdge / fullResolution arguments: the
/// region in screen pixels and the long edge of the image.
pub(crate) fn screenshot_options(input: &Value) -> Result<(Option<[u32; 4]>, u32)> {
    validate_fields(input, SCREENSHOT_FIELDS, &[])?;
    let full = match input.get("fullResolution") {
        None => false,
        Some(v) => v.as_bool().context("fullResolution must be a boolean")?,
    };
    let edge = match input.get("maxEdge") {
        None => if full { MODEL_EDGE } else { SCREENSHOT_EDGE },
        Some(_) if full => bail!("use maxEdge or fullResolution, not both"),
        Some(v) => {
            let edge = v.as_u64().and_then(|n| u32::try_from(n).ok()).context("maxEdge must be an integer")?;
            ensure!((MIN_EDGE..=MODEL_EDGE).contains(&edge), "maxEdge must be between {MIN_EDGE} and {MODEL_EDGE}");
            edge
        }
    };
    let region = match input.get("region") {
        None => None,
        Some(r) => {
            validate_fields(r, &["x", "y", "width", "height"], &["x", "y", "width", "height"])?;
            let n = |k: &str| {
                r[k].as_u64()
                    .and_then(|v| u32::try_from(v).ok())
                    .context("invalid region")
            };
            let region = [n("x")?, n("y")?, n("width")?, n("height")?];
            ensure!(
                region[2] >= 16 && region[3] >= 16,
                "region must be at least 16x16 screen pixels"
            );
            Some(region)
        }
    };
    Ok((region, edge))
}
pub(crate) fn frame(
    image: image::DynamicImage,
    region: Option<[u32; 4]>,
    max_edge: u32,
) -> Result<Framed> {
    let screen = image.dimensions();
    let whole = [0, 0, screen.0, screen.1];
    let region = region.unwrap_or(whole);
    ensure!(
        u64::from(region[0]) + u64::from(region[2]) <= u64::from(screen.0)
            && u64::from(region[1]) + u64::from(region[3]) <= u64::from(screen.1),
        "region outside the screen ({}x{} screen pixels)",
        screen.0,
        screen.1
    );
    let mut image = if region == whole {
        image
    } else {
        image.crop_imm(region[0], region[1], region[2], region[3])
    };
    let edge = region[2].max(region[3]);
    if edge > max_edge {
        let scale = f64::from(max_edge) / f64::from(edge);
        let w = ((f64::from(region[2]) * scale).round() as u32).max(1);
        let h = ((f64::from(region[3]) * scale).round() as u32).max(1);
        // Catmull-Rom conserva mejor el texto pequeño que el filtro triangular.
        image = image.resize_exact(w, h, image::imageops::FilterType::CatmullRom);
    }
    let (width, height) = image.dimensions();
    let mut bytes = Cursor::new(Vec::new());
    image.write_to(&mut bytes, image::ImageFormat::Png)?;
    Ok(Framed {
        png: bytes.into_inner(),
        width,
        height,
        region,
        screen,
    })
}
fn key(value: &str) -> Result<Key> {
    Ok(match value.to_lowercase().as_str() {
        "enter" => Key::Return,
        "tab" => Key::Tab,
        "escape" => Key::Escape,
        "backspace" => Key::Backspace,
        "delete" => Key::Delete,
        "up" => Key::UpArrow,
        "down" => Key::DownArrow,
        "left" => Key::LeftArrow,
        "right" => Key::RightArrow,
        "home" => Key::Home,
        "end" => Key::End,
        "pageup" => Key::PageUp,
        "pagedown" => Key::PageDown,
        "space" => Key::Space,
        _ => {
            let mut chars = value.chars();
            let c = chars.next().context("empty key")?;
            ensure!(chars.next().is_none() && !c.is_control(), "unsupported key");
            Key::Unicode(c)
        }
    })
}
fn run(
    state: &Mutex<Option<Observation>>,
    name: &str,
    input: &Value,
    cancel: &CancellationToken,
) -> Result<Value> {
    let _access = DESKTOP_ACCESS
        .lock()
        .map_err(|_| anyhow::anyhow!("desktop input unavailable"))?;
    ensure!(!cancel.is_cancelled(), "cancelled before desktop operation");
    let mut lease = if name == "desktop_status" || name == "desktop_monitors" {
        None
    } else {
        Some(DesktopLease::acquire()?)
    };
    #[cfg(windows)]
    let _dpi = windows::DpiScope::enter()?;
    let mut state = state
        .lock()
        .map_err(|_| anyhow::anyhow!("desktop session unavailable"))?;
    ensure!(!cancel.is_cancelled(), "cancelled before desktop operation");
    if name == "desktop_status" || name == "desktop_monitors" {
        validate_fields(input, &[], &[])?;
        return if name == "desktop_status" {
            status()
        } else {
            monitors()
        };
    }
    if name == "desktop_screenshot" {
        let (region, edge) = screenshot_options(input)?;
        let monitor = input
            .get("monitor")
            .map(|value| {
                value
                    .as_u64()
                    .and_then(|n| u32::try_from(n).ok())
                    .context("invalid monitor ID")
            })
            .transpose()?;
        *state = None;
        #[cfg(windows)]
        let captured_focus = windows::focus();
        let (image, x, y, monitor) = capture(monitor)?;
        let framed = frame(image, region, edge)?;
        let (width, height) = (framed.width, framed.height);
        ensure!(
            !cancel.is_cancelled(),
            "cancelled before screenshot delivery"
        );
        #[cfg(windows)]
        ensure!(
            windows::focus() == captured_focus,
            "foreground changed while capturing; take a fresh screenshot"
        );
        ensure!(
            framed.png.len() <= 4 * 1024 * 1024,
            "screenshot exceeds artifact size limit"
        );
        let token = format!("o{}", NEXT_OBSERVATION.fetch_add(1, std::sync::atomic::Ordering::Relaxed));
        *state = Some(Observation {
            token: token.clone(),
            width,
            height,
            region: framed.region,
            screen: framed.screen,
            uses: OBSERVATION_USES,
            origin_x: x,
            origin_y: y,
            captured_at: Instant::now(),
            generation: lease
                .as_mut()
                .context("desktop lease unavailable")?
                .generation()?,
            #[cfg(windows)]
            monitor,
            #[cfg(windows)]
            focus: captured_focus,
        });
        // Cuántas pantallas hay: así no hace falta preguntar antes con desktop_monitors.
        let screens = monitors().ok().and_then(|list| list["monitors"].as_array().map(Vec::len)).unwrap_or(1);
        let mut structured = framed.structured();
        structured["observation"] = json!(token);
        structured["monitors"] = json!(screens);
        structured["originX"] = json!(x);
        structured["originY"] = json!(y);
        structured["monitor"] = json!(monitor);
        return Ok(
            json!({"content":[{"type":"text","text":framed.summary(&token, monitor, screens)},{"type":"image","mimeType":"image/png","data":STANDARD.encode(&framed.png)}],"structuredContent":structured}),
        );
    }
    let (allowed, required): (&[&str], &[&str]) = match name {
        "desktop_click" => (
            &["observation", "x", "y", "button", "clicks"],
            &["observation", "x", "y"],
        ),
        "desktop_scroll" => (
            &["observation", "x", "y", "amount", "axis"],
            &["observation", "x", "y", "amount"],
        ),
        "desktop_move" => (&["observation", "x", "y"], &["observation", "x", "y"]),
        "desktop_drag" => (
            &["observation", "x", "y", "toX", "toY"],
            &["observation", "x", "y", "toX", "toY"],
        ),
        "desktop_type" => (&["observation", "text"], &["observation", "text"]),
        "desktop_key" => (
            &["observation", "key", "modifiers"],
            &["observation", "key"],
        ),
        _ => bail!("unknown desktop tool"),
    };
    validate_fields(input, allowed, required)?;
    let observation = state
        .as_ref()
        .context("take a fresh screenshot first")?
        .clone();
    ensure!(
        input["observation"].as_str() == Some(&observation.token),
        "stale desktop observation; take a new screenshot"
    );
    if observation.captured_at.elapsed() > Duration::from_secs(30) {
        *state = None;
        bail!("desktop observation expired; take a fresh screenshot");
    }
    ensure!(
        lease
            .as_mut()
            .context("desktop lease unavailable")?
            .generation()?
            == observation.generation,
        "another agent changed the desktop; take a fresh screenshot"
    );
    // Validate every argument before connecting to the desktop or consuming the token.
    let mut points = None;
    let mut end = None;
    let mut button = Button::Left;
    let mut amount = 0;
    let mut axis = Axis::Vertical;
    let mut clicks = 1;
    let mut typed = "";
    let mut pressed_key = Key::Return;
    let mut modifiers = Vec::new();
    if matches!(
        name,
        "desktop_click" | "desktop_scroll" | "desktop_drag" | "desktop_move"
    ) {
        points = Some(point(input, "x", "y", &observation)?);
    }
    if name == "desktop_drag" {
        end = Some(point(input, "toX", "toY", &observation)?);
    }
    if name == "desktop_click" {
        button = match input.get("button").map(|v| v.as_str()) {
            None | Some(Some("left")) => Button::Left,
            Some(Some("right")) => Button::Right,
            Some(Some("middle")) => Button::Middle,
            _ => bail!("invalid button"),
        };
        if let Some(value) = input.get("clicks") {
            clicks = value
                .as_u64()
                .filter(|n| (1..=2).contains(n))
                .context("clicks must be 1 or 2")?;
        }
    }
    if name == "desktop_scroll" {
        amount = input["amount"].as_i64().context("invalid amount")?;
        ensure!(
            (-20..=20).contains(&amount) && amount != 0,
            "invalid scroll amount"
        );
        axis = match input.get("axis").and_then(Value::as_str) {
            Some("horizontal") => Axis::Horizontal,
            Some("vertical") => Axis::Vertical,
            None if !input.as_object().unwrap().contains_key("axis") => Axis::Vertical,
            _ => bail!("invalid scroll axis"),
        };
    }
    if name == "desktop_type" {
        typed = input["text"].as_str().context("invalid text")?;
        ensure!(
            !typed.is_empty() && typed.len() <= 4000 && !typed.contains('\0'),
            "invalid text"
        );
    }
    if name == "desktop_key" {
        pressed_key = key(input["key"].as_str().context("invalid key")?)?;
        if let Some(raw) = input.get("modifiers") {
            let list = raw.as_array().context("invalid modifiers")?;
            ensure!(list.len() <= 4, "too many modifiers");
            for item in list {
                let modifier = match item.as_str() {
                    Some("ctrl") => Key::Control,
                    Some("alt") => Key::Alt,
                    Some("shift") => Key::Shift,
                    Some("meta") => Key::Meta,
                    _ => bail!("invalid modifier"),
                };
                ensure!(!modifiers.contains(&modifier), "duplicate modifier");
                modifiers.push(modifier);
            }
        }
    }
    check_platform()?;
    #[cfg(windows)]
    {
        windows::ensure_interactive()?;
        windows::validate_monitor(
            observation.monitor,
            observation.origin_x,
            observation.origin_y,
            observation.screen.0,
            observation.screen.1,
        )?;
        if matches!(name, "desktop_key" | "desktop_type") {
            ensure!(
                observation.focus.is_some() && windows::focus() == observation.focus,
                "foreground window changed; take a fresh screenshot before typing"
            );
        }
    }
    ensure!(!cancel.is_cancelled(), "cancelled before desktop input");
    let mut enigo = Enigo::new(&Settings::default())
        .map_err(|e| anyhow::anyhow!("desktop input unavailable: {e}"))?;
    ensure!(!cancel.is_cancelled(), "cancelled before desktop input");
    *state = None;
    let lease = lease.as_mut().context("desktop lease unavailable")?;
    lease.advance()?;
    let result = (|| -> Result<()> {
        if let Some((x, y)) = points {
            move_pointer(&mut enigo, x, y)?;
        }
        ensure!(!cancel.is_cancelled(), "cancelled after pointer motion");
        match name {
            "desktop_move" => (),
            "desktop_click" => {
                for _ in 0..clicks {
                    ensure!(!cancel.is_cancelled(), "cancelled during click");
                    enigo.button(button, Direction::Click)?;
                }
            }
            "desktop_scroll" => enigo.scroll(amount as i32, axis)?,
            "desktop_type" => enigo.text(typed)?,
            "desktop_drag" => {
                enigo.button(Button::Left, Direction::Press)?;
                let (from_x, from_y) = points.unwrap();
                let (to_x, to_y) = end.unwrap();
                let moved = (|| -> Result<()> {
                    for step in 1..=16 {
                        ensure!(!cancel.is_cancelled(), "cancelled during drag");
                        let x =
                            i64::from(from_x) + (i64::from(to_x) - i64::from(from_x)) * step / 16;
                        let y =
                            i64::from(from_y) + (i64::from(to_y) - i64::from(from_y)) * step / 16;
                        move_pointer(&mut enigo, x as i32, y as i32)?;
                        std::thread::sleep(Duration::from_millis(6));
                    }
                    Ok(())
                })();
                let released = enigo.button(Button::Left, Direction::Release);
                moved?;
                released?;
            }
            "desktop_key" => {
                let mut held = Vec::new();
                let result = (|| -> Result<()> {
                    for modifier in &modifiers {
                        ensure!(!cancel.is_cancelled(), "cancelled during shortcut");
                        enigo.key(*modifier, Direction::Press)?;
                        held.push(*modifier);
                    }
                    ensure!(!cancel.is_cancelled(), "cancelled during shortcut");
                    enigo.key(pressed_key, Direction::Click)?;
                    Ok(())
                })();
                let mut release_ok = true;
                for modifier in held.into_iter().rev() {
                    release_ok &= enigo.key(modifier, Direction::Release).is_ok();
                }
                result?;
                ensure!(release_ok, "modifier release failed");
            }
            _ => unreachable!(),
        }
        Ok(())
    })();
    if result.is_err() {
        return Err(DesktopUncertain.into());
    }
    // Our own input advanced the shared generation; another agent's would not match.
    let remaining = observation.uses.saturating_sub(1);
    if remaining > 0 {
        *state = Some(Observation {
            uses: remaining,
            generation: lease.generation()?,
            ..observation
        });
    }
    Ok(input_result(remaining))
}
pub(crate) fn input_result(remaining: u8) -> Value {
    json!({"completed":true,"observationUsesLeft":remaining,"message":if remaining > 0 {
        format!("Input sent. The same observation serves {remaining} more input(s) only if the screen did not change; otherwise capture again.")
    } else { "Input sent. Capture a fresh screenshot before further input.".to_string() }})
}

fn check_platform() -> Result<()> {
    #[cfg(target_os = "linux")]
    ensure!(
        std::env::var_os("WAYLAND_DISPLAY").is_none()
            && std::env::var("XDG_SESSION_TYPE").ok().as_deref() != Some("wayland"),
        "Wayland desktop control is not available; XWayland cannot control the whole desktop"
    );
    Ok(())
}

#[cfg(windows)]
fn move_pointer(_: &mut Enigo, x: i32, y: i32) -> Result<()> {
    windows::move_pointer(x, y)
}
#[cfg(not(windows))]
fn move_pointer(enigo: &mut Enigo, x: i32, y: i32) -> Result<()> {
    enigo.move_mouse(x, y, Coordinate::Abs)?;
    Ok(())
}

#[cfg(any(windows, test))]
fn normalize_virtual_point(x: i32, y: i32, bounds: [i32; 4]) -> Result<(i32, i32)> {
    let [left, top, width, height] = bounds;
    let (x, y) = (
        i64::from(x) - i64::from(left),
        i64::from(y) - i64::from(top),
    );
    ensure!(
        width > 1
            && height > 1
            && x >= 0
            && x < i64::from(width)
            && y >= 0
            && y < i64::from(height),
        "point outside virtual desktop"
    );
    let normalize =
        |p: i64, size: i32| ((p * 65535 + i64::from(size - 1) / 2) / i64::from(size - 1)) as i32;
    Ok((normalize(x, width), normalize(y, height)))
}

/// No screenshot, input, credential store or private application state is read.
pub fn status() -> Result<Value> {
    #[cfg(target_os = "linux")]
    if wayland::active() {
        return Ok(wayland::diagnostic());
    }
    let backend = if cfg!(windows) {
        "windows"
    } else if cfg!(target_os = "linux") {
        "x11"
    } else {
        "unsupported"
    };
    match monitors() {
        Ok(value) => Ok(
            json!({"available":true,"backend":backend,"monitors":value["monitors"],"coordinateSpace":"physicalPixels","reason":null}),
        ),
        Err(_) => Ok(
            json!({"available":false,"backend":backend,"monitors":[],"coordinateSpace":"physicalPixels","reason":
            if cfg!(target_os = "linux") && (std::env::var_os("WAYLAND_DISPLAY").is_some() || std::env::var("XDG_SESSION_TYPE").ok().as_deref() == Some("wayland")) { "waylandUnsupported" }
            else if cfg!(windows) { "interactiveDesktopUnavailable" } else { "displayUnavailable" }}),
        ),
    }
}

#[cfg(windows)]
fn monitors() -> Result<Value> {
    let _dpi = windows::DpiScope::enter()?;
    windows::ensure_interactive()?;
    windows::bounds()?;
    let values: Vec<Value> = xcap::Monitor::all()?.into_iter().map(|monitor| -> Result<Value> {
        Ok(json!({"id":monitor.id()?,"name":monitor.name()?,"primary":monitor.is_primary()?,"x":monitor.x()?,"y":monitor.y()?,"width":monitor.width()?,"height":monitor.height()?,"scaleFactor":windows::scale_factor(monitor.id()?)?}))
    }).collect::<Result<_>>()?;
    ensure!(!values.is_empty(), "no monitors available");
    Ok(json!({"monitors":values}))
}

#[cfg(target_os = "linux")]
fn monitors() -> Result<Value> {
    use x11rb::connection::Connection;
    check_platform()?;
    let (connection, primary) = x11rb::connect(None).context("X11 display unavailable")?;
    let values: Vec<Value> = connection.setup().roots.iter().enumerate().map(|(id, screen)| json!({"id":id,"name":format!("X11 screen {id}"),"primary":id==primary,"x":0,"y":0,"width":screen.width_in_pixels,"height":screen.height_in_pixels,"scaleFactor":1})).collect();
    ensure!(!values.is_empty(), "no X11 screen available");
    Ok(json!({"monitors":values}))
}

#[cfg(not(any(windows, target_os = "linux")))]
fn monitors() -> Result<Value> {
    bail!("desktop control is not available on this platform")
}

#[cfg(target_os = "linux")]
fn capture(monitor: Option<u32>) -> Result<(image::DynamicImage, i32, i32, u32)> {
    use x11rb::{
        connection::Connection,
        protocol::xproto::{ConnectionExt, ImageFormat, ImageOrder},
    };
    check_platform()?;
    let (conn, screen_id) = x11rb::connect(None).context("X11 display unavailable")?;
    ensure!(
        monitor.is_none() || monitor == Some(screen_id as u32),
        "only the current X11 root screen supports input"
    );
    let setup = conn.setup();
    let screen = &setup.roots[screen_id];
    let (w, h) = (screen.width_in_pixels, screen.height_in_pixels);
    ensure!(
        w > 0 && h > 0 && u64::from(w) * u64::from(h) <= 16_000_000,
        "desktop dimensions unsupported"
    );
    let format = setup
        .pixmap_formats
        .iter()
        .find(|f| f.depth == screen.root_depth)
        .context("unsupported X11 pixel format")?;
    let bpp = usize::from(format.bits_per_pixel);
    ensure!([16, 24, 32].contains(&bpp), "unsupported X11 pixel depth");
    let visual = screen
        .allowed_depths
        .iter()
        .flat_map(|d| &d.visuals)
        .find(|v| v.visual_id == screen.root_visual)
        .context("X11 visual unavailable")?;
    let reply = conn
        .get_image(ImageFormat::Z_PIXMAP, screen.root, 0, 0, w, h, u32::MAX)?
        .reply()?;
    let stride = (usize::from(w) * bpp).div_ceil(usize::from(format.scanline_pad))
        * usize::from(format.scanline_pad)
        / 8;
    ensure!(
        reply.data.len() >= stride * usize::from(h),
        "short X11 image"
    );
    let channel = |value: u32, mask: u32| -> u8 {
        if mask == 0 {
            return 0;
        }
        let shift = mask.trailing_zeros();
        let max = mask >> shift;
        ((u64::from((value & mask) >> shift) * 255) / u64::from(max)) as u8
    };
    let mut image = image::RgbaImage::new(u32::from(w), u32::from(h));
    for y in 0..usize::from(h) {
        for x in 0..usize::from(w) {
            let start = y * stride + x * (bpp / 8);
            let pixel = &reply.data[start..start + bpp / 8];
            let mut value = 0u32;
            if setup.image_byte_order == ImageOrder::LSB_FIRST {
                for (i, b) in pixel.iter().enumerate() {
                    value |= u32::from(*b) << (8 * i);
                }
            } else {
                for b in pixel {
                    value = (value << 8) | u32::from(*b);
                }
            }
            image.put_pixel(
                x as u32,
                y as u32,
                image::Rgba([
                    channel(value, visual.red_mask),
                    channel(value, visual.green_mask),
                    channel(value, visual.blue_mask),
                    255,
                ]),
            );
        }
    }
    Ok((
        image::DynamicImage::ImageRgba8(image),
        0,
        0,
        screen_id as u32,
    ))
}
#[cfg(windows)]
fn capture(selected: Option<u32>) -> Result<(image::DynamicImage, i32, i32, u32)> {
    windows::ensure_interactive()?;
    let monitors = xcap::Monitor::all()?;
    let monitor = monitors
        .into_iter()
        .find(|m| {
            selected.map_or_else(
                || m.is_primary().unwrap_or(false),
                |id| m.id().ok() == Some(id),
            )
        })
        .context("selected monitor unavailable; use desktop_monitors")?;
    let x = monitor.x()?;
    let y = monitor.y()?;
    let image = monitor.capture_image()?;
    ensure!(
        u64::from(image.width()) * u64::from(image.height()) <= 16_000_000,
        "desktop dimensions unsupported"
    );
    Ok((image::DynamicImage::ImageRgba8(image), x, y, monitor.id()?))
}
#[cfg(not(any(target_os = "linux", windows)))]
fn capture(_: Option<u32>) -> Result<(image::DynamicImage, i32, i32, u32)> {
    bail!("desktop control is not available on this platform")
}

#[cfg(test)]
mod tests {
    use super::*;
    fn run(state: &Mutex<Option<Observation>>, name: &str, input: &Value) -> Result<Value> {
        super::run(state, name, input, &CancellationToken::new())
    }
    fn observation() -> Observation {
        Observation {
            token: "one".into(),
            width: 100,
            height: 100,
            region: [0, 0, 100, 100],
            screen: (100, 100),
            uses: OBSERVATION_USES,
            origin_x: 0,
            origin_y: 0,
            captured_at: Instant::now(),
            generation: 0,
            #[cfg(windows)]
            monitor: 0,
            #[cfg(windows)]
            focus: None,
        }
    }
    #[test]
    fn screenshots_are_downscaled_and_regions_map_back_to_screen_pixels() {
        let shot = image::DynamicImage::new_rgba8(1920, 1080);
        let framed = frame(shot.clone(), None, SCREENSHOT_EDGE).unwrap();
        assert_eq!((framed.width, framed.height), (1280, 720));
        assert_eq!(framed.to_screen(0, 0).unwrap(), (0, 0));
        assert_eq!(framed.to_screen(640, 360).unwrap(), (960, 540));
        assert_eq!(framed.to_screen(1279, 719).unwrap(), (1919, 1079));
        assert!(framed.to_screen(1280, 0).is_err());
        // Resolución completa: hasta lo que ve el modelo, para que las coordenadas sigan valiendo.
        let full = frame(shot.clone(), None, MODEL_EDGE).unwrap();
        assert_eq!((full.width, full.height), (1568, 882));
        assert_eq!(full.to_screen(1567, 881).unwrap(), (1919, 1079));
        let cheap = frame(shot.clone(), None, 768).unwrap();
        assert_eq!((cheap.width, cheap.height), (768, 432));
        // A small region is sent at native size and offset by its origin.
        let zoom = frame(shot.clone(), Some([1500, 40, 300, 200]), SCREENSHOT_EDGE).unwrap();
        assert_eq!((zoom.width, zoom.height), (300, 200));
        assert_eq!(zoom.to_screen(10, 20).unwrap(), (1510, 60));
        assert!(frame(shot, Some([1800, 0, 300, 200]), SCREENSHOT_EDGE).is_err());
        assert_eq!(screenshot_options(&json!({"region":{"x":1,"y":2,"width":16,"height":16}})).unwrap(), (Some([1, 2, 16, 16]), SCREENSHOT_EDGE));
        assert_eq!(screenshot_options(&json!({"fullResolution":true})).unwrap(), (None, MODEL_EDGE));
        assert_eq!(screenshot_options(&json!({"maxEdge":768})).unwrap(), (None, 768));
        assert!(screenshot_options(&json!({"maxEdge":100})).is_err());
        assert!(screenshot_options(&json!({"maxEdge":768,"fullResolution":true})).is_err());
        let summary = framed.summary("o7", 0, 1);
        assert!(summary.starts_with("Screenshot 1280x720 of screen 1920x1080, scale 0.667, observation o7.") && summary.len() < 170, "{summary}");
        assert!(framed.summary("o8", 1, 2).contains(", monitor 1 of 2,"));
        assert!(screenshot_options(&json!({"region":{"x":1,"y":2,"width":8,"height":16}})).is_err());
        assert!(screenshot_options(&json!({"scale":2})).is_err());
        let mut o = observation();
        o.width = 1280;
        o.height = 720;
        o.region = [0, 0, 1920, 1080];
        o.origin_x = 1920;
        assert_eq!(point(&json!({"x":640,"y":360}), "x", "y", &o).unwrap(), (2880, 540));
    }
    #[test]
    fn definitions_obey_read_only_and_validation_is_strict() {
        let provider = DesktopProvider::default();
        assert_eq!(provider.definitions("plan").len(), 4);
        assert_eq!(
            provider.definitions("plan")[0]["function"]["name"],
            "desktop_status"
        );
        assert!(!provider.is_mutating("desktop_screenshot", &json!({})));
        assert!(provider.is_mutating("desktop_click", &json!({})));
        let state = Mutex::new(Some(observation()));
        assert!(run(
            &state,
            "desktop_click",
            &json!({"observation":"stale","x":1,"y":2})
        )
        .is_err());
        assert!(run(
            &state,
            "desktop_click",
            &json!({"observation":"one","x":100,"y":2})
        )
        .is_err());
        assert!(run(
            &state,
            "desktop_type",
            &json!({"observation":"one","text":"x","extra":true})
        )
        .is_err());
        assert!(state.lock().unwrap().is_some());
    }
    #[test]
    fn physical_virtual_coordinates_cover_negative_and_scaled_monitors() {
        let bounds = [-1920, -200, 4480, 1640];
        assert_eq!(
            normalize_virtual_point(-1920, -200, bounds).unwrap(),
            (0, 0)
        );
        assert_eq!(
            normalize_virtual_point(2559, 1439, bounds).unwrap(),
            (65535, 65535)
        );
        let (x, y) = normalize_virtual_point(0, 0, bounds).unwrap();
        assert!(x > 28000 && x < 29000 && y > 7900 && y < 8100);
        assert!(normalize_virtual_point(-1921, 0, bounds).is_err());
        assert!(normalize_virtual_point(2560, 0, bounds).is_err());
        assert!(normalize_virtual_point(0, 0, [0, 0, 1, 1080]).is_err());
        // Screenshot coordinates remain physical pixels at 125%, 150% or 200%.
        let mut o = observation();
        o.origin_x = -1920;
        o.origin_y = -200;
        o.width = 1920;
        o.height = 1080;
        o.region = [0, 0, 1920, 1080];
        assert_eq!(
            point(&json!({"x":1919,"y":1079}), "x", "y", &o).unwrap(),
            (-1, 879)
        );
    }
    #[test]
    fn expired_or_invalid_input_never_connects_to_the_desktop() {
        let mut old = observation();
        old.captured_at = Instant::now() - Duration::from_secs(31);
        let state = Mutex::new(Some(old));
        assert!(run(
            &state,
            "desktop_click",
            &json!({"observation":"one","x":1,"y":2})
        )
        .unwrap_err()
        .to_string()
        .contains("expired"));
        assert!(state.lock().unwrap().is_none());
        for (name, input) in [
            (
                "desktop_click",
                json!({"observation":"one","x":1,"y":2,"clicks":3}),
            ),
            (
                "desktop_scroll",
                json!({"observation":"one","x":1,"y":2,"amount":1,"axis":null}),
            ),
            ("desktop_move", json!({"observation":"one","x":1,"y":100})),
        ] {
            let state = Mutex::new(Some(observation()));
            assert!(run(&state, name, &input).is_err());
            assert!(state.lock().unwrap().is_some());
        }
    }
    #[test]
    fn cancellation_is_rechecked_after_waiting_for_other_sessions() {
        let held = DESKTOP_ACCESS.lock().unwrap();
        let cancel = CancellationToken::new();
        let token = cancel.clone();
        let (send, receive) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            send.send(()).unwrap();
            super::run(&Mutex::new(None), "invalid-tool", &json!({}), &token)
        });
        receive.recv().unwrap();
        cancel.cancel();
        drop(held);
        assert!(worker
            .join()
            .unwrap()
            .unwrap_err()
            .to_string()
            .starts_with("cancelled"));
    }
    #[cfg(target_os = "linux")]
    #[test]
    #[ignore = "requires a dedicated virtual X11 display"]
    fn isolated_x11_capture_and_input() {
        assert_eq!(
            std::env::var("TREX_DESKTOP_TEST").ok().as_deref(),
            Some("isolated-xvfb")
        );
        let state = Mutex::new(None);
        let screenshot = run(&state, "desktop_screenshot", &json!({})).unwrap();
        assert_eq!(screenshot["structuredContent"]["width"], 640);
        assert_eq!(screenshot["structuredContent"]["height"], 480);
        let token = screenshot["structuredContent"]["observation"]
            .as_str()
            .unwrap();
        let bytes = STANDARD
            .decode(screenshot["content"][1]["data"].as_str().unwrap())
            .unwrap();
        assert_eq!(
            image::load_from_memory(&bytes).unwrap().dimensions(),
            (640, 480)
        );
        run(
            &state,
            "desktop_click",
            &json!({"observation":token,"x":15,"y":25}),
        )
        .unwrap();
        assert!(run(
            &state,
            "desktop_click",
            &json!({"observation":token,"x":15,"y":25})
        )
        .is_err());
        use x11rb::{connection::Connection, protocol::xproto::ConnectionExt};
        let (conn, screen) = x11rb::connect(None).unwrap();
        let pointer = conn
            .query_pointer(conn.setup().roots[screen].root)
            .unwrap()
            .reply()
            .unwrap();
        assert_eq!((pointer.root_x, pointer.root_y), (15, 25));
    }
}
