# Política de seguridad

Gracias por ayudar a que trex sea más seguro. Puedes escribir en **español o en
inglés** / reports are welcome in Spanish or English.

## Cómo informar de una vulnerabilidad

**No abras un issue público** con los detalles de una vulnerabilidad.

1. Ve a la pestaña **Security** del repositorio.
2. Pulsa **Report a vulnerability** (aviso privado de GitHub).
3. Cuéntanos lo que puedas de esta lista:
   - versión de trex, sistema operativo y componente (app, Trex CLI, Trex Browser, instalador);
   - pasos para reproducirlo y qué esperabas que pasara;
   - qué impacto tiene (qué podría hacer alguien que lo aprovechara);
   - si lo sabes, cómo corregirlo.

No incluyas claves API, tokens ni cookies reales: usa valores de prueba.

trex lo mantiene una sola persona. Intentaré confirmar la recepción en pocos días
y te iré contando el avance. Cuando haya una corrección, la publicaré en un
release y, si quieres, te mencionaré en las notas; si prefieres el anonimato, dímelo.

## Versiones con soporte

trex está en fase inicial (`0.x`). Solo se corrige la **última versión publicada**.

## Qué consideramos una vulnerabilidad

Algo en trex que permita, sin que la persona usuaria lo apruebe:

- **Saltarse los permisos de los agentes**: escribir archivos o ejecutar comandos en
  modos de solo lectura (Planificar) o sin la aprobación que pide el modo Preguntar.
- **Filtrar credenciales**: claves API de Trex CLI, tokens de Claude Code, Codex o
  Antigravity, o cookies de Trex Browser, hacia el historial, los registros, los
  argumentos de un proceso, otro agente o la red.
- **Romper el aislamiento de Trex Browser**: acceso entre perfiles o espacios de
  distintos agentes (cookies, almacenamiento, permisos, descargas), o hacerse con el
  control de una ventana que otra persona o agente tiene pausada.
- **Control por accesibilidad fuera de lo permitido**: actuar sobre aplicaciones o
  ventanas que no se han autorizado, o seguir actuando después de detenerlo.
- **Ejecución de código por contenido no confiable**: que el texto de un modelo, una
  página web, un archivo adjunto o un nombre de proyecto acabe ejecutando código o
  escribiendo fuera de su carpeta.
- **Los instaladores**: elevación de privilegios, rutas inseguras o sustitución de
  componentes durante la instalación o la actualización.

## Fuera de alcance

- Fallos de **Claude Code, Codex, Antigravity, Chrome, Chromium, Electron, Playwright,
  Node.js** u otras dependencias en sí. Repórtalos a sus proyectos; si trex los
  empeora o los expone de forma especial, entonces sí cuenta aquí.
- El comportamiento o las respuestas de un modelo de IA, salvo que lleguen a saltarse
  un control de trex (primera lista).
- Ataques que ya requieren ejecutar código como tu usuario en tu equipo o acceso
  físico a él.
- Instaladores sin firma digital: es una limitación conocida, no un fallo (la de
  macOS es ad hoc, sin certificado de Apple).
- Informes de escáneres automáticos sin una explicación de cómo se explota.

## Cómo trata trex los datos sensibles

Esto describe el diseño actual, para que sepas qué esperar y qué reportar si no se cumple:

- **Cuentas de Claude Code y Codex**: se autentican desde sus propios CLIs; trex no
  copia sus credenciales.
- **Claves API de Trex CLI**: se guardan cifradas con DPAPI en Windows y en el almacén
  seguro del sistema en Linux y macOS (Secret Service y Keychain). No se escriben en la
  configuración de trex, en los argumentos del proceso ni en el historial del chat.
- **Traspasos entre agentes**: el contexto que se pasa de un chat a otro se filtra para
  omitir claves, tokens, contraseñas y archivos como `.env` o `credentials.json`.
- **Control por accesibilidad**: es una integración opcional que se activa en
  Ajustes → Integraciones, y se puede detener desde el chat.
- **Trex Browser**: usa perfiles privados por proyecto y mantiene separados los datos
  de cada agente.
- **Red**: trex no tiene servidor propio ni envía telemetría. Las conexiones salen hacia
  los servicios que tú configuras (Anthropic, OpenAI, Google, tu proveedor de API) y hacia
  el registro de npm, para saber si hay una versión nueva de Claude Code o Codex.

Los agentes que ejecutas con trex trabajan con **tus permisos** sobre tus archivos y
tu shell. Revisa lo que aprueban, sobre todo en el modo «Permitir todo».
