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

unsafe extern "system" fn procedure(hwnd: HWND, message: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    match message {
        WM_COMMAND if wparam.0 & 0xffff == BUTTON_ID && ((wparam.0 >> 16) & 0xffff) as u32 == BN_CLICKED => {
            CLICKS.fetch_add(1, Ordering::SeqCst);
            LRESULT(0)
        }
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
            let window = CreateWindowExW(WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW, class, w!("Trex a11y test"), WS_OVERLAPPEDWINDOW,
                -4000, -4000, 420, 260, None, None, Some(instance), None).unwrap();
            let child = |class: PCWSTR, text: PCWSTR, style: u32, y: i32, height: i32, id: usize| {
                CreateWindowExW(WINDOW_EX_STYLE(0), class, text, WS_CHILD | WS_VISIBLE | WS_TABSTOP | WINDOW_STYLE(style), 10, y, 200, height,
                    Some(window), Some(HMENU(id as _)), Some(instance), None).unwrap()
            };
            child(w!("BUTTON"), w!("Aceptar"), BS_PUSHBUTTON as u32, 10, 28, BUTTON_ID);
            child(w!("BUTTON"), w!("Recordar"), BS_AUTOCHECKBOX as u32, 46, 24, 102);
            child(w!("EDIT"), w!(""), ES_AUTOHSCROLL as u32 | WS_BORDER.0, 80, 24, 103);
            let combo = child(w!("COMBOBOX"), w!(""), CBS_DROPDOWNLIST as u32, 114, 120, 104);
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
    let mut engine = UiaEngine::new().unwrap();
    let id = format!("w{:X}", window.hwnd);
    let front = foreground();

    let listed = engine.call("list_windows", &json!({"app": "trex a11y test"})).unwrap();
    assert!(listed.contains(&id) && listed.contains("\"Trex a11y test\""), "{listed}");
    let snapshot = engine.call("snapshot", &json!({"window_id": id})).unwrap();
    assert!(snapshot.starts_with(&format!("window {id} \"Trex a11y test\"")), "{snapshot}");
    let button = reference(&snapshot, "button", "\"Aceptar\"");
    let check = reference(&snapshot, "checkbox", "\"Recordar\"");
    let edit = reference(&snapshot, "edit", "[");
    let combo = reference(&snapshot, "combobox", "[");
    assert!(snapshot.contains("checkbox \"Recordar\" unchecked [") && snapshot.contains("toggle]"), "{snapshot}");

    // Valores: escritos y comprobados releyendo el control.
    assert!(engine.call("set_value", &json!({"ref_id": edit, "value": "hola"})).unwrap().starts_with("Value verified: \"hola\""));
    assert!(engine.call("type", &json!({"ref_id": edit, "text": " mundo"})).unwrap().contains("\"hola mundo\""));
    assert_eq!(engine.call("get", &json!({"ref_id": edit, "property": "value"})).unwrap(), "hola mundo");
    assert!(engine.call("clear", &json!({"ref_id": edit})).unwrap().starts_with("Value verified: \"\""));

    // Casillas: idempotentes y verificadas.
    assert!(engine.call("check", &json!({"ref_id": check})).unwrap().starts_with("Now checked"));
    assert!(engine.call("check", &json!({"ref_id": check})).unwrap().starts_with("Already checked"));
    assert!(engine.call("uncheck", &json!({"ref_id": check})).unwrap().starts_with("Now unchecked"));
    assert!(engine.call("toggle", &json!({"ref_id": check})).unwrap().starts_with("Now checked"));

    // Botón: la aplicación recibe el clic sin ratón.
    assert!(engine.call("click", &json!({"ref_id": button})).unwrap().starts_with("Clicked (invoked)"));
    let deadline = Instant::now() + Duration::from_secs(2);
    while CLICKS.load(Ordering::SeqCst) == 0 && Instant::now() < deadline {
        sleep(Duration::from_millis(20));
    }
    assert_eq!(CLICKS.load(Ordering::SeqCst), 1);

    // Desplegable: elegir una opción por su nombre.
    let selected = engine.call("select", &json!({"ref_id": combo, "value": "verde"})).unwrap();
    assert!(selected.starts_with("Selected \"Verde\""), "{selected}");
    let found = engine.call("find", &json!({"window_id": id, "role": "button", "name": "acep"})).unwrap();
    assert!(found.contains("1 matches") && found.contains("button \"Aceptar\""), "{found}");

    // Ni la ventana de prueba ni ninguna otra pasó al frente.
    assert_eq!(foreground(), front, "an action changed the foreground window");

    // Las referencias caducan tras varios snapshots, con un error claro.
    for _ in 0..KEEP_SNAPSHOTS {
        engine.call("snapshot", &json!({"window_id": id})).unwrap();
    }
    assert_eq!(engine.call("click", &json!({"ref_id": button})).unwrap_err().code, "STALE_REF");
    assert_eq!(engine.call("snapshot", &json!({"app": "no-such-window-xyz"})).unwrap_err().code, "NOT_FOUND");
    assert_eq!(engine.call("snapshot", &json!({})).unwrap_err().code, "INVALID_ARGS");

    let closed = engine.call("close_app", &json!({"window_id": id})).unwrap();
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
fn automation_errors_become_stable_codes() {
    let error = |code: u32| failure(windows::core::Error::from(windows::core::HRESULT(code as i32))).code;
    assert_eq!(error(UIA_E_ELEMENTNOTAVAILABLE), "STALE_REF");
    assert_eq!(error(UIA_E_ELEMENTNOTENABLED), "DISABLED");
    assert_eq!(error(UIA_E_TIMEOUT), "UNCERTAIN");
    assert_eq!(error(E_ACCESSDENIED.0 as u32), "ACCESS_DENIED");
    assert_eq!(error(0x8000_4005), "ACTION_FAILED");
}
