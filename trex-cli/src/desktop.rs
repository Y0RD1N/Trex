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
    /// Lo que el modelo ha visto de esta zona (la última imagen entregada, con los
    /// recortes ya aplicados): con qué se compara la pantalla tras una entrada.
    frame: Option<Arc<image::RgbaImage>>,
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
    format!("Trex desktop controls the real computer with screenshots and real mouse and keyboard input; it is separate from the trex_browser project browser and from accessibility control. Start with desktop_screenshot (primary screen unless monitor is given; it says how many screens there are, desktop_monitors lists them) and check the screen and focus before input. Input coordinates are pixels of the latest screenshot image. For cheaper captures use region (screen pixels) or maxEdge. After each input the result shows what changed (a crop of the changed area, the whole screenshot when much changed, or \"No visible change\") with a fresh observation, so another desktop_screenshot is rarely needed; capture:\"none\" skips it. desktop_actions sends several inputs in one call (click a field, type, press enter) and captures once at the end; it stops before typing if the foreground window changed. An observation serves up to 3 inputs within 30 seconds while the screen is unchanged. {permissions} Never claim an unadvertised capability; if unavailable, explain the diagnostic rather than silently switching control systems. Never automatically replay uncertain input. A desktop-control failure says nothing about Trex Browser, whose websites go through browser_navigate.")
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
            ("desktop_actions", "Send up to 10 inputs in order in one call, with one capture of what changed at the end. Each action is {type: click|move|scroll|drag|type|key, ...the fields of that tool, without observation}, e.g. [{\"type\":\"click\",\"x\":40,\"y\":80},{\"type\":\"type\",\"text\":\"Ana\"},{\"type\":\"key\",\"key\":\"enter\"}]. Coordinates are pixels of the observation. Stops before typing if the foreground window changed.", with_after(json!({"observation":{"type":"string"},"actions":{"type":"array","minItems":1,"maxItems":10,"items":{"type":"object","properties":{"type":{"type":"string","enum":["click","move","scroll","drag","type","key"]}},"required":["type"]}}})), vec!["observation","actions"]),
            ("desktop_move", "Move the pointer to a point in the latest screenshot without clicking. Coordinates are screenshot pixels.", with_after(json!({"observation":{"type":"string"},"x":{"type":"integer","minimum":0},"y":{"type":"integer","minimum":0}})), vec!["observation","x","y"]),
            ("desktop_click", "Click a point in the latest desktop screenshot. Coordinates are screenshot pixels. Use clicks:2 for a double click.", with_after(json!({"observation":{"type":"string"},"x":{"type":"integer","minimum":0},"y":{"type":"integer","minimum":0},"button":{"type":"string","enum":["left","right","middle"]},"clicks":{"type":"integer","minimum":1,"maximum":2}})), vec!["observation","x","y"]),
            ("desktop_scroll", "Scroll at a point in the latest screenshot. Positive amount scrolls down (vertical) or right (horizontal).", with_after(json!({"observation":{"type":"string"},"x":{"type":"integer","minimum":0},"y":{"type":"integer","minimum":0},"amount":{"type":"integer","minimum":-20,"maximum":20},"axis":{"type":"string","enum":["vertical","horizontal"]}})), vec!["observation","x","y","amount"]),
            ("desktop_type", "Type text into the currently focused control. Verify focus from the latest screenshot (a click just made on the field counts).", with_after(json!({"observation":{"type":"string"},"text":{"type":"string","maxLength":4000}})), vec!["observation","text"]),
            ("desktop_key", "Press a key or keyboard shortcut in the focused control. Keys: enter, tab, escape, backspace, delete, arrows, home, end, pageup, pagedown, space, or one character. Modifiers: ctrl, alt, shift, meta.", with_after(json!({"observation":{"type":"string"},"key":{"type":"string"},"modifiers":{"type":"array","maxItems":4,"items":{"type":"string","enum":["ctrl","alt","shift","meta"]}}})), vec!["observation","key"]),
            ("desktop_drag", "Drag between points in the latest desktop screenshot using the left button.", with_after(json!({"observation":{"type":"string"},"x":{"type":"integer","minimum":0},"y":{"type":"integer","minimum":0},"toX":{"type":"integer","minimum":0},"toY":{"type":"integer","minimum":0}})), vec!["observation","x","y","toX","toY"]),
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

/// Opciones comunes de las entradas: qué capturar después y cuánto esperar antes.
fn with_after(mut properties: Value) -> Value {
    properties["capture"] = json!({"type":"string","enum":["changed","full","none"]});
    properties["settleMs"] = json!({"type":"integer","minimum":0,"maximum":3000});
    properties
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
    pub pixels: image::RgbaImage,
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
/// Una imagen en PNG.
fn png(pixels: &image::RgbaImage) -> Result<Vec<u8>> {
    let mut bytes = Cursor::new(Vec::new());
    pixels.write_to(&mut bytes, image::ImageFormat::Png)?;
    Ok(bytes.into_inner())
}

/// Qué capturar después de una entrada.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum AfterCapture {
    None,
    Changed,
    Full,
}
/// Espera por defecto para que la pantalla se asiente antes de capturar.
const SETTLE_MS: u64 = 350;
/// Por encima de este porcentaje de la imagen, se entrega la captura entera.
const LARGE_CHANGE_PERCENT: u64 = 35;
/// Entradas de una sola llamada a desktop_actions.
const MAX_ACTIONS: usize = 10;
const INPUT_TOOLS: [&str; 6] = ["desktop_click", "desktop_move", "desktop_scroll", "desktop_drag", "desktop_type", "desktop_key"];

pub(crate) fn after_options(input: &Value) -> Result<(AfterCapture, u64)> {
    let capture = match input.get("capture").map(Value::as_str) {
        None | Some(Some("changed")) => AfterCapture::Changed,
        Some(Some("full")) => AfterCapture::Full,
        Some(Some("none")) => AfterCapture::None,
        _ => bail!("capture must be changed, full or none"),
    };
    let settle = match input.get("settleMs") {
        None => SETTLE_MS,
        Some(value) => value.as_u64().filter(|ms| *ms <= 3000).context("settleMs must be 0..3000")?,
    };
    Ok((capture, settle))
}

/// Recuadro (x, y, ancho, alto en píxeles de la imagen) de lo que cambió entre
/// dos fotogramas de la misma zona; None si nada cambió de forma visible.
pub(crate) fn changed_box(before: &image::RgbaImage, after: &image::RgbaImage) -> Option<[u32; 4]> {
    if before.dimensions() != after.dimensions() {
        return Some([0, 0, after.width(), after.height()]);
    }
    let (mut left, mut top, mut right, mut bottom, mut count) = (u32::MAX, u32::MAX, 0, 0, 0u32);
    for (x, y, pixel) in after.enumerate_pixels() {
        let old = before.get_pixel(x, y);
        if pixel.0.iter().zip(old.0.iter()).take(3).any(|(a, b)| a.abs_diff(*b) > 32) {
            (left, top, right, bottom) = (left.min(x), top.min(y), right.max(x), bottom.max(y));
            count += 1;
        }
    }
    (count >= 3).then(|| [left, top, right - left + 1, bottom - top + 1])
}

/// Un recuadro con margen, al menos de 32×32 y dentro de la imagen.
pub(crate) fn padded(area: [u32; 4], width: u32, height: u32) -> [u32; 4] {
    const PAD: u32 = 12;
    let grow = |start: u32, size: u32, limit: u32| {
        let wanted = (size + 2 * PAD).max(32).min(limit);
        let start = start.saturating_sub(PAD + (wanted.saturating_sub(size + 2 * PAD)) / 2);
        let start = start.min(limit - wanted);
        (start, wanted)
    };
    let (x, w) = grow(area[0], area[2], width);
    let (y, h) = grow(area[1], area[3], height);
    [x, y, w, h]
}

/// La misma zona y escala que una observación, capturada de nuevo.
fn reframe(image: image::DynamicImage, region: [u32; 4], width: u32, height: u32) -> Result<image::RgbaImage> {
    let (screen_width, screen_height) = image.dimensions();
    ensure!(
        region[0] + region[2] <= screen_width && region[1] + region[3] <= screen_height,
        "the screen changed size"
    );
    let image = if region == [0, 0, screen_width, screen_height] { image } else { image.crop_imm(region[0], region[1], region[2], region[3]) };
    let image = if image.dimensions() == (width, height) { image } else { image.resize_exact(width, height, image::imageops::FilterType::CatmullRom) };
    Ok(image.to_rgba8())
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
    let pixels = image.to_rgba8();
    Ok(Framed {
        png: png(&pixels)?,
        pixels,
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
            frame: Some(Arc::new(framed.pixels.clone())),
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
            json!({"content":[{"type":"text","text":format!("{}{}", framed.summary(&token, monitor, screens), foreground_note())},{"type":"image","mimeType":"image/png","data":STANDARD.encode(&framed.png)}],"structuredContent":structured}),
        );
    }
    // Una entrada suelta o varias (desktop_actions): todas se validan antes de enviar nada.
    let common = ["observation", "capture", "settleMs"];
    let steps: Vec<(&str, Value)> = if name == "desktop_actions" {
        validate_fields(input, &["observation", "actions", "capture", "settleMs"], &["observation", "actions"])?;
        let list = input["actions"]
            .as_array()
            .filter(|list| (1..=MAX_ACTIONS).contains(&list.len()))
            .with_context(|| format!("actions must list 1 to {MAX_ACTIONS} inputs"))?;
        list.iter()
            .map(|action| {
                let kind = action["type"].as_str().context("each action needs a type")?;
                let tool = INPUT_TOOLS
                    .iter()
                    .copied()
                    .find(|tool| tool.strip_prefix("desktop_") == Some(kind))
                    .with_context(|| format!("unknown action type {kind}"))?;
                let mut fields = action.clone();
                fields.as_object_mut().context("each action must be an object")?.remove("type");
                Ok((tool, fields))
            })
            .collect::<Result<_>>()?
    } else {
        let tool = INPUT_TOOLS.iter().copied().find(|tool| *tool == name).context("unknown desktop tool")?;
        let mut fields = input.clone();
        let object = fields.as_object_mut().context("expected an object")?;
        ensure!(object.contains_key("observation"), "missing desktop argument");
        for key in common {
            object.remove(key);
        }
        vec![(tool, fields)]
    };
    for (tool, fields) in &steps {
        let (allowed, required) = input_fields(tool);
        validate_fields(fields, allowed, required)?;
    }
    let (after, settle) = after_options(input)?;
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
    let acts = steps
        .iter()
        .map(|(tool, fields)| parse_act(tool, fields, &observation))
        .collect::<Result<Vec<_>>>()?;
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
        if acts[0].keyboard() {
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
    let mut stopped = None;
    for (index, act) in acts.iter().enumerate() {
        // Nunca se escribe en otra ventana que la de la observación (un diálogo
        // que se abrió por el clic anterior, por ejemplo).
        #[cfg(windows)]
        if index > 0 && act.keyboard() && windows::focus() != observation.focus {
            stopped = Some(index);
            break;
        }
        if perform(&mut enigo, act, cancel).is_err() {
            return Err(DesktopUncertain.into());
        }
        if index + 1 < acts.len() {
            std::thread::sleep(Duration::from_millis(80));
        }
    }
    let sent = stopped.unwrap_or(acts.len());
    let head = match stopped {
        Some(index) => format!(
            "Stopped before input {} ({}): the foreground window changed. Inputs 1-{index} were sent; do not repeat them.",
            index + 1,
            steps[index].0.trim_start_matches("desktop_")
        ),
        None if acts.len() > 1 => format!("{sent} inputs sent."),
        None => "Input sent.".to_owned(),
    };
    if after == AfterCapture::None {
        // Our own input advanced the shared generation; another agent's would not match.
        let remaining = if acts.len() > 1 || stopped.is_some() { 0 } else { observation.uses.saturating_sub(1) };
        if remaining > 0 {
            *state = Some(Observation {
                uses: remaining,
                generation: lease.generation()?,
                ..observation
            });
        }
        let mut result = input_result(remaining);
        if acts.len() > 1 {
            result["message"] = json!(format!("{head} {}", result["message"].as_str().unwrap_or("")));
        }
        return Ok(result);
    }
    let (text, image, mut structured) = after_capture(&observation, after, settle, lease, cancel, &mut state)?;
    structured["sent"] = json!(sent);
    let mut content = vec![json!({"type":"text","text":format!("{head} {text}")})];
    if let Some(bytes) = image {
        content.push(json!({"type":"image","mimeType":"image/png","data":STANDARD.encode(bytes)}));
    }
    Ok(json!({"content":content,"structuredContent":structured,"isError":stopped.is_some()}))
}

/// Campos de cada entrada (sin la observación ni las opciones de captura).
fn input_fields(tool: &str) -> (&'static [&'static str], &'static [&'static str]) {
    match tool {
        "desktop_click" => (&["x", "y", "button", "clicks"], &["x", "y"]),
        "desktop_scroll" => (&["x", "y", "amount", "axis"], &["x", "y", "amount"]),
        "desktop_move" => (&["x", "y"], &["x", "y"]),
        "desktop_drag" => (&["x", "y", "toX", "toY"], &["x", "y", "toX", "toY"]),
        "desktop_type" => (&["text"], &["text"]),
        _ => (&["key", "modifiers"], &["key"]),
    }
}

/// Una entrada ya validada, en píxeles de pantalla.
enum Act {
    Move((i32, i32)),
    Click((i32, i32), Button, u64),
    Scroll((i32, i32), i32, Axis),
    Drag((i32, i32), (i32, i32)),
    Type(String),
    Key(Key, Vec<Key>),
}
impl Act {
    #[cfg_attr(not(windows), allow(dead_code))]
    fn keyboard(&self) -> bool {
        matches!(self, Act::Type(_) | Act::Key(..))
    }
}

fn parse_act(tool: &str, input: &Value, observation: &Observation) -> Result<Act> {
    Ok(match tool {
        "desktop_move" => Act::Move(point(input, "x", "y", observation)?),
        "desktop_click" => {
            let button = match input.get("button").map(|v| v.as_str()) {
                None | Some(Some("left")) => Button::Left,
                Some(Some("right")) => Button::Right,
                Some(Some("middle")) => Button::Middle,
                _ => bail!("invalid button"),
            };
            let clicks = match input.get("clicks") {
                None => 1,
                Some(value) => value.as_u64().filter(|n| (1..=2).contains(n)).context("clicks must be 1 or 2")?,
            };
            Act::Click(point(input, "x", "y", observation)?, button, clicks)
        }
        "desktop_scroll" => {
            let amount = input["amount"].as_i64().context("invalid amount")?;
            ensure!((-20..=20).contains(&amount) && amount != 0, "invalid scroll amount");
            let axis = match input.get("axis").map(|v| v.as_str()) {
                None | Some(Some("vertical")) => Axis::Vertical,
                Some(Some("horizontal")) => Axis::Horizontal,
                _ => bail!("invalid scroll axis"),
            };
            Act::Scroll(point(input, "x", "y", observation)?, amount as i32, axis)
        }
        "desktop_drag" => Act::Drag(point(input, "x", "y", observation)?, point(input, "toX", "toY", observation)?),
        "desktop_type" => {
            let typed = input["text"].as_str().context("invalid text")?;
            ensure!(!typed.is_empty() && typed.len() <= 4000 && !typed.contains('\0'), "invalid text");
            Act::Type(typed.to_owned())
        }
        _ => {
            let pressed = key(input["key"].as_str().context("invalid key")?)?;
            let mut modifiers = Vec::new();
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
            Act::Key(pressed, modifiers)
        }
    })
}

fn perform(enigo: &mut Enigo, act: &Act, cancel: &CancellationToken) -> Result<()> {
    match act {
        Act::Move((x, y)) => move_pointer(enigo, *x, *y)?,
        Act::Click((x, y), button, clicks) => {
            move_pointer(enigo, *x, *y)?;
            ensure!(!cancel.is_cancelled(), "cancelled after pointer motion");
            for _ in 0..*clicks {
                ensure!(!cancel.is_cancelled(), "cancelled during click");
                enigo.button(*button, Direction::Click)?;
            }
        }
        Act::Scroll((x, y), amount, axis) => {
            move_pointer(enigo, *x, *y)?;
            ensure!(!cancel.is_cancelled(), "cancelled after pointer motion");
            enigo.scroll(*amount, *axis)?;
        }
        Act::Type(text) => enigo.text(text)?,
        Act::Drag((from_x, from_y), (to_x, to_y)) => {
            move_pointer(enigo, *from_x, *from_y)?;
            ensure!(!cancel.is_cancelled(), "cancelled after pointer motion");
            enigo.button(Button::Left, Direction::Press)?;
            let moved = (|| -> Result<()> {
                for step in 1..=16 {
                    ensure!(!cancel.is_cancelled(), "cancelled during drag");
                    let x = i64::from(*from_x) + (i64::from(*to_x) - i64::from(*from_x)) * step / 16;
                    let y = i64::from(*from_y) + (i64::from(*to_y) - i64::from(*from_y)) * step / 16;
                    move_pointer(enigo, x as i32, y as i32)?;
                    std::thread::sleep(Duration::from_millis(6));
                }
                Ok(())
            })();
            let released = enigo.button(Button::Left, Direction::Release);
            moved?;
            released?;
        }
        Act::Key(pressed, modifiers) => {
            let mut held = Vec::new();
            let result = (|| -> Result<()> {
                for modifier in modifiers {
                    ensure!(!cancel.is_cancelled(), "cancelled during shortcut");
                    enigo.key(*modifier, Direction::Press)?;
                    held.push(*modifier);
                }
                ensure!(!cancel.is_cancelled(), "cancelled during shortcut");
                enigo.key(*pressed, Direction::Click)?;
                Ok(())
            })();
            let mut release_ok = true;
            for modifier in held.into_iter().rev() {
                release_ok &= enigo.key(modifier, Direction::Release).is_ok();
            }
            result?;
            ensure!(release_ok, "modifier release failed");
        }
    }
    Ok(())
}

/// Tras una entrada: espera a que la pantalla se asiente, la captura otra vez con
/// la misma zona y escala que la observación, y entrega solo lo que cambió (o la
/// imagen entera si cambió mucho). Deja una observación nueva, con las mismas
/// coordenadas, para seguir sin pedir otra captura.
fn after_capture(
    observation: &Observation,
    mode: AfterCapture,
    settle: u64,
    lease: &mut DesktopLease,
    cancel: &CancellationToken,
    state: &mut Option<Observation>,
) -> Result<(String, Option<Vec<u8>>, Value)> {
    let deadline = Instant::now() + Duration::from_millis(settle);
    while Instant::now() < deadline {
        ensure!(!cancel.is_cancelled(), "cancelled before the after-input capture");
        std::thread::sleep(Duration::from_millis(50).min(deadline.saturating_duration_since(Instant::now())));
    }
    #[cfg(windows)]
    let (image, x, y, _) = capture(Some(observation.monitor))?;
    #[cfg(not(windows))]
    let (image, x, y, _) = capture(None)?;
    if (x, y) != (observation.origin_x, observation.origin_y) || image.dimensions() != observation.screen {
        return Ok(("The screen layout changed; take a new screenshot.".to_owned(), None, json!({"changed":null})));
    }
    let (width, height) = (observation.width, observation.height);
    let pixels = reframe(image, observation.region, width, height)?;
    let change = match (mode, observation.frame.as_deref()) {
        (AfterCapture::Full, _) | (_, None) => Some([0, 0, width, height]),
        (_, Some(previous)) => changed_box(previous, &pixels),
    };
    let large = |area: [u32; 4]| u64::from(area[2]) * u64::from(area[3]) * 100 > u64::from(width) * u64::from(height) * LARGE_CHANGE_PERCENT;
    let (text, image, area) = match change {
        None => ("No visible change.".to_owned(), None, None),
        Some(area) if mode == AfterCapture::Full || large(area) => {
            (format!("Screenshot {width}x{height} of the same area after the input."), Some(png(&pixels)?), Some([0, 0, width, height]))
        }
        Some(area) => {
            let crop = padded(area, width, height);
            let part = image::imageops::crop_imm(&pixels, crop[0], crop[1], crop[2], crop[3]).to_image();
            (
                format!("Changed area x={} y={} {}x{} of the {width}x{height} screenshot (image below, same scale).", crop[0], crop[1], crop[2], crop[3]),
                Some(png(&part)?),
                Some(crop),
            )
        }
    };
    let token = format!("o{}", NEXT_OBSERVATION.fetch_add(1, std::sync::atomic::Ordering::Relaxed));
    *state = Some(Observation {
        token: token.clone(),
        uses: OBSERVATION_USES,
        captured_at: Instant::now(),
        generation: lease.generation()?,
        #[cfg(windows)]
        focus: windows::focus(),
        frame: Some(Arc::new(pixels)),
        ..observation.clone()
    });
    let text = format!("{text}{} Observation {token}: coordinates stay pixels of the {width}x{height} screenshot.", foreground_note());
    let changed = area.map(|area| json!({"x":area[0],"y":area[1],"width":area[2],"height":area[3]}));
    Ok((text, image, json!({"observation":token,"changed":changed,"width":width,"height":height,"uses":OBSERVATION_USES,"expiresInMs":30000})))
}

/// La ventana en primer plano, para no tener que deducirla de la imagen.
fn foreground_note() -> String {
    #[cfg(windows)]
    if let Some(title) = windows::foreground_title().filter(|title| !title.trim().is_empty()) {
        let title: String = title.trim().chars().take(80).collect();
        return format!(" Foreground: \"{title}\".");
    }
    String::new()
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
            frame: None,
        }
    }
    #[test]
    fn after_an_input_only_what_changed_is_sent() {
        let base = image::RgbaImage::from_pixel(200, 100, image::Rgba([20, 20, 20, 255]));
        assert_eq!(changed_box(&base, &base), None, "nothing moved");
        let mut caret = base.clone();
        caret.put_pixel(50, 50, image::Rgba([255, 255, 255, 255]));
        assert_eq!(changed_box(&base, &caret), None, "a couple of pixels is noise");
        let mut typed = base.clone();
        for x in 30..60 {
            for y in 40..48 {
                typed.put_pixel(x, y, image::Rgba([230, 230, 230, 255]));
            }
        }
        assert_eq!(changed_box(&base, &typed), Some([30, 40, 30, 8]));
        // El recorte lleva margen, al menos 32×32 y no sale de la imagen.
        assert_eq!(padded([30, 40, 30, 8], 200, 100), [18, 28, 54, 32]);
        assert_eq!(padded([0, 0, 5, 5], 200, 100), [0, 0, 32, 32]);
        assert_eq!(padded([195, 95, 5, 5], 200, 100), [168, 68, 32, 32]);
        assert_eq!(after_options(&json!({})).unwrap(), (AfterCapture::Changed, SETTLE_MS));
        assert_eq!(after_options(&json!({"capture":"none","settleMs":0})).unwrap(), (AfterCapture::None, 0));
        assert_eq!(after_options(&json!({"capture":"full"})).unwrap().0, AfterCapture::Full);
        assert!(after_options(&json!({"capture":"some"})).is_err());
        assert!(after_options(&json!({"settleMs":5000})).is_err());
    }
    #[test]
    fn several_inputs_are_validated_before_any_is_sent() {
        let state = Mutex::new(Some(observation()));
        let bad = |actions: Value| run(&state, "desktop_actions", &json!({"observation":"one","actions":actions})).is_err();
        assert!(bad(json!([])), "at least one action");
        assert!(bad(json!([{"type":"click","x":1,"y":2},{"type":"fly"}])), "unknown action");
        assert!(bad(json!([{"type":"click","x":1,"y":2},{"type":"type","text":"x","extra":1}])), "unknown field");
        assert!(bad(json!([{"type":"click","x":1,"y":2},{"type":"click","x":500,"y":2}])), "a point outside the screenshot");
        assert!(bad(json!((0..11).map(|_| json!({"type":"move","x":1,"y":1})).collect::<Vec<_>>())), "at most 10");
        assert!(run(&state, "desktop_actions", &json!({"observation":"one","actions":[{"type":"move","x":1,"y":1}],"capture":"maybe"})).is_err());
        assert!(state.lock().unwrap().is_some(), "nothing was sent, the observation stays");
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
        let full = provider.definitions("full");
        assert_eq!(full.len(), 11);
        assert!(full.iter().any(|tool| tool["function"]["name"] == "desktop_actions"));
        assert!(full.iter().filter(|tool| tool["function"]["name"] != "desktop_actions" && !read_only(tool["function"]["name"].as_str().unwrap()))
            .all(|tool| tool["function"]["parameters"]["properties"]["capture"].is_object()), "every input can capture what changed");
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
