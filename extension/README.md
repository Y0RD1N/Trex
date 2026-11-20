# trex para tu navegador

Extensión para Chrome, Brave y Edge que deja a los agentes de trex ver y manejar las
pestañas que tú compartas, en tu navegador de siempre y con tus sesiones iniciadas.

Está apagada por defecto y solo funciona con la app de trex abierta.

## Instalarla

Todavía no está en la Chrome Web Store: se carga a mano.

1. En trex, abre **Ajustes › Conexiones › Navegador** y activa **«Los agentes pueden usar tu navegador»**.
2. Pulsa **«Carpeta de la extensión»**: se abre la carpeta que hay que cargar.
3. En el navegador, abre `chrome://extensions` (en Brave, `brave://extensions`; en Edge, `edge://extensions`).
4. Activa el **modo de desarrollador** y pulsa **«Cargar descomprimida»**. Elige esa carpeta.
5. En trex pulsa **«Emparejar»** y escribe el código de 6 caracteres en la ventanita de la extensión.

Se empareja una vez por navegador. Para retirarlo, «Desvincular» en trex o en la extensión.

## Qué pueden tocar los agentes

Solo las pestañas del grupo **«trex»**:

- las que abre el propio agente, y
- las que tú compartes con el botón de la extensión («Compartir esta pestaña con trex»).

Para retirar una pestaña, sácala del grupo o pulsa «Dejar de compartir». El resto de tus
pestañas no se listan, no se leen y no se pueden manejar: la comprobación se hace dentro de
la extensión, en cada orden.

Mientras un agente maneja una pestaña, el navegador muestra su aviso de que una extensión
la está depurando. Es correcto que se vea; desaparece a los dos minutos sin actividad.

## Lo que conviene saber

- En una pestaña compartida el agente actúa **con tu sesión** de ese sitio.
- Lo que lee (texto y capturas) se envía al proveedor del modelo.
- No escribe en campos de contraseña: la extensión lo rechaza.
- En un chat en modo planificar o de solo lectura, el agente puede mirar pero no actuar.
- La extensión solo habla con `127.0.0.1`, es decir, con la app de trex de este equipo.
- Apagar «Tu navegador» en trex no la desempareja: vuelve a conectar sola cuando lo enciendes.
- Si cambias el puerto en trex, pulsa «Desvincular» en la extensión y empareja de nuevo
  poniendo el puerto nuevo en «Avanzado».

## Para quien la mantiene

- `manifest.json`: permisos `debugger`, `tabs`, `tabGroups`, `storage`, `alarms` y acceso de red solo a `127.0.0.1`.
- `background.js`: conexión con trex, grupo «trex» y herramientas. Toda herramienta que nombra una pestaña pasa por `sharedTab`.
- `page.js`: lo que se ejecuta dentro de la pestaña, en un mundo aislado de la página.
- `lib.js`: piezas puras, con pruebas en `scripts/extension.test.mjs`.
- El otro extremo es `src-tauri/src/browser_bridge.rs` (servidor local, emparejado y herramientas para los agentes).
