//! Pruebas del motor de Linux.
//!
//! Las primeras no necesitan escritorio. Las marcadas `#[ignore]` abren apps
//! reales (GTK 3 y GTK 4) y las manejan por AT-SPI: solo corren dentro del
//! escritorio aislado de `scripts/a11y-linux-session.sh` (Xvfb y buses propios),
//! nunca en el de la persona.
use super::bus::{role as r, state as s, Ifaces, Info, Obj, Raw, States};
use super::*;
use serde_json::json;

fn raw(role: u32, name: &str, states: &[u32], ifaces: u16, actions: &[&str]) -> Raw {
    Raw {
        obj: Obj::new(":1.9", &format!("/org/a11y/atspi/accessible/{role}{name}")),
        info: Info { role, states: States::of(states), name: name.into(), ifaces: Ifaces(ifaces), children: Vec::new() },
        actions: actions.iter().map(|action| action.to_string()).collect(),
        ..Raw::default()
    }
}

const SHOWN: [u32; 3] = [s::SHOWING, s::VISIBLE, s::SENSITIVE];

#[test]
fn roles_use_the_engine_vocabulary() {
    let none = States::default();
    let editable = Ifaces(Ifaces::EDITABLE_TEXT | Ifaces::TEXT);
    assert_eq!(role_name(r::TEXT, none, editable, false), "edit", "GTK entries are text with EditableText");
    assert_eq!(role_name(r::TEXT, none, Ifaces(Ifaces::TEXT), false), "text");
    assert_eq!(role_name(r::PASSWORD_TEXT, none, editable, false), "edit");
    assert_eq!(role_name(r::MENU, none, Ifaces::default(), true), "menuitem", "a menu-bar entry with an action");
    assert_eq!(role_name(r::MENU, none, Ifaces::default(), false), "menu");
    for (role, name) in [(r::TOGGLE_BUTTON, "button"), (r::PAGE_TAB, "tabitem"), (r::PAGE_TAB_LIST, "tab"), (r::DOCUMENT_WEB, "document"),
        (r::FRAME, "window"), (r::DIALOG, "window"), (r::SCROLL_PANE, "pane"), (r::TABLE_CELL, "dataitem"), (r::LINK, "hyperlink"),
        (r::SPIN_BUTTON, "spinner"), (r::LABEL, "text"), (r::PARAGRAPH, "text"), (r::HEADING, "heading"), (r::COMBO_BOX, "combobox"),
        (r::CHECK_BOX, "checkbox"), (r::RADIO_BUTTON, "radiobutton"), (r::CHECK_MENU_ITEM, "menuitem"), (9_999, "element")] {
        assert_eq!(role_name(role, none, Ifaces::default(), false), name, "role {role}");
    }
    assert!(is_container("window") && is_container("pane") && !is_container("button"));
    assert!(takes_text("edit") && takes_text("combobox") && !takes_text("button"));
}

#[test]
fn action_names_map_to_tools() {
    let names = |list: &[&str]| list.iter().map(|name| name.to_string()).collect::<Vec<_>>();
    assert_eq!(click_action(&names(&["press"]), "button"), Some(0));
    assert_eq!(click_action(&names(&["menu.popup", "click"]), "button"), Some(1));
    // En un campo, «activate» es enviar (Intro), no un clic.
    assert_eq!(click_action(&names(&["activate"]), "edit"), None);
    assert_eq!(click_action(&names(&["activate"]), "button"), Some(0));
    // GTK 4 publica acciones de la app (clipboard.copy…): no son clics.
    assert_eq!(click_action(&names(&["clipboard.copy", "selection.select-all", "link.open"]), "text"), None);
    assert_eq!(toggle_action(&names(&["click", "toggle"])), Some(1));
    assert_eq!(expand_action(&names(&["activate", "expand or contract"]), true), Some(1));
    assert_eq!(expand_action(&names(&["collapse", "expand"]), true), Some(1));
    assert_eq!(expand_action(&names(&["collapse", "expand"]), false), Some(0));
    assert_eq!(menu_action(&names(&["click", "showmenu"])), Some(1));
    assert_eq!(menu_action(&names(&["menu.popup"])), Some(0));
    assert_eq!(menu_action(&names(&["click"])), None);
}

#[test]
fn password_fields_are_recognized_without_a_role() {
    assert!(is_password(r::PASSWORD_TEXT, "Name", None));
    assert!(is_password(r::TEXT, "Clave", None), "GTK 4 has no password role");
    assert!(is_password(r::TEXT, "Password", None) && is_password(r::TEXT, "Contraseña nueva", None) && is_password(r::TEXT, "PIN", None));
    assert!(is_password(r::TEXT, "Campo", Some("••••")), "the text is masked");
    assert!(!is_password(r::TEXT, "Palabra clave", None), "a keyword is not a password");
    assert!(!is_password(r::TEXT, "Nombre", Some("Ana")));
}

#[test]
fn elements_become_snapshot_lines() {
    let button = describe(&raw(r::BUTTON, "Save", &SHOWN, Ifaces::ACTION | Ifaces::COMPONENT, &["click"]), false, false);
    assert!(button.referenced);
    assert_eq!(format_node(&button.node), "- button \"Save\" [click]");

    let mut entry = raw(r::TEXT, "Name", &[s::SHOWING, s::VISIBLE, s::SENSITIVE, s::EDITABLE, s::FOCUSABLE, s::FOCUSED],
        Ifaces::ACTION | Ifaces::EDITABLE_TEXT | Ifaces::TEXT, &["activate"]);
    entry.text = Some("Ana".into());
    assert_eq!(format_node(&describe(&entry, false, false).node), "- edit \"Name\" value=\"Ana\" focused [set_value]");

    let mut password = raw(r::TEXT, "Clave", &[s::SHOWING, s::VISIBLE, s::SENSITIVE, s::EDITABLE, s::FOCUSABLE], Ifaces::EDITABLE_TEXT | Ifaces::TEXT, &[]);
    password.text = Some("•••".into());
    let line = format_node(&describe(&password, false, false).node);
    assert_eq!(line, "- edit \"Clave\" password", "never its text, never writable");

    let check = describe(&raw(r::CHECK_BOX, "Wrap", &[s::SHOWING, s::VISIBLE, s::SENSITIVE, s::CHECKED], Ifaces::ACTION, &["click"]), false, false);
    assert_eq!(format_node(&check.node), "- checkbox \"Wrap\" checked [toggle]");
    let mixed = describe(&raw(r::CHECK_BOX, "All", &[s::SHOWING, s::VISIBLE, s::INDETERMINATE], Ifaces::ACTION, &["click"]), false, false);
    assert_eq!(format_node(&mixed.node), "- checkbox \"All\" disabled mixed [toggle]");

    let switch = describe(&raw(r::TOGGLE_BUTTON, "Wi-Fi", &[s::SHOWING, s::VISIBLE, s::SENSITIVE, s::PRESSED], Ifaces::ACTION, &["click"]), false, false);
    assert_eq!(format_node(&switch.node), "- button \"Wi-Fi\" checked [click,toggle]");

    let radio = describe(&raw(r::RADIO_BUTTON, "Small", &SHOWN, Ifaces::ACTION, &["click"]), false, false);
    assert_eq!(format_node(&radio.node), "- radiobutton \"Small\" unchecked [select]");

    let tab = describe(&raw(r::PAGE_TAB, "General", &[s::SHOWING, s::VISIBLE, s::SENSITIVE, s::SELECTABLE, s::SELECTED], Ifaces::COMPONENT, &[]), true, false);
    assert_eq!(format_node(&tab.node), "- tabitem \"General\" selected [select]");

    let mut combo = raw(r::COMBO_BOX, "Color", &[s::SHOWING, s::VISIBLE, s::SENSITIVE, s::EXPANDABLE], Ifaces::ACTION, &[]);
    combo.valuetext = Some("Red".into());
    assert_eq!(format_node(&describe(&combo, false, false).node), "- combobox \"Color\" value=\"Red\" collapsed [expand,select]");

    let mut slider = raw(r::SLIDER, "Volume", &SHOWN, Ifaces::VALUE, &[]);
    slider.number = Some(0.5);
    assert_eq!(format_node(&describe(&slider, false, false).node), "- slider \"Volume\" value=\"0.5\" [set_value]");

    let pane = describe(&raw(r::SCROLL_PANE, "", &SHOWN, Ifaces::COMPONENT, &[]), false, true);
    assert_eq!(format_node(&pane.node), "- pane [scroll]");

    // Fuera de la vista (desplazado): se puede traer.
    let below = describe(&raw(r::BUTTON, "More", &[s::VISIBLE, s::SENSITIVE], Ifaces::ACTION | Ifaces::COMPONENT, &["click"]), false, false);
    assert_eq!(format_node(&below.node), "- button \"More\" offscreen [click,scroll_to]");

    // En un menú, «seleccionar» solo resaltaría: no se ofrece.
    let item = describe(&raw(r::MENU_ITEM, "Open", &[s::SHOWING, s::VISIBLE, s::SENSITIVE, s::SELECTABLE], Ifaces::ACTION, &["click"]), true, false);
    assert_eq!(format_node(&item.node), "- menuitem \"Open\" [click]");

    // Párrafos de una página: su texto es su nombre.
    let mut paragraph = raw(r::PARAGRAPH, "", &SHOWN, Ifaces::TEXT, &[]);
    paragraph.text = Some("Hola \u{FFFC} mundo".into());
    let paragraph = describe(&paragraph, false, false);
    assert!(!paragraph.referenced);
    assert_eq!(format_node(&paragraph.node), "- text \"Hola mundo\"");

    // Una etiqueta de GTK 4 con acciones de portapapeles no es un control.
    let label = describe(&raw(r::LABEL, "Name", &SHOWN, Ifaces::ACTION | Ifaces::TEXT, &["clipboard.copy", "link.open"]), false, false);
    assert!(!label.referenced);
}

#[test]
fn trees_become_snapshots_and_keys() {
    // frame > [panel (oculto) > button, panel > [label, button, scroll pane > [scroll bar, text]]]
    let mut nodes = vec![
        raw(r::FRAME, "Editor", &[s::SHOWING, s::VISIBLE, s::ACTIVE], Ifaces::COMPONENT, &[]),
        raw(r::PANEL, "", &SHOWN, 0, &[]),
        raw(r::LABEL, "Ready", &SHOWN, Ifaces::TEXT, &[]),
        raw(r::BUTTON, "Save", &SHOWN, Ifaces::ACTION, &["click"]),
        raw(r::SCROLL_PANE, "", &SHOWN, Ifaces::COMPONENT, &[]),
        raw(r::SCROLL_BAR, "", &SHOWN, Ifaces::VALUE, &[]),
        raw(r::TEXT, "", &[s::SHOWING, s::VISIBLE, s::SENSITIVE, s::EDITABLE, s::FOCUSABLE], Ifaces::EDITABLE_TEXT | Ifaces::TEXT, &[]),
    ];
    let links = [(0, 1), (1, 2), (1, 3), (1, 4), (4, 5), (4, 6)];
    for (parent, kid) in links {
        nodes[kid].parent = Some(parent);
        nodes[parent].kids.push(kid);
    }
    nodes[6].text = Some("hola".into());
    let walk = build(&nodes, true, 300);
    let lines: Vec<String> = walk.entries.iter().map(|entry| format_node(&entry.node)).collect();
    assert_eq!(lines, ["- button \"Save\" [click]", "- pane [scroll]", "  - edit value=\"hola\" [set_value]"], "scroll bars are noise");
    assert!(!walk.truncated);
    // Las claves no usan el nombre de los contenedores (cambia solo).
    assert_eq!(walk.entries[0].key, "/group/button:Save");
    assert_eq!(walk.entries[2].key, "/group/pane/edit:");
    assert_eq!(walk.entries[0].parent.as_ref(), Some(&nodes[1].obj));
    let all = build(&nodes, false, 300);
    assert!(all.entries.iter().any(|entry| entry.node.name == "Ready"), "full reads include labels");
    let cut = build(&nodes, true, 1);
    assert_eq!(cut.entries.len(), 1);
    assert!(cut.truncated);
}

#[test]
fn changes_ignore_lost_focus_and_report_new_states() {
    let sig = |value: Option<&str>, states: &[&'static str]| Signature { value: value.map(str::to_owned), states: states.to_vec() };
    assert_eq!(change(&sig(Some("a"), &[]), &sig(Some("b"), &[])), Change::Changed);
    assert_eq!(change(&sig(None, &["unchecked"]), &sig(None, &["checked"])), Change::Changed);
    assert_eq!(change(&sig(None, &["focused"]), &sig(None, &[])), Change::Same, "losing the focus is told by the element that gains it");
    assert_eq!(change(&sig(None, &["offscreen"]), &sig(None, &[])), Change::Shown);
    assert_eq!(change(&sig(None, &[]), &sig(None, &["offscreen"])), Change::Same);
}

#[test]
fn idle_time_ignores_trex_own_shortcuts() {
    assert_eq!(user_idle(10_000, None, None), u32::MAX, "unknown means idle (not GNOME)");
    assert_eq!(user_idle(10_000, Some(9_000), None), 1_000);
    // La última entrada fue el atajo de Trex (de 8 000 a 8 050): la persona lleva más.
    assert_eq!(user_idle(10_000, Some(8_040), Some((8_000, 8_050))), 2_000);
    assert_eq!(user_idle(10_000, Some(9_500), Some((8_000, 8_050))), 500, "the user typed after it");
    assert!(user_active(true, 500) && !user_active(false, 0) && !user_active(true, 5_000));
}

#[test]
fn window_ids_are_stable_and_parseable() {
    let editor = Obj::new(":1.21", "/org/a11y/atspi/accessible/3");
    let key = window_key(&editor);
    assert_eq!(key, window_key(&editor.clone()), "the same in every gateway (locks rely on it)");
    assert_ne!(key, window_key(&Obj::new(":1.22", "/org/a11y/atspi/accessible/3")));
    assert!(key >= 0);
    assert_eq!(parse_window_id(&format!("w{key:X}")), Some(key));
    assert_eq!(parse_window_id("nope"), None);
    let info = WindowInfo { key: 0xAB, obj: editor, title: "Notas".into(), app: "gnome-text-editor".into(), app_name: "org.gnome.texteditor".into(),
        minimized: false, active: true };
    assert_eq!(info.line(), "wAB gnome-text-editor \"Notas\" foreground");
}

#[test]
fn title_buttons_in_common_languages() {
    assert!(title_button("Close", "close") && title_button("Cerrar", "close") && title_button(" Fermer ", "close"));
    assert!(title_button("Minimizar", "minimize") && title_button("Maximizar", "maximize") && title_button("Restaurar", "restore"));
    assert!(!title_button("Close tab", "close") && !title_button("Cerrar", "minimize"));
}

#[test]
fn installed_apps_are_found_by_id_name_or_program() {
    let text = "[Desktop Entry]\nType=Application\nName=Calculator\nName[es]=Calculadora\nExec=gnome-calculator %U\n\n[Desktop Action new]\nName=New\n";
    let entry = parse_desktop(Path::new("/usr/share/applications/org.gnome.Calculator.desktop"), text).unwrap();
    assert_eq!(entry.id, "org.gnome.calculator");
    assert_eq!(entry.names, ["calculator", "calculadora"], "actions do not add names");
    assert_eq!(desktop_score(&entry, "Calculadora"), 3);
    assert_eq!(desktop_score(&entry, "calculator"), 3, "the last part of the id");
    assert_eq!(desktop_score(&entry, "gnome-calculator"), 2);
    assert_eq!(desktop_score(&entry, "calc"), 1);
    assert_eq!(desktop_score(&entry, "firefox"), 0);
    assert_eq!(desktop_score(&entry, ""), 0);
    assert!(parse_desktop(Path::new("/x/hidden.desktop"), "[Desktop Entry]\nType=Application\nName=X\nHidden=true\n").is_none());
    assert!(parse_desktop(Path::new("/x/link.desktop"), "[Desktop Entry]\nType=Link\nName=X\n").is_none());
}

#[test]
fn launch_targets_paths_programs_and_documents() {
    let dir = tempfile::tempdir().unwrap();
    let document = dir.path().join("notes.txt");
    std::fs::write(&document, "hola").unwrap();
    let script = dir.path().join("tool.sh");
    std::fs::write(&script, "#!/bin/sh\n").unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    let (program, args, how) = launch_command(script.to_str().unwrap(), &["--x".into()]).unwrap();
    assert_eq!((program, args, how.as_str()), (script.clone(), vec!["--x".to_owned()], "program"));
    if crate::tools::find_program("gio").is_some() || crate::tools::find_program("xdg-open").is_some() {
        let (_, args, how) = launch_command(document.to_str().unwrap(), &[]).unwrap();
        assert_eq!(how, "default application");
        assert_eq!(args.last().unwrap(), document.to_str().unwrap());
    }
    if let Some(sh) = crate::tools::find_program("sh") {
        assert_eq!(launch_command("sh", &[]).unwrap().0, sh);
    }
    assert_eq!(launch_command("no-such-program-for-trex-xyz", &[]).unwrap_err().code, "LAUNCH_FAILED");
}

// --- Apps reales en el escritorio aislado ----------------------------------------------

/// Una sola prueba con apps a la vez: comparten el escritorio.
static DESKTOP: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn isolated() -> std::sync::MutexGuard<'static, ()> {
    assert_eq!(std::env::var("TREX_A11Y_SESSION").as_deref(), Ok("1"),
        "these tests open and drive real windows: run them with scripts/a11y-linux-session.sh, never on your own desktop");
    DESKTOP.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

struct App(std::process::Child);
impl App {
    fn start(program: &str, args: &[&str]) -> Self {
        Self(std::process::Command::new(program).args(args).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null()).spawn().unwrap_or_else(|error| panic!("{program}: {error}")))
    }
    /// Lo que la app escribió al terminar (como mucho 10 s de espera).
    fn output(mut self) -> String {
        let deadline = Instant::now() + Duration::from_secs(10);
        while self.0.try_wait().ok().flatten().is_none() {
            assert!(Instant::now() < deadline, "the app did not finish");
            sleep(Duration::from_millis(100));
        }
        let mut text = String::new();
        if let Some(mut out) = self.0.stdout.take() {
            use std::io::Read;
            let _ = out.read_to_string(&mut text);
        }
        text
    }
}
impl Drop for App {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn run(engine: &mut AtspiEngine, tool: &str, args: Value) -> ToolResult {
    engine.call(tool, &args, &AtomicBool::new(false))
}

fn ok(engine: &mut AtspiEngine, tool: &str, args: Value) -> String {
    run(engine, tool, args.clone()).unwrap_or_else(|error| panic!("{tool} {args}: {}: {}", error.code, error.message))
}

fn code(engine: &mut AtspiEngine, tool: &str, args: Value) -> &'static str {
    match run(engine, tool, args.clone()) {
        Ok(text) => panic!("{tool} {args} should fail, got: {text}"),
        Err(error) => error.code,
    }
}

/// La referencia de la primera línea que cumple `wanted`.
fn reference(text: &str, wanted: impl Fn(&str) -> bool) -> String {
    let line = text.lines().find(|line| line.contains("@s") && wanted(line)).unwrap_or_else(|| panic!("no matching line in:\n{text}"));
    line.split_whitespace().find(|word| word.starts_with("@s")).unwrap().to_owned()
}

fn wait_window(engine: &mut AtspiEngine, app: &str) {
    ok(engine, "wait", json!({"app": app, "timeout_ms": 15_000}));
}

#[test]
#[ignore = "needs the isolated desktop of scripts/a11y-linux-session.sh"]
fn gtk3_controls_are_read_and_operated() {
    let _desktop = isolated();
    let _app = App::start("gtk3-widget-factory", &[]);
    let mut engine = AtspiEngine::new(false).expect("accessibility bus");
    wait_window(&mut engine, "gtk3-widget-factory");
    let status = ok(&mut engine, "status", json!({}));
    assert!(status.contains("Linux AT-SPI") && status.contains("disabled in Trex settings"), "{status}");
    let windows = ok(&mut engine, "list_windows", json!({}));
    assert!(windows.contains("gtk3-widget-factory"), "{windows}");

    let snapshot = ok(&mut engine, "snapshot", json!({"app": "gtk3-widget-factory", "max_elements": 400}));
    for expected in ["button \"Close\" [click]", "checkbox \"checkbutton\"", "slider", "combobox \"Left\"", "tabitem \"page 2\"", "radiobutton \"Page 2\""] {
        assert!(snapshot.contains(expected), "{expected} missing in:\n{snapshot}");
    }
    assert!(!snapshot.contains("scrollbar"), "scroll bars are left out");

    // Casilla: cambia, se comprueba y no se repite.
    let check = reference(&snapshot, |line| line.contains("checkbox \"checkbutton\" unchecked") && !line.contains("disabled"));
    assert!(ok(&mut engine, "toggle", json!({"ref_id": check})).starts_with("Now checked (verified)."));
    assert!(ok(&mut engine, "toggle", json!({"ref_id": check, "state": "on"})).starts_with("Already checked"));
    assert!(ok(&mut engine, "toggle", json!({"ref_id": check, "state": "off"})).starts_with("Now unchecked (verified)."));
    let disabled = reference(&snapshot, |line| line.contains("checkbox") && line.contains("disabled"));
    assert_eq!(code(&mut engine, "toggle", json!({"ref_id": disabled})), "DISABLED");

    // Campo de texto: escribir, añadir y leer, comprobado releyendo.
    let entry = reference(&snapshot, |line| line.contains("edit value=\"entry\"") && !line.contains("disabled"));
    assert!(ok(&mut engine, "set_value", json!({"ref_id": entry, "value": "hola Trex"})).starts_with("Value verified: \"hola Trex\""));
    assert!(ok(&mut engine, "set_value", json!({"ref_id": entry, "value": " y más", "append": true})).contains("\"hola Trex y más\""));
    assert_eq!(ok(&mut engine, "get", json!({"ref_id": entry, "property": "value"})), "hola Trex y más");
    assert!(ok(&mut engine, "get", json!({"ref_id": entry, "property": "bounds"})).contains("relative to its window"));
    assert_eq!(code(&mut engine, "toggle", json!({"ref_id": entry})), "NOT_TOGGLEABLE");

    // Deslizador y casilla numérica.
    let slider = reference(&snapshot, |line| line.contains("slider") && !line.contains("disabled"));
    assert!(ok(&mut engine, "set_value", json!({"ref_id": slider, "value": "75"})).starts_with("Value set and verified: 75"));
    assert_eq!(code(&mut engine, "set_value", json!({"ref_id": slider, "value": "mucho"})), "INVALID_ARGS");
    let spinner = reference(&snapshot, |line| line.contains("spinner") && !line.contains("disabled"));
    assert!(ok(&mut engine, "set_value", json!({"ref_id": spinner, "value": "42"})).contains("42"));

    // Desplegable de GTK 3 (opciones en un menú oculto): se elige por nombre.
    let combo = reference(&snapshot, |line| line.contains("combobox \"Left\""));
    assert!(ok(&mut engine, "select", json!({"ref_id": combo, "value": "Right"})).starts_with("Selected \"Right\" (verified)."));
    assert!(ok(&mut engine, "get", json!({"ref_id": combo})).contains("combobox \"Right\""));
    assert_eq!(code(&mut engine, "select", json!({"ref_id": combo, "value": "Nowhere"})), "NOT_FOUND");

    // Pestaña de un cuaderno (Selection del contenedor).
    let tab = reference(&snapshot, |line| line.contains("tabitem \"page 2\""));
    assert!(ok(&mut engine, "select", json!({"ref_id": tab})).starts_with("Selected (verified)."));

    // Desplazamiento con la barra accesible de un panel.
    let pane = reference(&snapshot, |line| line.contains("pane [scroll]"));
    let scrolled = ok(&mut engine, "scroll", json!({"ref_id": pane, "direction": "down", "page": true}));
    assert!(scrolled.starts_with("Scrolled; position now") || scrolled.starts_with("Nothing moved"), "{scrolled}");
    let bottom = ok(&mut engine, "scroll", json!({"ref_id": pane, "to": "bottom"}));
    assert!(bottom.starts_with("Scrolled; position now 100%") || bottom.starts_with("Nothing moved"), "{bottom}");
    let top = ok(&mut engine, "scroll", json!({"ref_id": pane, "to": "top"}));
    assert!(top.starts_with("Scrolled; position now 0%") || top.starts_with("Nothing moved"), "{top}");
    assert_eq!(code(&mut engine, "scroll", json!({"ref_id": pane})), "INVALID_ARGS");

    // Cambiar de página: el informe trae lo nuevo con referencias que sirven.
    let page = reference(&snapshot, |line| line.contains("radiobutton \"Page 2\""));
    let changed = ok(&mut engine, "select", json!({"ref_id": page}));
    assert!(changed.starts_with("Selected (verified).") && changed.contains("New in the window (snapshot s"), "{changed}");
    let fresh = reference(&changed, |line| line.contains("[") && !line.contains("disabled"));
    ok(&mut engine, "get", json!({"ref_id": fresh}));

    // Texto completo de la ventana, por páginas.
    let text = ok(&mut engine, "snapshot", json!({"app": "gtk3-widget-factory", "format": "text", "max_elements": 20}));
    assert!(text.contains("· text · lines 1-20 of") && text.contains("more with offset=20"), "{text}");

    // Búsqueda y espera.
    let found = ok(&mut engine, "find", json!({"app": "gtk3-widget-factory", "role": "button", "name": "close"}));
    assert!(found.contains("1 matches") || found.contains("matches"), "{found}");
    assert!(ok(&mut engine, "wait", json!({"app": "gtk3-widget-factory", "role": "button", "name": "Close"})).contains("button \"Close\""));
    assert_eq!(code(&mut engine, "wait", json!({"app": "gtk3-widget-factory", "name": "No such thing", "timeout_ms": 500})), "TIMEOUT");
    assert_eq!(code(&mut engine, "find", json!({"app": "gtk3-widget-factory"})), "INVALID_ARGS");

    // Lote: varios pasos y un solo informe; si uno falla, dice lo hecho.
    let entry = reference(&ok(&mut engine, "find", json!({"app": "gtk3-widget-factory", "role": "edit"})), |line| !line.contains("disabled"));
    let batch = ok(&mut engine, "batch", json!({"steps": [{"tool": "set_value", "ref_id": entry, "value": "uno"}, {"tool": "set_value", "ref_id": entry, "value": "dos"}]}));
    assert!(batch.starts_with("Batch completed (2 steps):"), "{batch}");
    let failed = run(&mut engine, "batch", json!({"steps": [{"tool": "set_value", "ref_id": entry, "value": "tres"}, {"tool": "toggle", "ref_id": entry}]})).unwrap_err();
    assert_eq!(failed.code, "NOT_TOGGLEABLE");
    assert!(failed.message.contains("Completed, do not repeat") && failed.message.contains("1. set_value"), "{}", failed.message);

    // Las referencias caducan tras varios snapshots; las ventanas inexistentes se dicen.
    for _ in 0..KEEP_SNAPSHOTS {
        ok(&mut engine, "find", json!({"app": "gtk3-widget-factory", "role": "button", "name": "Close"}));
    }
    assert_eq!(code(&mut engine, "get", json!({"ref_id": check})), "STALE_REF");
    assert_eq!(code(&mut engine, "snapshot", json!({"app": "no-such-app"})), "NOT_FOUND");
    assert_eq!(code(&mut engine, "snapshot", json!({"window_id": "w1"})), "NOT_FOUND");
    assert_eq!(code(&mut engine, "press", json!({"app": "gtk3-widget-factory", "keys": "ctrl+s"})), "NOT_ALLOWED", "keyboard off in settings");

    // Cerrar con el botón de la barra de título.
    let closed = ok(&mut engine, "window", json!({"app": "gtk3-widget-factory", "action": "close"}));
    assert!(closed.starts_with("Closed w"), "{closed}");
    assert_eq!(ok(&mut engine, "wait", json!({"app": "gtk3-widget-factory", "gone": true})), "It is gone.");
}

#[test]
#[ignore = "needs the isolated desktop of scripts/a11y-linux-session.sh"]
fn gtk4_forms_keep_passwords_out_and_report_honestly() {
    let _desktop = isolated();
    let app = App::start("zenity", &["--forms", "--title=Trex form", "--add-entry=Name", "--add-password=Password", "--add-combo=Color",
        "--combo-values=Red|Green"]);
    let mut engine = AtspiEngine::new(true).expect("accessibility bus");
    wait_window(&mut engine, "Trex form");
    let snapshot = ok(&mut engine, "snapshot", json!({"app": "Trex form"}));
    assert!(snapshot.lines().any(|line| line.contains("edit \"Name\"") && line.ends_with("[set_value]")), "{snapshot}");
    let password = reference(&snapshot, |line| line.contains("edit \"Password\""));
    assert!(snapshot.contains("edit \"Password\" password\n") || snapshot.ends_with("edit \"Password\" password"), "never writable:\n{snapshot}");
    assert_eq!(code(&mut engine, "set_value", json!({"ref_id": password, "value": "secret"})), "PASSWORD");
    assert_eq!(code(&mut engine, "get", json!({"ref_id": password, "property": "value"})), "PASSWORD");

    let name = reference(&snapshot, |line| line.contains("edit \"Name\""));
    assert!(ok(&mut engine, "set_value", json!({"ref_id": name, "value": "Ana"})).starts_with("Value verified: \"Ana\""));

    // El desplegable de GTK 4: se abre (comprobado) y, si la fila no se confirma, se dice.
    let combo = reference(&snapshot, |line| line.contains("combobox \"Color\""));
    let opened = ok(&mut engine, "expand", json!({"ref_id": combo}));
    assert!(opened.starts_with("Expanded (verified)."), "{opened}");
    match run(&mut engine, "select", json!({"ref_id": combo, "value": "Green"})) {
        Ok(text) => {
            assert!(text.starts_with("Selected \"Green\" (verified)."), "{text}");
            assert!(ok(&mut engine, "get", json!({"ref_id": combo})).contains("value=\"Green\""), "a verified choice is really shown");
        }
        Err(error) => {
            assert_eq!(error.code, "NOT_KEPT");
            assert!(error.message.contains("still shows \"Red\""), "{}", error.message);
        }
    }

    // Plegar la lista (si quedó abierta) y comprobarlo.
    let folded = ok(&mut engine, "expand", json!({"ref_id": combo, "collapse": true}));
    assert!(folded.starts_with("Collapsed (verified).") || folded.starts_with("Already collapsed"), "{folded}");

    // Aceptar en un lote: la ventana se cierra y la app recibe lo escrito.
    let accept = reference(&ok(&mut engine, "find", json!({"app": "Trex form", "role": "button", "name": "OK"})), |_| true);
    let done = ok(&mut engine, "batch", json!({"steps": [{"tool": "set_value", "ref_id": name, "value": "Luis"}, {"tool": "click", "ref_id": accept}]}));
    assert!(done.contains("The window closed."), "{done}");
    let output = app.output();
    assert!(output.starts_with("Luis|"), "zenity got {output:?}");
}

#[test]
#[ignore = "needs the isolated desktop of scripts/a11y-linux-session.sh"]
fn apps_are_launched_by_program_or_name_and_closed() {
    let _desktop = isolated();
    let mut engine = AtspiEngine::new(false).expect("accessibility bus");
    let opened = ok(&mut engine, "launch", json!({"app": "gtk3-widget-factory"}));
    assert!(opened.starts_with("Opened gtk3-widget-factory (program).") && opened.contains("New window w"), "{opened}");
    let window = opened.split_whitespace().find(|word| word.starts_with('w') && word[1..].chars().all(|ch| ch.is_ascii_hexdigit()) && word.len() > 2).unwrap().to_owned();
    let minimized = ok(&mut engine, "window", json!({"window_id": window, "action": "minimize"}));
    assert!(minimized.to_lowercase().contains("minimize"), "{minimized}");
    assert_eq!(code(&mut engine, "window", json!({"window_id": window, "action": "spin"})), "INVALID_ARGS");
    assert!(ok(&mut engine, "window", json!({"window_id": window, "action": "close"})).starts_with("Closed"));
    ok(&mut engine, "wait", json!({"app": "gtk3-widget-factory", "gone": true}));
    // Por el nombre de la app instalada (su archivo .desktop), como lo diría una persona.
    if Path::new("/usr/share/applications/gtk3-widget-factory.desktop").exists() {
        let named = ok(&mut engine, "launch", json!({"app": "Widget Factory"}));
        assert!(named.starts_with("Opened Widget Factory (gtk3-widget-factory.desktop).") && named.contains("New window w"), "{named}");
        assert!(ok(&mut engine, "window", json!({"app": "gtk3-widget-factory", "action": "close"})).starts_with("Closed"));
    }
    assert_eq!(code(&mut engine, "launch", json!({"app": "no-such-program-for-trex-xyz"})), "LAUNCH_FAILED");
    assert_eq!(code(&mut engine, "launch", json!({})), "INVALID_ARGS");
}
