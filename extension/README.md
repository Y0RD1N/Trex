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
  `click_at` (clic en un punto de su última captura: un lienzo, un marco, un mapa), `type`,
  `fill_form` (varios campos de una vez: texto, desplegables, casillas y botones de opción),
  `select_option`, `key`, `scroll`, `upload_file`, `handle_dialog` (aceptar o descartar un
  `alert`, `confirm` o `prompt`) y `tab_close`.

Si la página abre un diálogo, las herramientas no se quedan esperando: avisan de que hay uno
abierto y el agente lo resuelve con `handle_dialog` (o lo cierras tú).

### Capturas

`screenshot` captura la zona visible de una pestaña del chat, **también en segundo plano** (sin
traerla delante), reducida a 1280 px de lado largo (unos 1 000 tokens; `maxEdge` de 256 a 2576,
`fullResolution` para la de la pantalla). Con `ref`, solo ese elemento; con `region`, solo una
zona de la última captura de esa pestaña, a la resolución de la pantalla; con `labels`, numera
en la imagen los elementos con los que se puede interactuar (el número N es `ref_N`).

- Solo la pestaña del chat, por su depurador: nunca otras pestañas, la ventana ni la pantalla.
  No hace falta ningún permiso nuevo.
- Antes de que la imagen salga del navegador se tapan las contraseñas, los campos de tarjeta y
  de códigos de verificación, y los marcos de pago (`allow="payment"` o de proveedores
  conocidos). El texto normal de la página no se tapa, igual que en `read_page`.
- Si la pestaña deja de ser del chat mientras se captura, la imagen no sale.
- Con la pestaña en segundo plano, el navegador no la pinta: la extensión fija la vista a su
  mismo tamaño un momento para que la pinte, y la página no se entera de ese cambio de tamaño.

**Tras cada acción** (Ajustes › Conexiones › Navegador, por defecto «Nada»): con «Qué cambió»,
después de `navigate`, `click`, `click_at`, `type`, `fill_form`, `select_option`, `key` y
`scroll` la extensión cuenta qué cambió en la página (lo que apareció o desapareció, la
dirección, el foco); con «Con imagen», además una captura de solo esa zona, o de la vista
entera si cambió casi todo o cargó otra página. El agente elige en cada acción con `capture`
(`changed`, `full` o `none`). Lo que cambió se ve con un `MutationObserver` en el mundo aislado
de la extensión, no comparando imágenes; los cambios que no tocan la página (un lienzo, un
campo en el que se escribe) cuentan por el elemento que tocó la acción. En segundo plano, la
página va con sus temporizadores retrasados y se espera algo más.

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
  órdenes a extensiones anteriores a 0.2.0, ni `click_at`, capturas por zona o elemento, ni
  «tras cada acción» a las anteriores a 0.3.0. Con «tras cada acción» encendido, las órdenes de
  las acciones traen `after` («text» o «image»).
- Capturas, medido en Brave 158: el `clip` y la escala de `Page.captureScreenshot` no son de
  fiar (tras una captura que no llega, la siguiente sale a la escala o del tamaño de la
  anterior), así que siempre se pide la vista entera y se recorta y reduce con
  `OffscreenCanvas`. Con la pestaña oculta, una petición a veces no contesta hasta que llega la
  siguiente: se vuelve a pedir a los 250 ms (ver `shootHidden`).
- Paquete para las tiendas: `node scripts/package-extension.mjs <carpeta fuera del repo>`;
  pasos de publicación en `docs/extension-tiendas.md`.
