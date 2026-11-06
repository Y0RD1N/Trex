# Integraciones de escritorio y aplicaciones

Estado: la sección de Ajustes detecta dependencias, ofrece guías de instalación
y permite comprobar la conexión de GitHub CLI sin mostrar su salida. Trex API
ofrece herramientas estructuradas para GitHub, scripts de Blender en segundo
plano y comandos de HyperFrames para validar, capturar y renderizar. Trex API
también ofrece captura y entrada de escritorio con activación explícita, en X11
y Windows (Windows aún no se ha verificado en un sistema real). El control
también se conecta a Claude Code y Codex mediante un servidor MCP por sesión. Wayland y el puente a Blender abierto están pendientes.

## Objetivo

Permitir que Claude Code, Codex y Trex API usen herramientas de escritorio,
Blender, HyperFrames y GitHub en Windows y Linux. La configuración, detección,
permisos y estado deben presentarse en TREX, sin pedir al usuario que configure
manualmente servidores MCP para cada asistente.

## Cómo reciben las funciones los agentes

Claude y Codex reciben el catálogo MCP de `trex_desktop` y confirman su conexión
antes del primer envío. La inicialización MCP incluye instrucciones de uso y
el modo real de permisos. El puente MCP de la app también entrega a Claude la
guía de integraciones cuando el perfil personaliza el prompt del sistema, sin
reemplazar ese prompt. Codex recibe la guía en `developerInstructions` al abrir,
reanudar o bifurcar el hilo.

Trex CLI anuncia las herramientas nativas en cada petición al proveedor. Aplica
las `instructions` enviadas por la app y devuelve `instructionsApplied:true`;
la app bloquea el envío si un CLI antiguo no confirma esa aplicación. Las pruebas
de proceso comprueban el mensaje de sistema y el catálogo que llega al proveedor
simulado, además de los límites, la restauración y los permisos. El modo de chat
de terminal también contiene guía básica para sus herramientas anunciadas.

La guía distingue control de Windows/escritorio, Trex Browser y los CLI de GitHub,
Blender e HyperFrames. Las herramientas de escritorio requieren activación en
Ajustes para un chat nuevo. El catálogo del modo plan excluye entrada; Trex API
excluye entrada si no se ha confirmado visión del modelo. Recibir el catálogo y
las instrucciones no garantiza que un modelo elija siempre la herramienta correcta;
no se sustituye esta verificación por una afirmación de uso real de modelos de pago.

## Arquitectura

- El ejecutable `trex-agent` ofrece un servidor MCP de escritorio por proceso,
  con modo inmutable, límite de mensajes e identificadores de operación que no
  se vuelven a ejecutar. Su proveedor nativo está integrado en Trex API.
- Claude y Codex reciben configuraciones MCP por sesión. Codex verifica el
  inventario de herramientas antes del primer turno y ambos clientes sustituyen
  la sesión cuando cambia la clase de permisos. Ambos verifican la conexión y
  las herramientas antes de enviar. Falta recuperación durable tras perder el
  proceso MCP.
- En Ajustes, mostrar instalación, disponibilidad, versión y limitaciones por
  integración, con instrucciones oficiales cuando falte una dependencia.
  Elegir por sesión qué integraciones se habilitan y ofrecer estado visible,
  pausa y detención del control. Modo plan: observación y análisis sin acciones
  que modifiquen el entorno. Los demás modos siguen los permisos elegidos para
  el agente; el control completo permite acciones cuando está habilitado.
- Ante una operación incierta o una pérdida de conexión, conservar su resultado
  como incierto y solicitar revisión; no repetirla automáticamente.

## Control de la computadora

Activa la opción en Ajustes y abre una nueva sesión de Trex API, Claude Code o
Codex. Claude y Codex reciben un servidor MCP local con el modo fijado al
arrancar: observar en planificación y entrada en los demás modos, sujeta a
sus permisos. Ambos confirman las herramientas disponibles antes de enviar.
El servidor no repite operaciones que usen el mismo identificador. Desactivar la
opción no revoca sesiones ya abiertas: ciérralas para retirarles el acceso. La
captura se entrega al proveedor del modelo. En Trex API, requiere visión
confirmada; las acciones de entrada no se ofrecen cuando esa capacidad es
desconocida, y las imágenes se guardan en el almacén privado de artefactos. Cada acción consume
la captura previa. El modo de planificación solo permite capturar. El soporte
actual cubre la pantalla principal en Windows y la pantalla raíz X11 en Linux;
Wayland se rechaza explícitamente, sin usar XWayland como sustituto. Se probó
en una pantalla X11 virtual; Windows y múltiples monitores siguen sin verificar.

### Diagnóstico y acciones de Windows

Ajustes muestra la disponibilidad real del escritorio y las pantallas detectadas,
con resolución y escala. La comprobación ejecuta `trex-agent desktop-doctor --json`:
no captura la pantalla, no envía entrada y no necesita perfil ni credenciales.
También está disponible para el agente como `desktop_status`.

`desktop_monitors` devuelve los identificadores que acepta el argumento opcional
`monitor` de `desktop_screenshot`. No hace falta llamarlo antes: cada captura
dice cuántas pantallas hay, así que el agente empieza directamente por
`desktop_screenshot`. Las coordenadas de entrada son píxeles de esa captura.

Coste de una captura (Claude cobra unos ancho×alto/750 tokens por imagen):
1280 px en el lado largo por defecto (unos 1 230 tokens en 16:9); `maxEdge`
(256–1568) la abarata para comprobar un cambio (768 px ≈ 440 tokens), `region`
recorta una zona de la pantalla y `fullResolution:true` llega hasta 1568 px, lo
más que ve el modelo (más allá, el modelo la reduciría y las coordenadas ya no
coincidirían). El resumen que acompaña a la imagen es una línea y el
identificador de observación es corto (`o7`), porque el modelo lo copia en cada
entrada. El control de computadora y el de accesibilidad son integraciones
independientes: las instrucciones no presentan ninguno como preferido. Windows aplica un contexto DPI por hilo, que se restaura al terminar,
y normaliza el movimiento sobre el escritorio virtual; permite pantallas con
orígenes negativos y evita usar el tamaño lógico de la pantalla principal.
Se vuelve a comprobar la geometría antes de actuar. La normalización, el contexto
DPI y el diagnóstico tienen pruebas en Windows; la entrada real con múltiples
monitores y las aplicaciones elevadas no se han validado en este dispositivo.

El agente dispone además de `desktop_move`, doble clic mediante `clicks:2`,
desplazamiento horizontal mediante `axis:"horizontal"`, arrastre gradual y
`desktop_wait` (milisegundos, máximo 10000). Cada entrada consume su observación,
que caduca a los 30 segundos. Cambiar la ventana enfocada obliga a capturar de
nuevo antes de escribir. Los agentes se serializan para no mezclar botones ni
modificadores. El servidor MCP atiende cancelación y EOF mientras ejecuta una
operación: cancela trabajo no emitido y no reproduce una entrada ya iniciada.
Los diagnósticos y la espera siguen disponibles en modo planificación; la entrada
se excluye del inventario y se rechaza de nuevo en el ejecutor.


Ofrecer captura de pantallas, lista y selección de ventanas, clic, movimiento y
arrastre, teclado, desplazamiento y espera. Definir coordenadas con monitor,
resolución, escala DPI y revisión de captura para evitar actuar sobre una vista
antigua. Una captura puede contener información privada y solo debe entregarse
al agente habilitado para esa sesión. Si el modelo no admite imágenes, no
indicar que pudo verlas.

En Windows usar las API nativas de captura y entrada y comprobar permisos de la
ventana destino. `SendInput` está sujeto a UIPI: no se debe prometer control de
ventanas elevadas desde un proceso sin el mismo nivel de privilegios. No
intentar sortear esa restricción.

En Linux distinguir X11 y Wayland. Para Wayland integrar RemoteDesktop y
ScreenCast de XDG Desktop Portal con PipeWire: el sistema solicita al usuario
seleccionar los dispositivos y la pantalla o ventana a compartir. Detectar el
backend y comunicar cuándo el compositor o portal no ofrece una capacidad.
X11 necesita un backend propio; verificar captura, entrada, DPI y ventanas en
una sesión real. Un servicio sin sesión gráfica debe informar que no está
listo en vez de simular éxito.

## Control por accesibilidad (experimental)

Integración independiente del control de computadora: la persona activa la que
quiera usar (o las dos) y ninguna se presenta al agente como preferida. Los
agentes manejan las aplicaciones a través del árbol de accesibilidad del sistema
(UI Automation en Windows), sin mover el ratón ni escribir con el teclado de la
persona. Se activa en Ajustes → Integraciones para los chats nuevos, los
equipos y las salas, donde también se decide si se permiten atajos de teclado.

Cada chat arranca su propio servidor, `trex-agent a11y-mcp --mode plan|full`
(servidor MCP `trex_a11y`), con herramientas `a11y_*`. Solo existe en Windows;
en otros sistemas el chat arranca sin la integración y lo avisa.

### Motor de Trex (Windows)

Va dentro de `trex-agent` (`trex-cli/src/a11y/`), sin dependencias externas:

- 6 herramientas de lectura (`list_windows`, `snapshot`, `find`, `get`, `wait`,
  `status`), 18 acciones semánticas y `press` con permiso (clic, menú contextual, valor, escribir,
  vaciar, casillas, desplegar, elegir, desplazar, abrir, cerrar, minimizar,
  maximizar y restaurar); unos 3 000 tokens de esquemas en modo completo;
- el árbol se devuelve como texto compacto (`- @s1:e3 edit "Nombre" [set_value,type]`),
  con los saltos de línea del texto como `⏎`,
  en una sola llamada entre procesos por ventana, y las ventanas se listan con
  la API clásica de Windows (milisegundos);
- `AutoSetFocus` desactivado: ninguna acción trae la ventana al frente. Si la
  persona usó ratón o teclado en la ventana destino hace menos de 2 s, se
  espera hasta 4 s a que haga una pausa y, si sigue, la acción se rechaza con
  `USER_ACTIVE` sin enviarse (abrir una app espera igual a que nadie teclee).
  Si la aplicación activa
  una de sus ventanas (un diálogo) sin que la persona toque nada, el foco
  vuelve a la ventana que estaba usando;
- cada acción dice qué cambió: el título de la ventana, elementos nuevos (con
  referencia, sin otro snapshot), elementos que cambiaron de valor o de estado
  (incluido cuál recibió el foco), los que entraron en pantalla y ventanas
  nuevas con sus elementos, sin los avisos del shell de Windows ni el propio
  marco de Trex. Los elementos se reconocen por su ruta de rol y nombre sin los
  nombres de contenedores y documentos, que suelen llevar el título de la
  ventana o de la página: cambiar de pestaña no hace parecer nueva toda la
  ventana;
- desplazar (`a11y_scroll`, por referencia o por ventana, por pasos, por
  páginas o hasta el principio o el final) usa el patrón de desplazamiento de
  la app y verifica la posición; las apps que no lo tienen (Qt, como Jellyfin
  Media Player) reciben la rueda del ratón como mensaje a su ventana, sin mover
  el puntero, y se mide cuánto se movió el contenido. La rueda solo se envía si
  hay contenido fuera de la ventana: en un reproductor, un mapa o un visor
  cambiaría el volumen o el zoom. `a11y_scroll_to` trae a la vista cualquier
  referencia, y un clic sobre un elemento oculto que no hace nada lo dice;
- Qt anuncia un valor editable en casi todo: escribir solo se ofrece en
  campos de texto, documentos, desplegables y celdas, y los contenedores vacíos
  no se listan;
- abrir una app que reutiliza su ventana (el Bloc de notas con pestañas) se
  detecta por el cambio de título, sin esperar a una ventana nueva;
- un marco naranja con la etiqueta «Trex · acción» marca durante un instante
  el elemento en el que actúa; no recibe clics ni foco;
- los botones clásicos (Win32 y WinForms) reciben el clic como mensaje
  encolado, igual que el de un ratón, así que un diálogo modal no bloquea la
  pasarela; el resto de acciones que podrían esperar corren en otro hilo con
  un límite de 2,5 s, y las llamadas se pueden cancelar;
- Chromium y Electron: la primera vez se les pide el árbol de la página
  (`WM_GETOBJECT`) y se lee de nuevo cuando lo han construido;
- en un equipo o una sala, cada agente reserva durante un minuto la ventana en
  la que actúa (`WINDOW_BUSY` para los demás); leer no reserva nada;
- `a11y_press` (atajos reales como Ctrl+S) solo existe con el permiso de
  Ajustes y en modo completo: exige 3 s sin tocar nada, trae la ventana al
  frente un instante, pulsa y devuelve el foco. Sus pulsaciones no cuentan
  como actividad de la persona. Sin la tecla Windows;
- cada acción con estado se comprueba releyendo el control (`NOT_KEPT` si la
  aplicación no conserva un valor, en vez de un falso «verificado»); los campos
  que solo admiten pulsaciones reales se rechazan con `KEYBOARD_ONLY`;
- los campos de contraseña nunca se leen ni se escriben, los valores largos se
  recortan y no se escribe nada en disco: las referencias viven en memoria y
  caducan a los ocho snapshots o listas de cambios;
- las instrucciones piden no usar el portapapeles, la terminal ni archivos
  como atajo para meter texto en una aplicación, y a Claude Code, cargar las
  herramientas diferidas en una sola búsqueda.

En el chat, las acciones se leen en castellano («Escribió 1043 caracteres»,
«Abrió notepad») con la marca «verificado» cuando la aplicación conservó el
cambio, y mientras el agente maneja una aplicación el aviso de trabajo dice
«Manejando notepad…» con un botón «Detener».

Las pruebas manejan una ventana Win32 real del propio proceso (fuera de la
pantalla y sin activarse): valores, casillas, desplegables, elementos y
ventanas nuevos, y que la ventana en primer plano no cambia. Además se probó a
mano con una app WinForms (diálogo modal, atajo Enter) y con un formulario en
Chrome.

### Antes: agent-desktop

Hasta noviembre de 2026 se podía elegir como motor externo
[agent-desktop](https://github.com/vercel-labs/agent-desktop). Se retiró: el
motor propio cubre su uso en Windows sin instalar nada y gasta menos tokens.
Las configuraciones guardadas que lo pedían (`--engine agent-desktop`,
`accessibility: "agent-desktop"`) siguen arrancando, con el motor propio.

## Blender

Detectar la instalación sin iniciar escenas ni ejecutar scripts. Para trabajo
estructurado, ejecutar la API Python dentro de Blender sobre una copia o ruta
indicada por el usuario, con proyecto y salida explícitos. Permitir consultar
escena, editar objetos, ejecutar scripts y renderizar; devolver errores y rutas
reales. El acceso a una instancia ya abierta necesita una extensión/puente de
Blender con un protocolo autenticado, gestión de ciclo de vida y ejecución en
el hilo apropiado de Blender. Es una capacidad separada de la ejecución en
segundo plano. El control visual del escritorio puede complementarla.

Informar cómo instalar Blender desde https://www.blender.org/download/ y no
instalar ni iniciar componentes automáticamente al detectar su ausencia.

## HyperFrames

Detectar primero una dependencia local del proyecto y después una instalación
adecuada del CLI; comprobar las dependencias y mostrar los diagnósticos del
comando `doctor` cuando se soliciten. Exponer creación, validación, vista previa,
capturas de fotogramas y render mediante el CLI, con rutas de entrada/salida
explícitas y cancelación. Guiar al agente con las instrucciones de HyperFrames
sin asumir que un modelo dispone de skills instaladas. El navegador integrado
puede utilizarse para la vista previa cuando corresponda.

La guía oficial describe `npm install -g hyperframes` y `npx hyperframes`:
https://hyperframes.app/docs/5-packages/cli. Mostrar la documentación de
instalación y dependencias para el sistema correspondiente.

## GitHub

Detectar GitHub CLI y comprobar autenticación sin mostrar tokens ni iniciar una
sesión por cuenta propia. Usar el almacén de credenciales existente del usuario.
Ofrecer listado e inspección de repositorios y PR, creación y actualización de
PR, revisión de checks y merge mediante operaciones separadas. Respetar los
permisos del agente y la instrucción concreta del usuario. Mostrar repositorio,
PR, rama y resultado; para merge se puede comprobar el SHA esperado y respetar
la política del repositorio. No usar `--admin` ni eliminar ramas salvo que el
usuario lo solicite. Ante un resultado incierto, consultar el estado antes de
reintentar. Guía: https://cli.github.com/manual/.

## Validación necesaria

- Probar negociación MCP, aislamiento entre sesiones, cancelación, límites,
  permisos y recuperación para los tres proveedores, sin cuentas reales ni
  servicios de pago. Probar modelos con y sin visión.
- Probar detección, instalación ausente y fallos con ejecutables simulados;
  probar Blender y HyperFrames reales en proyectos temporales y GitHub con un
  servidor de pruebas o límites controlados.
- En Windows verificar monitor múltiple, DPI, ventanas elevadas y ciclo de vida.
  En Linux verificar X11 y Wayland con los portales reales, revocación de
  permisos y escritorio sin sesión. No afirmar compatibilidad de un entorno que
  solo se compiló o se probó en contenedor.
- Empaquetar el componente en NSIS y RPM, comprobar actualización y reversión,
  y conservar proyectos, credenciales, archivos y sesiones del usuario.

Referencias: https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.RemoteDesktop.html,
https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput,
https://docs.blender.org/api/main/info_tips_and_tricks.html,
https://cli.github.com/manual/gh_pr_merge.
