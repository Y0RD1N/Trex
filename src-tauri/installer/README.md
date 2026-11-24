# Optional Trex CLI installer

Windows bundles use NSIS. The base application has the version in `tauri.conf.json` (`0.11.0`) and
identifier `com.trex.app`; the Windows configuration adds the CLI resource and installer
customization for the optional CLI component. Claude Code and Codex work without the
CLI component.

`npm run tauri build` builds the standalone `trex-cli` crate with Cargo before
compiling the app, and refreshes it again before bundling. `npm run cli:build`
can prepare the resource before running Cargo directly; `npm run cli:build --
--debug` builds the development CLI. The build script honors Tauri's target
triple and debug environment. The resource source keeps its `.exe` extension
so configured Tauri signing also applies to it, but the installed resource name
is `trex-agent.payload`. Only the selected installer hook copies it to the
application's sibling `trex-agent.exe`; the payload is then deleted in either
case. The installer never launches this executable.

The checkbox defaults to off. `HKCU\Software\com.trex.app\Installer`, DWORD
`InstallCli`, remembers an explicit choice. Silent and passive installs preserve
it; a missing preference means off. Unattended deployment can explicitly pass
`/TREXCLI=1` or `/TREXCLI=0`. Other values fail with exit code 2. Unchecking on
maintenance removes the executable. Updating/uninstalling removes only CLI
executables and staging payloads, preserving the CLI preference, profiles and
credentials. No PATH or shell configuration is modified. The application uses
the absolute sibling path; shell users can invoke that path directly.

The custom `installer.nsi` is vendored from the official
[Tauri CLI 2.12.0 template](https://github.com/tauri-apps/tauri/blob/447fa9f3f993fe77724189e355078b38ce20baea/crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi)
under the included MIT license. Local changes move the hooks include below the
mode variables, insert the options page after the directory page, initialize
the choice before maintenance, and stop the retired Trex Browser before an
older uninstaller runs (see below). Keep it aligned when upgrading the CLI. Tauri
documents [custom templates and hooks](https://v2.tauri.app/distribute/windows-installer/#customizing-the-nsis-installer).

After building a Windows installer, run
`pwsh -File scripts/test-trex-installer.ps1` with PowerShell 7+. The script compiles the complete
generated NSIS installer with unique product, binary, bundle and registry
identities in a GUID-specific temporary tree. The test copy disables WebView and
application launch callbacks. That synthetic tree is private to the current
Windows user, so the redirected CLI home does not inherit shared storage access.
It covers fresh default-off, explicit opt-in,
silent preservation, executable refresh, locked destinations, directory
collisions, explicit opt-out, invalid options, and update uninstallation, with
profile and credential sentinels at redirected `APPDATA`/`TREX_HOME` paths,
plus existing app settings. It checks exact CLI hashes and removes only
verified test paths and keys. It never executes the production installer, app,
CLI provider, or model. Silent tests compile the checkbox code but do not test
interactive checkbox behavior.

## Retired Trex Browser

Trex Browser is no longer built or installed. Versions up to 0.11.0 could leave
`trex-browser.exe`, `trex-browser-runtime\`, their inert `.payload` resources and
`.previous` backups beside the app, `Trex Browser.lnk` in the Start menu and on
the desktop, and the `InstallBrowser` DWORD beside `InstallCli`. The hook in
`trex-cli.nsh` removes them on install, update and uninstall. It first stops only
processes whose executable is inside `$INSTDIR\trex-browser-runtime\` or is
`$INSTDIR\trex-browser.exe`, checking the image path with the same handle that
terminates the process; never by name. Shortcuts are deleted only when they point
inside `$INSTDIR`, so a standalone installation keeps its own. A path that is a
reparse point, or a tree that contains one, is left alone. A locked file stays in
place with a warning in the details log; cleanup never aborts the installation.
An old `/TREXBROWSER=` option is ignored. Before the maintenance page runs an
older uninstaller, the template stops those processes as well, because the 0.11.0
uninstaller refuses to continue while its files are in use.

The Browser's private data (profiles with signed-in sessions, artifacts and broker
state in `%LOCALAPPDATA%\TrexBrowser`) lives outside `$INSTDIR` and the installer
never removes it. The app offers to delete it together with any leftovers beside
`trex.exe` (`src-tauri/src/legacy_browser.rs`), and can open the standalone
installation's `uninstall-trex-browser.exe`, registered at HKCU
`Software\com.trex.browser\Install`.
