# trex para tu navegador

Extensión para Chrome, Brave y Edge que deja a los agentes de trex ver y manejar las
pestañas que tú les compartas, en tu navegador de siempre y con tus sesiones iniciadas.
Cada chat de trex trabaja en su propio grupo de pestañas.

Está apagada por defecto y solo funciona con la app de trex abierta.

## Instalarla

1. En trex, abre **Ajustes › Conexiones › Navegador** y activa **«Los agentes pueden usar tu navegador»**.
2. Instala la extensión:
   - **Desde la tienda** (cuando esté publicada): Chrome Web Store para Chrome y Brave, Edge
     Add-ons para Edge. Es lo recomendable: se actualiza sola.
   - **A mano**: pulsa **«Carpeta de la extensión»** en trex, abre `chrome://extensions`
     (`brave://extensions`, `edge://extensions`), activa el **modo de desarrollador**, pulsa
     **«Cargar descomprimida»** y elige esa carpeta.
3. En trex pulsa **«Emparejar»** y escribe el código de 6 caracteres en la ventanita de la extensión.

Se empareja una vez por navegador. Para retirarlo, «Desvincular» en trex o en la extensión.

Si pasas de la copia cargada a mano a la de la tienda, el id de la extensión cambia: empareja
de nuevo y **quita la copia cargada a mano** (si las dos siguen activas, se quitan el sitio
la una a la otra). Más detalles en `docs/extension-tiendas.md`.

### Mejor en un perfil aparte

Los agentes actúan con las sesiones iniciadas del perfil donde esté la extensión. Lo más
tranquilo es crear un **perfil del navegador solo para trex** (Chrome: icono de tu perfil ›
«Añadir»), iniciar ahí sesión solo en lo que quieras que usen los agentes, e instalar la
extensión únicamente en ese perfil. Tu perfil de siempre queda fuera de su alcance.

## Qué pueden tocar los agentes

**Cada chat tiene su propio grupo de pestañas**, con su nombre: «trex · Claude 2»,
«trex · Codex»… Un chat solo ve y maneja las pestañas de su grupo:

- las que abre él, y
- las que tú le das.

Las pestañas de otro chat no existen para él, y el resto de tus pestañas tampoco: no se
listan, no se leen y no se pueden manejar. La comprobación se hace dentro de la extensión, en
cada orden, con un id opaco del chat que pone trex (no con el título del grupo: puedes
renombrarlo y sigue siendo de ese chat).

### Compartir una pestaña tuya

Pulsa el botón de la extensión en la pestaña y elige **con quién**:

- **«Cualquier chat (grupo común «trex»)»**: la pestaña va al grupo naranja «trex». Todos los
  chats que usan el navegador la ven en su lista; **el primero que la usa se la queda** (pasa a
  su grupo) y desde ese momento ningún otro chat la alcanza.
- **«Solo trex · Claude 2»** (aparece cuando ese chat ya tiene grupo): va directamente a su grupo.

También puedes **arrastrar** la pestaña al grupo del chat que quieras.

Para retirar una pestaña, sácala del grupo o pulsa «Dejar de compartir esta pestaña».

### Cuando termina un chat

Sus pestañas **no se cierran** (son tuyas): se quedan en su grupo, que se vuelve **gris** y
deja de ser de ningún chat. Así puedes cerrarlas todas de una vez (clic derecho en el grupo ›
«Cerrar grupo») o seguir usándolas. Ningún chat las alcanza salvo que las vuelvas a compartir.

Al cerrar el navegador, la extensión olvida qué grupo era de qué chat: los grupos que
restaure el navegador ya no son de nadie.

## Lo que pueden hacer

- **Mirar** (también en modo planificar o de solo lectura): `tabs_list`, `read_page`,
  `screenshot` y `wait_for` (esperar, como mucho 30 s, a que aparezca o desaparezca un texto o
  un elemento, o a que termine de cargar).
- **Actuar** (solo con el chat en un modo que lo permita): `tab_open`, `navigate`, `click`,
  `type`, `fill_form` (varios campos de una vez: texto, desplegables, casillas y botones de
  opción), `select_option`, `key`, `scroll`, `upload_file`, `handle_dialog` (aceptar o
  descartar un `alert`, `confirm` o `prompt`) y `tab_close`.

Si la página abre un diálogo, las herramientas no se quedan esperando: avisan de que hay uno
abierto y el agente lo resuelve con `handle_dialog` (o lo cierras tú).

**Subir archivos** (`upload_file`) solo sirve con archivos de la carpeta del proyecto del chat
(trex lo comprueba: nada fuera de ella, sin `..` ni enlaces, hasta 64 MiB y 10 archivos), y
requiere que actives **«Permitir el acceso a las URL de archivo»** en los detalles de la
extensión. Sin eso, todo lo demás funciona.

## Lo que conviene saber

- En una pestaña compartida el agente actúa **con tu sesión** de ese sitio.
- Lo que lee (texto y capturas) se envía al proveedor del modelo.
- No escribe contraseñas, códigos de verificación ni datos de tarjeta: la extensión lo rechaza.
- La extensión solo habla con `127.0.0.1`, es decir, con la app de trex de este equipo.
- Mientras un agente maneja una pestaña, el navegador muestra su aviso de que una extensión
  la está depurando. Es correcto que se vea; desaparece a los dos minutos sin actividad.
- Apagar «Tu navegador» en trex no la desempareja: vuelve a conectar sola cuando lo enciendes.
- Si cambias el puerto en trex, pulsa «Desvincular» en la extensión y empareja de nuevo
  poniendo el puerto nuevo en «Avanzado».

## Para quien la mantiene

- `manifest.json`: permisos `debugger`, `tabs`, `tabGroups`, `storage`, `alarms` y acceso de red solo a `127.0.0.1`.
- `background.js`: conexión con trex, grupos por chat y herramientas. Cada orden trae `owner`
  (id opaco del chat) y `group` (título de su grupo); toda herramienta que nombra una pestaña
  pasa primero por `ownTab`. De quién es cada grupo se guarda en `chrome.storage.session`.
- `page.js`: lo que se ejecuta dentro de la pestaña, en un mundo aislado de la página.
- `lib.js`: piezas puras, con pruebas en `scripts/extension.test.mjs`.
- El otro extremo es `src-tauri/src/browser_bridge.rs` (servidor local, emparejado, sesiones
  de los chats, validación de `upload_file` y herramientas para los agentes). trex no manda
  órdenes a extensiones anteriores a 0.2.0.
- Paquete para las tiendas: `node scripts/package-extension.mjs <carpeta fuera del repo>`;
  pasos de publicación en `docs/extension-tiendas.md`.
