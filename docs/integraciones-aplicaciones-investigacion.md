# Integraciones de aplicaciones: estado actual y cómo mejorarlas

Fecha: 2026-11-10. Alcance: la sección **Ajustes → Integraciones → Aplicaciones**
(Blender, HyperFrames, GitHub CLI) y cómo la usan Claude Code, Codex, Antigravity
y Trex CLI. No se cambió código; este documento es solo la investigación.

Leyenda de evidencia: **[código]** leído en este repositorio, **[medido]** probado
en esta máquina, **[fuente]** leído en la documentación o el repositorio del
proveedor por un investigador (no reabierto por mí salvo que se diga),
**[inferencia]** conclusión mía, sin comprobar.

## 1. Veredicto

1. **Lo que hay es un anuncio, no una integración, para tres de los cuatro agentes.**
   Claude, Codex y Antigravity reciben una frase por aplicación en el prompt
   (`src/integrations.ts:86-88`) y usan su propio shell. Solo Trex CLI tiene
   herramientas reales (`github_*`, `blender_run`, `hyperframes_run`).
2. **Las herramientas de Trex CLI son demasiado estrechas** para el trabajo real:
   HyperFrames expone 3 de unos 45 comandos; Blender no inspecciona ni devuelve
   imágenes; GitHub oculta el error real de `gh`.
3. **MCP o CLI no es la pregunta correcta.** La evidencia dice: el CLI gana en
   coste y fiabilidad cuando el agente puede ejecutarlo; MCP gana donde hay
   credenciales, sandbox sin red, imágenes o permisos que imponer. Lo que decide
   es **dónde vive cada cosa**: el conocimiento (cómo usar la app) en *skills*, la
   ejecución con riesgo o con imagen en **un servidor MCP propio** que reutiliza
   el código que ya existe, y el CLI desnudo donde basta.
4. **La infraestructura para hacerlo ya existe**: el trait `ToolProvider`, el
   patrón de doble superficie de `DesktopProvider` (nativo + MCP stdio) y la
   inyección de MCP por sesión en los tres agentes externos. El trabajo nuevo es
   mucho menor de lo que parece.

## 2. Cómo está implementado hoy

### 2.1 Qué recibe cada agente [código]

| | Guía de las apps | Herramientas de las apps | El interruptor… |
|---|---|---|---|
| Claude Code | Frase en `--append-system-prompt` (`claudeChat.ts:70`) | Ninguna: usa Bash | solo quita la frase |
| Codex | Frase en `developerInstructions` (`useCodexChat.ts:131`) | Ninguna: usa su shell | solo quita la frase |
| Antigravity | Frase dentro de `<trex_context>` (`useAntigravityChat.ts:211`) | Ninguna | solo quita la frase |
| Trex CLI | Prompt de sistema + `instructions` | `github_*` (5), `blender_run`, `hyperframes_run` | **sí oculta la herramienta** (`useTrexChat.ts:193`, `tools.rs:246-262`) |

Las tres frases son estas (`src/integrations.ts:86-88`): GitHub «usa el `gh`
instalado… verifica el head del merge»; Blender «ejecuta scripts bpy en un proceso
background nuevo… no una ventana abierta»; HyperFrames «usa el CLI para lint,
snapshot o render». La UI es honesta («se anuncian a tus agentes»), pero un
usuario razonablemente espera que desactivar GitHub impida que Claude lo use, y
no lo impide. Las pruebas (`scripts/integration-controls.test.mjs`) fijan este
comportamiento a propósito.

### 2.2 Hallazgos

**H1 · HyperFrames: 3 de ~45 comandos y el bucle visual roto (alto).**
`hyperframes_run` solo admite `lint`, `snapshot` y `render`
(`trex-cli/src/hyperframes.rs:18`).
- Falta `check --json`, la puerta que el propio proyecto recomienda (lint estático
  + runtime + layout + contraste). `lint` solo da una validez aparente.
- `snapshot` valida un directorio `snapshots` pero **no se lo pasa al CLI**
  (`hyperframes.rs:76-77`); el CLI escribe en `.hyperframes/artifacts/snapshots/…`
  y la herramienta no devuelve las rutas. El modelo no llega a ver los fotogramas.
- `render` no admite calidad, fps, formato ni composición (el CLI sí: `-q`, `-f`,
  `--format`, `-c`).
- Faltan `init`, `preview`, `doctor`, `timeline`, `catalog/add`, `transcribe`, `tts`.
- Tu CLI es la 0.9.10 **[medido]**; la última en npm es la 0.9.32 **[medido]**.
- La guía enlaza a `hyperframes.app`; el `homepage` del paquete en npm es
  `hyperframes.heygen.com` **[medido]**.
- El proyecto publica 9 skills y recomienda el bucle lint → check → snapshot →
  preview → render **[fuente]**. Tu máquina ya las tiene en `~/.claude/skills`,
  `~/.agents/skills` y `~/.codex/skills` **[medido]**; Trex no las conoce ni las
  monta.

**H2 · Blender: dos pasos, sin ojos y mirando a otro lado (alto).**
- `blender_run` exige un `.py` ya escrito en el workspace (`blender.rs:44-50`):
  una introspección de una línea cuesta dos llamadas y ensucia el proyecto.
- Devuelve stdout/stderr en bruto: sin JSON estructurado, sin inspección de
  escena, sin render ni captura para el modelo.
- La frase dice «no una ventana abierta». Tu proyecto `cibercoffe` ya usa lo
  contrario: un puente en vivo (`cafe_bridge.py`, socket local con token, ejecución
  en el hilo principal vía timer, captura de `VIEW_3D`) **[medido]**. El propio
  documento de Trex lo lista como pendiente (`docs/integraciones-escritorio.md`).
- Detección en Linux: solo `PATH` y `~/.local/bin` (`src-tauri/src/integrations.rs:63-64`
  devuelve `false` fuera de Windows). Flatpak, Snap o un tar.xz fuera del `PATH`
  salen «No detectado». Y no detectado **retira** la frase y oculta la
  herramienta nativa (`tools.rs:249-250`): una detección corta quita capacidad.
- Blender 5.x rompe código generado «de memoria» de la 4.x (`BLENDER_EEVEE_NEXT` →
  `BLENDER_EEVEE`, `scene.node_tree` → `compositing_node_group`, `bgl` eliminado)
  **[fuente]**. Nada de esto llega al agente.

**H3 · GitHub: el error real se descarta (medio).**
`gh` se ejecuta con `stderr(Stdio::null())` (`github.rs:334`) y cualquier fallo se
convierte en «GitHub CLI failed; check authentication and repository access»
(`github.rs:370`). El modelo no distingue permisos, rama sin subir, checks
requeridos o conflicto, y reintenta o adivina. Tampoco hay checks/logs de CI,
issues, comentarios ni lectura con `gh api`. Lo bueno, y conviene conservarlo:
`--match-head-commit` obligatorio, sin `--admin`, sin borrar ramas, escritura
incierta nunca se reintenta, cuerpo por stdin.

**H4 · El sandbox de Codex bloquea la red en el modo estándar (medio, a probar).**
Trex fija `workspace-write` con `networkAccess: false` salvo en «Permitir todo»
(`src/codexChat.ts:246`, `:262-264`). La documentación oficial de Codex dice que la
red está desactivada por defecto en ese modo **[fuente: búsqueda mía, páginas
oficiales de developers.openai.com]**. Entonces «usa el `gh` instalado» puede fallar
o provocar peticiones de aprobación. Antigravity también arranca sin red por
defecto **[fuente]**. Que un servidor MCP lance sus procesos fuera de ese sandbox
es **[inferencia]**: hay que probarlo.

**H5 · Detección duplicada y sin versiones (medio).**
Hay cuatro copias casi idénticas de «buscar el binario» (`integrations.rs`,
`github.rs`, `blender.rs`, `hyperframes.rs`). Hoy coinciden en lo esencial; el
riesgo es que se desincronicen (la app dice «Detectado» y el agente no lo
encuentra, o al revés) y que añadir Flatpak/Snap obligue a tocar las cuatro. La
interfaz admite que «no comprueba versiones». En tu máquina
HyperFrames se detecta por el enlace `~/.local/bin/hyperframes`; con un npm global
bajo mise/nvm dependería del `PATH` que herede la app **[inferencia]**.

**H6 · Higiene del entorno (bajo).** El CLI de HyperFrames se autoactualiza en
segundo plano y envía telemetría salvo exclusión **[fuente]**, lo que contradice el
«nunca instala» de Trex. Las variables `HYPERFRAMES_NO_UPDATE_CHECK`,
`HYPERFRAMES_NO_AUTO_INSTALL`, `HYPERFRAMES_NO_TELEMETRY` y `HYPERFRAMES_AGENT=1`
están documentadas **[fuente]** y Trex no las exporta.

**H7 · Ninguna guía de uso, solo descripciones de herramienta.** Ni `GithubProvider`,
ni `BlenderProvider`, ni `HyperframesProvider` implementan `guidance()` (solo lo
hacen `desktop.rs` y `mcp.rs`). Trex CLI recibe una línea y el JSON Schema.

### 2.3 Lo que ya existe y se puede reutilizar [código]

- **`ToolProvider`** (`tools.rs:63`): una definición, un `execute`, `is_mutating`,
  `guidance`. Los tres proveedores de apps ya lo implementan.
- **Doble superficie**: `DesktopProvider` se sirve nativo a Trex CLI y por MCP stdio
  (`desktop_mcp::serve`, subcomando `trex-agent desktop-mcp`) al resto. Es el molde.
  Límites de ese servidor: una sola operación a la vez, `cwd` fijo a `"."`, marcos
  de 64 KiB.
- **MCP por sesión en los tres externos**: Claude `--mcp-config`
  (`useClaudeChat.ts` ~l.486), Codex `mcp_servers.*` con `default_tools_approval_mode`
  (`useCodexChat.ts` ~l.552-575), Antigravity ACP `session/new { mcpServers }`
  (`useAntigravityChat.ts:145-151`, componente oficial `agy-acp-server` 1.4.4).
  Claude además recibe `trex_inbox` dentro del proceso (puente SDK, `inboxProtocol.ts`).
- **Banco de evaluación opt-in** (`trex-cli/src/evaluation.rs`): casos con un
  workspace temporal limpio por caso.
- **Skills**: Trex **no monta skills por sesión** en ningún agente. Con Codex solo
  llama a `skills/list` para el menú de barra (`useCodexChat.ts:207`).

## 3. Verificación en tu máquina [medido]

| Dato | Resultado |
|---|---|
| Blender | 5.2.2 LTS, symlink en `~/.local/bin` → `~/.local/opt/blender` |
| Arranque en frío `blender -b --factory-startup --python` (escena por defecto) | 0.38–0.68 s por llamada; devolvió JSON por stdout con un marcador |
| `gh` | 2.100.0, sesión activa por keyring, alcances `repo, workflow, read:org, gist` |
| `gh pr list --json` (repo público) | 0.56–0.68 s |
| HyperFrames | 0.9.10 (última 0.9.32); `doctor` 1.8 s; Chrome headless, FFmpeg y Docker/podman presentes; TTS/BGM locales no instalados |
| MCP globales del usuario | `MiniMax`, `playwright` (Claude); `node_repl`, `MiniMax`, `playwright` (Codex). Ninguno de Blender/GitHub/HyperFrames |
| `agy` (Antigravity) | no instalado en esta máquina: Antigravity **no se probó en vivo** |

Conclusión práctica: el coste de arranque de Blender headless es pequeño (≈0.4 s);
**no es el argumento contra el modo headless**. Lo que le falta es estado entre
llamadas (hay que guardar y recargar el `.blend`), ojos (imagen) y estructura.

## 4. Estado del arte

### 4.1 MCP vs CLI vs skills

Cifras de OpenRouter (nov-2026, Sonnet 5.5, **una** tarea de GitHub de solo lectura,
3 repeticiones por variante) **[fuente]**:

| Variante | Tokens de entrada |
|---|---|
| CLI `gh` | 1.421 |
| Skill | 3.315 |
| MCP con 2 herramientas | 23.228 |
| MCP con 46 herramientas | 59.417 |
| MCP con 91 herramientas | 101.351 |

- Con tool search diferido el coste inicial baja a 578 tokens, pero Haiku 5.5
  empeora por reintentos **[fuente]**. Un solo resultado grande (42 KB) costó más
  que las 46 definiciones: el **tamaño de las respuestas** pesa tanto como el catálogo.
- Scalekit (mar-2026, Sonnet 4, 75 ejecuciones): MCP gasta 4–32 veces más tokens;
  fiabilidad CLI 100 % frente a 72 %, pero los 7 fallos fueron *timeouts* de red del
  servidor remoto, y el autor vende pasarelas MCP **[fuente, con sesgo]**.
- Anthropic: `defer_loading` baja un catálogo de ~77K a ~8,7K tokens; Claude Code
  ya difiere las herramientas MCP por defecto. Su documentación resume el reparto:
  «MCP da la conexión; una skill enseña a usarla bien» **[fuente]**.
- Límites de estas pruebas: una tarea de lectura, un servicio, pocas repeticiones.
  Sirven para el orden de magnitud, no para decidir por sí solas.

### 4.2 Skills como vehículo

- `SKILL.md` es un estándar abierto (agentskills.io): `name` ≤64, `description`
  ≤1024, cuerpo recomendado <5.000 tokens; solo ~100 tokens de metadatos entran al
  contexto hasta que se usa **[fuente]**.
- Los tres agentes lo leen. Claude Code también acepta campos extra propios; fuera
  de él conviene un `SKILL.md` limpio **[fuente]**.
- HyperFrames ya publica 9 skills y manifiestos para Claude, Codex y Gemini, y un
  `hyperframes skills update` **[fuente]**.
- Montaje por sesión sin tocar la configuración global **[fuente, sin probar]**:
  Claude `--plugin-dir`; Codex app-server `skills/extraRoots/set`; Antigravity solo
  rutas de archivo (`<proyecto>/.agents/skills`, `~/.gemini/config/skills`), **sin
  opción por sesión documentada**.

### 4.3 Especificación MCP y diseño de herramientas

- Última revisión: **2026-07-28** (sin `initialize` ni sesión; `tools/list` con
  `ttlMs`; muestreo, *roots* y *logging* deprecados). Claude Code ya la negocia
  **[fuente]**. El servidor de Trex habla `2025-06-18` (`desktop_mcp.rs`).
- Las anotaciones (`readOnlyHint`, `destructiveHint`…) son **pistas**, no garantías:
  «hints inform; contracts enforce» **[fuente]**. El modo plan lo impone Trex.
- Guía de Anthropic para herramientas: pocas y de alto nivel, con prefijo por app,
  salida concisa por defecto, paginación/truncado, errores que digan qué corregir,
  imágenes como contenido `image` **[fuente]**.
- No depender de *elicitation* ni de *sampling*: en modo no interactivo se cancelan.

### 4.4 Blender

- **Existe un MCP oficial**: *Blender Lab MCP* (`projects.blender.org/lab/blender_mcp`);
  repo y estadísticas comprobados por mí: 37★, 27 incidencias abiertas,
  actualizado el 2026-09-29 **[medido]**. Anthropic lo presentó como conector el
  2026-04-28 **[fuente]**. 26 herramientas con anotaciones de riesgo, resúmenes de
  escena en capas, capturas al modelo, documentación de la API incluida y
  búsqueda; add-on en instancia abierta (Blender ≥5.1); GPL-3.0+; **sin sandbox ni
  autenticación en el socket**; su incidencia #72 describe un bloqueo de 120 s con
  add-ons de usuario activos **[fuente]**.
- `ahujasid/mcp-for-blender` (33,9k★): assets (Poly Haven, Sketchfab, Hyper3D…),
  socket sin autenticación **[fuente]**. Existe un CVE sobre el blender-mcp
  comunitario por ejecución arbitraria **[fuente secundaria]**.
- Headless **[medido por el investigador]**: `bpy.app.timers` no se dispara en `-b`
  una vez termina el script; `bpy.ops.ed.undo()` falla en `-b`. No hay demonio
  headless con estado vivo «gratis»; el estado es el `.blend` en disco. `bpy` por
  pip exige Python 3.13 exacto y pesa ~430 MB: mejor el binario de Blender.
- `--factory-startup` es obligatorio (sin él, add-ons de usuario cuelgan el CLI);
  `blender_run` ya lo usa.
- Buenas prácticas publicadas en skills de Blender: API de datos antes que
  operadores, `temp_override` si hace falta uno, verificar con números y render,
  copia previa con `save_as_mainfile(copy=True)`.
- Instalaciones a detectar: Flatpak (`flatpak run org.blender.Blender`), Snap
  (`/snap/bin/blender`, clásico), tar.xz en `~/blender-*` / `/opt`, Steam, Windows
  MSI/zip y macOS `.app`. La versión de Microsoft Store descarta stdout/stderr y
  `blender.exe` da acceso denegado: marcar «limitado». `blender --version` tarda
  0.08 s y no abre escena.

### 4.5 HyperFrames

- Repositorio oficial `heygen-com/hyperframes` (Apache-2.0), docs en
  `hyperframes.heygen.com` **[fuente + medido en npm]**.
- La mayoría de comandos aceptan `--json`; códigos 0/1/2; **nunca preguntan** con
  stdout sin TTY o dentro de un agente; lo interactivo (`publish`, `upgrade`) sale
  con 2 y nombra `--yes` **[fuente]**.
- `check --json` es la puerta; `snapshot --review --json` devuelve las rutas de los
  PNG; `preview --background` sirve el estudio en el puerto 3002 **[fuente]**.
- `HF_TOOL_CONTEXT` está pensado para integradores: el CLI escribe NDJSON con las
  rutas absolutas de los artefactos y serializa `check`/`snapshot` con un bloqueo de
  proyecto **[fuente]**. Es exactamente el caso de Trex.
- Hay un MCP **alojado** (OAuth de HeyGen, beta) y WebMCP dentro del navegador; **no
  hay MCP local** **[fuente]**. No sirve para estos agentes.
- Fallos conocidos: sandbox estilo seatbelt cierra Chrome en macOS; ~45 s extra por
  render si no hay timeline; `project.lock` bloquea comandos concurrentes **[fuente]**.

### 4.6 GitHub

- `github/github-mcp-server` v2.1.0: remoto (`api.githubcopilot.com/mcp`) o binario
  local `stdio`; *toolsets*, `--read-only`, `--tools/--exclude-tools`,
  `--lockdown-mode` (filtra contenido de autores sin permiso de escritura, «mejor
  esfuerzo»). El modo de herramientas dinámicas **ya no aparece** en la documentación
  actual **[fuente]**. Reutilizar el token de `gh` **no está soportado de forma
  directa**; lo habitual es inyectar `GITHUB_PERSONAL_ACCESS_TOKEN` **[fuente]**.
- `gh` 2.103.3 ofrece lo que un agente necesita: `pr checks --json … --required`,
  `run view --log-failed`, `pr merge --match-head-commit`, `api --paginate --jq`
  **[fuente]**. `gh` no tiene modo solo lectura.
- Riesgo real: **inyección indirecta**. Un issue público malicioso hizo que un
  agente filtrara repositorios privados (Invariant Labs, 2025-05); el fallo es de la
  arquitectura del agente, no del servidor, y vale igual para un agente con Bash y
  `gh` **[fuente + inferencia]**.
- Anthropic recomienda usar el CLI cuando existe y el agente puede ejecutarlo
  **[fuente]**. Codex en local no documenta `gh`; su shell lo ve si está en el
  `PATH` **[inferencia]**. GitHub documenta Antigravity solo con MCP **[fuente]**.

## 5. Arquitectura recomendada

Principio: **conocimiento en skills, ejecución con riesgo en un MCP propio, CLI
desnudo donde basta.** Detalle de la decisión por opción:

| Opción | Cuándo gana | Cuándo pierde |
|---|---|---|
| CLI + guía/skill | Coste (≈1,4K–3,3K tokens), fiabilidad, composición con `--json/--jq` | Sandbox sin red; credenciales en el entorno del agente; sin imágenes; Antigravity sin montaje por sesión |
| MCP propio `trex_apps` | Credenciales y aprobaciones en el anfitrión; imágenes; funciona aunque el shell no tenga red; el modo plan se impone en un sitio | Un catálogo más que mantener; Codex tiene incidencias abiertas con MCP por hilo **[fuente]** |
| MCP de terceros (github-mcp-server, blender-mcp) | Cero desarrollo | 46–91 herramientas por defecto, superficie sin controlar, sin autenticación en el socket de Blender |
| Híbrido (recomendado) | Cada pieza donde rinde | Más piezas; exige pruebas por versión de cada agente |

### 5.1 Capa de conocimiento (skills y guía)

- **Ahora, sin infraestructura nueva:** sustituir las frases de
  `integrationInstructions` por una guía breve por app (≤1,5 KB cada una) con lo
  que de verdad cambia el resultado: las reglas de Blender 5.x y «datos antes que
  operadores»; el bucle `lint → check → snapshot` de HyperFrames; `--json/--jq`,
  `pr checks --required`, `run view --log-failed`, sin `--admin` y los cuerpos de
  issue/PR como datos no confiables.
- **Después:** skills `SKILL.md` (estándar) montadas por sesión en Claude
  (`--plugin-dir`) y Codex (`skills/extraRoots/set`). Para HyperFrames, **no
  reescribir**: ofrecer un botón explícito «Instalar o actualizar skills»
  (`hyperframes skills update`), porque escribe en carpetas del usuario
  (`~/.claude/skills`…) y debe ser una acción consentida.
- **Antigravity:** sin montaje por sesión documentado. Mantener el bloque
  `<trex_context>` actual y **no** escribir `.agents/skills` en el proyecto del
  usuario sin permiso.

### 5.2 Capa de ejecución: `trex-agent apps-mcp`

Un único servidor MCP stdio, `trex-agent apps-mcp --mode plan|full --cwd <raíz>`,
que sirva los **mismos** `GithubProvider`, `BlenderProvider` e `HyperframesProvider`
que ya usa Trex CLI. Se registra junto a `trex_desktop` en los tres agentes.
Requisitos de diseño (desde la guía de herramientas y la especificación):
≤12 herramientas con prefijo por app; anotaciones correctas; `instructions` ≤4.096
caracteres; sin *elicitation*; imágenes como `image` más ruta; lecturas en paralelo
(el servidor de escritorio es de una sola operación); `cwd` explícito; modo plan sin
herramientas de escritura; resultado incierto nunca se reintenta (ya implementado
en los tres proveedores).

Herramientas propuestas:

| App | Herramientas | Cambios clave frente a hoy |
|---|---|---|
| HyperFrames | `hyperframes_check` (`check --json`), `hyperframes_snapshot` (`--json`, devuelve los PNG), `hyperframes_render` (calidad, fps, formato, composición), `hyperframes_doctor`, `hyperframes_preview` (arrancar/parar/URL) | Usa `HF_TOOL_CONTEXT` y entorno sin telemetría ni autoactualización. `init/add/timeline/tts/transcribe` se dejan al CLI con las skills del proyecto |
| Blender | `blender_inspect` (JSON en capas, solo lectura, sobre copia), `blender_preview` (render rápido → imagen), `blender_run` (acepta `code` en línea o `script`, marcadores JSON de resultado/error, copia `.blend` previa) | Detección ampliada (Flatpak, Snap, tar.xz, `BLENDER_PATH`) y `--version`; `--offline-mode` |
| GitHub | Mantener los 5 actuales; añadir `github_checks`, `github_run_log` (`--log-failed`) y una lectura `github_api` (solo GET) | **Devolver el `stderr` saneado y recortado** en vez del mensaje genérico |

Por qué también GitHub por MCP, si `gh` es más barato: no por coste, sino porque
(a) en Codex y Antigravity el shell puede no tener red (H4); (b) el token nunca
entra en el contexto; (c) la guarda `--match-head-commit` y el modo plan se aplican
en un solo sitio. Claude puede seguir usando `gh` por Bash: esto es una vía con
guardas, **no** una frontera de seguridad mientras el agente conserve un shell.

### 5.3 Blender en vivo (opcional, más adelante)

Tu `cafe_bridge.py` demuestra la necesidad (selección del usuario, viewport,
deshacer de la GUI). No conviene que Trex escriba su propio puente: ofrecer el
**Blender Lab MCP oficial** como servidor opt-in (instalación guiada, no
empaquetado por ser GPL), sabiendo que no tiene sandbox ni autenticación en el
socket y que exige Blender ≥5.1. `ahujasid` solo para assets, con telemetría
desactivada. Ejecutar Python en Blender es ejecutar código local arbitrario: en
modo plan, solo lectura; en modo completo, mostrar el script y pedir confirmación.

### 5.4 GitHub MCP oficial (opcional)

Solo para un modo «triaje de repositorios no confiables»: binario local `stdio` con
`--read-only --lockdown-mode` y un conjunto corto de *toolsets*, con un token de
grano fino. No como camino por defecto.

## 6. Plan por fases

| Fase | Qué | Esfuerzo (estimación) | Verificación |
|---|---|---|---|
| 0 | Arreglos baratos en lo que ya existe: devolver `stderr` en GitHub; HyperFrames `check`, ruta y rutas de PNG, `--json`; URL de la guía; variables de entorno de HyperFrames; detección de Blender (Flatpak/Snap/tar.xz/`BLENDER_PATH`) y `--version`; unificar los cuatro `find_*` | horas–1 día | pruebas Rust existentes + casos nuevos con ejecutables simulados |
| 1 | Guía por app más rica en `integrationInstructions` (≤1,5 KB) y `guidance()` en los tres proveedores | horas | `integration-controls.test.mjs` ampliado |
| 2 | `trex-agent apps-mcp` y registro en Claude/Codex/Antigravity; **prueba de humo por versión** de cada agente | días | prueba real de red bajo `workspace-write` en Codex; ACP en Antigravity |
| 3 | `blender_inspect` y `blender_preview` | días | `.blend` reales en proyecto temporal (ya hay un test `#[ignore]`) |
| 4 | Montaje de skills por sesión (Claude, Codex) y botón de skills de HyperFrames; la interfaz muestra por agente «herramientas + guía» o «solo guía» | días | prueba de proceso |
| 5 | Opt-in: Blender Lab MCP y github-mcp-server solo lectura | opcional | solo si hay demanda |

Medición: el aviso del propio documento (`integraciones-escritorio.md`) es que
recibir el catálogo no garantiza que el modelo elija bien. Antes y después de cada
fase conviene un conjunto fijo de tareas por app (p. ej. «crea un cubo y
renderízalo», «valida y mira fotogramas de un proyecto HyperFrames», «lista PRs y
explica por qué falla la CI») ejecutado en cada proveedor, midiendo éxito, llamadas
a herramientas y tokens. `trex-cli/src/evaluation.rs` ya es opt-in y usa un
workspace temporal por caso.

## 7. Qué no se verificó

- **Antigravity en vivo**: `agy` no está instalado aquí. Que `agy-acp-server` respete
  `session/new { mcpServers }` es lo que Trex ya asume para `trex_inbox/browser/
  desktop/a11y`, pero no lo probé; el montaje de skills por sesión no está documentado.
- **Codex**: que un servidor MCP escape del sandbox de red del shell, y las
  incidencias abiertas con `config` en `thread/start` (#45361) y MCP en `codex exec`
  (#24135) **[fuente secundaria]**.
- Las cifras de OpenRouter y Scalekit las leyó el investigador; yo no reabrí esas
  páginas. Son de tareas de solo lectura sobre un servicio.
- CVE-2026-10688 y el traspaso de agentskills.io a la Linux Foundation:
  **[fuente secundaria]**.
- Windows y macOS: nada de esto se probó fuera de Linux.
- No se ejecutó ningún modelo de pago para esta investigación (los investigadores
  solo buscaron y leyeron documentación).

## 8. Fuentes principales

- Blender Lab MCP: https://projects.blender.org/lab/blender_mcp · https://www.blender.org/lab/mcp-server/
- Anthropic, Claude for Creative Work: https://www.anthropic.com/news/claude-for-creative-work
- Manual de línea de comandos de Blender: https://docs.blender.org/manual/en/latest/advanced/command_line/arguments.html
- HyperFrames (repo): https://github.com/heygen-com/hyperframes · docs: https://hyperframes.heygen.com/packages/cli.md · skills: https://hyperframes.heygen.com/guides/skills.md · integradores: https://hyperframes.heygen.com/developers/harness-tool-context.md
- github-mcp-server: https://github.com/github/github-mcp-server · `gh`: https://cli.github.com/manual/
- OpenRouter, MCP vs CLI vs Skills: https://openrouter.ai/blog/insights/mcp-vs-cli-vs-skills/
- Scalekit: https://www.scalekit.com/blog/mcp-vs-cli-use
- Anthropic: https://www.anthropic.com/engineering/code-execution-with-mcp · https://www.anthropic.com/engineering/writing-tools-for-agents · https://www.anthropic.com/engineering/advanced-tool-use
- Claude Code MCP y skills: https://code.claude.com/docs/en/mcp · https://code.claude.com/docs/en/skills
- agentskills.io: https://agentskills.io/specification
- MCP 2026-07-28: https://modelcontextprotocol.io/specification/2026-07-28/changelog · anotaciones: https://blog.modelcontextprotocol.io/posts/2026-03-16-tool-annotations/
- Codex: https://developers.openai.com/codex/agent-approvals-security · https://learn.chatgpt.com/docs/extend/mcp?surface=cli
- Antigravity: https://antigravity.google/docs/mcp/ · https://antigravity.google/docs/permissions · https://antigravity.google/docs/ide/extensions/acp
- Invariant Labs: https://invariantlabs.ai/blog/mcp-github-vulnerability
