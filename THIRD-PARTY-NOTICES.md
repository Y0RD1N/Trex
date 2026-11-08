# Avisos de software de terceros

trex se publica bajo la [licencia MIT](LICENSE). Incorpora y redistribuye software
de terceros que conserva **su propia licencia**. Este archivo resume qué se
incluye y bajo qué términos. Ninguna de las dependencias de Rust ni de npm usa
GPL ni AGPL; el único binario externo con licencia dependiente de su compilación
es FFmpeg (ver la tabla).

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
| [Inter](https://rsms.me/inter/) y [JetBrains Mono](https://www.jetbrains.com/lp/mono/) (vía Fontsource) | 5.x | SIL OFL 1.1 | Tipografías | Interfaz de trex y de Trex Browser |
| [`jpeg-decoder`](https://crates.io/crates/jpeg-decoder) 0.3.2, **con un parche local** | 0.3.2 | MIT o Apache-2.0 | Validar capturas JPEG en Trex CLI | [`trex-cli/vendor/jpeg-decoder`](trex-cli/vendor/jpeg-decoder) (licencias y [descripción del parche](trex-cli/vendor/jpeg-decoder/TREX-PATCH.md)) |
| [Node.js](https://nodejs.org) | 24.22.1 | MIT (con licencias de sus propios componentes) | Runtime privado de Trex Browser | Su `LICENSE` completo se copia a `trex-browser-runtime/NODE_LICENSE` |
| [Playwright](https://playwright.dev) | 1.64.1 | Apache-2.0 | Automatización de Trex Browser | `node_modules/playwright*` dentro del runtime, con los avisos de licencia del paquete |
| [Electron](https://www.electronjs.org) | 45.2.1 | MIT; incluye Chromium y otros componentes con sus licencias | Ventana de Trex Browser | `LICENSE` y `LICENSES.chromium.html` de Electron, en la carpeta del shell |
| [FFmpeg](https://ffmpeg.org) (binario que descarga `playwright install ffmpeg`) | el que fija Playwright 1.64.1 | La de la compilación: FFmpeg es LGPL-2.1+ o GPL según sus opciones (`ffmpeg -L` la muestra); ver [su aviso legal](https://ffmpeg.org/legal.html) | Grabación de vídeo | `trex-browser-runtime/ffmpeg` |

Los instaladores de Windows y Fedora incluyen Trex Browser; el de macOS aún no.

## Componentes que **no** se redistribuyen

trex los usa si ya están en tu equipo, pero no vienen en los instaladores y
conservan sus propias condiciones de uso:

- **Claude Code** (Anthropic), **Codex** (OpenAI) y **Antigravity** (Google): los
  instalas y autenticas tú. trex ejecuta sus CLIs y no copia tus credenciales.
- **Google Chrome** (Windows) y **Chromium** (Fedora): Trex Browser maneja el que
  tengas instalado.
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
(Node, Playwright, Electron, FFmpeg) siguen siendo las empaquetadas.
