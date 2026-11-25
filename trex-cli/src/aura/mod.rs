//! El aura: lo que se ve en la pantalla mientras trex controla el equipo.
//!
//! - Con el **control de computadora** (capturas y ratón y teclado reales) se
//!   marca toda la pantalla con el **visor**: cuatro esquinas que se cierran
//!   cuando trex mira la pantalla y una onda donde hace clic.
//! - Con el **control por accesibilidad** solo se marca la ventana que maneja,
//!   con la **cinta**: un trazo discontinuo alrededor que avanza mientras
//!   trabaja y se para cuando espera a que la persona deje de usar la ventana.
//!
//! Ambos usan el acento de Ajustes (`--accent` o `TREX_ACCENT`), se van solos
//! tras 30 s sin acciones, no reciben clics ni foco y nunca salen en las
//! capturas. Solo hay aura en Windows: en Wayland no se puede dibujar sobre
//! otras ventanas.
//!
//! Llamar a estas funciones nunca bloquea ni falla: si no se puede dibujar, no
//! pasa nada.
pub mod paint;
#[cfg(windows)]
mod win;

use paint::Rgb;
use std::sync::Mutex;

/// El rosa «cinta», el acento por defecto de la app.
const DEFAULT_ACCENT: Rgb = Rgb(0xf0, 0x6a, 0x8d);

static ACCENT: Mutex<Option<Rgb>> = Mutex::new(None);

/// Fija el acento (`#rrggbb`). Devuelve si era válido.
pub fn set_accent(hex: &str) -> bool {
    let Some(color) = Rgb::parse(hex) else { return false };
    if let Ok(mut accent) = ACCENT.lock() {
        *accent = Some(color);
    }
    true
}

/// El acento: el fijado, el de `TREX_ACCENT` o el de la app por defecto.
pub fn accent() -> Rgb {
    if let Some(color) = ACCENT.lock().ok().and_then(|accent| *accent) {
        return color;
    }
    std::env::var("TREX_ACCENT").ok().and_then(|hex| Rgb::parse(&hex)).unwrap_or(DEFAULT_ACCENT)
}

#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) enum Command {
    ScreenLook { label: String },
    ScreenAct { label: String, point: Option<(i32, i32)> },
    WindowLook { window: isize },
    WindowAct { window: isize, label: Option<String> },
    WindowWait { window: isize },
}

#[cfg(test)]
static IN_TESTS: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

fn send(command: Command) {
    // Las pruebas de la biblioteca no pintan nada en la pantalla de quien las corre.
    #[cfg(test)]
    if !IN_TESTS.load(std::sync::atomic::Ordering::Relaxed) {
        return;
    }
    #[cfg(windows)]
    win::send(command);
    #[cfg(not(windows))]
    drop(command);
}

/// Control de computadora: trex captura la pantalla.
pub fn screen_look(label: &str) {
    send(Command::ScreenLook { label: label.to_owned() });
}

/// Control de computadora: trex actúa; con `point` (píxeles físicos), una onda allí.
pub fn screen_act(label: &str, point: Option<(i32, i32)>) {
    send(Command::ScreenAct { label: label.to_owned(), point });
}

/// Control por accesibilidad: trex lee la ventana.
pub fn window_look(window: isize) {
    send(Command::WindowLook { window });
}

/// Control por accesibilidad: trex actúa en la ventana (con la acción, si se sabe).
pub fn window_act(window: isize, label: Option<&str>) {
    send(Command::WindowAct { window, label: label.map(str::to_owned) });
}

/// Control por accesibilidad: trex espera a que la persona deje de usar la ventana.
pub fn window_wait(window: isize) {
    send(Command::WindowWait { window });
}

/// Si una clase de ventana es del aura (no debe listarse como ventana de la persona).
#[cfg(windows)]
pub fn is_aura_class(name: &str) -> bool {
    name == win::CLASS
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_accent_falls_back_to_the_app_default() {
        assert!(!set_accent("naranja"));
        assert!(set_accent("#4fb8a3"));
        assert_eq!(accent(), Rgb(0x4f, 0xb8, 0xa3));
    }

    /// Muestra el visor y la cinta en la pantalla real y comprueba que no salen
    /// en las capturas. `cargo test -- --ignored aura_shows` en un escritorio de Windows.
    #[cfg(windows)]
    #[test]
    #[ignore]
    fn aura_shows_on_screen_but_never_in_captures() {
        use std::time::Duration;
        IN_TESTS.store(true, std::sync::atomic::Ordering::Relaxed);
        set_accent("#dcaa4a");
        let monitor = xcap::Monitor::all().unwrap().into_iter().find(|m| m.is_primary().unwrap_or(false)).unwrap();
        screen_look("mira la pantalla");
        std::thread::sleep(Duration::from_millis(900));
        let during = monitor.capture_image().unwrap();
        // El brazo izquierdo de la esquina de arriba pasa por x = 12 (a 100 %), de y = 34 a 96:
        // si la captura lo viera, esos píxeles serían del ocre exacto.
        let ocre = [0xdc_u8, 0xaa, 0x4a];
        let painted = (40..90).filter(|y| {
            let pixel = during.get_pixel(12, *y).0;
            pixel.iter().zip(ocre).all(|(got, want)| got.abs_diff(want) <= 6)
        });
        assert_eq!(painted.count(), 0, "the visor never shows up in a capture");
        screen_act("clic", Some((monitor.x().unwrap() + 400, monitor.y().unwrap() + 300)));
        std::thread::sleep(Duration::from_millis(1500));
    }

    /// Una ventana normal para ponerle la cinta.
    #[cfg(windows)]
    fn test_window(x: i32, y: i32) -> isize {
        use windows::core::w;
        use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
        use windows::Win32::Graphics::Gdi::{COLOR_WINDOW, HBRUSH};
        use windows::Win32::System::LibraryLoader::GetModuleHandleW;
        use windows::Win32::UI::WindowsAndMessaging::*;
        unsafe extern "system" fn procedure(hwnd: HWND, message: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
            unsafe { DefWindowProcW(hwnd, message, wparam, lparam) }
        }
        let (sender, receiver) = std::sync::mpsc::channel();
        std::thread::spawn(move || unsafe {
            let module = GetModuleHandleW(None).unwrap();
            let class = WNDCLASSW {
                lpfnWndProc: Some(procedure),
                hInstance: module.into(),
                lpszClassName: w!("TrexAuraTestWindow"),
                hbrBackground: HBRUSH((COLOR_WINDOW.0 + 1) as _),
                ..Default::default()
            };
            RegisterClassW(&class);
            let window = CreateWindowExW(WINDOW_EX_STYLE(0), w!("TrexAuraTestWindow"), w!("Facturas noviembre"), WS_OVERLAPPEDWINDOW | WS_VISIBLE, x, y, 720, 460, None, None, Some(module.into()), None).unwrap();
            sender.send(window.0 as isize).unwrap();
            let mut message = MSG::default();
            while GetMessageW(&mut message, Some(HWND(window.0)), 0, 0).as_bool() {
                DispatchMessageW(&message);
            }
        });
        receiver.recv().unwrap()
    }

    /// Recorrido visual: guarda capturas del visor y de la cinta en
    /// `%TEMP%/trex-aura-demo`. Con `TREX_AURA_CAPTURABLE=1` (solo en depuración)
    /// para que el aura salga en ellas.
    #[cfg(windows)]
    #[test]
    #[ignore]
    fn aura_demo_captures() {
        use std::time::Duration;
        use windows::Win32::Foundation::HWND;
        use windows::Win32::UI::WindowsAndMessaging::{SetWindowPos, SWP_NOACTIVATE, SWP_NOSIZE, SWP_NOZORDER};
        IN_TESTS.store(true, std::sync::atomic::Ordering::Relaxed);
        set_accent("#dcaa4a");
        let folder = std::env::temp_dir().join("trex-aura-demo");
        std::fs::create_dir_all(&folder).unwrap();
        let monitor = xcap::Monitor::all().unwrap().into_iter().find(|m| m.is_primary().unwrap_or(false)).unwrap();
        let shot = |name: &str| monitor.capture_image().unwrap().save(folder.join(format!("{name}.png"))).unwrap();
        let wait = |ms| std::thread::sleep(Duration::from_millis(ms));
        let window = test_window(260, 180);
        wait(600);
        screen_look("mira la pantalla");
        wait(120);
        shot("visor-cerrando");
        wait(900);
        shot("visor-quieto");
        screen_act("clic", Some((monitor.x().unwrap() + 700, monitor.y().unwrap() + 420)));
        wait(160);
        shot("visor-onda");
        wait(1200);
        window_look(window);
        wait(700);
        shot("cinta-lee");
        window_act(window, Some("escribe"));
        wait(400);
        shot("cinta-escribe");
        window_wait(window);
        wait(400);
        shot("cinta-espera");
        window_act(window, Some("clic"));
        unsafe {
            SetWindowPos(HWND(window as _), None, 520, 300, 0, 0, SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE).unwrap();
        }
        wait(300);
        shot("cinta-movida");
        // Otra ventana delante: la cinta queda debajo de ella.
        let _front = test_window(900, 560);
        wait(500);
        shot("cinta-tapada");
        println!("capturas en {}", folder.display());
    }
}
