//! Explicitly enabled desktop access. Screenshots and input share a one-use observation token.
use crate::tools::{ToolFuture, ToolProvider};
use anyhow::{bail, ensure, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use enigo::{Axis, Button, Coordinate, Direction, Enigo, Key, Keyboard, Mouse, Settings};
use image::GenericImageView;
use serde_json::{json, Value};
use std::{
    io::Cursor,
    path::Path,
    sync::{Arc, Mutex},
};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

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
    origin_x: i32,
    origin_y: i32,
}
#[derive(Default)]
pub struct DesktopProvider {
    observation: Arc<Mutex<Option<Observation>>>,
}

impl ToolProvider for DesktopProvider {
    fn invalidate_observation(&self) {
        if let Ok(mut state) = self.observation.lock() {
            *state = None;
        }
    }
    fn definitions(&self, mode: &str) -> Vec<Value> {
        let specs = [
            ("desktop_screenshot", "Capture the desktop. The returned one-use observation token is required for the next input. Screens and focus can change independently; inspect before acting.", json!({}), vec![]),
            ("desktop_click", "Click a point in the latest desktop screenshot. Coordinates are screenshot pixels.", json!({"observation":{"type":"string"},"x":{"type":"integer","minimum":0},"y":{"type":"integer","minimum":0},"button":{"type":"string","enum":["left","right","middle"]}}), vec!["observation","x","y"]),
            ("desktop_scroll", "Scroll at a point in the latest desktop screenshot; positive amount scrolls down.", json!({"observation":{"type":"string"},"x":{"type":"integer","minimum":0},"y":{"type":"integer","minimum":0},"amount":{"type":"integer","minimum":-20,"maximum":20}}), vec!["observation","x","y","amount"]),
            ("desktop_type", "Type text into the currently focused control. Verify focus from a fresh screenshot first.", json!({"observation":{"type":"string"},"text":{"type":"string","maxLength":4000}}), vec!["observation","text"]),
            ("desktop_key", "Press a key or keyboard shortcut in the focused control. Keys: enter, tab, escape, backspace, delete, arrows, home, end, pageup, pagedown, space, or one character. Modifiers: ctrl, alt, shift, meta.", json!({"observation":{"type":"string"},"key":{"type":"string"},"modifiers":{"type":"array","maxItems":4,"items":{"type":"string","enum":["ctrl","alt","shift","meta"]}}}), vec!["observation","key"]),
            ("desktop_drag", "Drag between points in the latest desktop screenshot using the left button.", json!({"observation":{"type":"string"},"x":{"type":"integer","minimum":0},"y":{"type":"integer","minimum":0},"toX":{"type":"integer","minimum":0},"toY":{"type":"integer","minimum":0}}), vec!["observation","x","y","toX","toY"]),
        ];
        specs.into_iter().filter(|(name,_,_,_)| mode != "plan" || *name == "desktop_screenshot").map(|(name,description,properties,required)| json!({"type":"function","function":{"name":name,"description":description,"parameters":{"type":"object","properties":properties,"required":required,"additionalProperties":false}}})).collect()
    }
    fn is_mutating(&self, name: &str, _: &Value) -> bool {
        name != "desktop_screenshot"
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
            ensure!(
                mode != "plan" || name == "desktop_screenshot",
                "plan mode forbids desktop input"
            );
            let input = input.clone();
            let name = name.to_string();
            let state = self.observation.clone();
            tokio::task::spawn_blocking(move || run(&state, &name, &input))
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
    ensure!(
        x < o.width as u64 && y < o.height as u64,
        "point outside screenshot"
    );
    Ok((
        o.origin_x.checked_add(x as i32).context("invalid x")?,
        o.origin_y.checked_add(y as i32).context("invalid y")?,
    ))
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
fn run(state: &Mutex<Option<Observation>>, name: &str, input: &Value) -> Result<Value> {
    let mut state = state
        .lock()
        .map_err(|_| anyhow::anyhow!("desktop session unavailable"))?;
    if name == "desktop_screenshot" {
        validate_fields(input, &[], &[])?;
        *state = None;
        let (image, x, y) = capture()?;
        let (width, height) = image.dimensions();
        let mut bytes = Cursor::new(Vec::new());
        image.write_to(&mut bytes, image::ImageFormat::Png)?;
        let bytes = bytes.into_inner();
        ensure!(
            bytes.len() <= 4 * 1024 * 1024,
            "screenshot exceeds artifact size limit"
        );
        let token = Uuid::new_v4().to_string();
        *state = Some(Observation {
            token: token.clone(),
            width,
            height,
            origin_x: x,
            origin_y: y,
        });
        return Ok(
            json!({"content":[{"type":"text","text":format!("Screenshot {width}x{height}; observation {token}. Input consumes this observation; capture again before the next input.")},{"type":"image","mimeType":"image/png","data":STANDARD.encode(bytes)}],"structuredContent":{"observation":token,"width":width,"height":height}}),
        );
    }
    let (allowed, required): (&[&str], &[&str]) = match name {
        "desktop_click" => (
            &["observation", "x", "y", "button"],
            &["observation", "x", "y"],
        ),
        "desktop_scroll" => (
            &["observation", "x", "y", "amount"],
            &["observation", "x", "y", "amount"],
        ),
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
    // Validate every argument before connecting to the desktop or consuming the token.
    let mut points = None;
    let mut end = None;
    let mut button = Button::Left;
    let mut amount = 0;
    let mut typed = "";
    let mut pressed_key = Key::Return;
    let mut modifiers = Vec::new();
    if matches!(name, "desktop_click" | "desktop_scroll" | "desktop_drag") {
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
    }
    if name == "desktop_scroll" {
        amount = input["amount"].as_i64().context("invalid amount")?;
        ensure!(
            (-20..=20).contains(&amount) && amount != 0,
            "invalid scroll amount"
        );
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
    let mut enigo = Enigo::new(&Settings::default())
        .map_err(|e| anyhow::anyhow!("desktop input unavailable: {e}"))?;
    // Avoid mapping physical capture pixels onto DPI-virtualized input coordinates.
    #[cfg(windows)]
    {
        let (width, height) = enigo.main_display()?;
        ensure!(
            observation.origin_x == 0
                && observation.origin_y == 0
                && width == observation.width as i32
                && height == observation.height as i32,
            "display scaling or geometry differs from the screenshot; input is disabled"
        );
    }
    *state = None;
    let result = (|| -> Result<()> {
        if let Some((x, y)) = points {
            enigo.move_mouse(x, y, Coordinate::Abs)?;
        }
        match name {
            "desktop_click" => enigo.button(button, Direction::Click)?,
            "desktop_scroll" => enigo.scroll(amount as i32, Axis::Vertical)?,
            "desktop_type" => enigo.text(typed)?,
            "desktop_drag" => {
                enigo.button(Button::Left, Direction::Press)?;
                let (x, y) = end.unwrap();
                let moved = enigo.move_mouse(x, y, Coordinate::Abs);
                let released = enigo.button(Button::Left, Direction::Release);
                moved?;
                released?;
            }
            "desktop_key" => {
                let mut held = Vec::new();
                let result = (|| -> Result<()> {
                    for modifier in &modifiers {
                        enigo.key(*modifier, Direction::Press)?;
                        held.push(*modifier);
                    }
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
    Ok(
        json!({"completed":true,"message":"Input sent. Capture a fresh screenshot before further input."}),
    )
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

#[cfg(target_os = "linux")]
fn capture() -> Result<(image::DynamicImage, i32, i32)> {
    use x11rb::{
        connection::Connection,
        protocol::xproto::{ConnectionExt, ImageFormat, ImageOrder},
    };
    check_platform()?;
    let (conn, screen_id) = x11rb::connect(None).context("X11 display unavailable")?;
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
    Ok((image::DynamicImage::ImageRgba8(image), 0, 0))
}
#[cfg(windows)]
fn capture() -> Result<(image::DynamicImage, i32, i32)> {
    let monitors = xcap::Monitor::all()?;
    let monitor = monitors
        .into_iter()
        .find(|m| m.is_primary().unwrap_or(false))
        .context("primary monitor unavailable")?;
    let x = monitor.x()?;
    let y = monitor.y()?;
    let image = monitor.capture_image()?;
    ensure!(
        u64::from(image.width()) * u64::from(image.height()) <= 16_000_000,
        "desktop dimensions unsupported"
    );
    Ok((image::DynamicImage::ImageRgba8(image), x, y))
}
#[cfg(not(any(target_os = "linux", windows)))]
fn capture() -> Result<(image::DynamicImage, i32, i32)> {
    bail!("desktop control is not available on this platform")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn definitions_obey_read_only_and_validation_is_strict() {
        let provider = DesktopProvider::default();
        assert_eq!(provider.definitions("plan").len(), 1);
        assert_eq!(
            provider.definitions("plan")[0]["function"]["name"],
            "desktop_screenshot"
        );
        assert!(!provider.is_mutating("desktop_screenshot", &json!({})));
        assert!(provider.is_mutating("desktop_click", &json!({})));
        let state = Mutex::new(Some(Observation {
            token: "one".into(),
            width: 100,
            height: 100,
            origin_x: 0,
            origin_y: 0,
        }));
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
