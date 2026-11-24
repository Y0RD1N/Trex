# Trex Browser dentro de trex y un trex más ligero

Investigación del 24 de noviembre de 2026 sobre `main` en `6860af6` (Trex 0.11.0) más los
cambios sin commitear de la bandeja. Solo se midió y se leyó código: no se cambió nada.

Equipo: Windows 11 Pro 26200, 12 hilos, WebView2 158.0.4370.33. Las cifras de tamaño van en
MB = 10⁶ bytes salvo que diga KiB/MiB. **Medido** quiere decir que se midió en este equipo;
**estimado**, que sale del código o de documentación y no se comprobó.

Complementa a [`plan.md`](plan.md), que midió CPU y memoria en Linux en noviembre (animaciones,
streaming del chat, terminal por `Channel`, `output_batch.rs`). Nada de aquí repite esa parte.

> **Decisión (24-nov-2026, después de este informe):** el usuario prefirió **quitar Trex Browser
> por completo** en lugar de integrarlo, y quedarse solo con «Tu navegador» (la extensión para
> Chrome/Brave/Edge y el puente `src-tauri/src/browser_bridge.rs`). Para que la pérdida se note
> poco: perfil de navegador dedicado a los agentes recomendado en Ajustes, un grupo de pestañas
> por chat, herramientas nuevas en la extensión (formularios, esperas, diálogos, subida de
> archivos), paquete y guía para publicarla en Chrome Web Store y Edge Add-ons, y limpieza de los
> datos del navegador viejo desde Ajustes. Se hace en la rama `quitar-trex-browser`. La §2 queda
> como registro de las opciones que se valoraron; la mejora 1 de §4 (sacar el runtime del
> instalador) se cumple quitándolo, y la 4 (adelgazarlo) deja de aplicar.

---

## Resumen

**Navegador.** Recomiendo **integrar la vista y no el motor**: que trex muestre las pestañas
de los agentes en un panel de su propia ventana (imagen en vivo por CDP y control con ratón y
teclado), con el Electron de hoy funcionando oculto por detrás, y que el runtime del navegador
**se descargue bajo demanda** en lugar de ir dentro del instalador. Así se conservan las 43
herramientas de los agentes, los espacios aislados y el modelo de seguridad en Windows y
Fedora, desaparece la «app aparte» (ventana, acceso directo, instalador propio) y el instalador
de Windows baja de 146 a ~12 MB. Las webviews hijas de Tauri solo valen en Windows (en Fedora
no respetan la posición ni tienen CDP) y CEF exige Tauri v3, todavía en alfa. Coste estimado:
4–6 semanas en cinco fases (§2.6).

**Las cinco mejoras de peso y consumo con más impacto** (detalle en §4):

| # | Mejora | Cifra medida | Esfuerzo |
|---|---|---|---|
| 1 | Sacar el runtime del navegador del instalador (descarga verificada al activarlo) | setup 146,2 → ~12 MB; una instalación por defecto escribe 475 MB para quedarse con 15 | medio |
| 2 | Dormir el WebView2 cuando la ventana está oculta en la bandeja (`IsVisible = false`, memoria baja) | oculta en la bandeja, la página sigue en `visibilityState = "visible"` y gasta lo mismo que a la vista: 0,2 % en limpio, 5–8 % de un núcleo de WebView2 en la app instalada con voz y chats | bajo |
| 3 | Voz: no cargar Whisper ni la esfera con cualquier voz cercana | con Whisper cargado, trex nativo pasa de 133 a 504 MB privados y de 1–3 % a 20–37 % de CPU | bajo → medio |
| 4 | Adelgazar el runtime del navegador (un solo Node, `playwright-core`, sin `dxcompiler.dll`, diccionario NSIS) | −34,7 MB comprimidos y −130 MB en disco sobre 134 / 443 | bajo → medio |
| 5 | Menos procesos de fondo: no relanzar en cada arranque lo que ya se sabe (tema del navegador, CLI detectados dos veces, uso de cuentas) y compartir los MCP de escritorio entre chats | 6+ procesos en los primeros 20 s; 2 `trex-agent` por chat de Claude (10 con 5 chats, ~12 MB privados por chat) | bajo → medio |

El arranque ya es rápido (primer pintado a 0,6–0,7 s del lanzamiento, medido) y el 70–75 % de
ese tiempo es de WebView2, así que no está entre las cinco.

---

## 1. Trex Browser hoy

### 1.1 Procesos y conexión con los agentes

```
trex.exe (Tauri)
 ├─ cada comando Tauri: trex-browser.exe <sub> → node.exe worker.mjs <sub>          (vida corta)
 │    └─ si no hay broker: trex-browser.exe __spawn-broker → node.exe worker.mjs daemon
 ├─ Claude/Codex ── MCP Streamable HTTP 127.0.0.1:<puerto>/mcp (token por agente) ──► broker
 ├─ Antigravity, WSL, respaldo ── stdio: trex-browser.exe mcp → node worker.mjs mcp ──► broker
 └─ Trex CLI: trex-browser.exe call (trex-cli/src/browser.rs:172)
broker (node.exe + Playwright 1.64.1)
 ├─ chromium.launchPersistentContext(executablePath = trex-browser-shell.exe)  → Electron 45.2.1
 │     por --remote-debugging-pipe (sin puerto de depuración)
 └─ trex-browser.exe __guard-browser   (uno por navegador lanzado)
```

- Rutas: `trex-browser/src/main.rs:36-67`, `trex-browser/src/detached.rs:93-112`,
  `trex-browser/worker/worker.mjs:57-76` (`ensureBroker`), `worker.mjs:84-183` (daemon),
  `trex-browser/worker/shared-shell.mjs:154-164`, `trex-browser/shell/main.mjs:1-4,62`.
- **Bajo demanda.** Al abrir trex solo corre `theme set` a los 4 s (`src/browserThemeSync.ts:15`),
  que no arranca el broker. El broker arranca cuando se conecta un chat con navegador
  (`src-tauri/src/trex_browser.rs:463`) y Electron con la primera operación de página
  (`worker/browser.mjs:122-135`). Electron se cierra al liberarse el último espacio
  (`shared-shell.mjs:255-262`); **el broker no se apaga por inactividad**: vive hasta `stop` o
  `/shutdown` (`worker.mjs:155,181`).
- **Procesos vivos con el navegador en uso**: 1 broker, 1 guardia, y el árbol de Electron
  (principal, GPU, red y un renderer por `WebContents`: la UI ya son 4 —marco, cursor, isla y
  dock, `main.mjs:902-908`— más uno por pestaña). Cada comando de trex lanza además
  `trex-browser.exe` + `node.exe` de vida corta (`trex_browser.rs:285-340`); el menú del
  navegador del chat lo hace cada 3 s mientras está abierto (`src/components/chat/BrowserMenu.tsx:96`).
- **Plataformas:** solo Windows y Fedora. El dmg de macOS no lleva navegador
  (`src-tauri/tauri.macos.conf.json:7-8` solo copia `trex-agent`; `trex_browser.rs:252` no busca
  instalación fuera de Windows y Linux).
- **Extensiones:** Trex Browser no carga ninguna hoy (no hay `loadExtension` ni
  `session.extensions`). Ninguna opción pierde nada aquí.
- «Tu navegador» (`src-tauri/src/browser_bridge.rs`, `extension/`) es otra cosa: una extensión en
  el Chrome/Brave/Edge de la persona que solo toca el grupo de pestañas «trex». No comparte
  código ni procesos con Trex Browser.

### 1.2 De qué depende cada función

| Función | Cómo está hecha | Depende de |
|---|---|---|
| Control por agentes (43 herramientas en `full`, 42 en `qa`, 15 en `observe`) | Playwright por pipe + `ScopedCdp` (`shared-shell.mjs:202-213`, `scoped-cdp.mjs:60-100`) | **CDP completo de Chromium** |
| Espacios y perfiles aislados | `session.fromPath(<home>/projects/<id>/BROWSERn/user-data)` (`main.mjs:769-776`) y un `browserContextId` de CDP por espacio, todo en un solo proceso | sesiones de Electron + CDP |
| Pestaña ↔ target, UI invisible para los agentes | `wc.debugger.attach` + `Target.getTargetInfo` (`main.mjs:752-758`), `uiTargets` (`main.mjs:857`) | `webContents.debugger` |
| Descargas | `will-download` → `artifacts/<guid>` + `Browser.downloadWillBegin` sintético (`scope-storage.mjs:55-66`) | Electron |
| Permisos de sitio | handlers de sesión y `site-permissions.mjs` (`main.mjs:366-460`) | Electron |
| Popups de inicio de sesión | `setWindowOpenHandler` conserva `opener` y el POST (`main.mjs:602-608`) | Electron |
| Isla, dock, cursor, centro de agentes | vistas nativas superpuestas `overlay.html?part=…` (`main.mjs:271-327,523-539`); el HTML no puede pintar encima de la página | `WebContentsView` apiladas |
| Miniaturas del centro, vídeo, trazas, perfiles | `page.screenshot` cada 2,5 s solo con el centro abierto (`browser.mjs:262-277`), `page.screencast`, `Tracing`, `Profiler` (`browser.mjs:715-735`) | CDP |
| Tema sincronizado | trex → `trex_browser_theme` → `theme.json` → `theme.mjs` | portable |
| Seguridad | home con ACL que conoce los SID LPAC de Chromium (`trex-browser/src/security.rs:57-143`), job objects con breakaway (`detached.rs:91-112`), guardia que mata solo descendientes verificados (`guard.rs:180-218`), broker solo loopback con tokens de 256 bits (`worker.mjs:104-148`) | Chromium + Windows |

Ya existe un **modo oculto** del shell (`TREX_BROWSER_HEADLESS=1`, `shell/main.mjs:60,896`) que
usan las pruebas y la CI: ventana sin mostrar, sin cursor ni menús, y las pestañas de agentes con
`backgroundThrottling: false` (`main.mjs:552`). Es la base de la opción recomendada.

### 1.3 Peso (medido)

| Parte | En disco | Comprimido (LZMA, como el setup) |
|---|---|---|
| `trex-browser-runtime/` | 443,1 MB | 133,8 MB |
| · Electron 45.2.1 (`shell/`, 54 archivos) | 325,8 | 106,7 |
| · · `trex-browser-shell.exe` | 249,8 | 77,1 |
| · · `dxcompiler.dll` (WebGPU sobre D3D12) | 25,8 | 6,5 |
| · `node.exe` 24.22.1 (segundo Node, para el worker) | 93,9 | 23,0 |
| · `node_modules` (`playwright` + `playwright-core`) | 18,7 | 2,6 |
| · ffmpeg (vídeo de Playwright) | 4,3 | 1,4 |
| `trex-browser.exe` (lanzador Rust) | 0,53 | 0,18 |

Es el **92 % del setup de Windows** (134 de 146,2 MB). El `runtime-manifest.json` del payload
dice `"version": "0.9.0"` aunque los `.mjs` coinciden con el código actual: la etiqueta está
desactualizada.

---

## 2. Opciones para meter el navegador en la ventana de trex

Estado comprobado a 24-nov-2026: Tauri 2.12.7, wry 0.57.3 (el repo usa tauri 2.12.0 y
wry 0.57.0, `src-tauri/Cargo.lock`), `tauri-runtime-cef` 3.0.0-alpha.7. Fuentes al final (§7).

### Opción A — Webviews hijas de Tauri (`Window::add_child`, feature `unstable`)

Cada pestaña sería una webview nativa (WebView2 / WebKitGTK / WKWebView) dentro de la ventana
de trex.

- **Sigue siendo `unstable` en 2.12.7** y puede romper en versiones menores [1][2].
- **Windows:** viable. CDP por `--remote-debugging-port` en un entorno WebView2 aparte (con otro
  `data_directory`, para no exponer la UI de trex) o CDP dentro del proceso con
  `CallDevToolsProtocolMethod` vía `with_webview` [25][27]. Playwright `connectOverCDP` funciona
  contra WebView2 pero es de «menor fidelidad» y toma `contexts()[0]` [25][26]. Cada espacio
  aislado = otro `data_directory` = **otro grupo de procesos de WebView2**; los perfiles con
  nombre que comparten proceso (`profile_identifier`) están fusionados en `dev` de Tauri desde el
  18-nov (PR #16054) pero **sin publicar** [22]. No hay API de orden z: la hija siempre queda
  encima (#15682) [9], así que la isla, el dock y el cursor serían otras webviews apiladas a mano.
  `on_new_window` no puede devolver una webview hija: los popups pierden `window.opener` y fallan
  los OAuth en popup (#16426) [16], que hoy funcionan y tienen prueba
  (`single-window.integration`).
- **Fedora:** no sirve. En Linux Tauri mete la hija en el `gtk::Box` de la ventana y
  `set_bounds` no la mueve; en Wayland la posición y el tamaño se ignoran (#15656, #10420)
  [5][6][7][8]. WebKitGTK no tiene CDP: solo WebDriver o el inspector de WebKit [31][32];
  Playwright no puede controlar un WebKit embebido de terceros [26][29].
- **macOS:** sin CDP (solo Safari Web Inspector) [33]; hoy tampoco hay Trex Browser en macOS.

### Opción B — CEF como motor de Tauri (`tauri-runtime-cef`)

Toda la app (UI de trex incluida) pasaría a Chromium embebido, con CDP en las tres plataformas.

- Publicado solo como **3.0.0-alpha.7 para Tauri v3 alfa** [42][43]: migrar trex a v3 antes de
  que sea estable.
- CDP por puerto, pipe o dentro del proceso [46][47]; perfiles como contextos aislados [44];
  `add_child` funciona en v3 [50].
- Bloqueos hoy: **Windows corre sin sandbox de Chromium** (arreglo en PR #16431, abierta) [49];
  Linux solo con X11/XWayland [45][50]; transparencia que da pantalla negra (#15718) [51] —la
  ventana de trex es transparente (`src-tauri/tauri.conf.json:24`)—; sin extensiones [48].
- Peso: la distribución mínima de CEF 156 son 167 MiB comprimidos en win64, 318 en linux64 y
  129 en mac-arm64 [52]; macOS, que hoy pesa 12 MB, pasaría a cargar con Chromium.

### Opción C — Integrar la vista y mantener el motor (recomendada)

trex muestra el navegador en un panel propio; el motor sigue siendo el Electron de hoy, oculto.

- **Ver:** imagen en vivo de la pestaña del agente con `Page.startScreencast` (o el
  `page.screencast` de Playwright que ya se usa para vídeo, `browser.mjs:723`) a través del mismo
  `ScopedCdp`, que solo bloquea órdenes globales `Browser.`/`Storage.`/`Target.`. Las miniaturas
  del centro de agentes ya hacen una versión lenta de esto (`browser.mjs:262-277`).
- **Tomar control:** ratón, rueda y teclado reenviados con `Input.dispatchMouseEvent`,
  `Input.dispatchKeyEvent` e `Input.insertText`; pausar al agente reutiliza los controles humanos
  que ya existen (`browser.mjs:287-315`, `human-controls.mjs`). El portapapeles funciona solo,
  porque Electron corre en la misma máquina.
- **Pestañas, espacios y estado:** el inventario que ya da `trex_browser_list_spaces`
  (`trex_browser.rs:560`).
- **Ventana de Electron:** oculta por defecto (modo `TREX_BROWSER_HEADLESS`), con «Abrir en
  ventana» para lo que el panel no cubre bien: iniciar sesión con calma, selector de archivos,
  arrastrar y soltar.
- **Canal:** hoy cada comando lanza `trex-browser.exe` + `node.exe`; un panel en vivo necesita un
  canal persistente de trex al broker (HTTP/WebSocket local con el token del host, como ya hace la
  CLI).
- Lo que se pierde frente a una pestaña nativa: latencia de la imagen (JPEG), vídeo a pocos
  fotogramas, IME y accesibilidad de la página para la persona, menú contextual y diálogos
  nativos (hay que dibujarlos en trex). **Sin comprobar:** si una ventana de Electron oculta
  sigue produciendo fotogramas para el screencast; si no, hace falta renderizado fuera de
  pantalla (`webPreferences.offscreen`) o una ventana encubierta. Es lo primero que hay que
  probar (fase 0).

### Opción D — Pegar o reparentar la ventana de Electron

- `SetParent` entre procesos reinicia el DPI del hijo y une las colas de entrada, algo «muy
  difícil de gestionar» [56][57]. En Wayland un cliente no puede colocar ventanas en coordenadas
  globales, así que ni incrustar ni «pegar» una ventana sin marco que siga a la de trex [58]. En
  macOS no hay vía oficial para que una ventana de otro proceso sea hija.
- Solo valdría como experimento en Windows.

### 2.5 Qué se pierde y qué se gana

| | Hoy (Electron aparte) | A · hijas Tauri | B · CEF (v3 alfa) | **C · vista integrada** | D · pegar ventana |
|---|---|---|---|---|---|
| Control CDP de los agentes | ✓ completo | Windows: parcial (menor fidelidad, reescribir `ScopedCdp`); Fedora ✗ | ✓ | ✓ sin cambios | ✓ |
| Perfiles aislados por espacio | ✓ un proceso, muchos contextos | Windows: un grupo de procesos por espacio (perfiles con nombre sin publicar) | ✓ | ✓ sin cambios | ✓ |
| Extensiones | no hay | solo desempaquetadas, solo Windows | ✗ | no hay (igual) | no hay |
| Descargas y permisos | ✓ | ✓ (hay que reescribir la UI) | ✓ | ✓ (UI en el panel) | ✓ |
| Overlays (isla, dock, cursor, centro) | ✓ vistas nativas | webviews apiladas sin orden z | mismos problemas + #16610 | HTML normal de trex, encima de la imagen | ✓ |
| Popups OAuth con `opener` | ✓ | ✗ (#16426) | sin comprobar | ✓ | ✓ |
| Dentro de la ventana de trex | ✗ | ✓ Windows / ✗ Fedora | ✓ (Linux solo X11) | ✓ Windows y Fedora | Windows, frágil |
| Sensación al navegar a mano | nativa | nativa | nativa | imagen (latencia, sin IME) + «Abrir en ventana» | nativa |
| Seguridad (ACL, guardia, sandbox) | ✓ | rehacer para `msedgewebview2` | Windows sin sandbox hoy | ✓ sin cambios | ✓ |
| Instalador Windows | 146 MB | −107 MB si se quita Electron (el Node y Playwright del worker, ~26 MB, siguen) | ≈ igual, toda la app en CEF | igual; **~12 MB con descarga bajo demanda** | igual |
| Procesos | broker + guardia + Electron (4 renderers de UI + 1 por pestaña) | broker + un grupo WebView2 por espacio | uno solo de Chromium para todo | como hoy, sin los renderers de isla/dock/cursor | como hoy |
| Motores que mantener | 1 | 2 (WebView2 en Windows, Electron en Fedora) | 1 | 1 | 1 |

### 2.6 Coste por fases (estimado, una persona con ayuda de agentes)

| Opción | Fases | Total |
|---|---|---|
| **C (recomendada)** | **F0** prueba de concepto: fotogramas con la ventana oculta, latencia clic→imagen, CPU a 10–15 fps, `Input.*` por `ScopedCdp` (2–4 días). **F1** canal persistente trex↔broker y panel de solo ver: pestañas del espacio, imagen en vivo, estado del agente (1 semana). **F2** tomar control en el panel: ratón, rueda, teclado, texto, barra de dirección, atrás/adelante, avisos de permisos y descargas (1,5–2 semanas). **F3** retirar la app aparte: ventana oculta por defecto, «Abrir en ventana», quitar acceso directo e instalador independiente, ajustar pruebas `shell.integration`/`single-window` (3–5 días). **F4** (independiente, puede ir primero) runtime descargado bajo demanda y adelgazado (§4, mejoras 1 y 4) (1–1,5 semanas) | **4–6 semanas** |
| A (solo Windows) | F0 prueba de `add_child` + WebView2 con CDP + Playwright (1 semana); F1 shell en Tauri/React: pestañas, barra, permisos, descargas, popups, nueva pestaña (2–3 semanas); F2 worker sobre WebView2: espacios como entornos, `ScopedCdp`, guardia y ACL (3–4 semanas); F3 pruebas. Fedora sigue con Electron | 6–8 semanas + dos motores para siempre |
| B (CEF) | Esperar a Tauri v3 estable y a que se cierren sandbox de Windows, Wayland y transparencia; después migrar la app entera (4–8 semanas) | bloqueado hoy |
| D | 1–2 semanas en Windows; no existe en Wayland | no recomendado |

### 2.7 Recomendación

**C + descarga bajo demanda.** El valor de Trex Browser está en el control de los agentes por
CDP con espacios aislados, y eso hoy solo lo da Chromium en Windows y Fedora a la vez. Integrar
la vista consigue lo que el usuario pidió —el navegador vive dentro de trex, sin app ni
instalador aparte— sin reescribir el motor, el worker, la seguridad ni las ~150 pruebas del
navegador, y la descarga bajo demanda hace que quien no lo use no pague sus 134 MB. Revisar B
(CEF) cuando Tauri v3 sea estable: entonces un solo Chromium podría pintar la UI de trex y las
pestañas. A solo tendría sentido si se acepta un trex con navegador integrado únicamente en
Windows.

Aviso que vale para cualquier opción: Google rechaza el inicio de sesión en navegadores
embebidos; hoy se resuelve con «Abrir en navegador del sistema» (`trex-browser/README.md:148-154`).

---

## 3. Mediciones de peso y consumo

### 3.1 Instalador

Assets publicados (`gh release view`):

| Versión | setup.exe | dmg (arm64) | rpm |
|---|---|---|---|
| v0.1.0 (09-nov) | 144,86 | 10,71 | 163,57 |
| v0.5.0 (12-nov) | 145,56 | 11,57 | 164,31 |
| v0.11.0 (24-nov) | 146,23 | 12,19 | 164,89 |

Desglose del setup de Windows (cada grupo comprimido por separado con LZMA como el setup; suma
143,3 frente a 146,2 reales, ±2 %): runtime del navegador **133,8**, `trex.exe` 5,3,
`trex-agent.exe` 4,0, lanzador 0,18, `extension/` 0,02.

- **Las casillas de Trex CLI y Trex Browser vienen desmarcadas** (`src-tauri/installer/trex-cli.nsh:42-47`)
  pero sus payloads **van siempre dentro** (`src-tauri/tauri.windows.conf.json:4-8`) y la plantilla
  los extrae siempre (`src-tauri/installer/installer.nsi:660-664`); si no se marcan, se borran
  después (`trex-cli.nsh:338-340` y `:508`). Una instalación por defecto descarga 146 MB y
  escribe ~475 MB para quedarse con ~15,4 MB.
- El rpm lleva el navegador siempre y no es opcional (`src-tauri/tauri.linux.conf.json:18-21`).
- Las DLL de voz (sherpa-onnx + onnxruntime, 22 MB) **ya se descargan bajo demanda** desde 0.6.0
  y se cargan con `/DELAYLOAD` y comprobación SHA-256 (`src-tauri/build.rs:5-10`,
  `src-tauri/src/voice.rs:350-368`). No queda nada que ganar ahí.
- Ya existe un instalador solo del navegador (`src-tauri/installer/browser-installer.nsi`,
  `npm run browser:installer`), pero la CI no lo publica.

### 3.2 Frontend

`vite build` (Vite 8.3.1, rolldown) en una carpeta aparte; gzip 9 y brotli 11 con zlib de Node.

- `dist` = 2.987 KiB en 88 archivos; **brotli 1.108 KiB**, que es lo que va en el `.exe` (Tauri 2.12
  incrusta los assets en brotli). Las **fuentes son el 47 %** de eso (516,6 KiB).
- **Carga inicial de `index.html`:** 19 archivos, JS 1.572 KiB (472 gzip / 392 br) + CSS 273 KiB.
  Parseo y compilación en V8 sin caché: ~51 ms (orientativo; WebView2 guarda el código compilado
  entre arranques).

| Chunk | KiB | br | Carga |
|---|---|---|---|
| `main.js` | 680,0 | 169,3 | inicial |
| `xterm.js` | 354,1 | 74,2 | inicial |
| `main.css` | 264,2 | 36,3 | inicial |
| `react.js` | 213,7 | 56,7 | inicial |
| `markdown.js` | 151,4 | 39,1 | inicial |
| `chatHighlight.js` | 121,2 | 31,8 | diferido (se precarga al quedar libre, `Markdown.tsx:90-93`) |
| `SettingsPanel.js` | 120,1 | 27,1 | diferido (precarga a los 2,5 s, `lazyComponent.ts:12,26-31`) |
| `addon-webgl.js` | 110,7 | 26,1 | diferido de verdad (al montar un terminal) |
| `api.js` | 83,7 | 26,5 | inicial |

- **xterm entra en el arranque** por el import estático de `src/App.tsx:64` aunque solo lo usan
  las pestañas de shell y Codex sin chat (`App.tsx:175-176`): 354 KiB, el 23,5 % del JS inicial.
- El `import()` de `antigravityConnection` (`src/conversations.ts:35`) no sirve: `accountUsage.ts:15`
  lo importa de forma estática.
- Fuentes (`src/main.tsx:13-17`): entran 15 `.woff` que WebView2 nunca pide (127,8 KiB) y 16
  `.woff2` de alfabetos no latinos (176,7 KiB). El comentario de `main.tsx:4` aún habla de Inter.
- La app móvil (`remote.html`) carga 495 KiB y `src-tauri/src/remote.rs:451` la sirve **sin
  compresión** (gzip la dejaría en ~148 KiB). `RemoteApp.tsx:16` arrastra `chatState.ts` y
  `remoteProtocol.ts` (~27 KiB) solo por `timeAgo`.
- `orb.html` (esfera de voz) está limpia: 19,7 KiB.

### 3.3 Arranque y ventana oculta (app de prueba aislada)

Binario release aislado (`com.trex.perftest`, compilado con el perfil de `src-tauri/Cargo.toml`
desde el árbol de trabajo actual, bandeja incluida), configuración vacía (sin proyectos ni voz),
5 aperturas seguidas; la primera crea la carpeta de WebView2. Tiempos desde que se lanza el
proceso; los de la página, desde su `performance.timeOrigin`. Medido.

| | 1.ª apertura | 2.ª–5.ª |
|---|---|---|
| Lanzar → empieza a cargar la página (Rust + entorno WebView2) | 497 ms | 435–483 ms |
| Respuesta del HTML / `DOMContentLoaded` | 52 / 127 ms | 40–43 / 109–114 ms |
| Primer pintado (FCP) desde la página | 220 ms | 164–188 ms |
| **Lanzar → primer pintado** | **717 ms** | **602–671 ms** |
| Pintado principal (LCP) | 404 ms | 292–296 ms (una vez 2.640 ms: un elemento que pinta al precargarse los chunks diferidos a los 2,5 s) |

- **El 70–75 % del tiempo hasta el primer pintado pasa antes de que la página empiece a cargar**
  (proceso nativo y entorno de WebView2). El JS de la página es la parte pequeña; por eso diferir
  xterm (~11 ms de parseo) apenas mueve el arranque, igual que se midió en Linux (`plan.md`,
  fase 5).
- **Memoria en reposo con la ventana a la vista** (a los 15–30 s): 7 procesos, **~222 MB
  privados** (working set ~432 MB, que cuenta varias veces lo compartido). Privada por proceso:
  `trex.exe` 13 MB; WebView2: GPU **104–110 MB**, renderer 44–48, browser 34, red 12,
  almacenamiento 7, crashpad 3. Heap de JS 7 MB y 178 nodos DOM (pantalla de bienvenida).
- **CPU en reposo, 60 s a la vista: 0,18 % de un núcleo.** En limpio trex está quieto: el 5–8 % de
  WebView2 de la app instalada (§3.4) sale de su estado (voz, chats, animaciones), no de la base.
- **Ventana oculta en la bandeja** (`WM_CLOSE` como la X → `hide_to_tray`): la ventana queda oculta
  (`IsWindowVisible` = falso) pero **la página sigue con `document.visibilityState = "visible"`
  y no recibe ningún `visibilitychange`**. Privada 213 MB (el renderer baja de 47 a 40), CPU
  0,21 %. Consecuencias: Chromium no frena temporizadores ni animaciones de una ventana que nadie
  ve, y las comprobaciones de visibilidad que ya hay (`GitPanel.tsx`, `useAccountUsage.ts:37`)
  no sirven en la bandeja.
- El ejecutable pesa 15,44 MB con el frontend incrustado y 14,25 MB sin él: **el frontend ocupa
  1,19 MB del `.exe`** (comprimido con brotli).

**Ventana opaca** (mismo binario con `transparent: false`, 3 aperturas; muestra pequeña): privada
total ~195 MB frente a ~222 (una apertura dio 260 porque arrancó además el servicio de audio de
WebView2). El ahorro está en el proceso GPU (85–90 MB frente a 104–110) y en `trex.exe` (7 frente
a 13 MB): **~25 MB menos (−11 %)**. El primer pintado no mejoró (698–770 ms, con el equipo recién
salido de compilar) y la CPU en reposo quedó en ruido (0,3–0,5 %). Con el cristal apagado, que es
el valor por defecto, la transparencia cuesta esos ~25 MB sin aportar nada visible.

### 3.4 Reposo de la app instalada

trex 0.11.0 instalado (sin la bandeja), 5 h encendido, ventana a la vista sin foco, 5 asistentes
vivos (4 chats de Claude, 1 de Codex), control remoto y puente de Chrome encendidos, **modo
llamada (voz) encendido** (viene apagado por defecto).

| Grupo | Procesos | Working set | Privada |
|---|---|---|---|
| trex nativo (principal + servidor MCP de la bandeja de entrada) | 2 | 387 MB | 440 MB |
| WebView2 (browser, renderer, GPU, red, almacenamiento, audio, crashpad) | 7 | 343 MB | 338 MB |
| Hijos: asistentes y sus MCP (no es consumo de trex) | 56 | 860 MB | 2.398 MB |

- El segundo `trex.exe` no es otra copia: es `--trex-inbox-mcp` (`src-tauri/src/lib.rs:396`,
  `queue_mcp.rs:13`) lanzado por Codex; 1,5 MB privados y 0 % de CPU.
- **CPU de trex nativo: 20–37 % de un núcleo mientras Whisper está cargado**; el 17,5 % son hilos
  `intra-op` de onnxruntime y 3,4 % el hilo `trex-voice`. Al liberarse Whisper la memoria privada
  bajó de **504 a 133 MB** y la CPU quedó en **1,0–3,1 %** durante 7 minutos seguidos.
- Whisper se carga en cuanto el detector oye a alguien hablar (no hace falta la palabra de
  activación), con `num_threads = 4` (`voice.rs:545`), y a la vez se **precalienta la esfera**
  (`voice.rs:699`): un renderer nuevo de WebView2 de 63 MB que se destruye a los 120 s sin uso
  (`src-tauri/src/voice_orb.rs:29,396`).
- **WebView2 sin foco: 5–8 % de un núcleo** (compositor del renderer 1,5 %, `GpuVSyncThread`
  0,8 %, Viz 0,7 %): algo pide fotogramas sin parar. Sospecha no medida: la respiración del icono
  del micrófono (`src/components/Voice.css:42`), que no está en `INDICATORS`
  (`src/activityMotion.ts:140`) y no baja a ¼ sin foco. En Linux el reposo medía 0,2 %.
- `trex-agent` lanza `desktop-mcp` y `a11y-mcp` por cada chat de Claude, cada uno con su
  `conhost`: con 5 chats, 10 `trex-agent` y 21 `conhost` (58 MB privados, 244 MB de working set
  entre todos), ~12 MB privados por chat.

Qué arranca al abrir (todo sin bloquear la ventana salvo lo indicado):

| Cuándo | Qué | Dónde |
|---|---|---|
| 0 s | `claude --version`, `codex --version` (procesos), `trex --version` si está la CLI | `src/App.tsx:230,360,367`, `src-tauri/src/pty.rs:733,817` |
| 0 s, solo con voz | SHA-256 de 21 MB de DLL y `LoadLibrary` **en el hilo principal dentro de `setup`** | `voice.rs:431` → `voice.rs:354-366` |
| 4 s | `trex-browser theme set`: lanza un proceso **en cada arranque** porque el último tema enviado solo se guarda en memoria | `src/browserThemeSync.ts:15,28` |
| 8 s | uso de las cuentas: lanza `claude -p`/`codex` por perfil, de 2 en 2 | `src/hooks/useAccountUsage.ts:22,40` |
| 15 s | registro de npm ×2 y **otra vez** la detección de los dos CLI | `src/hooks/useCliUpdates.ts:12,78`, `App.tsx:390` |
| 20 s | GitHub `releases/latest` y estado de Antigravity | `src/hooks/useAgentUpdates.ts:17` |

Sondeos que corren siempre, también oculto: latido de coordinación cada 5 s por proyecto con
sesiones (`src/coordination.ts:239`), terminales de fondo de Codex cada 2,5 s por chat
(`src/agentTerminals.ts:100`) y, con voz, el hilo `trex-voice` (`voice.rs:631`) y la captura
WASAPI cada 20 ms (`voice_capture.rs:135`). El panel de Git y el uso de cuentas sí miran
`document.visibilityState`, pero esa comprobación no sirve en la bandeja (§3.3).

WebView2: no se pasa ningún `additional_browser_args` ni se usa `with_webview`,
`MemoryUsageTargetLevel`, `TrySuspend` o `IsVisible` en `src-tauri/`. `hide_to_tray`
(`src-tauri/src/tray.rs:78-81`) solo llama a `window.hide()`, y wry no cambia la visibilidad del
controlador de WebView2 al ocultar (comprobado en §3.3: la página no se entera). Según
Microsoft, es la app quien debe poner `IsVisible = false` para que Chromium frene temporizadores
y animaciones y libere cachés. La
ventana es `transparent: true` (`tauri.conf.json:24`) aunque el cristal está apagado por defecto
(`src/windowMaterial.ts:25`): se paga la transparencia sin usarla (coste sin medir).

### 3.5 Rust: compilación y dependencias

- `[profile.release]` de `src-tauri/Cargo.toml:89-94` ya es el agresivo (`lto = true`,
  `codegen-units = 1`, `opt-level = 3`, `panic = "abort"`, `strip`). `trex.exe` 15,25 MB
  (5,3 comprimido). Compilar desde cero con ese perfil tardó **23 min** en este equipo.
- `crate-type = ["staticlib", "cdylib", "rlib"]` (`src-tauri/Cargo.toml:16`) genera en cada build
  `deps/trex_lib.lib` (203,6 MB) y `trex_lib.dll` (1,36 MB) que no se instalan: solo hacen falta
  para Tauri móvil, y la app de iPhone es Swift nativo (`ios/`).
- Duplicados en el binario: `windows` 0.61/0.62 (`tauri-plugin-opener` trae la 0.61),
  `windows-sys` 0.59/0.60/0.61 (`if-addrs`, `arboard`/`rfd`), `png` 0.17/0.18. Solo en tiempo de
  compilación: `zip` 2/9, `bzip2` 0.6/0.4 y `ring` llegan por el build script de
  `sherpa-onnx-sys`, que además **descarga su paquete al compilar** (los fallos de CI del 23-nov).
- Pesados de compilar: `aws-lc-sys` (C con `cmake`, por `rustls` con `aws_lc_rs`,
  `src-tauri/Cargo.toml:59`), `ring`, `zstd-sys`, `bzip2-sys`, los dos `windows`,
  `webview2-com-sys`.
- `trex-agent.exe` (16 MB): thin LTO, 16 codegen-units, `panic = unwind`, tokio `full`, reqwest
  0.12 con rustls+ring, image con png/jpeg/gif/webp, xcap, enigo (otra vez windows 0.61),
  clap, rustyline, regex + ignore (`trex-cli/Cargo.toml:22,56-58`).

---

## 4. Mejoras ordenadas por impacto y esfuerzo

| # | Mejora | Impacto (medido salvo «est.») | Esfuerzo | Riesgo | Dónde |
|---|---|---|---|---|---|
| 1 | **Runtime del navegador fuera del instalador**: descargarlo y verificarlo (SHA-256 + firma) al activar Trex Browser, como las DLL de voz; o publicar dos setups | setup Windows 146,2 → ~12 MB (−92 %); rpm también; ~443 MB menos escritos y borrados en cada instalación por defecto | medio (descarga, verificación, CI que publique el runtime por plataforma) | instalaciones sin red; casar versión de app y runtime (hoy va por versión de protocolo); SmartScreen | `tauri.windows.conf.json:4-8`, `tauri.linux.conf.json:18-21`, `trex-cli.nsh`, `trex_browser.rs:261-270`, `voice.rs:138-150` como modelo |
| 2 | **Dormir el WebView2 en la bandeja**: al ocultar, `IsVisible = false` y `MemoryUsageTargetLevel = Low` con `with_webview`; al mostrar, deshacerlo. No usar `TrySuspend` (los agentes siguen trabajando en JS) | hasta los 5–8 % de un núcleo del WebView2 y memoria del renderer (est.); hoy la página no se entera de que está oculta (§3.3) | bajo (`webview2-com` 0.39, la que ya usa Tauri) | Chromium frena temporizadores de páginas ocultas (tras 5 min, encadenados a 1 por minuto): comprobar avisos, permisos, coordinación y control remoto con la ventana oculta | `src-tauri/src/tray.rs:78-91` |
| 3 | **Voz**: precalentar la esfera solo tras «oye trex»; Whisper con 1–2 hilos para la palabra de activación; a medio plazo, detector de palabra clave de sherpa-onnx y Whisper solo después | 133 ↔ 504 MB privados y 1–3 % ↔ 20–37 % de CPU según Whisper esté cargado; un renderer de 63 MB creado y destruido cada vez que se oye hablar | bajo (esfera, hilos) → medio-alto (detector) | más latencia al reconocer «oye trex»; calidad del detector en español | `voice.rs:545`, `voice.rs:699`, `voice_orb.rs:225` |
| 4 | **Adelgazar el runtime del navegador**: worker sobre el Node de Electron (`ELECTRON_RUN_AS_NODE`) en lugar de un `node.exe` aparte; importar `playwright-core` en vez de `playwright` y podar `lib/vite` y `types`; quitar `dxcompiler.dll` si no se quiere WebGPU; `SetCompressorDictSize 64` en NSIS | −23,0 (Node) −1,5 (Playwright) −6,5 (dxcompiler) −3,7 (diccionario) = **−34,7 MB comprimidos**; −130 MB en disco | bajo → medio | `RunAsNode` va contra el endurecimiento actual (`trex-browser/src/environment.rs` filtra `ELECTRON_*`); comprobar Node de Electron 45 frente a `engines >=24 <25`; sin WebGPU; +64 MB de RAM al instalar | `scripts/build-trex-browser.mjs`, `scripts/browser-build-common.mjs:89-132`, `worker/browser.mjs:6`, `worker/shared-shell.mjs:3`, `installer.nsi:15` |
| 5 | **Arranque sin procesos de más**: guardar en disco el hash del último tema enviado al navegador; no repetir la detección de CLI a los 15 s; leer el uso de cuentas al abrir «Uso» o más tarde; mover el SHA-256 y `LoadLibrary` de la voz al hilo `trex-voice` | 6+ procesos menos en los primeros 20 s; trabajo fuera del hilo principal (est.) | bajo | ninguno relevante | `browserThemeSync.ts:15-37`, `useCliUpdates.ts:78`, `useAccountUsage.ts:22`, `voice.rs:431` |
| 6 | **xterm diferido** (`lazy` en `App.tsx:64`, llevar `xterm.css` de `main.tsx:18` a `TerminalView`, quitar el grupo `xterm` de `vite.config.ts:54`); diferir también `AgentTeamView` y `AgentRoomView` (`App.tsx:66,107`) | −354 KiB (−23,5 %) y −61 KiB del JS inicial; ~11 ms de parseo de ~600 ms hasta el primer pintado: se nota poco en tiempo, más en memoria del renderer | bajo | un `Suspense` breve al abrir el primer terminal | `App.tsx:64,66,107` |
| 7 | **Pausar sondeos sin foco u oculto**: latido de coordinación, terminales de Codex, respiración del micrófono dentro de `INDICATORS` | pequeño cada uno, constante durante horas (est.) | bajo | avisos entre agentes algo más tardíos | `coordination.ts:239`, `agentTerminals.ts:100`, `activityMotion.ts:140` |
| 8 | **Broker del navegador que se apague solo** tras un rato sin espacios ni sesiones MCP | un `node.exe` menos en reposo (est.) | bajo | arranque en frío del broker la siguiente vez | `trex-browser/worker/worker.mjs:155,181` |
| 9 | **MCP de escritorio compartidos**: `desktop-mcp`/`a11y-mcp` por HTTP una vez, no dos procesos + `conhost` por chat | ~12 MB privados y 4 procesos menos por chat de Claude (medido con 5 chats) | medio | estado por chat | `trex-cli` |
| 10 | **Fuentes**: solo latin y latin-ext, solo `woff2` | −304 KiB del frontend incrustado (27 %) | bajo | otros alfabetos con la fuente del sistema | `main.tsx:13-17`, `remote/main.tsx:6-8` |
| 11 | **App móvil**: servir comprimido y sacar `timeAgo` a un módulo ligero | primera carga 495 → ~148 KiB; −27 KiB de JS | bajo-medio | ninguno | `remote.rs:451`, `RemoteApp.tsx:16` |
| 12 | **Compilación** (no lo nota el usuario, sí el desarrollo y la CI): `crate-type = ["rlib"]`; `SHERPA_ONNX_ARCHIVE_DIR` con caché en CI; `rustls` con `ring` en vez de `aws_lc_rs`; `trex-agent` con `lto = true` y `codegen-units = 1` (mantener `unwind`) | −205 MB de artefactos por build; sin `aws-lc-sys`/`cmake`; trex-agent −10/20 % (est.) | bajo | con `ring`, instalar el proveedor antes del primer TLS o hay `panic` (y con `abort` se cierra la app) | `src-tauri/Cargo.toml:16,59`, `installers.yml:47-61`, `trex-cli/Cargo.toml:56-58` |
| 13 | Ventana opaca cuando el cristal está apagado (el valor por defecto): crear la ventana desde Rust con `transparent` según el ajuste | ~25 MB privados menos (−11 %; 3 aperturas) | medio (la transparencia se fija al crear la ventana) | activar el cristal pediría reiniciar la ventana; la sombra y las esquinas redondeadas sin marco dependen de la transparencia en Windows: comprobarlas | `tauri.conf.json:24`, `src-tauri/src/window_material.rs`, `src/windowMaterial.ts:25` |

## 5. Descartado o sin efecto

- `opt-level = "s"`/`"z"` en `trex.exe`: −0,5/1,2 MB en el setup (est.) a cambio de código más
  lento; no compensa mientras el navegador pese 134 MB.
- Diferir el renderer de Markdown: al restaurar pestañas de chat se necesita enseguida; solo
  adelanta el primer fotograma y luego el contenido se recoloca. Sí compensa en la app móvil.
- Diferir voz, panel de Git o control remoto: la voz necesita su hook en `App`, el panel de Git
  se monta en cualquier chat dentro de un repo y el QR se genera en Rust.
- Recortar lenguajes de highlight.js (29 registrados a mano en `chatHighlight.ts:13-41`): ~8 KiB
  brotli en un chunk ya diferido.
- DLL de voz fuera del instalador: ya está hecho.

## 6. Cómo se midió

- **Bundle:** `node_modules/.bin/vite build --outDir <tmp> --emptyOutDir`, más un `vite.config`
  temporal que hace `mergeConfig` del del repo y vuelca `chunk.modules[id].renderedLength` en
  `generateBundle`.
- **Instalador:** `gh release view vX --repo Y0RD1N/Trex --json assets`; desglose con 7-Zip LZMA
  (`LZMA:23`, como el setup) comprimiendo cada grupo por separado.
- **Reposo de la app instalada:** árbol de procesos con `Get-CimInstance Win32_Process`, memoria
  con `Get-Process` y CPU con dos lecturas de `TotalProcessorTime`; CPU por hilo con nombres de
  `GetThreadDescription`. Sin depuradores ni cambios en la app.
- **Arranque:** binario release aislado (`identifier = com.trex.perftest`, su propia
  configuración y carpeta de WebView2), frontend en una ruta **relativa** a `src-tauri` (una ruta
  absoluta en `frontendDist` se toma como URL y la ventana carga un listado de archivos):

  ```powershell
  $env:TAURI_CONFIG = '{"identifier":"com.trex.perftest","build":{"frontendDist":"target/perf-dist"}}'
  $env:CARGO_TARGET_DIR = "<carpeta temporal>"
  $env:SHERPA_ONNX_ARCHIVE_DIR = "D:\projects\trex\src-tauri\target\sherpa-onnx-prebuilt"
  cargo build --release --locked --features tauri/custom-protocol
  ```

  y se lanza con `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9334` para leer
  por CDP `performance.timeOrigin`, la navegación, los paint y `document.visibilityState`. Al
  terminar se borran `%APPDATA%\com.trex.perftest` y `%LOCALAPPDATA%\com.trex.perftest`.

## 7. Fuentes

[1] https://docs.rs/tauri/latest/tauri/ · [2] https://docs.rs/tauri/latest/tauri/webview/struct.WebviewBuilder.html ·
[5] https://github.com/tauri-apps/tauri/blob/dev/crates/tauri-runtime-wry/src/lib.rs#L5309-L5313 ·
[6] https://github.com/tauri-apps/wry/blob/dev/src/webkitgtk/mod.rs#L691-L720 ·
[7] https://github.com/tauri-apps/tauri/issues/15656 · [8] https://github.com/tauri-apps/tauri/issues/10420 ·
[9] https://github.com/tauri-apps/tauri/issues/15682 · [16] https://github.com/tauri-apps/tauri/issues/16426 ·
[22] https://github.com/tauri-apps/tauri/pull/16054 ·
[25] https://playwright.dev/docs/webview2 · [26] https://playwright.dev/docs/api/class-browsertype#browser-type-connect-over-cdp ·
[27] https://learn.microsoft.com/en-us/microsoft-edge/webview2/how-to/chromium-devtools-protocol ·
[29] https://playwright.dev/docs/browsers ·
[31] https://webkitgtk.org/reference/webkit2gtk/2.38.1/method.WebContext.set_automation_allowed.html ·
[32] https://trac.webkit.org/wiki/RemoteInspectorGTKandWPE · [33] https://webkit.org/blog/13936 ·
[42] https://crates.io/crates/tauri-runtime-cef · [43] https://github.com/tauri-apps/tauri/releases/tag/tauri-v3.0.0-alpha.0 ·
[44] https://github.com/tauri-apps/tauri/blob/v3/crates/tauri-runtime-cef/CHANGELOG.md ·
[45] https://github.com/tauri-apps/tauri/blob/v3/crates/tauri-runtime-cef/Cargo.toml ·
[46] https://github.com/tauri-apps/tauri/blob/v3/crates/tauri-runtime-cef/src/runtime.rs ·
[47] https://github.com/tauri-apps/tauri/blob/v3/crates/tauri-runtime-cef/src/tauri_ext.rs ·
[48] https://github.com/tauri-apps/tauri/blob/v3/crates/tauri-runtime-cef/src/webview.rs ·
[49] https://github.com/tauri-apps/tauri/pull/16431 · [50] https://github.com/tauri-apps/tauri/issues/14963 ·
[51] https://github.com/tauri-apps/tauri/issues/16610 y /15718 · [52] https://cef-builds.spotifycdn.com/index.html ·
[56] https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setparent ·
[57] https://devblogs.microsoft.com/oldnewthing/20130412-00/?p=4683 ·
[58] https://canonical.com/mir/docs/2.26/explanation/window-positions-under-wayland/ ·
WebView2 y visibilidad: https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2controller#put_isvisible ·
`MemoryUsageTargetLevel`: https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2_19
