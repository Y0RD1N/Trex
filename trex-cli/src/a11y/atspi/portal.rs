//! Teclado real en Linux por el portal RemoteDesktop (Wayland y X11).
//!
//! GNOME pide permiso a la persona la primera vez que se usa en cada pasarela; la
//! sesión dura lo que dure la pasarela y solo incluye el teclado (sin ratón ni
//! pantalla). No se guarda ningún permiso duradero.
use anyhow::{ensure, Result};
use ashpd::desktop::remote_desktop::{DeviceType, KeyState, RemoteDesktop, SelectDevicesOptions};
use ashpd::desktop::{PersistMode, Session};
use ashpd::enumflags2::BitFlags;

pub struct Keyboard {
    remote: RemoteDesktop,
    session: Session<RemoteDesktop>,
}

impl Keyboard {
    /// Abre la sesión (la persona ve el aviso de GNOME y decide).
    pub async fn start() -> Result<Self> {
        // Una conexión propia: si la pasarela termina, el permiso se retira con ella.
        let connection = zbus::Connection::session().await?;
        let remote = RemoteDesktop::with_connection(connection).await?;
        let session = remote.create_session(Default::default()).await?;
        remote
            .select_devices(&session, SelectDevicesOptions::default().set_devices(BitFlags::from(DeviceType::Keyboard)).set_persist_mode(PersistMode::DoNot))
            .await?
            .response()?;
        let response = remote.start(&session, None, Default::default()).await?.response()?;
        ensure!(response.devices().contains(DeviceType::Keyboard), "the keyboard was not granted");
        Ok(Self { remote, session })
    }

    async fn key(&self, keysym: u32, state: KeyState) -> Result<()> {
        self.remote.notify_keyboard_keysym(&self.session, keysym as i32, state, Default::default()).await?;
        Ok(())
    }

    /// Pulsa y suelta una combinación: modificadores, tecla, y los modificadores
    /// se sueltan siempre (también si algo falla a mitad).
    pub async fn combo(&self, modifiers: &[u32], key: u32) -> Result<()> {
        let mut held = Vec::new();
        let mut result = Ok(());
        for modifier in modifiers {
            result = self.key(*modifier, KeyState::Pressed).await;
            if result.is_err() {
                break;
            }
            held.push(*modifier);
        }
        if result.is_ok() {
            result = self.key(key, KeyState::Pressed).await;
            let released = self.key(key, KeyState::Released).await;
            result = result.and(released);
        }
        for modifier in held.into_iter().rev() {
            let released = self.key(modifier, KeyState::Released).await;
            result = result.and(released);
        }
        result
    }

    pub async fn close(self) {
        let _ = self.session.close().await;
    }
}
