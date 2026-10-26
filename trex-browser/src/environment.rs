use anyhow::{Context, Result};
use std::collections::BTreeMap;
use std::ffi::{OsStr, OsString};
use std::path::Path;

pub type ChildEnvironment = BTreeMap<OsString, OsString>;

// Exact names only: in particular, no TREX_*, NODE_*, ELECTRON_* or provider
// prefix is inherited. The native verification marker is always overwritten.
const INHERITED: &[&str] = &[
    "APPDATA",
    "LOCALAPPDATA",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "TEMP",
    "TMP",
    "USERNAME",
    "USERDOMAIN",
    "COMPUTERNAME",
    "NUMBER_OF_PROCESSORS",
    "PROCESSOR_ARCHITECTURE",
    "OS",
    "PROGRAMFILES",
    "PROGRAMFILES(X86)",
    "PROGRAMW6432",
    "COMMONPROGRAMFILES",
    "COMMONPROGRAMFILES(X86)",
    "COMMONPROGRAMW6432",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TZ",
    "TERM",
    "COLORTERM",
    "NO_COLOR",
    "FORCE_COLOR",
    "PLAYWRIGHT_BROWSERS_PATH",
    "TREX_BROWSER_HEADLESS",
];

fn allowed(name: &OsStr) -> bool {
    name.to_str().is_some_and(|name| {
        INHERITED
            .iter()
            .any(|allowed| name.eq_ignore_ascii_case(allowed))
    })
}

#[cfg(windows)]
pub fn child_environment(
    runtime: &crate::runtime::Runtime,
    home: Option<&Path>,
) -> Result<ChildEnvironment> {
    let windows = crate::security::windows_directory()?;
    let launcher =
        std::env::current_exe().context("could not locate the native broker launcher")?;
    build(
        INHERITED
            .iter()
            .filter_map(|&name| std::env::var_os(name).map(|value| (OsString::from(name), value))),
        &runtime.node,
        home,
        &windows,
        &launcher,
        runtime.development,
        runtime
            .worker
            .parent()
            .context("the worker has no runtime directory")?,
    )
}

fn build(
    inherited: impl IntoIterator<Item = (OsString, OsString)>,
    node: &Path,
    home: Option<&Path>,
    windows: &Path,
    launcher: &Path,
    development: bool,
    runtime_directory: &Path,
) -> Result<ChildEnvironment> {
    let mut values = ChildEnvironment::new();
    for (name, value) in inherited {
        if allowed(&name) {
            // Canonical keys avoid duplicate case variants on Windows.
            values.insert(
                OsString::from(name.to_string_lossy().to_ascii_uppercase()),
                value,
            );
        }
    }
    let node_dir = node
        .parent()
        .context("the Node runtime has no parent directory")?;
    // No inherited PATH, current directory, shell extensions or user executables.
    let search_path = std::env::join_paths([node_dir, &windows.join("System32"), windows])
        .context("could not construct the runtime search path")?;
    values.insert("PATH".into(), search_path);
    values.insert("PATHEXT".into(), ".COM;.EXE".into());
    values.insert("SYSTEMROOT".into(), windows.as_os_str().to_owned());
    values.insert("WINDIR".into(), windows.as_os_str().to_owned());
    values.insert(
        "COMSPEC".into(),
        windows.join("System32/cmd.exe").into_os_string(),
    );
    if let Some(home) = home {
        values.insert("TREX_BROWSER_HOME".into(), home.as_os_str().to_owned());
        values.insert("TREX_BROWSER_NATIVE_VERIFIED".into(), "1".into());
    }
    values.insert(
        "TREX_BROWSER_LAUNCHER".into(),
        launcher.as_os_str().to_owned(),
    );
    // The daemon helper must use this same resolved runtime even when the
    // caller chose a directory elsewhere. Never forward the unchecked input.
    values.insert(
        "TREX_BROWSER_RUNTIME".into(),
        runtime_directory.as_os_str().to_owned(),
    );
    if !development || !values.contains_key(OsStr::new("PLAYWRIGHT_BROWSERS_PATH")) {
        values.insert(
            "PLAYWRIGHT_BROWSERS_PATH".into(),
            node_dir.join("ffmpeg").into_os_string(),
        );
    }
    Ok(values)
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn environment_is_an_exact_allowlist() {
        let values = build(
            [
                ("SystemRoot", "untrusted"),
                ("Path", "untrusted"),
                ("NODE_OPTIONS", "--import=untrusted"),
                ("node_path", "untrusted"),
                ("ELECTRON_RUN_AS_NODE", "1"),
                ("OPENAI_API_KEY", "secret"),
                ("ANTHROPIC_API_KEY", "secret"),
                ("TREX_BROWSER_API_KEY", "secret"),
                ("TREX_BROWSER_NATIVE_VERIFIED", "forged"),
                ("TREX_BROWSER_RUNTIME", "untrusted"),
                ("PLAYWRIGHT_BROWSERS_PATH", "browser-cache"),
                ("temp", "temp-directory"),
            ]
            .map(|(key, value)| (key.into(), value.into())),
            Path::new("C:/runtime/node.exe"),
            Some(Path::new("C:/private/home")),
            Path::new("C:/Windows"),
            Path::new("C:/trex-browser.exe"),
            false,
            Path::new("C:/runtime"),
        )
        .unwrap();
        assert_eq!(
            values
                .get(OsStr::new("TREX_BROWSER_NATIVE_VERIFIED"))
                .unwrap(),
            "1"
        );
        assert_eq!(values.get(OsStr::new("TEMP")).unwrap(), "temp-directory");
        assert_eq!(
            values.get(OsStr::new("PLAYWRIGHT_BROWSERS_PATH")).unwrap(),
            Path::new("C:/runtime").join("ffmpeg").as_os_str()
        );
        assert!(!values
            .values()
            .any(|value| value == "secret" || value == "untrusted"));
        for blocked in ["NODE_OPTIONS", "node_path", "ELECTRON_RUN_AS_NODE"] {
            assert!(!values.contains_key(OsStr::new(blocked)));
        }
        assert_eq!(
            values.get(OsStr::new("TREX_BROWSER_RUNTIME")).unwrap(),
            "C:/runtime"
        );
    }

    #[test]
    fn read_only_commands_receive_no_unverified_home_or_marker() {
        let values = build(
            [
                ("TREX_BROWSER_HOME".into(), "unverified".into()),
                ("TREX_BROWSER_NATIVE_VERIFIED".into(), "1".into()),
            ],
            Path::new("C:/runtime/node.exe"),
            None,
            Path::new("C:/Windows"),
            Path::new("C:/trex-browser.exe"),
            false,
            Path::new("C:/runtime"),
        )
        .unwrap();
        assert!(!values.contains_key(OsStr::new("TREX_BROWSER_HOME")));
        assert!(!values.contains_key(OsStr::new("TREX_BROWSER_NATIVE_VERIFIED")));
        assert_eq!(
            values.get(OsStr::new("TREX_BROWSER_LAUNCHER")).unwrap(),
            "C:/trex-browser.exe"
        );
    }
}
