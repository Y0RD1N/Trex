# Guía de uso de trex

Todo lo que puede hacer trex, con detalle. Si es tu primera vez, empieza por el
[README](../README.md).

**En esta guía:** [Qué hace](#qué-hace) · [Chat con Claude Code y Codex](#claude-code-y-codex-como-chat) ·
[Perfiles y cuentas](#perfiles-y-varias-cuentas) · [Trex CLI y conexiones API](#trex-cli-opcional-y-conexiones-api) ·
[Cursor](#cursor-de-texto) · [Terminales divididas](#trabajar-con-hasta-cuatro-terminales) ·
[Recuperar conversaciones](#recuperar-una-conversación) · [Capturas y avisos](#capturas-y-notificaciones) ·
[Atajos](#atajos) · [Notas](#notas) · [Trex Browser](#navegador-opcional-para-los-agentes) ·
[Fedora](#fedora) · [Equipos de agentes](#equipos-con-agente-principal)

## Qué hace

- **Proyectos**: añades carpetas una sola vez y quedan en la barra lateral.
- **Acciones del proyecto**: su menú contextual permite configurar un flujo de
  agentes o abrir una terminal directamente en esa carpeta, además de elegir
  un perfil, sin depender del proyecto activo en la barra superior.
- **Perfiles de asistentes**: el botón `+` permite elegir Claude Code, Codex
  o cualquiera de tus perfiles personalizados, dentro de la carpeta del proyecto.
- **Antigravity (integración inicial)**: añade un perfil desde Ajustes >
  Asistentes, instala el componente ACP oficial de Google y conecta tu cuenta
  al abrir el chat. Los modelos y permisos se consultan al servidor. Incluye
  entrega de imágenes y archivos, tareas y un espacio de Trex Browser por chat.
  Sus mensajes en cola se envían como turnos completos al terminar la respuesta.
  Uso y contexto muestra la ocupación informada por ACP, los tokens del chat y
  las cuotas por grupo de modelos de `/usage`, consultadas con la misma cuenta.
  La planificación de solo lectura, los equipos y el control de sus terminales
  internas permanecen deshabilitados mientras se validan esas capacidades.
  El arranque y la petición de autenticación se han probado en Windows y
  Fedora 44; los turnos de texto, el contexto y las cuotas también se han
  comprobado con una cuenta conectada en Windows. Las herramientas autenticadas
  y los turnos en Fedora todavía requieren validación adicional.
- **Pestañas**: varias terminales por proyecto, todas vivas a la vez.
  `Ctrl+T` (perfil predeterminado) y `Ctrl+Shift+T` (shell limpio).
- **Terminal dividida**: dos sesiones en columnas o filas, o hasta cuatro en una
  cuadrícula 2 × 2 por proyecto, con separadores ajustables y foco independiente.
- **Paleta de comandos**: `Ctrl+K` busca acciones, proyectos, perfiles y sesiones.
- **Recuperar conversaciones**: continúa el historial local de Claude Code o
  Codex desde el menú de nueva sesión o con `Ctrl+Shift+R`.
- **Continuar con otro asistente**: transfiere el trabajo de un chat a otro
  perfil de Claude Code o Codex, incluso si el anterior se quedó sin cuota.
- **Planificar e implementar**: elige un perfil y un modelo para cada etapa;
  Claude Code y Codex pueden desempeñar cualquiera de los dos roles. El plan
  definitivo se entrega automáticamente al ejecutor en otra conversación.
- **Mensajes en cola**: escribe mientras Claude, Codex o Trex trabajan; cada
  agente decide cuándo consultar su bandeja. Puedes editar, enviar directamente
  o cancelar los mensajes pendientes.
- **Vista previa de capturas**: revisa la imagen y la sesión de destino antes de
  adjuntarla. El texto se pega directamente.
- **Atajos personalizables**: cambia las combinaciones en Ajustes → Atajos,
  con detección de conflictos y opción de restablecer los valores iniciales.
- **Control por accesibilidad (experimental)**: Claude Code, Codex, Trex CLI y
  Antigravity manejan las aplicaciones a través del árbol de accesibilidad del
  sistema, sin mover tu ratón, sin escribir con tu teclado y sin traer ventanas
  al frente; un marco naranja muestra dónde actúa y puedes detenerlo desde el
  chat. Usa el motor propio de Trex (Windows), que no requiere instalar nada,
  también con Chrome y Electron. Es una integración independiente del control
  de computadora: tú eliges cuál activar en Ajustes → Integraciones. Detalles en
  [integraciones de escritorio](integraciones-escritorio.md#control-por-accesibilidad-experimental).
- **Avisos del escritorio**: notificaciones cuando un asistente termina,
  necesita atención o encuentra un error; por defecto, con TREX en segundo plano.
- **Al salir de Claude** vuelves al prompt del shell en la misma pestaña.
- **Detección de Claude Code**: busca el binario en el `PATH` y en las rutas
  típicas del instalador nativo (Windows: `%USERPROFILE%\.local\bin`), y avisa
  con instrucciones si no lo encuentra.
- **Ajustes persistentes**: shell (PowerShell, cmd, Git Bash, WSL, bash, zsh…),
  comandos, argumentos y perfiles de asistentes (`--continue`, `--resume`…), tipografía,
  scrollback y color de acento.
- **Cursor personalizable**: en Ajustes → Cursor puedes elegir estilos predefinidos,
  bloque, subrayado o barra vertical de 1 a 6 píxeles, y activar el parpadeo.
- **Modo claro y oscuro**: tema claro, oscuro o el del sistema, con color de acento configurable (y el terminal a juego).
- **Tono y acento a tu gusto**: en Ajustes → Apariencia elige una combinación de un
  clic (Sedimento, Grafito, Pizarra, Bosque, Tinta o Vino; cada una trae su acento) o
  ajusta el tono (matiz de 0 a 360° e intensidad; con intensidad 0 la interfaz es de
  grises puros). El acento admite cualquier color propio: usa el selector del sistema
  o escribe el hex. El contraste del texto es el mismo en todos los tonos, y si el
  acento elegido se confundiera con el fondo, trex lo acerca al blanco o al negro lo
  justo para que se lea. Los controles, menús, chat, tareas, equipos, ajustes y
  notificaciones comparten el mismo lenguaje visual. La ventana de Trex Browser
  lleva también tu tono, acento y modo claro u oscuro, y los sigue en cuanto los
  cambias (con una versión anterior del navegador conserva su tema oscuro).
- **Colores del terminal con vista previa**: Grafito, Océano, Bosque y Ciruela
  cambian solo los colores ANSI del terminal; el tono de la interfaz y el acento se
  eligen aparte. El código, los diffs y los errores mantienen sus colores
  informativos. Las preferencias guardadas siguen siendo compatibles.
- **Marco personalizable**: en Ajustes → Apariencia elige Compacto, Cómodo o
  Minimalista, o ajusta el redondeado, el margen y el borde. Los cambios se
  previsualizan en las terminales abiertas y se conservan al guardar.
- **Barra lateral organizada**: marca proyectos como favoritos desde su menú
  para tenerlos arriba. Las sesiones aparecen directamente dentro de su proyecto;
  los nombres completos se muestran al pasar el cursor o enfocar con el teclado.
- **Vista de proyectos**: bajo la búsqueda puedes mostrar Todos, solo Favoritos o
  Elegir uno o varios proyectos. La selección se conserva al reiniciar; la búsqueda
  se aplica dentro de esa vista y las sesiones de los proyectos ocultos siguen abiertas.
- **Movimiento ajustable**: transiciones breves entre sesiones y paneles, con
  reducción de animaciones en Ajustes → Apariencia y respeto a la preferencia del sistema.
- **Color completo en las terminales**: ANSI, 256 colores y RGB para Claude Code,
  Codex y los shells, incluso si trex se abre desde un entorno que desactiva colores.
- **Claude en pantalla completa**: usa su interfaz fullscreen dentro del terminal
  en Windows y Linux, también con aliases y cuentas separadas. La rejilla y el PTY
  se redimensionan juntos para evitar separadores duplicados al cambiar de pestaña.
- **Restauración de sesión**: al reabrir, recupera tus pestañas. Cada sesión
  restaurada arranca su proceso (shell, Claude Code o Codex) la primera vez que
  la abres, así que las que no usas no gastan memoria ni CPU.
- **Logo de cada proyecto**: la barra lateral muestra el icono de la app (el que
  enlaza `index.html`, los iconos de Tauri o archivos como `logo.svg` y
  `favicon.svg`); si no hay ninguno, la carpeta. Al abrir trex, las carpetas
  empiezan contraídas.
- **Actualizaciones de Claude Code y Codex**: trex compara la versión instalada
  con la última publicada en npm (respeta el canal `stable` de Claude Code) poco
  después de abrirse y cada pocas horas. Si hay una nueva, aparece en la barra
  lateral y en **Ajustes → Acerca de trex**; **Actualizar** ejecuta
  `claude update` o `codex update`. Las sesiones abiertas siguen con la versión
  anterior hasta reiniciarlas.

## Claude Code y Codex como chat

Desde **Nueva sesión (+) → Planear y ejecutar con agentes…**, describe la tarea
y elige por separado el perfil, el modelo y su nivel de esfuerzo para planificación
e implementación. Los esfuerzos disponibles corresponden al modelo elegido;
puedes conservar su valor predeterminado.
Puedes combinar Claude → Codex, Codex → Claude o dos modelos del mismo perfil.
Los modelos se consultan en cada cuenta, sin iniciar una respuesta.

La primera etapa permanece en modo de planificación con permisos de solo
lectura. Cuando devuelve un plan definitivo y termina correctamente, TREX lo
guarda completo y empieza la implementación en el mismo chat, con el modelo
elegido y los permisos habituales del ejecutor. Si necesita aclaraciones,
responde en ese mismo hilo. Cada respuesta identifica a su asistente; cada uno
conserva su propia cuenta, conversación, modelo y esfuerzo.

Para trabajos con varios pasos, el planificador recibe la indicación de publicar
las tareas del ejecutor. Las tareas confirmadas se entregan junto con el plan;
el ejecutor crea y actualiza su propia lista mientras trabaja. Cada participante
conserva su lista e identificadores en su propia sesión. Si el planificador no
publica tareas, el ejecutor puede crearlas a partir del plan. El panel muestra
únicamente las listas que las herramientas del asistente hayan confirmado: su
uso depende de que el agente disponga de esas herramientas y las invoque.

Puedes usar **Planear aquí** (en el menú **⋯** de la caja de mensaje) desde un chat existente para añadir el segundo
asistente conservando el historial y el perfil original en una de las etapas.
Después, **Nueva planificación** o `/plan tu nueva idea` inicia otro ciclo con el
contexto acumulado, sin crear más pestañas. `@planificador` y `@ejecutor` dirigen
mensajes a cada rol; `@Claude` y `@Codex` también funcionan si el proveedor
identifica a un único participante. Los mensajes normales se envían al destino
seleccionado. Los cambios de rol comparten un extracto acotado del historial,
sin sustituir el plan definitivo completo ni los permisos del asistente.
Cada rol recibe el contexto completo solo en su primera entrega; después, solo
las novedades del otro agente desde la última vez. El ejecutor recibe tu
petición original, el plan y las tareas, no el historial del planificador.

A la derecha, un único panel con pestañas **Equipo**, **Tareas** y **Git**
reúne el flujo, la lista de tareas y el repositorio (solo aparecen las que
tienen contenido). Recuerda la pestaña de cada chat, se cierra con `Esc` y,
en paneles estrechos, se abre como una hoja inferior sin tapar la caja de
mensaje. El control del flujo, en **Equipo**, muestra
los participantes, el estado y el ciclo; el botón **Modelos y esfuerzo del flujo**
despliega los ajustes de ambos agentes. Detener, nueva planificación y la revisión
de errores siguen disponibles en la misma tarjeta.

**Detener** pausa la transición y detiene la respuesta activa; los errores
también detienen el flujo. Al reabrir la aplicación, los flujos pendientes se
recuperan pausados para revisar su progreso antes de reanudarlos.

Con **Continuar con otro agente**, en el menú **⋯** de la caja de mensaje, puedes pasar el trabajo a
otro perfil: Claude 1 → Claude 2, Claude → Codex o en sentido contrario. Elige
el destino y su modelo, revisa el contexto y, si quieres, indica el siguiente paso. TREX
abre una conversación nueva en el mismo proyecto y conserva la original.
Los modelos se consultan en el perfil de destino sin iniciar una respuesta;
puedes elegir uno o conservar el predeterminado del perfil. La elección se
aplica desde el primer mensaje y se guarda con la pestaña.
Si el asistente está trabajando, detén la respuesta antes de transferirla.

Mientras un agente trabaja, el envío usa **En cola** de forma predeterminada.
El texto, las imágenes y las referencias a archivos se guardan localmente por
pestaña. Al terminar el turno, TREX entrega los pendientes como el siguiente
mensaje, en una sola petición y sin llamadas extra a herramientas. En tareas
largas el agente puede adelantarse con `trex_read_messages` tras un paso
importante; no consulta la cola en bucle ni antes de cada respuesta. La bandeja
muestra los pendientes y permite editarlos o cancelarlos hasta que comience su
lectura. Cada mensaje tiene un botón **Enviar ahora** que conserva sus adjuntos;
en Trex CLI detiene el turno anterior antes de entregar la corrección. Editar un
mensaje conserva su posición y no altera el borrador del campo principal.

Si no se puede confirmar un envío directo, el mensaje permanece guardado para
revisión. Comprueba la conversación antes de restaurarlo a la cola: reenviarlo
sin revisar podría repetir una instrucción ya recibida.

Si termina correctamente con mensajes pendientes, TREX los envía juntos como
un único mensaje con su recibo, una vez por lote; el recibo solo se confirma
cuando el asistente acepta el turno. Al detenerlo, fallar o restaurar
la aplicación, los mensajes quedan pendientes: pulsa **Continuar con la cola**
para retomarlos. La lectura depende del agente y no tiene un plazo garantizado.
Lee o cancela la cola antes de empezar una conversación nueva o transferirla.
Esta función pertenece a la vista de chat; los perfiles que abren terminal usan
los controles propios de su CLI.

Codex usa un servidor [MCP del App Server](https://learn.chatgpt.com/docs/app-server)
configurado para esa sesión, también al reanudar o regenerar conversaciones.
Claude usa una [herramienta MCP del Agent SDK](https://code.claude.com/docs/en/agent-sdk/custom-tools)
sobre el canal JSON existente. Los mensajes solo se extraen al invocar la
herramienta, con un recibo persistente para poder reintentar la entrega.

El relevo se prepara con el historial local disponible y el estado actual de
Git, sin pedir una respuesta al asistente anterior. Conserva el objetivo, las
instrucciones recientes, el último plan y las tareas, además de decisiones y
resultados registrados; los relevos posteriores conservan esos antecedentes
de forma acotada. El nuevo asistente comprueba los archivos antes de seguir.
El historial puede estar incompleto y se recorta si es largo. Las imágenes
adjuntas se omiten: consulta el chat original o adjúntalas de nuevo si hacen
falta. La transferencia requiere otro perfil compatible con la vista de chat;
los que fijan una conversación o usan un modo especial aparecen deshabilitados.

Las conversaciones largas muestran sus mensajes más recientes y cargan los
anteriores al subir (o con **Mostrar mensajes anteriores**), sin mover lo que
estás leyendo. Una pestaña oculta no repinta su conversación mientras el
asistente trabaja: se pone al día al volver a ella.

Al pegar o adjuntar imágenes, la caja inserta citas como **[Imagen 1]** en el
cursor y numera las miniaturas. Ambos asistentes reciben esas mismas etiquetas
junto a cada imagen. Al quitar un adjunto se eliminan sus citas y se renumeran
las restantes; editar o reenviar un mensaje conserva la correspondencia. Las
citas se resaltan mientras escribes y, ya enviadas, se ven como etiquetas con
la miniatura de la imagen o el nombre del archivo.

También puedes adjuntar **archivos de cualquier tipo** (PDF, hojas de cálculo,
código, documentos…) con el clip, arrastrándolos o pegándolos. Se citan como
**[Archivo 1]** y el mensaje lleva su ruta para que el asistente los lea con sus
herramientas; los que llegan sin ruta (arrastrados o pegados) se guardan antes
en la carpeta de datos de TREX.

En sentido contrario, **los asistentes te envían archivos** por el chat. Claude
Code, Codex, Trex CLI y Antigravity saben que un enlace a un archivo local en
una línea propia se muestra como una **tarjeta** con su tipo, tamaño y carpeta.
Funciona también con rutas de Windows, aunque lleven espacios o carpetas como
`.github`. La tarjeta tiene botones para abrirlo con la aplicación del sistema,
mostrarlo en su carpeta o **guardar una copia** donde elijas. Al pulsarla, el
archivo se abre en el **visor de la app**:

- el Markdown se lee con el formato del chat;
- el código lleva colores y números de línea;
- los CSV se ven como tabla;
- los PDF se ven con el visor de PDF integrado (en Linux se abren con el sistema);
- el HTML y el SVG se muestran aislados, sin scripts ni conexión.

El Markdown, los CSV, el HTML y el SVG pasan de su vista al **código** con un
botón. Las imágenes se amplían en el visor de imágenes. Word, Excel y los
comprimidos se abren con su aplicación. Un enlace dentro de una frase se abre
igual al pulsarlo.

Pulsa el nombre de la **rama de Git** junto a la caja del chat para buscar entre
las ramas locales y las remotas conocidas, cambiar de rama o **Crear y cambiar**
a una nueva desde la actual. La rama activa queda marcada y el indicador se
actualiza en los otros chats del proyecto. Si Git detecta que el cambio
sobrescribiría archivos pendientes, muestra su error y conserva los cambios.
Mientras el agente de ese chat trabaja puedes consultar las ramas; el cambio y la creación
se habilitan al terminar la tarea.

Los mensajes ofrecen tres iconos: **Editar**, **Reenviar** y **Copiar**. Editar
carga el texto y sus imágenes en la caja; al guardar, sustituye ese mensaje y
regenera las respuestas desde ese punto. `Esc` cancela y recupera tu borrador.
La conversación original queda conservada en el historial del asistente; los
archivos que ya se modificaron permanecen en el proyecto. Reenviar envía una
copia nueva del mensaje. Las respuestas también ofrecen copiar y regenerar.

Al completar cada tarea aparece un **resumen de cambios** con los archivos
editados, agrupados por carpetas, y las líneas añadidas y eliminadas. Despliega
una carpeta o un archivo para revisar sus diferencias, o usa el icono de diff
para abrirlas todas. El resumen se obtiene de las ediciones que informa el
asistente, utiliza el diff neto de Codex cuando está disponible y se conserva
al recuperar el historial. Los comandos de shell que no informan de sus
ediciones pueden no aparecer en la tarjeta.

Las sesiones de Claude Code y de Codex se abren como una conversación, igual
que en una app de chat: escribes abajo (`Enter` envía, `Shift+Enter` añade una
línea) y la respuesta aparece con formato, bloques de código y tablas. Por
detrás, trex ejecuta tu CLI instalado sin terminal, con la misma cuenta,
carpeta y argumentos del perfil: `claude -p` con `stream-json`, o
`codex app-server`.

- **Herramientas**: cada lectura, búsqueda, edición o comando aparece como una
  fila; al pulsarla ves el diff o la salida. **Tareas**, arriba a la derecha,
  está disponible también en chats normales con un solo agente. Para trabajos
  con varios pasos, el agente recibe indicaciones para publicar y actualizar
  su lista sin cambiar al modo Planificar. También puedes pedirle una lista
  directamente en el chat. El panel se abre con la primera lista confirmada;
  si lo contraes, las actualizaciones mantienen tu elección.
- **Terminales del agente**: una pestaña sobre el mensaje cuenta los procesos
  activos. Al abrirla hacia arriba puedes consultar su salida y detener cada
  terminal por separado. Planificación y mensajes en cola usan la misma bandeja;
  al plegarla se conservan los borradores. Los adjuntos se desplazan en una fila
  y el texto tiene altura limitada para dejar espacio al historial.
- **Permisos**: cuando el asistente necesita permiso, aparece una tarjeta con
  **Permitir**, la opción de permitirlo en la sesión o siempre, y **Denegar**.
  El panel **Ajustes del agente**, debajo del mensaje, cambia el modo: Preguntar, Aceptar
  ediciones, Planificar o Permitir todo en Claude; Solo lectura, Automático,
  Planificar o Permitir todo en Codex. **Permitir todo** se aplica al momento:
  lo que estaba esperando permiso se acepta y no vuelve a preguntar (las
  preguntas con opciones y los planes sí esperan tu respuesta). Cada pestaña
  recuerda su modo al reabrir trex y los chats nuevos empiezan con el último
  que elegiste. El acceso al panel indica **Acceso total**, **Solo lectura** o
  **Planificar** cuando corresponde, para mantener visible el modo activo.
- **Contexto**: en Claude y en Codex, el anillo de la bandeja muestra desde
  que abres el chat qué parte de la ventana de contexto ocupa la conversación;
  se pone ámbar al 70 % y rojo al 90 %. Al pulsarlo ves el desglose (en Claude,
  lo mismo que `/context`; en Codex, también los tokens de toda la
  conversación) y puedes resumirla con `/compact`. Las cifras de tokens
  muestran los **tokens nuevos** (entrada sin caché, salida y escritura de
  caché); las lecturas de caché, mucho más baratas, aparecen aparte junto al
  coste cuando el proveedor lo informa.
- **Resumen automático (opcional)**: en **Ajustes → Asistentes** puedes activar,
  por separado para Claude Code, Codex y Trex CLI, que la conversación se resuma
  sola al llegar a un número de tokens que eliges tú. Está apagado: sin
  activarlo, cada asistente resume cuando él decide (Claude Code y Codex, cerca
  del límite del modelo). trex no envía `/compact`: le pasa el umbral al propio
  asistente, que también actúa a mitad de un turno largo. Se aplica a las
  conversaciones que abras o reanudes después de guardar, y un umbral escrito
  en los argumentos del perfil (`--autocompact` en Claude Code,
  `-c model_auto_compact_token_limit=…` en Codex) tiene prioridad. Claude Code
  toma el valor como tamaño de la ventana y resume unos 33.000 tokens antes.
  Resumir antes hace que cada turno relea menos contexto; a cambio, un resumen
  puede perder detalles.
- **Modelo y esfuerzo**: el modelo tiene un acceso propio; **Ajustes del agente**
  agrupa permisos, esfuerzo y velocidad. Solo aparecen los niveles que admite
  cada modelo. En Codex se aplican desde el siguiente mensaje.
- **Planes**: en modo Planificar, Codex muestra el plan entero con un botón
  **Implementar el plan**, que vuelve al modo en que trabajabas y lo pone en
  marcha.
- **Imágenes**: pega una captura (`Ctrl+V` o tu atajo de pegado), arrástrala a
  la conversación o usa el clip. Se reducen a 1920 px y se comprimen antes de
  enviarlas; puedes quitar cualquiera antes de pulsar Enter.
- **Preguntas**: cuando el asistente necesita que elijas (AskUserQuestion en
  Claude, preguntas de Codex), la pregunta ocupa el sitio de la caja de
  mensaje con sus opciones numeradas, la recomendada marcada y un campo para
  escribir otra respuesta. Pulsa el número o la opción para responder; con
  varias preguntas se avanza una a una y con **Atrás** se vuelve. Si Claude
  adjunta vistas previas, se ven al lado al pasar por cada opción. **Omitir**
  deja que el asistente siga a su criterio. Lo que respondiste queda en el
  hilo. Si el asistente escribe una pregunta de elección con una lista de
  opciones en el mensaje, también se puede responder desde este panel; la
  elección se envía como mensaje y **Omitir** cierra el panel sin enviar nada.
  Codex pregunta así también fuera del modo Planificar (trex activa su
  función `default_mode_request_user_input`; un perfil con
  `--disable default_mode_request_user_input` la apaga).
- **Uso del plan**: el visor mantiene visibles los porcentajes y las barras de
  **5 horas** y **semana** junto al contexto; **—** indica un dato no disponible.
  Al pulsarlo ves
  ambos desgloses, cada ventana con su reinicio y el uso extra. Si un límite
  necesita atención, su nombre y porcentaje aparecen en el acceso. **Uso de las
  cuentas** (el medidor de la barra lateral o la paleta de comandos) muestra
  a la vez el de todos tus perfiles, como `/usage` en cada asistente: trex
  lanza el CLI un momento sin enviar mensajes, así que no gasta tokens.
- **Menciones con `@`**: escribe `@` para buscar archivos y carpetas del
  proyecto (respeta el `.gitignore`); en Claude también aparecen sus
  subagentes (`@agent-Explore`). `Tab` entra en una carpeta.
- **Comandos con `/`**: al principio del mensaje, `/` lista los comandos. En
  Claude son los de tu Claude Code (`/context`, `/compact`, tus skills…). En
  Codex, trex ofrece los suyos: `/new`, `/compact`, `/review`, `/init`,
  `/status` y `/mcp`. En ambos chats, **`$` abre las skills** de la sesión:
  escribe parte de su nombre, elige con las flechas y pulsa `Enter` o `Tab`
  para insertar `$nombre` dentro de tu mensaje. Puedes citar varias skills;
  elegirlas conserva el borrador y no envía el mensaje. `Esc` cierra la lista.
  El catálogo respeta el proyecto, la cuenta y los plugins del perfil y se
  vuelve a consultar al abrirlo. En los dos, `/model`,
  `/effort` y `/permissions` abren los selectores y `/clear` (o `/new`) empieza
  una conversación nueva.
- **Detener**: `Esc` o el botón cuadrado interrumpen la respuesta en curso. En
  Codex, lo que escribas mientras trabaja se suma a la respuesta en curso.
- **Continuar**: la conversación se guarda en el historial del asistente; al
  reabrir trex o al recuperarla se muestra de nuevo y sigue donde quedó.

Los perfiles de Codex con opciones que solo existen en la terminal (otro
subcomando, `--profile`, `--remote`…) siguen abriéndose como terminal.

## Perfiles y varias cuentas

En **Ajustes → Asistentes** puedes añadir, duplicar y nombrar tantos perfiles
como necesites. Cada uno tiene su propio comando, argumentos, shell y método de
inicio. Por ejemplo:

| Nombre | Tipo | Comando |
|---|---|---|
| Claude 1 | Claude Code | `claude1` |
| Claude 2 | Claude Code | `claude2` |
| Codex | Codex | `codex` |

Los comandos deben existir en tu equipo. En bash, zsh y fish también puedes
usar alias o funciones definidos en el shell elegido. El botón `+`, el menú de
cada proyecto y su pantalla de inicio ofrecen todos los perfiles. `Ctrl+T`
abre el que marques como predeterminado; puedes mantener varias sesiones de
cualquier perfil abiertas al mismo tiempo.

Si tus comandos ya seleccionan su cuenta, deja vacía **Carpeta de configuración**.
También puedes indicar una carpeta distinta por perfil en sus opciones avanzadas:
se pasa como `CLAUDE_CONFIG_DIR` para Claude Code o `CODEX_HOME` para Codex.
Usa una ruta completa o `~/...`. La cuenta se autentica desde el propio CLI;
trex no copia credenciales. Consulta las referencias oficiales de
[Claude Code](https://code.claude.com/docs/en/env-vars) y
[Codex](https://developers.openai.com/codex/config-advanced/).

Las pestañas abiertas conservan su comando y perfil, incluso al reiniciar trex.
Editar o eliminar un perfil afecta al menú de sesiones nuevas y no cambia las
sesiones que ya estaban abiertas. La configuración anterior de Claude se migra
a un perfil y se añade un perfil inicial de Codex.

## Trex CLI opcional y conexiones API

El instalador de Windows ofrece **Instalar Trex CLI (modelos con API key)**.
La casilla empieza desmarcada y las actualizaciones recuerdan la elección.
Sin el CLI, Trex conserva el flujo de Claude Code y Codex. Quitar el componente
conserva las conexiones, las claves y los historiales para recuperarlos después.

Con el componente instalado, abre **Ajustes → Asistentes → Trex API**. Crea una
conexión por cuenta con su nombre, proveedor, dirección API y credencial.
Trex consulta automáticamente el catálogo al abrir una conexión con clave guardada;
para una conexión nueva, lo consulta al terminar de introducir la credencial.
Elige el modelo de la lista y guarda la conexión. **Actualizar** vuelve a consultar
el catálogo; si el proveedor no lo ofrece o rechaza el acceso, puedes usar un ID
manual. Consultar modelos no genera respuestas ni comprueba saldo o permisos de uso.
Por ejemplo, **TREX1** para DeepSeek, **TREX2** para MiniMax, **TREX3**
para OpenRouter y **TREX5** para Anthropic. También admite endpoints personalizados
compatibles con Chat Completions. Guardar la conexión modifica el CLI al instante; **Guardar cambios**
conserva su referencia en la lista de asistentes de la app. La clave no se guarda
en la configuración de Trex, los argumentos del proceso ni el historial del chat.

**Anthropic** usa la API de Mensajes nativa con una clave `sk-ant-…` de la Consola
de tu organización (no la suscripción de Claude). Esa clave consume el saldo y los
créditos de la organización, incluidos los promocionales cuando la cuenta los
tiene. Trex activa el razonamiento adaptativo, la caché de prompts automática y los
niveles de esfuerzo que el catálogo de Anthropic declara para cada modelo, y
muestra el uso real (entrada, salida y caché) en el panel de uso.

En MiniMax puedes introducir una **API Key** de pago por uso o una
**Subscription Key** de M Plan / Token Plan. Son credenciales de productos distintos;
introduce una sola, sin el prefijo `Bearer`. El CLI añade la autenticación al consultar
el catálogo y al enviar mensajes. Una clave de suscripción puede no tener acceso
al catálogo aunque sí permita usar un modelo. Véase la
[configuración oficial de MiniMax](https://platform.minimax.io/docs/m-plan/other-tools).

El visor usa el límite de contexto que publica el endpoint para el modelo elegido.
Si MiniMax no lo incluye en el catálogo, aplica su
[especificación oficial](https://platform.minimax.io/docs/api-reference/text-openai-api) para
**MiniMax-M3.1-Flash** y **MiniMax-M3**: **1.000.000 de tokens**, entre entrada y
salida. Los endpoints personalizados conservan su propio límite; si no lo informan,
se indica que no está disponible. El contexto de la última solicitud y los tokens
procesados en toda la conversación se muestran por separado.

Para ahorrar tokens, el CLI compacta la conversación antes de superar 128.000
tokens activos aunque el modelo admita un millón, archiva los resultados de
herramientas de turnos anteriores (recuperables con `history_search`), reenvía
como máximo 3 imágenes de turnos previos y recorta las salidas largas
conservando el principio y, sobre todo, el final. Las herramientas avanzadas del
navegador (rendimiento, trazas, vídeo, sesiones) se activan bajo demanda con
`enable_tools`. Con modelos `anthropic/*` de OpenRouter activa la caché de
prompts, y si el proveedor no informa del coste lo estima con los precios
configurados, incluidos los de caché. Los ajustes están en
[trex-cli/README.md](../trex-cli/README.md).

Cada perfil puede abrir un chat, planificar o ejecutar en un chat compartido,
incluyendo dos modelos del mismo proveedor. El catálogo determina los esfuerzos
disponibles. Los mensajes enviados durante un turno van a la bandeja que el agente
consulta con `trex_read_messages`. El modo **Planificar** impide las escrituras y
los comandos de shell; **Preguntar** solicita permiso para cada modificación o
comando, y **Permitir todo** los autoriza. Una sesión interrumpida con herramientas
inciertas requiere revisar sus archivos y confirmar `/recover`; el chat compartido
lo confirma al pulsar la acción de reanudación después de revisar el historial.

El ejecutable `trex-agent.exe` queda junto a `trex.exe`; el instalador no modifica
PATH ni los perfiles del shell. Puede ejecutarse desde su ruta completa:

```powershell
& 'RUTA_DE_INSTALACION\trex-agent.exe' profiles list --json
& 'RUTA_DE_INSTALACION\trex-agent.exe' --profile TREX1 models list --json
& 'RUTA_DE_INSTALACION\trex-agent.exe' --profile TREX1 chat --mode plan --cwd 'D:\proyecto'
```

El CLI guarda las conexiones e historiales en la carpeta de datos `trex-agent`
del usuario; `TREX_HOME` permite seleccionar otra carpeta. En Windows protege las
claves con DPAPI; en Linux/macOS utiliza el almacén seguro del sistema. Los
perfiles con un `TREX_HOME` personalizado siguen funcionando en el chat, pero su
gestión se realiza desde el CLI con esa misma carpeta. El visor de uso muestra
tokens y el coste que informe la API, en lugar de cuotas de cinco horas o semana.

## Cursor de texto

El cursor se previsualiza antes de guardar y se aplica a todas las terminales
abiertas en Windows y Linux. **Automático** conserva el cursor que elija cada
aplicación; al elegir una forma propia, Claude Code y Codex respetan tu estilo.
El color sigue el acento de **Ajustes → Apariencia**.

## Trabajar con hasta cuatro terminales

En **Distribución de terminales**, en la cabecera, elige una terminal, dos
columnas, dos filas o **Cuatro paneles · 2 × 2**. Puedes dividir la vista aunque
solo tengas una sesión abierta: los paneles libres permiten elegir una sesión
del proyecto o abrir otra con cualquier perfil, incluido un shell. Puedes usar
cuatro Claude, cuatro Codex o mezclarlos; cada sesión ocupa un solo panel.

El selector de cada panel permite cambiar su sesión o abrir una nueva. Su botón
de ampliar muestra solo esa terminal y permite restaurar la misma distribución,
conservando las demás abiertas. Al cerrar
una sesión, su panel queda libre. Arrastra los separadores para ajustar ancho y
alto, o enfócalos y usa las flechas; `Home` los devuelve al 50 %.
`Ctrl+Shift+S` alterna entre una terminal y dos columnas; `Ctrl+Alt+O` recorre los
paneles ocupados. La distribución se guarda por proyecto, y las divisiones
anteriores de dos terminales se conservan al actualizar.

## Recuperar una conversación

En **Nueva sesión → Recuperar conversación** elige un perfil y una conversación
del proyecto actual. TREX lee su historial local y abre una terminal con
`claude --resume ID` o `codex resume ID`, conservando las opciones y la cuenta de
ese perfil. Las pestañas recuperadas conservan el comando de continuación al
reiniciar la app. La recuperación requiere que el historial siga en el equipo.

Indica **Carpeta de configuración** cuando un alias o función del shell elige
una cuenta distinta: TREX necesita esa ruta para localizar su historial. Si está
vacía, usa `CLAUDE_CONFIG_DIR` o `CODEX_HOME` del entorno de la app y, en su
defecto, `~/.claude` o `~/.codex`. El selector lee el sistema de archivos donde
se ejecuta TREX; un historial alojado dentro de WSL requiere una ruta accesible
desde Windows. Los perfiles que ya incluyen `--resume`, `--continue` o un modo
no interactivo muestran una indicación para usar otro perfil.

## Capturas y notificaciones

El pegado de imágenes muestra una vista previa por defecto. **Pegar imagen**
adjunta la captura a la sesión indicada; después puedes escribir el mensaje y
enviarlo desde el asistente. **Cancelar** conserva la conversación. Si el
portapapeles cambia mientras revisas la imagen, TREX pide que vuelvas a pegarla.
Puedes desactivar la revisión en **Ajustes → Terminal**.

En **Ajustes → Notificaciones** activa o silencia los avisos del escritorio y
elige si quieres recibirlos mientras usas TREX. **Probar y habilitar
notificaciones** comprueba los permisos y envía un aviso de prueba. Windows
requiere la app instalada; Linux utiliza el servicio de notificaciones del
escritorio, según el [plugin de Tauri](https://v2.tauri.app/plugin/notification/).
El historial de avisos de la cabecera sigue disponible.

## Atajos

En **Ajustes → Atajos** puedes cambiar las acciones de esta tabla pulsando una
combinación en su campo. **Pegar texto e imágenes** conserva `Ctrl+V` como valor
predeterminado. Los cambios se aplican al guardar a las terminales abiertas y
se conservan al reiniciar. Las combinaciones duplicadas se rechazan.

trex consulta el portapapeles nativo de Windows y Linux (X11 y Wayland): pega el
texto con el modo de pegado del terminal, y para las capturas activa el adjunto
del asistente. Claude Code recibe `Alt+V` en Windows y `Ctrl+V` en Linux; Codex
recibe `Ctrl+V` en ambos. `Ctrl+Shift+V` sigue disponible para pegar. Las imágenes
se adjuntan en las sesiones de asistentes; los shells normales reciben texto.

| Atajo | Acción |
|---|---|
| `Ctrl+V` (configurable) | Pegar texto o adjuntar una imagen en Claude Code y Codex |
| `Ctrl+K` | Paleta de comandos |
| `Ctrl+Shift+K` | Buscar proyectos y sesiones en la barra lateral |
| `Ctrl+Shift+S` | Dividir o unir terminales |
| `Ctrl+Alt+O` | Enfocar el otro panel |
| `Ctrl+Shift+R` | Recuperar una conversación |
| `Ctrl+T` | Nueva sesión del perfil predeterminado en el proyecto activo |
| `Ctrl+Shift+T` | Nueva terminal (shell limpio) |
| `Ctrl+W` | Cerrar pestaña |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | Cambiar de pestaña |
| `Ctrl+1..9` | Ir a la pestaña N |
| `Ctrl+F` | Buscar en la terminal |
| `Ctrl+Shift+C` / `Ctrl+Shift+V` | Copiar / pegar |
| `Ctrl+=` / `Ctrl+-` / `Ctrl+0` | Tamaño de fuente |
| `Ctrl+,` | Ajustes |
| `Ctrl+Shift+L` | Alternar entre modo claro y oscuro |
| `Ctrl+Shift+E` | Abrir el proyecto en el explorador |

`Ctrl+1…9` mantiene la selección de sesiones; `Ctrl+Shift+V` sigue disponible
como pegado alternativo. `Ctrl+C`, `Ctrl+D` y `Ctrl+Z` se reservan para el shell.

## Notas

- Si Claude Code no aparece, instálalo con el instalador nativo:
  - Windows (PowerShell): `irm https://claude.ai/install.ps1 | iex`
  - Linux/macOS: `curl -fsSL https://claude.ai/install.sh | bash`
  - Alternativa: `npm install -g @anthropic-ai/claude-code`


## Navegador opcional para los agentes

Trex Browser se instala por separado y también puede seleccionarse en el instalador de trex, independientemente de Trex CLI. Incluye su propio runtime: no necesitas instalar Node ni npm. Utiliza Chrome con perfiles privados por proyecto, `BROWSER1` a `BROWSER99`.

En **Ajustes → Navegador** puedes comprobar la instalación, crear perfiles y permitir el navegador en nuevas conversaciones. Claude Code, Codex y Trex API reciben sus herramientas automáticamente cuando el componente está disponible. El planificador usa observación; los permisos de implementación determinan el acceso de pruebas o completo.

El control **Navegador** del chat permite abrir una dirección, tomar capturas, grabar/detener vídeo y pausar la automatización para revisar la página. Las capturas y vídeos generados aparecen como archivos locales. Los agentes también pueden usar consola, red, trazas, perfiles de CPU y memoria, y mediciones de rendimiento.

Trex prepara el servicio del navegador desde la app antes de conectar Claude o Codex, sin abrir Chrome todavía. Así puede utilizarlo un agente cuyo proceso MCP está restringido por Windows. La ventana se abre automáticamente en la primera navegación. Codex comprueba las herramientas del chat antes de enviar el primer turno; una conexión fallida no se presenta como un navegador conectado. Los chats abiertos antes de actualizar deben reiniciarse para cargar la nueva conexión.

La interfaz CLI/MCP, los modos y las pruebas del componente están documentados en [trex-browser/README.md](../trex-browser/README.md). Las capturas se envían como imágenes únicamente a modelos con soporte de visión confirmado; los demás conservan el acceso a DOM, consola y red. Una operación incierta requiere revisión y no se repite automáticamente.

## Fedora

La app, Trex CLI y Trex Browser se empaquetan juntos en un RPM. El navegador usa Chromium instalado en Fedora y un runtime privado de Node/Playwright; las claves se guardan en Secret Service. Consulta [instalación, compilación y pruebas en Fedora](fedora.md), incluidos los requisitos del llavero y los límites de validación del escritorio.

## Equipos con agente principal

En **Nueva sesión → Configurar flujo de agentes → Equipo** puedes elegir un coordinador y entre uno y ocho colaboradores. Cada participante elige su cuenta, función, modelo, esfuerzo, velocidad (rápida, si el modelo la admite), permisos e instrucciones independientemente; puedes combinar Claude, Codex y conexiones API de Trex, o usar una misma cuenta con modelos diferentes. El selector **Dos agentes / Equipo** del diálogo alterna con el flujo de planificación e implementación.

La ventana de planificación solo configura los agentes: funciones, cuentas, modelos, esfuerzo e instrucciones reutilizables. Ordena los subagentes con las flechas y pulsa **Guardar y abrir chat**. No hay que escribir una idea en esa ventana. En el nuevo chat verás el equipo guardado y podrás escribir tu idea normalmente; el trabajo empieza al enviar ese mensaje al principal. El flujo de dos agentes funciona igual: se guarda primero y el primer mensaje inicia la planificación. Al convertir un chat existente, su contexto se conserva para ese primer mensaje y no se envía automáticamente.

El principal planifica, asigna tareas mediante herramientas y evalúa los informes antes de continuar. Respeta el orden inicial configurado cuando las funciones sean necesarias y puede volver a revisión o corrección según los hallazgos. No edita archivos directamente. Los colaboradores pueden implementar, revisar código, corregir errores, investigar o cumplir una función personalizada. Los revisores de solo lectura conservan restricciones nativas; los colaboradores con escritura utilizan los permisos normales de su asistente. La investigación web requiere las herramientas web del asistente o Trex Browser habilitado e instalado.

El chat reúne los historiales con el nombre de su participante y conserva el destino de cada aprobación. La lista **Tareas**, arriba a la derecha, muestra el plan, responsables, progreso e informes. El principal publica el plan antes de delegar; las confirmaciones de cada delegación actualizan su estado. Dentro del chat puedes desplegar la actividad de cada subagente, su modelo y esfuerzo, instrucciones, herramientas y resultados. Las solicitudes de permiso permanecen visibles fuera de las tarjetas plegables. **Cuentas y recuperación** conserva las acciones de historial y revisión. Se ejecuta una tarea a la vez dentro del equipo; no se aíslan los cambios en worktrees ni se bloquean otros chats que utilicen el mismo proyecto.

**Detener equipo** interrumpe todas sus sesiones. Al recuperar un equipo, empieza en pausa y requiere revisión explícita. Las entregas iniciadas sin confirmación permanecen inciertas: reanudar no las vuelve a ejecutar. Trex CLI puede requerir además **Confirmar revisión de operaciones** en el participante afectado. Las aclaraciones se añaden a la cola del principal.

Límites por equipo: ocho colaboradores, 32 tareas por ciclo y 128 en total; tarea delegada de hasta 16 KiB. El plan admite 32 pasos y 48 KiB en conjunto. Publicarlo no ejecuta las tareas. Un equipo usa los modelos y servicios configurados por el usuario; cada sesión consume su cuota habitual.

### Consumo de tokens en los equipos

- **Modelo y esfuerzo por función**: al elegir la función de un participante, el diálogo sugiere un modelo y un esfuerzo acordes (investigación con un modelo económico y esfuerzo bajo, revisión y corrección con uno intermedio, principal e implementación con el del perfil). Solo rellena lo que no hayas elegido tú y lo indica con «Sugerido para esta función».
- **Resumen antes de empezar**: el pie del diálogo muestra cuántos agentes usan cada cuenta y el porcentaje de sus límites de 5 horas y semana (consultarlo no gasta tokens), con avisos si una cuenta supera el 75 % o la comparten tres o más agentes.
- **Presupuesto**: puedes limitar los tokens nuevos del equipo y de cada agente. Las delegaciones informan del presupuesto restante; al agotarse, la tarea no empieza y el equipo se pausa con opciones para ampliarlo o quitar los límites. Los tokens nuevos excluyen las lecturas de caché, que se muestran aparte.
- **Uso visible**: la pestaña **Equipo** muestra el total del equipo, la barra de presupuesto y, agrupados por cuenta, el contexto, los tokens nuevos, el coste conocido y la cuota de cada participante. El principal recibe esos datos y prefiere a los miembros con margen; una cuenta al 98 % o rechazada bloquea nuevas delegaciones a ese miembro.
- **Contexto justo por función**: la investigación no recibe instantánea de Git, la revisión recibe las diferencias y el resto solo la rama y el estado. El navegador se asigna por función (puedes cambiarlo por agente). Antes de una tarea nueva, un miembro con el contexto al 50 % o más se compacta una vez.
- **Informes breves**: se piden informes de unas 500 palabras con rutas en lugar de código. Si uno supera 32 KiB ya no falla: el texto completo se guarda en la carpeta de datos de TREX y la tarea conserva el principio y el final con la ruta.
- **Coordinación sin sondeos**: el principal no espera consultando el estado; TREX abre un turno nuevo cuando terminan las delegaciones y una consulta devuelve los informes nuevos una sola vez.

En chats individuales, el mismo panel muestra las tareas publicadas por Claude y Codex y los planes de Trex CLI, con pendientes, trabajo en curso y tareas completadas. No hace falta configurar un equipo ni cambiar de modo. Puedes abrir **Tareas** desde el inicio o contraerlo para ampliar el chat; abrir el panel no envía mensajes al modelo. Los estados se reconstruyen a partir de los resultados de tareas que devuelve el historial del asistente; un error o actualización incompleta no marca tareas como terminadas. En ventanas estrechas, la lista se coloca encima del chat y permite desplazarse sin tapar el borrador.
