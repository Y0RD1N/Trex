//! Bandeja del sistema: trex sigue de fondo con la ventana cerrada.
//!
//! Con «Al cerrar la ventana, seguir en la bandeja» activado, cerrar la ventana
//! principal (la ✕, Alt+F4 o la barra de tareas) la oculta en lugar de terminar:
//! los chats y agentes abiertos, el control remoto y los avisos siguen
//! funcionando. El icono de la bandeja la vuelve a mostrar (clic o «Abrir trex»)
//! y «Salir» termina de verdad, con el mismo cierre ordenado de siempre.
//!
//! Apagado, no hay icono y cerrar termina como antes.
//!
//! Solo en Windows. En Linux el icono depende de appindicator, y GNOME (el
//! escritorio de Fedora) no lo muestra sin una extensión: la ventana se iría sin
//! dejar forma de volver. En macOS no se ha podido probar. En ambos el ajuste no
//! aparece y cerrar sigue terminando.
//!
//! Todo lo que toca el icono y su menú se hace en el hilo principal: los tipos
//! de la bandeja no admiten otro hilo.

// Fuera de Windows solo se usan los textos en las pruebas.
#![cfg_attr(not(windows), allow(dead_code))]

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use tauri::{AppHandle, Manager};

/// La bandeja existe en esta plataforma.
pub const SUPPORTED: bool = cfg!(windows);

#[derive(Default)]
pub struct TrayState {
    /// Ajuste guardado: cerrar la ventana la oculta en la bandeja.
    keep_running: AtomicBool,
    /// El icono está puesto. Sin icono no se oculta nada: no habría forma de volver.
    icon_shown: AtomicBool,
    /// «Salir» en curso: el cierre ya no se intercepta.
    quitting: AtomicBool,
    /// Agentes trabajando y esperando respuesta, según el frontend.
    working: AtomicU32,
    waiting: AtomicU32,
    #[cfg(windows)]
    ui: std::sync::Mutex<Option<windows::TrayUi>>,
}

/// Al arrancar: pone el icono si el ajuste guardado lo pide. Se llama desde
/// `setup`, que ya corre en el hilo principal.
pub fn init(app: &AppHandle) {
    apply_now(app, crate::config::load_settings(app).close_to_tray);
}

/// Tras guardar la configuración: pone o quita el icono según el ajuste.
pub fn apply(app: &AppHandle, enabled: bool) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || apply_now(&handle, enabled));
}

fn apply_now(app: &AppHandle, enabled: bool) {
    let state = app.state::<TrayState>();
    state.keep_running.store(enabled && SUPPORTED, Ordering::SeqCst);
    #[cfg(windows)]
    windows::set_icon(app, &state, enabled);
}

/// ¿Cerrar la ventana principal debe ocultarla en vez de terminar?
pub fn keeps_running_on_close(app: &AppHandle) -> bool {
    let state = app.state::<TrayState>();
    should_hide(
        state.keep_running.load(Ordering::SeqCst),
        state.icon_shown.load(Ordering::SeqCst),
        state.quitting.load(Ordering::SeqCst),
    )
}

/// Solo con el ajuste activo, el icono a la vista y sin una salida en curso.
fn should_hide(keep_running: bool, icon_shown: bool, quitting: bool) -> bool {
    keep_running && icon_shown && !quitting
}

/// Oculta la ventana; la primera vez avisa de que trex sigue en la bandeja.
pub fn hide_to_tray(window: &tauri::Window) {
    let _ = window.hide();
    notice_once(window.app_handle());
}

/// Muestra y enfoca la ventana principal (icono, menú u otra copia de trex).
pub fn show_main(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else { return };
    let _ = window.show();
    if window.is_minimized().unwrap_or(false) {
        let _ = window.unminimize();
    }
    let _ = window.set_focus();
}

/// Termina trex de verdad: el mismo cierre ordenado que al cerrar sin bandeja.
pub fn quit(app: &AppHandle) {
    app.state::<TrayState>().quitting.store(true, Ordering::SeqCst);
    crate::shutdown_sessions(app);
    app.exit(0);
}

/// Archivo que recuerda que el aviso de la bandeja ya se mostró.
const NOTICE_MARKER: &str = "tray-notice-shown";

fn notice_once(app: &AppHandle) {
    let Ok(dir) = app.path().app_config_dir() else { return };
    let marker = dir.join(NOTICE_MARKER);
    if marker.exists() {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        use tauri_plugin_notification::NotificationExt;
        let shown = app
            .notification()
            .builder()
            .title("TREX · Sigue en la bandeja")
            .body("Los chats y agentes siguen trabajando. Ábrelo desde su icono junto al reloj; para cerrarlo del todo, elige «Salir» en ese menú.")
            .show();
        // Si el sistema no lo mostró, se intenta la próxima vez.
        if shown.is_ok() {
            let _ = std::fs::create_dir_all(&dir);
            let _ = std::fs::write(&marker, b"");
        }
    });
}

/// El frontend cuenta los agentes trabajando y esperando respuesta.
/// Sin `async`: Tauri la ejecuta en el hilo principal, donde vive el icono.
#[tauri::command]
pub fn tray_activity(app: AppHandle, working: u32, waiting: u32) {
    let state = app.state::<TrayState>();
    state.working.store(working, Ordering::SeqCst);
    state.waiting.store(waiting, Ordering::SeqCst);
    #[cfg(windows)]
    windows::refresh(&app, &state);
}

/// «Salir de trex» desde la propia ventana (menú «Más opciones»).
#[tauri::command]
pub fn app_quit(app: AppHandle) {
    quit(&app);
}

// --- Textos ------------------------------------------------------------------------

fn agents(count: u32) -> String {
    if count == 1 { "1 agente".into() } else { format!("{count} agentes") }
}

/// Línea de actividad del menú.
pub fn activity_line(working: u32, waiting: u32) -> String {
    let waits = if waiting == 1 { "espera tu respuesta" } else { "esperan tu respuesta" };
    match (working, waiting) {
        (0, 0) => "Ningún agente trabajando".into(),
        (working, 0) => format!("{} trabajando", agents(working)),
        (0, waiting) => format!("{} {waits}", agents(waiting)),
        (working, waiting) => format!("{} trabajando · {waiting} {waits}", agents(working)),
    }
}

/// Estado del control remoto, en el orden en que importa.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RemoteSummary {
    pub enabled: bool,
    pub running: bool,
    /// Móviles conectados ahora.
    pub connected: usize,
}

/// Línea del control remoto del menú.
pub fn remote_line(remote: RemoteSummary) -> String {
    match remote {
        RemoteSummary { enabled: false, .. } => "Control remoto apagado".into(),
        RemoteSummary { running: false, .. } => "Control remoto sin red todavía".into(),
        RemoteSummary { connected: 0, .. } => "Control remoto activo".into(),
        RemoteSummary { connected: 1, .. } => "Control remoto · 1 móvil conectado".into(),
        RemoteSummary { connected, .. } => format!("Control remoto · {connected} móviles conectados"),
    }
}

/// Texto al pasar el ratón por el icono.
pub fn tooltip(working: u32, waiting: u32) -> String {
    match (working, waiting) {
        (0, 0) => "trex".into(),
        _ => format!("trex · {}", activity_line(working, waiting)),
    }
}

#[cfg(windows)]
mod windows {
    use super::*;
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};

    const TRAY_ID: &str = "trex-tray";
    const MENU_OPEN: &str = "tray-open";
    const MENU_QUIT: &str = "tray-quit";

    pub(super) struct TrayUi {
        icon: TrayIcon,
        activity: MenuItem<tauri::Wry>,
        remote: MenuItem<tauri::Wry>,
        /// Últimos textos puestos: solo se tocan si cambian.
        texts: [String; 3],
    }

    fn lock<T>(mutex: &std::sync::Mutex<T>) -> std::sync::MutexGuard<'_, T> {
        mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn texts(app: &AppHandle, state: &TrayState) -> [String; 3] {
        let (working, waiting) = (state.working.load(Ordering::SeqCst), state.waiting.load(Ordering::SeqCst));
        let remote = crate::remote::tray_summary(&app.state::<crate::remote::RemoteState>());
        [activity_line(working, waiting), remote_line(remote), tooltip(working, waiting)]
    }

    /// Pone el icono (creándolo la primera vez) o lo esconde. Hilo principal.
    /// Se llama en cada guardado de la configuración: si nada cambia, no toca nada.
    pub(super) fn set_icon(app: &AppHandle, state: &TrayState, enabled: bool) {
        if state.icon_shown.load(Ordering::SeqCst) == enabled {
            return;
        }
        let mut ui = lock(&state.ui);
        match ui.as_ref().map(|tray| tray.icon.clone()) {
            // Aún no existe (y aquí `enabled` es true): se crea ya visible.
            None => match build(app, state) {
                Ok(built) => {
                    *ui = Some(built);
                    state.icon_shown.store(true, Ordering::SeqCst);
                }
                Err(error) => eprintln!("trex: no se pudo crear el icono de la bandeja: {error}"),
            },
            // Se crea una sola vez y después solo se muestra u oculta: rehacerlo
            // dejaría registrado otro manejador del menú cada vez.
            Some(icon) => {
                drop(ui);
                if icon.set_visible(enabled).is_ok() {
                    state.icon_shown.store(enabled, Ordering::SeqCst);
                }
                if enabled {
                    refresh(app, state);
                }
            }
        }
    }

    fn build(app: &AppHandle, state: &TrayState) -> tauri::Result<TrayUi> {
        let [activity_text, remote_text, tooltip_text] = texts(app, state);
        let open = MenuItem::with_id(app, MENU_OPEN, "Abrir trex", true, None::<&str>)?;
        let activity = MenuItem::with_id(app, "tray-activity", &activity_text, false, None::<&str>)?;
        let remote = MenuItem::with_id(app, "tray-remote", &remote_text, false, None::<&str>)?;
        let exit = MenuItem::with_id(app, MENU_QUIT, "Salir", true, None::<&str>)?;
        let menu = Menu::with_items(app, &[
            &open,
            &PredefinedMenuItem::separator(app)?,
            &activity,
            &remote,
            &PredefinedMenuItem::separator(app)?,
            &exit,
        ])?;
        let icon = TrayIconBuilder::with_id(TRAY_ID)
            .icon(tauri::include_image!("icons/32x32.png"))
            .tooltip(&tooltip_text)
            .menu(&menu)
            // Clic izquierdo abre la ventana; el menú va con el derecho.
            .show_menu_on_left_click(false)
            .on_menu_event(|app, event| match event.id().as_ref() {
                MENU_OPEN => show_main(app),
                MENU_QUIT => quit(app),
                _ => {}
            })
            .on_tray_icon_event(|tray, event| match event {
                TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } => {
                    show_main(tray.app_handle())
                }
                // Al acercar el ratón, el estado del control remoto se pone al día
                // antes de que se abra el menú.
                TrayIconEvent::Enter { .. } => {
                    let app = tray.app_handle();
                    refresh(app, &app.state::<TrayState>());
                }
                _ => {}
            })
            .build(app)?;
        Ok(TrayUi { icon, activity, remote, texts: [activity_text, remote_text, tooltip_text] })
    }

    /// Pone al día los textos del menú y del icono. Hilo principal.
    pub(super) fn refresh(app: &AppHandle, state: &TrayState) {
        if !state.icon_shown.load(Ordering::SeqCst) {
            return;
        }
        let next = texts(app, state);
        let mut ui = lock(&state.ui);
        let Some(tray) = ui.as_mut() else { return };
        if tray.texts[0] != next[0] {
            let _ = tray.activity.set_text(&next[0]);
        }
        if tray.texts[1] != next[1] {
            let _ = tray.remote.set_text(&next[1]);
        }
        if tray.texts[2] != next[2] {
            let _ = tray.icon.set_tooltip(Some(&next[2]));
        }
        tray.texts = next;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn closing_hides_only_with_the_setting_on_the_icon_shown_and_no_quit_in_progress() {
        assert!(should_hide(true, true, false));
        assert!(!should_hide(false, true, false), "setting off: closing quits as before");
        assert!(!should_hide(true, false, false), "without an icon there would be no way back");
        assert!(!should_hide(true, true, true), "«Salir» really quits");
    }

    #[test]
    fn the_activity_line_counts_working_and_waiting_agents_in_spanish() {
        assert_eq!(activity_line(0, 0), "Ningún agente trabajando");
        assert_eq!(activity_line(1, 0), "1 agente trabajando");
        assert_eq!(activity_line(3, 0), "3 agentes trabajando");
        assert_eq!(activity_line(0, 1), "1 agente espera tu respuesta");
        assert_eq!(activity_line(0, 2), "2 agentes esperan tu respuesta");
        assert_eq!(activity_line(2, 1), "2 agentes trabajando · 1 espera tu respuesta");
        assert_eq!(tooltip(0, 0), "trex");
        assert_eq!(tooltip(1, 0), "trex · 1 agente trabajando");
    }

    #[test]
    fn the_remote_line_says_whether_it_is_off_waiting_for_the_network_or_who_is_connected() {
        let off = RemoteSummary { enabled: false, running: false, connected: 0 };
        assert_eq!(remote_line(off), "Control remoto apagado");
        assert_eq!(remote_line(RemoteSummary { enabled: true, ..off }), "Control remoto sin red todavía");
        let on = RemoteSummary { enabled: true, running: true, connected: 0 };
        assert_eq!(remote_line(on), "Control remoto activo");
        assert_eq!(remote_line(RemoteSummary { connected: 1, ..on }), "Control remoto · 1 móvil conectado");
        assert_eq!(remote_line(RemoteSummary { connected: 2, ..on }), "Control remoto · 2 móviles conectados");
    }
}
