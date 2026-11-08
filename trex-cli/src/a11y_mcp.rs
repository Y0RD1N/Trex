//! Control por accesibilidad: el motor propio de Trex (`crate::a11y`) como
//! servidor MCP (`trex-agent a11y-mcp`).
//!
//! Opera las aplicaciones mediante el árbol de accesibilidad del sistema (UI
//! Automation en Windows, AT-SPI en Linux), sin mover el ratón ni escribir con el teclado de la
//! persona. Es una integración independiente del control de computadora
//! (`trex_desktop`): la persona elige cuál usar.
//!
//! Antes había un motor externo (agent-desktop). Las configuraciones antiguas
//! que lo piden siguen funcionando con el motor propio.
use anyhow::{bail, ensure, Result};
use serde_json::{json, Value};

pub const PREFIX: &str = "a11y_";

/// Motores que aceptan las configuraciones guardadas: todos usan el propio.
pub fn known_engine(engine: &str) -> Result<()> {
    if !matches!(engine, "auto" | "trex" | "agent-desktop") {
        bail!("unknown accessibility engine {engine}");
    }
    Ok(())
}

/// Disponibilidad para Ajustes: no abre aplicaciones ni lee la pantalla.
pub fn doctor() -> Value {
    let reason = if crate::a11y::available() { crate::a11y::unavailable_reason() } else { Some("unsupportedPlatform") };
    json!({"available": reason.is_none(), "engine": "trex", "platform": std::env::consts::OS, "reason": reason})
}

pub fn serve(mode: &str, keyboard: bool) -> Result<()> {
    ensure!(matches!(mode, "plan" | "full"), "accessibility MCP mode must be plan or full");
    ensure!(crate::a11y::available(), "the accessibility engine is only available on Windows and Linux");
    // Sin bus de accesibilidad (Linux sin escritorio) el servidor no arranca: la
    // sesión lo marca como no disponible en vez de fallar en cada llamada.
    if let Some(reason) = crate::a11y::unavailable_reason() {
        anyhow::bail!("the accessibility engine cannot run here ({reason})");
    }
    crate::a11y::serve(mode, keyboard)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saved_configurations_keep_working_with_the_builtin_engine() {
        for engine in ["auto", "trex", "agent-desktop"] {
            assert!(known_engine(engine).is_ok(), "{engine}");
        }
        assert!(known_engine("other").is_err());
        let status = doctor();
        assert_eq!(status["engine"], "trex");
        assert_eq!(status["platform"], std::env::consts::OS);
        if !crate::a11y::available() {
            assert_eq!(status["available"], false);
            assert_eq!(status["reason"], "unsupportedPlatform");
        }
        assert_eq!(status["available"], status["reason"].is_null(), "available exactly when there is no reason");
        assert!(serve("observe", false).is_err(), "only plan or full");
    }
}
