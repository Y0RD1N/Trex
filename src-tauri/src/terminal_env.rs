use portable_pty::CommandBuilder;

/// Cada PTY representa xterm con color completo, aunque TREX arranque desde
/// una herramienta que desactive colores o use una terminal sin capacidades.
pub(crate) fn configure_terminal_colors(command: &mut CommandBuilder) {
    command.env_remove("NO_COLOR");
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
    command.env("TERM_PROGRAM", "trex");
    // FORCE_COLOR=1 limita supports-color (usado por Codex) a 16 colores:
    // Codex descarta entonces los estilos RGB en vez de convertirlos a ANSI.
    command.env("FORCE_COLOR", "3");
    command.env("CLICOLOR", "1");
    command.env("CLICOLOR_FORCE", "1");
}

/// También cubre aliases, cuentas y Claude iniciado manualmente desde el shell.
/// Solo afecta al proceso de esta terminal; no cambia settings.json del usuario.
pub(crate) fn configure_claude_display(command: &mut CommandBuilder) {
    command.env("CLAUDE_CODE_NO_FLICKER", "1");
    // Esta variable tiene prioridad sobre NO_FLICKER y la opción tui de Claude.
    command.env("CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN", "0");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsStr;

    #[test]
    fn terminal_capabilities_replace_an_inherited_plain_output_environment() {
        let mut command = CommandBuilder::new("shell");
        command.env("NO_COLOR", "1");
        command.env("TERM", "dumb");
        command.env("FORCE_COLOR", "1");
        command.env("CLICOLOR", "0");
        command.env("CLICOLOR_FORCE", "0");
        command.env("CODEX_HOME", "account-folder");
        configure_terminal_colors(&mut command);
        assert_eq!(command.get_env("NO_COLOR"), None);
        for (key, value) in [
            ("TERM", "xterm-256color"), ("COLORTERM", "truecolor"),
            ("TERM_PROGRAM", "trex"), ("FORCE_COLOR", "3"),
            ("CLICOLOR", "1"), ("CLICOLOR_FORCE", "1"),
            ("CODEX_HOME", "account-folder"),
        ] {
            assert_eq!(command.get_env(key), Some(OsStr::new(value)), "{key}");
        }
    }

    #[test]
    fn explicit_session_overrides_can_still_disable_color() {
        let mut command = CommandBuilder::new("shell");
        configure_terminal_colors(&mut command);
        // Los overrides de SpawnRequest se aplican después de los defaults.
        command.env("NO_COLOR", "1");
        command.env("FORCE_COLOR", "0");
        assert_eq!(command.get_env("NO_COLOR"), Some(OsStr::new("1")));
        assert_eq!(command.get_env("FORCE_COLOR"), Some(OsStr::new("0")));
    }

    #[test]
    fn claude_uses_fullscreen_even_when_the_parent_disabled_it() {
        let mut command = CommandBuilder::new("shell");
        command.env("CLAUDE_CODE_NO_FLICKER", "0");
        command.env("CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN", "1");
        command.env("CLAUDE_CONFIG_DIR", "account-folder");
        configure_claude_display(&mut command);
        assert_eq!(command.get_env("CLAUDE_CODE_NO_FLICKER"), Some(OsStr::new("1")));
        assert_eq!(command.get_env("CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN"), Some(OsStr::new("0")));
        assert_eq!(command.get_env("CLAUDE_CONFIG_DIR"), Some(OsStr::new("account-folder")));
    }
}
