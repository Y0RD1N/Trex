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
`monitor` de `desktop_screenshot`. Las coordenadas de entrada son píxeles de esa
captura. Windows aplica un contexto DPI por hilo, que se restaura al terminar,
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
