#!/usr/bin/env bash
# Escritorio aislado para probar el motor de accesibilidad de Linux (AT-SPI):
# X virtual (Xvfb), bus de sesión propio y bus de accesibilidad propio. Nada de lo
# que se abre aquí aparece en el escritorio de la persona ni toca sus apps.
#
#   scripts/a11y-linux-session.sh <comando> [argumentos…]
#
# Sin comando, corre las pruebas de integración del motor:
#   cargo test --manifest-path trex-cli/Cargo.toml a11y::atspi -- --ignored --test-threads=1
#
# Necesita: xorg-x11-server-Xvfb (xvfb-run), dbus-daemon, at-spi2-core, gtk3-devel
# (gtk3-widget-factory) y zenity.
set -euo pipefail

if [ "${TREX_A11Y_SESSION:-}" != 1 ]; then
  for tool in xvfb-run dbus-run-session gdbus; do
    command -v "$tool" >/dev/null || { echo "Falta $tool (instala xorg-x11-server-Xvfb, dbus-daemon y glib2)." >&2; exit 1; }
  done
  exec env TREX_A11Y_SESSION=1 xvfb-run -a -s "-screen 0 1280x900x24" dbus-run-session -- "$0" "$@"
fi

# Resultados iguales en cualquier equipo: textos en inglés y sin portales ni Wayland.
export LANG=C.UTF-8 LC_ALL=C.UTF-8 LANGUAGE=C
export GTK_USE_PORTAL=0 GDK_DEBUG=no-portals GIO_USE_VFS=local GSETTINGS_BACKEND=memory GDK_BACKEND=x11 NO_AT_BRIDGE=0 XDG_SESSION_TYPE=x11
unset WAYLAND_DISPLAY AT_SPI_BUS_ADDRESS XDG_CURRENT_DESKTOP

libexec() {
  for dir in /usr/libexec /usr/lib/at-spi2-core /usr/lib/x86_64-linux-gnu/at-spi2-core /usr/lib/at-spi2; do
    [ -x "$dir/$1" ] && { echo "$dir/$1"; return; }
  done
  echo "Falta $1 (instala at-spi2-core)." >&2
  exit 1
}

pids=()
cleanup() { [ ${#pids[@]} -eq 0 ] || kill "${pids[@]}" 2>/dev/null || true; }
trap cleanup EXIT

"$(libexec at-spi-bus-launcher)" --launch-immediately >/dev/null 2>&1 &
pids+=($!)
address=""
for _ in $(seq 100); do
  address=$(gdbus call --session --dest org.a11y.Bus --object-path /org/a11y/bus --method org.a11y.Bus.GetAddress 2>/dev/null | sed -E "s/^\('(.*)',\)$/\1/") && [ -n "$address" ] && break
  sleep 0.1
done
[ -n "$address" ] || { echo "El bus de accesibilidad no arrancó." >&2; exit 1; }

"$(libexec at-spi2-registryd)" >/dev/null 2>&1 &
pids+=($!)
for _ in $(seq 100); do
  gdbus call --address "$address" --dest org.a11y.atspi.Registry --object-path /org/a11y/atspi/accessible/root \
    --method org.freedesktop.DBus.Properties.Get org.a11y.atspi.Accessible ChildCount >/dev/null 2>&1 && break
  sleep 0.1
done

if [ $# -eq 0 ]; then
  root="$(cd "$(dirname "$0")/.." && pwd)"
  set -- cargo test --manifest-path "$root/trex-cli/Cargo.toml" a11y::atspi -- --ignored --test-threads=1
fi
"$@"
