//! Material de la ventana en Windows 11: Mica, Mica intensa o Acrílico.
//!
//! El sistema pinta el material detrás del webview, que ya es transparente:
//! - Mica: el fondo de escritorio difuminado y teñido, discreto.
//! - Mica intensa (Mica Alt): el mismo fondo con más color.
//! - Acrílico: deja ver difuminado lo que hay detrás de la ventana.
//!
//! Tauri no informa si el efecto llegó a aplicarse, así que la compatibilidad
//! se decide aquí por el número de compilación y la respuesta dice qué material
//! quedó puesto. El frontend solo aclara el marco con esa respuesta, para que
//! nunca deje ver el escritorio sin difuminar.

/// Primera compilación de Windows 11, la que trae Mica.
const MICA_FIRST_BUILD: u32 = 22000;
/// Desde aquí los fondos del sistema (Mica intensa y Acrílico) van por
/// `DWMWA_SYSTEMBACKDROP_TYPE`, sin el acrílico antiguo que se arrastraba.
const SYSTEM_BACKDROP_BUILD: u32 = 22523;

/// Material que puede ponerse en esta compilación; si el pedido no está, el más
/// cercano que sí lo esté.
fn supported_material(requested: &str, build: u32) -> &'static str {
    let wanted = match requested {
        "mica" => "mica",
        "mica-alt" => "mica-alt",
        "acrylic" => "acrylic",
        _ => return "none",
    };
    if build >= SYSTEM_BACKDROP_BUILD {
        wanted
    } else if build >= MICA_FIRST_BUILD {
        "mica"
    } else {
        "none"
    }
}

/// Pone el material pedido (claro u oscuro, como la interfaz) o lo retira.
/// Devuelve el material que queda puesto: "mica", "mica-alt", "acrylic" o "none".
#[tauri::command]
pub fn set_window_material(window: tauri::WebviewWindow, material: String, dark: bool) -> String {
    #[cfg(windows)]
    {
        use tauri::utils::config::WindowEffectsConfig;
        use tauri::window::{Effect, EffectsBuilder};
        let chosen = supported_material(&material, windows_version::OsVersion::current().build);
        let mica = if dark { Effect::MicaDark } else { Effect::MicaLight };
        let applied = match chosen {
            "mica" => window.set_effects(EffectsBuilder::new().effect(mica).build()),
            "mica-alt" => {
                let tabbed = if dark { Effect::TabbedDark } else { Effect::TabbedLight };
                window.set_effects(EffectsBuilder::new().effect(tabbed).build())
            }
            // El acrílico toma claro u oscuro del modo de la ventana, que solo
            // fija Mica: se pone primero y el acrílico lo sustituye después.
            "acrylic" => window
                .set_effects(EffectsBuilder::new().effect(mica).build())
                .and_then(|_| window.set_effects(EffectsBuilder::new().effect(Effect::Acrylic).build())),
            _ => {
                let _ = window.set_effects(None::<WindowEffectsConfig>);
                return "none".into();
            }
        };
        if applied.is_ok() {
            return chosen.into();
        }
        let _ = window.set_effects(None::<WindowEffectsConfig>);
    }
    #[cfg(not(windows))]
    let _ = (window, material, dark, supported_material("", 0));
    "none".into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_material_needs_its_windows_build() {
        assert_eq!(supported_material("mica-alt", 19045), "none", "Windows 10 stays opaque");
        assert_eq!(supported_material("mica-alt", 22000), "mica", "first Windows 11 falls back to Mica");
        assert_eq!(supported_material("acrylic", 22000), "mica");
        for material in ["mica", "mica-alt", "acrylic"] {
            assert_eq!(supported_material(material, 26200), material);
        }
        assert_eq!(supported_material("none", 26200), "none");
        assert_eq!(supported_material("glass", 26200), "none", "unknown names never turn the frame see-through");
    }
}
