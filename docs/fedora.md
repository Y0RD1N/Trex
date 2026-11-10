# Fedora

Trex, Trex CLI and the standalone Trex Browser have native Linux launchers.

Trex CLI desktop control on Wayland uses XDG ScreenCast/RemoteDesktop portals.
GNOME requires `xdg-desktop-portal` and `xdg-desktop-portal-gnome`; KDE uses its
matching portal backend. Install `pipewire-gstreamer`, `gstreamer1-plugins-base`
and `gstreamer1-plugins-good` for capture. The system dialog grants the selected
screens and input devices; grants are never silently restored. Run
`trex-agent desktop-doctor --json` to check the portal and GStreamer plugins
without opening a consent dialog. Input cannot bypass the compositor's consent.

Native background terminals use Unix PTYs and process groups. The Windows
PowerShell encoding adapter is not used on Linux. File/privacy rules, context
compaction, API limits, MCP, checkpoints and noninteractive exec share the same
engine on both platforms. See [Trex CLI configuration](../trex-cli/README.md#api-agent-configuration-and-limits).
The Fedora package is an x86-64 RPM. Building on ARM64 is supported by the
component builder but has not been runtime-tested on an ARM64 device.

## Install

```sh
sudo dnf install ./trex-*.rpm chromium gnome-keyring
trex
```

The RPM installs fixed sibling executables `/usr/bin/trex`,
`/usr/bin/trex-agent` and `/usr/bin/trex-browser`. The Browser's private runtime
is `/usr/lib/trex/trex-browser-runtime`; it contains pinned Node 24.22.1,
Playwright 1.64.1 and its pinned ffmpeg. Neither Node nor npm is required at
runtime. Models and browser automation remain opt-in in Trex.

Chromium, Google Chrome or Microsoft Edge must be installed separately.
Fedora's native Chromium executable is detected without using a shell wrapper
or searching PATH. Browser windows are visible by default. `DISPLAY` or
`WAYLAND_DISPLAY`, XDG runtime and the desktop D-Bus session are forwarded
through the sanitized launcher environment. Headless operation is explicit
(`TREX_BROWSER_HEADLESS=1`). Chromium's sandbox remains enabled.

If WebKit shows a blank/stale window or graphics errors on a particular driver,
try `WEBKIT_DISABLE_DMABUF_RENDERER=1 trex` for that launch. This follows
[Tauri's Linux graphics guidance](https://v2.tauri.app/develop/debug/linux-graphics/).
It is a troubleshooting override, not an unconditional application setting;
working graphics drivers keep their accelerated path. The native Wayland app
smoke test in the GPU-less container used this override and software rendering;
an earlier default-renderer automation click timed out. Native Chromium's
Wayland mouse/capture tests passed independently.

Playwright does not list Fedora among its officially supported distributions.
This repository therefore tests the actual Fedora Chromium and private runtime;
it does not describe Fedora as an upstream Playwright support guarantee.

## Credentials and private state

API keys use the desktop's Secret Service (for example GNOME Keyring). An
unlocked session keyring is required to save or read keys; Trex never falls
back to a plaintext credential file. A headless SSH session needs its own
unlocked Secret Service session. Do not work around a missing keyring by
putting keys in shell arguments or configuration files.

CLI profiles use `$XDG_DATA_HOME/trex-agent` (normally
`~/.local/share/trex-agent`). `TREX_HOME` can select a different private profile
directory. Existing directories with shared permissions are rejected without
rewriting them. Browser state uses `$XDG_STATE_HOME/trex-browser` (normally
`~/.local/state/trex-browser`), or an absolute `TREX_BROWSER_HOME`. Its root
must be owned by the current user and have mode 0700. Broker tokens, receipts,
screenshots and recordings stay in that private state tree.

The Linux launcher rejects symlinked or shared-writable runtime paths,
validates uploads through held directory/file descriptors and supervises each
owned Chromium process with pidfds. The broker has its own process session:
stopping an agent's MCP process group leaves the browser available. Stopping
or crashing that broker cleans up its owned browser roots. It never kills
Chromium by executable name.

## Standalone Browser

Build the archive on Linux:

```sh
npm ci
npm run browser:installer
```

Extract `TrexBrowser_0.3.0_linux_x64.tar.xz` into an ordinary, user-owned
`$XDG_DATA_HOME/trex-browser` directory (normally
`~/.local/share/trex-browser`). Keep `trex-browser` and
`trex-browser-runtime/` together and preserve executable modes. Trex and its
CLI discover that fixed per-user location after checking their own sibling.
No global PATH or Claude/Codex configuration changes are required.

```sh
~/.local/share/trex-browser/trex-browser doctor --json
~/.local/share/trex-browser/trex-browser prepare --json
```

Doctor never launches a browser. Prepare starts only the authenticated broker;
the first `browser_navigate` opens the project's dedicated visible window.

## Build and verify

```sh
sudo dnf install rust cargo gcc gcc-c++ make cmake pkgconf-pkg-config openssl-devel \
  webkit2gtk4.1-devel gtk3-devel librsvg2-devel libappindicator-gtk3-devel \
  libxdo-devel dbus-devel rpm-build patchelf file tar xz unzip
npm ci
npm test
cargo test --locked --manifest-path trex-cli/Cargo.toml
cargo test --locked --manifest-path trex-browser/Cargo.toml
npm run cli:build -- --debug
cargo test --locked --manifest-path src-tauri/Cargo.toml --lib
npm run tauri -- build --bundles rpm
```

The build requires Node 22.12+ or 24+ and downloads the verified private Node
archive and locked Playwright packages. Build from a normal private directory,
not a symlink or a group/world-writable shared workspace. The Linux runtime
builder rejects mirror/TLS injection and checks the ELF architecture, ffmpeg,
doctor and a real MCP initialize/tools handshake before publishing its payload.

Actual browser integration can run against the production launcher:

```sh
export TREX_BROWSER_TEST_NATIVE="$PWD/src-tauri/installer/payload/browser-linux/trex-browser"
export TREX_BROWSER_TEST_NODE="$PWD/src-tauri/installer/payload/browser-linux/trex-browser-runtime/node"
export PLAYWRIGHT_BROWSERS_PATH="$PWD/src-tauri/installer/payload/browser-linux/trex-browser-runtime/ffmpeg"
"$TREX_BROWSER_TEST_NODE" --test --test-concurrency=1 \
  trex-browser/tests/browser.integration.test.mjs \
  trex-browser/tests/linux-lifecycle.test.mjs
```

These use isolated profiles and loopback fixtures, including actual captures,
video, diagnostics, permissions, cancellation, recovery and native process
supervision. They never use personal browser profiles or paid model APIs.
Fedora CI also compiles the RPM and tests all three native crates. Visible Chromium was also checked with a native Wayland/Weston compositor.
GNOME desktop integration, notifications, hardware acceleration and SELinux
policy still need testing on a full Fedora desktop; a container with virtual
X11/Wayland displays does not establish those results.
