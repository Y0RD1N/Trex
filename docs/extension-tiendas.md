# Publicar «trex para tu navegador» en las tiendas

La extensión de `extension/` se puede cargar a mano («Cargar descomprimida»), pero para
quien no desarrolla es mucho mejor instalarla desde la **Chrome Web Store** (sirve para
Chrome y Brave) y desde **Edge Add-ons** (Edge). Las publica la persona dueña del proyecto
con su propia cuenta de desarrollador; aquí está todo lo que hace falta para hacerlo.

## 1. Preparar el paquete

```sh
node scripts/package-extension.mjs C:\ruta\fuera\del\repo
```

Sin carpeta, el script crea una temporal y dice dónde dejó el archivo. Nunca lo deja dentro
del repositorio (se niega). El resultado es `trex-extension-<versión>.zip` con:

```
manifest.json          (en la raíz, como piden las tiendas)
background.js  lib.js  page.js
popup.html  popup.js  popup.css
icons/32.png  icons/64.png  icons/128.png
```

Sin README, sin pruebas y con saltos de línea LF: el mismo código da siempre el mismo .zip.
El script también comprueba el manifiesto (versión 3, icono de 128 px, descripción de 132
caracteres como mucho, sin el campo `key`, y que todo lo que nombra va dentro).

**Cada envío necesita una versión nueva.** Las tiendas no aceptan dos veces la misma
`version` de `manifest.json`: súbela antes de empaquetar (0.2.0 → 0.2.1…).

## 2. Chrome Web Store (Chrome y Brave)

1. **Cuenta.** Entra en el [panel de desarrollador](https://chrome.google.com/webstore/devconsole)
   con la cuenta de Google que será la dueña. Hay que aceptar el acuerdo, pagar la cuota de
   registro (pago único) y tener la verificación en dos pasos activada. Conviene poner un
   correo de contacto que se lea.
2. **Nuevo elemento → subir el .zip.**
3. **Ficha de la tienda:** nombre, descripciones (apartado 4), categoría *Herramientas para
   desarrolladores* (o *Productividad*), idioma principal español y una traducción al inglés,
   icono de 128 px (el del paquete vale), capturas (apartado 8).
4. **Prácticas de privacidad:** propósito único (apartado 5), justificación de cada permiso
   (apartado 6), uso de datos (apartado 7), «¿Usas código remoto?» → **No** (todo el código va
   en el paquete; lo que se ejecuta en la página son funciones de `page.js`) y la URL de la
   política de privacidad.
5. **Distribución:** pública, o *no listada* mientras se prueba (solo la encuentra quien
   tenga el enlace). Todos los países.
6. **Enviar a revisión.** Con el permiso `debugger` la revisión es manual y tarda más que la
   de una extensión normal: cuenta con días, no horas. Si piden aclaraciones, el apartado 6
   es la respuesta.

Brave instala directamente desde la Chrome Web Store: no hace falta publicar aparte.

## 3. Edge Add-ons (Microsoft Edge)

1. **Cuenta.** En el [Partner Center](https://partner.microsoft.com/dashboard/microsoftedge/overview)
   hay que inscribirse en el programa de Microsoft Edge (gratis) con una cuenta Microsoft.
2. **Crear una extensión → subir el mismo .zip.**
3. **Disponibilidad:** pública u oculta, mercados.
4. **Propiedades:** categoría *Herramientas para desarrolladores*, URL de la política de
   privacidad, web y correo de soporte. Edge pregunta si la extensión «tiene acceso a datos
   personales»: **sí** (apartado 7).
5. **Ficha, por idioma** (español e inglés): descripción (apartado 4), logotipo de la tienda
   (cuadrado; el de 128 px escalado vale de partida, mejor uno de 300×300) y capturas.
6. **Notas para la certificación:** explica que la extensión solo funciona con la app de
   escritorio trex abierta y emparejada, y cómo probarla (instala trex, Ajustes › Conexiones ›
   Navegador, «Emparejar», escribe el código en la ventanita de la extensión, comparte una
   pestaña y pide a un chat que la lea). Sin esto, el revisor ve una extensión que «no hace
   nada».
7. **Publicar.** La certificación de Edge también revisa `debugger` a mano.

## 4. Textos de la ficha

### Español

- **Nombre:** trex para tu navegador
- **Descripción corta** (la del manifiesto, ≤ 132 caracteres):
  > Deja que los agentes de la app trex vean y manejen las pestañas que tú les compartas: cada chat, en su propio grupo de pestañas.
- **Descripción larga:**

  > trex para tu navegador conecta tu navegador de siempre (Chrome, Brave o Edge) con la app
  > de escritorio trex, para que los agentes de programación con los que hablas en trex
  > (Claude, Codex, Gemini…) puedan ver y usar páginas web con tus sesiones iniciadas.
  >
  > Tú decides qué pueden tocar:
  > • Cada chat de trex tiene su propio grupo de pestañas, con su nombre («trex · Claude 2»).
  > Solo ve y maneja las suyas; nunca las de otro chat ni el resto de tus pestañas.
  > • Compartes una pestaña desde el botón de la extensión: con un chat concreto o en el grupo
  > común «trex», del que la toma el primer chat que la use. Para retirarla, sácala del grupo.
  > • Los agentes pueden leer la página, hacer capturas, abrir pestañas en su grupo, hacer
  > clic, escribir, rellenar formularios, elegir opciones, esperar a que algo aparezca,
  > responder diálogos y subir archivos de la carpeta del proyecto del chat.
  > • Nunca escriben contraseñas, códigos de verificación ni datos de tarjeta: la extensión
  > lo impide.
  > • Si el chat está en modo de solo lectura o planificando, solo puede mirar.
  >
  > Cómo funciona: la extensión solo habla con la app trex de tu propio equipo
  > (127.0.0.1). No tiene servidor propio ni envía nada a terceros por su cuenta. Lo que lee
  > un agente (texto y capturas de las pestañas compartidas) llega al proveedor del modelo que
  > usas en trex, como el resto de la conversación.
  >
  > Necesitas la app trex abierta y «Tu navegador» activado en Ajustes › Conexiones ›
  > Navegador. Se empareja una vez con un código de 6 caracteres.
  >
  > Mientras un agente maneja una pestaña, el navegador muestra su aviso de que una extensión
  > la está depurando: es lo esperado, y desaparece a los dos minutos sin actividad.

### English

- **Name:** trex for your browser
- **Short description** (≤ 132 characters):
  > Let the agents in the trex app see and use the tabs you share with them, each chat in its own tab group.
- **Long description:**

  > trex for your browser connects your everyday browser (Chrome, Brave or Edge) to the trex
  > desktop app, so the coding agents you talk to in trex (Claude, Codex, Gemini…) can see and
  > use web pages with your signed-in sessions.
  >
  > You decide what they can touch:
  > • Every trex chat gets its own tab group, named after it ("trex · Claude 2"). It only
  > sees and drives its own tabs — never another chat's, never the rest of your tabs.
  > • You share a tab from the extension button: with a specific chat, or in the common "trex"
  > group, where the first chat that uses it takes it. To take it back, move it out of the group.
  > • Agents can read the page, take screenshots, open tabs in their group, click, type,
  > fill in forms, pick options, wait for something to appear, answer dialogs and upload
  > files from the chat's project folder.
  > • They never type passwords, verification codes or card details: the extension refuses.
  > • A chat in read-only or planning mode can only look.
  >
  > How it works: the extension only talks to the trex app on your own computer (127.0.0.1).
  > It has no server of its own and sends nothing to third parties by itself. What an agent
  > reads (text and screenshots of shared tabs) reaches the model provider you use in trex,
  > like the rest of the conversation.
  >
  > You need the trex app open with "Your browser" turned on in Settings › Connections ›
  > Browser. Pair once with a 6-character code.
  >
  > While an agent drives a tab, the browser shows its notice that an extension is debugging
  > it. That is expected, and it goes away after two minutes without activity.

(La extensión no tiene `_locales`: el nombre y la descripción del manifiesto están en
español. La ficha en inglés se escribe en la tienda. Si algún día se quiere el nombre
traducido dentro del navegador, hay que añadir `_locales/es` y `_locales/en` y usar
`__MSG_…__` en el manifiesto.)

## 5. Propósito único

> Permitir que los agentes de la app de escritorio trex, que se ejecuta en el mismo equipo,
> vean y manejen las pestañas del navegador que la persona comparte con ellos, cada chat dentro
> de su propio grupo de pestañas.

## 6. Justificación de los permisos

Las tiendas piden una frase por permiso. Estas son las respuestas; la de `debugger` es la que
más se mira.

- **`debugger`** — Es el único medio que da Chrome para que una extensión actúe en una
  pestaña como lo haría la persona: clics y teclas de verdad (eventos de entrada que la página
  no distingue de los de una persona), escribir en el campo con el foco, capturas de pantalla
  de la pestaña aunque no esté delante, leer la página en un «mundo aislado» que los scripts
  de la propia página no ven, detectar y responder los diálogos `alert`/`confirm`/`prompt`
  (que de otro modo dejan la página bloqueada) y poner archivos en un `<input type=file>`.
  Los scripts de contenido no pueden hacer nada de esto de forma fiable. Límites: solo se
  conecta a pestañas que la persona ha compartido con un chat (su grupo de pestañas), solo
  cuando un agente lo pide y se suelta a los dos minutos sin actividad; mientras está puesto,
  Chrome muestra su aviso de depuración. No se usa para leer el tráfico de red ni para
  pestañas que no estén compartidas.
- **`tabs`** — Ver el título y la dirección de las pestañas compartidas para que el agente
  sepa cuál es cuál, abrir pestañas nuevas en el grupo del chat, navegar, ir atrás y adelante
  y cerrar las pestañas del chat.
- **`tabGroups`** — Cada chat tiene su propio grupo de pestañas («trex · Claude 2»): es así
  como la persona ve qué está usando cada agente y como la extensión decide qué puede tocar
  cada uno. Retirar una pestaña es tan fácil como sacarla del grupo.
- **`storage`** — Guardar el emparejado con la app (un token aleatorio y el puerto local) y,
  mientras el navegador está abierto, qué grupo es de qué chat.
- **`alarms`** — Despertar al service worker cada minuto para volver a conectar con la app
  trex si se cerró o se reinició.
- **`host_permissions: http://127.0.0.1/*`** — La extensión solo habla con la app trex de
  este mismo equipo, por un puerto local. No tiene permiso sobre ningún sitio web: no inyecta
  scripts de contenido ni lee páginas que la persona no haya compartido.

Opcional y fuera del manifiesto: para que un agente pueda **subir archivos**, la persona tiene
que activar «Permitir el acceso a las URL de archivo» en los detalles de la extensión
(Chrome lo exige para `DOM.setFileInputFiles`). Sin eso, todo lo demás funciona y la
herramienta lo explica. Qué archivos se pueden subir lo decide la app trex: solo archivos
normales dentro de la carpeta del proyecto del chat, sin `..` ni enlaces simbólicos, de hasta
64 MiB y como mucho 10 por vez (`src-tauri/src/browser_bridge.rs`, `checked_uploads`).

## 7. Prácticas de privacidad

Qué datos maneja la extensión y adónde van:

| Dato | Cuándo | Adónde va |
| --- | --- | --- |
| Título y dirección de las pestañas compartidas | `tabs_list` | A la app trex local, y de ahí al proveedor del modelo del chat |
| Texto visible y elementos de la página | `read_page`, `wait_for` | Igual |
| Capturas de pantalla de la pestaña | `screenshot` | Igual |
| Texto de los diálogos de la página | cuando salta uno | Igual |
| Lo que el agente escribe o elige en formularios | `type`, `fill_form`, `select_option` | Lo escribe el agente en la página; no se guarda |
| Rutas de archivos del proyecto | `upload_file` | Las da la app trex; los archivos los sube la propia página |
| Token de emparejado y puerto | al emparejar | Solo en el navegador (`chrome.storage.local`) |

- Nada sale del equipo por la extensión: solo habla con `127.0.0.1`. Lo que llega al
  proveedor del modelo (Anthropic, OpenAI, Google…) lo manda la app trex como parte de la
  conversación que la persona tiene con ese agente, igual que el resto del chat.
- No lee pestañas no compartidas, ni el historial, ni las cookies, ni las contraseñas. Lo que
  hay escrito en un campo de contraseña nunca se lee, y la extensión se niega a escribir en
  contraseñas, códigos de verificación y datos de tarjeta.
- No hay analítica, ni publicidad, ni venta de datos.

En el formulario de la Chrome Web Store, marca como datos tratados **«Contenido del sitio
web»** y **«Historial web»** (solo títulos y direcciones de las pestañas compartidas). Puede
aparecer información personal dentro de las páginas que la persona comparte (por ejemplo, su
correo): menciónalo en la política. Marca las tres certificaciones: no se venden datos a
terceros, no se usan para nada ajeno al propósito único y no se usan para dar créditos.

La tienda exige una **URL de política de privacidad**. Un texto que sirve de base (publícalo,
por ejemplo, en la web del proyecto o como página del repositorio):

> **Política de privacidad de «trex para tu navegador»**
>
> La extensión conecta tu navegador con la app de escritorio trex que se ejecuta en tu mismo
> equipo. Solo se comunica con esa app, a través de 127.0.0.1; no tiene servidores propios.
>
> Cuando compartes una pestaña con un chat de trex y el agente de ese chat lo pide, la
> extensión lee de esa pestaña su título, su dirección, su texto visible, sus elementos
> interactivos o una captura de pantalla, y se los entrega a la app trex. La app los incluye
> en la conversación con el agente, que los envía al proveedor del modelo que hayas elegido
> (sus condiciones de privacidad se aplican a esos datos). Las páginas pueden contener datos
> personales tuyos; compártelas solo si quieres que el agente los vea.
>
> La extensión no lee pestañas que no hayas compartido, ni tu historial, ni tus cookies, ni
> tus contraseñas; se niega a escribir contraseñas, códigos de verificación y datos de
> tarjeta. Solo guarda en tu navegador el emparejado con la app y qué grupo de pestañas es de
> qué chat. No usa analítica ni publicidad y no vende ni cede datos.
>
> Para dejar de usarla, desvincúlala desde la propia extensión o desde trex, o desinstálala.

## 8. Capturas que conviene hacer

Las tiendas piden al menos una (Chrome Web Store: 1280×800 o 640×400; Edge: 1280×800 o
640×480, comprueba las medidas en el formulario). Mejor en un perfil de navegador limpio, sin
pestañas ni datos personales a la vista:

1. **Dos chats, dos grupos.** Una ventana con el grupo «trex · Claude 2» (azul, por ejemplo)
   y «trex · Codex» (verde), y el grupo común «trex» (naranja). Es la idea central.
2. **La ventanita** de la extensión emparejada, sobre una página web, con «Compartir con» y
   el botón «Compartir esta pestaña».
3. **El emparejado** en trex (Ajustes › Conexiones › Navegador) con el código, y la ventanita
   de la extensión con el campo del código.
4. **Un agente trabajando**: el chat de trex a un lado, con la respuesta de `read_page` o de
   `fill_form`, y la pestaña en su grupo al otro.
5. **La negativa**: el agente intentando escribir en un campo de contraseña y el mensaje de
   que lo debe hacer la persona. Ayuda al revisor a entender los límites.

Opcional: la tesela promocional pequeña de 440×280 (el logotipo de trex sobre su color).

## 9. El id de la extensión cambia: hay que volver a emparejar

Una extensión cargada a mano tiene un id que depende de la carpeta; la publicada en la Chrome
Web Store tiene otro, asignado por la tienda, y la de Edge Add-ons otro distinto. No se puede
(ni se debe) forzar el mismo: el campo `key` del manifiesto no se admite al publicar.

trex no da por hecho ningún id. En `src-tauri/src/browser_bridge.rs`:

- `extension_origin` acepta cualquier `Origin: chrome-extension://<id>` con un id bien
  formado (32 letras de la «a» a la «p»): así sirven la de Chrome, la de Edge y la cargada a
  mano.
- Al emparejar (`Inner::pair`), el token queda **ligado al id** de la extensión que lo pidió;
  `authenticate` y la ruta `/ws` exigen después ese mismo id.

Por eso, al pasar de la versión cargada a mano a la de la tienda:

1. Instala la de la tienda y empareja de nuevo (Ajustes › Conexiones › Navegador ›
   «Emparejar»). El token de la copia vieja no vale para la nueva.
2. **Quita o desactiva la copia cargada a mano** en `chrome://extensions`. Si las dos siguen
   activas en el mismo navegador, se conectan las dos y trex atiende a la última que entra:
   se irían quitando el sitio cada pocos segundos.
3. En trex, «Desvincular» la entrada vieja del navegador (o dejar que caiga sola: trex
   guarda como mucho 8 navegadores emparejados).

## 10. Actualizaciones

- Sube `version` en `extension/manifest.json`, vuelve a empaquetar y sube el .zip nuevo en
  cada tienda. Los navegadores actualizan solos en unas horas.
- La extensión 0.2.0 necesita un trex que mande en cada orden la identidad del chat
  (`owner`) y el título de su grupo (`group`). Con un trex anterior responde «Actualiza trex».
- Al revés, trex no atiende a una extensión anterior a 0.2.0 (que pondría todos los chats en
  un único grupo): pide recargarla o actualizarla.
- Si cambian los permisos del manifiesto, Chrome desactiva la extensión hasta que la persona
  acepte los nuevos, y la revisión vuelve a ser manual: evita tocarlos sin necesidad.
