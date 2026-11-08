# Desarrollo y compilación

Cómo compilar trex desde el código, probarlo y generar los instaladores. Sirve
para compilarlo en tu equipo o para trabajar en tu propio fork (la
[licencia MIT](../LICENSE) lo permite). Para las contribuciones al repositorio
principal, mira [CONTRIBUTING.md](../CONTRIBUTING.md).

## Preparar el entorno

Necesitas Node 22.12+ (o 24+) y Rust estable.

- **Windows**: WebView2 y Visual Studio Build Tools con el componente de C++.
- **Linux**: las bibliotecas de Tauri. En Ubuntu 24.04:
  `sudo apt-get install libwebkit2gtk-4.1-dev build-essential libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev`.
  Para Fedora, mira [fedora.md](fedora.md).

```bash
git clone https://github.com/Y0RD1N/trex.git
cd trex
npm install
npm run tauri dev
```

La configuración de la app se guarda en el directorio de configuración del usuario
(`%APPDATA%\com.trex.app\config.json` en Windows).

## Cómo está organizado

| Carpeta | Qué contiene |
|---|---|
| `src/` | Interfaz en React + TypeScript: barra lateral, pestañas, terminal (xterm.js), chats, equipos y ajustes |
| `src-tauri/` | App de escritorio en Rust (Tauri v2): PTY (`pty.rs`), configuración (`config.rs`), integración con Claude Code, Codex y Antigravity, panel de Git, cola de mensajes e instaladores (`installer/`) |
| `trex-cli/` | Trex CLI (`trex-agent`): agente nativo con claves API y servidor JSON-RPC ([protocolo](../trex-cli/PROTOCOL.md)), más el motor de control por accesibilidad |
| `trex-browser/` | Trex Browser: lanzador en Rust (`src/`), worker de Node con Playwright (`worker/`) y ventana de Electron (`shell/`) |
| `scripts/` | Tests de la interfaz (`*.test.mjs`), scripts de compilación de los componentes y de los instaladores |
| `docs/` | Guía de uso, documentación de componentes, notas de versión y material de diseño |
| `.github/workflows/` | CI: comprobaciones en Windows, Ubuntu y Fedora, e instaladores |

## Comprobar los cambios

GitHub Actions ejecuta esto en cada push a `main` y en cada pull request:

```bash
npm test
npm run build
npm run cli:build -- --debug
cargo test --locked --manifest-path src-tauri/Cargo.toml --lib
cargo test --locked --manifest-path trex-cli/Cargo.toml
cargo test --locked --manifest-path trex-browser/Cargo.toml
```

`npm run cli:build -- --debug` prepara el recurso de Trex CLI que necesitan los tests de
`src-tauri`. Los tests de política del navegador:

```bash
npm ci --prefix trex-browser --ignore-scripts
node --test trex-browser/tests/security.test.mjs trex-browser/tests/availability.test.mjs trex-browser/tests/mcp-compatibility.test.mjs
```

## Compilar instaladores

```bash
npm run tauri build
```

El resultado queda en `src-tauri/target/release/bundle/`:

- **Windows**: instalador `.exe` (NSIS), con Trex CLI y Trex Browser como componentes
  opcionales. Detalles y pruebas en [`src-tauri/installer/README.md`](../src-tauri/installer/README.md).
- **Fedora**: un RPM con la app, Trex CLI y Trex Browser; hay que compilar en Linux
  ([guía](fedora.md)).
- **macOS**: `.dmg` para Apple Silicon, con firma ad hoc.

También puedes generarlos en GitHub Actions: pestaña **Actions → Installers → Run
workflow**. Al subir una etiqueta (`git tag v0.2.0 && git push origin v0.2.0`), los
instalables se adjuntan a un borrador de release.

El icono parte de `public/trex.svg`; ejecuta `python scripts/make_icon.py` tras
modificarlo para regenerar los PNG, ICO e ICNS.

## Convenciones

- Los commits se escriben en inglés con el formato
  [Conventional Commits](https://www.conventionalcommits.org/): `feat(browser): …`,
  `fix(a11y): …`, `docs: …`.
- Si añades una dependencia, comprueba que su licencia es permisiva (MIT, Apache-2.0,
  BSD…) y regenera el inventario con `node scripts/third-party-licenses.mjs`.
