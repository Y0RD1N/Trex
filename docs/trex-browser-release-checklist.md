# Trex Browser: manual check before each release

The automated suites (`tests/browser.integration.test.mjs`,
`tests/shell.integration.test.mjs`) drive the browser through CDP. CDP input
never goes through the operating system, so they cannot catch:

- a drag region swallowing every click;
- overlay views that never paint;
- keyboard focus going to the wrong view;
- native menus and dialogs.

Run this list with a real mouse and keyboard, on every operating system you
ship (Wayland and X11 on Linux). It takes about 10 minutes.

Launch the packaged build, not the development one:
`trex-browser-runtime/shell/trex-browser-shell`. On Linux, the window may open
behind the active window (focus-stealing prevention); bring it forward first.

## Window and top bar
- [ ] The window opens with the new tab page, and the top bar is visible and pinned.
- [ ] Click the central search box, type `example.com`, press Enter. The page loads and the bar hides on its own.
- [ ] Move the pointer to the top edge: the bar slides in. Move it down to the page: the bar hides.
- [ ] Drag the window from the empty space beside the tabs. A double click there maximizes and restores it.
- [ ] Minimize, maximize and close work. On macOS, check the traffic lights.
- [ ] Resize from every edge and corner.

## Tabs and navigation
- [ ] `Ctrl/⌘+T` opens a tab with the cursor already in the address field: typing goes there.
- [ ] Click a tab to switch to it. Close a tab with its ✕ and with a middle click.
- [ ] `Ctrl/⌘+W`, `Ctrl/⌘+1…9`, `Alt+←/→`, `Ctrl/⌘+R`, `F5` and `Ctrl/⌘+L` work from the page and from the bar.
- [ ] A link with `target=_blank` opens as a new tab of our own, never as a separate window.
- [ ] Close the window with several tabs open, then reopen it: the tabs are restored.

## Page tools
- [ ] `Ctrl/⌘+F`: matches are highlighted, the `n/m` counter is right, Enter and Shift+Enter move between matches, `Esc` closes.
- [ ] Zoom with `Ctrl +/-/0` and with `Ctrl` + mouse wheel. The `NN %` button appears and resets the zoom.
- [ ] Right-click on empty space, on a link, on an image, on selected text and inside an input. Each menu shows the expected items and they work.
- [ ] `F12` and the "Inspeccionar" menu item open DevTools for the page, never for our UI.
- [ ] Download a file: the download button and panel appear, with progress. "Abrir" and the folder button work, and the file is in `~/Descargas` or `~/Downloads`.
- [ ] Ask for notification and location permission. A notice appears in the bar with Bloquear and Permitir, and the decision is remembered after a reload.

- [ ] Type `192.168.1.5:3000`, `foo.test:3000` and `localhost:3000`: they open over http. Type a bare word: it searches.
- [ ] Open a page that cannot load (`http://no-existe.invalid`, a stopped local server): the error page shows the reason and "Reintentar"; reload retries the same address.
- [ ] A page without its own background (plain text, a bare HTML file) is white, not dark.
- [ ] After entering an address or picking a tab, arrows, Space and PageDown scroll the page without clicking it first.
- [ ] `Ctrl+Tab` / `Ctrl+Shift+Tab` cycle tabs; `Ctrl+Shift+T` reopens your last closed tab; `F11` toggles full screen.
- [ ] With the agents center open, `Esc` closes it, and `Ctrl+W` / `F5` do not touch the hidden page.
- [ ] Right-click inside the address field and the find field: Deshacer, Cortar, Copiar, Pegar and Seleccionar todo work.
- [ ] Open the downloads panel, press "Limpiar": the panel closes and the bar hides again.

## Agents (from a trex chat)
- [ ] The first navigation by an agent opens this browser, not Chrome or Chromium.
- [ ] While the agent acts, the frame turns orange and the dock shows the agent, the tool and the element name.
- [ ] "Pausar" in the dock stops the agent's next action with `PAUSED`. "Reanudar" continues it.
- [ ] "Tomar control" pauses the agent and brings the window to the front.
- [ ] `Ctrl/⌘+Shift+A` opens the agents center, with live thumbnails while other spaces are working. Its actions work.
- [ ] With trex in front of the browser window, the agent keeps working without timeouts.

## Before tagging
- [ ] `npm test` in `trex-browser`, plus both integration suites, pass against the packaged runtime (`TREX_BROWSER_TEST_NATIVE`).
- [ ] `doctor --json` reports `browser.channel: "trex-shell"`.
- [ ] The Electron version is up to date (see the update plan in `trex-browser/shell/README.md`).
