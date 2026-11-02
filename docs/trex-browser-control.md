# Control de Trex Browser por agentes: propuesta

Estado: propuesta (1 nov 2026). Resume cómo se conectan hoy los agentes, qué
alternativas existen y qué recomendamos para que controlar el navegador sea más
sencillo, rápido y cómodo, tanto para el agente como para la persona.

## 1. Cómo funciona hoy

```
agente ──stdio──► trex-browser (launcher Rust) ──► node worker.mjs mcp
        └─► HTTP loopback + token ──► broker ──► Playwright ──► Chrome
```

- **Arranque por chat:** `doctor` (×2) → `spaces` → `prepare` → la configuración MCP
  se genera en **tres formatos** (JSON `--mcp-config` en Claude, claves con puntos
  en Codex, array ACP en Antigravity). Trex CLI no usa MCP: lanza
  `trex-browser call` **por cada herramienta** (un proceso Node por llamada).
- **Por llamada:** `/health` + `/grant` + `/call`. La app (Tauri) además ejecuta
  `doctor` antes de cada llamada.
- **Fricciones:** `prepare` existe solo por el *job breakaway* de Windows; cambiar
  el modo de permisos obliga a reiniciar la sesión del agente; hay que pasar
  `tabId` + `revision` + `ref` juntos y muchas acciones invalidan refs
  (`STALE_SNAPSHOT`); la lista de herramientas está duplicada en Rust y JS.

## 2. Alternativas evaluadas

| Opción | Comodidad para el agente | Rendimiento | Riesgos |
|---|---|---|---|
| **MCP stdio** (actual) | Buena, universal | Un proceso por agente; cadena de 5 saltos | Arranque lento, breakaway en Windows |
| **MCP Streamable HTTP en el broker** | Igual de universal; sin procesos que lanzar | Una conexión persistente, sin `prepare` | Cursor CLI tiene bugs con cabeceras; Antigravity no expande variables de entorno → token en el fichero o en la URL |
| **CLI + skill** (`trex-browser click @e3`) | Funciona en cualquier agente con shell; buena para encadenar | Más viajes; sujeto a los permisos de shell del agente | Aprobaciones menos estructuradas |
| **Plugin nativo por agente** (plugin de Claude Code, plugin de Codex, skills de Antigravity) | Lo mejor para *enseñar* el flujo de trabajo | Igual que el MCP que empaqueta | Cuatro formatos distintos que mantener |
| **Code mode** (el agente escribe un script de Playwright que el worker ejecuta) | Muy eficiente en flujos largos | Muy pocos tokens | Es ejecución de código: requiere sandbox y solo en modo *full* |
| WebDriver BiDi | — | — | Electron/Chromium lo soportan peor que CDP; no compensa |

Referencias de diseño de herramientas: Playwright MCP (snapshot accesible + refs,
`--caps`), Vercel agent-browser (snapshot solo de elementos interactivos, refs `@e1`),
Chrome DevTools MCP (perfilado y red), Stagehand (primitivas en lenguaje natural:
añaden un segundo modelo y latencia, no compensan con Claude o Codex).

## 3. Recomendación

**MCP sigue siendo el protocolo, pero servido por HTTP desde el broker, con una
superficie de herramientas más pequeña y un plugin por agente encima.** No es
"MCP o plugin": el plugin empaqueta la conexión MCP y las instrucciones.

### 3.1 Un único servidor MCP HTTP en el broker

- `http://127.0.0.1:<puerto>/mcp` con un **token de sesión** por agente. El token
  representa el binding `{proyecto, perfil, clientId, modo}` en el servidor, así que
  el agente no puede cambiarlo.
- El agente **no lanza ningún proceso**: desaparecen `prepare`, el doble `doctor` y
  el problema del *job breakaway* de Windows.
- **Cambiar el modo de permisos** ya no reinicia la conversación: el servidor
  actualiza el binding y emite `notifications/tools/list_changed`.
- Configuración por agente:
  - Claude: `--mcp-config` con `{"type":"http","url":…,"headers":{"Authorization":"Bearer …"}}` + `--strict-mcp-config`.
  - Codex: `mcp_servers.trex_browser.url` + `bearer_token_env_var` (token en el entorno del proceso).
  - Antigravity (ACP): servidor `http` si el agente anuncia la capacidad; si no, el shim stdio actual.
  - Trex CLI: cliente HTTP en proceso (sin un proceso Node por llamada).
- **El shim stdio se conserva** como respaldo para clientes con bugs (Cursor) o sin HTTP.

### 3.2 Herramientas más cómodas para el modelo

1. **Snapshot en modo `ai` de Playwright** (`page.ariaSnapshot({mode:'ai'})`) con refs
   nativas (`f1e2`) resueltas con `page.getByRef`. Ya se verificó en el shell.
   Sustituye las refs propias basadas en handles y reduce los `STALE_SNAPSHOT`.
2. **Cada acción devuelve un recibo compacto**: URL/título, diálogos, errores de
   consola nuevos y un *diff* del snapshot, para no tener que volver a capturar
   después de cada clic.
3. **Unas 12 herramientas base** (navigate, snapshot, find, click, type, fill_form,
   press_key, select, screenshot, tabs, wait_for, batch) y el resto por grupos de
   capacidades (red, rendimiento, vídeo, emulación) que se activan según el modo.
4. **Anotaciones MCP** `readOnlyHint` / `destructiveHint`: Codex puede aprobar
   automáticamente las lecturas (`default_tools_approval_mode = "writes"`).
5. **Salidas grandes como artefactos** (`resource_link`) en lugar de texto en línea.
6. `browser_run_code` (script Playwright en sandbox) solo en modo *full*.

### 3.3 Plugin por agente (encima del MCP)

Un paquete por agente con la configuración MCP y una **skill** que enseña el
flujo: *snapshot → actuar con ref → verificar con el recibo → nunca repetir una
acción incierta → si el usuario tomó el control, esperar*. En Claude Code puede
incluir además un hook que informe a Trex.

### 3.4 Persona ↔ agente en el propio navegador (implementado en el shell)

- El marco se tiñe mientras un agente actúa; la barra inferior muestra la
  herramienta y el objetivo, con **Pausar** y **Tomar control**.
- **Centro de agentes** (`Ctrl+Shift+A`): una tarjeta por espacio del proyecto, con
  miniatura en vivo, estado, herramienta, pestaña y URL, y controles por tarjeta.
- Los controles humanos aplican la misma pausa explícita que `browser_pause`. El
  agente ve `PAUSED` en su siguiente llamada; con canales de Claude
  (`claude/channel`) se puede avisar al agente al instante.

## 4. Plan por fases

| Fase | Contenido | Resultado |
|---|---|---|
| A (hecho) | Shell Electron + integración con el worker por CDP pipe | Navegador con diseño Trex; mismas 42 herramientas |
| B (hecho) | Endpoint MCP HTTP en el broker + tokens de sesión; Claude y Codex por HTTP | Sin procesos por agente; cambio de modo sin reinicio en Claude |
| C (en parte) | `browser_snapshot {compact:true}` y resumen `effect` en cada acción (URL, título, pestañas, diálogos, errores de consola). Falta: refs nativas `ai` y anotaciones | Menos llamadas y menos tokens |
| D | Plugins/skills por agente; Trex CLI por HTTP | Instalación y flujo guiado en cada agente |
| E | Code mode en sandbox (solo *full*) | Flujos largos con pocos tokens |

## Estado de la fase B (implementada)

- **Broker:** `POST /mcp` habla JSON-RPC, con respuestas JSON y sin SSE.
  - Solo loopback, con `Host` exacto, sin `Origin` y con `Bearer` por agente.
  - `trex-browser mcp-session --stdin-json {cwd,mode,clientId,profile}` devuelve `{url, token, mode}`.
  - Volver a pedirlo para el mismo agente devuelve **el mismo token** con el nuevo modo.
  - Los tokens viven en `mcp-sessions.json` (privado, 0600) y caducan tras 30 días sin uso.
  - El puerto se reutiliza (`broker-port`), así que la URL sobrevive a un reinicio del broker.
- **Clientes reales verificados:**
  - Claude Code: `{"type":"http","headers":{"Authorization":"Bearer ${TREX_BROWSER_TOKEN}"}}` en `--mcp-config`, con el token en el entorno del proceso.
  - Codex CLI 0.165: `mcp_servers.trex_browser.url` + `bearer_token_env_var`.
  - Ambos abrieron una página y listaron pestañas.
- **trex:**
  - Claude y Codex usan HTTP cuando el componente anuncia `capabilities.mcpHttp`.
  - WSL, Antigravity y Trex CLI siguen con el adaptador stdio, que también es el respaldo si la sesión HTTP falla.
  - En Claude, un cambio de permisos re-vincula el token sin reiniciar la conversación (salvo con el control de escritorio activo, que sigue siendo stdio). En Codex se mantiene el reinicio seguro.
- **Límite conocido:** sin SSE, el servidor no puede avisar con `tools/list_changed`. Tras ampliar permisos, las herramientas nuevas aparecen cuando el cliente vuelve a pedir la lista. Las llamadas se validan siempre con el modo vigente.
- **Pruebas:** `trex-browser/tests/mcp-http.integration.test.mjs` y `scripts/browser.test.mjs`.
