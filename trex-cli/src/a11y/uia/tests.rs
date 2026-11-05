//! Pruebas con una ventana Win32 real del propio proceso: fuera de la pantalla,
//! sin activarse y sin barra de tareas, para no molestar a quien use el equipo.
use super::*;
use serde_json::json;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc;
use windows::core::w;
use windows::Win32::Foundation::{HINSTANCE, HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::WindowsAndMessaging::*;

static CLICKS: AtomicUsize = AtomicUsize::new(0);
const BUTTON_ID: usize = 101;
/// «Agregar» crea un botón nuevo en la ventana; «Abrir diálogo», una ventana nueva.
const ADD_ID: usize = 105;
const DIALOG_ID: usize = 107;

unsafe extern "system" fn dialog_procedure(hwnd: HWND, message: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    unsafe { DefWindowProcW(hwnd, message, wparam, lparam) }
}

unsafe extern "system" fn procedure(hwnd: HWND, message: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    let clicked = message == WM_COMMAND && ((wparam.0 >> 16) & 0xffff) as u32 == BN_CLICKED;
    match message {
        WM_COMMAND if clicked && wparam.0 & 0xffff == BUTTON_ID => {
            CLICKS.fetch_add(1, Ordering::SeqCst);
            LRESULT(0)
        }
        WM_COMMAND if clicked && wparam.0 & 0xffff == ADD_ID => unsafe {
            let instance: HINSTANCE = GetModuleHandleW(None).unwrap().into();
            let _ = CreateWindowExW(WINDOW_EX_STYLE(0), w!("BUTTON"), w!("Nuevo"), WS_CHILD | WS_VISIBLE | WINDOW_STYLE(BS_PUSHBUTTON as u32),
                230, 10, 100, 28, Some(hwnd), Some(HMENU(106 as _)), Some(instance), None);
            LRESULT(0)
        },
        WM_COMMAND if clicked && wparam.0 & 0xffff == DIALOG_ID => unsafe {
            let instance: HINSTANCE = GetModuleHandleW(None).unwrap().into();
            if let Ok(dialog) = CreateWindowExW(WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW, w!("TrexA11yTestDialog"), w!("Trex a11y dialog"), WS_OVERLAPPEDWINDOW,
                -4000, -3500, 300, 160, None, None, Some(instance), None) {
                let _ = CreateWindowExW(WINDOW_EX_STYLE(0), w!("BUTTON"), w!("Cerrar"), WS_CHILD | WS_VISIBLE | WINDOW_STYLE(BS_PUSHBUTTON as u32),
                    10, 10, 100, 28, Some(dialog), Some(HMENU(201 as _)), Some(instance), None);
                let _ = ShowWindow(dialog, SW_SHOWNOACTIVATE);
            }
            LRESULT(0)
        },
        WM_DESTROY => {
            unsafe { PostQuitMessage(0) };
            LRESULT(0)
        }
        _ => unsafe { DefWindowProcW(hwnd, message, wparam, lparam) },
    }
}

struct TestWindow {
    hwnd: isize,
    thread: Option<std::thread::JoinHandle<()>>,
}
impl TestWindow {
    fn open() -> Self {
        let (sender, receiver) = mpsc::channel();
        let thread = std::thread::spawn(move || unsafe {
            let instance: HINSTANCE = GetModuleHandleW(None).unwrap().into();
            let class = w!("TrexA11yTestWindow");
            let definition = WNDCLASSW { lpfnWndProc: Some(procedure), hInstance: instance, lpszClassName: class, ..Default::default() };
            RegisterClassW(&definition);
            let dialog = WNDCLASSW { lpfnWndProc: Some(dialog_procedure), hInstance: instance, lpszClassName: w!("TrexA11yTestDialog"), ..Default::default() };
            RegisterClassW(&dialog);
            let window = CreateWindowExW(WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW, class, w!("Trex a11y test"), WS_OVERLAPPEDWINDOW,
                -4000, -4000, 420, 300, None, None, Some(instance), None).unwrap();
            let child = |class: PCWSTR, text: PCWSTR, style: u32, y: i32, height: i32, id: usize| {
                CreateWindowExW(WINDOW_EX_STYLE(0), class, text, WS_CHILD | WS_VISIBLE | WS_TABSTOP | WINDOW_STYLE(style), 10, y, 200, height,
                    Some(window), Some(HMENU(id as _)), Some(instance), None).unwrap()
            };
            child(w!("BUTTON"), w!("Aceptar"), BS_PUSHBUTTON as u32, 10, 28, BUTTON_ID);
            child(w!("BUTTON"), w!("Recordar"), BS_AUTOCHECKBOX as u32, 46, 24, 102);
            child(w!("EDIT"), w!(""), ES_AUTOHSCROLL as u32 | WS_BORDER.0, 80, 24, 103);
            let combo = child(w!("COMBOBOX"), w!(""), CBS_DROPDOWNLIST as u32, 114, 120, 104);
            child(w!("BUTTON"), w!("Agregar"), BS_PUSHBUTTON as u32, 150, 28, ADD_ID);
            child(w!("BUTTON"), w!("Abrir diálogo"), BS_PUSHBUTTON as u32, 186, 28, DIALOG_ID);
            for item in [w!("Rojo"), w!("Verde"), w!("Azul")] {
                SendMessageW(combo, CB_ADDSTRING, None, Some(LPARAM(item.as_ptr() as isize)));
            }
            let _ = ShowWindow(window, SW_SHOWNOACTIVATE);
            sender.send(window.0 as isize).unwrap();
            let mut message = MSG::default();
            while GetMessageW(&mut message, None, 0, 0).as_bool() {
                let _ = TranslateMessage(&message);
                DispatchMessageW(&message);
            }
        });
        Self { hwnd: receiver.recv().unwrap(), thread: Some(thread) }
    }
}
impl Drop for TestWindow {
    fn drop(&mut self) {
        unsafe {
            let _ = PostMessageW(Some(HWND(self.hwnd as _)), WM_CLOSE, WPARAM(0), LPARAM(0));
        }
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

/// La referencia de la primera línea con ese rol y nombre.
fn reference(snapshot: &str, role: &str, name: &str) -> String {
    let line = snapshot
        .lines()
        .find(|line| line.contains(&format!(" {role}")) && line.contains(name) && line.contains('@'))
        .unwrap_or_else(|| panic!("no {role} {name} in:\n{snapshot}"));
    line.split_whitespace().find(|word| word.starts_with('@')).unwrap().to_owned()
}

#[test]
fn reads_and_operates_a_real_window_without_taking_its_focus() {
    let window = TestWindow::open();
    let mut engine = UiaEngine::new(false).unwrap();
    let id = format!("w{:X}", window.hwnd);
    let front = foreground();

    let listed = engine.run("list_windows", &json!({"app": "trex a11y test"})).unwrap();
    assert!(listed.contains(&id) && listed.contains("\"Trex a11y test\""), "{listed}");
    let snapshot = engine.run("snapshot", &json!({"window_id": id})).unwrap();
    assert!(snapshot.starts_with(&format!("window {id} \"Trex a11y test\"")), "{snapshot}");
    let button = reference(&snapshot, "button", "\"Aceptar\"");
    let check = reference(&snapshot, "checkbox", "\"Recordar\"");
    let edit = reference(&snapshot, "edit", "[");
    let combo = reference(&snapshot, "combobox", "[");
    assert!(snapshot.contains("checkbox \"Recordar\" unchecked [") && snapshot.contains("toggle]"), "{snapshot}");

    // Valores: escritos y comprobados releyendo el control.
    assert!(engine.run("set_value", &json!({"ref_id": edit, "value": "hola"})).unwrap().starts_with("Value verified: \"hola\""));
    assert!(engine.run("type", &json!({"ref_id": edit, "text": " mundo"})).unwrap().contains("\"hola mundo\""));
    assert_eq!(engine.run("get", &json!({"ref_id": edit, "property": "value"})).unwrap(), "hola mundo");
    assert!(engine.run("clear", &json!({"ref_id": edit})).unwrap().starts_with("Value verified: \"\""));

    // Casillas: idempotentes y verificadas.
    assert!(engine.run("check", &json!({"ref_id": check})).unwrap().starts_with("Now checked"));
    assert!(engine.run("check", &json!({"ref_id": check})).unwrap().starts_with("Already checked"));
    assert!(engine.run("uncheck", &json!({"ref_id": check})).unwrap().starts_with("Now unchecked"));
    assert!(engine.run("toggle", &json!({"ref_id": check})).unwrap().starts_with("Now checked"));

    // Botón: la aplicación recibe el clic sin ratón.
    assert!(engine.run("click", &json!({"ref_id": button})).unwrap().starts_with("Clicked (button message)"), "classic buttons get a posted click");
    let deadline = Instant::now() + Duration::from_secs(2);
    while CLICKS.load(Ordering::SeqCst) == 0 && Instant::now() < deadline {
        sleep(Duration::from_millis(20));
    }
    assert_eq!(CLICKS.load(Ordering::SeqCst), 1);

    // Cada acción dice qué cambió, con referencias listas para usar.
    let added = engine.run("click", &json!({"ref_id": reference(&snapshot, "button", "\"Agregar\"")})).unwrap();
    assert!(added.contains("New in the window") && added.contains("button \"Nuevo\""), "{added}");
    let fresh = reference(&added, "button", "\"Nuevo\"");
    assert_eq!(engine.run("get", &json!({"ref_id": fresh, "property": "name"})).unwrap(), "Nuevo");
    let opened = engine.run("click", &json!({"ref_id": reference(&snapshot, "button", "\"Abrir diálogo\"")})).unwrap();
    assert!(opened.contains("New window") && opened.contains("\"Trex a11y dialog\"") && opened.contains("button \"Cerrar\""), "{opened}");
    let quiet = engine.run("click", &json!({"ref_id": button})).unwrap();
    assert!(quiet.contains("No visible change in the window."), "{quiet}");
    assert_eq!(CLICKS.load(Ordering::SeqCst), 2);
    // Sin el permiso de Ajustes, nada de teclado.
    assert_eq!(engine.run("press", &json!({"window_id": id, "keys": "ctrl+s"})).unwrap_err().code, "NOT_ALLOWED");

    // Desplegable: elegir una opción por su nombre.
    let selected = engine.run("select", &json!({"ref_id": combo, "value": "verde"})).unwrap();
    assert!(selected.starts_with("Selected \"Verde\""), "{selected}");
    let found = engine.run("find", &json!({"window_id": id, "role": "button", "name": "acep"})).unwrap();
    assert!(found.contains("1 matches") && found.contains("button \"Aceptar\""), "{found}");

    // Ni la ventana de prueba ni ninguna otra pasó al frente.
    assert_eq!(foreground(), front, "an action changed the foreground window");

    // Las referencias caducan tras varios snapshots, con un error claro.
    for _ in 0..KEEP_SNAPSHOTS {
        engine.run("snapshot", &json!({"window_id": id})).unwrap();
    }
    assert_eq!(engine.run("click", &json!({"ref_id": button})).unwrap_err().code, "STALE_REF");
    assert_eq!(engine.run("snapshot", &json!({"app": "no-such-window-xyz"})).unwrap_err().code, "NOT_FOUND");
    assert_eq!(engine.run("snapshot", &json!({})).unwrap_err().code, "INVALID_ARGS");

    let closed = engine.run("close_app", &json!({"window_id": id})).unwrap();
    assert!(closed.starts_with(&format!("Closed {id}")), "{closed}");
    drop(window);
}

#[test]
fn the_user_keeps_priority_in_the_window_they_are_using() {
    assert!(user_active(10, 10, 300), "typing in the target window right now");
    assert!(!user_active(10, 10, USER_ACTIVE_MS + 1), "idle for a while");
    assert!(!user_active(11, 10, 0), "working in another window does not block a background one");
    assert!(!user_active(0, 0, 0));
}

#[test]
fn shortcuts_sent_by_trex_are_not_taken_for_the_user() {
    // La persona tocó algo hace 5 s; Trex envió un atajo hace 0,2 s.
    let now = 100_000;
    assert_eq!(user_idle(now, Some(now - 200), Some((now - 210, now - 195))), 210, "Trex's own keys do not count");
    assert_eq!(user_idle(now, Some(now - 50), Some((now - 5_000, now - 4_990))), 50, "later input is the user's");
    assert_eq!(user_idle(now, Some(now - 900), None), 900);
    assert_eq!(user_idle(now, None, None), u32::MAX);
    // Con el contador de Windows dando la vuelta.
    assert_eq!(user_idle(30, Some(u32::MAX - 9), Some((u32::MAX - 20, u32::MAX - 5))), 51);
}

#[test]
fn automation_errors_become_stable_codes() {
    let error = |code: u32| failure(windows::core::Error::from(windows::core::HRESULT(code as i32))).code;
    assert_eq!(error(UIA_E_ELEMENTNOTAVAILABLE), "STALE_REF");
    assert_eq!(error(UIA_E_ELEMENTNOTENABLED), "DISABLED");
    assert_eq!(error(UIA_E_TIMEOUT), "UNCERTAIN");
    assert_eq!(error(E_ACCESSDENIED.0 as u32), "ACCESS_DENIED");
    assert_eq!(error(0x8000_4005), "ACTION_FAILED");
}
