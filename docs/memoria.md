# Memoria de Trex

Una sola memoria para todos los agentes y proveedores: lo que aprende una sesión de Claude Code
lo saben después Codex, Antigravity y Trex CLI, y al revés.

## Dónde se guarda

En la carpeta de datos de la app, nunca dentro de un repositorio:

- Linux: `~/.local/share/com.trex.app/memory/`
- Windows: `%APPDATA%\com.trex.app\memory\`
- macOS: `~/Library/Application Support/com.trex.app/memory/`

```
memory/
├── global/                     lo de la persona: vale en todos los proyectos
├── projects/<carpeta>-<hash>/  lo de un proyecto (y la memoria automática de Claude Code)
├── .trash/                     lo olvidado o sustituido, recuperable
├── .review/                    lo que parece dar órdenes, apartado hasta que lo apruebes
├── .imports/                   qué memoria de Claude Code ya se importó
├── .git/                       historial de cada cambio (si Git está instalado)
├── .disabled                   existe solo si la memoria está apagada
└── .lock                       cerrojo entre la ventana y los agentes
```

Cada recuerdo es un archivo Markdown con cabecera, el mismo formato que la memoria automática de
Claude Code, y `MEMORY.md` es su índice (una línea por recuerdo). Se pueden leer y editar a mano.

```markdown
---
name: usa-pnpm
description: El repo usa pnpm, no npm
metadata:
  type: project
  created: 2026-11-11T22:10:00.000Z
  modified: 2026-11-11T22:10:00.000Z
  source: codex-mcp-client · sesión tab-3
---

Usa pnpm en este repo.
**Why:** el lockfile es pnpm-lock.yaml.
```

Tipos: `user` (la persona), `feedback` (correcciones y preferencias de trabajo), `project`
(decisiones del proyecto y su porqué) y `reference` (dónde está algo fuera del proyecto).

## Cómo la usa cada proveedor

| Proveedor | Lee | Escribe |
|---|---|---|
| Claude Code | Su memoria automática nativa, apuntada a la carpeta del proyecto con `--settings {"autoMemoryDirectory": …}`; lo global llega en `--append-system-prompt` | Con sus herramientas de archivos, como siempre; lo global con `trex_memory_save` |
| Codex | Resumen (índice global y del proyecto) en las instrucciones de cada hilo | `trex_memory_*` del servidor MCP `trex_inbox` |
| Antigravity | Resumen en el bloque `<trex_context>` | `trex_memory_*` |
| Trex CLI | Resumen en las instrucciones de la sesión | `trex_memory_*` |

Herramientas: `trex_memory_search`, `trex_memory_read`, `trex_memory_save` y `trex_memory_forget`.
El resumen se toma al arrancar la sesión y no cambia durante ella (así entra en la caché del prompt);
tiene un tope de ~2.500 tokens. Si un perfil de Claude trae su propio `--settings` o su propio prompt
de sistema, se respetan.

La primera vez que se usa un proyecto, Trex copia la memoria automática que Claude Code tuviera en
`~/.claude/projects/<carpeta>/memory` (sin tocar los originales). Lo que se olvide después no vuelve.

## Para que no se rompa

| Riesgo | Protección |
|---|---|
| Corte o cuelgue a mitad de escribir | Escritura atómica: temporal, volcado a disco y sustitución |
| Dos agentes guardando a la vez | Un archivo por recuerdo y cerrojo de carpeta |
| Editar sobre una copia vieja | Hay que pasar la versión leída: si cambió, se rechaza y no se pisa |
| Un archivo dañado o editado mal | Se informa y se deja estar; el resto sigue funcionando |
| Índice desincronizado | `MEMORY.md` se rehace siempre desde los archivos (tras cada cambio y cada turno) |
| Borrar o sustituir por error | Papelera e historial con Git: todo se recupera |
| Crecer hasta cortarse en silencio | Topes de Claude Code (índice ≤ 150 líneas / 20 KB, ≤ 200 recuerdos por carpeta, ≤ 8 KB por recuerdo) |
| Credenciales | Se rechazan al guardar (claves privadas, tokens de GitHub, Anthropic, OpenAI, AWS, Slack, Google, JWT…) |
| Memoria envenenada (texto que da órdenes) | Sale de la carpeta de los agentes a `.review/` (también si Claude lo escribe directamente): nadie lo recibe ni lo encuentra hasta que lo apruebes; procedencia en cada recuerdo |
| Recuerdos viejos | Fecha en cada uno, «sustituye a» en lugar de duplicar y la regla «el código manda» |

Si la memoria falla, las sesiones arrancan igual, sin ella. Sin Git, todo funciona menos el historial.

## Panel «Memoria»

En las pestañas laterales del chat, junto a Tareas y Git:

- **Por revisar**: lo apartado por parecer una orden. Aprobar lo devuelve a los agentes; editar lo deja
  revisado; olvidar lo manda a la papelera.
- **Este proyecto** y **Global**: abrir un recuerdo muestra su contenido, quién lo guardó y cuándo, y
  permite editarlo, llevarlo a global (o solo a este proyecto) y olvidarlo.
- **Nuevo recuerdo** (+): tus propias notas, en el proyecto o globales (quedan revisadas).
- **Papelera**: recuperar lo olvidado o sustituido, sin pisar un recuerdo activo con el mismo nombre.
- **Activada / Desactivada**: apagarla hace que las sesiones nuevas no reciban ni guarden recuerdos
  (las abiertas, al reiniciarse) y que las herramientas no se ofrezcan; los recuerdos se conservan.
- Se pone al día solo cuando un agente guarda algo durante su turno, y **Abrir carpeta** lleva a los archivos.

## Código

- `src-tauri/src/memory.rs`: almacén, formato, herramientas y comandos (`memory_session`, `memory_sync`,
  `memory_list`, `memory_tools`, `memory_call` y los del panel: `memory_overview`, `memory_read`,
  `memory_write`, `memory_forget`, `memory_approve`, `memory_move`, `memory_restore`, `memory_set_enabled`).
- `src-tauri/src/queue_mcp.rs`: herramientas en el servidor MCP de Codex, Antigravity y Trex CLI.
- `src-tauri/src/coordination.rs`: herramientas en el puente MCP de Claude (servido por la ventana).
- `src/memory.ts`: lo que recibe cada sesión al arrancar, la sincronización tras cada turno y la API del panel.
- `src/components/chat/MemoryPanel.tsx`: el panel.
- Pruebas: `cargo test --lib memory::` y `node --test scripts/memory.test.mjs`.

## Pendiente

- Interruptor por chat (usar / alimentar la memoria en una conversación concreta).
- Consolidación en segundo plano opcional (fusionar duplicados, retirar lo obsoleto).
- Probar conversaciones reales con Codex, Antigravity y Trex CLI (hoy cubiertas con el servidor MCP real en tests).
