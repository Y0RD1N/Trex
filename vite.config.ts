import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
// @ts-expect-error type error without @types/node package
import process from "node:process";
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(() => ({
  plugins: [react()],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1430,
    strictPort: true,
    host: host || "127.0.0.1",
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1431,
        }
      : undefined,
    watch: {
      // 3. Native Rust sources and build artifacts are outside frontend HMR, and so
      //    are local QA fixtures: rebuilding them must not reload the running app.
      ignored: ["**/src-tauri/**", "**/trex-cli/**", "**/trex-browser/**", "**/.clipboard-qa.local/**"],
    },
  },

  build: {
    // The bundle is served from disk by Tauri, not downloaded: the warning about
    // 500 kB chunks is about network transfers. Startup cost is kept down by
    // loading rare UI (settings, dialogs, highlight.js, xterm addons) on demand.
    chunkSizeWarningLimit: 1200,
    rolldownOptions: {
      // La app móvil del control remoto es una segunda página: no carga nada del escritorio.
      input: { main: "index.html", remote: "remote.html" },
      output: {
        // Stable vendor chunks: they keep their hash (and WebView code cache) across
        // app updates and are compiled in parallel with the app code. Only modules
        // of the initial graph (`$initial`): lazy chunks such as highlight.js or the
        // xterm WebGL/search addons must not be pulled back into startup.
        codeSplitting: {
          groups: [
            { name: "react", test: /node_modules[\\/](?:react|react-dom|scheduler)[\\/]/, tags: ["$initial"], priority: 3 },
            { name: "xterm", test: /node_modules[\\/]@xterm[\\/]/, tags: ["$initial"], priority: 2 },
            { name: "markdown", test: /node_modules[\\/](?:react-markdown|remark-[^\\/]+|micromark[^\\/]*|mdast-[^\\/]+|hast-[^\\/]+|unist-[^\\/]+|unified|vfile[^\\/]*|property-information|space-separated-tokens|comma-separated-tokens|decode-named-character-reference|character-entities[^\\/]*|html-url-attributes|style-to-js|style-to-object|inline-style-parser|estree-util-[^\\/]+|devlop|bail|trough|is-plain-obj|zwitch|longest-streak|markdown-table|ccount|escape-string-regexp|trim-lines|html-void-elements|web-namespaces)[\\/]/, tags: ["$initial"], priority: 2 },
          ],
        },
      },
    },
  },
}));
