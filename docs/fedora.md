# Fedora

Trex and Trex CLI have native Linux launchers.

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
sudo dnf install ./trex-*.rpm gnome-keyring
trex
```

The RPM installs fixed sibling executables `/usr/bin/trex` and
`/usr/bin/trex-agent`. Models remain opt-in in Trex.

«Tu navegador» (the browser extension) needs Chrome, Chromium, Brave or Edge,
installed separately, for example `sudo dnf install chromium`. See
[extension/README.md](../extension/README.md).

Trex Browser is retired. Upgrading from a version that had it removes its
launcher and runtime; its private profiles (`~/.local/state/trex-browser`) stay
until you delete them from Trex's settings.

If WebKit shows a blank/stale window or graphics errors on a particular driver,
try `WEBKIT_DISABLE_DMABUF_RENDERER=1 trex` for that launch. This follows
[Tauri's Linux graphics guidance](https://v2.tauri.app/develop/debug/linux-graphics/).
It is a troubleshooting override, not an unconditional application setting;
working graphics drivers keep their accelerated path. The native Wayland app
smoke test in the GPU-less container used this override and software rendering;
an earlier default-renderer automation click timed out.

## Credentials and private state

API keys use the desktop's Secret Service (for example GNOME Keyring). An
unlocked session keyring is required to save or read keys; Trex never falls
back to a plaintext credential file. A headless SSH session needs its own
unlocked Secret Service session. Do not work around a missing keyring by
putting keys in shell arguments or configuration files.

CLI profiles use `$XDG_DATA_HOME/trex-agent` (normally
`~/.local/share/trex-agent`). `TREX_HOME` can select a different private profile
directory. Existing directories with shared permissions are rejected without
rewriting them.

## Build and verify

```sh
sudo dnf install rust cargo gcc gcc-c++ make cmake pkgconf-pkg-config openssl-devel \
  webkit2gtk4.1-devel gtk3-devel librsvg2-devel libappindicator-gtk3-devel \
  libxdo-devel dbus-devel rpm-build patchelf file tar xz unzip
npm ci
npm test
cargo test --locked --manifest-path trex-cli/Cargo.toml
npm run cli:build -- --debug
cargo test --locked --manifest-path src-tauri/Cargo.toml --lib
npm run tauri -- build --bundles rpm
```

The build requires Node 22.12+ or 24+. Fedora CI also compiles the RPM and
tests both native crates. GNOME desktop integration, notifications, hardware
acceleration and SELinux policy still need testing on a full Fedora desktop; a
container with virtual X11/Wayland displays does not establish those results.
