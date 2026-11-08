//! Combinaciones de teclas de `a11y_press` («ctrl+s», «alt+f», «enter»).
//!
//! Sin la tecla Windows: sus atajos abren partes del sistema, fuera de la app.

/// Teclas virtuales de Windows (los mismos códigos sirven para validar en cualquier plataforma).
pub const SHIFT: u16 = 0x10;
pub const CONTROL: u16 = 0x11;
pub const ALT: u16 = 0x12;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Combo {
    pub modifiers: Vec<u16>,
    pub key: u16,
    /// Forma legible: «Ctrl+S».
    pub label: String,
}

fn key_code(name: &str) -> Option<(u16, String)> {
    let named: &[(&[&str], u16, &str)] = &[
        (&["enter", "return"], 0x0D, "Enter"), (&["tab"], 0x09, "Tab"), (&["esc", "escape"], 0x1B, "Esc"),
        (&["space", "spacebar"], 0x20, "Space"), (&["backspace"], 0x08, "Backspace"), (&["delete", "del"], 0x2E, "Delete"),
        (&["insert", "ins"], 0x2D, "Insert"), (&["home"], 0x24, "Home"), (&["end"], 0x23, "End"),
        (&["pageup", "pgup"], 0x21, "PageUp"), (&["pagedown", "pgdn"], 0x22, "PageDown"), (&["up"], 0x26, "Up"),
        (&["down"], 0x28, "Down"), (&["left"], 0x25, "Left"), (&["right"], 0x27, "Right"),
    ];
    if let Some((_, code, label)) = named.iter().find(|(names, _, _)| names.contains(&name)) {
        return Some((*code, (*label).to_owned()));
    }
    let mut chars = name.chars();
    if let (Some(single), None) = (chars.next(), chars.next()) {
        if single.is_ascii_alphabetic() {
            return Some((single.to_ascii_uppercase() as u16, single.to_ascii_uppercase().to_string()));
        }
        if single.is_ascii_digit() {
            return Some((single as u16, single.to_string()));
        }
    }
    let number = name.strip_prefix('f').and_then(|digits| digits.parse::<u16>().ok()).filter(|n| (1..=24).contains(n))?;
    Some((0x70 + number - 1, format!("F{number}")))
}

/// Interpreta «ctrl+shift+s»; errores en inglés, para el agente.
pub fn parse(text: &str) -> Result<Combo, String> {
    let parts: Vec<String> = text.split('+').map(|part| part.trim().to_lowercase()).collect();
    if parts.iter().any(String::is_empty) {
        return Err(format!("Invalid key combination {text:?}; use forms like ctrl+s, alt+f or enter."));
    }
    let (modifier_names, key_name) = parts.split_at(parts.len() - 1);
    let mut modifiers = Vec::new();
    let mut labels = Vec::new();
    for name in modifier_names {
        let (code, label) = match name.as_str() {
            "ctrl" | "control" => (CONTROL, "Ctrl"),
            "shift" => (SHIFT, "Shift"),
            "alt" | "option" => (ALT, "Alt"),
            "win" | "windows" | "cmd" | "meta" | "super" => return Err("Windows-key shortcuts are not allowed: they act on the system, not on the app.".into()),
            other => return Err(format!("Unknown modifier {other}.")),
        };
        if !modifiers.contains(&code) {
            modifiers.push(code);
            labels.push(label.to_owned());
        }
    }
    let (key, label) = key_code(&key_name[0]).ok_or_else(|| format!("Unknown key {}.", key_name[0]))?;
    labels.push(label);
    Ok(Combo { modifiers, key, label: labels.join("+") })
}

/// Keysym de X11 de una tecla de `parse` (para el teclado de Linux, que va por keysyms).
pub fn keysym(code: u16) -> Option<u32> {
    let symbol = match code {
        SHIFT => 0xffe1,
        CONTROL => 0xffe3,
        ALT => 0xffe9,
        0x0D => 0xff0d,
        0x09 => 0xff09,
        0x1B => 0xff1b,
        0x20 => 0x20,
        0x08 => 0xff08,
        0x2E => 0xffff,
        0x2D => 0xff63,
        0x24 => 0xff50,
        0x23 => 0xff57,
        0x21 => 0xff55,
        0x22 => 0xff56,
        0x25 => 0xff51,
        0x26 => 0xff52,
        0x27 => 0xff53,
        0x28 => 0xff54,
        // Letras: el keysym en minúscula (Mayús ya va como modificador).
        0x41..=0x5A => u32::from(code) + 0x20,
        0x30..=0x39 => u32::from(code),
        0x70..=0x87 => 0xffbe + u32::from(code - 0x70),
        _ => return None,
    };
    Some(symbol)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_parsed_key_has_a_keysym() {
        let ctrl_s = parse("ctrl+shift+s").unwrap();
        assert_eq!(ctrl_s.modifiers.iter().map(|code| keysym(*code).unwrap()).collect::<Vec<_>>(), [0xffe3, 0xffe1]);
        assert_eq!(keysym(ctrl_s.key), Some(u32::from(b's')));
        assert_eq!(keysym(parse("f5").unwrap().key), Some(0xffc2));
        assert_eq!(keysym(parse("f24").unwrap().key), Some(0xffd5));
        assert_eq!(keysym(parse("enter").unwrap().key), Some(0xff0d));
        assert_eq!(keysym(parse("7").unwrap().key), Some(u32::from(b'7')));
        for name in ["tab", "esc", "space", "backspace", "delete", "insert", "home", "end", "pageup", "pagedown", "up", "down", "left", "right", "alt+a"] {
            let combo = parse(name).unwrap();
            assert!(keysym(combo.key).is_some() && combo.modifiers.iter().all(|code| keysym(*code).is_some()), "{name}");
        }
    }

    #[test]
    fn combinations_are_parsed_and_labelled() {
        assert_eq!(parse("ctrl+s").unwrap(), Combo { modifiers: vec![CONTROL], key: 0x53, label: "Ctrl+S".into() });
        assert_eq!(parse(" Ctrl + Shift + Z ").unwrap().label, "Ctrl+Shift+Z");
        assert_eq!(parse("alt+f4").unwrap(), Combo { modifiers: vec![ALT], key: 0x73, label: "Alt+F4".into() });
        assert_eq!(parse("enter").unwrap().key, 0x0D);
        assert_eq!(parse("ctrl+ctrl+1").unwrap().modifiers, vec![CONTROL]);
        assert!(parse("win+r").unwrap_err().contains("not allowed"));
        assert!(parse("ctrl+").is_err());
        assert!(parse("hyper+a").unwrap_err().contains("modifier"));
        assert!(parse("ctrl+f25").unwrap_err().contains("Unknown key"));
    }
}
