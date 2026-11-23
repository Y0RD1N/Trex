#!/bin/bash
# Compila e instala la app de iPhone desde WSL con xtool.
#
# El código vive en Windows (trex/ios), pero SwiftPM no puede compilar sobre /mnt/…:
# la caché de módulos de clang falla en NTFS («module X is defined in both …»). Por eso
# se copia a ~/proyectos/trex-ios (sistema de archivos de Linux) y xtool trabaja allí.
#
# Uso (dentro de Ubuntu):
#   bash /mnt/d/projects/trex/ios/scripts/dev.sh            # compila, firma e instala en el iPhone
#   bash /mnt/d/projects/trex/ios/scripts/dev.sh dev build  # solo compila
#   bash /mnt/d/projects/trex/ios/scripts/dev.sh test       # pruebas del núcleo en Linux
set -euo pipefail

SRC="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${TREX_IOS_BUILD_DIR:-$HOME/proyectos/trex-ios}"

mkdir -p "$DEST"
rsync -a --delete \
  --exclude .build --exclude xtool --exclude .bsp --exclude .swiftpm --exclude .sourcekit-lsp \
  "$SRC/" "$DEST/"
cd "$DEST"

if [ "${1:-}" = "test" ]; then
  exec env TREX_CORE_ONLY=1 swift test --scratch-path "$DEST/.build/core-tests"
fi

if [ "$#" -eq 0 ]; then set -- dev; fi

# Instalar necesita hablar con el iPhone: si no responde, se dice por qué antes de compilar.
if [ "$1" = "dev" ] && [ "${2:-}" != "build" ] && command -v ideviceinfo >/dev/null; then
  if ! timeout 15 ideviceinfo -k DeviceName >/dev/null 2>&1; then
    cat >&2 <<EOF
El iPhone no responde por USB. Comprueba:
  1. Que no haya una VPN que bloquee el tráfico fuera del túnel (kill-switch).
  2. Que usbipd lo tenga conectado a WSL (usbipd attach --wsl --busid <id> --auto-attach).
  3. Si sigue igual, recupera la conexión colgada:
       sudo bash $SRC/scripts/reset-usb.sh
EOF
    exit 1
  fi
fi

exec xtool "$@"
