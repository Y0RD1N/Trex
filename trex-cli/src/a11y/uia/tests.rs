//! Pruebas con una ventana Win32 real del propio proceso: fuera de la pantalla,
//! sin activarse y sin barra de tareas, para no molestar a quien use el equipo.
use super::*;
use serde_json::json;
use std::sync::atomic::{AtomicI32, AtomicUsize, Ordering};
use std::sync::mpsc;
use windows::core::w;
use windows::Win32::Foundation::{HINSTANCE, HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::WindowsAndMessaging::*;

static CLICKS: AtomicUsize = AtomicUsize::new(0);
/// Las pruebas con ventanas reales, de una en una: en la app hay un solo motor por
/// proceso, y crear varios a la vez a veces falla con un error genérico de Windows.
static REAL_WINDOWS: std::sync::Mutex<()> = std::sync::Mutex::new(());
/// Suma de los giros de rueda que recibió la ventana de la rueda.
static WHEEL: AtomicI32 = AtomicI32::new(0);
const BUTTON_ID: usize = 101;
/// «Agregar» crea un botón nuevo en la ventana; «Abrir diálogo», una ventana nueva.
const ADD_ID: usize = 105;
const DIALOG_ID: usize = 107;

unsafe extern "system" fn dialog_procedure(hwnd: HWND, message: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    unsafe { DefWindowProcW(hwnd, message, wparam, lparam) }
}

/// Ventana sin desplazamiento por accesibilidad (como una app Qt): solo entiende
/// la rueda del ratón, y con ella mueve sus dos botones.
unsafe extern "system" fn wheel_procedure(hwnd: HWND, message: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if message == WM_MOUSEWHEEL {
        let delta = ((wparam.0 >> 16) & 0xffff) as u16 as i16 as i32;
        let total = WHEEL.fetch_add(delta, Ordering::SeqCst) + delta;
        for (id, x) in [(301, 10), (302, 140)] {
            if let Ok(button) = unsafe { GetDlgItem(Some(hwnd), id) } {
                let _ = unsafe { MoveWindow(button, x, 100 + total / 12, 120, 28, true) };
            }
        }
        return LRESULT(0);
    }
    if message == WM_DESTROY {
        unsafe { PostQuitMessage(0) };
        return LRESULT(0);
    }
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
            // También cambia un valor que ya estaba y el título de la ventana.
            if let Ok(edit) = GetDlgItem(Some(hwnd), 103) {
                let _ = SetWindowTextW(edit, w!("agregado"));
            }
            let _ = SetWindowTextW(hwnd, w!("Trex a11y test (1)"));
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
            // Una lista larga, para desplazarla por accesibilidad.
            let list = CreateWindowExW(WINDOW_EX_STYLE(0), w!("LISTBOX"), w!(""), WS_CHILD | WS_VISIBLE | WS_VSCROLL | WS_BORDER, 220, 46, 180, 90,
                Some(window), Some(HMENU(108 as _)), Some(instance), None).unwrap();
            for index in 1..=30 {
                let item: Vec<u16> = format!("Fila {index:02}\0").encode_utf16().collect();
                SendMessageW(list, LB_ADDSTRING, None, Some(LPARAM(item.as_ptr() as isize)));
            }
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
impl TestWindow {
    /// La ventana de la rueda: sin barras de desplazamiento ni patrón Scroll.
    fn wheel() -> Self {
        let (sender, receiver) = mpsc::channel();
        let thread = std::thread::spawn(move || unsafe {
            let instance: HINSTANCE = GetModuleHandleW(None).unwrap().into();
            let class = w!("TrexA11yWheelTest");
            let definition = WNDCLASSW { lpfnWndProc: Some(wheel_procedure), hInstance: instance, lpszClassName: class, ..Default::default() };
            RegisterClassW(&definition);
            let window = CreateWindowExW(WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW, class, w!("Trex a11y wheel"), WS_OVERLAPPEDWINDOW,
                -4000, -3000, 320, 260, None, None, Some(instance), None).unwrap();
            // Contenido más abajo de lo que se ve: hay algo que desplazar.
            let _ = CreateWindowExW(WINDOW_EX_STYLE(0), w!("BUTTON"), w!("Abajo"), WS_CHILD | WS_VISIBLE | WINDOW_STYLE(BS_PUSHBUTTON as u32), 10, 600, 120, 28,
                Some(window), Some(HMENU(303 as _)), Some(instance), None);
            for (id, x, text) in [(301, 10, w!("Mover A")), (302, 140, w!("Mover B"))] {
                let _ = CreateWindowExW(WINDOW_EX_STYLE(0), w!("BUTTON"), text, WS_CHILD | WS_VISIBLE | WINDOW_STYLE(BS_PUSHBUTTON as u32), x, 100, 120, 28,
                    Some(window), Some(HMENU(id as _)), Some(instance), None);
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
    let _turn = REAL_WINDOWS.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let window = TestWindow::open();
    let mut engine = UiaEngine::new(false).unwrap();
    let id = format!("w{:X}", window.hwnd);
    let front = foreground();

    let listed = engine.run("list_windows", &json!({"app": "trex a11y test"})).unwrap();
    assert!(listed.contains(&id) && listed.contains("\"Trex a11y test\""), "{listed}");
    let snapshot = engine.run("snapshot", &json!({"window_id": id})).unwrap();
    assert!(snapshot.starts_with(&format!("window {id} \"Trex a11y test\"")), "{snapshot}");
    let check = reference(&snapshot, "checkbox", "\"Recordar\"");
    let edit = reference(&snapshot, "edit", "[");
    assert!(snapshot.contains("button \"Aceptar\"") && snapshot.contains("combobox"), "{snapshot}");
    assert!(snapshot.contains("checkbox \"Recordar\" unchecked [") && snapshot.contains("toggle]"), "{snapshot}");

    // Valores: escritos y comprobados releyendo el control.
    assert!(engine.run("set_value", &json!({"ref_id": edit, "value": "hola"})).unwrap().starts_with("Value verified: \"hola\""));
    assert!(engine.run("set_value", &json!({"ref_id": edit, "value": " mundo", "append": true})).unwrap().contains("\"hola mundo\""));
    assert_eq!(engine.run("get", &json!({"ref_id": edit, "property": "value"})).unwrap(), "hola mundo");
    assert!(engine.run("set_value", &json!({"ref_id": edit, "value": ""})).unwrap().starts_with("Value verified: \"\""), "an empty value clears it");

    // Casillas: idempotentes y verificadas.
    assert!(engine.run("toggle", &json!({"ref_id": check, "state": "on"})).unwrap().starts_with("Now checked"));
    assert!(engine.run("toggle", &json!({"ref_id": check, "state": "on"})).unwrap().starts_with("Already checked"));
    assert!(engine.run("toggle", &json!({"ref_id": check, "state": "off"})).unwrap().starts_with("Now unchecked"));
    assert!(engine.run("toggle", &json!({"ref_id": check})).unwrap().starts_with("Now checked"));
    assert_eq!(engine.run("toggle", &json!({"ref_id": check, "state": "maybe"})).unwrap_err().code, "INVALID_ARGS");

    // Un lote: varios pasos en una llamada, un solo informe al final.
    let batch = engine.run("batch", &json!({"steps": [
        {"tool": "set_value", "ref_id": edit, "value": "lote"},
        {"tool": "toggle", "ref_id": check, "state": "off"},
        {"tool": "wait", "ms": 50},
    ]})).unwrap();
    assert!(batch.starts_with("Batch completed (3 steps):\n1. set_value: Value verified: \"lote\".\n2. toggle: Now unchecked (verified).\n3. wait: Waited 50 ms."), "{batch}");
    assert_eq!(batch.matches("No visible change").count() + batch.matches("Changed (snapshot").count(), 1, "one report for the whole batch: {batch}");
    // Si un paso falla, se para y dice qué se completó (para no repetirlo).
    let failed = engine.run("batch", &json!({"steps": [
        {"tool": "set_value", "ref_id": edit, "value": "uno"},
        {"tool": "click", "ref_id": "@s999:e1"},
        {"tool": "set_value", "ref_id": edit, "value": "nunca"},
    ]})).unwrap_err();
    assert_eq!(failed.code, "STALE_REF");
    assert!(failed.message.starts_with("step 2 (click) failed:") && failed.message.contains("Completed, do not repeat: \n1. set_value"), "{}", failed.message);
    assert_eq!(engine.run("get", &json!({"ref_id": edit, "property": "value"})).unwrap(), "uno", "the third step never ran");
    engine.run("set_value", &json!({"ref_id": edit, "value": ""})).unwrap();

    // Leer solo el texto, sin referencias, por páginas.
    let text = engine.run("snapshot", &json!({"window_id": id, "format": "text", "max_elements": 3})).unwrap();
    assert!(text.starts_with(&format!("window {id} \"Trex a11y test\" (")) && text.contains(" · text · lines 1-3 of ") && text.contains("more with offset=3"), "{text}");
    assert!(!text.contains('@'), "no refs in text mode: {text}");
    assert!(text.contains("Aceptar"), "{text}");
    let next = engine.run("snapshot", &json!({"window_id": id, "format": "text", "offset": 3, "max_elements": 3})).unwrap();
    assert!(next.contains(" · text · lines 4-6 of "), "{next}");
    // Referencias nuevas para lo que sigue: los informes de arriba ya crearon varias lecturas.
    let snapshot = engine.run("snapshot", &json!({"window_id": id})).unwrap();
    let (button, combo) = (reference(&snapshot, "button", "\"Aceptar\""), reference(&snapshot, "combobox", "["));

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
    // Lo que ya estaba y cambió (el valor del campo) y el título nuevo, sin otro snapshot.
    assert!(added.contains("Window title is now \"Trex a11y test (1)\"."), "{added}");
    assert!(added.contains("Changed (snapshot") && added.contains("value=\"agregado\""), "{added}");
    assert!(!added.contains("disappeared"), "a new title does not make the old elements look gone: {added}");
    let fresh = reference(&added, "button", "\"Nuevo\"");
    assert_eq!(engine.run("get", &json!({"ref_id": fresh, "property": "name"})).unwrap(), "Nuevo");
    let opened = engine.run("click", &json!({"ref_id": reference(&snapshot, "button", "\"Abrir diálogo\"")})).unwrap();
    assert!(opened.contains("New window") && opened.contains("\"Trex a11y dialog\"") && opened.contains("button \"Cerrar\""), "{opened}");
    let quiet = engine.run("click", &json!({"ref_id": button})).unwrap();
    assert!(quiet.contains("No visible change in the window."), "{quiet}");
    assert_eq!(CLICKS.load(Ordering::SeqCst), 2);
    // Sin el permiso de Ajustes, nada de teclado.
    assert_eq!(engine.run("press", &json!({"window_id": id, "keys": "ctrl+s"})).unwrap_err().code, "NOT_ALLOWED");

    // Lista larga: se desplaza con su patrón y se comprueba la posición.
    let row = reference(&snapshot, "listitem", "\"Fila 01\"");
    let scrolled = engine.run("scroll", &json!({"ref_id": row, "direction": "down", "amount": 3})).unwrap();
    assert!(scrolled.starts_with("Scrolled; position now ") && !scrolled.starts_with("Scrolled; position now 0%"), "{scrolled}");
    let bottom = engine.run("scroll", &json!({"ref_id": row, "to": "bottom"})).unwrap();
    assert!(bottom.starts_with("Scrolled; position now 100%"), "{bottom}");
    let end = engine.run("scroll", &json!({"ref_id": row, "direction": "down"})).unwrap();
    assert!(end.starts_with("Nothing moved: it is already at the end."), "{end}");
    assert!(engine.run("scroll", &json!({"ref_id": row, "to": "top"})).unwrap().starts_with("Scrolled; position now 0%"));
    let last = reference(&snapshot, "listitem", "\"Fila 30\"");
    let shown = engine.run("scroll_to", &json!({"ref_id": last})).unwrap();
    assert!(shown.starts_with("Scrolled into view (verified)."), "{shown}");
    assert_eq!(engine.run("scroll", &json!({"ref_id": row})).unwrap_err().code, "INVALID_ARGS");

    // Desplegable: elegir una opción por su nombre.
    let selected = engine.run("select", &json!({"ref_id": combo, "value": "verde"})).unwrap();
    assert!(selected.starts_with("Selected \"Verde\""), "{selected}");
    let found = engine.run("find", &json!({"window_id": id, "role": "button", "name": "acep"})).unwrap();
    assert!(found.contains("1 matches") && found.contains("button \"Aceptar\""), "{found}");

    // Ninguna ventana de la prueba pasó al frente. (Otra sí puede: la persona
    // puede estar usando el equipo mientras corren las pruebas.)
    let now = foreground();
    assert!(now == front || !same_process(now, window.hwnd), "an action brought a test window to the front");

    // Las referencias caducan tras varios snapshots, con un error claro.
    for _ in 0..KEEP_SNAPSHOTS {
        engine.run("snapshot", &json!({"window_id": id})).unwrap();
    }
    assert_eq!(engine.run("click", &json!({"ref_id": button})).unwrap_err().code, "STALE_REF");
    assert_eq!(engine.run("snapshot", &json!({"app": "no-such-window-xyz"})).unwrap_err().code, "NOT_FOUND");
    assert_eq!(engine.run("snapshot", &json!({})).unwrap_err().code, "INVALID_ARGS");

    assert_eq!(engine.run("window", &json!({"window_id": id, "action": "explode"})).unwrap_err().code, "INVALID_ARGS");
    let closed = engine.run("window", &json!({"window_id": id, "action": "close"})).unwrap();
    assert!(closed.starts_with(&format!("Closed {id}")), "{closed}");
    drop(window);
}

#[test]
fn apps_without_scroll_support_get_the_mouse_wheel_as_a_message() {
    let _turn = REAL_WINDOWS.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let window = TestWindow::wheel();
    let mut engine = UiaEngine::new(false).unwrap();
    let id = format!("w{:X}", window.hwnd);
    // La ventana entera: no tiene patrón de desplazamiento, así que va la rueda.
    let moved = engine.run("scroll", &json!({"window_id": id, "direction": "down", "amount": 2})).unwrap();
    assert!(moved.starts_with("Scrolled with the mouse wheel sent to the window (the pointer did not move); the content moved 20 px."), "{moved}");
    assert_eq!(WHEEL.load(Ordering::SeqCst), -240, "two notches down");
    // Desde un elemento: el botón no la entiende y Windows se la pasa a su ventana.
    let snapshot = engine.run("snapshot", &json!({"window_id": id})).unwrap();
    let button = reference(&snapshot, "button", "\"Mover A\"");
    let back = engine.run("scroll", &json!({"ref_id": button, "direction": "up", "page": true})).unwrap();
    assert!(back.contains("the content moved 50 px"), "{back}");
    assert_eq!(WHEEL.load(Ordering::SeqCst), 360, "a page is five notches up");
    drop(window);
}

#[test]
fn trex_own_highlight_is_never_listed_as_a_window() {
    let _turn = REAL_WINDOWS.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let highlighter = super::super::highlight::Highlighter::start().expect("highlight window");
    highlighter.show(RECT { left: -3000, top: -3000, right: -2900, bottom: -2950 }, "prueba");
    sleep(Duration::from_millis(200));
    assert!(top_windows().iter().all(|facts| class_name(facts.0) != HIGHLIGHT_CLASS));
}

#[test]
fn changes_report_values_states_and_what_came_into_view() {
    let signature = |value: Option<&str>, states: &[&'static str]| Signature { value: value.map(str::to_owned), states: states.to_vec() };
    let same = signature(None, &["focused"]);
    assert_eq!(change(&same, &same), Change::Same);
    assert_eq!(change(&signature(None, &[]), &signature(Some("hola"), &[])), Change::Changed, "a new value");
    assert_eq!(change(&signature(None, &[]), &signature(None, &["focused"])), Change::Changed, "it got the focus");
    assert_eq!(change(&signature(None, &["unchecked"]), &signature(None, &["checked"])), Change::Changed);
    assert_eq!(change(&signature(None, &["disabled"]), &signature(None, &[])), Change::Changed, "it was enabled");
    assert_eq!(change(&signature(None, &["focused"]), &signature(None, &[])), Change::Same, "losing the focus is told by the one that got it");
    assert_eq!(change(&signature(None, &["selected"]), &signature(None, &[])), Change::Same);
    assert_eq!(change(&signature(None, &["offscreen"]), &signature(None, &[])), Change::Shown, "scrolled into view");
    assert_eq!(change(&signature(None, &[]), &signature(None, &["offscreen"])), Change::Same, "scrolled away");
}

#[test]
fn scrolling_helpers() {
    let positions = |items: &[(&str, i32, i32)]| items.iter().map(|(name, x, y)| (name.to_string(), (*x, *y))).collect::<HashMap<_, _>>();
    let before = positions(&[("Inicio", 0, 10), ("Series", 0, 40), ("Buscar", 0, 70), ("Cerrar", 300, 0)]);
    assert_eq!(moved(&before, &positions(&[("Inicio", 0, -90), ("Series", 0, -60), ("Buscar", 0, -30), ("Cerrar", 300, 0)])), (0, -100));
    assert_eq!(moved(&before, &before), (0, 0));
    assert_eq!(moved(&before, &positions(&[("Inicio", 0, 12), ("Series", 0, 40), ("Buscar", 0, 70), ("Cerrar", 300, 0)])), (0, 0), "one jitter is not a scroll");
    let window = RECT { left: 0, top: 0, right: 1000, bottom: 800 };
    assert_eq!(wheel_point(Some(RECT { left: 100, top: 700, right: 300, bottom: 900 }), window), (200, 750), "the visible part");
    assert_eq!(wheel_point(Some(RECT { left: 0, top: -200, right: 100, bottom: -100 }), window), (500, 400), "not visible: the window center");
    assert_eq!(wheel_point(None, window), (500, 400));
    assert!(inside(RECT { left: 10, top: 10, right: 50, bottom: 30 }, window));
    assert!(!inside(RECT { left: 10, top: -60, right: 50, bottom: -10 }, window), "a header slid above the window");
    assert!(!inside(RECT::default(), window));
    // La rueda solo va si hay contenido fuera de la vista (no a un reproductor de video).
    let player = [RECT { left: 0, top: 0, right: 1000, bottom: 800 }, RECT { left: 400, top: 700, right: 600, bottom: 760 }];
    assert!(!beyond(&player, window), "a video player: nothing to scroll, the wheel would change the volume");
    assert!(beyond(&[player[0], RECT { left: 10, top: 900, right: 200, bottom: 950 }], window), "a list continues below");
    assert!(beyond(&[RECT { left: 10, top: -60, right: 50, bottom: -10 }], window), "a header slid above");
    assert!(!beyond(&[RECT::default()], window), "hidden elements without a place do not count");
    assert_eq!(stem("notepad"), "notepad");
    assert_eq!(stem(r"C:\Users\Ana\poema.txt"), "poema");
    assert_eq!(stem("calc.exe"), "calc");
    assert!(takes_text("edit") && takes_text("document") && takes_text("combobox"));
    assert!(!takes_text("custom") && !takes_text("hyperlink") && !takes_text("image"), "Qt's writable values on everything are not text fields");
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
