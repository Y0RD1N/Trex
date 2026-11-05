/**
 * Vista previa, dentro de la app, de los archivos que comparte el asistente.
 *
 * Qué se puede ver y cómo (Markdown leído, código con colores, tablas CSV,
 * HTML y SVG aislados, PDF con el visor del navegador), sin interfaz para
 * poder probarlo. El resto (Word, Excel, comprimidos…) se abre con la
 * aplicación del sistema, y las imágenes van al visor de imágenes.
 */
import { invoke } from "@tauri-apps/api/core";

export type PreviewKind = "markdown" | "code" | "text" | "table" | "html" | "svg" | "pdf";

/** Texto que se lee para la vista previa: lo que pasa de aquí se avisa como recortado. */
export const TEXT_PREVIEW_BYTES = 2 * 1024 * 1024;
/** Un PDF se pasa entero al visor; más grande, se abre fuera. */
export const PDF_PREVIEW_BYTES = 64 * 1024 * 1024;
/** Por encima, el código se muestra sin colores (colorear cuesta y bloquea la ventana). */
export const HIGHLIGHT_CHARS = 300_000;
/** Por encima, un Markdown empieza en su texto: interpretarlo entero tarda. */
export const MARKDOWN_RENDER_CHARS = 1_000_000;
/** Filas de una tabla CSV que se pintan. */
export const TABLE_ROWS = 2000;

const extensionOf = (path: string): string => {
  const name = path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
  return /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? (/^(dockerfile|makefile)$/i.test(name) ? name.toLowerCase() : "");
};

/** Lenguaje del resaltador (ver `chatHighlight`) según la extensión. */
const LANGUAGES: Record<string, string> = {
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript", js: "javascript", jsx: "javascript", mjs: "javascript",
  cjs: "javascript", json: "json", jsonc: "json", py: "python", rs: "rust", go: "go", java: "java", kt: "kotlin", rb: "ruby",
  php: "php", c: "c", h: "c", cpp: "cpp", hpp: "cpp", cc: "cpp", cs: "csharp", css: "css", scss: "scss", html: "xml", htm: "xml",
  xml: "xml", svg: "xml", yaml: "yaml", yml: "yaml", toml: "ini", ini: "ini", sh: "bash", bash: "bash", zsh: "bash", ps1: "powershell",
  sql: "sql", lua: "lua", md: "markdown", markdown: "markdown", diff: "diff", patch: "diff", graphql: "graphql", gql: "graphql",
  dockerfile: "dockerfile", makefile: "makefile",
};

export const previewLanguage = (path: string): string | null => LANGUAGES[extensionOf(path)] ?? null;

/**
 * El visor de PDF del navegador: WebView2 (Windows) y WKWebView (macOS) lo
 * tienen; WebKitGTK (Linux) no, y ahí el PDF se abre con el sistema.
 */
export const canPreviewPdf = (userAgent = typeof navigator === "undefined" ? "" : navigator.userAgent): boolean =>
  !/Linux/i.test(userAgent) || /Chrome|Edg\//.test(userAgent);

/** Cómo se ve un archivo dentro de la app, o null si se abre con el sistema. */
export function previewKind(path: string, pdf = canPreviewPdf()): PreviewKind | null {
  const extension = extensionOf(path);
  if (extension === "md" || extension === "markdown") return "markdown";
  if (extension === "csv" || extension === "tsv") return "table";
  if (extension === "html" || extension === "htm") return "html";
  if (extension === "svg") return "svg";
  if (extension === "pdf") return pdf ? "pdf" : null;
  if (["txt", "log", "rst", "text", "env", "gitignore", "conf", "cfg", "properties"].includes(extension)) return "text";
  if (LANGUAGES[extension]) return "code";
  return null;
}

/** Si el tipo tiene dos vistas: la interpretada y el texto. */
export const hasSourceView = (kind: PreviewKind): boolean => kind === "markdown" || kind === "table" || kind === "html" || kind === "svg";

/**
 * Texto de los bytes leídos. Es binario si hay un NUL al principio (salvo UTF-16
 * con BOM). Un carácter cortado al final por el límite se descarta.
 */
export function decodePreview(bytes: Uint8Array): { text: string; binary: boolean } {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return { text: new TextDecoder("utf-16le").decode(bytes.subarray(2)), binary: false };
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return { text: new TextDecoder("utf-16be").decode(bytes.subarray(2)), binary: false };
  const head = bytes.subarray(0, 8000);
  if (head.includes(0)) return { text: "", binary: true };
  const text = new TextDecoder("utf-8").decode(bytes).replace(/^﻿/, "").replace(/�$/, "");
  return { text, binary: false };
}

/**
 * Filas de un CSV o TSV (comillas dobles, `""` dentro de un campo, saltos de
 * línea entre comillas). Solo se guardan `limit` filas; `total` las cuenta todas.
 */
export function parseDelimited(text: string, delimiter: "," | "\t" | ";" = ",", limit = TABLE_ROWS): { rows: string[][]; total: number } {
  const rows: string[][] = [];
  let row: string[] = [], field = "", quoted = false, total = 0;
  const endRow = (): void => {
    row.push(field); field = "";
    if (row.length > 1 || row[0] !== "") { total++; if (rows.length < limit) rows.push(row); }
    row = [];
  };
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (char === "\"") {
        if (text[index + 1] === "\"") { field += "\""; index++; } else quoted = false;
      } else field += char;
    } else if (char === "\"" && field === "") quoted = true;
    else if (char === delimiter) { row.push(field); field = ""; }
    else if (char === "\n" || char === "\r") { if (char === "\r" && text[index + 1] === "\n") index++; endRow(); }
    else field += char;
  }
  if (field !== "" || row.length) endRow();
  return { rows, total };
}

/** Columnas con cifras (importes, porcentajes, cantidades) en todas sus celdas con valor. */
export function numericColumns(rows: string[][], columns: number): boolean[] {
  const number = /^[-+]?(?:[\d\s.,]*\d)(?:\s?[%€$£])?$|^[€$£]\s?[-+]?[\d\s.,]*\d$/;
  return Array.from({ length: columns }, (_, column) => {
    let values = 0;
    for (const row of rows) {
      const value = (row[column] ?? "").trim();
      if (!value) continue;
      if (!number.test(value)) return false;
      values++;
    }
    return values > 0;
  });
}

/** Separador de una tabla: tabulador en `.tsv`; en `.csv`, coma o punto y coma (Excel en español) según la cabecera. */
export function tableDelimiter(path: string, text: string): "," | "\t" | ";" {
  if (extensionOf(path) === "tsv") return "\t";
  const header = text.slice(0, text.search(/\r?\n|$/));
  return (header.match(/;/g)?.length ?? 0) > (header.match(/,/g)?.length ?? 0) ? ";" : ",";
}

/**
 * Documento HTML aislado: sin scripts (el iframe va con `sandbox`) y sin pedir
 * nada a internet. Solo carga imágenes y fuentes incrustadas.
 */
export function isolatedHtml(html: string): string {
  const policy = "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data:\">";
  return /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, match => `${match}${policy}`) : `${policy}${html}`;
}

/** Los primeros bytes de un archivo (todos si es más pequeño). */
export async function readPreview(path: string, limit: number): Promise<Uint8Array> {
  const data = await invoke<ArrayBuffer | number[]>("read_file_preview", { path, limit });
  return data instanceof ArrayBuffer ? new Uint8Array(data) : Uint8Array.from(data);
}
