# Plan de optimización de rendimiento

Objetivo: que Trex gaste lo mínimo posible de CPU y memoria sin perder funciones,
medido siempre con la misma carga y con el perfilador de WebKit, nunca a ojo.

Regla de trabajo: **medir → cambiar una cosa → volver a medir**. Un cambio que no mejora
la medida se descarta (abajo quedan también los descartados, con su porqué).

## Resultado (10–11 de noviembre de 2026)

CPU en % de un núcleo, suma de todos los procesos de Trex (ventana + WebKit), sin el
perfilador encendido, en un compositor sin pantalla a 1920×1080@60 y con la ventana con foco:

| Escenario | Antes | Después | Cambio |
|---|---|---|---|
| Reposo, chat vacío | 0,5 % | 0,6 % | = |
| Agente trabajando sin escribir | 24,5 % | **7,0 %** | −71 % |
| Respuesta llegando (streaming) | 42,2 % | **27,3 %** | −35 % |
| Reposo tras una respuesta | 2,6 % | **0,2 %** | −92 % |
| Streaming con 40 turnos encima | 45,9 % | **28,0 %** | −39 % |
| Reposo con 40 turnos | 2,6 % | **0,3 %** | −88 % |

Con la ventana **sin foco** (Trex a la vista mientras se trabaja en otra aplicación):
trabajando 3,6 %, streaming 15,1 %, reposo 0,2 %.

Terminal con salida continua (`yes` en una pestaña de shell):

| | Antes | Después |
|---|---|---|
| Caudal | 23,7 MB/s | **38,9 MB/s** (+64 %) |
| CPU por cada MB/s | 12,4 % | **5,3 %** (2,3× más eficiente) |
| Memoria de WebKit durante la salida | 1.432 MB | **228 MB** |
| Memoria de WebKit al terminar | 1.349 MB | **204 MB** |

Memoria de WebKit con 40 turnos largos: 371 → 339 MB. Arranque en caliente hasta poder
escribir: ~580–950 ms, sin cambios (ya está en el suelo de WebKit, ver fase 5).

## Fases

| Fase | Qué | Estado |
|---|---|---|
| 0 | Banco de medición reproducible y línea base | hecha |
| 1 | Reposo y «trabajando»: animaciones, audio | hecha |
| 2 | Streaming del chat: JS, React, IPC, tandas | hecha |
| 3 | Chats largos y memoria | medida (sin cambios que compensen) |
| 4 | Terminal: PTY → xterm.js | hecha |
| 5 | Arranque y tamaño | medida (sin cambios que compensen) |
| 6 | Backend Rust | medida (sin cambios que compensen) |
| 7 | Verificación: tests, build y medida comparada | hecha |

### Fase 0 — Banco de medición (`scripts/perf/`)

- `bench.mjs`: instancia aislada (HOME y XDG_* temporales) en `mutter --headless`, con un
  Claude falso; recorre los escenarios y mide CPU y memoria por proceso y por hilo (`/proc`),
  más el perfilador de WebKit (muestreo de JS, estilo/layout/pintado, CPU por hilo, quién
  invalida estilo y layout, reparto de memoria).
- `inspector.mjs`: cliente del protocolo del Web Inspector de WebKitGTK
  (`WEBKIT_INSPECTOR_HTTP_SERVER`).
- `fake-claude.mjs`: responde como `claude -p --output-format stream-json
  --include-partial-messages` (texto con Markdown, código, tablas y herramientas) a un ritmo fijo.

Binario de medida (con inspector, en un directorio aparte para no mezclarlo con el instalable):

```bash
npm run build
cd src-tauri && CARGO_TARGET_DIR=/tmp/trex-perf/target \
  cargo build --release --features tauri/devtools,tauri/custom-protocol
cd .. && BENCH_NO_PROFILE=1 dbus-run-session -- \
  node scripts/perf/bench.mjs /tmp/trex-perf/target/release/trex resultado.json
```

Para ver nombres de funciones en el perfil: `npx vite build --minify false --outDir X` y
compilar con `TAURI_CONFIG='{"build":{"frontendDist":"X"}}'`.

Lecciones del banco: el perfilador de WebKit cuesta CPU en el proceso de la ventana (las cifras
van sin él); sin pantalla la ventana nunca tiene foco (el banco lo simula); y la cifra de memoria
de `LayerTree` es una estimación, no memoria real (se comprobó con `/proc/<pid>/smaps`).

### Fase 1 — Reposo y «trabajando»

| Causa medida | Cambio | Efecto |
|---|---|---|
| El loader (la «t» en estratos) era un SVG animado usado como máscara: WebKit lo repintaba a 60 fps con todo lo enmascarado (~11 % web + ~6 % ventana) | Sprite estático de 14 fotogramas recorrido con `mask-position` a saltos (10 por segundo). Generador: `scripts/make_loader_sprite.py` | ~17 % → ~2 % |
| El icono de Claude girando con `transform` se acelera en el compositor: 60 fotogramas por segundo aunque fuera a saltos | Rotación a saltos con una propiedad registrada (`@property --agent-turn`), que no se acelera; lo mismo para el «respirar» de Codex | ~8 % → <1 % |
| Cada indicador con su propio reloj: ~28 fotogramas por segundo entre todos | `src/activityMotion.ts`: todos en fase sobre el reloj del documento y a ¼ de velocidad sin foco | −1,5 % (con foco), −4 % (sin foco) |
| El `AudioContext` del sonido de aviso quedaba en marcha para siempre: hilos de GStreamer ~3 % en reposo | Se suspende tras desbloquearse y después de cada aviso | 2,6 % → 0,2 % en reposo |

### Fase 2 — Streaming

| Causa medida | Cambio |
|---|---|
| `toLocaleString`/`DateTimeFormat` creaban un formateador en cada render (lo más caro en JS) | `src/intl.ts`: formateadores cacheados (horas, números, monedas, comparación de textos) |
| `useReducedMotion` llamaba a `matchMedia` en cada render de cada componente | Una sola consulta compartida |
| Git, uso, ramas, cola, modelos, ajustes y terminales en segundo plano se repintaban con cada tanda de texto | `memo` en esos paneles y props con identidad estable en `ChatPanel` (y en `useMessageQueue`) |
| Un evento de Tauri por línea del agente (un `eval` en la ventana por fragmento) | `src-tauri/src/output_batch.rs`: la primera línea tras un silencio sale al momento y el resto en tandas de 33 ms; `listenAgentLine` acepta tandas |
| El chat se pintaba cada 50 ms aunque nadie lo mirase | Sin foco, cada 200 ms; al volver el foco se entrega lo pendiente al momento (`lineBatch.ts`) |

### Fase 3 — Chats largos y memoria (medido, descartado)

- `content-visibility: auto` en las filas del hilo: −1,5 % de CPU, la misma memoria. No compensa
  el riesgo de saltos al desplazarse.
- Pintar 30 filas en lugar de 60 (`THREAD_WINDOW`): la mitad de DOM y la misma memoria. Revertido.
- Teselas del scroll: ocultar la capa liberó 2 MB; la «memoria» de `LayerTree` era una estimación.
- Lo que crece es basura del streaming: en 90 s de reposo baja sola (317 → 275 MB; JS 84 → 58 MB
  tras recoger basura). No hay fuga.

### Fase 4 — Terminal

La salida del PTY iba en base64 dentro de un evento JSON por cada lectura (un `eval` de JS en el
hilo principal de la ventana y una cadena enorme por bloque). Ahora va en binario por un `Channel`
de Tauri (`pty_spawn` recibe `onData`), agrupada con el mismo `output_batch.rs` (tandas de 16 ms o
128 KB, la primera tras un silencio al momento). xterm recibe los mismos bytes que antes.

### Fase 5 — Arranque (medido, sin cambios)

En caliente, el proceso tarda ~270 ms en empezar a cargar la página (igual que una ventana WebKit
mínima) y la página trabaja ~170 ms (JS ~64 ms, estilo ~40 ms); el resto es espera de IPC. Cargar
xterm al arrancar cuesta ~3 ms: diferirlo no compensa.

### Fase 6 — Backend Rust (medido, sin cambios)

En reposo: ~0,1 % de CPU y 68 MB (sobre todo bibliotecas y heap de GTK/WebKit). Los `sleep` de
10 ms están en tests, reintentos acotados de cerrojos y esperas con límite; ninguno corre
de forma permanente. La transparencia de la ventana no cuesta nada medible.

## Lo que queda (por orden de impacto estimado)

1. Streaming con foco (~27 %): el coste se reparte entre JS (~40 %), pintado, estilo y layout de
   cada tanda. La siguiente palanca sería partir `ChatPanel` para que solo el hilo dependa del texto.
2. Reducir basura del streaming: aplicar cada tanda de fragmentos en una sola pasada del reducer
   (hoy cada fragmento copia la lista de mensajes).
3. Terminal: el coste restante está en xterm (análisis y WebGL) y en el proceso `yes` mismo.
