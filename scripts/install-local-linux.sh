#!/usr/bin/env bash
# Installs a locally built trex (release) into ~/.local/share/trex, the way the
# per-user install has been updated so far:
#   - backup of the previous binaries and config.json in
#     backups/repo-<commit>-<timestamp>, plus update.json with hashes;
#   - each file is copied next to its target and renamed over it, so a running
#     trex keeps its old executable until it is restarted;
#   - app data (~/.local/share/com.trex.app) is never touched, only counted;
#   - the retired Trex Browser launcher and runtime move into that backup and
#     its menu entry is removed; its private profiles are left for trex to
#     delete when asked (Settings).
# Build first: npx tauri build --no-bundle
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
dest="${TREX_INSTALL_DIR:-$HOME/.local/share/trex}"
data="$HOME/.local/share/com.trex.app"
config="$HOME/.config/com.trex.app/config.json"
app="$repo/src-tauri/target/release/trex"
agent="$repo/src-tauri/installer/payload/trex-agent"

for f in "$app" "$agent"; do
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
prev_trex=$(sha "$dest/trex"); prev_agent=$(sha "$dest/trex-agent")

# Backup (copies; the running app keeps working).
for f in trex trex-agent; do if [ -e "$dest/$f" ]; then cp -a "$dest/$f" "$backup/"; fi; done
if [ -f "$config" ]; then cp -a "$config" "$backup/config.json"; fi

# Atomic replacement of single files.
put() { install -m 755 "$1" "$dest/.$2.new" && mv -f "$dest/.$2.new" "$dest/$2"; }
put "$app" trex
put "$agent" trex-agent

# Trex Browser is retired: stop its broker (agent windows close), move its
# program files into the backup and remove the menu entry. Profiles in
# ~/.local/state/trex-browser stay until trex deletes them (Settings).
if [ -x "$dest/trex-browser" ] && [ ! -L "$dest/trex-browser" ]; then "$dest/trex-browser" stop >/dev/null 2>&1 || true; fi
for f in trex-browser trex-browser-runtime; do
  if [ -L "$dest/$f" ]; then rm -f "$dest/$f"; elif [ -e "$dest/$f" ]; then mv "$dest/$f" "$backup/"; fi
done
rm -rf "$dest/.trex-browser-runtime.new" "$dest/.trex-browser-runtime.old"
apps="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
hicolor="${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor"
if [ -e "$apps/trex-browser.desktop" ]; then
  rm -f "$apps/trex-browser.desktop"
  for s in 16 24 32 48 64 128 256 512; do rm -f "$hicolor/${s}x${s}/apps/trex-browser.png"; done
  rm -f "$hicolor/scalable/apps/trex-browser.svg"
  command -v update-desktop-database >/dev/null && update-desktop-database -q "$apps" || true
  command -v gtk-update-icon-cache >/dev/null && gtk-update-icon-cache -q -t "$hicolor" || true
fi

files=0; if [ -d "$data" ]; then files=$(find "$data" -type f | wc -l); fi
cat > "$backup/update.json" <<EOF
{
  "commit": "$commit",
  "uncommittedChanges": $dirty,
  "previousAssets": { "trex": "$prev_trex", "trex-agent": "$prev_agent" },
  "installedAssets": { "trex": "$(sha "$dest/trex")", "trex-agent": "$(sha "$dest/trex-agent")" },
  "preservedDataFiles": $files
}
EOF
echo "Instalado. Copia de seguridad: $backup"
echo "Reinicia trex para usar la nueva versión."
