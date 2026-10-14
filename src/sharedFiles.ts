/**
 * Archivos que el asistente comparte en el chat.
 *
 * El asistente adjunta un archivo con un enlace Markdown a su ruta local en una
 * línea propia (se lo piden `FILE_SHARING_INSTRUCTIONS`); el chat lo pinta como
 * una tarjeta para verlo, abrirlo o guardarlo. Aquí están las reglas: qué
 * enlace es un archivo local, qué tipo de archivo es y cómo se describe.
 */
import { invoke } from "@tauri-apps/api/core";
import { nodeText, type HastNode } from "./chatMarkdown";

/**
 * Lo que se añade a las instrucciones del asistente para que sepa adjuntar
 * archivos. Una sola línea y sin comillas dobles: viaja como argumento del CLI.
 */
export const FILE_SHARING_INSTRUCTIONS = [
  "You are running inside trex, a desktop chat app that renders your replies as Markdown.",
  "When the user asks you for a file, or when you create a file they will want to look at (a PDF, an image, a document, an export, a generated asset), attach it:",
  "put a Markdown link to its absolute local path on a line of its own, for example [CV.pdf](/home/user/cv/CV.pdf);",
  "wrap paths that contain spaces in angle brackets, like [Report.pdf](</home/user/My Files/Report.pdf>).",
  "trex shows each attached file as a card the user can preview, open or save, and shows images inline; several attachments can go on consecutive lines.",
  "Only attach files that are useful to the user, and keep referring to code locations as you normally do.",
].join(" ");

export type FileInfo = { path: string; name: string; exists: boolean; isDir: boolean; size: number };
export type FileKind = "image" | "pdf" | "document" | "sheet" | "slides" | "code" | "archive" | "audio" | "video" | "text" | "other";

const KINDS: [FileKind, RegExp][] = [
  ["image", /\.(png|jpe?g|gif|webp)$/i],
  ["pdf", /\.pdf$/i],
  ["document", /\.(docx?|odt|rtf|pages)$/i],
  ["sheet", /\.(xlsx?|ods|csv|tsv|numbers)$/i],
  ["slides", /\.(pptx?|odp|key)$/i],
  ["archive", /\.(zip|tar|gz|tgz|bz2|xz|7z|rar)$/i],
  ["audio", /\.(mp3|wav|ogg|flac|m4a|aac|opus)$/i],
  ["video", /\.(mp4|mkv|webm|mov|avi)$/i],
  ["text", /\.(txt|md|markdown|log|rst)$/i],
  ["code", /\.(tsx?|jsx?|mjs|cjs|json|py|rs|go|java|kt|swift|rb|php|c|h|cpp|hpp|cs|css|scss|html?|xml|svg|ya?ml|toml|ini|sh|bash|zsh|ps1|sql|lua)$/i],
];

/** Tipo de archivo según la extensión (para el icono y la vista previa). */
export function fileKind(name: string): FileKind {
  return KINDS.find(([, pattern]) => pattern.test(name))?.[0] ?? "other";
}

export const KIND_LABELS: Record<FileKind, string> = {
  image: "Imagen", pdf: "PDF", document: "Documento", sheet: "Hoja de cálculo", slides: "Presentación", code: "Código",
  archive: "Archivo comprimido", audio: "Audio", video: "Vídeo", text: "Texto", other: "Archivo",
};

/** Tamaño legible: «830 B», «12 KB», «3,4 MB». */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024, unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value < 10 ? value.toFixed(1).replace(".", ",").replace(",0", "") : Math.round(value)} ${units[unit]}`;
}

const isWindowsPath = (value: string): boolean => /^[a-z]:[\\/]/i.test(value);

/**
 * Ruta local a la que apunta un enlace, o null si es una web, un ancla u otra
 * cosa. Admite `file://`, rutas absolutas, `~/` y rutas relativas al proyecto;
 * quita las referencias a líneas (`:12`, `:12:3`, `#L12`).
 */
export function localFilePath(href: string | undefined | null, cwd: string): string | null {
  if (!href) return null;
  let value = href.trim();
  if (!value || value.startsWith("#")) return null;
  if (/^file:/i.test(value)) {
    value = value.replace(/^file:(\/\/[^/]*)?/i, "");
    if (/^\/[a-z]:[\\/]/i.test(value)) value = value.slice(1);
  } else if (/^[a-z][a-z0-9+.-]*:/i.test(value) && !isWindowsPath(value)) {
    return null;
  }
  try { value = decodeURIComponent(value); } catch { /* se usa tal cual */ }
  value = value.replace(/#L\d+(-L?\d+)?$/i, "").replace(/(\.[a-z0-9]+):\d+(:\d+)?$/i, "$1");
  if (!value) return null;
  if (value.startsWith("/") || value.startsWith("~/") || isWindowsPath(value)) return value;
  if (!cwd) return null;
  const separator = cwd.includes("\\") && !cwd.includes("/") ? "\\" : "/";
  const parts = [...cwd.replace(/[\\/]+$/, "").split(/[\\/]/), ...value.split(/[\\/]/)];
  const resolved: string[] = [];
  for (const part of parts) {
    if (part === "..") { if (resolved.length > 1) resolved.pop(); }
    else if (part !== "." && (part !== "" || resolved.length === 0)) resolved.push(part);
  }
  return resolved.join(separator) || null;
}

export type Attachment = { path: string; label: string };

/**
 * Adjuntos de un párrafo o una lista que solo contiene enlaces (o imágenes) a
 * archivos locales; null si hay algo más. Un enlace dentro de una frase es
 * una referencia y se queda en el texto.
 */
export function attachmentsOf(node: HastNode | undefined, cwd: string): Attachment[] | null {
  const found: Attachment[] = [];
  const visit = (child: HastNode): boolean => {
    if (child.type === "text") return !(child.value ?? "").trim() || /^[\s,;·•–—-]*$/.test(child.value ?? "");
    if (child.type !== "element") return true;
    if (child.tagName === "br") return true;
    if (child.tagName === "a" || child.tagName === "img") {
      const target = child.tagName === "a" ? child.properties?.href : child.properties?.src;
      const path = localFilePath(typeof target === "string" ? target : null, cwd);
      if (!path) return false;
      const label = child.tagName === "a" ? nodeText(child).trim() : String(child.properties?.alt ?? "").trim();
      found.push({ path, label: label && label !== path && !label.includes("/") ? label : baseName(path) });
      return true;
    }
    // Listas de adjuntos: cada elemento (o su párrafo) solo tiene enlaces.
    if (["li", "p", "ul", "ol"].includes(child.tagName ?? "")) return (child.children ?? []).every(visit);
    return false;
  };
  if (!node?.children?.length || !node.children.every(visit) || !found.length) return null;
  const seen = new Set<string>();
  return found.filter(item => !seen.has(item.path) && seen.add(item.path));
}

/** Nombre del archivo de una ruta. */
export const baseName = (path: string): string => path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? path;

/** Carpeta del archivo, relativa al proyecto si está dentro y con `~` para la carpeta personal. */
export function folderLabel(path: string, cwd: string, home = ""): string {
  const folder = path.replace(/[\\/]+$/, "").replace(/[\\/][^\\/]*$/, "") || "/";
  const root = cwd.replace(/[\\/]+$/, "");
  if (root && (folder === root || folder.startsWith(`${root}/`) || folder.startsWith(`${root}\\`))) {
    const inside = folder.slice(root.length + 1);
    return inside ? inside : baseName(root);
  }
  const userHome = home.replace(/[\\/]+$/, "");
  return userHome && (folder === userHome || folder.startsWith(`${userHome}/`)) ? `~${folder.slice(userHome.length)}` : folder;
}

// --- Backend --------------------------------------------------------------------

const infoCache = new Map<string, Promise<FileInfo>>();

/** Datos del archivo; se guardan para no repetir la consulta mientras el texto sigue llegando. */
export function fileInfo(path: string): Promise<FileInfo> {
  let pending = infoCache.get(path);
  if (!pending) {
    pending = invoke<FileInfo[]>("file_info", { paths: [path] }).then(list => list[0]);
    // Un archivo que no estaba puede aparecer después (el asistente lo crea luego).
    pending.then(info => { if (!info?.exists) infoCache.delete(path); }, () => infoCache.delete(path));
    infoCache.set(path, pending);
  }
  return pending;
}

export const openFile = (path: string): Promise<void> => invoke("open_file", { path });
export const revealFile = (path: string): Promise<void> => invoke("reveal_file", { path });
export const saveFileCopy = (from: string, to: string): Promise<void> => invoke("save_file_copy", { from, to });
export const saveFileData = (to: string, data: string): Promise<void> => invoke("save_file_data", { to, data });
