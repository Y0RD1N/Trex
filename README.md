# trex

Terminal de escritorio para **Windows y Linux** pensada para trabajar con
**Claude Code y Codex**: guardas tus proyectos y abres sesiones dentro de su
carpeta, con el asistente y el perfil que elijas.

## ✨ Qué hace

- **Proyectos**: añades carpetas una sola vez y quedan en la barra lateral.
- **Perfiles de asistentes**: el botón `+` permite elegir Claude Code, Codex
  o cualquiera de tus perfiles personalizados, dentro de la carpeta del proyecto.
- **Pestañas**: varias terminales por proyecto, todas vivas a la vez.
  `Ctrl+T` (perfil predeterminado) y `Ctrl+Shift+T` (shell limpio).
- **Terminal dividida**: dos sesiones en columnas o filas, o hasta cuatro en una
  cuadrícula 2 × 2 por proyecto, con separadores ajustables y foco independiente.
- **Paleta de comandos**: `Ctrl+K` busca acciones, proyectos, perfiles y sesiones.
- **Recuperar conversaciones**: continúa el historial local de Claude Code o
  Codex desde el menú de nueva sesión o con `Ctrl+Shift+R`.
- **Vista previa de capturas**: revisa la imagen y la sesión de destino antes de
  adjuntarla. El texto se pega directamente.
- **Atajos personalizables**: cambia las combinaciones en Ajustes → Atajos,
  con detección de conflictos y opción de restablecer los valores iniciales.
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
- **Paletas completas con vista previa**: Grafito, Océano, Bosque y Ciruela combinan
  la interfaz, el texto, los colores ANSI y la selección del terminal en claro y oscuro.
- **Marco personalizable**: en Ajustes → Apariencia elige Compacto, Cómodo o
  Minimalista, o ajusta el redondeado, el margen y el borde. Los cambios se
  previsualizan en las terminales abiertas y se conservan al guardar.
- **Barra lateral organizada**: marca proyectos como favoritos desde su menú
  para tenerlos arriba. Las sesiones aparecen directamente dentro de su proyecto;
  los nombres completos se muestran al pasar el cursor o enfocar con el teclado.
- **Movimiento ajustable**: transiciones breves entre sesiones y paneles, con
  reducción de animaciones en Ajustes → Apariencia y respeto a la preferencia del sistema.
- **Color completo en las terminales**: ANSI, 256 colores y RGB para Claude Code,
  Codex y los shells, incluso si trex se abre desde un entorno que desactiva colores.
- **Claude en pantalla completa**: usa su interfaz fullscreen dentro del terminal
  en Windows y Linux, también con aliases y cuentas separadas. La rejilla y el PTY
  se redimensionan juntos para evitar separadores duplicados al cambiar de pestaña.
- **Restauración de sesión**: al reabrir, recupera tus pestañas.

## Claude Code y Codex como chat

Las sesiones de Claude Code y de Codex se abren como una conversación, igual
que en una app de chat: escribes abajo (`Enter` envía, `Shift+Enter` añade una
línea) y la respuesta aparece con formato, bloques de código y tablas. Por
detrás, trex ejecuta tu CLI instalado sin terminal, con la misma cuenta,
carpeta y argumentos del perfil: `claude -p` con `stream-json`, o
`codex app-server`.

- **Herramientas**: cada lectura, búsqueda, edición o comando aparece como una
  fila; al pulsarla ves el diff o la salida. La lista de tareas se muestra
  como una checklist.
- **Permisos**: cuando el asistente necesita permiso, aparece una tarjeta con
  **Permitir**, la opción de permitirlo en la sesión o siempre, y **Denegar**.
  El selector de la caja de mensaje cambia el modo: Preguntar, Aceptar
  ediciones, Planificar o Permitir todo en Claude; Solo lectura, Automático,
  Planificar o Permitir todo en Codex. **Permitir todo** se aplica al momento:
  lo que estaba esperando permiso se acepta y no vuelve a preguntar (las
  preguntas con opciones y los planes sí esperan tu respuesta). Cada pestaña
  recuerda su modo al reabrir trex y los chats nuevos empiezan con el último
  que elegiste.
- **Contexto**: en Claude y en Codex, el anillo de la bandeja muestra desde
  que abres el chat qué parte de la ventana de contexto ocupa la conversación;
  se pone ámbar al 70 % y rojo al 90 %. Al pulsarlo ves el desglose (en Claude,
  lo mismo que `/context`; en Codex, también los tokens de toda la
  conversación) y puedes resumirla con `/compact`.
- **Modelo y esfuerzo**: los selectores muestran los modelos de tu cuenta y
  solo los niveles de esfuerzo que admite cada uno. En Codex se aplican desde
  el siguiente mensaje.
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
  hilo. Codex pregunta así también fuera del modo Planificar (trex activa su
  función `default_mode_request_user_input`; un perfil con
  `--disable default_mode_request_user_input` la apaga).
- **Uso del plan**: junto al contexto, la bandeja muestra cuánto llevas de tu
  plan (la ventana de 5 horas o la semana, la que más importa ahora); al
  pulsarlo ves cada ventana con su reinicio y el uso extra. **Uso de las
  cuentas** (el medidor de la barra lateral o la paleta de comandos) muestra
  a la vez el de todos tus perfiles, como `/usage` en cada asistente: trex
  lanza el CLI un momento sin enviar mensajes, así que no gasta tokens.
- **Menciones con `@`**: escribe `@` para buscar archivos y carpetas del
  proyecto (respeta el `.gitignore`); en Claude también aparecen sus
  subagentes (`@agent-Explore`). `Tab` entra en una carpeta.
- **Comandos con `/`**: al principio del mensaje, `/` lista los comandos. En
  Claude son los de tu Claude Code (`/context`, `/compact`, tus skills…). En
  Codex, trex ofrece los suyos: `/new`, `/compact`, `/review`, `/init`,
  `/status` y `/mcp`, y `$` para usar una skill. En los dos, `/model`,
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

## 🧱 Tecnología

| Capa | Tecnología |
|---|---|
| Shell de escritorio | Tauri v2 (Rust) |
| Terminal | xterm.js + addons (fit, web-links, search) |
| PTY real | `portable-pty` (ConPTY en Windows, openpty en Unix) |
| Interfaz | React 19 + TypeScript + Vite |
| Transporte de datos | eventos Tauri (`pty-data-<id>` en base64 para no romper UTF-8) |

## 📁 Estructura

```
src/                     interfaz React (sidebar, pestañas, terminal, ajustes)
src-tauri/src/pty.rs     motor de PTY, resolución de shells y detección de Claude
src-tauri/src/config.rs  configuración persistente (config.json)
src-tauri/src/lib.rs     comandos Tauri y arranque
scripts/make_icon.py     genera el icono de la app
```

## 🚀 Desarrollo

Requisitos: Node 22.12+ o 24+, Rust estable y, en Windows, WebView2 + Visual Studio
Build Tools (C++).

```bash
npm install
npm run tauri dev
```

La configuración del usuario vive en el directorio de configuración de la app
(`%APPDATA%\com.trex.app\config.json` en Windows).

Las comprobaciones se ejecutan con `npm test`, `npm run build` y
`cargo test --manifest-path src-tauri/Cargo.toml --lib`. GitHub Actions ejecuta
esas mismas comprobaciones en Windows y Ubuntu.

## 📦 Compilar

```bash
npm run tauri build
```

- **Windows**: genera instalador `.msi` y `.exe` (NSIS) en
  `src-tauri/target/release/bundle/`.
- **Linux**: genera `.deb` y `.AppImage`, pero hay que compilar **en Linux**
  (nativo, contenedor o CI con GitHub Actions).

## ⌨️ Atajos

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

## 📝 Notas

- Si Claude Code no aparece, instálalo con el instalador nativo:
  - Windows (PowerShell): `irm https://claude.ai/install.ps1 | iex`
  - Linux/macOS: `curl -fsSL https://claude.ai/install.sh | bash`
  - Alternativa: `npm install -g @anthropic-ai/claude-code`
