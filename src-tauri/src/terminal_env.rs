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
}
