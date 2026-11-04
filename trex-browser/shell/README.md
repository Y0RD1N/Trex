# Trex Browser shell

Our own browser for agent spaces: a frameless glass window in "full view" (the
page fills the window), with floating controls and an **agents center**. Built
with Electron 45 (Chromium 156) for Windows, Linux and macOS.

## How it fits the companion

The worker launches the shell exactly like it launched Chrome:
`chromium.launchPersistentContext(userData, { executablePath: <shell> })`.

- **CDP over `--remote-debugging-pipe`.** No debugging port is opened. Playwright
  and every existing `browser_*` tool keep working.
- **One window and process for the application.** Each agent owns tabs backed by its
  existing persistent `projects/<project>/BROWSERn/user-data` session. Personal tabs join this window in their own persistent session. Private scoped CDP connections
  expose only that agent's targets to Playwright, preserving independent cookies,
  storage, permissions and operation queues. Background agents keep working
  without changing the human-selected tab. Personal browser windows stay separate.
- **The native guard** verifies the shell executable and its same-binary
  descendants, the same way it does for Chrome.
- **Our UI is also WebContents.** The UI views (frame, top bar, dock, agent cursor)
  are identified by **CDP target id** (`uiTargets`), and `worker/shell.mjs` hides
  them from agents. They run in their own in-memory session (`trex-ui`), the only
  one that serves `trex://ui`. For pages, that address is a network error, so a
  page cannot reach our UI or stall automation with a blocked navigation. The
  main process recognises UI views by membership, never by URL.
- **New tabs are created by the shell.** Electron does not implement
  `Target.createTarget`. The worker asks the shell over the same CDP pipe
  (`window.trexShell.worker('newTab')`) and maps the result by target id.
- **Worker → shell:** `setAgent` (live state of this space) and `setSpaces` (all
  spaces of the project, with thumbnails while the center is open).
  **Shell → worker:** human controls (`pause`, `resume`, `takeover`, `focus`) and
  center open/close, delivered through a Playwright binding. Human controls reuse
  the explicit pause semantics: the agent's next page action gets `PAUSED`.

Native views retain their bounds, visibility and parent while agent status changes.
New background tabs are inserted below the foreground, and view ordering changes
in place only when the selected tab or agents center changes. Overlay updates
patch existing controls so focus, pressed buttons and CSS animations survive.

## UI

| Piece | View | Notes |
|---|---|---|
| Glass frame + agents center | full-window `WebContentsView` (`ui/index.html`) | Tinted orange while an agent acts, amber while paused |
| Top bar: tabs + toolbar | full-width overlay at the top (`overlay.html?part=island`) | Hidden in full view: a transparent 12 px strip along the top edge reveals it on hover, and it hides again when the pointer leaves. It stays pinned while typing an address and on the new tab page; `Ctrl+L` / `Ctrl+T` reveal it focused. Horizontal tabs (middle click closes), `+`, and window controls; empty tab-row space drags the window and a double click maximizes. |
| Activity dock | overlay (`part=dock`) | Visible only while the agent is working or paused; Pause / Take control |

Overlays are separate views because pages are native layers that HTML cannot
draw over. Their CSS `backdrop-filter` therefore cannot blur the page below, so
overlays use a dense tinted glass. The agents center uses a blurred capture of
the page as its backdrop.

**Desktop blur:** real behind-window blur exists on macOS (`vibrancy`) and
Windows 11 (`backgroundMaterial: 'acrylic'`). On Linux the window is translucent
but the desktop behind it is not blurred.

**Shortcuts:**

| Shortcut | Action |
|---|---|
| `Ctrl/⌘+Shift+A` | Agents center |
| `Ctrl/⌘+T` | New tab |
| `Ctrl/⌘+W` | Close tab |
| `Ctrl/⌘+L` | Show the top bar and focus the address |
| `Ctrl/⌘+R`, `F5` | Reload |
| `Alt+←` / `Alt+→` | Back / forward |
| `Ctrl/⌘+1..9` | Select tab |

## Development

```sh
cd trex-browser/shell
npm install            # the repo uses npm lockfiles (bypass a pnpm alias with `command npm`)
npx electron --version # downloads the Electron binary
npm run link-dev       # resources/app -> this folder, and tightens dist permissions for the guard
npm run spike          # Playwright-over-pipe checks against the shell
npm run capture        # renders the UI states to PNG (TREX_SHELL_DEV composition)
node spike/e2e-worker.mjs /tmp/out   # real BrowserService, two spaces, agents center
node spike/token-audit.mjs           # tokens each tool result costs an agent
```

With `TREX_BROWSER_DEV=1`, the worker prefers this development binary.
`TREX_BROWSER_ENGINE=chrome` forces the installed Chrome/Chromium.

Headless runs (`TREX_BROWSER_HEADLESS=1`, used by the integration tests) keep the
window hidden and, on Linux, use XWayland. Electron parents JS dialogs to the
window, and a hidden Wayland surface cannot be exported as a parent.

## Distribution

`packageShell()` in `scripts/browser-build-common.mjs` puts the pinned Electron
in `trex-browser-runtime/shell`, with our app as real files in
`resources/app`. It keeps only the `en-US`, `es` and `es-419` UI locales.

| OS | Layout | Status |
|---|---|---|
| Linux (RPM, tar.xz) | `shell/trex-browser-shell`. Modes are tightened for the guard | Built and verified by `build-trex-browser-linux.mjs`; installed and used from trex |
| Windows (NSIS) | `shell/trex-browser-shell.exe`. The installer copies `trex-browser-runtime` recursively | Wired into `build-trex-browser.mjs`. **Not yet built or run on Windows** |
| macOS | `shell/Trex Browser.app` (Electron's bundle, renamed and with bundle id `com.trex.browser`). The executable stays `Contents/MacOS/Electron`, because helpers are found by name | Function implemented. **No macOS build script, signing or notarization yet; untested** |

Signing:
- **Windows:** sign `trex-browser-shell.exe` with the same Authenticode certificate as `trex-browser.exe`.
- **macOS:** sign the `.app` with Developer ID, hardened runtime and the V8 JIT entitlements (`com.apple.security.cs.allow-jit`, `allow-unsigned-executable-memory`), then notarize with `notarytool` and staple the ticket.

The Electron binary is already stripped. Most of the size is Chromium (about
224 MB uncompressed); the RPM uses zstd.

## Keeping Electron up to date

Electron publishes Chromium security fixes in patch releases every week or two,
and a new major every 8 weeks. Only the latest three majors are supported.

1. **Monthly, or as soon as a Chromium security advisory appears:** bump the exact
   `electron` version in `shell/package.json` to the latest patch of the
   supported major, then run `npm install` and `npm run link-dev`.
2. **Every major:** read the breaking changes, especially `WebContentsView`,
   `BaseWindow`, `--remote-debugging-pipe` and protocol handlers.
3. **Verify:**
   - `npm run spike`;
   - `node spike/ui-isolation.mjs`;
   - `tests/shell.integration.test.mjs`;
   - the full `tests/browser.integration.test.mjs`;
   - the manual checklist in `docs/trex-browser-release-checklist.md`.
4. **Rebuild** the runtime per OS and ship it with the next trex release.
   `doctor --json` must report `browser.channel: "trex-shell"`.

Playwright and Electron share Chromium's CDP. When Playwright is bumped,
re-run the same checks.

## Pending

- Windows and macOS builds on real machines, plus signing and notarization.
- MCP over HTTP (see `docs/trex-browser-control.md`).
