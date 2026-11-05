//! Una ventana, un agente: varios agentes de Trex (un equipo, salas, chats a la
//! vez) no actúan al mismo tiempo sobre la misma ventana.
//!
//! Cada pasarela es un proceso; la primera que actúa en una ventana la reserva
//! durante un minuto desde su última acción, con un archivo en una carpeta
//! temporal común. Leer no reserva nada. Al cerrar, cada pasarela libera lo suyo.
use std::{
    collections::HashSet,
    fs,
    path::PathBuf,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

/// Una reserva caduca si su dueño no actúa en este tiempo (o se cerró de golpe).
pub const LEASE: Duration = Duration::from_secs(60);

fn now_ms() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|time| time.as_millis()).unwrap_or(0)
}

pub struct Locks {
    dir: PathBuf,
    owner: String,
    held: HashSet<isize>,
}

impl Default for Locks {
    fn default() -> Self {
        Self::in_dir(std::env::temp_dir().join("trex-a11y-locks"))
    }
}

impl Locks {
    pub fn in_dir(dir: PathBuf) -> Self {
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|time| time.subsec_nanos()).unwrap_or(0);
        Self { dir, owner: format!("{}-{nanos}", std::process::id()), held: HashSet::new() }
    }

    fn path(&self, window: isize) -> PathBuf {
        self.dir.join(format!("{window:X}.lock"))
    }

    /// Reserva (o renueva) la ventana; `Err` con el proceso de otro agente que la tiene.
    pub fn claim(&mut self, window: isize) -> Result<(), String> {
        let path = self.path(window);
        if let Ok(text) = fs::read_to_string(&path) {
            let mut lines = text.lines();
            let owner = lines.next().unwrap_or("");
            let at: u128 = lines.next().and_then(|line| line.trim().parse().ok()).unwrap_or(0);
            if owner != self.owner && now_ms().saturating_sub(at) < LEASE.as_millis() {
                return Err(owner.split('-').next().unwrap_or(owner).to_owned());
            }
        }
        // Sin carpeta o sin permiso no se bloquea a nadie: la reserva es una cortesía entre agentes.
        if fs::create_dir_all(&self.dir).is_ok() && fs::write(&path, format!("{}\n{}", self.owner, now_ms())).is_ok() {
            self.held.insert(window);
        }
        Ok(())
    }
}

impl Drop for Locks {
    fn drop(&mut self) {
        for window in self.held.drain().collect::<Vec<_>>() {
            let path = self.path(window);
            if fs::read_to_string(&path).is_ok_and(|text| text.lines().next() == Some(self.owner.as_str())) {
                let _ = fs::remove_file(path);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_agent_per_window_until_it_lets_go() {
        let dir = tempfile::tempdir().unwrap();
        let mut first = Locks::in_dir(dir.path().to_path_buf());
        let mut second = Locks::in_dir(dir.path().to_path_buf());
        second.owner = format!("{}-other", std::process::id() + 1);
        first.claim(0xA1).unwrap();
        first.claim(0xA1).unwrap();
        assert_eq!(second.claim(0xA1).unwrap_err(), std::process::id().to_string(), "the other agent's process is named");
        second.claim(0xB2).unwrap();
        // Una reserva vieja (su dueño se cerró de golpe) no bloquea.
        fs::write(dir.path().join("C3.lock"), format!("999-old\n{}", now_ms() - LEASE.as_millis() - 1)).unwrap();
        second.claim(0xC3).unwrap();
        drop(first);
        assert!(!dir.path().join("A1.lock").exists(), "released on exit");
        second.claim(0xA1).unwrap();
        assert!(dir.path().join("B2.lock").exists());
    }
}
