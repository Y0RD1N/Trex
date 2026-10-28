# Espacios del navegador por agente

Al iniciar un equipo con Trex Browser habilitado, el principal y cada
colaborador reciben un perfil persistente propio. La asignación se conserva al
reanudar el equipo, y no usa los perfiles que ya hayas creado manualmente.
Crear estos espacios no abre ventanas: cada navegador aparece cuando su agente
navega por primera vez.

En el botón **Espacios**, junto al campo de mensaje, puedes elegir un integrante,
ver sus pestañas, traer una al frente, abrir otra, tomar capturas y grabar vídeo.
**Pausar para revisar** detiene las entradas de ese espacio y mantiene disponibles
las capturas. **Cerrar este espacio** pausa primero sus entradas y cierra solo
su perfil. El agente puede volver a abrirlo si aún tiene una tarea activa.
**Detener agente y revisar** interrumpe la delegación y pausa el equipo para
revisar el resultado; una tarea incierta no se repite al reanudar.

## Trabajo simultáneo y dependencias

El principal publica el plan antes de delegar. Las tareas independientes de
lectura pueden ejecutarse a la vez, hasta cuatro y una por integrante. Las
tareas que pueden editar el proyecto tienen ejecución exclusiva: esto evita que
una revisión coincida con archivos a medio escribir.

```json
{
  "steps": [
    {"taskKey":"docs","memberId":"research","task":"Consultar documentación oficial","dependsOn":[]},
    {"taskKey":"inspect","memberId":"review","task":"Inspeccionar la implementación actual","dependsOn":[]},
    {"taskKey":"implement","memberId":"developer","task":"Implementar según los hallazgos","dependsOn":["docs","inspect"]},
    {"taskKey":"verify","memberId":"review","task":"Revisar la implementación y sus pruebas","dependsOn":["implement"]}
  ]
}
```

`dependsOn: []` declara independencia. Las dependencias deben aparecer antes en
el plan; no se admiten ciclos ni cambios de dependencias después de enviar una
tarea. Omitir el campo mantiene el comportamiento secuencial de planes anteriores.
El plan no ejecuta nada por sí solo.

El principal encola cada tarea mediante `trex_delegate_task` con `wait:false` y
consulta sus informes usando `trex_task_status` con `taskId` y `waitMs:30000`.
Este tiempo de espera evita consultar continuamente mientras trabaja un
colaborador. Si el principal termina su turno antes que los colaboradores,
Trex le avisa una sola vez cuando los informes estén listos para revisión.
Una dependencia fallida cancela los pasos que dependían de ella; la corrección
requiere una tarea nueva, no repetir una ejecución incierta.

## Pestañas y acciones por lotes

Las capturas DOM devuelven `tabId` y `revision`. Guarda ambos con las referencias
a elementos: consultar otra pestaña ya no los invalida. Una navegación o acción
en la misma página puede invalidarlos y exige una captura nueva.

`browser_batch` agrupa entre 1 y 16 pasos ordenados:

```json
{
  "steps": [
    {"tool":"browser_navigate","arguments":{"url":"http://localhost:5173"}},
    {"tool":"browser_click","arguments":{"selector":"button[data-action=preview]"}},
    {"tool":"browser_snapshot","arguments":{}},
    {"tool":"browser_take_screenshot","arguments":{}}
  ]
}
```

Todos los pasos conservan los mismos permisos. Observe no puede introducir un
clic, JavaScript o una pestaña nueva dentro de un lote. Las entradas se validan
antes de empezar, y cada paso ejecutado conserva su recibo. Si hay un error o
cancelación, los pasos posteriores no se envían; los anteriores no se deshacen
ni se vuelven a ejecutar automáticamente. Los lotes no admiten otros lotes,
cambios de propietario, administración de capturas ni subidas de archivos.

Los perfiles de distintos integrantes tienen almacenamiento separado. Cada
perfil sigue teniendo un propietario y una cola de entradas; varias pestañas
de un mismo perfil no equivalen a varios agentes independientes.
