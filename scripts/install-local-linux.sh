#!/usr/bin/env bash
# Installs a locally built trex (release) into ~/.local/share/trex, the way the
# per-user install has been updated so far:
#   - backup of the previous binaries, browser component and config.json in
#     backups/repo-<commit>-<timestamp>, plus update.json with hashes;
#   - each file is copied next to its target and renamed over it, so a running
#     trex keeps its old executable until it is restarted;
#   - app data (~/.local/share/com.trex.app) is never touched, only counted.
# Build first: npx tauri build --no-bundle
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
dest="${TREX_INSTALL_DIR:-$HOME/.local/share/trex}"
data="$HOME/.local/share/com.trex.app"
config="$HOME/.config/com.trex.app/config.json"
app="$repo/src-tauri/target/release/trex"
agent="$repo/src-tauri/installer/payload/trex-agent"
browser="$repo/src-tauri/installer/payload/browser-linux"

for f in "$app" "$agent" "$browser/trex-browser" "$browser/trex-browser-runtime/worker.mjs"; do
  [ -e "$f" ] || { echo "Falta $f: compila primero (npx tauri build --no-bundle)." >&2; exit 1; }
done
[ -d "$dest" ] || { echo "No existe la instalación en $dest" >&2; exit 1; }

commit="$(git -C "$repo" rev-parse HEAD)"
dirty=false; [ -n "$(git -C "$repo" status --porcelain)" ] && dirty=true
stamp="$(date +%Y%m%d-%H%M%S)-$(date +%N | cut -c1-6)"
suffix=""; [ "$dirty" = true ] && suffix="-dirty"
backup="$dest/backups/repo-${commit:0:7}${suffix}-$stamp"
mkdir -m 700 -p "$backup"

sha() { if [ -e "$1" ]; then sha256sum "$1" | cut -d' ' -f1; else echo null; fi; }
prev_trex=$(sha "$dest/trex"); prev_agent=$(sha "$dest/trex-agent"); prev_browser=$(sha "$dest/trex-browser")

# Backup (copies; the running app keeps working).
for f in trex trex-agent trex-browser; do if [ -e "$dest/$f" ]; then cp -a "$dest/$f" "$backup/"; fi; done
if [ -d "$dest/trex-browser-runtime" ]; then cp -a "$dest/trex-browser-runtime" "$backup/"; fi
if [ -f "$config" ]; then cp -a "$config" "$backup/config.json"; fi

# Atomic replacement of single files.
put() { install -m 755 "$1" "$dest/.$2.new" && mv -f "$dest/.$2.new" "$dest/$2"; }
put "$app" trex
put "$agent" trex-agent
# Stop the browser broker before swapping its runtime (agent browser windows
# close; profiles are kept). The old launcher still matches the old runtime.
"$dest/trex-browser" stop >/dev/null 2>&1 || true
put "$browser/trex-browser" trex-browser
rm -rf "$dest/.trex-browser-runtime.new"
cp -a "$browser/trex-browser-runtime" "$dest/.trex-browser-runtime.new"
rm -rf "$dest/.trex-browser-runtime.old"
if [ -d "$dest/trex-browser-runtime" ]; then mv "$dest/trex-browser-runtime" "$dest/.trex-browser-runtime.old"; fi
mv "$dest/.trex-browser-runtime.new" "$dest/trex-browser-runtime"
rm -rf "$dest/.trex-browser-runtime.old"
# Agents connected over MCP-HTTP do not start the broker themselves (the stdio
# adapter did): start it again now, on the same port with the same sessions.
"$dest/trex-browser" prepare --json >/dev/null

# Trex Browser as a desktop app: icon in the app grid/dock, opens the person's
# own (non-automated) window. Selectable as a web browser, never made default.
icons="$repo/trex-browser/shell/icons"
apps="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
hicolor="${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor"
for s in 16 24 32 48 64 128 256 512; do install -Dm644 "$icons/trex-browser-$s.png" "$hicolor/${s}x${s}/apps/trex-browser.png"; done
install -Dm644 "$icons/trex-browser.svg" "$hicolor/scalable/apps/trex-browser.svg"
mkdir -p "$apps"
sed "s|^Exec=.*|Exec=\"$dest/trex-browser-runtime/shell/trex-browser-shell\" %U|" "$repo/src-tauri/installer/linux/trex-browser.desktop" > "$apps/.trex-browser.desktop.new"
chmod 644 "$apps/.trex-browser.desktop.new" && mv -f "$apps/.trex-browser.desktop.new" "$apps/trex-browser.desktop"
command -v update-desktop-database >/dev/null && update-desktop-database -q "$apps" || true
command -v gtk-update-icon-cache >/dev/null && gtk-update-icon-cache -q -t "$hicolor" || true

files=0; if [ -d "$data" ]; then files=$(find "$data" -type f | wc -l); fi
cat > "$backup/update.json" <<EOF
{
  "commit": "$commit",
  "uncommittedChanges": $dirty,
  "previousAssets": { "trex": "$prev_trex", "trex-agent": "$prev_agent", "trex-browser": "$prev_browser" },
  "installedAssets": { "trex": "$(sha "$dest/trex")", "trex-agent": "$(sha "$dest/trex-agent")", "trex-browser": "$(sha "$dest/trex-browser")" },
  "browserChannel": "$("$dest/trex-browser" doctor --json | python3 -c 'import json,sys;print(json.load(sys.stdin)["browser"].get("channel"))')",
  "preservedDataFiles": $files
}
EOF
echo "Instalado. Copia de seguridad: $backup"
echo "Reinicia trex para usar la nueva versión."
