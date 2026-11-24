# Avisos de software de terceros

trex se publica bajo la [licencia MIT](LICENSE). Incorpora y redistribuye software
de terceros que conserva **su propia licencia**. Este archivo resume qué se
incluye y bajo qué términos. Ninguna de las dependencias de Rust ni de npm usa
GPL ni AGPL.

- **Inventario completo** de crates de Rust y paquetes de npm, con su licencia:
  [docs/third-party-licenses.md](docs/third-party-licenses.md) (generado).
- Cada instalador conserva los avisos de licencia que traen los componentes
  empaquetados (ver la columna «Dónde» más abajo).

## Componentes que se redistribuyen en los instaladores

| Componente | Versión | Licencia | Para qué | Dónde |
|---|---|---|---|---|
| [Tauri](https://tauri.app) y sus plugins | 2.x | MIT o Apache-2.0 | Shell de escritorio | Compilado en `trex` |
| Plantilla NSIS de Tauri CLI | 2.12.0 | MIT | Instalador de Windows | [`src-tauri/installer/LICENSE_TAURI_MIT`](src-tauri/installer/LICENSE_TAURI_MIT) |
| [xterm.js](https://xtermjs.org) y addons | 6.x | MIT | Terminal | Compilado en la interfaz |
| [React](https://react.dev) | 19.x | MIT | Interfaz | Compilado en la interfaz |
| [highlight.js](https://highlightjs.org) | 11.x | BSD-3-Clause | Resaltado de código | Compilado en la interfaz |
| [IBM Plex Sans y IBM Plex Mono](https://www.ibm.com/plex/) y [JetBrains Mono](https://www.jetbrains.com/lp/mono/) (vía Fontsource) | 5.x | SIL OFL 1.1 | Tipografías | Interfaz de trex (Plex) y su terminal (JetBrains Mono) |
| [`jpeg-decoder`](https://crates.io/crates/jpeg-decoder) 0.3.2, **con un parche local** | 0.3.2 | MIT o Apache-2.0 | Validar capturas JPEG en Trex CLI | [`trex-cli/vendor/jpeg-decoder`](trex-cli/vendor/jpeg-decoder) (licencias y [descripción del parche](trex-cli/vendor/jpeg-decoder/TREX-PATCH.md)) |

## Componentes que **no** se redistribuyen

trex los usa si ya están en tu equipo, pero no vienen en los instaladores y
conservan sus propias condiciones de uso:

- **Claude Code** (Anthropic), **Codex** (OpenAI) y **Antigravity** (Google): los
  instalas y autenticas tú. trex ejecuta sus CLIs y no copia tus credenciales.
- **Google Chrome, Brave, Microsoft Edge o Chromium**: «Tu navegador» usa el que
  tengas instalado, mediante la extensión de trex.
- **WebView2** (Windows) y **WebKitGTK** (Linux): componentes del sistema que usa Tauri.

## Copyleft débil: MPL-2.0

Cinco crates de Rust se publican bajo MPL-2.0: `cssparser`, `cssparser-macros`,
`dtoa-short`, `option-ext` y `selectors`. trex los usa **sin modificarlos**, tal
como se publican en crates.io; su código fuente está disponible allí. La MPL-2.0
solo afecta a sus propios archivos y no cambia la licencia del resto de trex.

## Marcas

«Claude» y «Claude Code» son marcas de Anthropic; «Codex» y «ChatGPT», de OpenAI;
«Antigravity» y «Gemini», de Google. trex es un proyecto independiente, **sin
relación ni respaldo** de esas empresas, y las nombra solo para indicar con qué
herramientas funciona.

## Mantenimiento

Antes de cada release: `node scripts/third-party-licenses.mjs`, revisar la sección
«Requieren atención» del inventario y comprobar que las versiones de esta tabla
siguen siendo las empaquetadas.
