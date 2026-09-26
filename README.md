# trex

Terminal de escritorio para **Windows y Linux** pensada para trabajar con
**Claude Code**: guardas tus proyectos y cada terminal se abre ya dentro de la
carpeta del proyecto y con Claude ejecutándose.

## ✨ Qué hace

- **Proyectos**: añades carpetas una sola vez y quedan en la barra lateral.
- **Terminal con Claude dentro**: el botón `+` de un proyecto abre una pestaña
  con `cwd` = esa carpeta y `claude` ya arrancado. Nada de `cd` ni de teclear
  el comando cada vez.
- **Pestañas**: varias terminales por proyecto, todas vivas a la vez.
  `Ctrl+T` (Claude) y `Ctrl+Shift+T` (shell limpio).
- **Al salir de Claude** vuelves al prompt del shell en la misma pestaña.
- **Detección de Claude Code**: busca el binario en el `PATH` y en las rutas
  típicas del instalador nativo (Windows: `%USERPROFILE%\.local\bin`), y avisa
  con instrucciones si no lo encuentra.
- **Ajustes persistentes**: shell (PowerShell, cmd, Git Bash, WSL, bash, zsh…),
  comando y argumentos de Claude (`--continue`, `--resume`…), tipografía,
  scrollback y color de acento.
- **Modo claro y oscuro**: tema claro, oscuro o el del sistema, con color de acento configurable (y el terminal a juego).
- **Restauración de sesión**: al reabrir, recupera tus pestañas.

## 🧱 Tecnología

| Capa | Tecnología |
|---|---|
| Shell de escritorio | Tauri v2 (Rust) |
| Terminal | xterm.js + addons (fit, web-links, search) |
| PTY real | `portable-pty` (ConPTY en Windows, openpty en Unix) |
| Interfaz | React 19 + TypeScript + Vite |
| Transporte de datos | eventos Tauri (`pty-data-<id>` en base64 para no romper UTF-8) |

## 📁 Estructura

```
src/                     interfaz React (sidebar, pestañas, terminal, ajustes)
src-tauri/src/pty.rs     motor de PTY, resolución de shells y detección de Claude
src-tauri/src/config.rs  configuración persistente (config.json)
src-tauri/src/lib.rs     comandos Tauri y arranque
scripts/make_icon.py     genera el icono de la app
```

## 🚀 Desarrollo

Requisitos: Node 18+, Rust estable y, en Windows, WebView2 + Visual Studio
Build Tools (C++).

```bash
npm install
npm run tauri dev
```

La configuración del usuario vive en el directorio de configuración de la app
(`%APPDATA%\com.trex.app\config.json` en Windows).

## 📦 Compilar

```bash
npm run tauri build
```

- **Windows**: genera instalador `.msi` y `.exe` (NSIS) en
  `src-tauri/target/release/bundle/`.
- **Linux**: genera `.deb` y `.AppImage`, pero hay que compilar **en Linux**
  (nativo, contenedor o CI con GitHub Actions).

## ⌨️ Atajos

| Atajo | Acción |
|---|---|
| `Ctrl+T` | Nueva terminal con Claude en el proyecto activo |
| `Ctrl+Shift+T` | Nueva terminal (shell limpio) |
| `Ctrl+W` | Cerrar pestaña |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | Cambiar de pestaña |
| `Ctrl+1..9` | Ir a la pestaña N |
| `Ctrl+F` | Buscar en la terminal |
| `Ctrl+Shift+C` / `Ctrl+Shift+V` | Copiar / pegar |
| `Ctrl+=` / `Ctrl+-` / `Ctrl+0` | Tamaño de fuente |
| `Ctrl+,` | Ajustes |
| `Ctrl+Shift+L` | Alternar entre modo claro y oscuro |
| `Ctrl+Shift+E` | Abrir el proyecto en el explorador |

## 📝 Notas

- Si Claude Code no aparece, instálalo con el instalador nativo:
  - Windows (PowerShell): `irm https://claude.ai/install.ps1 | iex`
  - Linux/macOS: `curl -fsSL https://claude.ai/install.sh | bash`
  - Alternativa: `npm install -g @anthropic-ai/claude-code`
