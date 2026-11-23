#!/bin/bash
# Recupera la conexión USB con el iPhone dentro de WSL (usbipd-win) cuando se quedó colgada.
#
# Pasa al activar una VPN que bloquea el tráfico fuera del túnel (o al suspender el PC):
# el enlace USB/IP entre Windows y Ubuntu muere sin cerrarse, Ubuntu cree que el iPhone
# sigue conectado y usbmuxd se queda bloqueado esperándolo (xtool: «LockdownClient.Error.muxError»).
#
# Uso (dentro de Ubuntu, con la VPN desactivada):
#   sudo bash /mnt/d/projects/trex/ios/scripts/reset-usb.sh
# Después, `usbipd attach --wsl --busid <id> --auto-attach` en Windows lo vuelve a conectar.
set -euo pipefail

VHCI=/sys/devices/platform/vhci_hcd.0
if [ "$(id -u)" -ne 0 ]; then
  echo "Ejecútalo con sudo." >&2
  exit 1
fi

if [ -r "$VHCI/status" ]; then
  # Columnas: hub port sta spd dev sockfd local_busid. Un puerto con dispositivo tiene sta 006.
  awk 'NR > 1 && $3 == "006" { print $2 + 0 }' "$VHCI/status" | while read -r port; do
    echo "Soltando el puerto USB virtual $port"
    echo "$port" > "$VHCI/detach" || true
  done
fi

systemctl reset-failed usbmuxd 2>/dev/null || true
systemctl restart usbmuxd
sleep 2
echo "usbmuxd: $(systemctl is-active usbmuxd)"
echo "Ahora vuelve a conectar el iPhone desde Windows (usbipd attach … --auto-attach) y ejecuta dev.sh."
