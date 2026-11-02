//! Wayland input/capture via XDG portals. No XWayland or privileged input fallback.
use super::{DesktopLease, DesktopUncertain};
use anyhow::{bail, ensure, Context, Result};
use ashpd::desktop::{
    remote_desktop::{Axis, DeviceType, KeyState, RemoteDesktop, SelectDevicesOptions},
    screencast::{CursorMode, Screencast, SelectSourcesOptions, SourceType, Stream},
    PersistMode, Session,
};
use base64::Engine;
use serde_json::{json, Value};
use std::{
    os::fd::{AsRawFd, OwnedFd},
    process::Stdio,
    time::{Duration, Instant},
};
use tokio::io::AsyncReadExt;
use tokio_util::sync::CancellationToken;

pub fn active() -> bool {
    std::env::var_os("WAYLAND_DISPLAY").is_some()
        || std::env::var("XDG_SESSION_TYPE").ok().as_deref() == Some("wayland")
}
pub fn diagnostic() -> Value {
    let pipeline = crate::tools::find_program("gst-launch-1.0").is_some();
    let bus = std::env::var_os("DBUS_SESSION_BUS_ADDRESS").is_some();
    json!({"available":pipeline && bus,"backend":"waylandPortal","requiresConsent":true,"coordinateSpace":"physicalPixels","monitors":[],"reason":if !bus{Some("sessionBusUnavailable")}else if !pipeline{Some("gstreamerPipewireRequired")}else{None},"requirements":["xdg-desktop-portal","xdg-desktop-portal-gnome or compositor portal","PipeWire","GStreamer pipewiresrc, videoconvert and pngenc"],"inputGranted":false})
}
/// Metadata and plugin probes never create a portal session or display consent.
pub async fn probe() -> Value {
    let mut value = diagnostic();
    let portals = tokio::time::timeout(Duration::from_secs(3), async {
        let cast = Screencast::new().await?;
        let remote = RemoteDesktop::new().await.ok();
        Ok::<_, ashpd::Error>((cast.version(), remote.map(|p| p.version())))
    })
    .await;
    let available = matches!(portals, Ok(Ok(_)));
    value["portalVerified"] = json!(available);
    if let Ok(Ok((capture, input))) = portals {
        value["screenCastVersion"] = json!(capture);
        value["remoteDesktopVersion"] = json!(input);
    }
    let mut plugins = true;
    if let Some(binary) = crate::tools::find_program("gst-inspect-1.0") {
        for plugin in ["pipewiresrc", "videoconvert", "pngenc"] {
            let mut command = tokio::process::Command::new(&binary);
            command
                .args(["--exists", plugin])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .kill_on_drop(true);
            if !matches!(tokio::time::timeout(Duration::from_secs(2),command.status()).await,Ok(Ok(status)) if status.success())
            {
                plugins = false;
            }
        }
    } else {
        plugins = false;
    }
    value["pluginsVerified"] = json!(plugins);
    value["available"] =
        json!(available && plugins && crate::tools::find_program("gst-launch-1.0").is_some());
    if !available {
        value["reason"] = json!("portalUnavailable");
    } else if !plugins {
        value["reason"] = json!("gstreamerPipewireRequired");
    }
    value
}
enum Binding {
    Observe {
        cast: Screencast,
        session: Session<Screencast>,
    },
    Control {
        cast: Screencast,
        remote: RemoteDesktop,
        session: Session<RemoteDesktop>,
        keyboard: bool,
        pointer: bool,
    },
}
struct Observation {
    token: String,
    stream: u32,
    width: u32,
    height: u32,
    logical: (i32, i32),
    at: Instant,
    generation: u64,
}
#[derive(Default)]
pub struct PortalState {
    binding: Option<Binding>,
    streams: Vec<Stream>,
    observation: Option<Observation>,
}
impl PortalState {
    pub fn invalidate(&mut self) {
        self.observation = None;
    }
    pub async fn close(&mut self) {
        self.observation = None;
        self.streams.clear();
        if let Some(binding) = self.binding.take() {
            let _ = tokio::time::timeout(Duration::from_secs(2), async {
                match binding {
                    Binding::Observe { session, .. } => session.close().await,
                    Binding::Control { session, .. } => session.close().await,
                }
            })
            .await;
        }
    }
    async fn initialize(&mut self, mode: &str, cancel: &CancellationToken) -> Result<()> {
        if self.binding.is_some() {
            return Ok(());
        }
        ensure!(crate::tools::find_program("gst-launch-1.0").is_some(),"install GStreamer with pipewiresrc, videoconvert and pngenc before using Wayland capture");
        let initialize = async {
            // A dedicated connection makes owner death revoke even a partially
            // initialized session; no restore token or enduring grant is saved.
            let connection = zbus::Connection::session().await?;
            let cast = Screencast::with_connection(connection.clone()).await?;
            let sources = SelectSourcesOptions::default()
                .set_sources(SourceType::Monitor | SourceType::Window)
                .set_multiple(true)
                .set_cursor_mode(CursorMode::Embedded)
                .set_persist_mode(PersistMode::DoNot);
            if mode == "plan" {
                let session = cast.create_session(Default::default()).await?;
                cast.select_sources(&session, sources).await?.response()?;
                let response = cast
                    .start(&session, None, Default::default())
                    .await?
                    .response()?;
                let streams = response.streams().to_vec();
                Ok::<_, anyhow::Error>((Binding::Observe { cast, session }, streams))
            } else {
                let remote = RemoteDesktop::with_connection(connection).await?;
                let session = remote.create_session(Default::default()).await?;
                remote
                    .select_devices(
                        &session,
                        SelectDevicesOptions::default()
                            .set_devices(DeviceType::Keyboard | DeviceType::Pointer),
                    )
                    .await?
                    .response()?;
                cast.select_sources(&session, sources).await?.response()?;
                let response = remote
                    .start(&session, None, Default::default())
                    .await?
                    .response()?;
                let keyboard = response.devices().contains(DeviceType::Keyboard);
                let pointer = response.devices().contains(DeviceType::Pointer);
                let streams = response.streams().to_vec();
                Ok((
                    Binding::Control {
                        cast,
                        remote,
                        session,
                        keyboard,
                        pointer,
                    },
                    streams,
                ))
            }
        };
        let initialized = tokio::select! {_=cancel.cancelled()=>bail!("Wayland authorization cancelled"),result=tokio::time::timeout(Duration::from_secs(120),initialize)=>result.context("Wayland authorization timed out")??};
        ensure!(
            !initialized.1.is_empty(),
            "no screen was granted by the portal"
        );
        self.binding = Some(initialized.0);
        self.streams = initialized.1;
        Ok(())
    }
    async fn fd(&self) -> Result<OwnedFd> {
        match self
            .binding
            .as_ref()
            .context("Wayland session unavailable")?
        {
            Binding::Observe { cast, session } => Ok(cast
                .open_pipe_wire_remote(session, Default::default())
                .await?),
            Binding::Control { cast, session, .. } => Ok(cast
                .open_pipe_wire_remote(session, Default::default())
                .await?),
        }
    }
    pub async fn run(
        &mut self,
        mode: &str,
        name: &str,
        input: &Value,
        cancel: CancellationToken,
    ) -> Result<Value> {
        ensure!(!cancel.is_cancelled(), "desktop operation cancelled");
        if name == "desktop_status" {
            super::validate_fields(input, &[], &[])?;
            let mut value = probe().await;
            value["sessionActive"] = json!(self.binding.is_some());
            return Ok(value);
        }
        if name == "desktop_wait" {
            super::validate_fields(input, &["milliseconds"], &["milliseconds"])?;
            let ms = input["milliseconds"]
                .as_u64()
                .filter(|n| *n <= 10000)
                .context("milliseconds must be 0..10000")?;
            self.observation = None;
            tokio::select! {_=cancel.cancelled()=>bail!("desktop wait cancelled"),_=tokio::time::sleep(Duration::from_millis(ms))=>{}}
            return Ok(json!({"completed":true}));
        }
        ensure!(
            mode != "plan" || matches!(name, "desktop_monitors" | "desktop_screenshot"),
            "plan mode forbids desktop input"
        );
        let mut lease = DesktopLease::acquire()?;
        self.initialize(mode, &cancel).await?;
        if name == "desktop_monitors" {
            super::validate_fields(input, &[], &[])?;
            return Ok(
                json!({"monitors":self.streams.iter().enumerate().map(|(n,s)|json!({"id":s.pipe_wire_node_id(),"name":format!("Portal screen {}",n+1),"primary":n==0,"size":s.size(),"position":s.position(),"coordinateSpace":"portalLogicalPixels"})).collect::<Vec<_>>() }),
            );
        }
        if name == "desktop_screenshot" {
            super::validate_fields(input, &["monitor"], &[])?;
            self.observation = None;
            let selected = input
                .get("monitor")
                .map(|v| {
                    v.as_u64()
                        .and_then(|n| u32::try_from(n).ok())
                        .context("invalid monitor ID")
                })
                .transpose()?;
            // The system can revoke a session at any time (for example "Stop
            // sharing" in GNOME). Drop it and ask the portal again instead of
            // failing with "Invalid session" for the rest of the conversation.
            let fd = match self.fd().await {
                Ok(fd) => fd,
                Err(_) => {
                    self.close().await;
                    self.initialize(mode, &cancel).await?;
                    self.fd().await?
                }
            };
            let stream = self
                .streams
                .iter()
                .find(|s| selected.is_none_or(|id| s.pipe_wire_node_id() == id))
                .context("monitor is not part of the granted portal session")?
                .clone();
            let bytes = capture(fd, stream.pipe_wire_node_id(), &cancel).await?;
            let dimensions = image::ImageReader::new(std::io::Cursor::new(&bytes))
                .with_guessed_format()?
                .into_dimensions()?;
            ensure!(
                dimensions.0 > 0
                    && dimensions.1 > 0
                    && u64::from(dimensions.0) * u64::from(dimensions.1) <= 64_000_000,
                "invalid capture dimensions"
            );
            let token = uuid::Uuid::new_v4().to_string();
            self.observation = Some(Observation {
                token: token.clone(),
                stream: stream.pipe_wire_node_id(),
                width: dimensions.0,
                height: dimensions.1,
                logical: stream
                    .size()
                    .unwrap_or((dimensions.0 as i32, dimensions.1 as i32)),
                at: Instant::now(),
                generation: lease.generation()?,
            });
            return Ok(
                json!({"content":[{"type":"text","text":format!("Wayland screenshot {}x{}; observation {token}. Only the screens selected in the system portal are accessible.",dimensions.0,dimensions.1)},{"type":"image","mimeType":"image/png","data":base64::engine::general_purpose::STANDARD.encode(bytes)}],"structuredContent":{"observation":token,"width":dimensions.0,"height":dimensions.1,"monitor":stream.pipe_wire_node_id(),"originX":0,"originY":0,"coordinateSpace":"physicalPixels","expiresInMs":30000}}),
            );
        }
        let fields: &[&str] = match name {
            "desktop_move" => &["observation", "x", "y"],
            "desktop_click" => &["observation", "x", "y", "button", "clicks"],
            "desktop_scroll" => &["observation", "x", "y", "axis", "amount"],
            "desktop_drag" => &["observation", "x", "y", "toX", "toY"],
            "desktop_type" => &["observation", "text"],
            "desktop_key" => &["observation", "key", "modifiers"],
            _ => bail!("unknown desktop tool"),
        };
        super::validate_fields(input, fields, &["observation"])?;
        let observation = self
            .observation
            .as_ref()
            .context("take a fresh Wayland screenshot first")?;
        ensure!(
            input["observation"].as_str() == Some(&observation.token)
                && observation.at.elapsed() <= Duration::from_secs(30),
            "stale desktop observation; take a new screenshot"
        );
        ensure!(
            lease.generation()? == observation.generation,
            "another agent changed the desktop; take a new screenshot"
        );
        validate_action(name, input, observation)?;
        let observation = self.observation.take().unwrap();
        lease.advance()?;
        let result = tokio::select! {_=cancel.cancelled()=>None,result=tokio::time::timeout(Duration::from_secs(30),self.action(name,input,&observation,&cancel))=>Some(result)};
        if !matches!(result, Some(Ok(Ok(())))) {
            self.close().await;
            return Err(DesktopUncertain.into());
        }
        Ok(
            json!({"completed":true,"message":"Input sent. Capture a fresh screenshot before further input."}),
        )
    }
    async fn action(
        &self,
        name: &str,
        input: &Value,
        o: &Observation,
        cancel: &CancellationToken,
    ) -> Result<()> {
        let Binding::Control {
            remote,
            session,
            keyboard,
            pointer,
            ..
        } = self
            .binding
            .as_ref()
            .context("Wayland control session unavailable")?
        else {
            bail!("read-only portal session")
        };
        ensure!(
            !cancel.is_cancelled(),
            "desktop input cancelled before dispatch"
        );
        if name == "desktop_type" || name == "desktop_key" {
            ensure!(*keyboard, "keyboard access was not granted");
        } else {
            ensure!(*pointer, "pointer access was not granted");
        }
        if input.get("x").is_some() {
            let (x, y) = coordinates(input, "x", "y", o)?;
            remote
                .notify_pointer_motion_absolute(session, o.stream, x, y, Default::default())
                .await?;
        }
        match name {
            "desktop_move" => (),
            "desktop_click" => {
                let button = match input["button"].as_str().unwrap_or("left") {
                    "left" => 272,
                    "right" => 273,
                    _ => 274,
                };
                for _ in 0..input["clicks"].as_u64().unwrap_or(1) {
                    ensure!(!cancel.is_cancelled(), "click cancelled");
                    remote
                        .notify_pointer_button(
                            session,
                            button,
                            KeyState::Pressed,
                            Default::default(),
                        )
                        .await?;
                    remote
                        .notify_pointer_button(
                            session,
                            button,
                            KeyState::Released,
                            Default::default(),
                        )
                        .await?;
                }
            }
            "desktop_scroll" => {
                remote
                    .notify_pointer_axis_discrete(
                        session,
                        if input["axis"] == "horizontal" {
                            Axis::Horizontal
                        } else {
                            Axis::Vertical
                        },
                        input["amount"].as_i64().unwrap() as i32,
                        Default::default(),
                    )
                    .await?
            }
            "desktop_drag" => {
                remote
                    .notify_pointer_button(session, 272, KeyState::Pressed, Default::default())
                    .await?;
                let (start_x, start_y) = coordinates(input, "x", "y", o)?;
                let (end_x, end_y) = coordinates(input, "toX", "toY", o)?;
                let moved = async {
                    for n in 1..=16 {
                        ensure!(!cancel.is_cancelled(), "drag cancelled");
                        remote
                            .notify_pointer_motion_absolute(
                                session,
                                o.stream,
                                start_x + (end_x - start_x) * f64::from(n) / 16.0,
                                start_y + (end_y - start_y) * f64::from(n) / 16.0,
                                Default::default(),
                            )
                            .await?;
                        tokio::time::sleep(Duration::from_millis(6)).await;
                    }
                    Ok::<_, anyhow::Error>(())
                }
                .await;
                let release = remote
                    .notify_pointer_button(session, 272, KeyState::Released, Default::default())
                    .await;
                moved?;
                release?;
            }
            "desktop_type" => {
                for ch in input["text"]
                    .as_str()
                    .unwrap()
                    .replace("\r\n", "\n")
                    .chars()
                {
                    ensure!(!cancel.is_cancelled(), "typing cancelled");
                    let code = keysym(&ch.to_string())?;
                    remote
                        .notify_keyboard_keysym(
                            session,
                            code,
                            KeyState::Pressed,
                            Default::default(),
                        )
                        .await?;
                    remote
                        .notify_keyboard_keysym(
                            session,
                            code,
                            KeyState::Released,
                            Default::default(),
                        )
                        .await?;
                }
            }
            "desktop_key" => {
                let mut held = Vec::new();
                let result = async {
                    if let Some(modifiers) = input["modifiers"].as_array() {
                        for modifier in modifiers {
                            ensure!(!cancel.is_cancelled(), "shortcut cancelled");
                            let code = modifier_keysym(modifier.as_str().unwrap())?;
                            remote
                                .notify_keyboard_keysym(
                                    session,
                                    code,
                                    KeyState::Pressed,
                                    Default::default(),
                                )
                                .await?;
                            held.push(code);
                        }
                    }
                    ensure!(!cancel.is_cancelled(), "shortcut cancelled");
                    let code = keysym(input["key"].as_str().unwrap())?;
                    remote
                        .notify_keyboard_keysym(
                            session,
                            code,
                            KeyState::Pressed,
                            Default::default(),
                        )
                        .await?;
                    remote
                        .notify_keyboard_keysym(
                            session,
                            code,
                            KeyState::Released,
                            Default::default(),
                        )
                        .await?;
                    Ok::<_, anyhow::Error>(())
                }
                .await;
                for code in held.into_iter().rev() {
                    remote
                        .notify_keyboard_keysym(
                            session,
                            code,
                            KeyState::Released,
                            Default::default(),
                        )
                        .await?;
                }
                result?;
            }
            _ => bail!("unknown input tool"),
        }
        Ok(())
    }
}
fn coordinates(input: &Value, x: &str, y: &str, o: &Observation) -> Result<(f64, f64)> {
    let x = input[x]
        .as_u64()
        .filter(|v| *v < u64::from(o.width))
        .context("x coordinate outside screenshot")?;
    let y = input[y]
        .as_u64()
        .filter(|v| *v < u64::from(o.height))
        .context("y coordinate outside screenshot")?;
    ensure!(
        o.logical.0 > 0 && o.logical.1 > 0,
        "portal stream geometry unavailable"
    );
    Ok((
        x as f64 * f64::from(o.logical.0) / f64::from(o.width),
        y as f64 * f64::from(o.logical.1) / f64::from(o.height),
    ))
}
fn keysym(key: &str) -> Result<i32> {
    let symbol = match key.to_ascii_lowercase().as_str() {
        "enter" | "\n" => 0xff0d,
        "tab" | "\t" => 0xff09,
        "escape" => 0xff1b,
        "backspace" => 0xff08,
        "delete" => 0xffff,
        "left" => 0xff51,
        "right" => 0xff53,
        "up" => 0xff52,
        "down" => 0xff54,
        "home" => 0xff50,
        "end" => 0xff57,
        "pageup" => 0xff55,
        "pagedown" => 0xff56,
        "space" => 32,
        _ => {
            let mut chars = key.chars();
            let ch = chars.next().context("empty key")?;
            ensure!(chars.next().is_none(), "unsupported key");
            let code = ch as u32;
            if code <= 255 {
                code as i32
            } else {
                (0x01000000 | code) as i32
            }
        }
    };
    Ok(symbol)
}
fn modifier_keysym(key: &str) -> Result<i32> {
    match key {
        "ctrl" => Ok(0xffe3),
        "alt" => Ok(0xffe9),
        "shift" => Ok(0xffe1),
        "meta" => Ok(0xffeb),
        _ => bail!("invalid modifier"),
    }
}
fn validate_action(name: &str, input: &Value, o: &Observation) -> Result<()> {
    if matches!(
        name,
        "desktop_move" | "desktop_click" | "desktop_scroll" | "desktop_drag"
    ) {
        coordinates(input, "x", "y", o)?;
    }
    if name == "desktop_drag" {
        coordinates(input, "toX", "toY", o)?;
    }
    if name == "desktop_click" {
        ensure!(
            input
                .get("button")
                .is_none_or(|v| matches!(v.as_str(), Some("left" | "right" | "middle"))),
            "invalid button"
        );
        ensure!(
            input
                .get("clicks")
                .is_none_or(|v| v.as_u64().is_some_and(|v| (1..=2).contains(&v))),
            "invalid clicks"
        );
    }
    if name == "desktop_scroll" {
        ensure!(
            input["amount"]
                .as_i64()
                .is_some_and(|n| n != 0 && (-20..=20).contains(&n)),
            "invalid scroll amount"
        );
        ensure!(
            input
                .get("axis")
                .is_none_or(|v| matches!(v.as_str(), Some("horizontal" | "vertical"))),
            "invalid scroll axis"
        );
    }
    if name == "desktop_type" {
        ensure!(
            input["text"]
                .as_str()
                .is_some_and(|s| !s.is_empty() && s.len() <= 4000 && !s.contains('\0')),
            "invalid text"
        );
    }
    if name == "desktop_key" {
        keysym(input["key"].as_str().context("key required")?)?;
        if let Some(modifiers) = input.get("modifiers") {
            let modifiers = modifiers.as_array().context("invalid modifiers")?;
            ensure!(modifiers.len() <= 4, "too many modifiers");
            let mut seen = std::collections::HashSet::new();
            for modifier in modifiers {
                let key = modifier.as_str().context("invalid modifier")?;
                modifier_keysym(key)?;
                ensure!(seen.insert(key), "duplicate modifier");
            }
        }
    }
    Ok(())
}
async fn capture(fd: OwnedFd, node: u32, cancel: &CancellationToken) -> Result<Vec<u8>> {
    let raw_fd = fd.as_raw_fd();
    let mut command = tokio::process::Command::new(
        crate::tools::find_program("gst-launch-1.0").context("GStreamer unavailable")?,
    );
    command
        .args([
            "-q",
            "pipewiresrc",
            &format!("fd={raw_fd}"),
            &format!("path={node}"),
            "num-buffers=1",
            "!",
            "videoconvert",
            "!",
            "pngenc",
            "snapshot=true",
            "!",
            "fdsink",
            "fd=1",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    unsafe {
        command.pre_exec(move || {
            if libc::fcntl(raw_fd, libc::F_SETFD, 0) < 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let mut child = command.spawn()?;
    let stdout = child.stdout.take().context("capture stdout unavailable")?;
    let operation = async {
        let mut bytes = Vec::new();
        stdout
            .take(4 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .await?;
        ensure!(bytes.len() <= 4 * 1024 * 1024, "capture exceeds 4 MiB");
        ensure!(
            child.wait().await?.success(),
            "PipeWire capture failed; verify the GStreamer pipewiresrc and pngenc plugins"
        );
        Ok::<_, anyhow::Error>(bytes)
    };
    let result = tokio::select! {_=cancel.cancelled()=>None,result=tokio::time::timeout(Duration::from_secs(15),operation)=>Some(result)};
    match result {
        Some(Ok(result)) => result,
        _ => {
            let _ = child.kill().await;
            bail!("Wayland capture interrupted or timed out")
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn logical_coordinates_and_unicode_keysyms() {
        let o = Observation {
            token: String::new(),
            stream: 1,
            width: 3840,
            height: 2160,
            logical: (1920, 1080),
            at: Instant::now(),
            generation: 0,
        };
        assert_eq!(
            coordinates(&json!({"x":1920,"y":1080}), "x", "y", &o).unwrap(),
            (960.0, 540.0)
        );
        assert_eq!(keysym("🦖").unwrap(), 0x0101f996);
        assert!(validate_action("desktop_click", &json!({"x":4000,"y":0}), &o).is_err());
    }
}
