# Tareas en cualquier chat

Las tareas no requieren crear un equipo ni cambiar a Planificar. Para un trabajo
con varios pasos, el agente publica una lista y actualiza su progreso en el panel
**Tareas** del chat. La lista se recupera desde los resultados de herramientas
guardados en el historial, sin marcar pasos completados por el simple hecho de
terminar una respuesta.

Claude y Codex reciben `trex_update_tasks` mediante el servidor de la aplicación
`trex_inbox`, incluso cuando sus herramientas nativas de planificación no están
disponibles. El argumento es `plan: [{step, status}]`; los estados son `pending`,
`in_progress` y `completed`. Se admiten hasta 64 pasos, uno en curso y 32 KiB de
argumentos JSON. `plan: []` vacía la lista. Una entrada inválida o fallida conserva
la lista anterior. Esta herramienta no ejecuta tareas, no edita el proyecto, no
lee mensajes de la cola ni concede permisos adicionales.

Trex CLI ofrece su herramienta nativa `update_plan` en todos los modos. Los
eventos nativos de tareas de Claude y Codex siguen siendo compatibles. En los
equipos, el principal usa `trex_team_plan` para la lista de delegaciones; cada
colaborador puede mantener además su propia lista de pasos.

Una sesión que ya estaba en marcha al actualizar la aplicación debe reconectarse
para recibir el catálogo nuevo. Conserva su conversación y su historial; no hace
falta borrar el chat.
