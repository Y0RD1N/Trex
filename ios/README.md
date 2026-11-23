# trex para iPhone

App nativa (SwiftUI) del **control remoto** de trex: ves y diriges las sesiones de tu PC
desde el iPhone. Habla el mismo protocolo que la PWA (`src/remote/`) con el servidor de
`src-tauri/src/remote.rs` (`/api/pair`, `/api/ws`, `/api/upload`, `/api/icon`).

| Pantalla | Qué hace |
|---|---|
| Emparejar | Escanea el QR de *Ajustes › Control remoto* o escribe la dirección y el código. El token se guarda en el Llavero. |
| Sesiones / Esperan | Todos los proyectos (filtro propio del iPhone: todos, favoritos o una selección) con sus chats; lo que te necesita primero; permitir o rechazar sin entrar. |
| Nuevo chat | Proyecto, asistente, modelo, esfuerzo, velocidad y permisos, con un primer mensaje opcional, o retomar una conversación guardada. |
| Proyecto (mantener pulsado) | Nuevo chat, marcar o quitar favorito (en el PC) y ocultar en este iPhone. |
| Chat | Hilo con Markdown, árbol de herramientas, tareas, «trabajando», enviar (con fotos y archivos) y detener. |
| Hojas | Permisos (una vez / siempre), planes y preguntas de una o varias opciones. |
| Este iPhone | Tus trex (cambiar, renombrar, olvidar, conectar otro), avisos y diagnóstico del teclado. |

Los colores llegan del PC (mensaje `theme`), igual que en la PWA.

**Abrir y cerrar chats, favoritos, conversaciones y modelos** usan una ampliación del protocolo
(la PWA la ignora): el PC publica un mensaje `catalog` (todos los proyectos y los perfiles que
abren chat) y el móvil manda peticiones `request` (`open`, `close`, `favorite`, `conversations`,
`models`) que resuelve `App.tsx` por los mismos caminos que la interfaz; la respuesta `result`
puede traer datos (`session`, `conversations`, `models`). Con un trex anterior a la 0.10.0
no llega el catálogo y la app oculta esas opciones.

**Varios trex** (p. ej. el PC de la oficina y el de casa): cada emparejado se guarda en el Llavero
con su token y su nombre. Se cambia desde el indicador de conexión de la cabecera o desde
*Este iPhone › Tus trex*; solo hay una conexión abierta a la vez. Si un PC responde «denied»,
la app reintenta una vez antes de olvidarlo, porque trex también avisa así a todos los móviles
cuando reinicia su servidor remoto (al cambiar un ajuste).

## Estructura

- `Sources/TrexRemoteCore`: modelos del protocolo, mensajes, direcciones/QR, formatos y Markdown. Sin UIKit: se prueba en Linux.
- `Sources/TrexRemote`: la app SwiftUI.
- `Tests/TrexRemoteCoreTests`: pruebas del núcleo con mensajes reales del protocolo. **Si cambias `src/remoteProtocol.ts` o `remote.rs`, actualiza estas pruebas.**

## Compilar e instalar (Windows + WSL con xtool)

Requisitos: [xtool](https://github.com/xtool-org/xtool) configurado en Ubuntu (WSL), el iPhone
conectado a WSL con `usbipd-win` y el modo desarrollador activado.

```bash
# Dentro de Ubuntu:
bash /mnt/d/projects/trex/ios/scripts/dev.sh            # compila, firma e instala en el iPhone
bash /mnt/d/projects/trex/ios/scripts/dev.sh dev build  # solo compila
bash /mnt/d/projects/trex/ios/scripts/dev.sh test       # pruebas del núcleo en Linux
```

El script copia `ios/` a `~/proyectos/trex-ios` antes de compilar: SwiftPM no puede compilar
sobre `/mnt/…` (la caché de módulos de clang falla en NTFS).

Notas:

- Con un Apple ID gratuito la app caduca a los 7 días: vuelve a ejecutar el script.
- Una VPN con «bloquear tráfico fuera del túnel» (WireGuard de pantalla completa) corta la red
  entre WSL y Windows: desactívala mientras instalas. Si la activaste con el iPhone conectado,
  el enlace USB queda colgado (`LockdownClient.Error.muxError`):
  `sudo bash /mnt/d/projects/trex/ios/scripts/reset-usb.sh` lo recupera.
- El `usbmuxd` de Ubuntu 24.04 necesita el parche
  [libimobiledevice/usbmuxd#292](https://github.com/libimobiledevice/usbmuxd/pull/292) para
  instalar apps a través de usbipd-win (sin él se cuelga en «Connecting»).
- Sin notificaciones push de Apple no hay avisos con la app cerrada; los avisos locales solo
  llegan mientras iOS mantenga la app viva en segundo plano.
- `Info.plist` permite `http://` porque el servidor de trex escucha dentro del túnel (WireGuard
  o Tailscale); con `tailscale serve` también funciona por `https://`.
