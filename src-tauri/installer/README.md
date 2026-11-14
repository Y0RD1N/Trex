# Optional Trex CLI and Browser installers

Windows bundles use NSIS. The base application has the version in `tauri.conf.json` (`0.6.0`) and
identifier `com.trex.app`; the Windows configuration adds resources and installer
customization for independently optional CLI and Browser components. Claude Code
and Codex work without the CLI component.

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
mode variables, insert the options page after the directory page, and initialize
the choice before maintenance. Keep it aligned when upgrading the CLI. Tauri
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

The same options page independently offers Trex Browser. Its `InstallBrowser`
DWORD lives beside `InstallCli`, defaults to off for a fresh install, and is
preserved by silent/passive maintenance. `/TREXBROWSER=1` and
`/TREXBROWSER=0` override only Browser; other values exit with code 2. Click
handlers retain both choices when navigating back. The Browser hook is
self-contained in `trex-cli.nsh` so existing CLI verification can keep copying
that hook alone; `trex-browser.nsh` exposes the Browser functions without the CLI
page for the standalone installer.

The app bundle supplies `trex-browser.payload` and
`trex-browser-runtime.payload/**` as inert resources. The selected hook promotes
them to sibling `trex-browser.exe` and `trex-browser-runtime/**`; an unselected
install removes the inert resources. The runtime must contain `node.exe`,
`worker.mjs`, `package.json`, `package-lock.json`, `node_modules/`, and `ffmpeg/`.
Additional runtime files, including its build manifest, travel with that tree.
The hooks validate existing files and all directory ancestors before extraction
or removal, rejecting locks, file/directory collisions, read-only files and
reparse points. Promotion uses `.previous` backups and reverses completed
renames if promotion fails. Existing `.previous` paths require recovery before
retrying. The installer never stops Browser processes or launches the payload.
Only those program assets and their inert resources are removed; Browser
profiles, artifacts, API keys and credentials are outside these paths.

`browser-installer.nsi` creates a separate per-user installer with no elevation,
PATH changes or `launcher.env`. Invoke `makensis.exe` with these definitions:

```powershell
makensis.exe "/DTREX_BROWSER_PAYLOAD_DIR=D:\staging\browser" `
  "/DTREX_BROWSER_OUTFILE=D:\output\trex-browser-setup.exe" `
  /DTREX_BROWSER_VERSION=0.6.0 src-tauri/installer/browser-installer.nsi
```

The payload directory must contain the actual `trex-browser.exe` and complete
`trex-browser-runtime/` tree. Both path definitions are required; version defaults
to `0.6.0`. Missing payload inputs fail compilation; the template contains no
placeholder payload or download step. The default installation directory is
`$LOCALAPPDATA\Programs\Trex Browser`; NSIS `/D=` chooses another absolute path.
The installer writes 64-bit HKCU
`Software\com.trex.browser\Install`, REG_SZ `InstallDir`, only after successful
promotion. The independent uninstall key is
`Software\Microsoft\Windows\CurrentVersion\Uninstall\com.trex.browser`, and
the uninstaller is `uninstall-trex-browser.exe`. Uninstall removes registration
only when its stored location still matches that installation, and preserves
unrelated registry values. An optional app sibling never writes this discovery
registration.

Run `pwsh -File scripts/test-trex-browser-installer.ps1` for independent synthetic
NSIS verification. It compiles copied hooks and the standalone template against
marker-only payloads, uses GUID-specific identities/registry keys and a private
current-user-only temporary directory, and redirects known folders plus process
environment. It exercises independent choices, updates, locks, collisions,
reparse points, removal, registration ownership, and user-data sentinels. It
never runs a production installer, Tauri build, GUI, Browser payload or real
credential store. The existing lifecycle verification harness is unchanged.

`npm run browser:build` builds the locked native launcher and assembles the real
private runtime. `npm run browser:installer` also creates the standalone setup in
`src-tauri/installer/output/`. These build commands require the development
toolchain; an installed user needs neither Node nor npm. The builder downloads
official Node **24.22.1** over verified TLS, checks its pinned SHA256 against the
[official release manifest](https://nodejs.org/dist/v24.22.1/SHASUMS256.txt),
runs `npm ci --ignore-scripts` against the exact
Playwright **1.64.1** lock, and downloads Playwright's pinned ffmpeg runtime and
Windows dependency helper, without downloading a browser.
It verifies the real Node/ffmpeg executable versions and the assembled native
doctor before replacing a prior payload. The probe uses isolated app-data and
private-home paths, and never starts a browser or broker. No incomplete or fake
production payload is generated when core sources are missing.

`trex-browser-runtime/runtime-manifest.json` records every assembled asset hash
before code signing. Resource sources retain `.exe`/`.dll` extensions, including
Node and ffmpeg. Tauri 2.12.0 checks the source resource extension and signature
before renaming its destination ([upstream implementation](https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.12.0/crates/tauri-bundler/src/bundle/windows/nsis/mod.rs#L765-L781)):
configured signing therefore covers unsigned
executables while preserving already valid vendor signatures. The launcher is
inert as `trex-browser.payload`, and the runtime directory is inert as
`trex-browser-runtime.payload/` until selection. Signing changes executable
hashes, so the build manifest identifies its hashes as `before-code-signing`.
The standalone build currently produces an unsigned setup unless separately
signed by the release pipeline.

The native app bridge resolves the installed sibling first, then the 64-bit
HKCU standalone registration above. It never searches PATH. Debug builds alone
also accept this checkout's `trex-browser/target/debug/` layout; build that layout
with `npm run browser:build -- --debug`. Requests use bounded JSON stdin, drained
bounded stdout, discarded stderr and timeouts. `doctor` is a machine probe,
never a browser/model launch. Artifact opening accepts only a service-validated
artifact ID and only opens generated PNG, JPEG or WebM files.
